// META-TEST-PROCS (PR-14): a deliberately leaking file for the ci-suite hard check - it starts a detached node process that names
// its temp dir and never stops it, bypassing tests/helpers/tmp.mjs (and so its teardown). Run only by tests/test-procs.test.mjs.
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('leaks one process naming its temp dir', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-leak-'));
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', d], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
});
