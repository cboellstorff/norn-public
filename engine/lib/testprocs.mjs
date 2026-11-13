// META-TEST-PROCS (DEC-219, SPEC 9.6 PR-14): the processes whose command line names a (test's temp) dir.
import { listProcs } from './strays.mjs';

const norm = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** procs (default: every process now) whose command line names one of dirs; never this process. -> [{ pid, name, cmd }] */
export function procsNaming(dirs, procs = listProcs()) {
  const ds = dirs.map(norm).filter(Boolean);
  if (!ds.length) return [];
  return procs.filter(p => p.pid !== process.pid && ds.some(d => norm(p.cmd).includes(d))).map(({ pid, name, cmd }) => ({ pid, name, cmd }));
}
