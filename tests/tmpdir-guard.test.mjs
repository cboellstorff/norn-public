// META-GTP-CI TMPDIR-1 (DEC-60): no test keeps a state dir straight in os.tmpdir(). liveRuns lists every sibling state dir, so such a
// test scans the runner's whole (never cleaned) temp dir and its result depends on what earlier runs left there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { record } from '../engine/lib/records.mjs';
import { hbPath, liveRuns } from '../engine/lib/runs.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(TESTS, 'helpers', 'tmp.mjs'), SELF = fileURLToPath(import.meta.url);
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const f = path.join(d, e.name);
  if (e.isDirectory()) return ['fixtures', 'golden'].includes(e.name) && d === TESTS ? [] : walk(f);
  return /\.m?js$/.test(e.name) ? [f] : [];
});

test('tmpdir guard: no test file calls os.tmpdir() itself - every temp dir comes from helpers/tmp.mjs mkTmp (<mkdtemp>/state/<project>)', () => {
  const bad = [];
  for (const f of walk(TESTS)) {
    if (f === HELPER || f === SELF) continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (/tmpdir\s*\(/.test(l)) bad.push(`${path.relative(TESTS, f)}:${i + 1}`); });
  }
  assert.deepEqual(bad, [], 'use mkTmp() from tests/helpers/tmp.mjs, never os.tmpdir() directly');
});

// the kill criterion on a fake temp dir (never the runner's real one: scanning that is the very cost this guard exists for)
function withTmpdir(dir, fn) {
  const keys = ['TMPDIR', 'TMP', 'TEMP'], old = keys.map(k => process.env[k]);
  for (const k of keys) process.env[k] = dir;
  try { return fn(); } finally { keys.forEach((k, i) => { if (old[i] === undefined) delete process.env[k]; else process.env[k] = old[i]; }); }
}
function plantLive(dir) {
  const id = record(dir, { kind: 'run', ev: 'start', by: 'migration', data: { kind: 'worker', project: 'kestrel', lane: 'x', executor: 'fake' } }, { views: false }).id;
  fs.mkdirSync(path.dirname(hbPath(dir, id)), { recursive: true });
  fs.writeFileSync(hbPath(dir, id), JSON.stringify({ run: id, ts: new Date().toISOString() }));
}
