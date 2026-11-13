// META-GTP-CI 1: the CI suite runner fails only on a red NOT in tests/KNOWN-REDS.txt (GT-PARITY-PLAN 2.11). The fixture file has
// a listed red, a listed subtest red (its parent's "subtests failed" is not a red of its own) and an opt-in new red.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseKnown, judge, suiteEnv } from '../engine/lib/cisuite.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CI = path.join(REPO, 'engine', 'bin', 'ci-suite.mjs');
const FX = 'tests/fixtures/ci-suite';
const suite = (env = {}) => spawnSync(process.execPath, [CI, '--known', `${FX}/known.txt`, `${FX}/*.test.mjs`],
  { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env } });

test('parseKnown: "<file> :: <name>" lines, # comments and blanks skipped; a line without :: throws', () => {
  assert.deepEqual(parseKnown('# c\n\ntests/a.test.mjs :: GOLDEN:\r\n tests\\b.test.mjs ::  x y \n'),
    [{ file: 'tests/a.test.mjs', name: 'GOLDEN:' }, { file: 'tests/b.test.mjs', name: 'x y' }]);
  assert.throws(() => parseKnown('tests/a.test.mjs GOLDEN'), /KNOWN-REDS line 1/);
});

test('judge: a listed red (exact name or prefix, same file) passes; a new red fails; a listed red that passed is reported, not failed', () => {
  const known = parseKnown('tests/a.test.mjs :: GOLDEN:\ntests/b.test.mjs :: DEC-362: x\ntests/c.test.mjs :: gone');
  const j = judge([{ file: 'tests/a.test.mjs', name: 'GOLDEN: kestrel byte-same' }, { file: 'tests/b.test.mjs', name: 'DEC-362: x' },
    { file: 'tests/a.test.mjs', name: 'DEC-362: x' }], known);
  assert.deepEqual(j.listed.map(f => f.name), ['GOLDEN: kestrel byte-same', 'DEC-362: x']);
  assert.deepEqual(j.fresh, [{ file: 'tests/a.test.mjs', name: 'DEC-362: x' }]);
  assert.deepEqual(j.fixed, [{ file: 'tests/c.test.mjs', name: 'gone' }]);
  assert.equal(j.ok, false);
  assert.equal(judge([], []).ok, true);
});

test('ci-suite: only listed reds -> exit 0; a new red -> exit 1 naming it', () => {
  const ok = suite();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /ci-suite: 2 listed red\(s\), 0 new/);
  assert.match(ok.stdout, /listed red now passes \(remove it\): tests\/fixtures\/ci-suite\/gone\.test\.mjs :: never fails/);
  const bad = suite({ CI_SUITE_FX_NEW: '1' });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /NEW RED: tests\/fixtures\/ci-suite\/fx\.test\.mjs :: fx new red/);
  assert.doesNotMatch(bad.stdout, /NEW RED: .*fx parent/);
});

test('tests/KNOWN-REDS.txt is empty (GOLDEN + DEC-362 fixed at the cause, 5ea9e25); any listed red names a test that exists', () => {
  const known = parseKnown(fs.readFileSync(path.join(REPO, 'tests', 'KNOWN-REDS.txt'), 'utf8'));
  assert.deepEqual(known.map(k => k.file), []);   // the list only shrinks: a new entry needs the controller's ruling
  for (const k of known) assert.ok(fs.readFileSync(path.join(REPO, k.file), 'utf8').includes(`test('${k.name}`), `${k.file} has no test '${k.name}...'`);
});

// DEC-78: smoke.test.mjs runs alone (concurrency 1) after the parallel set, so its < 60 s budget measures smoke, not contention.
test.after(cleanTmp);
const SER = 'tests/fixtures/ci-suite-serial';
const serial = (red = '', globs = [`${SER}/*.test.mjs`]) => {
  const log = path.join(mkTmp('meta-ci-serial-'), 'log');
  fs.writeFileSync(log, '');
  const r = spawnSync(process.execPath, [CI, '--known', `${SER}/known.txt`, ...globs],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, CI_SUITE_LOG: log, CI_SUITE_RED: red } });
  const ev = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => l.split(' ')).map(([f, w, t]) => ({ f, w, t: +t }));
  return { ...r, ev };
};

test('ci-suite: smoke.test.mjs is left out of the parallel run and runs once, alone, after it; one report, one exit code', () => {
  const ok = serial();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /ci-suite: parallel phase: 2 file\(s\), concurrency 3/);
  assert.match(ok.stdout, new RegExp(`ci-suite: serial phase: ${SER}/smoke\.test\.mjs, concurrency 1`));
  const starts = ok.ev.filter(e => e.w === 'start');
  assert.deepEqual(starts.map(e => e.f).sort(), ['p1', 'p2', 'smoke'], 'each file runs exactly once');
  const smokeStart = starts.find(e => e.f === 'smoke').t;
  for (const e of ok.ev.filter(e => e.f !== 'smoke')) assert.ok(e.t <= smokeStart, `${e.f} ${e.w} after smoke started`);
  assert.match(ok.stdout, /ci-suite: 0 listed red\(s\), 0 new/);

  const par = serial('p1');
  assert.equal(par.status, 1, par.stdout + par.stderr);
  assert.match(par.stdout, new RegExp(`NEW RED: ${SER}/p1\.test\.mjs :: p1 fixture`));
  const smk = serial('smoke');
  assert.equal(smk.status, 1, smk.stdout + smk.stderr);
  assert.match(smk.stdout, new RegExp(`NEW RED: ${SER}/smoke\.test\.mjs :: smoke fixture`));
  const both = serial('p2,smoke');
  assert.equal(both.status, 1, both.stdout + both.stderr);
  assert.match(both.stdout, /ci-suite: 0 listed red\(s\), 2 new/);
});

test('ci-suite: an explicit glob without smoke runs only the parallel phase; one naming only smoke runs only the serial one', () => {
  const p = serial('', [`${SER}/p1.test.mjs`]);
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.deepEqual(p.ev.filter(e => e.w === 'start').map(e => e.f), ['p1']);
  assert.doesNotMatch(p.stdout, /serial phase/);
  const s = serial('', [`${SER}/smoke.test.mjs`]);
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.deepEqual(s.ev.filter(e => e.w === 'start').map(e => e.f), ['smoke']);
  assert.doesNotMatch(s.stdout, /parallel phase/);
});

// 11-13 RUN-471 / RUN-477 / RUN-481 / RUN-505: a worker's own META_RUN_ID / META_ROLE / META_STATE (and CLAUDECODE) leaked into
// the suite it ran - 4 CLI test files went red and the suite hung; the MERGE of feat/meta-shot stopped on it.
test('ci-suite: the calling run identity (META_RUN_ID, META_ROLE, META_STATE, ..., CLAUDECODE) never reaches the suite', () => {
  const r = spawnSync(process.execPath, [CI, '--known', 'tests/fixtures/ci-suite-env/known.txt', 'tests/fixtures/ci-suite-env/*.test.mjs'],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, META_RUN_ID: 'RUN-1', META_RUN_STATE: '/x/state', META_ROLE: 'checkin', META_STATE: '/x/state',
      META_PROJECT: 'p', META_SESSION_ID: 's', META_RESUMES: '1', META_NOTES: '/x/NOTES.md', CLAUDECODE: '1' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ci-suite: 0 listed red\(s\), 0 new/);
});

test('suiteEnv: the temp repos of the suite skip git auto maintenance (a gc / maintenance process per commit or fetch, not under test); the git config entries of a caller are kept', () => {
  const e = suiteEnv({ PATH: 'p' });
  const cfg = Object.fromEntries(Array.from({ length: Number(e.GIT_CONFIG_COUNT) }, (_, i) => [e['GIT_CONFIG_KEY_' + i], e['GIT_CONFIG_VALUE_' + i]]));
  assert.deepEqual(cfg, { 'maintenance.auto': 'false', 'gc.auto': '0' });
  const k = suiteEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.x', GIT_CONFIG_VALUE_0: 'y' });
  assert.equal(k.GIT_CONFIG_COUNT, '3'); assert.equal(k.GIT_CONFIG_KEY_0, 'core.x'); assert.equal(k.GIT_CONFIG_KEY_2, 'gc.auto');
});
