// META-OPS-R1 #7: the Usage tab - /api/usage over fixture state (Claude transcript fallback for a run with no final json, Codex
// live rollout total), cached one UI tick (15 s), the window clamp, All projects; the renderer and its group-by. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TABS, loadTab, renderTab, usageGroup } from '../engine/dash/ui.mjs';
import { TABS as SERVER_TABS } from '../engine/dash/server.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { record } from '../engine/lib/records.mjs';
import { weekStart } from '../engine/lib/cost.mjs';

const getter = f => async r => { const x = await f.get(r); if (x.status !== 200) throw new Error(`${r} -> ${x.status} ${x.data.error}`); return x.data; };

test('/api/usage: per-run rows from the fixture transcripts + rollout, weighted % via the budget calibration, cached one tick', async () => {
  const f = await fixture();
  try {
    const a = await f.get('/api/usage?project=kestrel');
    assert.equal(a.status, 200);
    assert.equal(a.data.parts.length, 1);
    const p = a.data.parts[0];
    assert.equal(p.project, 'kestrel'); assert.equal(p.days, 7); assert.equal(p.calib.cacheR_per_pct, 40900000);
    assert.equal(p.window, 'week', 'the budget reset sets the headline window'); assert.equal(p.since, new Date(weekStart(Date.parse('2026-11-04T08:00'), Date.parse(p.now))).toISOString());
    const seabed = p.rows.find(r => r.lane === 'seabed');
    assert.equal(seabed.family, 'claude'); assert.equal(seabed.runs, 1);
    assert.ok(seabed.cache_read > 0 && seabed.output > 0, 'the stopped run without a final usage counts its transcript');
    assert.ok(seabed.pct > 0 && Math.abs(p.totals.claude.pct - p.totals.claude.cache_read / 40900000) < 1e-12);
    const render = p.rows.find(r => r.lane === 'render');
    assert.deepEqual([render.family, render.executor, render.running, render.pct], ['codex', 'codex-sol', 1, null]);
    assert.equal(render.tokens, 60559, 'Codex: the live rollout total');
    assert.equal(a.data.cached, false); assert.ok(Number.isFinite(a.data.ms));
    const b = await f.get('/api/usage?project=kestrel');
    assert.equal(b.data.cached, true, 'a second view inside the 15 s tick is served from the cache');
    assert.equal((await f.get('/api/usage?project=kestrel&days=999')).data.parts[0].days, 30, 'window clamped to 30 days');
    const all = await f.get('/api/usage?project=all');
    assert.deepEqual(all.data.parts.map(x => x.project), ['kestrel', 'other']);
  } finally { await f.done(); }
});

test('Usage renderer: summary, check-in baseline, by lane / stage / executor / day; All projects one section each', async () => {
  const f = await fixture();
  try {
    const get = getter(f);
    const ck = record(f.pa.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'checkin', executor: 'claude', lane: 'checkin' } });
    record(f.pa.state, { kind: 'run', ev: 'end', id: ck.id, by: 'launcher', data: { exit: 0, outcome: 'done',
      usage: { cache_read_input_tokens: 1361736, cache_creation_input_tokens: 53419, input_tokens: 36, output_tokens: 9867 } } });
    const html = renderTab('usage', await loadTab('usage', 'kestrel', get), { project: 'kestrel' });
    for (const id of ['id="panel-usage"', 'id="usage-summary"', 'id="usage-checkins"', 'id="usage-lane"', 'id="usage-stage"', 'id="usage-executor"', 'id="usage-day"'])
      assert.ok(html.includes(id), id);
    for (const s of ['since the weekly reset', 'rolling 7 days', 'seabed', 'codex-sol', '% of week', 'tokens / tick', 'ticks / day', 'cacheR_per_pct', '1.4M cache read', '10k output']) assert.ok(html.includes(s), s);
    const all = renderTab('usage', await loadTab('usage', 'all', get), { project: 'all' });
    assert.ok(all.includes('id="usage-kestrel"') && all.includes('id="usage-other"'));
  } finally { await f.done(); }
});

test('usageGroup: Claude types and % summed per key, Codex / provider tokens apart, executors listed', () => {
  const rows = [
    { lane: 'gen', stage: 'S1', executor: 'claude', day: 'd1', family: 'claude', runs: 2, running: 1, tokens: 160, cache_read: 100, cache_create: 10, input: 0, output: 50, weighted: 2850, pct: 0.5 },
    { lane: 'gen', stage: 'S2', executor: 'claude', day: 'd2', family: 'claude', runs: 1, running: 0, tokens: 40, cache_read: 40, cache_create: 0, input: 0, output: 0, weighted: 40, pct: 0.25 },
    { lane: 'gen', stage: 'S2', executor: 'codex-sol', day: 'd2', family: 'codex', runs: 1, running: 0, tokens: 7000, cache_read: null, cache_create: null, input: null, output: null, weighted: null, pct: null },
    { lane: 'gen', stage: 'S2', executor: 'glm', day: 'd2', family: 'provider', runs: 1, running: 0, tokens: 20, cache_read: 10, cache_create: 0, input: 5, output: 5, weighted: 360, pct: null },
  ];
  const [g] = usageGroup(rows, ['lane']);
  assert.deepEqual([g.lane, g.runs, g.running, g.cache_read, g.output, g.pct, g.codex, g.provider], ['gen', 5, 1, 140, 50, 0.75, 7000, 20]);
  assert.deepEqual(g.executors, ['claude', 'codex-sol', 'glm']);
  assert.deepEqual(usageGroup(rows, ['lane', 'stage']).map(x => x.stage), ['S1', 'S2'], 'sorted by % first');
  assert.equal(usageGroup(rows.slice(2, 3), ['lane'])[0].pct, null, 'no Claude row: no %');
});

test('/api/usage account headline (META-OPS-R3): never scanned inline - a background refresh writes the cache, the view reads it', async () => {
  const f = await fixture();
  try {
    const now = new Date().toISOString(), fresh = path.join(f.root, 'claude-projects', 'C--fx-wt', 'interactive.jsonl');
    fs.writeFileSync(fresh, JSON.stringify({ type: 'assistant', timestamp: now, requestId: 'rq', message: { id: 'mx', model: 'claude-opus-5-5',
      usage: { cache_read_input_tokens: 409000000, cache_creation_input_tokens: 0, input_tokens: 0, output_tokens: 0 } } }) + '\n');
    const a = (await f.get('/api/usage?project=kestrel')).data;
    assert.equal(a.parts[0].headline.source, 'runs', 'no cache yet: the runs headline'); assert.equal(a.parts[0].account, null);
    assert.equal(a.account_refresh.running, true, 'the first view starts the background refresh');
    const done = await f.app.accountRefresh();
    assert.ok(done.ok && done.files >= 1 && Number.isFinite(done.ms));
    const b = (await f.get('/api/usage?project=kestrel&days=6')).data, p = b.parts[0];
    assert.equal(p.headline.source, 'account');
    assert.ok(p.account.cache_read >= 409000000 && Math.abs(p.headline.pct - p.account.cache_read / 40900000) < 1e-9);
    assert.ok(Number.isFinite(p.account.age_s) && b.account_refresh.last.ok);
    const html = renderTab('usage', b, { project: 'kestrel' });
    for (const s of ['id="usage-account"', 'outside runs (interactive)', 'account, since the weekly reset', 'cache age']) assert.ok(html.includes(s), s);
    const na = renderTab('usage', a, { project: 'kestrel' });
    assert.ok(na.includes('account: n/a'), 'no account number: n/a + the runs headline');
  } finally { await f.done(); }
});
