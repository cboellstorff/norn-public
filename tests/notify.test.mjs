// H4 `norn notify` (HARNESS-DESIGN sec. 6): backends are data in machine.json `notify` (ntfy | pushover | toast | none); default none
// when the key is absent (DIR-8 outbound-only, opt-in). Every send = one line in <state>/notify.jsonl, no secrets. The transport is
// injected: no test touches the network or shows a toast (the CLI ntfy test posts to a loopback server).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { notify, NotifyError } from '../engine/lib/notify.mjs';
import { validate, MACHINE_SCHEMA } from '../engine/lib/config.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const tmp = () => mkTmp('meta-notify-');
const log = s => fs.readFileSync(path.join(s, 'notify.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
function fake(status = 200) {
  const calls = [];
  return { calls, post: async (url, o) => { calls.push({ url, ...o }); return { status, text: 'ok' }; }, run: (cmd, args, o) => { calls.push({ cmd, args, env: o.env }); return { status: 0 }; } };
}

test('no notify key (or backend none) = nothing sent, the send is still recorded', async () => {
  const s = tmp(), t = fake();
  const r = await notify({ title: 'T', body: 'B', machine: { home: '/h' }, state: s, transport: t });
  assert.equal(r.backend, 'none'); assert.equal(r.sent, false); assert.equal(t.calls.length, 0);
  await notify({ title: 'T2', body: 'B2', machine: { notify: { backend: 'none' } }, state: s, transport: t });
  const l = log(s);
  assert.equal(l.length, 2);
  assert.deepEqual({ ...l[0], ts: 'x' }, { ts: 'x', backend: 'none', title: 'T', body: 'B', priority: 'default', sent: false, ok: true });
});

test('ntfy: JSON publish to the server root with topic / title / message / priority; topic never recorded', async () => {
  const s = tmp(), t = fake(), topic = 'kestrel-x7Qk2pW9vR4mZ8tL';
  const r = await notify({ title: 'Clear ready', body: 'controller at 110k', priority: 'high', machine: { notify: { backend: 'ntfy', topic } }, state: s, transport: t });
  assert.equal(r.sent, true); assert.equal(r.ok, true);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].url, 'https://ntfy.sh/');
  assert.equal(t.calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(t.calls[0].body), { topic, title: 'Clear ready', message: 'controller at 110k', priority: 4 });
  const raw = fs.readFileSync(path.join(s, 'notify.jsonl'), 'utf8');
  assert.ok(!raw.includes(topic), 'the topic is the access secret of an ntfy channel: never recorded');
  assert.equal(log(s)[0].status, 200);
});

test('ntfy: own server (https, or http on loopback only); a non-2xx answer = ok false, recorded, NotifyError code 1', async () => {
  const s = tmp();
  const t1 = fake();
  await notify({ title: 'a', body: 'b', machine: { notify: { backend: 'ntfy', topic: 'tp', server: 'https://ntfy.example.org/' } }, state: s, transport: t1 });
  assert.equal(t1.calls[0].url, 'https://ntfy.example.org/');
  await assert.rejects(notify({ title: 'a', body: 'b', machine: { notify: { backend: 'ntfy', topic: 'tp', server: 'http://ntfy.example.org' } }, state: s, transport: fake() }),
    e => e instanceof NotifyError && e.code === 2 && /https/.test(e.message));
  await assert.rejects(notify({ title: 'a', body: 'b', machine: { notify: { backend: 'ntfy', topic: 'tp' } }, state: s, transport: fake(500) }),
    e => e instanceof NotifyError && e.code === 1 && /500/.test(e.message));
  const last = log(s).at(-1);
  assert.equal(last.ok, false); assert.equal(last.status, 500); assert.equal(last.sent, false);
});

test('pushover: token + user from the named env vars (never stored or recorded); missing env = NotifyError code 2', async () => {
  const s = tmp(), t = fake();
  const env = { PUSHOVER_TOKEN: 'tok-SECRET-123', PUSHOVER_USER: 'usr-SECRET-456' };
  await notify({ title: 'T', body: 'B', priority: 'urgent', machine: { notify: { backend: 'pushover' } }, state: s, env, transport: t });
  assert.equal(t.calls[0].url, 'https://api.pushover.net/1/messages.json');
  assert.equal(t.calls[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
  const f = Object.fromEntries(new URLSearchParams(t.calls[0].body));
  assert.deepEqual(f, { token: 'tok-SECRET-123', user: 'usr-SECRET-456', title: 'T', message: 'B', priority: '1' });
  const raw = fs.readFileSync(path.join(s, 'notify.jsonl'), 'utf8');
  assert.ok(!raw.includes('SECRET'), 'no secret in the record');
  const t2 = fake();
  await notify({ title: 'T', body: 'B', machine: { notify: { backend: 'pushover', token_env: 'MY_TOK', user_env: 'MY_USR' } }, state: s, env: { MY_TOK: 'a', MY_USR: 'b' }, transport: t2 });
  assert.equal(new URLSearchParams(t2.calls[0].body).get('token'), 'a');
  await assert.rejects(notify({ title: 'T', body: 'B', machine: { notify: { backend: 'pushover' } }, state: s, env: {}, transport: fake() }),
    e => e instanceof NotifyError && e.code === 2 && /PUSHOVER_TOKEN/.test(e.message));
});

test('toast: Windows only, powershell with title / body passed through env (no quoting into the script)', async () => {
  const s = tmp(), t = fake();
  await notify({ title: "it's \"quoted\"", body: '$(rm -rf)', machine: { notify: { backend: 'toast' } }, state: s, transport: t, platform: 'win32' });
  assert.equal(t.calls[0].cmd, 'powershell.exe');
  const script = t.calls[0].args.at(-1);
  assert.ok(!script.includes('quoted') && !script.includes('rm -rf'), 'text is never spliced into the script');
  assert.equal(t.calls[0].env.META_NOTIFY_TITLE, "it's \"quoted\""); assert.equal(t.calls[0].env.META_NOTIFY_BODY, '$(rm -rf)');
  await assert.rejects(notify({ title: 'a', body: 'b', machine: { notify: { backend: 'toast' } }, state: s, transport: fake(), platform: 'linux' }),
    e => e instanceof NotifyError && e.code === 2 && /Windows/.test(e.message));
});

test('bad priority / empty title = NotifyError code 2, nothing sent or recorded', async () => {
  const s = tmp(), t = fake();
  await assert.rejects(notify({ title: 'a', body: 'b', priority: 'max', machine: { notify: { backend: 'ntfy', topic: 'x' } }, state: s, transport: t }), e => e.code === 2);
  await assert.rejects(notify({ title: '', body: 'b', machine: {}, state: s, transport: t }), e => e.code === 2);
  assert.equal(t.calls.length, 0); assert.ok(!fs.existsSync(path.join(s, 'notify.jsonl')));
});

function cli(args, env) {
  return new Promise(res => {
    const e = { ...process.env, ...env };
    for (const k of ['META_STATE', 'META_PROJECT', 'META_ROLE', 'META_RUN_ID', 'META_NOTES']) if (!(k in env)) delete e[k];
    const p = spawn(process.execPath, [META, 'notify', ...args], { env: e });
    let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
    p.on('exit', code => res({ code, out }));
  });
}

test('CLI: norn notify --title --body [--priority] --state D; none by default; ntfy to a loopback server; usage = exit 2', async () => {
  const root = tmp(), s = path.join(root, 'state');
  fs.mkdirSync(path.join(root, 'local'), { recursive: true });
  let r = await cli(['--title', 'T', '--body', 'B', '--state', s], { META_ROOT: root });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /backend none/);
  assert.equal(log(s)[0].backend, 'none');
  const got = [];
  const srv = http.createServer((q, w) => { let b = ''; q.on('data', d => { b += d; }); q.on('end', () => { got.push({ url: q.url, body: b }); w.end('{}'); }); });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  const mf = path.join(root, 'machine-notify.json');
  fs.writeFileSync(mf, JSON.stringify({ schema: 1, home: root, claude: { exe: 'c', config_dir: root, projects_dir: root }, node: 'n', scheduler: { kind: 'cron', name: 'x', interval_min: 15 },
    dash: { port: 0, bind: '127.0.0.1' }, projects: [], notify: { backend: 'ntfy', topic: 'tp', server: `http://127.0.0.1:${srv.address().port}` } }));
  r = await cli(['--title', 'T', '--body', 'B', '--priority', 'low', '--state', s, '--machine', mf], { META_ROOT: root });
  srv.close();
  assert.equal(r.code, 0, r.out); assert.match(r.out, /sent via ntfy/);
  assert.deepEqual(JSON.parse(got[0].body), { topic: 'tp', title: 'T', message: 'B', priority: 2 });
  assert.equal((await cli(['--title', 'T'], { META_ROOT: root, META_STATE: s })).code, 2, '--body is required');
  assert.equal((await cli(['--title', 'T', '--body', 'B', '--bogus', 'x', '--state', s], { META_ROOT: root })).code, 2);
  assert.equal((await cli(['--title', 'T', '--body', 'B'], { META_ROOT: root })).code, 2, 'no state = usage (every send is recorded)');
});

// NORN-WATCH S5 (DIR-86 Q1): `--file <png>` = an attachment (owner shots from headless merge workers); the topic is never recorded
test('S5 --file: ntfy PUT of the file bytes to <server>/<topic> with title / message / priority / filename as query; toast names the path', async () => {
  const s = tmp(), topic = 'kestrel-x7Qk2pW9vR4mZ8tL', png = path.join(s, 'shot 1.png');
  fs.writeFileSync(png, Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  const calls = [];
  const t = { post: async () => { throw new Error('a file goes by PUT'); }, put: async (url, o) => { calls.push({ url, ...o }); return { status: 200, text: 'ok' }; } };
  const r = await notify({ title: 'Merged DLV-19', body: 'revert: git revert -m 1 abc', priority: 'high', cls: 'merge', file: png, machine: { notify: { backend: 'ntfy', topic } }, state: s, transport: t });
  assert.equal(r.sent, true);
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, `https://ntfy.sh/${topic}`);
  assert.equal(u.searchParams.get('title'), 'Merged DLV-19');
  assert.equal(u.searchParams.get('message'), 'revert: git revert -m 1 abc');
  assert.equal(u.searchParams.get('priority'), '4');
  assert.equal(u.searchParams.get('filename'), 'shot 1.png');
  assert.deepEqual([...calls[0].body], [137, 80, 78, 71, 1, 2, 3]);
  const l = log(s).at(-1);
  assert.equal(l.file, png.replace(/\\/g, '/'));
  assert.ok(!fs.readFileSync(path.join(s, 'notify.jsonl'), 'utf8').includes(topic));
  const t2 = { run: (cmd, args, o) => { calls.push({ env: o.env }); return { status: 0 }; } };
  await notify({ title: 'T', body: 'B', file: png, machine: { notify: { backend: 'toast' } }, state: s, transport: t2, platform: 'win32' });
  assert.match(calls.at(-1).env.META_NOTIFY_BODY, /shot 1\.png/);
});

test('S5 --file: a missing file = NotifyError code 2, nothing sent; an fyi notice cannot carry a file', async () => {
  const s = tmp(), t = fake();
  await assert.rejects(notify({ title: 'T', body: 'B', file: path.join(s, 'nope.png'), machine: { notify: { backend: 'ntfy', topic: 'x' } }, state: s, transport: t }),
    e => e instanceof NotifyError && e.code === 2 && /nope\.png/.test(e.message));
  await assert.rejects(notify({ title: 'DEC-1', body: 'B', cls: 'fyi', file: __filename_png(s), machine: {}, state: s, transport: t }),
    e => e instanceof NotifyError && e.code === 2 && /fyi/.test(e.message));
  assert.equal(t.calls.length, 0);
});
function __filename_png(s) { const f = path.join(s, 'a.png'); fs.writeFileSync(f, 'x'); return f; }
