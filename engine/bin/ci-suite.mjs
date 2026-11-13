#!/usr/bin/env node
// META-GTP-CI 1: run the node suite and fail only on a red NOT listed in tests/KNOWN-REDS.txt (GT-PARITY-PLAN 2.11).
// usage: node engine/bin/ci-suite.mjs [--known F] [--concurrency N] [glob ...]   (default: tests/KNOWN-REDS.txt, 3, "tests/*.test.mjs")
// The suite is one `node --test` per matched file, N at a time, plus a reporter that writes the reds; smoke.test.mjs
// then runs alone (DEC-78). CI and the merge lanes call this script: it is the one home of the suite command.
// exit 0 = no new red, 1 = a new red or a file that left a process alive (named on stdout), 2 = usage / the suite produced no result.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseKnown, judge, suiteEnv } from '../lib/cisuite.mjs';
import { procsNaming } from '../lib/testprocs.mjs';
import { killTree } from '../lib/runs.mjs';

const REPORTER = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'ci-reporter.mjs')).href;
const fwd = s => s.split('\\').join('/');
const argv = process.argv.slice(2), globs = [];
let known = 'tests/KNOWN-REDS.txt', conc = '3';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--known') known = argv[++i];
  else if (argv[i] === '--concurrency') conc = argv[++i];
  else if (argv[i].startsWith('--')) { console.error(`ci-suite: unknown flag ${argv[i]}`); process.exit(2); }
  else globs.push(argv[i]);
}
if (!globs.length) globs.push('tests/*.test.mjs');

let list;
try { list = parseKnown(fs.readFileSync(known, 'utf8')); } catch (e) { console.error(`ci-suite: ${e.message}`); process.exit(2); }
// DEC-78: smoke.test.mjs has a < 60 s wall-clock budget that picked up contention from the parallel set, so it is left out of
// the parallel run and runs alone (concurrency 1) after it. Both phases feed ONE red report and ONE exit code.
const SERIAL = new Set(['smoke.test.mjs']);
const files = [...new Set(globs.flatMap(g => fs.globSync(fwd(g))).map(fwd))].sort();
if (!files.length) { console.error(`ci-suite: no test file matches ${globs.join(' ')}`); process.exit(2); }
const parFiles = files.filter(f => !SERIAL.has(path.basename(f))), serFiles = files.filter(f => SERIAL.has(path.basename(f)));
// a ci-suite started from inside a test must run its files (no NODE_TEST_CONTEXT), and a calling run's identity stays out (suiteEnv)
const childEnv = suiteEnv(process.env);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-suite-'));
// META-TEST-PROCS (DEC-219, SPEC 9.6 PR-14; Jest's --detectOpenHandles, made a hard check): each test file runs as its own
// `node --test` with its own temp dir (TEMP / TMP / TMPDIR), so every temp state it makes - and every process it starts there -
// names that dir. When the file is done, a process whose command line still names it is that file's leak: the file fails, naming
// the pids (never a listed red: KNOWN-REDS cannot hold it), and the suite kills them. 11-13: 22 supervisor + fake-executor pairs.
const runFile = (name, f, i) => new Promise(resolve => {
  const ft = path.join(tmp, `${name}-${i}`), out = path.join(tmp, `${name}-${i}.jsonl`);
  fs.mkdirSync(ft);
  const child = spawn(process.execPath, ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${REPORTER}`, `--test-reporter-destination=${out}`, f], { env: { ...childEnv, TEMP: ft, TMP: ft, TMPDIR: ft } });
  const buf = [];
  child.stdout.on('data', d => buf.push(d)); child.stderr.on('data', d => buf.push(d));
  child.on('close', (status, signal) => {
    process.stdout.write(Buffer.concat(buf));
    const fails = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      .map(x => ({ file: x.file ? fwd(path.relative(process.cwd(), x.file)) : f, name: x.name })) : null;
    const left = procsNaming([ft]);
    for (const p of left) killTree(p.pid);
    const leak = left.length ? { file: f, name: `left ${left.length} process(es) alive after the file: ${left.map(p => `pid ${p.pid} (${p.cmd})`).join('; ')}` } : null;
    resolve({ f, status, signal, fails, leak });
  });
});
const phase = async (name, c, files) => {
  console.log(`ci-suite: ${name} phase: ${name === 'serial' ? files.join(' ') : `${files.length} file(s)`}, concurrency ${c}`);
  const t0 = Date.now(), res = [], todo = files.map((f, i) => [f, i]);
  const worker = async () => { while (todo.length) { const [f, i] = todo.shift(); res.push(await runFile(name, f, i)); } };
  await Promise.all(Array.from({ length: Math.max(1, Number(c) || 1) }, worker));
  const status = Math.max(0, ...res.map(r => r.status ?? 1));
  console.log(`ci-suite: ${name} phase took ${((Date.now() - t0) / 1000).toFixed(2)} s (exit ${status})`);
  const none = res.find(r => !r.fails);
  if (none) { console.error(`ci-suite: ${none.f} wrote no result (exit ${none.status}, signal ${none.signal})`); process.exit(2); }
  const quiet = res.filter(r => r.status !== 0 && !r.fails.length).map(r => r.f);
  return { name, status, quiet, fails: res.flatMap(r => r.fails), leaks: res.map(r => r.leak).filter(Boolean) };
};
const runs = [];
if (parFiles.length) runs.push(await phase('parallel', conc, parFiles));
if (serFiles.length) runs.push(await phase('serial', '1', serFiles));
const j = judge(runs.flatMap(r => r.fails), list);
for (const f of j.listed) console.log(`listed red: ${f.file} :: ${f.name}`);
for (const k of j.fixed) console.log(`listed red now passes (remove it): ${k.file} :: ${k.name}`);
for (const f of j.fresh) console.log(`NEW RED: ${f.file} :: ${f.name}`);
const leaks = runs.flatMap(r => r.leaks);
for (const f of leaks) console.log(`LEAK RED: ${f.file} :: ${f.name}`);
console.log(`ci-suite: ${j.listed.length} listed red(s), ${j.fresh.length} new, ${leaks.length} leak(s)`);
for (const r of runs) for (const f of r.quiet) { console.error(`ci-suite: ${f} (${r.name} phase) exited non-zero with no red reported`); process.exit(1); }
process.exit(j.ok && !leaks.length ? 0 : 1);
