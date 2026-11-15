// S9 cut-over: workers started by the OLD launcher (worker.ps1 / codex-impl.sh) keep running. Each one is a legacy RUN (imported by
// `norn migrate`, or adopted here for a launcher with no lane json, e.g. Codex) watched by ONE detached watcher (design 12, "a
// one-time watcher (pid + start time)"): while the pid is alive with the same process start time (Windows reuses pids) it refreshes
// the RUN heartbeat (Agents shows it, caps count it, the lost sweep spares it) and holds the worktree lock (one writer); at exit it
// records `end` (outcome = NOTES grammar when exit 0, as the supervisor) and spawns `norn tick --reason exit`. It never auto-resumes:
// the old worker-run.ps1 resume is switched off at the cut-over (old BUDGET.json) and a HANDOFF goes to the check-in (CHECKIN rule).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, loadState } from './records.mjs';
import { parseOutcome, hbPath, acquireLock, refreshLock, releaseLock, renameRetry, HB_MS } from './runs.mjs';
import { isMain } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const writeAtomic = (f, o) => { const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(o)); renameRetry(t, f); };

/** Process start time (ms since epoch) of a live pid, or null when it does not run. */
export function procStart(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return null; }
  const r = platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', windowsHide: true })
    : spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  const t = Date.parse((r.stdout || '').trim() + (platform === 'win32' ? '' : ' UTC'));
  return r.status === 0 && Number.isFinite(t) ? t : null;
}
// the same process: alive and created within 120 s of the recorded start (worker.ps1's pid-reuse rule)
export const sameProcess = (pid, startedMs, probe = procStart) => { const t = probe(pid); return t !== null && Math.abs(t - startedMs) < 120e3; };

/** Outcome of an ended legacy run: claude = lane json exit + NOTES grammar; codex = exit unknown, the final file's marker. */
export function legacyOutcome(spec) {
  if (spec.executor.startsWith('codex')) {
    const fin = read(spec.final);
    return fin === null ? { exit: null, outcome: 'crash', marker_line: null, error: 'no final file' } : { exit: null, ...parseOutcome(fin) };
  }
  const lane = spec.lane_file ? readJson(spec.lane_file) : null;
  const exit = Number.isInteger(lane?.exit) ? lane.exit : null;
  const m = parseOutcome(read(spec.notes));
  return exit === 0 ? { exit, ...m } : { exit, outcome: 'crash', marker_line: m.marker_line };
}

/**
 * Adopt running legacy RUNs: for each spec { run, pid, started (ISO), executor, worktree, notes?, lane_file?, final? } whose process is
 * still the same one, take the worktree lock, write the heartbeat and spawn the detached watcher. A spec without `run` is first
 * recorded as a new RUN start (by launcher, data.legacy true) - the Codex runs, which have no lane json to migrate.
 * o: { state, locksDir, specs, tick: [cmd] | null, probe?, spawnWatcher? }. Returns [{ run, adopted | skipped }].
 */
export function adoptLegacy(o) {
  const probe = o.probe || procStart, out = [];
  fs.mkdirSync(path.join(o.state, 'hb'), { recursive: true });
  for (const s of o.specs) {
    const startedMs = Date.parse(s.started);
    if (!sameProcess(s.pid, startedMs, probe)) { out.push({ run: s.run || null, skipped: `pid ${s.pid} not running (or reused)` }); continue; }
    let run = s.run;
    if (!run) run = record(o.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: s.executor.startsWith('codex') ? 'codex' : 'worker', project: s.project, lane: s.lane,
      executor: s.executor, model: s.model, worktree: s.worktree, brief: s.brief, notes: s.notes, log: s.log, final: s.final, pid: s.pid, started: s.started, legacy: true } }, { views: false }).id;
    const it = loadState(o.state).items[run];
    if (!it || it.state !== 'running') { out.push({ run, skipped: `${run} is ${it?.state ?? 'missing'}` }); continue; }
    let lockFile = null;
    if (s.worktree && o.locksDir) { try { lockFile = acquireLock(o.locksDir, s.worktree, { run, pid: s.pid }).file; } catch (e) { out.push({ run, note: `lock: ${e.message}` }); } }
    const spec = { ...s, run, state: path.resolve(o.state), lockFile, tick: o.tick ?? null, hbMs: o.hbMs ?? HB_MS, startedMs };
    const specFile = path.join(o.state, 'hb', `${run}.legacy.json`);
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 1));
    writeAtomic(hbPath(o.state, run), { run, pid: s.pid, supervisor_pid: null, legacy: true, ts: new Date().toISOString() });
    const w = (o.spawnWatcher || spawnWatcher)(specFile);
    out.push({ run, adopted: s.pid, watcher: w });
  }
  return out;
}
function spawnWatcher(specFile) {
  const c = spawn(process.execPath, [fileURLToPath(import.meta.url), specFile], { detached: true, stdio: 'ignore', windowsHide: true });
  c.unref();
  return c.pid;
}

/** The watcher body (detached). Polls every hbMs; ends the RUN once the process is gone. */
export async function watch(specFile, { probe = procStart, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  const { state, run } = spec;
  const supStarted = procStart(process.pid);   // the watcher is the run's supervisor: (pid, start time), as supervisor.mjs
  const hb = () => writeAtomic(hbPath(state, run), { run, pid: spec.pid, supervisor_pid: process.pid, supervisor_started: supStarted, legacy: true, ts: new Date().toISOString() });
  for (;;) {
    if (loadState(state).items[run]?.state !== 'running') return 'gone';  // killed / ended elsewhere: nothing to do
    if (!sameProcess(spec.pid, spec.startedMs, probe)) break;
    hb(); if (spec.lockFile) refreshLock(spec.lockFile, run, { pid: spec.pid });
    await sleep(spec.hbMs);
  }
  const data = { ...legacyOutcome(spec), pid: spec.pid, supervisor_pid: process.pid, supervisor_started: supStarted, legacy: true };
  try { record(state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data }); } catch { return 'gone'; }
  try { fs.unlinkSync(hbPath(state, run)); } catch { /* gone */ }
  if (spec.lockFile) releaseLock(spec.lockFile, run);
  if (spec.tick && !process.env.META_NO_TICK) { try { spawn(spec.tick[0], spec.tick.slice(1), { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* best effort */ } }
  return data.outcome;
}

if (isMain(import.meta.url)) watch(process.argv[2]).then(() => process.exit(0), () => process.exit(1));

/** Specs for the migrated legacy RUNs still running (S2 importer: data.legacy, pid, started; lane json = <laneDir>/<lane>.json). */
export function legacySpecs(state, laneDir) {
  return Object.values(loadState(state).items).filter(i => i.kind === 'run' && i.state === 'running' && i.data.legacy && i.data.pid)
    .map(i => ({ run: i.id, pid: i.data.pid, started: i.data.started, executor: i.data.executor || 'claude', lane: i.data.lane, worktree: i.data.worktree,
      notes: i.data.notes, final: i.data.final, log: i.data.log, lane_file: laneDir ? path.join(laneDir, `${i.data.lane}.json`) : undefined }));
}
