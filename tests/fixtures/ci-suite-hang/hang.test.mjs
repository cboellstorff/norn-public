// CI-HANG-B7F6833 R2: a file that never exits, for the ci-suite per-file wall cap. Run only by tests/ci-suite.test.mjs.
import test from 'node:test';

test('passes first', () => { console.log('hang-fixture: before the hang'); });
test('never ends', () => new Promise(() => { setInterval(() => {}, 1e6); }));
