// S1 views: golden questions / decisions / directives views, view = fold (0 inference), hand-edit refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { record, loadState } from '../engine/lib/records.mjs';
import { HEADER, VIEW_FILES, renderQuestions, renderDecisions, renderDirectives, writeViews } from '../engine/lib/views.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const GOLD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden');
const tmp = () => mkTmp('meta-views-');

// A fixed history touching every view state; fixed clock -> byte-stable output.
function history(dir, opts = {}) {
  let t = 0;
  const o = { now: () => new Date(Date.UTC(2026, 9, 31, 2, 0, 0) + 60000 * t++), run: null, views: false, ...opts };
  const r = (e, run = null) => record(dir, e, { ...o, run });
  r({ kind: 'lane', ev: 'create', by: 'controller', data: { name: 'gen', worktree: 'C:/w/gen', branch: 'feat/gen' } });
  const q1 = r({ kind: 'question', ev: 'create', by: 'checkin', data: { title: 'Basin outlet: carve or fill?', lane: 'gen', body: 'Seed 7: 3 sinks deeper than 2 m.\nSeed 9: 1 sink | 0.4 m.', options: [{ key: 'a', text: 'carve (Lindsay 2016)', cost: '1 round' }, { key: 'b', text: 'fill (Planchon-Darboux)', cost: '' }], recommend: { key: 'a', why: 'keeps relief' }, class: 'ii', blocks: ['gen'], source: 'NOTES.md:41' } }, 'RUN-311').id;
  const q2 = r({ kind: 'question', ev: 'create', by: 'checkin', data: { title: 'Shoreline width', lane: 'gen', body: '', options: [], class: 'i', blocks: [], source: 'final.md' } }).id;
  const q3 = r({ kind: 'question', ev: 'create', by: 'controller', data: { title: 'Old ask', lane: 'relief', options: [], blocks: [] } }).id;
  r({ kind: 'question', ev: 'answer', id: q1, by: 'owner', data: { choice: 'a', text: 'carve, as recommended', via: 'dashboard' } });
  const d1 = r({ kind: 'decision', ev: 'create', by: 'checkin', data: { lane: 'gen', question: 'Basin outlet', choice: 'carve', why: 'owner answer Q-1', cost: '1 round', source: 'Lindsay 2016', answers: q1, on_runs: ['RUN-312'] } }).id;
  r({ kind: 'question', ev: 'apply', id: q1, by: 'checkin', data: { refs: [d1, 'RUN-312'] } });
  r({ kind: 'question', ev: 'withdraw', id: q3, by: 'controller', data: { why: 'asker no longer needs it' } });
  r({ kind: 'question', ev: 'answer', id: q2, by: 'owner', data: { text: 'two tiles', via: 'chat' } });
  const d2 = r({ kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'relief', question: 'Talus angle', choice: '35 deg', why: 'cited', cost: '', source: 'Carson 1971', notify: true } }).id;
  const d3 = r({ kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'relief', question: 'Talus angle (re-measured)', choice: '33 deg', why: 'new data', cost: '', source: 'Selby 1993' } }).id;
  r({ kind: 'decision', ev: 'supersede', id: d2, by: 'controller', data: { by: d3, why: 'newer measurement' } });
  r({ kind: 'decision', ev: 'overrule', id: d1, by: 'owner', data: { text: 'fill instead', rework_lane: 'gen' } });
  const x1 = r({ kind: 'directive', ev: 'create', by: 'owner', data: { text: 'Max 4 Codex runs.', via: 'chat' } }).id;
  const x2 = r({ kind: 'directive', ev: 'create', by: 'owner', data: { text: 'CODEX BRAKE: Sol only, max 2.', via: 'talk', scope: ['gen', 'relief'] } }).id;
  r({ kind: 'directive', ev: 'supersede', id: x1, by: 'checkin', data: { by: x2, why: 'amends the cap' } });
  const x3 = r({ kind: 'directive', ev: 'create', by: 'dashboard', data: { text: 'Restart the dashboard once.', via: 'dashboard', expires_utc: '2026-11-01T00:00:00Z' } }).id;
  r({ kind: 'directive', ev: 'done', id: x3, by: 'checkin', data: { refs: ['RUN-320'] } });
  r({ kind: 'directive', ev: 'create', by: 'owner', data: { text: 'Ship the island.', via: 'chat' } });
  r({ kind: 'question', ev: 'create', by: 'checkin', data: { title: 'Still open', lane: 'gen', body: 'Two sinks:\n- Q-1 area 4 km2\n- east cove 1 km2', options: [{ key: 'x', text: 'yes', cost: '2 h' }, { key: 'y', text: 'no', cost: '' }], recommend: { key: 'x', why: 'standard' }, class: 'iii', blocks: ['gen'], source: 'NOTES.md:88' } }, 'RUN-330');
  return loadState(dir);
}

const golden = (name, text) => {
  const f = path.join(GOLD, name);
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(f, text);
  assert.equal(text, fs.readFileSync(f, 'utf8'), `${name} differs from tests/golden (UPDATE_GOLDEN=1 to re-record, then review the diff)`);
};

test('golden views: questions, decisions, directives', () => {
  const st = history(tmp());
  golden('OWNER-QUESTIONS.md', renderQuestions(st));
  golden('DECISIONS-LOG.md', renderDecisions(st));
  golden('DIRECTIVES.md', renderDirectives(st));
});

test('every view starts with the GENERATED header and renders the same bytes twice', () => {
  const st = history(tmp());
  for (const f of [renderQuestions, renderDecisions, renderDirectives]) {
    assert.ok(f(st).startsWith(HEADER + '\n'));
    assert.equal(f(st), f(history(tmp())));
  }
});

test('questions view = fold, 0 inference: the Open section lists exactly the open Q of the fold', () => {
  const st = history(tmp());
  const text = renderQuestions(st);
  const section = (name) => (text.split(/^## /m).find(s => s.startsWith(name)) || '').match(/^### (Q-\d+)/gm)?.map(s => s.slice(4)) || [];
  const byState = s => Object.values(st.items).filter(i => i.kind === 'question' && i.state === s).map(i => i.id);
  assert.deepEqual(section('Open'), byState('open'));
  assert.deepEqual(section('Answered'), byState('answered'));
  assert.deepEqual(byState('open'), ['Q-4']);
});

test('record() regenerates the views; a hand-edited view is refused, not overwritten; revert -> regenerated again', () => {
  const d = tmp();
  const results = [];
  const opts = { views: undefined, onViews: v => results.push(v) };
  history(d, opts);
  const qv = path.join(d, 'views', VIEW_FILES.questions);
  assert.equal(fs.readFileSync(qv, 'utf8'), renderQuestions(loadState(d)));
  assert.deepEqual(results.at(-1).refused, []);
  const generated = fs.readFileSync(qv, 'utf8');
  fs.writeFileSync(qv, generated.replace('Still open', 'Hand edited'));
  record(d, { kind: 'question', ev: 'create', by: 'checkin', data: { title: 'After edit', lane: 'gen', options: [], blocks: [] } }, opts);
  assert.deepEqual(results.at(-1).refused, [qv]);
  assert.match(fs.readFileSync(qv, 'utf8'), /Hand edited/);
  assert.doesNotMatch(fs.readFileSync(qv, 'utf8'), /After edit/);
  assert.match(fs.readFileSync(path.join(d, 'views', VIEW_FILES.decisions), 'utf8'), /DEC-1/, 'the other views still regenerate');
  fs.writeFileSync(qv, generated); // revert
  const r = writeViews(d, loadState(d));
  assert.deepEqual(r.refused, []);
  assert.match(fs.readFileSync(qv, 'utf8'), /After edit/);
});

test('a pre-existing view that meta never generated is refused (no silent overwrite of a hand file)', () => {
  const d = tmp();
  const p = path.join(d, 'OWNER-QUESTIONS.md');
  fs.writeFileSync(p, '# my hand-written questions\n');
  const r = writeViews(d, loadState(d), { questions: p });
  assert.deepEqual(r.refused, [p]);
  assert.equal(fs.readFileSync(p, 'utf8'), '# my hand-written questions\n');
});
