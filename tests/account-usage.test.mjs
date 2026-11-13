// META-OPS-R3: the account's weekly number - every Claude assistant message in the transcripts root since the weekly reset
// (deduped msg id + request id, claude-* models), offset-cached per file in a state-dir cache file, read by the dash (never
// scanned inline); headline = account %, "outside runs" = account - runs (clamped). Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshAccountUsage, readAccountUsage, accountUsage, ACCOUNT_SOURCES, costRollup } from '../engine/lib/cost.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const tmp = () => mkTmp('meta-acct-');
const u = cr => ({ cache_read_input_tokens: cr, cache_creation_input_tokens: 0, input_tokens: 0, output_tokens: 0 });
const line = (id, req, cr, ts, model = 'claude-opus-5-5') => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: req,
  message: { id, model, role: 'assistant', content: [], usage: u(cr) } }) + '\n';
const NOW = Date.parse('2026-11-08T12:00:00Z'), SINCE = Date.parse('2026-11-04T14:00:00Z');
function setup() {
  const d = tmp(), pd = path.join(d, 'projects'), cacheFile = path.join(d, 'state', 'account-usage.json');
  fs.mkdirSync(path.join(pd, 'C--a', 'sid', 'subagents'), { recursive: true }); fs.mkdirSync(path.join(pd, 'C--b'), { recursive: true });
  return { d, pd, cacheFile, f: n => path.join(pd, n) };
}

test('account usage: deduped on message id + request id across files and within one; claude-* only; subagents count', () => {
  const s = setup();
  try {
    fs.writeFileSync(s.f('C--a/sid.jsonl'), line('m1', 'r1', 100, '2026-11-08T10:00:00Z') + line('m1', 'r1', 100, '2026-11-08T10:00:01Z')
      + '{"type":"user","timestamp":"2026-11-08T10:00:02Z"}\n' + line('m2', 'r2', 200, '2026-11-08T10:01:00Z')
      + line('m3', 'r3', 999, '2026-11-08T10:02:00Z', 'glm-4.6') + line('m4', 'r4', 999, '2026-11-08T10:02:00Z', '<synthetic>'));
    fs.writeFileSync(s.f('C--a/sid/subagents/agent-x.jsonl'), line('s1', 'q1', 30, '2026-11-08T10:03:00Z'));
    fs.writeFileSync(s.f('C--b/other.jsonl'), line('m1', 'r1', 100, '2026-11-08T10:00:00Z') + line('m1', 'r9', 7, '2026-11-08T10:04:00Z'));
    const r = refreshAccountUsage({ projectsDir: s.pd, cacheFile: s.cacheFile, now: NOW });
    assert.equal(r.files, 3); assert.ok(r.bytesRead > 0); assert.ok(Number.isFinite(r.ms));
    const a = readAccountUsage({ cacheFile: s.cacheFile, since: SINCE, now: NOW });
    assert.equal(a.cache_read, 100 + 200 + 30 + 7, 'm1:r1 once (dup line + copy in another file), m1:r9 is a new request, glm / synthetic out');
    assert.equal(a.messages, 4); assert.equal(a.provider, 'claude'); assert.equal(a.files, 3);
  } finally { fs.rmSync(s.d, { recursive: true, force: true }); }
});

test('account usage: the window edge is the exact reset instant (timestamp >= since), not the bucket or the day', () => {
  const s = setup();
  try {
    fs.writeFileSync(s.f('C--a/sid.jsonl'), line('a', '1', 1, '2026-11-04T13:59:59.999Z') + line('b', '2', 10, '2026-11-04T14:00:00.000Z')
      + line('c', '3', 100, '2026-11-04T09:00:00Z') + line('d', '4', 1000, '2026-11-08T11:59:00Z'));
    refreshAccountUsage({ projectsDir: s.pd, cacheFile: s.cacheFile, now: NOW });
    assert.equal(readAccountUsage({ cacheFile: s.cacheFile, since: SINCE, now: NOW }).cache_read, 1010);
    assert.equal(readAccountUsage({ cacheFile: s.cacheFile, since: Date.parse('2026-11-04T13:59:59.999Z'), now: NOW }).cache_read, 1011);
    assert.equal(readAccountUsage({ cacheFile: s.cacheFile, since: SINCE, until: Date.parse('2026-11-08T11:59:00Z'), now: NOW }).cache_read, 10,
      'until is exclusive (a reading at a past instant)');
  } finally { fs.rmSync(s.d, { recursive: true, force: true }); }
});

test('account usage: no cache file reads null; a provider without an account source is n/a; the cache age is reported', () => {
  const s = setup();
  try {
    assert.equal(readAccountUsage({ cacheFile: s.cacheFile, since: SINCE, now: NOW }), null);
    assert.ok(ACCOUNT_SOURCES.claude && !ACCOUNT_SOURCES.codex);
    assert.equal(accountUsage('codex', { cacheFile: s.cacheFile, since: SINCE }), null);
    fs.writeFileSync(s.f('C--a/sid.jsonl'), line('a', '1', 5, '2026-11-08T10:00:00Z'));
    refreshAccountUsage({ projectsDir: s.pd, cacheFile: s.cacheFile, now: NOW - 60000 });
    const a = accountUsage('claude', { cacheFile: s.cacheFile, since: SINCE, now: NOW });
    assert.equal(a.at, new Date(NOW - 60000).toISOString()); assert.equal(a.age_s, 60);
  } finally { fs.rmSync(s.d, { recursive: true, force: true }); }
});

const NOWR = Date.parse('2026-11-08T12:00:00Z');
const runAt = (id, cr) => ({ id, kind: 'run', state: 'exited', created: '2026-11-08T10:00:00Z', updated: '2026-11-08T10:05:00Z',
  data: { kind: 'worker', executor: 'claude', lane: 'gen' }, end: { usage: u(cr) }, history: [{ ev: 'start', ts: '2026-11-08T10:00:00Z' }] });

test('costRollup: headline = account % since the reset, lanes stay runs, outside runs = account - runs; clamped with the raw delta', () => {
  const o = { now: NOWR, days: 7, cacheRPerPct: 1000, resetAt: '2026-11-04T14:00:00.000Z' };
  const acct = cr => ({ provider: 'claude', cache_read: cr, messages: 3, files: 2, at: '2026-11-08T11:59:00.000Z', age_s: 60 });
  const r = costRollup([runAt('RUN-1', 3000)], { ...o, account: acct(5000) });
  assert.deepEqual([r.headline.source, r.headline.pct], ['account', 5]);
  assert.equal(r.totals.claude.pct, 3, 'runs total unchanged'); assert.equal(r.rows[0].pct, 3, 'lane rows stay runs');
  assert.deepEqual([r.account.pct, r.account.outside.cache_read, r.account.outside.pct, r.account.outside.raw_pct, r.account.outside.clamped], [5, 2000, 2, 2, false]);
  const neg = costRollup([runAt('RUN-1', 3000)], { ...o, account: acct(2500) });
  assert.deepEqual([neg.account.outside.pct, neg.account.outside.raw_pct, neg.account.outside.clamped], [0, -0.5, true]);
  const na = costRollup([runAt('RUN-1', 3000)], o);
  assert.deepEqual([na.headline.source, na.headline.pct, na.account], ['runs', 3, null], 'no account source: account n/a, the runs headline');
});
