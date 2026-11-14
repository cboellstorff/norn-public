// META-TEND P6: the Guard on the dashboard - GET /api/guard (a sandboxed fixture: temp HOME, no real ~/.claude) over SloppaChoppa's
// open BLOCK findings, the tests advisories and the instruction scan (a worker, never on the request path); the Guard tab; the chips
// in place on Agents, Docs and Settings; pop-ups ship off.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers/dash-fixture.mjs';
import { advisory } from '../engine/lib/advisory.mjs';
import { renderTab, renderNav, NORN_GROUPS } from '../engine/dash/ui.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('GET /api/guard: code, tests and the instruction scan in one ranked list, each with the tab that fixes it; pop-ups off', { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    const S = f.pa.state;
    fs.mkdirSync(path.join(S, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(S, 'tests', 'advisories.json'), JSON.stringify({ at: new Date().toISOString(), list: [advisory({ phase: 'TESTS', key: 'tests-copy-paste', severity: 'medium', surface: 'test file', path: 'tests/a.test.mjs', why: 'copy-paste', source: 't', fix: { tier: 'flag', action: 'look' } })] }));
    let g0 = (await f.get('/api/guard?project=kestrel')).data;
    assert.ok(g0.rows.every(r => !r.new), 'while the instruction scan is pending there is no baseline yet: nothing is new');
    for (let i = 0; g0.pending && i < 1200; i++) { await sleep(100); g0 = (await f.get('/api/guard?project=kestrel')).data; }
    assert.equal(g0.pending, false, 'the instruction scan lands from its worker');
    assert.ok(g0.rows.some(r => r.type === 'tests') && g0.rows.every(r => !r.new), 'the first full scan is the baseline: nothing in it is new');
    assert.ok(fs.existsSync(path.join(S, 'advisory', 'guard-baseline.json')));
    await sleep(5);
    fs.mkdirSync(path.join(S, 'slop'), { recursive: true });
    fs.writeFileSync(path.join(S, 'slop', 'holds.json'), JSON.stringify({ 'feat/x': { lane: 'seabed', run: 'RUN-1', base: 'a', head: 'b', at: new Date().toISOString(),
      blocks: [{ rule: 'K2', level: 'BLOCK', file: 'engine/a.mjs', line: 4, msg: 'an empty catch', fp: 'fp1' }] } }));
    let g = (await f.get('/api/guard?project=kestrel')).data;
    const code = g.rows.find(r => r.type === 'code');
    assert.deepEqual([code.severity, code.go], ['high', { tab: 'agents', jump: 'node-RUN-1' }]);
    assert.equal(code.new, true, 'first seen after the baseline = new');
    assert.equal(g.rows[0].id, code.id, 'the new blocker ranks first');
    assert.ok(g.rows.some(r => r.type === 'tests' && r.go.tab === 'tests' && !r.new), 'a baseline row stays not new on a later scan');
    assert.deepEqual(g.voice, { popups: 'off', daily_cap: 3 }, 'pop-ups ship off (DIR-36)');
    assert.equal(g.types.find(t => t.type === 'code').open, 1);
    assert.deepEqual(g.errors, []);
    assert.ok(g.ledger && Number.isInteger(g.ledger.prose), 'the rule ledger summary');
    assert.ok(fs.existsSync(path.join(S, 'advisory', 'seen.json')), 'first_seen lives in the one seen store');
    const html = renderTab('guard', g, { project: 'kestrel' });
    for (const id of ['guard-orc', 'guard-line', 'guard-types', 'guard-ledger', 'guard-rows', `guard-${code.id}`]) assert.ok(html.includes(`id="${id}"`), id);
    assert.match(html, /data-go="agents" data-gojump="node-RUN-1"/);
    assert.match(html, /Pop-ups: <b>off<\/b>/);
    assert.match(html, /data-act="orc-call"/);
    // a chip in place on the run that owns the block
    const ag = { ...(await f.get('/api/agents?project=kestrel')).data, top: [], guard: g };
    assert.match(renderTab('agents', ag, { project: 'kestrel' }), /id="node-RUN-1"[^]*?Guard finding/);
    // a chip in place on the Settings class row a model advice is about
    const set = { ...(await f.get('/api/settings?project=kestrel')).data, guard: { rows: [{ id: 'M-1', type: 'models', cls: 'chores', severity: 'medium', why: 'Chores on a top model' }] } };
    assert.match(renderTab('settings', set, { project: 'kestrel' }), /id="grp-executors-routing-chores"[^>]*><div class="sl"><b>Chores<\/b> <button class="lnk gchip" data-go="usage" data-gojump="usage-advice"/);
    assert.equal((await f.get('/api/guard?project=all')).status, 400, 'one project');
  } finally { await f.done(); }
});

test('the Guard sits in Verdandi beside Instructions and Usage; chips in place on Docs', () => {
  const ver = NORN_GROUPS.find(g => g[0] === 'verdandi')[3];
  assert.deepEqual(ver.slice(ver.indexOf('usage')), ['usage', 'tests', 'instructions', 'guard']);
  assert.match(renderNav('guard', {}, 'norn'), /id="tab-guard"[^>]*aria-selected="true"/);
  const docs = renderTab('docs', { docs: [{ i: 0, tab: 'Plan', exists: true }, { i: 1, tab: 'Spec', exists: true }], doc: null,
    guard: { rows: [{ id: 'x', severity: 'medium', why: 'a dead path', go: { tab: 'docs', doc: 1 } }] } }, {});
  assert.match(docs, /id="doc-1"[^>]*>Spec <span class="gchip"[^>]*><span class="chip warn">1 Guard finding/);
  assert.ok(!/id="doc-0"[^>]*>Plan <span class="gchip"/.test(docs));
});
