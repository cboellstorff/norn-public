// META-AUTH-VENDOR R1: a vendor outage is not "your login expired". 2026-11-13 09:47-10:19Z: 10 runs ended `auth` on
// "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare" (an edge block during Anthropic's own incident) and the
// owner was told to log in again ~5 times for nothing. Now an auth exit has a class (login | vendor, executors data rows); both hold
// and resume as before; the notice / dashboard row / doctor name the vendor incident (its status page, a fake endpoint here) and say
// no login is needed. auth_line / limit_line keep the matched text with a little context. Temp dirs + a local fake endpoint only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRun, classifyLimit } from '../engine/lib/runs.mjs';
import { authPatterns, limitPatterns, AUTH_PATTERNS } from '../engine/lib/executors.mjs';
import { classifyAuth, markAuthDown, authNoticeDue, readAuth, loginHolds, authDoctorLines } from '../engine/lib/authguard.mjs';
import { fetchStatusJson, openIncident, vendorIncident, statusSource } from '../engine/lib/vendorstatus.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { tick } from '../engine/lib/tick.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = n => fs.readFileSync(path.join(HERE, 'fixtures', 'auth', n), 'utf8');
const VENDOR = fixture('vendor-403-checkin-20261113-094900.json');   // the real final of 11-13 09:49Z (ids scrubbed)
const LOGIN = fixture('login-oauth-checkin-20261112-202440.json');   // the real final of 11-12 20:24Z (ids scrubbed)
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const t0 = performance.now();
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); }
}
function sandbox() {
  const t = mkTmp('meta-authv-');
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
// a fake Statuspage endpoint in its own process (the sync probe blocks this one): GET -> body, every request's headers logged
function fakeStatus(t, { body, hang = false } = {}) {
  const log = path.join(t, 'hits.jsonl'), port = path.join(t, 'port');
  const src = `const http=require('http'),fs=require('fs');const s=http.createServer((q,r)=>{fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(q.headers)+'\\n');`
    + `${hang ? '' : `r.writeHead(200,{'content-type':'application/json'});r.end(${JSON.stringify(JSON.stringify(body ?? {}))});`}});`
    + `s.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(port)},String(s.address().port)));`;
  const p = spawn(process.execPath, ['-e', src], { stdio: 'ignore' });
  return waitFor(() => fs.existsSync(port) && fs.readFileSync(port, 'utf8')).then(n => ({
    url: `http://127.0.0.1:${n}/api/v2/incidents/unresolved.json`,
    hits: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
    stop: () => p.kill(),
  }));
}
const INCIDENT_PAGE = { page: { name: 'Claude' }, incidents: [
  { name: 'Elevated errors on claude.ai, Claude Code, and platform.claude.com', status: 'investigating', created_at: '2026-11-13T09:58:58.057Z',
    started_at: '2026-11-13T09:58:58.049Z', resolved_at: null, impact: 'major' }] };

// ---------- the two classes: data rows per harness, the real lines as fixtures ----------
test('auth classes: the 11-13 edge 403 is vendor, the 11-12 OAuth expiry is login; 5xx / overloaded are vendor; rows are data', () => {
  const claude = authPatterns('claude');
  assert.ok(Array.isArray(claude.vendor) && claude.vendor.length, 'claude has a vendor row');
  assert.equal(classifyAuth(VENDOR, claude).cls, 'vendor');
  assert.equal(classifyAuth(LOGIN, claude).cls, 'login');
  assert.equal(classifyAuth(VENDOR, authPatterns('fake')).cls, 'vendor', 'the fake stands in for claude');
  for (const s of ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
    '"api_error_status":503,"result":"API Error: 503 Service Unavailable"', 'Failed to authenticate. API Error: 502 Bad Gateway', 'Failed to authenticate'])
    assert.equal(classifyAuth(s, claude)?.cls, 'vendor', s);
  for (const s of ['Invalid API key · Please run /login', 'OAuth token revoked · Please run /login', 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'])
    assert.equal(classifyAuth(s, claude)?.cls, 'login', s);
  for (const s of ['TypeError: boom', 'Claude AI usage limit reached|1762970000', 'the server returned 500 rows'])
    assert.equal(classifyAuth(s, claude), null, s);
  // codex: GUESS vendor rows (no codex edge block seen yet); its login rows stay login
  const codex = authPatterns('codex-sol');
  assert.ok(codex.vendor?.length);
  assert.equal(classifyAuth('stream error: unexpected status 503 Service Unavailable', codex)?.cls, 'vendor');
  assert.equal(classifyAuth('ERROR: Your access token could not be refreshed. Please log out and sign in again.', codex)?.cls, 'login');
  // a project row with only `match` (the old shape) is login
  assert.equal(classifyAuth('custom gone', { match: ['custom gone'] }).cls, 'login');
  // status sources are data: claude = Anthropic's Statuspage, codex = OpenAI's (checked 11-13); the fake never has one
  assert.match(statusSource('claude').url, /^https:\/\/status\.claude\.com\/api\/v2\//);
  assert.equal(statusSource('claude').vendor, 'Anthropic');
  assert.match(statusSource('codex').url, /^https:\/\/status\.openai\.com\/api\/v2\//);
  assert.equal(statusSource('fake'), null, 'tests never reach a real endpoint');
  assert.equal(AUTH_PATTERNS.fake.status, undefined);
});

// ---------- the vendor status: a fake endpoint, short timeout, cached, no credentials ----------
test('vendor status: the open incident from a fake Statuspage endpoint; resolved ones skipped; no credentials; cached; a hang times out', async () => {
  const d = sandbox();
  const page = { incidents: [{ name: 'Old', status: 'resolved', started_at: '2026-11-12T08:52:35Z', resolved_at: '2026-11-12T09:25:12Z' }, ...INCIDENT_PAGE.incidents] };
  const srv = await fakeStatus(d.t, { body: page });
  try {
    const j = fetchStatusJson(srv.url, { timeoutMs: 5000 });
    assert.deepEqual(openIncident(j), { name: 'Elevated errors on claude.ai, Claude Code, and platform.claude.com', since: '2026-11-13T09:58:58.049Z' });
    assert.equal(openIncident({ incidents: [page.incidents[0]] }), null);
    assert.equal(openIncident(null), null);
    const h = srv.hits()[0];
    for (const k of ['authorization', 'cookie', 'x-api-key', 'anthropic-api-key']) assert.equal(h[k], undefined, k);
    const src = { vendor: 'Anthropic', url: srv.url };
    const now = Date.parse('2026-11-13T10:10:00Z');
    const i1 = vendorIncident(d.state, 'claude', { now, source: src });
    assert.equal(i1.name, page.incidents[1].name);
    const n = srv.hits().length;
    assert.deepEqual(vendorIncident(d.state, 'claude', { now: now + 60000, source: src }), i1, 'cached');
    assert.equal(srv.hits().length, n, 'no second fetch within the cache window');
    assert.deepEqual(vendorIncident(d.state, 'claude', { now: now + 3600000, cacheOnly: true, source: src }), i1, 'cacheOnly: the last answer, never a fetch');
    assert.equal(srv.hits().length, n);
  } finally { srv.stop(); }
  const hang = await fakeStatus(mkTmp('meta-authv-hang-'), { hang: true });
  try {
    const t0 = performance.now();
    assert.equal(fetchStatusJson(hang.url, { timeoutMs: 1500 }), null);
    assert.ok(performance.now() - t0 < 8000, 'short timeout');
  } finally { hang.stop(); }
});

// ---------- the notice per class, one per episode ----------
test('auth notice: vendor class names the incident and says no login; login class is today\'s text; one notice per episode', () => {
  const d = sandbox();
  const t0 = Date.parse('2026-11-13T09:49:29Z');
  markAuthDown(d.state, { harness: 'claude', cls: 'vendor', line: 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare', run: 'RUN-1', now: t0 });
  assert.equal(readAuth(d.state).claude.cls, 'vendor');
  const inc = { name: 'Elevated errors on claude.ai, Claude Code, and platform.claude.com', since: '2026-11-13T09:58:58.049Z' };
  const n = authNoticeDue(d.state, { now: t0 + 11 * 60000, incident: () => inc, held: () => 3 });
  assert.ok(n);
  assert.equal(n.body.split('. Norn')[0], `Anthropic reports an incident: ${inc.name} (since 09:58Z)`);
  assert.match(n.body, /Norn holds 3 runs and resumes them when it clears\. You do NOT need to log in\./);
  assert.doesNotMatch(`${n.title} ${n.body}`, /login has expired|run claude auth login/);
  assert.equal(authNoticeDue(d.state, { now: t0 + 30 * 60000, incident: () => inc, held: () => 3 }), null, 'one per episode');
  // no incident on the status page (yet / unreachable): still a vendor notice, never "log in"
  const e = sandbox();
  markAuthDown(e.state, { harness: 'claude', cls: 'vendor', line: 'API Error: 529 Overloaded', run: 'RUN-1', now: t0 });
  const m = authNoticeDue(e.state, { now: t0 + 11 * 60000, incident: () => null, held: () => 1 });
  assert.match(m.body, /You do NOT need to log in\./);
  assert.match(m.body, /Norn holds 1 run and/);
  assert.match(m.body, /09:49Z/);
  // login class: today's text
  const f = sandbox();
  markAuthDown(f.state, { harness: 'claude', line: 'Failed to authenticate: OAuth session expired', run: 'RUN-1', now: t0 });
  const l = authNoticeDue(f.state, { now: t0 + 11 * 60000, incident: () => { throw new Error('a login episode never asks the status page'); } });
  assert.match(l.title, /the claude login has expired - run claude auth login/);
});

test('dashboard row + doctor: a vendor hold says the incident and no login; a login hold names the command', () => {
  const d = sandbox();
  markAuthDown(d.state, { harness: 'fake', cls: 'vendor', line: 'Attention Required! | Cloudflare', run: 'RUN-1', now: Date.parse('2026-11-13T09:49:29Z') });
  const runs = [{ id: 'RUN-2', kind: 'run', state: 'queued', data: { executor: 'fake' } }];
  const [h] = loginHolds(d.state, runs, { incident: () => ({ name: 'Elevated errors', since: '2026-11-13T09:58:58Z' }) });
  assert.equal(h.cls, 'vendor');
  assert.match(h.title, /Elevated errors/);
  assert.match(h.title, /no login needed|do NOT need to log in/i);
  assert.doesNotMatch(h.title, /Log in/);
  const dl = authDoctorLines(d.state, { incident: () => null });
  assert.equal(dl.length, 1);
  assert.equal(dl[0].level, 'note');
  assert.match(dl[0].text, /You do NOT need to log in/);
  const e = sandbox();
  markAuthDown(e.state, { harness: 'fake', line: 'OAuth session expired', run: 'RUN-1' });
  const [g] = loginHolds(e.state, runs);
  assert.equal(g.cls, 'login');
  assert.match(g.title, /^Log in to fake again: run claude auth login/);
  const el = authDoctorLines(e.state);
  assert.equal(el[0].level, 'bad');
  assert.match(el[0].text, /claude auth login/);
  assert.deepEqual(authDoctorLines(sandbox().state), [], 'no episode: nothing to say');
});

// ---------- the run: a vendor exit holds and resumes as a login exit does ----------
test('auth exit, vendor class: outcome auth with auth_class vendor, gate marked vendor, re-queued and held', async () => {
  const d = sandbox();
  const r = startRun(d.opts({ brief: d.brief('mode: crash\nsay: Failed to authenticate. API Error: 403 Attention Required! | Cloudflare\nresumed_mode: done\n') }));
  const it = await d.ended(r.run);
  assert.equal(it.end.outcome, 'auth');
  assert.equal(it.end.auth_class, 'vendor');
  assert.match(it.end.auth_line, /Attention Required/);
  assert.equal(readAuth(d.state).fake.cls, 'vendor');
  const rq = await waitFor(() => d.runs().find(x => x.data.requeue_of === r.run));
  assert.equal(rq.state, 'queued', 'held like a login exit');
});

test('tick: a vendor episode holds the check-in and sends the vendor notice once, counting the held runs (no real endpoint)', () => {
  const d = sandbox();
  const root = d.wt('root');
  const project = { name: 'demo', root, state: d.state, ledger: path.join(d.t, 'progress.md'), briefs_dir: d.t, checkin: { cwd: root } };
  const fixtureB = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'status', 'BUDGET.json'), 'utf8').replace(/^﻿/, ''));
  const o = { project, machine: { claude: { exe: 'x', projects_dir: path.join(d.t, 'none') } }, budget: { ...fixtureB, max_claude_workers: 1, calib_time_utc: new Date().toISOString() },
    budgetFile: path.join(d.t, 'budget.json'), reason: 'test', dry: true, hbMs: 150, staleMs: 3000, fakeMs: 200 };
  markAuthDown(d.state, { harness: 'fake', cls: 'vendor', line: 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare', run: 'RUN-0', now: Date.now() - 11 * 60000 });
  const e = readAuth(d.state);
  e.fake.next_probe = new Date(Date.now() + 3600000).toISOString();
  fs.writeFileSync(path.join(d.t, 'state', 'auth-down.json'), JSON.stringify(e));
  const q = startRun(d.opts({ brief: d.brief('mode: done\n', 'q.md'), lane: 'q', queue: true }));
  assert.equal(q.queued, true);
  assert.match(q.why, /^auth: fake vendor outage since/);
  const r1 = tick(o);
  assert.equal(r1.code, 0, r1.msg);
  assert.equal(r1.notice?.cls, 'vendor');
  assert.match(r1.notice.body, /Norn holds 1 run and resumes them when it clears\. You do NOT need to log in\./);
  assert.doesNotMatch(`${r1.notice.title} ${r1.notice.body}`, /auth login/);
  assert.equal(tick(o).notice, undefined, 'once');
});
