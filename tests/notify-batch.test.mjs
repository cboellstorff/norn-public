// NORN-WATCH notice policy (controller 11-09): owner asks / merges / kills + crashes go out at once; rulings and other FYI
// (--class fyi, each naming its record id) are batched into ONE digest notice per window (project policy notify.batch_h,
// default 3 h). No --class = immediate, as before (additive). Transport injected: offline, temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { notify, flushNotices, NotifyError, batchHours } from '../engine/lib/notify.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const tmp = () => mkTmp('meta-nb-');
const log = s => fs.readFileSync(path.join(s, 'notify.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const machine = { notify: { backend: 'ntfy', topic: 'secret-topic' } };
function fake() { const calls = []; return { calls, post: async (url, o) => { calls.push(JSON.parse(o.body)); return { status: 200, text: 'ok' }; } }; }
const at = h => () => new Date(Date.UTC(2026, 10, 9, 0, 0) + h * 3600e3);

test('fyi is batched (recorded, not sent); the window closes on the next notice -> one digest naming every record id', async () => {
  const s = tmp(), t = fake();
  const base = { machine, state: s, transport: t };
  await notify({ ...base, title: 'DEC-700 trees', body: 'ruled a', cls: 'fyi', now: at(0) });
  await notify({ ...base, title: 'kestrel ruling', body: 'DEC-701: ruled b', cls: 'fyi', now: at(1) });
  assert.equal(t.calls.length, 0, 'nothing sent inside the window');
  await notify({ ...base, title: 'Q-90 art pick', body: 'a or b?', cls: 'ask', now: at(2) });
  assert.equal(t.calls.length, 1, 'an ask goes out at once; the window (3 h) is still open');
  await notify({ ...base, title: 'DEC-702 x', body: 'ruled c', cls: 'fyi', now: at(3.1) });
  assert.equal(t.calls.length, 2, 'the window closed: one digest');
  const d = t.calls[1];
  assert.match(d.title, /3 FYI/);
  for (const id of ['DEC-700', 'DEC-701', 'DEC-702']) assert.match(d.message, new RegExp(id));
  assert.equal(d.message.trim().split('\n').length, 3, 'one line per notice');
  assert.equal(fs.readFileSync(path.join(s, 'notify-batch.jsonl'), 'utf8'), '', 'batch emptied');
  const l = log(s);
  assert.equal(l.filter(x => x.sent).length, 2);
  assert.deepEqual(l.map(x => x.class ?? null), ['fyi', 'fyi', 'ask', 'fyi', 'digest']);
  assert.ok(!JSON.stringify(l).includes('secret-topic'));
});

test('fyi must name a record id; class values checked; alert defaults to high, no class = immediate as before', async () => {
  const s = tmp(), t = fake(), base = { machine, state: s, transport: t, now: at(0) };
  await assert.rejects(notify({ ...base, title: 'trees ruled', body: 'no id', cls: 'fyi' }), e => e instanceof NotifyError && e.code === 2);
  await assert.rejects(notify({ ...base, title: 'x', body: 'y', cls: 'loud' }), e => e instanceof NotifyError && e.code === 2);
  await notify({ ...base, title: 'RUN-5 crashed', body: 'exit 3', cls: 'alert' });
  await notify({ ...base, title: 'plain', body: 'b' });
  assert.deepEqual(t.calls.map(c => c.priority), [4, 3]);
  assert.equal(t.calls.length, 2);
});

test('flushNotices: force sends a pending batch at once; empty batch sends nothing; batch_h from project policy', async () => {
  const s = tmp(), t = fake();
  await notify({ machine, state: s, transport: t, title: 'DEC-1 a', body: 'b', cls: 'fyi', now: at(0) });
  assert.equal((await flushNotices({ machine, state: s, transport: t, now: at(0.5) })).sent, false, 'window open, not forced');
  assert.equal((await flushNotices({ machine, state: s, transport: t, now: at(0.5), force: true })).sent, true);
  assert.equal(t.calls.length, 1);
  assert.equal((await flushNotices({ machine, state: s, transport: t, now: at(9), force: true })).sent, false, 'empty');
  assert.equal(batchHours({ policy: { notify: { batch_h: 1.5 } } }), 1.5);
  assert.equal(batchHours({}), 3);
  assert.throws(() => batchHours({ name: 'p', policy: { notify: { batch_h: 0 } } }), /batch_h/);
});

test('CLI: --class fyi is batched, --flush sends it; backend none still records', () => {
  const s = tmp();
  const env = { ...process.env }; for (const k of ['META_STATE', 'META_PROJECT']) delete env[k];
  const mf = path.join(s, 'machine.json'), root = s.replace(/\\/g, '/');
  fs.writeFileSync(mf, JSON.stringify({ schema: 1, home: root, claude: { exe: 'c', config_dir: root, projects_dir: root }, node: 'n',
    scheduler: { kind: 'cron', name: 'x', interval_min: 15 }, dash: { port: 0, bind: '127.0.0.1' }, projects: [] }));
  const run = (...a) => spawnSync(process.execPath, [META, 'notify', '--state', s, '--machine', mf, ...a], { env: { ...env, META_ROOT: root }, encoding: 'utf8' });
  const a = run('--title', 'DEC-9 x', '--body', 'b', '--class', 'fyi');
  assert.equal(a.status, 0, a.stderr); assert.match(a.stdout, /batched/);
  const f = run('--flush');
  assert.equal(f.status, 0, f.stderr); assert.match(f.stdout, /1 FYI/);
  assert.deepEqual(log(s).map(x => x.class), ['fyi', 'digest']);
  assert.equal(run('--title', 'x', '--body', 'y', '--class', 'nope').status, 2);
});
