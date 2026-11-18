// Lane lifecycle (lane norn-lifecycle item 5): no lane sits. The evidence shapes of solve-shack, each red first: a lane a check-in
// created and dispatched elsewhere (docs-fixer-2), an owner lane with a brief and no run (model-tab-visualization), a stopped lane whose
// work landed (run-efficiency), a stopped lane whose work did not, and a done lane archived archive_days after its merged end.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { record, loadState } from '../engine/lib/records.mjs';
import { laneRules, tickLanes, lanesProbe, lanePolicy } from '../engine/lib/lifecycle.mjs';
import { lanesView } from '../engine/lib/lanes.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const T0 = Date.parse('2026-11-17T10:00:00Z'), H = 3600e3, D = 24 * H;
const at = ms => () => new Date(ms);
const rec = (state, ev, o = {}) => record(state, ev, { views: false, ...o });
const start = (state, lane, ms, extra = {}) => rec(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane, stage: 'FIX', ...extra } }, { now: at(ms) }).id;
const end = (state, id, ms, outcome, why) => rec(state, { kind: 'run', ev: 'end', id, by: 'launcher', data: { exit: 0, outcome, ...(why ? { why } : {}) } }, { now: at(ms) });
const lane = (state, name, ms, o = {}) => rec(state, { kind: 'lane', ev: 'create', id: `L:${name}`, by: o.by || 'owner', data: { name } }, { now: at(ms), ...(o.run ? { run: o.run } : {}) });
const archives = (state, name) => loadState(state).items[`L:${name}`].history.filter(h => h.ev === 'archive');
const noGit = () => null;   // no repo: nothing counts merged by git (rulings only)

test('docs-fixer-2: a lane a check-in created and dispatched nothing on is archived by the tick once that check-in ended', () => {
  const state = mkTmp('lc-orphan-');
  lane(state, 'docs-fixer', T0);
  const ck = start(state, 'checkin', T0 + H, { kind: 'checkin' });
  lane(state, 'docs-fixer-2', T0 + H + 1000, { by: 'checkin', run: ck });
  const work = start(state, 'docs-fixer', T0 + H + 2000, { stage: 'fix2' });   // the brief went to the old lane (RUN-26)
  assert.deepEqual(tickLanes(state, { now: T0 + H + 3000, git: noGit }), [], 'not while the check-in runs (it may still dispatch on it)');
  end(state, ck, T0 + H + 60000, 'done');
  const out = tickLanes(state, { now: T0 + 2 * H, git: noGit });
  assert.deepEqual(out.map(x => [x.id, x.rule]), [['L:docs-fixer-2', 'orphan']]);
  const a = archives(state, 'docs-fixer-2');
  assert.equal(a.length, 1); assert.equal(a[0].by, 'tick'); assert.match(a[0].data.why, new RegExp(`created by check-in ${ck}`));
  assert.equal(loadState(state).items['L:docs-fixer'].state, 'active', 'the lane that got the work stays');
  assert.equal(loadState(state).items[work].state, 'running');
});

test('model-tab-visualization: an owner lane with no run is idle past policy.idle_lanes.hours - a check-in finding, the Lanes page says idle', () => {
  const state = mkTmp('lc-idle-');
  lane(state, 'model-tab-visualization', T0);
  assert.deepEqual(laneRules(loadState(state), { now: T0 + 5 * H }), [], 'young: no finding yet');
  const rows = laneRules(loadState(state), { now: T0 + 7 * H });
  assert.deepEqual(rows.map(x => [x.id, x.rule, x.act]), [['L:model-tab-visualization', 'idle', 'checkin']]);
  assert.match(rows[0].why, /start it, park it with a why, or archive it/);
  assert.deepEqual(laneRules(loadState(state), { now: T0 + 7 * H, idleH: 12 }), [], 'the policy hours');
  assert.deepEqual(lanePolicy({ idle_lanes: { hours: 12 } }).idleH, 12);
  const v = lanesView(loadState(state), { now: T0 + 7 * H }).find(l => l.name === 'model-tab-visualization');
  assert.equal(v.text, 'idle: no run'); assert.equal(v.group, 'needs', 'not shown as active / queued');
  assert.deepEqual(tickLanes(state, { now: T0 + 7 * H, git: noGit }), [], 'never archived by the tick: the check-in decides');
  assert.deepEqual(lanesProbe({})({ at: T0 + 7 * H, items: Object.values(loadState(state).items) }), ['lanes:idle:L:model-tab-visualization'], 'a gate wake');
  const d = digest(state, {}, { now: T0 + 7 * H, git: noGit });
  assert.deepEqual(d.sections.lanes.map(x => [x.id, x.rule]), [['L:model-tab-visualization', 'idle']], 'a digest row');
});

test('run-efficiency: a stopped lane whose work landed (norn runs landed) is archived by the tick; a stopped-not-landed lane never is', () => {
  const state = mkTmp('lc-stopped-');
  lane(state, 'run-efficiency', T0); lane(state, 'stuck-one', T0);
  const a = start(state, 'run-efficiency', T0 + H), b = start(state, 'stuck-one', T0 + H);
  end(state, a, T0 + 2 * H, 'stopped', 'merge conflict'); end(state, b, T0 + 2 * H, 'stopped', 'needs an owner pick');
  rec(state, { kind: 'run', ev: 'landed', id: a, by: 'checkin', data: { why: 'DEC-9: landed as uncle-chucks PR #6' } });
  const rows = laneRules(loadState(state), { now: T0 + 3 * H, landed: (_, r) => !!r.landed });
  assert.deepEqual(rows.map(x => [x.id, x.rule, x.act]).sort(), [['L:run-efficiency', 'stopped', 'tick'], ['L:stuck-one', 'stopped', 'checkin']]);
  assert.equal(rows.find(x => x.id === 'L:stuck-one').text, 'stopped: needs a check-in decision');
  const out = tickLanes(state, { now: T0 + 3 * H, git: noGit });
  assert.deepEqual(out.map(x => x.id), ['L:run-efficiency']);
  assert.match(archives(state, 'run-efficiency')[0].data.why, /ruled landed: DEC-9/);
  assert.equal(loadState(state).items['L:stuck-one'].state, 'active', 'its work did not land: never auto-archived');
  assert.deepEqual(tickLanes(state, { now: T0 + 30 * D, git: noGit }), [], 'not later either');
  const v = lanesView(loadState(state), { now: T0 + 3 * H }).find(l => l.name === 'stuck-one');
  assert.equal(v.rule?.text, 'stopped: needs a check-in decision', 'the Lanes page says which rule acts');
  const d = digest(state, {}, { now: T0 + 3 * H, git: noGit });
  assert.deepEqual(d.sections.lanes.map(x => [x.id, x.rule]), [['L:stuck-one', 'stopped']]);
});

test('a done lane whose work is merged is archived archive_days after its end (by: tick, Undo-able); unmerged or archive_days 0 stays', () => {
  const state = mkTmp('lc-done-');
  for (const n of ['merged', 'unmerged', 'live']) lane(state, n, T0);
  const m = start(state, 'merged', T0), u = start(state, 'unmerged', T0), l = start(state, 'live', T0);
  for (const id of [m, u, l]) end(state, id, T0 + H, 'done');
  rec(state, { kind: 'run', ev: 'landed', id: m, by: 'checkin', data: { why: 'DEC-1 squash-merged' } });
  start(state, 'live', T0 + 2 * H);   // a new round is running: never archived
  const rows = laneRules(loadState(state), { now: T0 + 5 * D, merged: (_, r) => !!r.landed });
  assert.deepEqual(rows.map(x => [x.id, x.act, x.text]), [['L:merged', 'tick', 'archives in 3 days'], ['L:unmerged', 'wait', 'done, not merged: stays until its work is on main']]);
  assert.deepEqual(tickLanes(state, { now: T0 + 5 * D, git: noGit }), [], 'before archive_days');
  assert.deepEqual(tickLanes(state, { now: T0 + 8 * D, git: noGit, project: { policy: { done_lanes: { archive_days: 0 } } } }), [], '0 = off');
  const out = tickLanes(state, { now: T0 + 8 * D, git: noGit });
  assert.deepEqual(out.map(x => [x.id, x.rule]), [['L:merged', 'archive']]);
  const st = loadState(state);
  assert.equal(st.items['L:merged'].state, 'archived'); assert.equal(archives(state, 'merged')[0].by, 'tick');
  assert.equal(st.items['L:unmerged'].state, 'active'); assert.equal(st.items['L:live'].state, 'active');
  rec(state, { kind: 'lane', ev: 'unarchive', id: 'L:merged', by: 'dashboard', data: {} });   // the Lanes page Unarchive
  assert.equal(loadState(state).items['L:merged'].state, 'active');
});

test('the archived lane\'s worktree goes only when clean and on main; a dirty one stays, recorded as work at risk', () => {
  const t = mkTmp('lc-wt-'), repo = path.join(t, 'repo'), state = path.join(t, 'state', 'p');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
  const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(state, { recursive: true });
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'commit.gpgsign', 'false'); fs.writeFileSync(path.join(repo, 'a'), 'a'); g(repo, 'add', 'a'); g(repo, 'commit', '-q', '-m', 'init');
  const clean = path.join(t, 'wt-clean'), dirty = path.join(t, 'wt-dirty');
  g(repo, 'worktree', 'add', '-q', '-b', 'lane/clean', clean); g(repo, 'worktree', 'add', '-q', '-b', 'lane/dirty', dirty);
  fs.writeFileSync(path.join(dirty, 'wip.txt'), 'not committed');
  for (const [n, wt] of [['clean', clean], ['dirty', dirty]]) {
    lane(state, n, T0); const id = start(state, n, T0, { worktree: wt }); end(state, id, T0 + H, 'stopped', 'x');
    rec(state, { kind: 'run', ev: 'landed', id, by: 'checkin', data: { why: 'DEC-2' } });
  }
  const out = tickLanes(state, { now: T0 + 2 * H, project: { root: repo } });
  assert.deepEqual(out.map(x => [x.id, x.worktree]).sort(), [['L:clean', 'removed'], ['L:dirty', 'kept']]);
  assert.equal(fs.existsSync(clean), false); assert.equal(fs.readFileSync(path.join(dirty, 'wip.txt'), 'utf8'), 'not committed');
  assert.match(archives(state, 'dirty')[0].data.at_risk, /uncommitted changes/);
});

test('the gate probe: a lane with a live run is never idle; a lane rule wakes the check-in only for its own findings', () => {
  const state = mkTmp('lc-probe-');
  lane(state, 'busy', T0); lane(state, 'quiet', T0);
  start(state, 'busy', T0 + 7 * H);
  const st = loadState(state), items = Object.values(st.items);
  const probe = lanesProbe({})({ at: T0 + 8 * H, items: items.filter(i => i.kind !== 'run'), runs: items.filter(i => i.kind === 'run') });
  assert.deepEqual(probe, ['lanes:idle:L:quiet']);
});

test('CI reds on main: two successive reds -> one lane (ci-fix), two runs; the second resets the branch from main once the first landed', async () => {
  const { ciFixPlan } = await import('../engine/lib/lifecycle.mjs');
  const state = mkTmp('lc-ci-');
  const p1 = ciFixPlan(loadState(state), { run: 101 });
  assert.deepEqual([p1.lane, p1.stage, p1.round, p1.create, p1.reset], ['ci-fix', 'CI-101', 1, true, false]);
  lane(state, p1.lane, T0, { by: 'checkin' });
  const a = start(state, p1.lane, T0, { stage: p1.stage, round: p1.round });
  const mid = ciFixPlan(loadState(state), { run: 102 });
  assert.equal(mid.live, a, 'a red while the fix runs waits for it (one writer)'); assert.match(mid.line, new RegExp(`after run:${a}:ended`));
  end(state, a, T0 + H, 'done');
  rec(state, { kind: 'run', ev: 'landed', id: a, by: 'checkin', data: { why: 'DEC-3 merged' } });
  const p2 = ciFixPlan(loadState(state), { run: 102 });
  assert.deepEqual([p2.lane, p2.stage, p2.round, p2.create, p2.reset, p2.live], ['ci-fix', 'CI-102', 1, false, true, null]);
  assert.match(p2.line, /reset the lane branch from main/);
  start(state, p2.lane, T0 + 2 * H, { stage: p2.stage, round: p2.round });
  const st = loadState(state), lanes = Object.values(st.items).filter(i => i.kind === 'lane');
  assert.deepEqual(lanes.map(l => l.id), ['L:ci-fix'], 'one lane');
  assert.equal(Object.values(st.items).filter(i => i.kind === 'run' && i.data.lane === 'ci-fix').length, 2, 'two runs');
  assert.equal(ciFixPlan(st, { run: 102 }).round, 2, 'the same red again = the next round of its stage');
  rec(state, { kind: 'lane', ev: 'archive', id: 'L:ci-fix', by: 'tick', data: { why: 'done, merged, old' } });
  assert.match(ciFixPlan(loadState(state), { run: 103 }).line, /META rec unarchive L:ci-fix/, 'archived by the rules: unarchived, never a new lane');
});
