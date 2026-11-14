// META-TEND P6: the Guard's instruction-file scan OFF the dash request path (a big project: ~18 s cold) - a worker thread of the dash
// (workerData { project, machine, home }: the server's own project, machine and home, so a sandboxed dash never reads the real
// home). Posts the slim part the Guard reads: the findings, the rule ledger's advisories + counts, the rows' ids and paths.
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { instructionsView } from './instructions.mjs';

export function guardScan({ project, machine = null, home = '' }) {
  const v = instructionsView(project, { machine: machine?.claude ? machine : null, home });
  return { findings: v.findings || [], rules: { advisories: v.rules?.advisories || [], counts: v.rules?.counts ?? null }, rows: (v.rows || []).map(r => ({ id: r.id, path: r.path })) };
}

if (!isMainThread) {
  try { parentPort.postMessage({ ok: true, v: guardScan(workerData) }); } catch (e) { parentPort.postMessage({ ok: false, error: String(e?.message || e) }); }
}
