// gap #3: a run's outcome is its own result file (<state>/runs/RUN-n.result.json, written by `norn done`; the supervisor passes its
// path as META_RESULT), read before the lane's shared NOTES end marker; the marker stays the fallback (with the stale-marker guard).
// The end records the source: outcome_source result | marker | exit | none. FAKE executor, temp dirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadState } from '../engine/lib/records.mjs';
import { makeResult, readResult, writeResult, resultPath, resultLine, ResultError } from '../engine/lib/result.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { runEnded } from './helpers/wait.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const BASE_ENV = { META_ROLE: '', META_PROJECT: '', META_STATE: '', META_RUN_ID: '', META_RUN_STATE: '', META_RESULT: '', META_NO_TICK: '1' };
const meta = (args, env = {}) => {
  const r = spawnSync(process.execPath, [META, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...BASE_ENV, ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
function sandbox(brief, { oldNotes = null } = {}) {
  const t = mkTmp('meta-run-result-'), d = { state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), wt: path.join(t, 'wt'), notes: path.join(t, 'NOTES.md'), other: path.join(t, 'OTHER.md') };
  for (const k of ['state', 'locks', 'wt']) fs.mkdirSync(d[k], { recursive: true });
  if (oldNotes !== null) { fs.writeFileSync(d.notes, oldNotes); const old = new Date(Date.now() - 3600e3); fs.utimesSync(d.notes, old, old); }
  d.brief = path.join(t, 'brief.md');
  fs.writeFileSync(d.brief, brief.replace('{other}', d.other.replace(/\\/g, '/')));
  d.run = (extra = []) => meta(['run', '--executor', 'fake', '--lane', 'fixer', '--brief', d.brief, '--notes', d.notes, '--worktree', d.wt, '--state', d.state, '--locks', d.locks, '--no-tick', ...extra]);
  d.end = async () => {
    const r = d.run();
    assert.equal(r.code, 0, r.err);
    const id = r.out.match(/RUN-\d+/)[0];
    await runEnded(d.state, id);
    return { id, end: loadState(d.state).items[id].end };
  };
  return d;
}

test('makeResult / readResult: outcomes, the why of a stop, the run it names, its age', () => {
  assert.deepEqual(makeResult({ run: 'RUN-3', at: 'T' }), { v: 1, run: 'RUN-3', outcome: 'done', at: 'T' });
  assert.throws(() => makeResult({ run: 'RUN-3', outcome: 'stopped' }), ResultError);
  assert.throws(() => makeResult({ run: 'RUN-3', outcome: 'done', why: 'x' }), /--why is for --outcome stopped/);
  assert.throws(() => makeResult({ run: 'RUN-3', outcome: 'finished' }), /--outcome must be/);
  assert.throws(() => makeResult({ run: 'x' }), /RUN-n/);
  assert.equal(resultLine({ outcome: 'stopped', why: 'red' }), '## STOPPED: red');
  assert.equal(resultLine({ outcome: 'handoff' }), '## HANDOFF');
  const t = mkTmp('meta-run-result-'), f = resultPath(t, 'RUN-4');
  assert.equal(readResult(f, { run: 'RUN-4' }), null, 'absent');
  writeResult(f, { run: 'RUN-4', outcome: 'stopped', why: ' the gate\n is red ', summary: 'tried twice' });
  assert.deepEqual(readResult(f, { run: 'RUN-4', since: Date.now() - 60000 }), { outcome: 'stopped', marker_line: '## STOPPED: the gate is red', why: 'the gate is red', summary: 'tried twice', at: JSON.parse(fs.readFileSync(f, 'utf8')).at });
  assert.match(readResult(f, { run: 'RUN-5' }).error, /names "RUN-4"/);
  assert.match(readResult(f, { run: 'RUN-4', since: Date.now() + 60000 }).error, /before this run started/);
  fs.writeFileSync(f, '{nope');
  assert.deepEqual(readResult(f, { run: 'RUN-4' }), { error: 'not JSON' });
});

test('norn done: inside a run it writes META_RESULT; a run ends itself only; a typo run / no state refuses (exit 2)', () => {
  const t = mkTmp('meta-run-result-'), state = path.join(t, 'state');
  fs.mkdirSync(path.join(state, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(state, 'runs', 'RUN-7.spec.json'), '{}');
  const env = { META_RUN_ID: 'RUN-7', META_RUN_STATE: state, META_RESULT: resultPath(state, 'RUN-7') };
  const ok = meta(['done', '--outcome', 'handoff', '--summary', 'half way'], env);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /RUN-7 HANDOFF -> .*RUN-7\.result\.json/);
  assert.deepEqual(readResult(resultPath(state, 'RUN-7'), { run: 'RUN-7' }).summary, 'half way');
  assert.match(meta(['done', '--run', 'RUN-8'], env).err, /a run ends itself only/);
  assert.match(meta(['done', '--outcome', 'stopped'], env).err, /needs --why/);
  const typo = meta(['done', '--run', 'RUN-9', '--state', state]);
  assert.equal(typo.code, 2); assert.match(typo.err, /RUN-9 is not a run of/);
  assert.match(meta(['done']).err, /no run/);
  const outside = meta(['done', '--run', 'RUN-7', '--state', state, '--outcome', 'stopped', '--why', 'by hand']);
  assert.equal(outside.code, 0, outside.err);
  assert.equal(readResult(resultPath(state, 'RUN-7'), { run: 'RUN-7' }).why, 'by hand');
  assert.match(meta(['done', '--help']).out, /^usage: norn done/);
});

test('the result file decides: a worker that writes no NOTES marker but runs norn done ends done (source result)', async () => {
  const d = sandbox('mode: no-marker\nresult: done\nresult_summary: all green\n');
  const { id, end } = await d.end();
  assert.equal(end.outcome, 'done');
  assert.equal(end.outcome_source, 'result');
  assert.equal(end.marker_line, '## DONE');
  assert.equal(end.summary, 'all green');
  assert.ok(fs.existsSync(resultPath(d.state, id)));
});

test('the result file beats a disagreeing NOTES marker; a stop carries its why', async () => {
  const d = sandbox('mode: done\nresult: stopped\nresult_why: the suite is red\n');
  const { end } = await d.end();
  assert.equal(end.outcome, 'stopped');
  assert.equal(end.outcome_source, 'result');
  assert.equal(end.why, 'the suite is red');
  assert.equal(end.marker_line, '## STOPPED: the suite is red');
});

test('fallback: no result file = the NOTES marker (source marker); an inherited old marker = no-marker (source none)', async () => {
  const fresh = await sandbox('mode: done\n').end();
  assert.equal(fresh.end.outcome, 'done');
  assert.equal(fresh.end.outcome_source, 'marker');
  const stale = await sandbox('mode: done\nwrites: {other}\n', { oldNotes: '# an earlier run\n\n## DONE\n' }).end();
  assert.equal(stale.end.outcome, 'no-marker');
  assert.equal(stale.end.outcome_source, 'none');
});

test('a reused lane NOTES: an old ## DONE never decides when this run wrote its result (handoff)', async () => {
  const d = sandbox('mode: no-marker\nwrites: {other}\nresult: handoff\n', { oldNotes: '# an earlier run\n\n## DONE\n' });
  const { id, end } = await d.end();
  assert.equal(end.outcome, 'handoff');
  assert.equal(end.outcome_source, 'result');
  // the HANDOFF auto-resumes (cap 2): let the chain settle so no run outlives the test
  for (let n = Number(id.slice(4)) + 1; n <= Number(id.slice(4)) + 2; n++) {
    const next = `RUN-${n}`;
    if (loadState(d.state).items[next]) await runEnded(d.state, next);
  }
});

test('a crash is its exit whatever the result file says (source exit)', async () => {
  const { end } = await sandbox('mode: crash\nresult: done\n').end();
  assert.equal(end.outcome, 'crash');
  assert.equal(end.outcome_source, 'exit');
});
