// META-CI-WORKCLASS R4 (DEC-336): which call blocked the test process's loop? A `node --cpu-prof` profile (ci-suite --cpu-prof, the
// Windows CI job) samples the main thread even while it is stuck in a native sync call, in its JS caller's frame. stalls(profile)
// = the longest runs of consecutive samples on ONE non-idle stack (and single sample gaps), each >= minMs, the longest first.
// CLI: node tests/helpers/profgap.mjs DIR [minMs=500] - prints the top stalls of every *.cpuprofile under DIR.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = new Set(['(idle)', '(program)', '(garbage collector)', '(root)']);
const short = u => String(u || '').replace(/^file:\/\/\/?/, '').split('/').slice(-2).join('/');

export function stalls(profile, minMs = 500) {
  const byId = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const stackOf = id => { const fr = [];
    for (let n = byId.get(id); n; n = byId.get(parent.get(n.id))) { const c = n.callFrame; if (SKIP.has(c.functionName)) continue;
      fr.push(c.url ? `${c.functionName || '(anon)'} ${short(c.url)}:${c.lineNumber + 1}` : `${c.functionName || '(anon)'} (native)`); }
    return fr.slice(0, 10).join(' < '); };
  const out = [], { samples, timeDeltas } = profile;
  let at = 0;
  for (let i = 0; i < samples.length;) {
    let j = i, us = 0; const start = at;
    while (j < samples.length && samples[j] === samples[i]) { const d = timeDeltas[j + 1] ?? 0; us += d; at += d; j++; }
    const stack = stackOf(samples[i]);
    if (stack && us / 1000 >= minMs) out.push({ ms: Math.round(us / 1000), at: Math.round(start / 1000), stack });
    i = j;
  }
  // a gap between two samples (the sampler could not sample the thread): the stack on both sides
  at = 0;
  for (let i = 1; i < samples.length; i++) { at += timeDeltas[i]; if (timeDeltas[i] / 1000 >= minMs) out.push({ ms: Math.round(timeDeltas[i] / 1000), at: Math.round(at / 1000),
    stack: `(no sample) between ${stackOf(samples[i - 1]) || 'idle'} AND ${stackOf(samples[i]) || 'idle'}` }); }
  return out.sort((a, b) => b.ms - a.ms);
}

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.cpuprofile') ? [path.join(d, e.name)] : []);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2], min = Number(process.argv[3] ?? 500), files = dir && fs.existsSync(dir) ? walk(dir) : [];
  let n = 0;
  for (const f of files) { let s; try { s = stalls(JSON.parse(fs.readFileSync(f, 'utf8')), min); } catch (e) { console.log(`${path.relative(dir, f)}: unreadable (${e.message})`); continue; }
    for (const x of s.slice(0, 3)) { n++; console.log(`${path.relative(dir, f)}: stall ${x.ms} ms at +${x.at} ms: ${x.stack}`); } }
  console.log(`profgap: ${n} stall(s) >= ${min} ms in ${files.length} profile(s)`);
}
