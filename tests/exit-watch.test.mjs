// META-RUNTIME 3: a cli executor that finishes its work but never exits (grok RUN-1616: FINAL ## DONE, session_end logged, the
// process idle 51 min until the controller stopped it). The entry's exit_after_s arms the cli adapter's exit watch: once the run's
// NOTES gain an end marker AND the CLI wrote nothing for exit_after_s, its process tree is ended and the run ends by its marker.
// Temp dirs + node stub CLIs only: no real executor is spawned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCommand, startRun, stopRun } from '../engine/lib/runs.mjs';
import { providerProblems } from '../engine/lib/executors.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { WATCH } from '../engine/lib/harness/cli.mjs';
import { GROK } from './helpers/command-matrix.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
// the deadline runs on the monotonic clock: a wall-clock step (the WSL runner's clock steps ~16 s) never expires it early
async function waitFor(fn, ms = 20000) { const t0 = performance.now(); for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); } }
const NL = String.fromCharCode(10);
// a stub CLI: optionally appends `marker` to $META_NOTES, prints an answer, then hangs forever (a child that never exits)
const stub = (marker, extra = {}) => ({ type: 'cli', exe: process.execPath, model: 'm', effort: 'low', brief: 'file', output: 'plain', ...extra,
  args: ['-e', `const fs=require('fs');${marker ? `fs.appendFileSync(process.env.META_NOTES, ${JSON.stringify(marker + NL)});` : ''}process.stdout.write('answer'+String.fromCharCode(10));setInterval(()=>{},1000)`, '{mode}'],
  modes: { edit: { access: 'write', args: [] } } });

function sandbox() {
  const t = mkTmp('meta-xw-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), wt: path.join(t, 'wt'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks', 'wt']) fs.mkdirSync(d[k], { recursive: true });
  d.item = id => loadState(d.state).items[id];
  d.ended = (id, ms) => waitFor(() => { const it = d.item(id); return settled(it) && it; }, ms);   // + its supervisor gone (FINDING L1)
  d.start = entry => { const b = path.join(t, 'b.md'); fs.writeFileSync(b, 'x');
    return startRun({ state: d.state, locksDir: d.locks, executor: 'stub', provider: entry, exe: process.execPath, lane: 'x', worktree: d.wt, notes: d.notes, brief: b,
      budget: {}, tick: null, hbMs: 150, staleMs: 3000, policy: { auto_resume_max: 0 } }).run; };
  return d;
}

test('exit watch: data - exit_after_s wraps the cli in the watch (notes + seconds); no field / no notes (probe) = the bare command line', () => {
  const o = { executor: 'grok', exe: '/x/grok', worktree: '/w', brief: '/b.md', notes: '/n/NOTES.md', model: 'm', effort: 'high', final: '/f.txt' };
  const bare = buildCommand({ ...o, provider: { ...GROK, exit_after_s: undefined } });
  const w = buildCommand({ ...o, provider: { ...GROK, exit_after_s: 600 } });
  assert.equal(w.exe, process.execPath);
  assert.deepEqual(w.args.slice(0, 6), [WATCH, '--after', '600', '--notes', '/n/NOTES.md', '--']);
  assert.deepEqual(w.args.slice(6), [bare.exe, ...bare.args]);
  assert.deepEqual([w.stdin, w.stdout, w.parse], [bare.stdin, bare.stdout, bare.parse]);
  assert.equal(buildCommand({ ...o, notes: undefined, provider: { ...GROK, exit_after_s: 600 } }).exe, '/x/grok', 'no NOTES to watch: bare');
  assert.ok(Number.isInteger(GROK.exit_after_s) && GROK.exit_after_s > 0, 'kestrel grok arms the watch');
  const bad = x => providerProblems({ executors: { t: { ...stub(null), exit_after_s: x } } }).join('; ');
  for (const x of [0, -1, 'soon']) assert.match(bad(x), /exit_after_s must be a number > 0/);
  assert.equal(bad(2.5), '');
});

test('exit watch: a cli that writes ## DONE then hangs is ended after exit_after_s of silence; the run ends done by its marker', async () => {
  const d = sandbox();
  const r = d.start(stub('## DONE', { exit_after_s: 1 }));
  const e = await d.ended(r, 15000);
  assert.equal(e.state, 'exited'); assert.equal(e.end.outcome, 'done'); assert.equal(e.end.exit, 0);
  assert.match(fs.readFileSync(e.data.log, 'utf8'), /exit watch: .*end marker.* idle 1 s - ended/);
  assert.match(fs.readFileSync(e.data.final, 'utf8'), /answer/);
});

test('exit watch (gap #3): a cli that writes its result file ($META_RESULT, as `norn done` does) then hangs is ended too; the run ends by the result', async () => {
  const d = sandbox();
  const entry = { ...stub(null, { exit_after_s: 1 }) };
  entry.args = ['-e', `const fs=require('fs');fs.writeFileSync(process.env.META_RESULT, JSON.stringify({v:1,run:process.env.META_RUN_ID,outcome:'handoff',at:new Date().toISOString()}));process.stdout.write('answer'+String.fromCharCode(10));setInterval(()=>{},1000)`, '{mode}'];
  const r = d.start(entry);
  const e = await d.ended(r, 60000);
  assert.equal(e.end.outcome, 'handoff'); assert.equal(e.end.outcome_source, 'result'); assert.equal(e.end.exit, 0);
  assert.match(fs.readFileSync(e.data.log, 'utf8'), /exit watch: result handoff in the result file, .* idle 1 s - ended/);
});

test('exit watch: no end marker (still working) or a marker left from before the start (a resume) never arms it', async () => {
  const d = sandbox();
  const a = d.start(stub(null, { exit_after_s: 0.5 }));
  await sleep(3000);
  assert.equal(d.item(a).state, 'running', 'no marker: keeps running');
  stopRun({ state: d.state, locksDir: d.locks, run: a, by: 'owner' });
  const d2 = sandbox();
  fs.writeFileSync(d2.notes, '## round 1' + NL + '## HANDOFF' + NL);
  const b = d2.start(stub(null, { exit_after_s: 0.5 }));
  await sleep(3000);
  assert.equal(d2.item(b).state, 'running', 'an old marker does not arm the watch');
  stopRun({ state: d2.state, locksDir: d2.locks, run: b, by: 'owner' });
});

// META-GTP-CI-FILLWAKE F1: the idle measurement runs on the monotonic clock. A wall-clock step forward (preload tests/helpers/wall-step.mjs:
// Date.now jumps 1 h) right after the CLI went quiet with its marker written must not end it before exit_after_s of real silence.
test('exit watch: a wall-clock step forward does not end a marked, quiet CLI early (idle is monotonic)', async () => {
  const { spawn } = await import('node:child_process');
  const { killTree } = await import('../engine/lib/runs.mjs');
  const d = sandbox();
  const cli = `require('fs').appendFileSync(${JSON.stringify(d.notes)}, ${JSON.stringify('## DONE' + NL)});setInterval(()=>{},1000)`;
  const step = new URL('./helpers/wall-step.mjs', import.meta.url).href;
  const w = spawn(process.execPath, ['--import', step, WATCH, '--after', '8', '--notes', d.notes, '--', process.execPath, '-e', cli],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true, windowsHide: true });
  let err = '', code;
  w.stderr.on('data', b => { err += b; });
  w.on('exit', c => { code = c; });
  try {
    await waitFor(() => fs.existsSync(d.notes) && /## DONE/.test(fs.readFileSync(d.notes, 'utf8')));
    await sleep(3500);   // > 3 watch ticks after the step; well under the 8 s of real silence
    assert.equal(code, undefined, `ended early: ${err}`);
  } finally { killTree(w.pid); }
});
