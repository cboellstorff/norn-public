// META-Q-RECONCILE R1 (owner 11-13): an owner answer given anywhere closes the question. Synthetic fixture shaped on the live
// Q-58 / DEC-873 miss (lane night: the controller took "Agreed, C" in chat and wrote a decision, never an answer). Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, loadState, readEvents, recordsFile, RecordError } from '../engine/lib/records.mjs';
import { possibleAnswers } from '../engine/lib/qreconcile.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { renderDigest } from '../engine/lib/views.mjs';
import { handle } from '../engine/lib/mcp.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
let tick = 0;
const now = () => new Date(Date.UTC(2026, 10, 13, 2, 0, tick++));
const rec = (dir, e) => record(dir, e, { now, views: false });
const env = () => {
  const e = { ...process.env, META_NO_TICK: '1' };
  for (const k of Object.keys(e)) if (k.startsWith('META_') && k !== 'META_NO_TICK') delete e[k];
  return e;
};
const cli = (state, ...args) => spawnSync(process.execPath, [META, 'rec', ...args, '--state', state], { env: env(), encoding: 'utf8' });

const Q58 = { title: 'Night default: Classic (black), Physical, or Physical + Night vision?', lane: 'night',
  body: 'Which night ships as the default? (images: C:/x/look-afterload/sheet-night.png + sheet-night-coast.png)\n- A Classic\n- B Physical\n- C Physical + Night vision',
  options: [{ key: 'a', text: 'Classic' }, { key: 'b', text: 'Physical' }, { key: 'c', text: 'Physical + Night vision' }], recommend: { key: 'c', why: 'readable' }, blocks: [], owner_only: true };
const DEC873 = { lane: 'night', question: 'OWNER PICK 11-13 (taste pick, sheets look-afterload/sheet-night.png): which night ships as the default?',
  choice: 'C: exposure_law = physical with night vision on becomes the default (owner verbatim: "Agreed, C").', why: 'the owner picked from the stills' };

function setup() {
  const s = mkTmp('meta-qrec-');
  rec(s, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'night' } });
  rec(s, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'water' } });
  const q = rec(s, { kind: 'question', ev: 'create', by: 'checkin', data: Q58 }).id;
  return { s, q };
}
// the miss as it happened: a decision written past the guard (the importer role replays history as it was)
const legacyDec = (s, data = DEC873) => rec(s, { kind: 'decision', ev: 'create', by: 'migration', data: { ...data, legacy_by: 'controller' } }).id;
const dg = s => digest(s, {}, { now: Date.parse('2026-11-13T12:00:00Z'), git: { refTip: () => null, isAncestor: () => false }, dlv: [], evalAfter: () => ({ met: null }), ready: [] });

test('write time: a decision with an owner pick on a lane with an open Q is refused (exit 3) and names the Q', () => {
  const { s, q } = setup();
  assert.throws(() => rec(s, { kind: 'decision', ev: 'create', by: 'controller', data: DEC873 }),
    e => e instanceof RecordError && e.code === 3 && e.message.includes(`${q} is open on lane night - pass --answers ${q} or --not-an-answer`));
  assert.equal(readEvents(recordsFile(s)).filter(e => e.kind === 'decision').length, 0, 'nothing written');
  // owner words alone count as an owner pick
  assert.throws(() => rec(s, { kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'night', question: 'q', choice: 'c', why: 'w', owner_words: 'Agreed, C' } }), e => e.code === 3);
  // the CLI: exit 3, the message names the Q
  const r = cli(s, 'add', 'decision', '--lane', 'night', '--question', DEC873.question, '--choice', DEC873.choice, '--why', DEC873.why, '--as', 'controller');
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, new RegExp(`${q} is open on lane night - pass --answers ${q} or --not-an-answer`));
  // a plain ruling (no owner pick) on the same lane, and an owner pick on ANOTHER lane, pass
  rec(s, { kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'night', question: 'raise the floor?', choice: 'yes', why: 'cited data' } });
  rec(s, { kind: 'decision', ev: 'create', by: 'controller', data: { ...DEC873, lane: 'water' } });
});

test('--not-an-answer: written, flagged, the Q stays open and no digest row points at it', () => {
  const { s, q } = setup();
  const r = cli(s, 'add', 'decision', '--lane', 'night', '--question', DEC873.question, '--choice', DEC873.choice, '--why', DEC873.why, '--not-an-answer', '--as', 'controller');
  assert.equal(r.status, 0, r.stderr);
  const st = loadState(s);
  const dec = Object.values(st.items).find(i => i.kind === 'decision');
  assert.equal(dec.data.not_an_answer, true);
  assert.equal(st.items[q].state, 'open');
  assert.deepEqual(possibleAnswers(Object.values(st.items)), []);
});

test('--answers Q-n --owner-words: one call, three events (decision, answer with the owner words, apply)', () => {
  const { s, q } = setup();
  const before = readEvents(recordsFile(s)).length;
  const r = cli(s, 'add', 'decision', '--lane', 'night', '--question', DEC873.question, '--choice', DEC873.choice, '--why', DEC873.why,
    '--answers', q, '--owner-words', 'Agreed, C', '--as', 'controller');
  assert.equal(r.status, 0, r.stderr);
  const evs = readEvents(recordsFile(s)).slice(before);
  assert.deepEqual(evs.map(e => `${e.kind} ${e.ev}`), ['decision create', 'question answer', 'question apply']);
  const dec = evs[0].id;
  assert.equal(r.stdout.split('\n')[0].trim(), dec);
  assert.equal(evs[0].data.owner_words, 'Agreed, C');
  assert.equal(evs[1].id, q);
  assert.equal(evs[1].by, 'owner', 'the owner\'s words, relayed');
  assert.deepEqual({ text: evs[1].data.text, via: evs[1].data.via, from: evs[1].data.from, choice: evs[1].data.choice, relayed_by: evs[1].data.relayed_by },
    { text: 'Agreed, C', via: 'chat', from: dec, choice: 'c', relayed_by: 'controller' });
  assert.deepEqual(evs[2].data.refs, [dec]);
  assert.equal(evs[2].by, 'controller');
  assert.equal(loadState(s).items[q].state, 'applied');
  // --answers on an open Q with an owner pick but no words: refused (the Q would stay open)
  const { s: s2, q: q2 } = setup();
  const r2 = cli(s2, 'add', 'decision', '--lane', 'night', '--question', DEC873.question, '--choice', DEC873.choice, '--why', DEC873.why, '--answers', q2, '--as', 'controller');
  assert.equal(r2.status, 2, r2.stderr);
  assert.match(r2.stderr, /--owner-words/);
  assert.equal(loadState(s2).items[q2].state, 'open');
});

test('digest: "Q-n open, possibly answered by DEC-m" - same lane, later DEC, owner words / OWNER PICK / the Q\'s evidence paths', () => {
  const { s, q } = setup();
  const dec = legacyDec(s);
  const rows = dg(s).sections.questions;
  assert.equal(rows.find(r => r.id === q).answered_by, dec);
  assert.match(renderDigest(dg(s)), new RegExp(`${q} open, possibly answered by ${dec}`));
  // the Q's evidence path alone (no owner words) also matches
  const b = setup();
  const d2 = legacyDec(b.s, { lane: 'night', question: 'night default', choice: 'physical + night vision', why: 'from sheet-night-coast.png' });
  assert.equal(dg(b.s).sections.questions.find(r => r.id === b.q).answered_by, d2);
});

test('digest: a DEC on another lane, an earlier DEC, or a plain ruling never matches', () => {
  const s = mkTmp('meta-qrec-');
  rec(s, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'night' } });
  legacyDec(s);   // earlier than the Q
  const q = rec(s, { kind: 'question', ev: 'create', by: 'checkin', data: Q58 }).id;
  legacyDec(s, { ...DEC873, lane: 'water' });   // another lane
  legacyDec(s, { lane: 'night', question: 'raise the floor?', choice: 'yes', why: 'cited data' });   // no owner words, no evidence path
  assert.equal(dg(s).sections.questions.find(r => r.id === q).answered_by ?? null, null);
  assert.doesNotMatch(renderDigest(dg(s)), /possibly answered/);
});

test('norn rec answer Q-n --from DEC-m: the owner words copied from the DEC, via = the DEC\'s; + apply; the row leaves', () => {
  const { s, q } = setup();
  const dec = legacyDec(s, { ...DEC873, via: 'chat:claude-code' });
  const r = cli(s, 'answer', q, '--from', dec, '--as', 'checkin');
  assert.equal(r.status, 0, r.stderr);
  const it = loadState(s).items[q];
  assert.equal(it.state, 'applied');
  assert.deepEqual({ text: it.answer.text, via: it.answer.via, from: it.answer.from, choice: it.answer.choice }, { text: 'Agreed, C', via: 'chat:claude-code', from: dec, choice: 'c' });
  assert.deepEqual(it.apply.refs, [dec]);
  assert.equal(dg(s).sections.questions.find(x => x.id === q), undefined);
  // a DEC without owner words cannot answer a Q
  const b = setup();
  const d2 = legacyDec(b.s, { lane: 'night', question: 'night default', choice: 'c', why: 'from sheet-night-coast.png' });
  const r2 = cli(b.s, 'answer', b.q, '--from', d2, '--as', 'checkin');
  assert.equal(r2.status, 2, r2.stderr);
  assert.match(r2.stderr, /owner words/);
  // ... nor one on another lane
  const c = setup();
  const d3 = legacyDec(c.s, { ...DEC873, lane: 'water' });
  assert.equal(cli(c.s, 'answer', c.q, '--from', d3, '--as', 'checkin').status, 2);
});

test('norn rec not-an-answer DEC-m --q Q-n: the row leaves, the Q stays open', () => {
  const { s, q } = setup();
  const dec = legacyDec(s);
  const r = cli(s, 'not-an-answer', dec, '--q', q, '--why', 'the pick was for the day look', '--as', 'checkin');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(loadState(s).items[q].state, 'open');
  assert.equal(dg(s).sections.questions.find(x => x.id === q).answered_by ?? null, null);
});

test('MCP norn_decision_add: the same refusal (code 3) and the same --answers path', () => {
  const { s, q } = setup();
  const ctx = { state: s, profile: 'controller', writer: 'controller', via: 'chat:test' };
  const call = args => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'norn_decision_add', arguments: args } }, ctx).result;
  const no = call({ lane: 'night', question: DEC873.question, choice: DEC873.choice, why: DEC873.why });
  assert.equal(no.isError, true); assert.equal(no.structuredContent.code, 3);
  assert.match(no.structuredContent.error, new RegExp(`${q} is open on lane night`));
  const yes = call({ lane: 'night', question: DEC873.question, choice: DEC873.choice, why: DEC873.why, answers: q, owner_words: 'Agreed, C' });
  assert.equal(yes.isError, undefined, JSON.stringify(yes));
  const it = loadState(s).items[q];
  assert.equal(it.state, 'applied'); assert.equal(it.answer.text, 'Agreed, C'); assert.equal(it.answer.via, 'chat:test');
});

test('dashboard Inbox: the Q card shows the hint and a one-tap "already answered in DEC-m" that writes the answer from the DEC', async () => {
  const f = await fixture();
  try {
    const S = f.pa.state;
    rec(S, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'night' } });
    const q = rec(S, { kind: 'question', ev: 'create', by: 'checkin', data: Q58 }).id;
    const dec = legacyDec(S);
    const item = (await f.get('/api/inbox')).data.items.find(i => i.id === q);
    assert.equal(item.answered_by?.id, dec);
    assert.equal(item.answered_by?.words, 'Agreed, C');
    const html = renderTab('inbox', { items: [item] }, { project: f.pa.name });
    assert.match(html, new RegExp(`data-act="answer-from"[^>]*data-from="${dec}"`));
    assert.match(html, new RegExp(`already answered in ${dec}`));
    assert.match(html, /Agreed, C/);
    const w = await f.post('/api/answer', { project: f.pa.name, id: q, from: dec });
    assert.equal(w.status, 200, JSON.stringify(w.data));
    const it = loadState(S).items[q];
    assert.equal(it.state, 'answered'); assert.equal(it.answer.text, 'Agreed, C'); assert.equal(it.answer.from, dec);
  } finally { await f.done(); }
});
