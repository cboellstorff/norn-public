// ci-suite fixture (tests/ci-suite.test.mjs): one green test, one listed red, a subtest red under a parent, and a NEW red
// only when CI_SUITE_FX_NEW=1. Not part of the suite glob (tests/*.test.mjs does not recurse).
import test from 'node:test';
import assert from 'node:assert/strict';

test('fx green', () => assert.ok(true));
test('KNOWN: fx listed red', () => assert.fail('listed'));
test('fx parent', async t => { await t.test('KNOWN-SUB: fx listed subtest red', () => assert.fail('listed sub')); });
if (process.env.CI_SUITE_FX_NEW === '1') test('fx new red', () => assert.fail('new'));
