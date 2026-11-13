// META-GTP-CI-FLAKES: a run's `end` record is NOT the end of its supervisor. After the record the supervisor still runs onRunDone,
// the ledger step, frees the lock, stops orphans, re-queues, FILLS THE QUEUE (under state/queue.lock) and spawns the tick - then
// exits. A test that acts on the state right after `end` races that tail (CI-LINUX FINDING L1: fillQueue returned [] because the
// supervisor's own fill held queue.lock). `settled(item)` = the run has ended AND its supervisor process (end.supervisor_pid) is gone:
// every side effect of the run's end has happened. A killed run has no end record: its supervisor has nothing left to do.
import fs from 'node:fs';

// alive = the process still runs. POSIX: an exited child the test process has not reaped yet (a zombie: its event loop was blocked,
// e.g. an Atomics.wait poll) still answers kill(pid, 0), so /proc/<pid>/stat state Z counts as gone. Windows: kill(pid, 0) checks
// the exit code (libuv), so an exited process is gone there.
export const alive = pid => {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }   // no /proc: kill(0) decides
};
// a run swept lost by a stall names its still-living supervisor in the lost record (CIRED-7b3d67d): it still frees + fills on its exit
export const settled = it => { const pid = it?.end?.supervisor_pid ?? it?.lost?.supervisor_pid; return !!it && !['running', 'queued'].includes(it.state) && !(pid && alive(pid)); };
