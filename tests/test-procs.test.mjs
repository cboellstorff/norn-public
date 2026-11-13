// META-TEST-PROCS (DEC-219, SPEC 9.6 PR-14): a test file must not leave a Norn process (supervisor, fake executor, ...) alive. 11-13
// 22 supervisor + fake-executor pairs from meta-agn- / meta-dlg- temp states were found 23-28 h old. The teardown home is
// tests/helpers/tmp.mjs (every temp dir comes from mkTmp: it kills what names one); ci-suite is the hard check behind it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { suiteEnv } from '../engine/lib/cisuite.mjs';
import { procsNaming } from '../engine/lib/testprocs.mjs';
import { killTree } from '../engine/lib/runs.mjs';
import { listProcs } from '../engine/lib/strays.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempEnv = dir => ({ ...suiteEnv(process.env), TEMP: dir, TMP: dir, TMPDIR: dir });
const show = ps => ps.map(p => `pid ${p.pid}: ${p.cmd}`).join('\n');

test('a test that holds a supervisor + fake executor and has no teardown of its own leaves no process alive after its file', () => {
  const dir = mkTmp('meta-tp-');
  let left = [];
  try {
    const r = spawnSync(process.execPath, ['--test', 'tests/fixtures/test-procs/no-teardown.test.mjs'], { cwd: REPO, encoding: 'utf8', env: tempEnv(dir) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    left = procsNaming([dir]);
    assert.deepEqual(left, [], `still alive after the file ended:\n${show(left)}`);
  } finally { for (const p of left) killTree(p.pid); }
});

// the hard check: ci-suite runs each file with its own temp dir; a process still naming it after the file is a red no KNOWN-REDS
// line can hold, the pids named, and the suite kills it
const ci = (glob, known) => spawnSync(process.execPath, [path.join(REPO, 'engine', 'bin', 'ci-suite.mjs'), '--known', known, glob],
  { cwd: REPO, encoding: 'utf8', env: suiteEnv(process.env) });
test('ci-suite: a file that leaves a process alive fails naming its pid (even when KNOWN-REDS lists the file), and the process is killed; a file whose teardown is the shared helper passes', () => {
  const dir = mkTmp('meta-tp-known-');
  const known = path.join(dir, 'known.txt');
  fs.writeFileSync(known, 'tests/fixtures/ci-suite-leak/leak.test.mjs :: \n');
  const bad = ci('tests/fixtures/ci-suite-leak/leak.test.mjs', known);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  const m = bad.stdout.match(/LEAK RED: tests\/fixtures\/ci-suite-leak\/leak\.test\.mjs :: left 1 process\(es\) alive after the file: pid (\d+) \(/);
  assert.ok(m, bad.stdout);
  assert.match(bad.stdout, /ci-suite: 0 listed red\(s\), 0 new, 1 leak\(s\)/);
  assert.deepEqual(listProcs().filter(p => p.pid === Number(m[1])), [], `pid ${m[1]} still alive after ci-suite`);

  const ok = ci('tests/fixtures/test-procs/no-teardown.test.mjs', known);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /ci-suite: 0 listed red\(s\), 0 new, 0 leak\(s\)/);
});
