// META-TEST-PROCS (DEC-219, SPEC 9.6 PR-14): the processes whose command line names a (test's temp) dir.
import { listProcs } from './strays.mjs';

const norm = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
// a dir is named only where its last path segment ENDS (the next char cannot continue a file name), so ci-suite's parallel-2
// never names a process of parallel-25 or of a sibling parallel-2.old - includes() did (CI-RED R1 note).
const CONT = /[\w.~-]/;
const names = (cmd, d) => {
  for (let i = cmd.indexOf(d); i >= 0; i = cmd.indexOf(d, i + 1)) if (!CONT.test(cmd.charAt(i + d.length))) return true;
  return false;
};

/** procs (default: every process now) whose command line names one of dirs; never this process. -> [{ pid, name, cmd }] */
export function procsNaming(dirs, procs = listProcs()) {
  const ds = dirs.map(norm).filter(Boolean);
  if (!ds.length) return [];
  return procs.filter(p => p.pid !== process.pid && ds.some(d => names(norm(p.cmd), d))).map(({ pid, name, cmd }) => ({ pid, name, cmd }));
}
