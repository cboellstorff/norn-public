// CIRED-60fa8b6 R2 (DEC-84 B): progress-based waits. A test waits for a condition while its PRODUCER (the run's supervisor, a node
// process, a child) still lives; it fails as soon as the producer is gone and the condition is still false - not after N s of a
// loaded machine (the Windows leg runs 10-15x slower than the Linux one on the same box, and a fixed deadline sampled that).
// HANG_CAP_MS is only a hang guard for a producer that lives but never delivers; no test asserts on it.
import fs from 'node:fs';
import { alive, settled } from './settled.mjs';
import { loadState } from '../../engine/lib/records.mjs';
import { hbPath } from '../../engine/lib/runs.mjs';

export const HANG_CAP_MS = 10 * 60000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nap = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function step(fn, producer, what, t0, capMs) {
  const v = fn();
  if (v) return { v };
  if (producer && !producer()) {   // gone: one last look (it may have delivered just before it exited), then fail
    const last = fn();
    if (last) return { v: last };
    throw new Error(`${what}: its producer is gone and the condition is still false`);
  }
  if (performance.now() - t0 > capMs) throw new Error(`${what}: hang guard ${capMs / 1000} s passed while its producer still lives`);
  return null;
}

// an option the helpers do not know is a caller bug (a `timeoutMs` here was silently ignored: CI-HANG-6E54DAB)
const KNOWN = new Set(['producer', 'what', 'capMs', 'pollMs']);
function known(opts) {
  const bad = Object.keys(opts).filter(k => !KNOWN.has(k));
  if (bad.length) throw new TypeError(`waitFor: unknown option ${bad.join(', ')} (known: ${[...KNOWN].join(', ')})`);
  return opts;
}

/** await fn() truthy while producer() is true (no producer = only the hang guard ends it) */
export async function waitFor(fn, opts = {}) {
  const { producer, what = 'condition', capMs = HANG_CAP_MS, pollMs = 50 } = known(opts);
  const t0 = performance.now();   // monotonic: a wall-clock step never trips the guard
  for (;;) { const r = step(fn, producer, what, t0, capMs); if (r) return r.v; await sleep(pollMs); }
}

/** the same, blocking (for a synchronous test) */
export function waitForSync(fn, opts = {}) {
  const { producer, what = 'condition', capMs = HANG_CAP_MS, pollMs = 50 } = known(opts);
  const t0 = performance.now();
  for (;;) { const r = step(fn, producer, what, t0, capMs); if (r) return r.v; nap(pollMs); }
}

/** a run's producer: its supervisor lives. The pid comes from the hb (written at spawn, runs.mjs startRun) or the end record; none
 * known yet (the start is being written) counts as alive. */
export const supervisorAlive = (state, item) => () => {
  const it = item();
  let s = it?.end?.supervisor_pid ? it.end : null;
  if (!s && it) { try { s = JSON.parse(fs.readFileSync(hbPath(state, it.id), 'utf8')); } catch { /* no hb */ } }
  return !s?.supervisor_pid || alive(s.supervisor_pid, s.supervisor_started);
};

/** d.ended: the run has ended and its supervisor is gone (settled), while that supervisor makes progress */
export const runEnded = (state, id) => {
  const item = () => loadState(state).items[id];
  return waitFor(() => { const it = item(); return settled(it) && it; }, { producer: supervisorAlive(state, item), what: `${id} settled` });
};

/** a fill's producers: a run of the state that is still running or whose supervisor still runs its tail (a fill under queue.lock,
 * a slot not yet free). None left and the fill still holds = nothing will change. */
// The probes are slow (a sync start-time probe, 1-1.5 s on a loaded box): a run may start a successor and exit while they run, so a
// "none" is re-checked on a fresh state until its runs did not change under the check (CI-RED-18A9C0A R2, critique cause B).
export const stateBusy = (state, { live = (st, it) => supervisorAlive(st, () => it)() } = {}) => () => {
  const runs = () => Object.values(loadState(state).items).filter(it => it.kind === 'run');
  const sig = rs => rs.map(it => `${it.id}:${it.state}:${it.history.length}`).join(',');
  for (let rs = runs(); ;) {
    if (rs.some(it => (it.state === 'running' || it.end?.supervisor_pid) && live(state, it))) return true;
    const now = runs();
    if (sig(now) === sig(rs)) return false;
    rs = now;
  }
};

/** a child process's producer: it has not exited (child_process ChildProcess) */
export const childAlive = p => () => p.exitCode === null && p.signalCode === null;
