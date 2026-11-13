// S2 migration importer (META-GENERAL-DESIGN 11): fixtures = copies of the live meta files taken at S2 start (2026-10-31 ~02:10Z).
// Counts below were hand-derived from the fixtures (grep / awk; NOTES S2 DECIDED lists old -> new counts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planMigration, runMigration, readSources, MigrationError } from '../engine/lib/migrate.mjs';
import { loadState, readEvents, recordsFile, fold } from '../engine/lib/records.mjs';
import { renderQuestions } from '../engine/lib/views.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'migration');
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const NOW = new Date('2026-10-31T02:10:00Z');
const tmp = () => mkTmp('meta-mig-');
const src = () => readSources(FIX);
const lines = f => fs.readFileSync(path.join(FIX, f), 'utf8').replace(/^\uFEFF/, '').split('\n');
let cached = null;
const migrated = () => {
  if (cached) return cached;
  const s = tmp();
  const res = runMigration(src(), { state: s, budgetOut: path.join(s, 'local', 'budget.json'), projectOut: path.join(s, 'project.json'), project: 'demo', now: () => NOW });
  cached = { s, res, st: loadState(s) };
  return cached;
};
const ofKind = (st, k) => Object.values(st.items).filter(i => i.kind === k);

test('unmapped line / key -> fail, nothing written', () => {
  const bad = [
    s => { s.decisions += 'stray prose line\n'; },
    s => { s.questions += '- 2026-10-30T23:00Z OWNER ANSWER (gen 09:99Z question): ACCEPTED (a).\n'; },
    s => { s.directives += 'not a bullet\n'; },
    s => { const b = JSON.parse(s.budget); b.brand_new_key = 1; s.budget = JSON.stringify(b); },
  ];
  for (const mutate of bad) {
    const x = src(); mutate(x);
    assert.throws(() => planMigration(x, { now: () => NOW }), MigrationError);
    const s = tmp();
    assert.throws(() => runMigration(x, { state: s, now: () => NOW }), MigrationError);
    assert.equal(fs.existsSync(recordsFile(s)), false);
  }
});

test('refuses a non-empty state dir', () => {
  const { s } = migrated();
  assert.throws(() => runMigration(src(), { state: s, now: () => NOW }), /not empty/);
});

test('every imported event is written by role migration', () => {
  const { s } = migrated();
  const evs = [...readEvents(recordsFile(s)), ...readEvents(recordsFile(s, 'run'))];
  assert.ok(evs.length > 0 && evs.every(e => e.by === 'migration'));
});

test('owner DECs keep rule iv after migration: a controller cannot supersede DEC-96 with a newer DEC', async () => {
  const { s } = migrated();
  const { record } = await import('../engine/lib/records.mjs');
  const c = tmp(); fs.cpSync(s, c, { recursive: true });
  const d = record(c, { kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'relief', question: 'q', choice: 'x', why: 'y' } }, { views: false });
  assert.throws(() => record(c, { kind: 'decision', ev: 'supersede', id: 'DEC-96', by: 'controller', data: { by: d.id, why: 'newer' } }, { views: false }), /owner decision/);
  assert.equal(record(c, { kind: 'decision', ev: 'supersede', id: 'DEC-1', by: 'controller', data: { by: d.id, why: 'newer' } }, { views: false }).ev, 'supersede');
});

test('CLI: norn migrate --dry-run prints the mapping table and writes nothing; real run writes records + map', () => {
  const s = mkTmp('meta-mig-', 'legacy-proj');
  const env = { ...process.env }; delete env.META_RUN_ID;
  const args = ['migrate', '--src', FIX, '--state', s, '--budget-out', path.join(s, 'local', 'budget.json'), '--project-out', path.join(s, 'project.json'), '--now', NOW.toISOString()];
  const dry = spawnSync(process.execPath, [META, ...args, '--dry-run'], { env, encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^\| source \| record \| event \| final state \|$/m);
  assert.match(dry.stdout, /^\| OWNER-QUESTIONS\.md:13 \| Q-5 \| supersede by DIR-9 \| superseded \|$/m);
  assert.match(dry.stdout, /^\| BUDGET\.json max_claude_workers \| budget\.max_claude_workers \|/m);
  assert.match(dry.stdout, /6 Q \(0 open\) · 194 DEC · 13 DIR \(9 active\) · 19 L · 19 RUN · 82 BUDGET keys/);
  assert.deepEqual(fs.readdirSync(s), []);
  const real = spawnSync(process.execPath, [META, ...args], { env, encoding: 'utf8' });
  assert.equal(real.status, 0, real.stderr);
  assert.ok(fs.existsSync(path.join(s, 'records.jsonl')) && fs.existsSync(path.join(s, 'migration-map.md')));
  assert.ok(ofKind(loadState(s), 'run').every(r => r.data.project === path.basename(s)), 'the CLI project defaults to the state dir name (state/<project>)');
  const bad = spawnSync(process.execPath, [META, ...args], { env, encoding: 'utf8' });
  assert.equal(bad.status, 2); assert.match(bad.stderr, /not empty/);
});

test('question head "lane (REF)" (live 10-31 04:01Z form) -> an open Q on that lane, title led by the ref (S9)', () => {
  const x = src();
  x.questions += '- 2026-10-31T04:01Z relief (RELIEF-AUDIT s.6 Q1): the FINAL coast D gate is 1.147. Keep it?\n';
  const s = tmp();
  runMigration(x, { state: s, now: () => NOW });
  const qs = Object.values(loadState(s).items).filter(i => i.kind === 'question' && i.state === 'open');
  assert.equal(qs.length, 1);
  assert.equal(qs[0].data.lane, 'relief'); assert.equal(qs[0].data.legacy_by, 'checkin');
  assert.match(qs[0].data.title, /^RELIEF-AUDIT s\.6 Q1: the FINAL coast D gate is 1\.147/);
});
