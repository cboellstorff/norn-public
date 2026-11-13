// NORN-WATCH S5 (DEC-683): every descendant of a run dies with the run. A tree walk at the end misses orphans (VISUAL-A2's shot tool
// left 20 headless Edge alive 10 h: their parents had exited), so membership is decided at birth:
//   Windows: the supervisor puts ITSELF in a named Job Object before it spawns the executor (jobguard.cs `hold`, KILL_ON_JOB_CLOSE);
//            every process born below it is in the job, parent alive or not. At its end `reap` kills all but the supervisor and
//            clears KILL_ON_JOB_CLOSE (its after-end spawns - tick, auto-resume - live on). The supervisor dying = the hold process
//            sees stdin EOF, its handle closes, the job kills the rest. An independent run started from inside (norn run / a queue
//            fill) breaks away (jobguard `spawn`, CREATE_BREAKAWAY_FROM_JOB); a helper of the run stays inside and dies with it.
//   POSIX:   the executor is its own process group (spawn detached); the end kills the group (setsid escapes: documented gap).
// The helper is C# compiled on first use with the csc.exe of .NET Framework 4 (every Windows 10 / 11; no native npm build), cached
// as <tmp>/meta-jobguard-<source sha>.exe. No csc / compile failure = null: the run goes on unguarded and says so in its log.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'jobguard.cs');
const CSC = ['Framework64', 'Framework'].map(f => path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe'));

/** the compiled helper's path (compiled once per source version), or null off Windows / without csc */
export function jobguardExe({ platform = process.platform, dir = os.tmpdir(), csc = CSC } = {}) {
  if (platform !== 'win32') return null;
  let src;
  try { src = fs.readFileSync(SRC); } catch { return null; }
  const exe = path.join(dir, `meta-jobguard-${crypto.createHash('sha256').update(src).digest('hex').slice(0, 12)}.exe`);
  if (fs.existsSync(exe)) return exe;
  const c = csc.find(f => fs.existsSync(f));
  if (!c) return null;
  const tmp = `${exe}.${process.pid}.tmp.exe`;
  const r = spawnSync(c, ['-nologo', '-optimize', `-out:${tmp}`, SRC], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0 || !fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch { /* none */ } return null; }
  try { fs.renameSync(tmp, exe); } catch { try { fs.unlinkSync(tmp); } catch { /* a racer won */ } }
  return fs.existsSync(exe) ? exe : null;
}

/** put `pid` (the caller) in a new named job; resolves { name, exe, proc } or { error } (never rejects) */
export function holdJob(pid, { exe = jobguardExe(), name = `meta-run-${pid}-${Date.now()}`, timeoutMs = 15000 } = {}) {
  if (!exe) return Promise.resolve({ error: 'no jobguard helper (not Windows, or no .NET Framework csc.exe)' });
  return new Promise(resolve => {
    let buf = '', done = false;
    const end = v => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    let proc;
    try { proc = spawn(exe, ['hold', String(pid), name], { detached: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); }
    catch (e) { return end({ error: e.message }); }
    const t = setTimeout(() => end({ error: 'jobguard hold timed out' }), timeoutMs);
    proc.on('error', e => end({ error: e.message }));
    proc.stdout.on('data', d => {
      buf += d;
      if (/^ok/m.test(buf)) { proc.stdout.removeAllListeners('data'); proc.stdout.destroy(); proc.unref(); end({ name, exe, proc }); }
      else if (/^err/m.test(buf)) end({ error: buf.trim() });
    });
  });
}

/** kill every process of the job but `keep`; KILL_ON_JOB_CLOSE off afterwards. Returns { killed: [pids] } or { error } */
export function reapJob(job, keep = process.pid) {
  if (!job?.name) return { error: job?.error || 'no job' };
  const r = spawnSync(job.exe, ['reap', job.name, String(keep)], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const m = /^reaped (\d+) ?([\d,]*)/m.exec(r.stdout || '');
  try { job.proc?.stdin?.end(); } catch { /* gone */ }
  return m ? { killed: m[2] ? m[2].split(',').map(Number) : [] } : { error: String(r.stdout || r.error?.message || `exit ${r.status}`).trim().slice(0, 200) };
}

// MSVCRT command-line quoting of one argument (CommandLineToArgvW rules)
export function winQuote(a) {
  if (a !== '' && !/[\s"]/.test(a)) return a;
  let out = '"', bs = 0;
  for (const ch of a) {
    if (ch === '\\') { bs++; continue; }
    if (ch === '"') { out += '\\'.repeat(bs * 2 + 1) + '"'; bs = 0; continue; }
    out += '\\'.repeat(bs) + ch; bs = 0;
  }
  return out + '\\'.repeat(bs * 2) + '"';
}

/** start exe + args OUTSIDE the caller's job (detached, no window). Returns { pid, breakaway } or null when it cannot (the caller
 * then spawns as before). */
export function spawnOutside(exePath, args, { cwd = process.cwd(), exe = jobguardExe() } = {}) {
  if (!exe) return null;
  const r = spawnSync(exe, ['spawn', cwd, [exePath, ...args].map(winQuote).join(' ')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const m = /^pid (\d+) (breakaway|inside)/m.exec(r.stdout || '');
  return m ? { pid: Number(m[1]), breakaway: m[2] === 'breakaway' } : null;
}

/** POSIX: kill the executor's process group (it was spawned detached = group leader) */
export function reapGroup(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return { killed: [] };
  try { process.kill(-pgid, 'SIGKILL'); return { killed: [pgid] }; } catch (e) { return e.code === 'ESRCH' ? { killed: [] } : { error: e.message }; }
}
