// GAP-6: `norn merge-land` - a MERGE run lands the merge it made in its own merge worktree (mergewt.mjs) on main. Code,
// not the worker: under a short per-repo lock (the ref update only, seconds) main moves to the merge by a FAST-FORWARD - a push
// to the remote's main (never a force) when the repo has that remote, else the local main ref. When main moved since the merge was
// made, main is merged into the merge worktree OUTSIDE the lock and the land is tried again (bounded): a conflict = nothing lands;
// with a merge gate (project merge.gate.cmd) the gate runs on the re-merged tree first, without one the worker re-tests (REMERGED).
// The owner's checkout is moved to the landed main only when it is clean, on main and no run holds it; otherwise it is left alone
// with a note (the remote has the merge; the owner pulls when ready).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeGit } from './dlvgit.mjs';
import { acquireLock, lockPath, RunRefused, STALE_MS } from './runs.mjs';
import { mergeConfig, branchWorktree } from './mergeq.mjs';
import { suiteMode } from './mergebrief.mjs';
import { landKey } from './mergewt.mjs';
import { inDir, gateText } from './monorepo.mjs';

const fwd = p => String(p || '').replace(/\\/g, '/');
const s7 = s => String(s || '').slice(0, 7);
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const LAND_ATTEMPTS = 3;
export const LAND_LOCK_WAIT_MS = 120000;
/** exit codes of norn merge-land: landed, nothing landed (STOPPED), main moved and was merged in - re-test, then land again */
export const LAND_EXIT = { landed: 0, conflict: 3, red: 3, blocked: 3, busy: 3, remerged: 4 };

// the land lock: one ref update per repo at a time; waits (polls) up to waitMs - a land holds it for seconds only
function landLock(locksDir, repo, { run, waitMs, staleMs }) {
  const end = Date.now() + waitMs;
  for (;;) {
    try { return acquireLock(locksDir, landKey(repo), { run, staleMs }); } catch (e) {
      if (!(e instanceof RunRefused) || Date.now() >= end) throw e;
      sleepSync(200);
    }
  }
}
/** the gate cmd run synchronously in cwd (cwd/<gate.dir>), its output to log; the env drops VIRTUAL_ENV and every META_* (as mergeq.runGate) */
export function runGateSync(gate, { cwd, log }) {
  const t0 = Date.now();
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'w');
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'VIRTUAL_ENV' && !k.startsWith('META_')));
    const r = spawnSync(gate.cmd, { cwd: inDir(cwd, gate.dir), shell: true, windowsHide: true, stdio: ['ignore', fd, fd], env, timeout: (gate.timeout_min ?? 30) * 60e3 });
    return { ok: r.status === 0 && !r.error, code: r.status ?? -1, ms: Date.now() - t0, timedOut: r.error?.code === 'ETIMEDOUT', log: fwd(log) };
  } finally { fs.closeSync(fd); }
}

/**
 * Move main's checked-out copy (or the bare ref) to sha by a fast-forward only. A checkout of main moves only when it is clean
 * (tracked files), and no run holds its worktree lock; else it is left as it is. Returns { ok, note }.
 */
export function advanceLocalMain(repo, sha, { main = 'main', locksDir = null, run = 'merge-land', staleMs = STALE_MS, git = makeGit() } = {}) {
  const local = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${main}`], { allowFail: true })?.trim() || null;
  if (local === sha) return { ok: true, note: `already at ${s7(sha)}` };
  if (local && git(repo, ['merge-base', '--is-ancestor', local, sha], { allowFail: true }) === null) return { ok: false, note: `local ${main} ${s7(local)} has commits the merge lacks: left alone` };
  const where = branchWorktree(repo, main, git);
  if (!where) {   // main checked out nowhere: the ref alone, compare-and-swap on the old value
    const r = git(repo, ['update-ref', '-m', `norn merge-land ${s7(sha)}`, `refs/heads/${main}`, sha, ...(local ? [local] : [])], { status: true });
    return r.code === 0 ? { ok: true, note: `${main} ref moved to ${s7(sha)}` } : { ok: false, note: `${main} ref moved meanwhile: left alone` };
  }
  const co = where.inMain ? repo : where.path;
  if (locksDir) {
    const cur = (() => { try { return JSON.parse(fs.readFileSync(lockPath(locksDir, co), 'utf8')); } catch { return null; } })();
    if (cur && cur.run !== run && !(Date.now() - Date.parse(cur.ts) > staleMs)) return { ok: false, note: `${fwd(co)} is held by ${cur.run ?? 'a writer'}: left at ${s7(local)}` };
  }
  const st = git(co, ['status', '--porcelain', '--untracked-files=no'], { allowFail: true });
  if (st === null) return { ok: false, note: `${fwd(co)}: git status failed: left alone` };
  if (st.trim()) return { ok: false, note: `${fwd(co)} has uncommitted changes: left at ${s7(local)}` };
  const m = git(co, ['merge', '--ff-only', '--quiet', sha], { status: true });
  return m.code === 0 ? { ok: true, note: 'updated', checkout: fwd(co) } : { ok: false, note: `${fwd(co)}: the fast-forward failed (exit ${m.code}): left at ${s7(local)}` };
}

/**
 * Land the merge worktree's HEAD on main. o: { repo, wt, main, remote, push (default true: push when the remote exists), gate ({cmd,
 * timeout_min, dir} | null), skipTests (policy merge.suite = skip: a clean re-merge lands untested), locksDir, run, attempts,
 * lockWaitMs, logDir, git }. Returns { status: landed | remerged | conflict | red | blocked | busy, sha?, pushed?, checkout?, attempts, why, gates }.
 */
export function landMerge(o) {
  const { repo, wt, main = 'main', remote = 'origin', locksDir, run = 'merge-land', gate = null, skipTests = false, attempts = LAND_ATTEMPTS,
    lockWaitMs = LAND_LOCK_WAIT_MS, staleMs = STALE_MS, logDir = null, git = makeGit() } = o;
  const hasRemote = o.push !== false && git(repo, ['remote', 'get-url', remote], { allowFail: true }) !== null;
  const gates = [], res = (status, why, x = {}) => ({ status, why, attempts: n, gates, ...x });
  const dirty = (git(wt, ['status', '--porcelain', '--untracked-files=no'], { allowFail: true }) ?? 'x').trim();
  let n = 0;
  if (dirty) return res('blocked', `the merge worktree ${fwd(wt)} has uncommitted changes (or is no git worktree): commit the merge first`);
  if (git(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true })) return res('blocked', `a merge is in progress in ${fwd(wt)}: commit or abort it first`);
  for (n = 1; n <= attempts; n++) {
    const head = git(wt, ['rev-parse', 'HEAD']).trim();
    let moved = null;
    const lock = landLock(locksDir, repo, { run, waitMs: lockWaitMs, staleMs });
    try {
      if (hasRemote) git(wt, ['fetch', '--quiet', remote, `+refs/heads/${main}:refs/remotes/${remote}/${main}`], { allowFail: true });
      const target = git(repo, ['rev-parse', '--verify', '--quiet', hasRemote ? `refs/remotes/${remote}/${main}` : `refs/heads/${main}`], { allowFail: true })?.trim() || null;
      if (target && git(repo, ['merge-base', '--is-ancestor', target, head], { allowFail: true }) === null) moved = target;
      else if (hasRemote) {
        const p = git(wt, ['push', '--quiet', remote, `${head}:refs/heads/${main}`], { status: true });   // a fast-forward push: never --force
        if (p.code !== 0) continue;   // the remote moved between the fetch and the push: fetch again (the finally frees the lock)
        git(wt, ['fetch', '--quiet', remote, `+refs/heads/${main}:refs/remotes/${remote}/${main}`], { allowFail: true });
        const co = advanceLocalMain(repo, head, { main, locksDir, run, staleMs, git });
        return res('landed', `pushed ${remote}/${main} = ${s7(head)}`, { sha: head, pushed: `${remote}/${main}`, checkout: co.note });
      } else {
        const co = advanceLocalMain(repo, head, { main, locksDir, run, staleMs, git });
        if (!co.ok) return res('blocked', `no ${remote} to push to and the local ${main} cannot move: ${co.note}`, { checkout: co.note });
        return res('landed', `${main} = ${s7(head)} (local; no ${remote} remote)`, { sha: head, pushed: null, checkout: co.note });
      }
    } finally { lock.release(); }
    if (!moved) continue;
    // main moved since the merge was made: merge it in here, outside the lock
    const m = git(wt, ['merge', '--no-edit', '-m', `merge: ${main} ${s7(moved)} into the merge (norn merge-land, attempt ${n})`, moved], { status: true });
    if (m.code !== 0) {
      git(wt, ['merge', '--abort'], { allowFail: true });
      return res('conflict', `${main} moved to ${s7(moved)} and merging it into the merge conflicts: aborted, nothing landed`);
    }
    const sha = git(wt, ['rev-parse', 'HEAD']).trim();
    if (skipTests) continue;
    if (!gate?.cmd) return res('remerged', `${main} moved to ${s7(moved)}: merged into the merge worktree at ${s7(sha)}, nothing landed yet - re-run the tests and the smoke, then land again`, { sha });
    const g = runGateSync(gate, { cwd: wt, log: path.join(logDir || path.join(wt, '..'), `${path.basename(wt)}-land-gate-${n}.log`) });
    gates.push(g);
    if (!g.ok) return res('red', `${main} moved to ${s7(moved)}; the gate \`${gateText(gate)}\` is RED on the re-merged tree ${s7(sha)} (log ${g.log}): nothing landed`, { sha });
  }
  return res('busy', `${main} kept moving: ${attempts} land attempts, nothing landed`);
}

/** the words of one land result (the CLI's line; the brief tells the worker what each first word means) */
export function landLine(r) {
  const head = { landed: 'LANDED', remerged: 'REMERGED' }[r.status] || 'NOT LANDED';
  const tail = r.status === 'landed' ? `; main checkout: ${r.checkout}` : '';
  return `${head}${r.sha && r.status === 'landed' ? ' ' + r.sha : ''}: ${r.why} (${r.attempts} attempt(s))${tail}`;
}

/** landMerge with a project's settings (project.json deliverables + merge gate + policy.merge.suite) */
export function landProject(p, { wt, locksDir, run, push, attempts, lockWaitMs, git } = {}) {
  const cfg = mergeConfig(p);
  return landMerge({ repo: cfg.repo, wt, main: cfg.main, remote: cfg.remote, gate: cfg.gate, skipTests: suiteMode(p) === 'skip', locksDir, run, push, attempts, lockWaitMs,
    logDir: p.state ? path.join(p.state, 'mq') : null, ...(git ? { git } : {}) });
}
