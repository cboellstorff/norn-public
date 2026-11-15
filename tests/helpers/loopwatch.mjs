// META-CI-WORKCLASS R3 (DEC-333): whose stall is it? The test process's own event loop (a 100 ms interval's gaps + Node's
// event-loop-delay histogram), its CPU time against the box's, and when the servers watched here received / answered each request.
// mark() at a step's start; await loopReport(mark) on its timeout: a big gap = this loop was blocked (or the box starved it: then the
// process CPU is low and the box busy); small gaps + late `served` = the request reached this process late (the browser side).
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import inspector from 'node:inspector';

const TICK = 100, gaps = [], served = [];
const eld = monitorEventLoopDelay({ resolution: 20 }); eld.enable();
let last = performance.now();
setInterval(() => { const now = performance.now(), g = now - last - TICK; last = now;
  if (g > TICK) { gaps.push({ at: Date.now(), ms: Math.round(g) }); if (gaps.length > 100) gaps.shift(); } }, TICK).unref();

const boxCpu = () => os.cpus().reduce((a, c) => { const t = c.times; a.busy += t.user + t.nice + t.sys + t.irq; a.all += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { busy: 0, all: 0 });

export function watchServer(server) {
  server.on('request', (q, r) => { const e = { url: q.url, t0: Date.now(), ms: null }; served.push(e); if (served.length > 200) served.shift();
    r.on('finish', () => { e.ms = Date.now() - e.t0; }); });
  return server;
}

// a V8 sampling profile of this thread over the step: a sync call that blocks the loop is sampled in its JS caller's frame (a
// blocked thread is still sampled), so the busiest non-idle stack names it
const session = new inspector.Session(); session.connect();
const post = (m, p = {}) => new Promise((res, rej) => session.post(m, p, (e, r) => e ? rej(e) : res(r)));
let profiling = post('Profiler.enable').then(() => post('Profiler.setSamplingInterval', { interval: 5000 }));
const short = u => String(u || '').replace(/^file:\/\/\/?/, '').split('/').slice(-2).join('/');
function busiest(profile) {
  const byId = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const time = new Map();
  profile.samples.forEach((id, i) => time.set(id, (time.get(id) || 0) + (profile.timeDeltas[i + 1] ?? 0)));
  const skip = new Set(['(idle)', '(program)', '(garbage collector)', '(root)']);
  const stacks = new Map();
  for (const [id, us] of time) {
    const fr = []; for (let n = byId.get(id); n; n = byId.get(parent.get(n.id))) { const c = n.callFrame; if (!skip.has(c.functionName) && c.url) fr.push(`${c.functionName || '(anon)'} ${short(c.url)}:${c.lineNumber + 1}`); }
    if (!fr.length) continue; const k = fr.slice(0, 8).join(' < '); stacks.set(k, (stacks.get(k) || 0) + us);
  }
  return [...stacks].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, us]) => `${k} ${Math.round(us / 1000)} ms`);
}

// META-CI-WORKCLASS R4 (DEC-336): the pipe hypothesis, tested - every write to this process's stdout / stderr is timed (a sync pipe
// write blocks the loop at low CPU); one > 100 ms is kept for the report (stream, bytes, ms) and logged on the side (log)
const WRITE_MS = 100, writes = [], errWrite = process.stderr.write.bind(process.stderr);
const size = c => typeof c === 'string' ? Buffer.byteLength(c) : c?.byteLength ?? c?.length ?? 0;
export function timeWrites(stream, name, log = errWrite) {
  const orig = stream.write;
  stream.write = function (chunk, ...rest) { const t0 = performance.now(); try { return orig.call(this, chunk, ...rest); } finally { const ms = performance.now() - t0;
    if (ms > WRITE_MS) { const w = { at: Date.now() - Math.round(ms), ms: Math.round(ms), bytes: size(chunk), name }; writes.push(w); if (writes.length > 50) writes.shift();
      setImmediate(() => log(`slow write: ${name} ${w.bytes} bytes took ${w.ms} ms
`)); } } };
  return stream;
}
timeWrites(process.stdout, 'stdout'); timeWrites(process.stderr, 'stderr');

export function mark() { eld.reset(); profiling = profiling.then(() => post('Profiler.stop').catch(() => {})).then(() => post('Profiler.start')).catch(() => {});
  return { t: Date.now(), cpu: process.cpuUsage(), box: boxCpu() }; }

export const maxGap = m => Math.max(0, ...gaps.filter(g => g.at >= m.t).map(g => g.ms));
export async function loopReport(m) {
  let top = []; try { await profiling; top = busiest((await post('Profiler.stop')).profile); profiling = Promise.resolve(); } catch (e) { top = [`(no profile: ${e.message})`]; }
  const wall = Date.now() - m.t, c = process.cpuUsage(m.cpu), b = boxCpu(), busy = b.all - m.box.all > 0 ? Math.round(100 * (b.busy - m.box.busy) / (b.all - m.box.all)) : 0;
  const gs = gaps.filter(g => g.at >= m.t), max = Math.max(0, ...gs.map(g => g.ms));
  const sv = served.filter(e => e.t0 >= m.t).slice(-30).map(e => `${e.url.split('?')[0]} +${e.t0 - m.t} ms -> ${e.ms == null ? 'unanswered' : e.ms + ' ms'}`);
  return `loop: max gap ${max} ms in ${wall} ms (gaps > ${TICK} ms at: ${gs.slice(-10).map(g => `+${g.at - g.ms - m.t}:${g.ms}`).join(' ') || 'none'}); event-loop delay max ${Math.round(eld.max / 1e6)} ms p99 ${Math.round(eld.percentile(99) / 1e6)} ms
cpu: process ${Math.round(c.user / 1000)} ms user + ${Math.round(c.system / 1000)} ms system in ${wall} ms wall; box ${busy} % busy over ${os.availableParallelism()} cpus
served: ${sv.join(', ') || 'nothing since the step began'}
busiest stack: ${top.join(' | ') || 'none (the loop was idle)'}
writes: ${writes.filter(w => w.at >= m.t).map(w => `${w.name} ${w.bytes} bytes ${w.ms} ms at +${w.at - m.t} ms`).join(', ') || `none > ${WRITE_MS} ms`}`;
}
// R4 (a): one home for "this step was slow, say whose time it was" - pg.go and any private CDP wait: a step over ms, or with a loop gap
// over gap, writes the loop report (stderr: the CI log; the red is intermittent) and returns it; a quick step returns null
export async function slowStep(m, label, { ms = 2000, gap = 500, log = s => process.stderr.write(s) } = {}) {
  const wall = Date.now() - m.t; if (wall <= ms && maxGap(m) <= gap) return null;
  const r = `slow ${label}: ${wall} ms
${await loopReport(m)}
`; log(r); return r;
}
