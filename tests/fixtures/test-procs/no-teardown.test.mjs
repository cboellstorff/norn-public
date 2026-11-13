// META-TEST-PROCS (PR-14): a test that starts a supervisor + fake executor the way delegate / agnostic hold a parent and ends WITHOUT
// any teardown of its own. Run by tests/test-procs.test.mjs: nothing it spawned may be alive once its file is done.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRun } from '../../../engine/lib/runs.mjs';
import { loadState } from '../../../engine/lib/records.mjs';
import { mkTmp } from '../../helpers/tmp.mjs';

test('a held parent (fake executor, sleeping until a release file that never comes) and no teardown', async () => {
  const t = mkTmp('meta-tpx-');
  const d = { state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), wt: path.join(t, 'wt') };
  for (const k of ['state', 'locks', 'wt']) fs.mkdirSync(d[k], { recursive: true });
  const b = path.join(t, 'parent.md');
  fs.writeFileSync(b, `mode: sleep\nuntil: ${path.join(t, 'release-never')}\n`);
  const { run } = startRun({ state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt, notes: path.join(t, 'NOTES.md'), brief: b,
    hbMs: 150, policy: { auto_resume_max: 0 }, budget: {}, tick: null });
  for (let i = 0; i < 200 && !fs.existsSync(path.join(d.state, 'hb', `${run}.json`)); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(loadState(d.state).items[run].state, 'running');
});
