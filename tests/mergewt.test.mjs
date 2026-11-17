// GAP-6: merges no longer queue behind each other on the owner's checkout. Each MERGE run works in its own merge worktree
// (<state>/mq/merge-<lane>-<sha7>), up to policy.merge.parallel at once, and lands with `norn merge-land` (mergeland.mjs): a
// fast-forward of main under a short lock, a re-merge when main moved, never a force; the owner's checkout moves only when clean.
// Real temp git repos (a bare origin + its clone), the FAKE executor for the run tests; temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startRun, readiness, writeTrees, lockPath, mergeSpec, slotsFull } from '../engine/lib/runs.mjs';
import { renderMergeBrief, briefMarker } from '../engine/lib/mergebrief.mjs';
import { mergeWtPath, ensureMergeWorktree, slotKey, mergeParallel } from '../engine/lib/mergewt.mjs';
import { landMerge, landProject, landLine, advanceLocalMain } from '../engine/lib/mergeland.mjs';
import { holdWords } from '../engine/lib/plan.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { main as nornMain } from '../engine/bin/norn.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { fromTemplate } from './helpers/git-template.mjs';
import { waitForSync, supervisorAlive } from './helpers/wait.mjs';
import { settled } from './helpers/settled.mjs';

test.after(cleanTmp);
const tmp = p => mkTmp('meta-mwt-' + p + '-');
const fwd = p => String(p).replace(/\\/g, '/');
const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo, file, text, msg) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
  g(repo, 'add', file); g(repo, 'commit', '-q', '-m', msg);
  return g(repo, 'rev-parse', 'HEAD');
};
const LAND_MJS = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'lib', 'mergeland.mjs')).href;

// origin (bare) + co/repo (the owner's main checkout, on main): base.txt, pkg/gate.mjs (a monorepo folder's gate: red while a
// file named bad.txt is in the tree), feat/a (a.txt), feat/b (b.txt), feat/c (base.txt changed: conflicts with a main that changes it)
function buildRepo(root) {
  const origin = path.join(root, 'origin');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: GENV });
  const repo = path.join(root, 'co', 'repo');
  execFileSync('git', ['clone', '-q', origin, repo], { env: GENV, stdio: 'ignore' });
  g(repo, 'config', 'user.name', 't'); g(repo, 'config', 'user.email', 't@t'); g(repo, 'config', 'commit.gpgsign', 'false');
  g(repo, 'config', 'core.autocrlf', 'false');   // the tests' git (no system config) and Norn's (the machine's) must see one tree
  g(repo, 'checkout', '-q', '-b', 'main');
  commit(repo, 'base.txt', 'base\n', 'base');
  commit(repo, 'pkg/gate.mjs', "import fs from 'node:fs';\nprocess.exit(fs.existsSync('../bad.txt') ? 1 : 0);\n", 'the pkg gate');
  g(repo, 'push', '-q', '-u', 'origin', 'main');
  const tips = {};
  for (const [b, file, text] of [['feat/a', 'a.txt', 'a\n'], ['feat/b', 'b.txt', 'b\n'], ['feat/c', 'base.txt', 'c changes base\n']]) {
    g(repo, 'checkout', '-q', '-b', b, 'main');
    tips[b] = commit(repo, file, text, `${b} work`);
    g(repo, 'push', '-q', 'origin', b);
  }
  g(repo, 'checkout', '-q', 'main');
  return { origin, repo, tips };
}
const fixture = () => fromTemplate('mwt-repo', buildRepo, tmp('repo'));
const ORIGIN_MAIN = f => g(f.origin, 'rev-parse', 'main');
const onOrigin = (f, sha) => { try { g(f.origin, 'merge-base', '--is-ancestor', sha, 'main'); return true; } catch { return false; } };
// a merge worktree with branch b merged into main (what the worker's steps 1-5 make)
function merged(f, wt, b) {
  ensureMergeWorktree({ repo: f.repo, wt });
  g(wt, 'merge', '-q', '--no-ff', '-m', `merge: ${b}`, `origin/${b}`);
  return g(wt, 'rev-parse', 'HEAD');
}
// someone else lands on main meanwhile: a commit pushed to origin main from a scratch worktree
function mainMoves(f, file, text) {
  const wt = path.join(path.dirname(f.repo), 'mover-' + file.replace(/\W/g, ''));
  g(f.repo, 'fetch', '-q', 'origin');
  g(f.repo, 'worktree', 'add', '-q', '--detach', wt, 'origin/main');
  const sha = commit(wt, file, text, `main moves: ${file}`);
  g(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  g(f.repo, 'worktree', 'remove', '--force', wt);
  return sha;
}
const locksOf = f => path.join(path.dirname(f.repo), 'locks');

test('two lane branches merged concurrently in their own worktrees both land on main (two merge-land processes at once; never a force)', async () => {
  const f = fixture(), wtA = path.join(path.dirname(f.repo), 'mq', 'merge-a'), wtB = path.join(path.dirname(f.repo), 'mq', 'merge-b');
  merged(f, wtA, 'feat/a'); merged(f, wtB, 'feat/b');
  const base = ORIGIN_MAIN(f);
  const land = wt => new Promise((resolve, reject) => {
    const code = `import(${JSON.stringify(LAND_MJS)}).then(m => { const r = m.landMerge(${JSON.stringify({ repo: f.repo, wt, locksDir: locksOf(f), run: path.basename(wt), gate: { cmd: 'node -e "process.exit(0)"' }, logDir: path.dirname(wt) })}); process.stdout.write(JSON.stringify(r)); })`;
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env: GENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', errs = '';
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { errs += d; });
    c.on('exit', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error(`land ${wt}: ${errs || out}`)); } });
  });
  const [ra, rb] = await Promise.all([land(wtA), land(wtB)]);
  assert.equal(ra.status, 'landed', JSON.stringify(ra));
  assert.equal(rb.status, 'landed', JSON.stringify(rb));
  const tip = ORIGIN_MAIN(f);
  assert.ok(onOrigin(f, f.tips['feat/a']) && onOrigin(f, f.tips['feat/b']), 'both lanes are on origin main');
  assert.ok([ra.sha, rb.sha].includes(tip), 'main is the later land');
  g(f.origin, 'merge-base', '--is-ancestor', base, tip);   // main only moved forward
  assert.equal([ra, rb].filter(r => r.attempts > 1).length, 1, 'exactly one of them found main moved and merged it in before landing');
  // the owner's checkout was clean and on main: it moved with the lands (fast-forward), and its tree has both files
  g(f.repo, 'merge-base', '--is-ancestor', ra.sha, 'main');
  assert.ok(fs.existsSync(path.join(f.repo, 'a.txt')) && fs.existsSync(path.join(f.repo, 'b.txt')));
});

test('main moved under the merge: with a gate the land merges main in, gates the tree (monorepo folder) and lands; without one it says REMERGED, the next land lands', () => {
  const f = fixture(), wt = path.join(path.dirname(f.repo), 'mq', 'merge-a');
  merged(f, wt, 'feat/a');
  const moved = mainMoves(f, 'm1.txt', 'm1\n');
  // a monorepo project (subdir pkg): the merge is whole-repo, the gate runs from <tree>/pkg
  const P = { name: 'mono', root: fwd(f.repo), subdir: 'pkg', state: fwd(path.join(path.dirname(f.repo), 'st')), merge: { gate: { cmd: 'node gate.mjs', timeout_min: 2 } }, policy: {} };
  const r = landProject(P, { wt, locksDir: locksOf(f), run: 'RUN-1' });
  assert.equal(r.status, 'landed', JSON.stringify(r));
  assert.equal(r.attempts, 2);
  assert.equal(r.gates.length, 1);
  assert.ok(r.gates[0].ok);
  assert.ok(onOrigin(f, moved) && onOrigin(f, f.tips['feat/a']));
  assert.match(landLine(r), /^LANDED [0-9a-f]{40}: pushed origin\/main = .* \(2 attempt\(s\)\); main checkout: updated$/);
  // no gate: REMERGED (exit 4 at the CLI) - the worker re-tests; its next land lands
  const wt2 = path.join(path.dirname(f.repo), 'mq', 'merge-b');
  merged(f, wt2, 'feat/b');
  mainMoves(f, 'm2.txt', 'm2\n');
  const r1 = landMerge({ repo: f.repo, wt: wt2, locksDir: locksOf(f), run: 'RUN-2' });
  assert.equal(r1.status, 'remerged', JSON.stringify(r1));
  assert.equal(onOrigin(f, f.tips['feat/b']), false, 'nothing landed on REMERGED');
  const r2 = landMerge({ repo: f.repo, wt: wt2, locksDir: locksOf(f), run: 'RUN-2' });
  assert.equal(r2.status, 'landed');
  assert.ok(onOrigin(f, f.tips['feat/b']));
  // a red gate on the re-merged tree lands nothing
  const wt3 = path.join(path.dirname(f.repo), 'mq', 'merge-c');
  ensureMergeWorktree({ repo: f.repo, wt: wt3 });
  commit(wt3, 'c3.txt', 'x\n', 'merge c3');
  mainMoves(f, 'bad.txt', 'red\n');
  const before = ORIGIN_MAIN(f), r3 = landProject(P, { wt: wt3, locksDir: locksOf(f), run: 'RUN-3' });
  assert.equal(r3.status, 'red', JSON.stringify(r3));
  assert.equal(ORIGIN_MAIN(f), before, 'a red gate leaves main where it was');
});

test('a conflicting merge ends without touching main: the re-merge conflicts -> NOT LANDED, aborted, origin and the local main unchanged', () => {
  const f = fixture(), wt = path.join(path.dirname(f.repo), 'mq', 'merge-c');
  merged(f, wt, 'feat/c');
  const moved = mainMoves(f, 'base.txt', 'main changes base too\n');
  g(f.repo, 'pull', '-q', '--ff-only', 'origin', 'main');
  const local = g(f.repo, 'rev-parse', 'main');
  const r = landMerge({ repo: f.repo, wt, locksDir: locksOf(f), run: 'RUN-1', gate: { cmd: 'node -e "process.exit(0)"' } });
  assert.equal(r.status, 'conflict', JSON.stringify(r));
  assert.match(landLine(r), /^NOT LANDED: main moved to [0-9a-f]{7} and merging it into the merge conflicts: aborted, nothing landed/);
  assert.equal(ORIGIN_MAIN(f), moved, 'origin main untouched');
  assert.equal(g(f.repo, 'rev-parse', 'main'), local, 'the local main untouched');
  assert.equal(onOrigin(f, f.tips['feat/c']), false);
  assert.equal(g(wt, 'status', '--porcelain'), '', 'the merge was aborted: the merge worktree is clean');
  // the CLI's exit code for it is 3 (STOPPED in the brief)
  const pf = path.join(path.dirname(f.repo), 'project.json');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'mwt', title: 'm', root: fwd(f.repo), ledger: '${root}/L.md', briefs_dir: '${root}', policy: {} }));
  const out = [], err = [];
  const code = nornMain(['merge-land', '--project', pf, '--worktree', wt, '--locks', locksOf(f)], { META_ROOT: fwd(path.dirname(f.repo)) }, s => out.push(s), s => err.push(s));
  assert.equal(code, 3, out.join('\n') + err.join('\n'));
  assert.match(out.join('\n'), /^NOT LANDED: /);
});

test("the owner's dirty main checkout is never modified: the merge lands on origin, the checkout stays as it was; without a remote nothing lands", () => {
  const f = fixture(), wt = path.join(path.dirname(f.repo), 'mq', 'merge-a');
  merged(f, wt, 'feat/a');
  fs.writeFileSync(path.join(f.repo, 'base.txt'), 'the owner is editing\n');
  const head = g(f.repo, 'rev-parse', 'HEAD'), status = g(f.repo, 'status', '--porcelain');
  const r = landMerge({ repo: f.repo, wt, locksDir: locksOf(f), run: 'RUN-1' });
  assert.equal(r.status, 'landed');
  assert.ok(onOrigin(f, f.tips['feat/a']));
  assert.match(r.checkout, /has uncommitted changes: left at/);
  assert.equal(g(f.repo, 'rev-parse', 'HEAD'), head, 'HEAD unchanged');
  assert.equal(g(f.repo, 'rev-parse', 'refs/heads/main'), head, 'the main ref of the checked-out branch unchanged');
  assert.equal(g(f.repo, 'status', '--porcelain'), status);
  assert.equal(fs.readFileSync(path.join(f.repo, 'base.txt'), 'utf8'), 'the owner is editing\n');
  assert.equal(fs.existsSync(path.join(f.repo, 'a.txt')), false);
  // a checkout another run holds (its worktree lock) is left alone too, even clean
  fs.writeFileSync(path.join(f.repo, 'base.txt'), 'base\n');
  fs.mkdirSync(locksOf(f), { recursive: true });
  fs.writeFileSync(lockPath(locksOf(f), f.repo), JSON.stringify({ run: 'RUN-9', pid: 1, ts: new Date().toISOString() }));
  assert.match(advanceLocalMain(f.repo, r.sha, { locksDir: locksOf(f), run: 'RUN-1' }).note, /held by RUN-9/);
  assert.equal(g(f.repo, 'rev-parse', 'HEAD'), head);
  fs.unlinkSync(lockPath(locksOf(f), f.repo));
  // no remote (--no-push): the local main is the target; the dirty checkout of it blocks the land - nothing moves
  const wt2 = path.join(path.dirname(f.repo), 'mq', 'merge-b');
  merged(f, wt2, 'feat/b');
  fs.writeFileSync(path.join(f.repo, 'base.txt'), 'dirty again\n');
  const r2 = landMerge({ repo: f.repo, wt: wt2, locksDir: locksOf(f), run: 'RUN-2', push: false });
  assert.equal(r2.status, 'blocked', JSON.stringify(r2));
  assert.equal(g(f.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(f.repo, 'base.txt'), 'utf8'), 'dirty again\n');
  // clean again: the local land fast-forwards the checkout
  fs.writeFileSync(path.join(f.repo, 'base.txt'), 'base\n');
  const r3 = landMerge({ repo: f.repo, wt: wt2, locksDir: locksOf(f), run: 'RUN-2', push: false });
  assert.equal(r3.status, 'landed', JSON.stringify(r3));
  assert.equal(r3.checkout, 'updated');
  assert.equal(g(f.repo, 'rev-parse', 'HEAD'), r3.sha);
});

// ---------- the runs: the merge worktree, the slots, the cleanup (FAKE executor) ----------
function runBox() {
  const f = fixture(), t = path.dirname(f.repo);
  const d = { f, t, state: path.join(t, 'state', 'mwt'), locks: path.join(t, 'state', 'locks') };
  fs.mkdirSync(d.state, { recursive: true });
  d.P = { name: 'mwt', root: fwd(f.repo), state: fwd(d.state), meta: '/m', deliverables: { main: 'main' }, policy: {} };
  d.brief = (lane, sha, until, mode = 'done') => {
    const b = path.join(t, `merge-${lane}.md`);
    fs.writeFileSync(b, renderMergeBrief(d.P, { lane, branch: `feat/${lane}`, worktree: fwd(path.join(t, 'wt-' + lane)), notes: fwd(path.join(t, `${lane}-NOTES.md`)), sha }) + `mode: ${mode}\nuntil: ${fwd(until)}\n`);
    return b;
  };
  // --worktree names the lane worktree as the check-in's run line does (lane_defaults): the brief's merge worktree wins
  d.opts = (lane, brief, o = {}) => ({ state: d.state, locksDir: d.locks, executor: 'fake', lane, worktree: path.join(t, 'wt-' + lane), brief, stage: 'MERGE', notes: path.join(t, `${lane}-NOTES.md`),
    tick: null, hbMs: 150, staleMs: 3000, policy: { auto_resume_max: 0 }, budget: {}, main_checkout: f.repo, ...o });
  d.item = id => loadState(d.state).items[id];
  d.filled = qid => Object.values(loadState(d.state).items).find(x => x.kind === 'run' && x.data.from_queue === qid) || null;
  d.ends = id => waitForSync(() => settled(d.item(id)), { producer: supervisorAlive(d.state, () => d.item(id)), what: `${id} ends` });
  return d;
}

test('the brief: an isolated merge names its merge worktree and merge-land, the marker carries no main checkout; parallel 0 = the old brief', () => {
  const d = runBox(), sha = d.f.tips['feat/a'];
  const text = renderMergeBrief(d.P, { lane: 'a', branch: 'feat/a', worktree: '/w/a', notes: '/n/a.md', sha });
  const m = briefMarker(text), wt = mergeWtPath(d.state, 'a', sha);
  assert.equal(m.merge_wt, wt);
  assert.match(wt, /\/mq\/merge-a-[0-9a-f]{7}$/);
  assert.equal(m.main, undefined, 'no main checkout lock');
  assert.equal(m.slots, 2);
  assert.ok(text.includes(`git -C ${wt} merge --no-ff --no-commit ${sha}`));
  assert.ok(text.includes(`merge-land --project <project.json> --worktree ${wt}`));
  assert.ok(!text.includes(`git -C ${fwd(d.f.repo)} merge`), 'never merges in the owner checkout');
  const rb = renderMergeBrief(d.P, { lane: 'a', branch: 'feat/a', worktree: '/w/a', notes: '/n/a.md' });
  assert.equal(briefMarker(rb).mode, 'rebase');
  assert.ok(rb.includes(`git -C ${mergeWtPath(d.state, 'a')} merge --no-ff`));
  const old = renderMergeBrief({ ...d.P, policy: { merge: { parallel: 0 } } }, { lane: 'a', branch: 'feat/a', worktree: '/w/a', notes: '/n/a.md', sha });
  assert.equal(briefMarker(old).main, fwd(d.f.repo));
  assert.equal(briefMarker(old).merge_wt, undefined);
  assert.throws(() => mergeParallel({ policy: { merge: { parallel: -1 } } }), /policy\.merge\.parallel/);
  // writeTrees: the merge worktree only (mergeSpec makes it the run's); a rebase brief also the lane worktree
  const b = d.brief('a', sha, '/never');
  assert.deepEqual(writeTrees(mergeSpec(d.opts('a', b))).map(fwd), [wt]);
  const rbf = path.join(d.t, 'rb.md'); fs.writeFileSync(rbf, rb);
  assert.deepEqual(writeTrees(mergeSpec(d.opts('a', rbf))).map(fwd), [mergeWtPath(d.state, 'a'), '/w/a']);
  assert.equal(holdWords('merge slots full: 2 merge(s) running in /r (RUN-1, RUN-2; policy.merge.parallel 2)'), 'waits for a merge slot (2 merges running)');
});

test('MERGE runs: two start at once (policy.merge.parallel 2) in their own merge worktrees, the third waits for a slot; ends remove the worktrees; the owner checkout is never locked', () => {
  const d = runBox(), go = l => path.join(d.t, 'go-' + l);
  const shaA = d.f.tips['feat/a'], shaB = d.f.tips['feat/b'], shaC = d.f.tips['feat/c'];
  // a leftover of a crashed merge: swept by the next isolated start
  const left = mergeWtPath(d.state, 'old', 'abcdef1');
  ensureMergeWorktree({ repo: d.f.repo, wt: left });
  const a = startRun(d.opts('a', d.brief('a', shaA, go('a'))));
  assert.equal(fs.existsSync(left), false, 'the leftover merge worktree was swept');
  const b = startRun(d.opts('b', d.brief('b', shaB, go('b'), 'stopped')));
  const wtA = mergeWtPath(d.state, 'a', shaA), wtB = mergeWtPath(d.state, 'b', shaB);
  assert.equal(fwd(d.item(a.run).data.worktree), wtA);
  assert.ok(fs.existsSync(path.join(wtA, 'base.txt')) && fs.existsSync(path.join(wtB, 'base.txt')), 'both merge worktrees exist, checked out at main');
  assert.equal(g(wtA, 'rev-parse', 'HEAD'), g(d.f.repo, 'rev-parse', 'origin/main'));
  assert.equal(fs.existsSync(lockPath(d.locks, d.f.repo)), false, 'no MERGE run holds the owner checkout');
  assert.ok(fs.existsSync(lockPath(d.locks, slotKey(fwd(d.f.repo), 0))) && fs.existsSync(lockPath(d.locks, slotKey(fwd(d.f.repo), 1))));
  // the third: refused without --queue (exit 3), queued with it, waiting on the slots
  const cb = d.brief('c', shaC, go('c'));
  assert.throws(() => startRun(d.opts('c', cb)), e => e.code === 3 && /merge slots full: 2 merge/.test(e.message));
  assert.equal(fs.existsSync(mergeWtPath(d.state, 'c', shaC)), false, 'a refused start makes no worktree');
  const q = startRun(d.opts('c', cb, { queue: true }));
  assert.ok(q.queued);
  assert.match(q.why, /merge slots full/);
  const row = readiness(d.state, { resources: () => ({ free_gb: 64, cpu_pct: 1 }) }).find(r => r.id === q.run);
  assert.ok(row.terms.some(x => /^merge slots full: 2 merge\(s\) running .*RUN-\d+, RUN-\d+/.test(x)), row.terms.join('; '));
  // b ends STOPPED (its merge conflicted, say): its worktree goes, main untouched, and its exit's fill starts c
  const mainBefore = ORIGIN_MAIN(d.f);
  fs.writeFileSync(go('b'), 'go');
  d.ends(b.run);
  assert.equal(d.item(b.run).end.outcome, 'stopped');
  assert.equal(fs.existsSync(wtB), false, `a STOPPED merge removes its worktree; log: ${fs.readFileSync(d.item(b.run).data.log, 'utf8').slice(-1500)}`);
  assert.equal(ORIGIN_MAIN(d.f), mainBefore);
  const c = d.filled(q.run);
  assert.ok(c, 'the freed slot started the waiting merge');
  assert.ok(fs.existsSync(mergeWtPath(d.state, 'c', shaC)));
  for (const l of ['a', 'c']) fs.writeFileSync(go(l), 'go');
  d.ends(a.run); d.ends(c.id);
  assert.equal(fs.existsSync(wtA), false, 'a DONE merge removes its worktree');
  assert.equal(fs.existsSync(mergeWtPath(d.state, 'c', shaC)), false);
  assert.equal(slotsFull(mergeSpec(d.opts('c', cb)), 3000), null, 'every slot is free again');
  assert.equal(g(d.f.repo, 'worktree', 'list').split('\n').length, 1, 'git knows no merge worktree any more');
});
