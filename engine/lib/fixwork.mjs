// Slop > In progress: what is being worked on for slop, the way the Lanes tab shows a lane - each Fix all send followed through its
// steps (sent -> the fixer run -> its drafted changes -> the owner's review -> applying -> done), and the slop merge holds.
// The fixer's result card (the Fix all design's "slice 7", missing until now: a send ended with the drafts in a NOTES file nobody
// was shown) = its hunks, parsed like an audit's (audit.mjs auditHunks), each decided with the audit decision shape, so accept /
// decline per hunk and "apply all" share one record path. Nothing here edits a file: an accept is a directive the check-in applies.
import { auditHunks, WATCH_RUNS } from './audit.mjs';
import { readText as readTextS } from './fsnap.mjs';

const readText = f => { try { return readTextS(f); } catch { return null; } };
const ts = x => String(x ?? '');
export const FIX_STEPS = [['sent', 'Sent'], ['fixer', 'Fixer run'], ['review', 'Your review'], ['applying', 'Applying'], ['done', 'Done']];

/** the runs that worked a Fix all send: a non-check-in run whose brief names the send's directive or decision (the check-in briefs
 *  the fixer from the directive: "# DIR-8 docs fixer (DEC-1: fix all)"), oldest first */
export function fixerRuns(items, send) {
  const ids = [send.directive, send.id].filter(Boolean);
  const re = new RegExp(`\\b(${ids.map(x => x.replace(/[-]/g, '\\-')).join('|')})\\b`);
  return Object.values(items).filter(i => i.kind === 'run' && i.data?.kind !== 'checkin' && i.data?.brief && ts(i.created) >= ts(send.created))
    .filter(r => re.test((readText(r.data.brief) || '').slice(0, 800)))
    .sort((a, b) => ts(a.created).localeCompare(ts(b.created)));
}

/** the accept directive of hunks: the check-in applies them (each as written), then marks the send's directive done */
export function applyText(send, run, hunks) {
  const head = `Apply ${hunks.length} drafted change(s) of Fix all ${send.id} (fixer ${run.id}, its notes ${run.data.notes}), each hunk as written, one commit per file; skip a hunk that no longer applies and say so in the ledger. When every decided hunk is applied, mark ${send.directive} done (norn rec done ${send.directive}). The next ${WATCH_RUNS} runs are watched for a failure a change might cause. Hunks:`;
  let txt = head;
  for (const h of hunks) {
    const one = `\n- ${h.id} ${h.path}:${h.line}\n${String(h.fix.patch).trimEnd()}`;
    if (txt.length + one.length > 3800) { txt += `\n- and ${hunks.length - hunks.indexOf(h)} more: their ids ${hunks.slice(hunks.indexOf(h)).map(x => x.id).join(' ')} (patches in the fixer's notes)`; break; }
    txt += one;
  }
  return txt;
}

/**
 * The In progress view of one project: { sends [{ id, directive, n, at, state, step, steps, runs, hunks?, counts, holds? }], holds, counts }.
 * p: { state, root }; items: the records fold; holds: the slop merge holds (server guardOf), [{ branch, run, lane, blocks }]
 */
export function fixWork(p, items, { holds = [] } = {}) {
  const all = Object.values(items);
  const sends = all.filter(i => i.kind === 'decision' && i.data?.lane === 'fixall').map(dec => {
    const dir = all.find(i => i.kind === 'directive' && i.data?.fixall === dec.id);
    const send = { id: dec.id, directive: dir?.id ?? null, created: dec.created };
    const runs = fixerRuns(items, send);
    const last = runs.at(-1);
    // its drafts are the fixer's notes only when they name this send (a lane's notes reused by a later fixer are an earlier send's)
    const ids = new RegExp(`\\b(${[send.directive, send.id].filter(Boolean).join('|')})\\b`);
    const own = last?.data?.notes ? ids.test((readText(last.data.notes) || '').slice(0, 800)) : false;
    const hunks = last && last.state === 'exited' && last.end?.outcome === 'done' && own ? auditHunks(last, p, items) : [];
    const n = s => hunks.filter(h => h.status === s).length;
    const counts = { hunks: hunks.length, open: n('open'), accepted: n('accepted'), declined: n('declined') };
    const applyDirs = all.filter(i => i.kind === 'directive' && i.data?.fixall_apply === dec.id);
    const applying = applyDirs.some(d => d.state === 'active');
    // the step it is on: done (its directive closed) > applying (an apply directive open) > review (drafts waiting) > fixer > sent
    const step = !dir || dir.state !== 'active' ? 'done' : applying || (hunks.length && !counts.open && counts.accepted) ? 'applying'
      : counts.open ? 'review' : last ? 'fixer' : 'sent';
    const runState = !last ? null : last.state === 'exited' ? (last.end?.outcome ?? 'ended') : last.state;
    const words = {
      sent: 'waiting for the next check-in to start the fixer run',
      fixer: last && last.state !== 'exited' ? `${last.id} is drafting the changes` : last && !own && last.end?.outcome === 'done' ? `${last.id} ended without drafting anything for this send (its notes are another send's): send these findings again`
        : last ? `${last.id} ended ${runState}${hunks.length ? '' : ' with no drafted change found in its notes'}` : '',
      review: `${counts.open} drafted change${counts.open === 1 ? '' : 's'} wait${counts.open === 1 ? 's' : ''} for you: apply them, or keep the text as it is`,
      applying: `the check-in applies the ${counts.accepted} accepted change(s)${applyDirs.length ? ` (${applyDirs.map(d => d.id).join(', ')})` : ''}`,
      done: dir ? `${dir.id} ${dir.state}` : 'no directive',
    };
    // failed: its fixer ended and drafted nothing for it - its findings are free to send again (server fixSent)
    const failed = !!(last && last.state === 'exited' && !hunks.length);
    return { id: dec.id, failed, directive: dir?.id ?? null, directive_state: dir?.state ?? null, n: (dec.data.findings || []).length, at: dec.created,
      question: dec.data.question, step, line: words[step], steps: FIX_STEPS.map(([k, label]) => ({ key: k, label })),
      runs: runs.map(r => ({ id: r.id, lane: r.data.lane, state: r.state, outcome: r.end?.outcome ?? null, created: r.created, model: r.data.model ?? null, notes: r.data.notes ?? null })),
      run: last?.id ?? null, notes: last?.data?.notes ?? null, counts,
      hunks: hunks.map(h => ({ id: h.id, path: h.path, line: h.line, severity: h.severity, why: h.why, status: h.status, patch: h.fix.patch })),
      applies: applyDirs.map(d => ({ id: d.id, state: d.state })) };
  }).sort((a, b) => ts(b.at).localeCompare(ts(a.at)));
  const live = sends.filter(s => s.step !== 'done');
  return { sends, holds, counts: { live: live.length, review: sends.filter(s => s.step === 'review').reduce((n, s) => n + s.counts.open, 0), holds: holds.length, done: sends.length - live.length } };
}
