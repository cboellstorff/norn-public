// The instruction-file scan OFF the dash request path (a big project: 20-50 s) - a worker thread of the dash (workerData { project, machine,
// home }: the server's own project, machine and home, so a sandboxed dash never reads the real home). META-TEND P6 started it for
// the Guard; META-UX-BUILD S1: it is the ONE scan of the Instructions tab and the Guard. It posts the full view (its paragraphs as
// entries, a content hash) and keeps it at <state>/instructions-view.json, so a restarted dash answers at once from the last view.
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { instructionsView } from './instructions.mjs';

export const insViewFile = state => path.join(state, 'instructions-view.json');

/** one scan -> { at, hash, v, paras: [[row id, paragraphs]] }; written to the state (tmp + rename; a read-only state keeps none) */
export function insScan({ project, machine = null, home = '' }) {
  const v = instructionsView(project, { machine: machine?.claude ? machine : null, home, remember: true });   // META-PRACTICE-P1: findings fixed since the last scan
  const paras = [...v.paras], content = JSON.stringify({ v, paras }), at = new Date().toISOString();
  const h = createHash('sha256').update(content).digest('hex');
  if (project.state) {
    const f = insViewFile(project.state), tmp = `${f}.${process.pid}.tmp`;
    // a read-only or full state keeps no view: the dash serves this scan from memory, and a restart scans cold. A tmp file that
    // cannot be removed either keeps this pid's name, so this dash's next rebuild overwrites it.
    try { fs.writeFileSync(tmp, `{"at":${JSON.stringify(at)},"hash":"${h}",${content.slice(1)}`); fs.renameSync(tmp, f); }
    catch { fs.rmSync(tmp, { force: true, maxRetries: 0 }); }
  }
  return { at, hash: h, v, paras };
}

if (!isMainThread) {
  try { parentPort.postMessage({ ok: true, ...insScan(workerData) }); } catch (e) { parentPort.postMessage({ ok: false, error: String(e?.message || e) }); }
}
