// META-AUTH AUTH-1: an expired CLI login is its own outcome (`auth`), not a crash. The killed run is re-queued (its own session
// resumed); while the login is down new dispatches hold (like RATE_OK); a cheap probe (backoff, bounded) reopens the gate; one owner
// notice after 10 min. Temp dirs only; the fake executor stands in for claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRun, fillQueue, queueRun, queueSpecPath } from '../engine/lib/runs.mjs';
import { authPatterns, AUTH_PATTERNS } from '../engine/lib/executors.mjs';
import { classifyAuth, markAuthDown, authRefusal, authNoticeDue, readAuth, authFile, AUTH_NOTICE_MIN, CANARY_MS, probeBackoffMs } from '../engine/lib/authguard.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { tick } from '../engine/lib/tick.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const t0 = performance.now();
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); }
}
function sandbox() {
  const t = mkTmp('meta-auth-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks']) fs.mkdirSync(d[k], { recursive: true });
  d.wt = n => { const w = path.join(t, 'wt' + n); fs.mkdirSync(w, { recursive: true }); return w; };
  d.brief = (body, name = 'brief.md') => { const f = path.join(t, name); fs.writeFileSync(f, body); return f; };
  d.runs = () => Object.values(loadState(d.state).items).filter(i => i.kind === 'run');
  d.item = id => loadState(d.state).items[id];
  d.opts = (o = {}) => ({ state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt(1), notes: d.notes, hbMs: 150, staleMs: 3000,
    policy: { auto_resume_max: 0 }, budget: { max_claude_workers: 2 }, tick: null, ...o });
  d.ended = id => waitFor(() => { const it = d.item(id); return settled(it) && it; });
  return d;
}
// the incident's final (state/norn/logs/checkin-20261112-202133-de028b.json), trimmed to the fields that matter
const INCIDENT = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', duration_ms: 174, num_turns: 1,
  result: 'Failed to authenticate: OAuth session expired and could not be refreshed', session_id: '760923ee-1ceb-4309-988d-1231dba4d473' });

// ---------- signatures: data per executor ----------
test('auth signatures: claude (the 2026-11-12 incident + API 401 shapes) / codex / grok rows are data; fake = claude; entry.auth overrides', () => {
  const claude = authPatterns('claude');
  assert.deepEqual(authPatterns('fake').match, claude.match, 'the fake stands in for claude (no probe: tests inject it)');
  assert.equal(classifyAuth(INCIDENT, claude).line.includes('OAuth session expired'), true);
  for (const s of ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
    'Invalid API key · Please run /login', 'OAuth token revoked · Please run /login'])
    assert.ok(classifyAuth(s, claude), s);
  for (const s of ['Claude AI usage limit reached|1762970000', 'TypeError: boom', 'API Error: Rate limit reached', '"type":"result","result":"fake crash"'])
    assert.equal(classifyAuth(s, claude), null, s);
  const codex = authPatterns('codex-sol');
  assert.deepEqual(authPatterns('codex-astra'), codex);
  assert.ok(classifyAuth('ERROR: Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.', codex));
  assert.ok(classifyAuth('stream error: unexpected status 401 Unauthorized: {"error":{"code":"token_expired"}}', codex));
  assert.equal(classifyAuth("ERROR: You've hit your usage limit.", codex), null);
  assert.deepEqual(authPatterns('grok', { type: 'cli', exe: 'grok' }), AUTH_PATTERNS.grok);
  const own = { match: ['custom login gone'], login: 'x login' };
  assert.deepEqual(authPatterns('grok', { type: 'cli', auth: own }), own);
  assert.equal(classifyAuth('anything', { match: [] }), null);
  for (const n of ['claude', 'codex']) assert.ok(AUTH_PATTERNS[n].login, `${n}: the login command the owner notice names`);
});

// ---------- the gate: open / probe with backoff / half-open canary / closed ----------
test('auth gate: down -> held until the probe is due; a failed probe backs off (bounded); a pass lets ONE canary through, then closes', () => {
  const d = sandbox();
  const t0 = Date.parse('2026-11-12T20:21:13Z');
  assert.equal(authRefusal(d.state, 'fake', { now: t0 }), null, 'no record = open');
  markAuthDown(d.state, { harness: 'fake', line: 'Failed to authenticate', run: 'RUN-1', now: t0 });
  assert.equal(path.dirname(authFile(d.state)), path.dirname(path.resolve(d.state)), 'machine-wide: the state home, shared by its projects');
  assert.equal(authRefusal(d.state, 'claude', { now: t0 }), null, 'another harness is not held');
  let probes = 0;
  const no = () => { probes++; return false; }, yes = () => { probes++; return true; };
  assert.match(authRefusal(d.state, 'fake', { now: t0 + 1000, probe: no }), /^auth: /);
  assert.equal(probes, 0, 'not probed before next_probe');
  assert.match(authRefusal(d.state, 'fake', { now: t0 + probeBackoffMs(0), probe: no }), /^auth: /);
  assert.equal(probes, 1);
  assert.equal(readAuth(d.state).fake.tries, 1);
  const due = Date.parse(readAuth(d.state).fake.next_probe);
  assert.equal(due, t0 + probeBackoffMs(0) + probeBackoffMs(1));
  assert.ok(probeBackoffMs(1) > probeBackoffMs(0) && probeBackoffMs(30) === probeBackoffMs(99), 'exponential, capped');
  assert.match(authRefusal(d.state, 'fake', { now: due, probe: yes, dry: true }), /^auth: /, 'a dry walk never probes');
  assert.equal(probes, 1);
  assert.equal(authRefusal(d.state, 'fake', { now: due, probe: yes }), null, 'probe passes: this caller is the canary');
  assert.match(authRefusal(d.state, 'fake', { now: due + 1000, probe: yes }), /canary/, 'one launch at a time until the canary lives');
  // the canary died on auth again: the episode goes on (same since, more tries)
  markAuthDown(d.state, { harness: 'fake', line: 'Failed to authenticate', run: 'RUN-9', now: due + 2000 });
  const e = readAuth(d.state).fake;
  assert.equal(e.since, new Date(t0).toISOString());
  assert.equal(e.tries, 2);
  assert.equal(e.ok_at, undefined);
  const due2 = Date.parse(e.next_probe);
  assert.equal(authRefusal(d.state, 'fake', { now: due2, probe: yes }), null);
  assert.equal(authRefusal(d.state, 'fake', { now: due2 + CANARY_MS, probe: yes }), null, 'the canary outlived its window: closed');
  assert.equal(readAuth(d.state).fake, undefined);
});

test('auth notice: one per episode, only after AUTH_NOTICE_MIN, across the projects of one state home; plain words', () => {
  const d = sandbox();
  const other = path.join(d.t, 'state', 'kestrel');
  fs.mkdirSync(other, { recursive: true });
  const t0 = Date.parse('2026-11-12T20:21:13Z');
  markAuthDown(d.state, { harness: 'claude', line: 'Failed to authenticate: OAuth session expired', run: 'RUN-1', now: t0 });
  assert.equal(authNoticeDue(d.state, { now: t0 + 9 * 60000 }), null, 'not before 10 min');
  const n = authNoticeDue(d.state, { now: t0 + AUTH_NOTICE_MIN * 60000 });
  assert.ok(n);
  assert.match(`${n.title} ${n.body}`, /claude auth login/);
  assert.match(n.body, /20:21Z/);
  assert.equal(authNoticeDue(d.state, { now: t0 + 20 * 60000 }), null, 'never a stream');
  assert.equal(authNoticeDue(other, { now: t0 + 20 * 60000 }), null, 'the other project of the same home: same episode, no second notice');
  // a new episode (the old one closed) may notify again
  markAuthDown(d.state, { harness: 'claude', line: 'x', run: 'RUN-2', now: t0 + 21 * 60000 });
  authRefusal(d.state, 'claude', { now: t0 + 30 * 60000, probe: () => true });
  authRefusal(d.state, 'claude', { now: t0 + 30 * 60000 + CANARY_MS });
  markAuthDown(d.state, { harness: 'claude', line: 'x', run: 'RUN-3', now: t0 + 60 * 60000 });
  assert.ok(authNoticeDue(other, { now: t0 + 71 * 60000 }));
});

// ---------- the run: auth exit -> held -> probe passes -> its own session resumed ----------
test('auth exit: outcome auth (not crash), gate marked, re-queued as a resume of its own session; held until the probe passes', async () => {
  const d = sandbox();
  const r = startRun(d.opts({ brief: d.brief('mode: crash\nsay: Failed to authenticate: OAuth session expired and could not be refreshed\nresumed_mode: done\n') }));
  const it = await d.ended(r.run);
  assert.equal(it.end.outcome, 'auth');
  assert.match(it.end.auth_line, /OAuth session expired/);
  assert.ok(readAuth(d.state).fake, 'the gate is marked down');
  const rq = await waitFor(() => d.runs().find(x => x.data.requeue_of === r.run));
  assert.equal(rq.state, 'queued', 'held: the end-of-run fill did not start it');
  const spec = JSON.parse(fs.readFileSync(queueSpecPath(d.state, rq.id), 'utf8'));
  assert.equal(spec.resumeSid, r.session_id, 'its own session');
  assert.equal(spec.auth_requeues, 1);
  // a NEW dispatch while down holds too (queued, not launched to die)
  const n = startRun(d.opts({ brief: d.brief('mode: done\n', 'n.md'), worktree: d.wt(2), lane: 'new', queue: true }));
  assert.equal(n.queued, true);
  assert.match(n.why, /^auth: /);
  const direct = startRun(d.opts({ brief: d.brief('mode: done\n', 'n2.md'), worktree: d.wt(3), lane: 'direct' }));
  assert.equal(direct.queued, true, 'a direct start holds as well');
  const later = Date.now() + probeBackoffMs(0) + 1000;
  assert.deepEqual(fillQueue(d.state, { now: later, authProbe: () => false }), [], 'probe fails: still held');
  const got = fillQueue(d.state, { now: later + probeBackoffMs(1) + 1000, authProbe: () => true });
  assert.deepEqual(got.map(x => x.queued), [rq.id], 'probe passes: the oldest (the killed run) is the one canary');
  const res = await d.ended(got[0].next);
  assert.equal(res.end.outcome, 'done');
  assert.equal(res.data.session_id, r.session_id);
  assert.match(fs.readFileSync(d.notes, 'utf8'), new RegExp(`resumed session ${r.session_id} prompt: .*authentication`));
  assert.equal(d.item(n.run).state, 'queued', 'the others wait for the canary window');
});

test('auth exit: a crash is still a crash; a check-in is not re-queued; the re-queue is bounded', async () => {
  const d = sandbox();
  const c = startRun(d.opts({ brief: d.brief('mode: crash\nsay: TypeError: boom\n') }));
  assert.equal((await d.ended(c.run)).end.outcome, 'crash');
  assert.equal(readAuth(d.state).fake, undefined);
  const say = 'say: Invalid API key · Please run /login\n';
  const ck = startRun(d.opts({ brief: d.brief(`mode: crash\n${say}`, 'ck.md'), kind: 'checkin', lock: false, lane: 'checkin', worktree: d.wt(2) }));
  assert.equal((await d.ended(ck.run)).end.outcome, 'auth');
  await sleep(300);
  assert.ok(!d.runs().some(x => x.data.requeue_of === ck.run), 'a check-in: the next tick runs one');
  fs.rmSync(authFile(d.state));
  const cap = startRun(d.opts({ brief: d.brief(`mode: crash\n${say}`, 'cap.md'), worktree: d.wt(3), lane: 'cap', auth_requeues: 3 }));
  assert.equal((await d.ended(cap.run)).end.outcome, 'auth');
  await sleep(300);
  assert.ok(!d.runs().some(x => x.data.requeue_of === cap.run), 'bounded: no fourth re-queue');
});

test('tick: while auth is down the check-in holds (no 96 ms launch) and the owner notice leaves once', () => {
  const d = sandbox();
  const root = d.wt('root');
  const project = { name: 'demo', root, state: d.state, ledger: path.join(d.t, 'progress.md'), briefs_dir: d.t, checkin: { cwd: root } };
  const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'status', 'BUDGET.json'), 'utf8').replace(/^﻿/, ''));
  const o = { project, machine: { claude: { exe: 'x', projects_dir: path.join(d.t, 'none') } }, budget: { ...fixture, max_claude_workers: 1, calib_time_utc: new Date().toISOString() },
    budgetFile: path.join(d.t, 'budget.json'), reason: 'test', dry: true, hbMs: 150, staleMs: 3000, fakeMs: 200 };
  markAuthDown(d.state, { harness: 'fake', line: 'Failed to authenticate', run: 'RUN-0', now: Date.now() - 11 * 60000 });
  const e = readAuth(d.state);
  e.fake.next_probe = new Date(Date.now() + 3600000).toISOString();
  fs.writeFileSync(authFile(d.state), JSON.stringify(e));
  const r1 = tick(o);
  assert.equal(r1.code, 0, r1.msg);
  assert.match(r1.msg, /auth: /);
  assert.ok(!d.runs().some(x => x.data.kind === 'checkin'), 'no check-in launched');
  assert.ok(r1.notice?.title, 'the notice is due');
  const r2 = tick(o);
  assert.equal(r2.notice, undefined, 'once');
});
