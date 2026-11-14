// META-TEND TESTS: the fixture of `ci-suite --measure --coverage` (tests/ci-suite.test.mjs): one test with a subtest over names.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentName } from '../../../engine/lib/names.mjs';

test('outer', async t => {
  await t.test('inner names RUN-1', () => assert.equal(typeof agentName('RUN-1'), 'string'));
});
