// NORN-WATCH S4: triggers as records - a queued run's `after:` conditions + `inputs:` DLVs (norn run --after / --inputs), evaluated
// by the fill; the park guard on an input DLV; META-QUEUE.md as a generated view. Temp dirs only; the fake executor stands in for claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRun, queueRun, fillQueue, RunError } from '../engine/lib/runs.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { parseAfter } from '../engine/lib/after.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const t0 = performance.now();   // monotonic: a wall-clock step (the WSL runner's ~16 s) never expires the deadline early
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); }
}
function sandbox() {
  const t = mkTmp('meta-after-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks']) fs.mkdirSync(d[k], { recursive: true });
  d.wt = n => { const w = path.join(t, 'wt' + n); fs.mkdirSync(w, { recursive: true }); return w; };
  d.brief = (body, name = 'brief.md') => { const f = path.join(t, name); fs.writeFileSync(f, body); return f; };
  d.item = id => loadState(d.state).items[id];
  d.opts = (o = {}) => ({ state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt(1), notes: d.notes, hbMs: 150, staleMs: 3000,
    policy: { auto_resume_max: 0 }, budget: { max_claude_workers: 4 }, tick: null, brief: d.brief('mode: done\n'), ...o });
  // ended AND its supervisor gone: the run's own end-of-run fill + queue view (under queue.lock) are done (FINDING L1)
  d.ended = id => waitFor(() => { const it = d.item(id); return settled(it) && it; });
  d.q = (title = 'art pick') => record(d.state, { kind: 'question', ev: 'create', by: 'checkin', data: { title, lane: 'demo', options: [{ key: 'a', text: 'A' }], blocks: [] } }, { views: false }).id;
  return d;
}

test('parseAfter: kind:id[:state] with per-kind defaults; bad terms throw', () => {
  assert.deepEqual(parseAfter('q:Q-50:answered,dlv:DLV-19:merged,run:RUN-1613:done,dir:DIR-90'), [
    { kind: 'q', id: 'Q-50', state: 'answered' }, { kind: 'dlv', id: 'DLV-19', state: 'merged' },
    { kind: 'run', id: 'RUN-1613', state: 'done' }, { kind: 'dir', id: 'DIR-90', state: 'done' }]);
  assert.deepEqual(parseAfter('q:Q-1'), [{ kind: 'q', id: 'Q-1', state: 'answered' }]);
  for (const bad of ['x:Q-1', 'q:DLV-1', 'q:Q-1:merged', 'q:Q-1:answered:x']) assert.throws(() => parseAfter(bad), /--after/);
});

test('after: an unmet run waits and does not block a younger run; met -> starts in the same pass', async () => {
  const d = sandbox();
  const q = d.q();
  const a = startRun(d.opts({ lane: 'art', worktree: d.wt(1), after: parseAfter(`q:${q}`), inputs: [] }));
  assert.equal(a.queued, true, 'a run with after: always queues');
  assert.deepEqual(d.item(a.run).data.after, [{ kind: 'q', id: q, state: 'answered' }]);
  assert.deepEqual(fillQueue(d.state), [], 'unmet: waits');
  const b = queueRun(d.opts({ lane: 'other', worktree: d.wt(2) })).run;
  const got = fillQueue(d.state);
  assert.deepEqual(got.map(x => x.queued), [b], 'the younger run passes the waiting one');
  assert.equal(d.item(a.run).state, 'queued');
  record(d.state, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { choice: 'a', text: 'a', via: 'chat' } }, { views: false });
  const now = fillQueue(d.state);
  assert.deepEqual(now.map(x => x.queued), [a.run], 'met: starts in this pass');
  assert.equal(d.item(now[0].next).data.lane, 'art');
  assert.equal((await d.ended(now[0].next)).end.outcome, 'done');
  await d.ended(got[0].next);
});

test('after: a condition that can no longer be met holds the run as needs a ruling with why (Q withdrawn, run killed, DIR revoked) - META-AUTONOMY R1: never a silent withdraw', async () => {
  const d = sandbox();
  const q = d.q();
  const dir = record(d.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'do x', via: 'chat' } }, { views: false }).id;
  const release = path.join(d.t, 'release');
  const holder = startRun(d.opts({ lane: 'holder', worktree: d.wt(9), brief: d.brief(`mode: done\nuntil: ${release}\n`, 'h.md') })).run;
  const rq = startRun(d.opts({ lane: 'q', worktree: d.wt(1), after: parseAfter(`q:${q}`) })).run;
  const rr = startRun(d.opts({ lane: 'r', worktree: d.wt(2), after: parseAfter(`run:${holder}`) })).run;
  const rd = startRun(d.opts({ lane: 'd', worktree: d.wt(3), after: parseAfter(`dir:${dir}`) })).run;
  assert.deepEqual(fillQueue(d.state), []);
  record(d.state, { kind: 'question', ev: 'withdraw', id: q, by: 'checkin', data: { why: 'moot' } }, { views: false });
  record(d.state, { kind: 'run', ev: 'kill', id: holder, by: 'controller', data: { why: 'test' } }, { views: false });
  record(d.state, { kind: 'directive', ev: 'revoke', id: dir, by: 'owner', data: {} }, { views: false });
  fs.writeFileSync(release, '');
  assert.deepEqual(fillQueue(d.state), []);
  assert.equal(d.item(rq).state, 'queued'); assert.match(d.item(rq).hold.why, new RegExp(`q:${q}:answered: ${q} withdrawn`));
  assert.equal(d.item(rr).state, 'queued'); assert.match(d.item(rr).hold.why, new RegExp(`run:${holder}:done: ${holder} killed`));
  assert.equal(d.item(rd).state, 'queued'); assert.match(d.item(rd).hold.why, new RegExp(`${dir} revoked`));
  await sleep(300);
});

test('after: a named record must exist at queue time (a typo would wait forever)', () => {
  const d = sandbox();
  assert.throws(() => startRun(d.opts({ after: parseAfter('q:Q-7') })), e => e instanceof RunError && /Q-7 does not exist/.test(e.message));
  assert.throws(() => queueRun(d.opts({ inputs: ['DLV-3'] })), e => e instanceof RunError && /DLV-3/.test(e.message));
});

test('CLI: norn run --after/--inputs queues (met now -> started at once); park of an input DLV refused exit 2 naming the run; digest shows the trigger', async () => {
  const d = sandbox();
  const env = { ...process.env, META_HB_MS: '150', META_NO_TICK: '1', META_FILL_SAMPLE: '{"free_gb":64,"cpu_pct":0}' };   // the resource gate is not under test: a busy CI box (CPU > 90 %) held RUN-2 queued (CI 42667438887, 42631863948)
  const cli = (...a) => { const x = spawnSync(process.execPath, [META, ...a], { env, encoding: 'utf8' }); return { code: x.status, out: x.stdout, err: x.stderr }; };
  const budget = path.join(d.t, 'budget.json'); fs.writeFileSync(budget, JSON.stringify({ max_claude_workers: 4 }));
  const common = ['--executor', 'fake', '--state', d.state, '--locks', d.locks, '--budget', budget, '--notes', d.notes];
  const q = d.q();
  const dlv = record(d.state, { kind: 'deliverable', ev: 'create', by: 'controller', data: { repo: d.t, branch: 'feat/x', delivers: 'x' } }, { views: false }).id;
  assert.equal(cli('run', ...common, '--lane', 'a', '--worktree', d.wt(1), '--brief', d.brief('mode: done\n'), '--after', 'q:Q-1:nope').code, 2);
  const r = cli('run', ...common, '--lane', 'a', '--worktree', d.wt(1), '--brief', d.brief('mode: done\n'), '--after', `q:${q}`, '--inputs', dlv);
  assert.equal(r.code, 0, r.err);
  const id = r.out.match(/QUEUED (RUN-\d+) lane a .*waits for its after: conditions/)[1];
  assert.deepEqual(d.item(id).data.inputs, [dlv]);
  const pf = path.join(d.t, 'project.json');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 't', title: 't', root: d.t.split(path.sep).join('/') }));
  const p = cli('deliverables', 'park', dlv, '--why', 'later', '--as', 'controller', '--project', pf, '--state', d.state);
  assert.equal(p.code, 2, p.out + p.err);
  assert.match(p.err, new RegExp(`${dlv} cannot be parked: queued run ${id}`));
  const dg = digest(d.state, {}, { dlv: [] });
  assert.deepEqual(dg.sections.queued.map(x => [x.id, x.after.map(a => [a.cond, a.met])]), [[id, [[`q:${q}:answered`, false]]]]);
  // met at queue time: started by the same command
  record(d.state, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { choice: 'a', text: 'a', via: 'chat' } }, { views: false });
  const s = cli('run', ...common, '--lane', 'b', '--worktree', d.wt(2), '--brief', d.brief('mode: done\n', 'b2.md'), '--after', `q:${q}`);
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /queue: RUN-\d+ -> STARTED RUN-\d+/);
  for (const it of Object.values(loadState(d.state).items)) if (it.kind === 'run' && it.state === 'running') await d.ended(it.id);
});

test('META-QUEUE view: generated on every fill (running / queued + triggers / recent ends); a hand edit is refused, not overwritten', async () => {
  const d = sandbox();
  const q = d.q();
  const a = startRun(d.opts({ lane: 'art', after: parseAfter(`q:${q}`) })).run;
  fillQueue(d.state);
  const view = path.join(d.state, 'META-QUEUE.md');
  const text = fs.readFileSync(view, 'utf8');
  assert.match(text, /GENERATED by norn/);
  assert.match(text, new RegExp(`## Queued \\(1\\)\\n\\n- 1\\. ${a} .*lane art .*after q:${q}:answered unmet`));
  fs.writeFileSync(view, text + 'my note\n');
  record(d.state, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { choice: 'a', text: 'a', via: 'chat' } }, { views: false });
  const got = fillQueue(d.state);
  assert.equal(got.length, 1, 'the fill itself is not held by a refused view');
  assert.match(fs.readFileSync(view, 'utf8'), /my note/, 'hand edit kept, not overwritten');
  fs.writeFileSync(view, text);   // revert -> regenerated again
  await d.ended(got[0].next);
  fillQueue(d.state);
  const after = fs.readFileSync(view, 'utf8');
  assert.match(after, /## Queued \(0\)/);
  assert.match(after, new RegExp(`## Recent ends \\(\\d+\\)\\n\\n- ${got[0].next} .*ended done`));
  assert.ok(!fs.existsSync(path.join(d.state, 'views', 'OWNER-QUESTIONS.md')), 'the fill writes only the queue view');
});
