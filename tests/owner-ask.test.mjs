// NORN-WATCH S3: owner asks are Q records - `owner_only` questions (a check-in never rules one), `norn rec answer --each` maps one
// chat reply to named Q answers (one answer event per Q, `mapped_from` = the shared owner text) and echoes them. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, loadState, readEvents, recordsFile, RecordError } from '../engine/lib/records.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const tmp = () => mkTmp('meta-ask-');
const env = () => { const e = { ...process.env, META_NO_TICK: '1' }; for (const k of ['META_STATE', 'META_PROJECT', 'META_ROLE', 'META_RUN_ID']) delete e[k]; return e; };
const cli = (...a) => spawnSync(process.execPath, [META, ...a], { env: env(), encoding: 'utf8' });
const q = (title, extra = {}) => ({ kind: 'question', ev: 'create', by: 'controller', data: { title, lane: 'gen', options: [{ key: 'a', text: `${title} A`, cost: '' }, { key: 'b', text: `${title} B`, cost: '' }], ...extra } });
const dec = answers => ({ kind: 'decision', ev: 'create', data: { lane: 'gen', question: 'q', choice: 'a', why: 'w', answers } });

test('owner_only is stored on the question; a non-boolean is invalid', () => {
  const s = tmp();
  record(s, q('Art pick', { owner_only: true }), { views: false });
  assert.equal(loadState(s).items['Q-1'].data.owner_only, true);
  assert.throws(() => record(s, q('Bad', { owner_only: 'yes' }), { views: false }), e => e instanceof RecordError && e.code === 2 && /owner_only/.test(e.message));
});

test('a check-in never rules an owner_only Q: decision --answers refused for checkin, allowed for the controller; other Qs unchanged', () => {
  const s = tmp();
  record(s, q('Art pick', { owner_only: true }), { views: false });
  record(s, q('Plain'), { views: false });
  assert.throws(() => record(s, { ...dec('Q-1'), by: 'checkin' }, { views: false }), e => e instanceof RecordError && e.code === 2 && /owner_only/.test(e.message));
  assert.equal(record(s, { ...dec('Q-2'), by: 'checkin' }, { views: false }).id, 'DEC-1');
  assert.equal(record(s, { ...dec('Q-1'), by: 'controller' }, { views: false }).id, 'DEC-2');
});

test('CLI: --owner-only stored; checkin --answers on it exits 2, controller exits 0', () => {
  const s = tmp();
  const add = cli('rec', 'add', 'question', '--state', s, '--as', 'checkin', '--lane', 'gen', '--title', 'Art pick', '--option', 'a|Well-knot|', '--option', 'b|Braid|', '--owner-only');
  assert.equal(add.status, 0, add.stderr); assert.equal(add.stdout.trim(), 'Q-1');
  assert.equal(loadState(s).items['Q-1'].data.owner_only, true);
  const plain = cli('rec', 'add', 'question', '--state', s, '--as', 'checkin', '--lane', 'gen', '--title', 'Plain', '--option', 'a|A|');
  assert.equal(plain.status, 0, plain.stderr); assert.equal(loadState(s).items['Q-2'].data.owner_only, undefined);
  const args = ['rec', 'add', 'decision', '--state', s, '--lane', 'gen', '--question', 'q', '--choice', 'a', '--why', 'w', '--answers', 'Q-1'];
  const ck = cli(...args, '--as', 'checkin');
  assert.equal(ck.status, 2); assert.match(ck.stderr, /owner_only/);
  assert.equal(cli(...args, '--as', 'controller').status, 0);
});

test('CLI: answer --each writes one answer per Q with mapped_from and echoes every title + option; a bad pair writes nothing', () => {
  const s = tmp();
  record(s, q('Art pick', { owner_only: true }), { views: false });
  record(s, q('Repo rename'), { views: false });
  record(s, q('Third'), { views: false });
  const bad = cli('rec', 'answer', '--state', s, '--as', 'owner', '--each', 'Q-1=a,Q-3=z', '--text', 'agree', '--via', 'chat');
  assert.equal(bad.status, 2); assert.match(bad.stderr, /Q-3/);
  assert.equal(readEvents(recordsFile(s)).filter(e => e.ev === 'answer').length, 0, 'all-or-nothing');
  const ok = cli('rec', 'answer', '--state', s, '--as', 'owner', '--each', 'Q-1=a, Q-2=b', '--text', 'agree with both', '--via', 'chat');
  assert.equal(ok.status, 0, ok.stderr);
  const evs = readEvents(recordsFile(s)).filter(e => e.ev === 'answer');
  assert.deepEqual(evs.map(e => [e.id, e.data.choice, e.data.text, e.data.mapped_from]), [['Q-1', 'a', 'agree with both', 'agree with both'], ['Q-2', 'b', 'agree with both', 'agree with both']]);
  assert.match(ok.stdout, /^Recorded: Q-1 Art pick = a \(Art pick A\); Q-2 Repo rename = b \(Repo rename B\)\. Say 'no' to undo\./);
  assert.equal(loadState(s).items['Q-3'].state, 'open');
  const both = cli('rec', 'answer', 'Q-3', '--state', s, '--as', 'owner', '--each', 'Q-3=a', '--text', 'x', '--via', 'chat');
  assert.equal(both.status, 2, 'an ID and --each are exclusive');
  const nokey = cli('rec', 'answer', '--state', s, '--as', 'owner', '--each', 'Q-3', '--text', 'x', '--via', 'chat');
  assert.equal(nokey.status, 2, '--each needs Q-n=key pairs');
});

test('MCP: norn_question_add takes owner_only', async () => {
  const s = tmp();
  const p = spawn(process.execPath, [META, 'mcp', '--state', s, '--profile', 'checkin'], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const got = new Promise(res => p.stdout.on('data', d => { buf += d; if (buf.includes('"id":2')) res(); }));
  const send = m => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: 'norn_question_add', arguments: { lane: 'gen', title: 'Art pick', owner_only: true, options: [{ key: 'a', text: 'A' }] } } });
  await got; p.stdin.end(); await new Promise(r => p.on('exit', r));
  assert.equal(loadState(s).items['Q-1'].data.owner_only, true, buf);
});
