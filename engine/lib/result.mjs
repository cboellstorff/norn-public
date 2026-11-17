// The run RESULT file (gap #3): each run's own outcome, <state>/runs/<RUN-n>.result.json, written by the worker with `norn done`
// (the supervisor passes its path as META_RESULT). The NOTES end marker of a lane is shared prose reused across runs (a run that wrote
// nothing inherited an earlier "## DONE"); a result file names one run and is the outcome when present. The NOTES marker stays the
// fallback for a worker / harness that does not write it. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';

export const RESULT_OUTCOMES = ['done', 'stopped', 'handoff'];
export const resultPath = (state, run) => path.join(state, 'runs', `${run}.result.json`);
const RUN_ID = /^RUN-\d+$/;
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();

export class ResultError extends Error { constructor(msg) { super(msg); this.code = 2; } }

/** the NOTES-style line of a result (consumers read marker_line: a MERGE's "## STOPPED: reverted ...") */
export const resultLine = r => (r.outcome === 'stopped' ? `## STOPPED: ${r.why}` : `## ${r.outcome.toUpperCase()}`);

/** validate { run, outcome, why?, summary? } -> the record written; throws ResultError */
export function makeResult({ run, outcome = 'done', why, summary, at = new Date().toISOString() }) {
  if (!RUN_ID.test(String(run ?? ''))) throw new ResultError(`--run must be RUN-n (got ${JSON.stringify(run ?? null)})`);
  if (!RESULT_OUTCOMES.includes(outcome)) throw new ResultError(`--outcome must be ${RESULT_OUTCOMES.join(' | ')} (got ${JSON.stringify(outcome)})`);
  const w = oneLine(why), s = oneLine(summary);
  if (outcome === 'stopped' && !w) throw new ResultError('--outcome stopped needs --why "<why>"');
  if (outcome !== 'stopped' && w) throw new ResultError(`--why is for --outcome stopped only (use --summary for a ${outcome} run)`);
  return { v: 1, run, outcome, ...(w ? { why: w } : {}), ...(s ? { summary: s.slice(0, 2000) } : {}), at };
}

/** write a run's result file (atomic: tmp + rename); file = its path (resultPath). Returns the record. */
export function writeResult(file, fields) {
  const r = makeResult(fields);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(t, JSON.stringify(r) + '\n');
  fs.renameSync(t, file);
  return r;
}

/**
 * a run's result file -> { outcome, marker_line, why?, summary?, at } | { error } (present but unusable) | null (absent).
 * run = the run it must name; since (ms) = the run's start: a file older than that is not this run's (never expected: one file per run).
 */
export function readResult(file, { run, since } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let j;
  try { j = JSON.parse(text); } catch { return { error: 'not JSON' }; }
  if (!j || typeof j !== 'object') return { error: 'not an object' };
  if (run && j.run !== run) return { error: `names ${JSON.stringify(j.run ?? null)}, not ${run}` };
  if (!RESULT_OUTCOMES.includes(j.outcome)) return { error: `outcome ${JSON.stringify(j.outcome ?? null)}` };
  if (j.outcome === 'stopped' && !oneLine(j.why)) return { error: 'stopped without a why' };
  const at = Date.parse(j.at);
  if (since && !(at >= since - 2000)) return { error: `written ${j.at ?? '(no time)'}, before this run started` };
  return { outcome: j.outcome, marker_line: resultLine(j), ...(j.outcome === 'stopped' ? { why: oneLine(j.why) } : {}), ...(j.summary ? { summary: oneLine(j.summary) } : {}), at: j.at };
}
