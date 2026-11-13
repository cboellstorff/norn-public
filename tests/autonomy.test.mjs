// META-AUTONOMY R1: Norn runs without a controller session - the check-ins repair their own queue. Each test is one of the 7
// "CONTROLLER ACTION" cases the 11-12 check-ins could not act on (state/norn/NORN-LEDGER.md 20:42Z-00:21Z, DEC-92 / 106 / 107 /
// 108 / 111), replayed on SYNTHETIC runs in a temp state dir (never live state). The fake executor stands in for claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueRun, readiness, fillQueue, queueSpecPath, RunRefused } from '../engine/lib/runs.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { parseAfter, makeEval, evalAll } from '../engine/lib/after.mjs';
import { buildPlan } from '../engine/lib/plan.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { needsYou } from '../engine/lib/mcp.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const meta = (args, env = {}) => {
  const r = spawnSync(process.execPath, [META, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROLE: '', META_PROJECT: '', META_STATE: '', META_RUN_ID: '', META_NO_TICK: '1', ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

function sandbox() {
  const t = mkTmp('meta-autonomy-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks']) fs.mkdirSync(d[k], { recursive: true });
  d.wt = n => { const w = path.join(t, 'wt' + n); fs.mkdirSync(w, { recursive: true }); return w; };
  d.brief = (body = 'mode: done\n', name = 'brief.md') => { const f = path.join(t, name); fs.writeFileSync(f, body); return f; };
  d.item = id => loadState(d.state).items[id];
  d.runs = () => Object.values(loadState(d.state).items).filter(i => i.kind === 'run');
  d.opts = (o = {}) => ({ state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt(1), notes: d.notes, hbMs: 150, staleMs: 3000,
    policy: { auto_resume_max: 0 }, budget: { max_claude_workers: 4 }, tick: null, brief: d.brief(), ...o });
  d.rec = (ev, data, id, by = 'launcher') => record(d.state, { kind: 'run', ev, id, by, data }, { views: false });
  // a synthetic run that started and ended (no process): { lane, stage, round, worktree, outcome, head, from_queue }
  d.ran = ({ outcome = 'done', head, ...data }) => {
    const id = d.rec('start', { kind: 'fake', executor: 'fake', worktree: d.wt(99), ...data }).id;
    if (outcome) d.rec('end', { exit: 0, outcome, ...(head ? { head } : {}) }, id);
    return id;
  };
  d.cli = (args, env) => meta([...args, '--state', d.state], env);
  return d;
}
function repo(d) {
  const r = path.join(d.t, 'repo');
  fs.mkdirSync(r);
  git(r, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(d.t, 'nohooks')]]) git(r, 'config', k, v);
  const commit = (cwd, f, body = f + '\n') => { fs.writeFileSync(path.join(cwd, f), body); git(cwd, 'add', f); git(cwd, 'commit', '-q', '-m', f); return git(cwd, 'rev-parse', 'HEAD'); };
  commit(r, 'a.txt');
  const branch = (name, files) => { git(r, 'branch', name, 'main'); git(r, 'checkout', '-q', name); let h; for (const f of files) h = commit(r, f); git(r, 'checkout', '-q', 'main'); return h; };
  return { r, commit, branch };
}

// ---------- case 1 (DEC-92, ledger 20:42Z + 20:45Z): RUN-321 + RUN-322 queued the same meta-adopt A1 brief ----------
test('DEC-92: a second QUEUED / RUNNING run of the same lane + stage + round refuses (exit 3) across worktrees; a resume naming it as --parent passes', () => {
  const d = sandbox();
  const first = queueRun(d.opts({ lane: 'meta-adopt', stage: 'A1', round: 1, worktree: d.wt(1) })).run;
  assert.throws(() => queueRun(d.opts({ lane: 'meta-adopt', stage: 'A1', round: 1, worktree: d.wt(2) })),
    e => e instanceof RunRefused && e.code === 3 && e.message.includes(first) && /meta-adopt A1/.test(e.message));
  const cli = d.cli(['run', '--executor', 'fake', '--lane', 'meta-adopt', '--stage', 'A1', '--round', '1', '--brief', d.brief(), '--worktree', d.wt(3), '--locks', d.locks, '--queue']);
  assert.equal(cli.code, 3, cli.out + cli.err);
  assert.match(cli.out, /REFUSED: .*RUN-1/);
  const running = d.ran({ lane: 'meta-adopt', stage: 'A2', round: 1, outcome: null });
  assert.throws(() => queueRun(d.opts({ lane: 'meta-adopt', stage: 'A2', round: 1, worktree: d.wt(4) })), e => e.code === 3 && e.message.includes(running), 'a RUNNING one blocks too');
  assert.ok(queueRun(d.opts({ lane: 'meta-adopt', stage: 'A1', round: 1, worktree: d.wt(5), parent: first })).run, 'a resume names the first as --parent');
  assert.ok(queueRun(d.opts({ lane: 'meta-adopt', stage: 'A1', round: 2, worktree: d.wt(6) })).run, 'another round is another run');
  assert.ok(queueRun(d.opts({ lane: 'other', stage: 'A1', round: 1, worktree: d.wt(7) })).run, 'another lane');
  const done = d.ran({ lane: 'meta-x', stage: 'S1', round: 1 });
  assert.ok(queueRun(d.opts({ lane: 'meta-x', stage: 'S1', round: 1, worktree: d.wt(8) })).run, `an ENDED run (${done}) does not block`);
});

test('DEC-92: the check-in withdraws a QUEUED duplicate itself (norn stop --as checkin --why); a RUNNING run stays owner / controller', () => {
  const d = sandbox();
  const dup = queueRun(d.opts({ lane: 'meta-adopt', stage: 'A1', round: 1 })).run;
  const noWhy = d.cli(['stop', dup, '--as', 'checkin']);
  assert.equal(noWhy.code, 2, 'refused without --why');
  assert.equal(d.item(dup).state, 'queued');
  const ok = d.cli(['stop', dup, '--as', 'checkin', '--why', 'DEC-92 duplicate of RUN-322']);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(d.item(dup).state, 'withdrawn');
  assert.equal(d.item(dup).history.at(-1).by, 'checkin');
  const live = d.ran({ lane: 'meta-adopt', stage: 'A2', outcome: null });
  const kill = d.cli(['stop', live, '--as', 'checkin', '--why', 'DEC-92']);
  assert.equal(kill.code, 3, 'never a RUNNING one: kills stay owner / controller');
  assert.match(kill.out, /owner|controller/);
  assert.equal(d.item(live).state, 'running');
});

// ---------- case 2 (DEC-106, ledger 23:14Z): S3 RUN-306 after run:RUN-305:merged - the MERGE rebased S2b, e7aed31 never on main ----------
test('DEC-106: run:X:merged is the WORK on main - a rebase, a rebase + --no-ff merge commit and a squash all count; unmerged work waits', () => {
  const d = sandbox();
  const g = repo(d);
  const s2b = g.branch('feat/roadmap-s2b', ['s2b.txt']);
  const plan = g.branch('feat/plan', ['p1.txt', 'p2.txt']);
  const ootb = g.branch('feat/ootb', ['o1.txt', 'o2.txt']);
  const open = g.branch('feat/open', ['x.txt']);
  g.commit(g.r, 'main-moved.txt');   // main moves on: every merge below must rebase / squash
  const run = (lane, head) => d.ran({ lane, stage: 'S', worktree: g.r, head });
  const R = { s2b: run('roadmap', s2b), plan: run('plan', plan), ootb: run('ootb', ootb), open: run('open', open) };
  const merged = id => makeEval(d.state)({ kind: 'run', id, state: 'merged' });
  for (const id of Object.values(R)) assert.deepEqual(merged(id), { met: false, gone: null }, `${id}: not on main yet - waits`);
  // the MERGE rebases (a new sha) and fast-forwards main
  git(g.r, 'checkout', '-q', 'feat/roadmap-s2b'); git(g.r, 'rebase', '-q', 'main'); git(g.r, 'checkout', '-q', 'main'); git(g.r, 'merge', '-q', '--ff-only', 'feat/roadmap-s2b');
  assert.notEqual(git(g.r, 'rev-parse', 'feat/roadmap-s2b'), s2b, 'the rebase changed the sha');
  // a rebase then a --no-ff merge commit naming the branch (DEC-111: meta-plan R2 rebased 0ff2b78..62865e9, merged 7b28833)
  git(g.r, 'checkout', '-q', 'feat/plan'); git(g.r, 'rebase', '-q', 'main'); git(g.r, 'checkout', '-q', 'main'); git(g.r, 'merge', '-q', '--no-ff', '-m', 'merge: feat/plan', 'feat/plan');
  // a squash merge: one commit with the whole branch diff
  git(g.r, 'merge', '-q', '--squash', 'feat/ootb'); git(g.r, 'commit', '-q', '-m', 'squash ootb');
  git(g.r, 'branch', '-D', '-q', 'feat/roadmap-s2b', 'feat/plan', 'feat/ootb');   // the branches are gone after the merge
  for (const k of ['s2b', 'plan', 'ootb']) assert.deepEqual(merged(R[k]), { met: true, gone: null }, `${k}: its work is on main`);
  assert.deepEqual(merged(R.open), { met: false, gone: null }, 'unmerged work still waits');
  const a3 = queueRun(d.opts({ lane: 'roadmap', stage: 'S3', after: parseAfter(`run:${R.s2b}:merged`) })).run;
  const row = readiness(d.state).find(r => r.id === a3);
  assert.ok(!row.terms.some(t => /after|ruling|withdraw/.test(t)), row.terms.join('; '));
});

// ---------- case 3 (DEC-111, ledger 00:21Z): OOTB-REVIEW R2 RUN-383 after RUN-370 + RUN-317 merged, both rebased ----------
test('DEC-111: a queued run after two rebased merges is ready; "counted merged" is a recorded fact (norn runs landed) the evaluator honours', () => {
  const d = sandbox();
  const g = repo(d);
  const plan = g.branch('feat/meta-plan', ['plan.txt']);
  const auth = g.branch('feat/auth', ['auth.txt']);
  g.commit(g.r, 'other.txt');
  for (const b of ['feat/meta-plan', 'feat/auth']) { git(g.r, 'checkout', '-q', b); git(g.r, 'rebase', '-q', 'main'); git(g.r, 'checkout', '-q', 'main'); git(g.r, 'merge', '-q', '--ff-only', b); }
  const r370 = d.ran({ lane: 'meta-plan', stage: 'PLAN', worktree: g.r, head: plan });
  const r317 = d.ran({ lane: 'meta-auth', stage: 'AUTH-1', worktree: g.r, head: auth });
  const r383 = queueRun(d.opts({ lane: 'ootb-review', stage: 'R2', after: parseAfter(`run:${r370}:merged,run:${r317}:merged`) })).run;
  assert.deepEqual(evalAll(d.item(r383).data.after, makeEval(d.state)).met, true);
  // a run whose work landed in a way git cannot see (conflict-resolved by hand): the check-in records the ruling
  const hand = d.ran({ lane: 'meta-x', stage: 'S1', worktree: g.r, head: g.branch('feat/x', ['x.txt']) });
  const c = { kind: 'run', id: hand, state: 'merged' };
  assert.deepEqual(makeEval(d.state)(c), { met: false, gone: null });
  assert.equal(d.cli(['runs', 'landed', hand, '--as', 'checkin']).code, 2, 'refused without --why');
  const r = d.cli(['runs', 'landed', hand, '--why', 'DEC-111 counted merged', '--sha', 'abc1234', '--as', 'checkin']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(makeEval(d.state)(c), { met: true, gone: null });
  assert.equal(d.item(hand).landed.why, 'DEC-111 counted merged');
});

// ---------- case 4 (DEC-107, ledger 23:25Z): A5 RUN-356 + OOTB-REVIEW RUN-371 auto-withdrew SILENTLY ----------
test('DEC-107: run:X:done where X was filled into a STOPPED successor is held as "needs a ruling" (never withdrawn); the ruling releases it', () => {
  const d = sandbox();
  const r350 = queueRun(d.opts({ lane: 'meta-adopt', stage: 'A4' })).run;
  const r364 = d.ran({ lane: 'meta-adopt', stage: 'A4', from_queue: r350, outcome: null });
  d.rec('fill', { next: r364 }, r350);
  d.rec('end', { exit: 0, outcome: 'stopped' }, r364);
  const a5 = queueRun({ ...d.opts({ lane: 'meta-adopt', stage: 'A5', worktree: d.wt(2), after: parseAfter(`run:${r350}:done`) }), notBefore: '2099-01-01T00:00:00Z' }).run;   // never starts here
  assert.deepEqual(fillQueue(d.state), []);
  assert.equal(d.item(a5).state, 'queued', 'never a silent withdraw');
  assert.match(d.item(a5).hold.why, new RegExp(`run:${r350}:done: ${r350} \\(via ${r364}\\) ended stopped`));
  fillQueue(d.state);
  assert.equal(d.item(a5).history.filter(h => h.ev === 'hold').length, 1, 'recorded once, not every pass');
  const row = readiness(d.state).find(r => r.id === a5);
  assert.ok(row.hold && row.terms.some(t => t.startsWith('needs a ruling: ')), row.terms.join('; '));
  // the surfaces: the check-in's inbox, the digest row, the Plan "!"
  assert.equal(needsYou(d.item(a5)), 'needs a ruling');
  const dg = digest(d.state, {}, { dlv: [], ready: readiness(d.state) });
  assert.ok(dg.sections.queued.find(q => q.id === a5).terms.some(t => t.startsWith('needs a ruling')));
  const p = buildPlan({ runs: d.runs(), ready: readiness(d.state) });
  assert.equal(p.upnext.find(u => u.id === a5).status, 'ruling');
  assert.ok(p.chains.some(c => c.shape === '!' && c.steps.some(s => s.id === a5)), JSON.stringify(p.chains));
  // DEC-104 counted the stopped run's work merged: the ruling on the successor releases the family
  assert.equal(d.cli(['runs', 'landed', r364, '--why', 'DEC-104 a9cd80d merged', '--as', 'checkin']).code, 0);
  assert.deepEqual(makeEval(d.state)({ kind: 'run', id: r350, state: 'done' }), { met: true, gone: null });
  fillQueue(d.state);   // not_before holds the start; the hold clears
  assert.equal(d.item(a5).hold.cleared, true);
  assert.equal(needsYou(d.item(a5)), null);
});

// ---------- case 5 (DEC-107, ledger 23:25Z): RUN-379 A3 lacks after run:RUN-338:merged - withdraw + re-queue with both ----------
test('DEC-107: norn requeue swaps the conditions of a QUEUED run, keeps its args and rewires its dependants; recorded, role-checked, --why required', () => {
  const d = sandbox();
  const s3 = d.ran({ lane: 'roadmap', stage: 'S3' }), a1 = d.ran({ lane: 'meta-adopt', stage: 'A1' });
  const r379 = queueRun(d.opts({ lane: 'meta-adopt', stage: 'A3', round: 1, model: 'claude-opus-5-5', priority: 'P1', after: parseAfter(`run:${s3}:merged`) })).run;
  const r382 = queueRun(d.opts({ lane: 'meta-adopt', stage: 'A5', worktree: d.wt(2), after: parseAfter(`run:${r379}:merged,run:${s3}:done`) })).run;
  const conds = `run:${s3}:merged,run:${a1}:merged`;
  assert.equal(d.cli(['requeue', r379, '--after', conds, '--as', 'checkin']).code, 2, 'refused without --why');
  assert.equal(d.cli(['requeue', r379, '--after', conds, '--why', 'DEC-107', '--as', 'launcher']).code, 2, 'role-checked');
  assert.equal(d.item(r379).state, 'queued', 'a refusal changes nothing');
  const r = d.cli(['requeue', r379, '--after', conds, '--why', 'DEC-107', '--as', 'checkin']);
  assert.equal(r.code, 0, r.err);
  const next = r.out.match(/REQUEUED (RUN-\d+) -> (RUN-\d+)/)?.[2];
  assert.ok(next, r.out);
  const old = d.item(r379), nw = d.item(next);
  assert.equal(old.state, 'withdrawn');
  assert.deepEqual([old.withdraw.why, old.withdraw.next, old.history.at(-1).by], ['DEC-107', next, 'checkin']);
  assert.equal(nw.state, 'queued');
  assert.deepEqual(nw.data.after, parseAfter(conds));
  for (const k of ['lane', 'stage', 'round', 'model', 'priority', 'brief', 'worktree', 'executor']) assert.deepEqual(nw.data[k], old.data[k], k);
  assert.equal(nw.data.replaces, r379);
  assert.deepEqual(JSON.parse(fs.readFileSync(queueSpecPath(d.state, next), 'utf8')).after, parseAfter(conds));
  assert.match(r.out, new RegExp(`rewired ${r382}`));
  assert.deepEqual(d.item(r382).data.after, parseAfter(`run:${next}:merged,run:${s3}:done`), 'the dependant now waits on the re-queued run');
  assert.deepEqual(JSON.parse(fs.readFileSync(queueSpecPath(d.state, r382), 'utf8')).after, parseAfter(`run:${next}:merged,run:${s3}:done`));
  // a condition naming the withdrawn run still resolves (the withdraw names its successor)
  assert.deepEqual(makeEval(d.state)({ kind: 'run', id: r379, state: 'done' }), { met: false, gone: null });
  // never a RUNNING run
  const live = d.ran({ lane: 'live', stage: 'L1', outcome: null });
  const refused = d.cli(['requeue', live, '--after', conds, '--why', 'DEC-107', '--as', 'checkin']);
  assert.equal(refused.code, 3);
  assert.equal(d.item(live).state, 'running');
});

// ---------- case 6 (DEC-108, ledger 23:25Z / 23:27Z / 23:46Z): RUN-381, a limit re-queue made obsolete, sat queued for hours ----------
test('DEC-108: an obsolete limit re-queue is withdrawn by the check-in in the same pass', () => {
  const d = sandbox();
  const r376 = d.ran({ lane: 'meta-gtp-ci', stage: 'CIRED', executor: 'codex-astra', outcome: 'limit' });
  const r381 = queueRun({ ...d.opts({ lane: 'meta-gtp-ci', stage: 'CIRED' }), requeueOf: r376, notBefore: '2026-11-15T23:01:00Z' }).run;
  const r = d.cli(['stop', r381, '--as', 'checkin', '--why', 'DEC-108 obsolete: red fixed on Claude (RUN-239)']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`${r381} withdrawn`));
  assert.equal(d.item(r381).state, 'withdrawn');
});

// ---------- case 7 (DEC-106, ledger 23:14Z): S3 re-dispatched as RUN-378; A3 RUN-340 hung off the withdrawn RUN-306 ----------
test('DEC-106: a condition on a withdrawn / stopped run follows its successor of the same lane + stage; only a true orphan needs a ruling', () => {
  const d = sandbox();
  const r306 = queueRun(d.opts({ lane: 'meta-roadmap', stage: 'S3' })).run;
  const r340 = queueRun(d.opts({ lane: 'meta-adopt', stage: 'A3', worktree: d.wt(2), after: parseAfter(`run:${r306}:done`) })).run;
  d.rec('withdraw', { why: 'DEC-106 re-dispatched' }, r306, 'controller');
  const r378 = d.ran({ lane: 'meta-roadmap', stage: 'S3', round: 2, outcome: null });
  const ev = () => makeEval(d.state)({ kind: 'run', id: r306, state: 'done' });
  assert.deepEqual(ev(), { met: false, gone: null }, 'waits on the live successor');
  fillQueue(d.state);
  assert.equal(d.item(r340).state, 'queued');
  assert.equal(d.item(r340).hold, undefined, 'not held: it has a successor');
  d.rec('end', { exit: 0, outcome: 'done' }, r378);
  assert.deepEqual(ev(), { met: true, gone: null }, 'the successor ended DONE');
  // a stopped run with no successor of its lane + stage: a true orphan
  const lone = d.ran({ lane: 'meta-lone', stage: 'S1', outcome: 'stopped' });
  assert.match(makeEval(d.state)({ kind: 'run', id: lone, state: 'done' }).gone, /ended stopped/);
  // a later run of the same lane but ANOTHER stage is no successor
  d.ran({ lane: 'meta-lone', stage: 'S2', outcome: null });
  assert.match(makeEval(d.state)({ kind: 'run', id: lone, state: 'done' }).gone, /ended stopped/);
});
