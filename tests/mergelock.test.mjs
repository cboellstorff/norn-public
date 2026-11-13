// META-MERGELOCK R1 (DEC-103 / DEC-104): every MERGE-stage run holds the MAIN checkout's worktree lock for its whole life, in
// addition to its own worktree's - one merge at a time machine-wide. FAKE executor only, temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRun, stopRun, fillQueue, readiness, lockPath, writeTrees, sweepLost } from '../engine/lib/runs.mjs';
import { renderMergeBrief } from '../engine/lib/mergebrief.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { waitForSync, supervisorAlive } from './helpers/wait.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const fwd = p => String(p).replace(/\\/g, '/');
const RES = () => ({ free_gb: 64, cpu_pct: 1 });

function sandbox() {
  const t = mkTmp('meta-mergelock-');
  const d = { t, state: path.join(t, 'state', 'norn'), locks: path.join(t, 'state', 'locks'), main: path.join(t, 'main'), wtA: path.join(t, 'wt-a'), wtB: path.join(t, 'wt-b') };
  for (const k of ['state', 'locks', 'main', 'wtA', 'wtB']) fs.mkdirSync(d[k], { recursive: true });
  d.P = { name: 'norn', root: fwd(d.main), meta: '/h/dev/sdd-codex', deliverables: { main: 'main' }, policy: {} };
  // a staged MERGE brief of one lane; the fake executor finishes once `until` exists (a test releases it)
  d.staged = (lane, wt, until) => {
    const f = path.join(t, `merge-${lane}.md`);
    fs.writeFileSync(f, renderMergeBrief(d.P, { lane, branch: `feat/${lane}`, worktree: fwd(wt), notes: fwd(path.join(t, `${lane}-NOTES.md`)), sha: 'abcdef1' }) + `mode: done\nuntil: ${fwd(until)}\n`);
    return f;
  };
  d.opts = (lane, wt, brief, o = {}) => ({ state: d.state, locksDir: d.locks, executor: 'fake', lane, worktree: wt, brief, stage: 'MERGE', notes: path.join(t, `${lane}-NOTES.md`),
    tick: null, hbMs: 150, staleMs: 3000, policy: { auto_resume_max: 0 }, budget: {}, ...o });
  d.item = id => loadState(d.state).items[id];
  d.mainLock = () => { try { return JSON.parse(fs.readFileSync(lockPath(d.locks, d.main), 'utf8')); } catch { return null; } };
  d.filled = qid => Object.values(loadState(d.state).items).find(x => x.kind === 'run' && x.data.from_queue === qid) || null;
  // ended AND its supervisor gone: the lock release + the queue fill of its exit are done
  d.ends = id => waitForSync(() => settled(d.item(id)), { producer: supervisorAlive(d.state, () => d.item(id)), what: `${id} ends` });
  return d;
}

test('writeTrees: a MERGE run writes its own worktree AND the main checkout (from the brief marker); other stages only their own', () => {
  const d = sandbox();
  const b = d.staged('a', d.wtA, path.join(d.t, 'go-a'));
  const trees = writeTrees(d.opts('a', d.wtA, b)).map(fwd);
  assert.deepEqual(trees, [fwd(d.wtA), fwd(d.main)]);
  assert.deepEqual(writeTrees(d.opts('a', d.wtA, b, { stage: 'S2' })).map(fwd), [fwd(d.wtA)]);
  // a MERGE run IN the main checkout (the mq batch) holds one lock, not two
  assert.deepEqual(writeTrees(d.opts('mq', d.main, b)).map(fwd), [fwd(d.main)]);
  // a hand-written MERGE brief: the project's main checkout from the spec
  const hand = path.join(d.t, 'hand.md'); fs.writeFileSync(hand, '# merge by hand\n');
  assert.deepEqual(writeTrees(d.opts('a', d.wtA, hand, { main_checkout: d.main })).map(fwd), [fwd(d.wtA), fwd(d.main)]);
});

test('two staged MERGE runs on different lanes: the second refuses exit 3 on the main checkout; --queue / --after stay queued; the first exit frees it and the fill starts the second', () => {
  const d = sandbox();
  const goA = path.join(d.t, 'go-a'), goB = path.join(d.t, 'go-b');
  const a = startRun(d.opts('a', d.wtA, d.staged('a', d.wtA, goA)));
  assert.ok(a.run);
  assert.equal(d.mainLock()?.run, a.run, 'the MERGE run holds the main checkout lock');
  const bb = d.staged('b', d.wtB, goB);
  assert.throws(() => startRun(d.opts('b', d.wtB, bb)), e => e.code === 3 && new RegExp(`${a.run}`).test(e.message));
  assert.equal(fs.existsSync(lockPath(d.locks, d.wtB)), false, 'a refused start leaves no lock behind on its own worktree');
  const q = startRun(d.opts('b', d.wtB, bb, { queue: true }));
  assert.ok(q.queued, '--queue: a held main checkout queues the MERGE');
  const row = readiness(d.state, { resources: RES }).find(r => r.id === q.run);
  assert.equal(row.ready, false);
  assert.ok(row.terms.some(x => x.includes(a.run)), row.terms.join('; '));
  assert.deepEqual(fillQueue(d.state, { resources: RES }), [], 'the fill does not start it while the main checkout is held');
  fs.writeFileSync(goA, 'go');
  d.ends(a.run);
  // a's supervisor freed the main lock and filled the queue: b started from the queue
  const bRun = d.filled(q.run);
  assert.ok(bRun, 'the fill started the queued MERGE once the lock freed');
  fs.writeFileSync(goB, 'go');
  d.ends(bRun.id);
  assert.equal(d.mainLock(), null, 'every MERGE exit frees the main lock');
});

test('a fill with two eligible MERGE runs starts one; the other waits on the main checkout', () => {
  const d = sandbox();
  const goA = path.join(d.t, 'go-a'), goB = path.join(d.t, 'go-b');
  const wtC = path.join(d.t, 'wt-c'); fs.mkdirSync(wtC, { recursive: true });
  const blocker = startRun(d.opts('x', d.wtA, d.staged('x', d.wtA, path.join(d.t, 'go-x')), { stage: 'S1' }));   // holds wt-a only
  const after = [{ kind: 'run', id: blocker.run, state: 'ended' }];
  const qa = startRun(d.opts('a', d.wtB, d.staged('a', d.wtB, goA), { after }));
  const qb = startRun(d.opts('b', wtC, d.staged('b', wtC, goB), { after }));
  assert.ok(qa.queued && qb.queued);
  fs.writeFileSync(path.join(d.t, 'go-x'), 'go');
  d.ends(blocker.run);   // its supervisor fills: exactly one MERGE starts, the other waits on the main checkout
  const first = d.filled(qa.run) || d.filled(qb.run);
  assert.ok(first, 'one MERGE started');
  const waiting = d.filled(qa.run) ? qb.run : qa.run;
  assert.equal(d.filled(waiting), null, 'the second MERGE stays queued');
  assert.equal(d.item(waiting).state, 'queued');
  assert.equal(d.mainLock()?.run, first.id);
  const row = readiness(d.state, { resources: RES }).find(r => r.id === waiting);
  assert.ok(row.terms.some(x => x.includes(first.id)), row.terms.join('; '));
  fs.writeFileSync(goA, 'go'); fs.writeFileSync(goB, 'go');
  d.ends(first.id);   // its exit frees the main lock and its fill starts the other
  const second = d.filled(waiting);
  assert.ok(second, 'the waiting MERGE starts when the lock frees');
  d.ends(second.id);
  assert.equal(d.mainLock(), null);
});

test('a killed MERGE run frees the main lock (norn stop); a lost one (no heartbeat) goes stale and is broken like any lock', () => {
  const d = sandbox();
  const a = startRun(d.opts('a', d.wtA, d.staged('a', d.wtA, path.join(d.t, 'never'))));
  assert.equal(d.mainLock()?.run, a.run);
  stopRun({ state: d.state, locksDir: d.locks, run: a.run, by: 'controller', why: 'test' });
  assert.equal(d.mainLock(), null, 'norn stop frees the main checkout lock too');
  assert.equal(fs.existsSync(lockPath(d.locks, d.wtA)), false);
  // a lost run: its lock file stays but its ts goes stale (no supervisor refresh) - the next MERGE breaks it
  fs.writeFileSync(lockPath(d.locks, d.main), JSON.stringify({ run: 'RUN-999', pid: 1, ts: new Date(Date.now() - 60000).toISOString() }));
  const go = path.join(d.t, 'go-b');
  const b = startRun(d.opts('b', d.wtB, d.staged('b', d.wtB, go)));
  assert.equal(d.mainLock()?.run, b.run);
  fs.writeFileSync(go, 'go');
  d.ends(b.run);
  assert.equal(d.mainLock(), null);
});

// CIRED-7b3d67d (CI Linux, main 7b3d67d): a 4 s machine stall let a fill's sweep mark the running first MERGE `lost`; its supervisor
// lived on, its `end` was refused (lost, not running) and it exited WITHOUT freeing the main lock or filling - the queued MERGE waited
// for ever (until the lock went stale and someone else filled). The sweep is simulated here by a clock 60 s ahead.
test('a MERGE run swept lost while its supervisor lives: its exit still frees the main lock and the fill starts the waiting MERGE', () => {
  const d = sandbox();
  const goA = path.join(d.t, 'go-a'), goB = path.join(d.t, 'go-b');
  const a = startRun(d.opts('a', d.wtA, d.staged('a', d.wtA, goA)));
  const q = startRun(d.opts('b', d.wtB, d.staged('b', d.wtB, goB), { queue: true }));
  assert.ok(q.queued);
  waitForSync(() => JSON.parse(fs.readFileSync(path.join(d.state, 'hb', a.run + '.hb'), 'utf8')).pid, { producer: supervisorAlive(d.state, () => d.item(a.run)), what: `${a.run} beats` });
  assert.deepEqual(sweepLost(d.state, { staleMs: 3000, by: 'launcher', now: () => new Date(Date.now() + 60000) }), [a.run]);
  assert.equal(d.item(a.run).state, 'lost');
  assert.equal(d.mainLock()?.run, a.run, 'the lost run\'s supervisor still holds the main lock');
  fs.writeFileSync(goA, 'go');
  d.ends(a.run);   // lost + its supervisor gone (the lost record names it): its exit tail is done
  assert.notEqual(d.mainLock()?.run, a.run, 'the lost run\'s exit frees the main lock');
  const bRun = d.filled(q.run);
  assert.ok(bRun, 'the lost run\'s exit fill starts the waiting MERGE');
  fs.writeFileSync(goB, 'go');
  d.ends(bRun.id);
  assert.equal(d.mainLock(), null);
});
