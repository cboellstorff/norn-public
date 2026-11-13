// ci-suite fixture (tests/ci-suite.test.mjs, DEC-78 serial smoke): logs its start/end to CI_SUITE_LOG; red when CI_SUITE_RED names it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const log = (what) => fs.appendFileSync(process.env.CI_SUITE_LOG, `p1 ${what} ${Date.now()}\n`);
test('p1 fixture', async () => {
  log('start');
  await new Promise(r => setTimeout(r, 300));
  log('end');
  assert.ok(!(process.env.CI_SUITE_RED || '').split(',').includes('p1'), 'p1 red on request');
});
