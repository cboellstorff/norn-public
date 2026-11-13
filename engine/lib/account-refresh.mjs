// The account-usage refresh OFF the dash request path (META-OPS-R3): a worker thread of the dash (workerData { projectsDir,
// cacheFile }) or the CLI `node engine/lib/account-refresh.mjs <projectsDir> <cacheFile>` (prints the result as JSON).
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { refreshAccountUsage } from './cost.mjs';

if (!isMainThread) {
  try { parentPort.postMessage({ ok: true, ...refreshAccountUsage(workerData) }); } catch (e) { parentPort.postMessage({ ok: false, error: String(e?.message || e) }); }
} else if (process.argv[2] && process.argv[3]) {
  console.log(JSON.stringify(refreshAccountUsage({ projectsDir: process.argv[2], cacheFile: process.argv[3] })));
}
