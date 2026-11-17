// META-UX-BUILD S7 (REPORT meta-ux-plan s.3 "End to end" 3-5, DIR-65 Q2 A): the fixer run of a Fix all directive. An ACTIVE directive a
// Send wrote (data.fixall = its decision) with no fixer run gets ONE queued docs-class run, started by code (the tick spawns
// `norn fix start DIR-n --queue`, the merge queue's pattern) through the normal queue: caps, slots, the weekly stop and the rate cap.
// The run is the audit's kind of run (read-only, its final message = its notes file) with a GENERATED brief: the ids, each finding's
// fix sentence / patch / picked way, its file + line. It answers in the audit format (audit.mjs parseAudit: hunks) plus one line per
// finding: drafted, or skipped and why. A run takes at most policy.fixer.batch findings; a Send approves ceil(n / batch) runs, never
// more (decision.data.runs; a decision without it approved ONE run). Node built-ins only.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseAudit } from './audit.mjs';

export const FIX_LANE = 'fixall';
export const fixerDir = state => path.join(state, 'fixer');
const fwd = p => String(p ?? '').replace(/\\/g, '/');
const byCreated = (a, b) => String(a.created).localeCompare(String(b.created));

/** the batch size of one fixer run (policy.fixer.batch, defaults in policy.mjs) */
export const fixBatch = pol => Math.max(1, Number(pol?.fixer?.batch) || 40);
/** the runs a send of n findings needs */
export const runsFor = (n, batch) => Math.max(1, Math.ceil(n / batch));

/** the fixer runs of directive id (oldest first): lane fixall, the brief named <DIR>-<stamp>.brief.md */
export const fixRuns = (items, id) => Object.values(items).filter(i => i.kind === 'run' && i.data?.lane === FIX_LANE && path.basename(fwd(i.data.brief)).startsWith(`${id}-`)).sort(byCreated);

/** the decisions on directive id's results (lane fixall-result: apply / skip / discard), oldest first */
const verdicts = (items, id) => Object.values(items).filter(i => i.kind === 'decision' && i.data?.lane === 'fixall-result' && i.data.directive === id).sort(byCreated);

/** a run's batch: the ids its brief names (the brief is the record of what ran) */
export const briefIds = text => [...String(text ?? '').matchAll(/^- id: (\S+)/gm)].map(m => m[1]);

/**
 * the plan of one fixall directive: { id, dec, ids, approved, runs, live, done (ids a run took), resolved (applied / skipped /
 * discarded), left (no run took them yet), next (the next run's batch, null = start nothing), more (runs the rest needs) }
 * readBrief(run) -> the brief text of a run (its batch)
 */
export function fixPlan(dir, items, { batch = 40, readBrief = () => '' } = {}) {
  const ids = dir.data.findings || [], dec = items[dir.data.fixall];
  const extra = Object.values(items).filter(i => i.kind === 'decision' && i.data?.lane === FIX_LANE && i.data.rest_of === dir.id && i.state === 'in-force');
  const approved = (Number(dec?.data?.runs) || 1) + extra.reduce((n, d) => n + (Number(d.data.runs) || 1), 0);
  const runs = fixRuns(items, dir.id), live = runs.find(r => ['queued', 'running', 'starting'].includes(r.state)) ?? null;
  const took = new Set(runs.filter(r => r.end?.outcome !== 'crash' && r.state !== 'cancelled').flatMap(r => briefIds(readBrief(r))));
  const resolved = new Set(verdicts(items, dir.id).flatMap(v => v.data.ids || []));
  const left = ids.filter(x => !took.has(x) && !resolved.has(x));
  const counted = runs.filter(r => r.end?.outcome !== 'crash' && r.state !== 'cancelled').length;
  const next = !live && dir.state === 'active' && left.length && counted < approved ? left.slice(0, batch) : null;
  return { id: dir.id, dec: dec?.id ?? null, ids, approved, runs: runs.map(r => r.id), live: live?.id ?? null, done: [...took], resolved: [...resolved], left, next, more: left.length ? runsFor(left.length, batch) : 0 };
}

/** the generated brief of one fixer run: the findings (id, file:line, fix sentence, patch, picked way) and the answer format */
export function fixerBrief({ project, dir, dec, rows, picks = [] }) {
  const way = r => picks.find(q => r.key && (q.key === r.key || q.key.split('|')[0] === r.key))?.way ?? null;
  const items = rows.map(r => [`- id: ${r.id}`, `  file: ${fwd(r.path)}${r.line ? `:${r.line}` : ''}`, `  finding: ${String(r.why ?? r.title ?? '').replace(/\s+/g, ' ').slice(0, 400)}`,
    r.action ? `  fix: ${String(r.action).replace(/\s+/g, ' ').slice(0, 300)}` : null, way(r) ? `  the owner picked: ${way(r)}` : null,
    r.patch ? `  patch (ready):\n${String(r.patch).split('\n').map(l => `    ${l}`).join('\n')}` : null].filter(Boolean).join('\n'));
  return [`# Fixer run - ${project}, ${dir} (approved by ${dec}): ${rows.length} finding(s)`, '',
    'You are READ-ONLY: draft every change, edit nothing. The owner applies your hunks on one result card (nothing lands before he taps Apply).',
    'Read each named file around its line, then write, as your FINAL message:',
    '1. For each file you change, one heading `### `path/to/file:line` - medium - rewrite` and a ```diff block (unified: --- a/<path>, +++ b/<path>, @@ -l,n +l,m @@ hunks) with the exact new text.',
    '2. A list `## Findings` with ONE line per finding below: `- <id>: drafted` or `- <id>: skipped: <why>` (a your-call finding without a picked way, a fix you cannot make safely).',
    'Keep every unrelated line as it is. Never touch a file the list does not name.', '', '## The findings', '', ...items, ''].join('\n');
}

/** a fixer run's final message -> { hunks (parseAudit's, with id = a hash of the patch), status [{ id, state drafted|skipped, why }], failed } */
export function fixResult(text, ids) {
  const { hunks } = parseAudit(text), t = String(text ?? '').replace(/\r\n/g, '\n');
  const status = ids.map(id => {
    const m = t.match(new RegExp(`^\\s*[-*]\\s*\`?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`?\\s*:\\s*(drafted|skipped)\\b:?\\s*(.*)$`, 'mi'));
    return { id, state: m ? m[1].toLowerCase() : 'missing', why: m?.[2]?.trim() || null };
  });
  return { hunks: hunks.map(h => ({ id: createHash('sha1').update(h.patch).digest('hex').slice(0, 12), file: h.file, line: h.line, patch: h.patch })), status, failed: hunks.length === 0 };
}
