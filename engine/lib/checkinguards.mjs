// META-CHECKIN-GUARDS R1 (owner DIR-51): the two check-in moves the P4 replay found HARMFUL, refused in code - one pure function per
// kind, used by the engine at its door (runs.startRun / queueRun, records.record) AND by the replay grader (eval/checkin.scoreTick),
// so a stored replay move graded through a guard is exactly what the engine would do with it.
//   A busy  - a check-in's new run on a worktree with a LIVE writer, not chained behind that worktree's runs (exit 6).
//   B owner - a CHECK-IN's ruling (decision --answers Q-n) of an OPEN owner_only question (exit 2, NORN-WATCH S3 as before). The
//           controller relaying the owner's answer (--answers / --owner-words, MCP norn_decision_add) stays allowed (DEC-305).
// Scope, from both projects' recorded history (NOTES): the worktree, not the lane (a lane may run parallel stages in their own
// worktrees); a live writer, not a queued run (the fill never starts a queued run on a worktree with a live writer); a MERGE stage
// is the merge gate's (runs.mergeStageRefusal, DEC-5), not this one; owner-only = the owner_only flag (DIR-47: check-ins rule
// classes i-v themselves - recorded check-ins rule class iii asks routinely - except an owner_only Q).
import { isMergeStage } from './usageguard.mjs';

export const BUSY_EXIT = 6, OWNER_ONLY_EXIT = 2;   // guard B keeps NORN-WATCH S3's exit 2 (tests/owner-ask pin it)
export const GUARD_WORDS = { busy: 'lane busy', 'owner-only': 'owner-only ask' };
const NON_WRITER = new Set(['checkin', 'delegate', 'interactive']);
const wtKey = w => String(w || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * Guard A. spec { lane, worktree, stage, after: [{ kind, id, state }] }; runs: run items ({ id, state, data }) - the running and queued
 * ones of the state. -> the refusal words, or null. Chained = an after: run condition on a run of that worktree (live or queued:
 * behind the worktree's own chain), the recorded pattern `norn run --queue --after run:RUN-n:ended`.
 */
export function busyRefusal(spec, runs) {
  if (isMergeStage(spec.stage)) return null;
  const wt = wtKey(spec.worktree);
  const mine = (runs || []).filter(r => ['running', 'queued'].includes(r.state) && !NON_WRITER.has(r.data?.kind) && r.data?.role !== 'helper'
    && (wt ? wtKey(r.data?.worktree) === wt : r.data?.lane === spec.lane));
  const live = mine.filter(r => r.state === 'running');
  if (!live.length) return null;
  const chain = new Set(mine.map(r => r.id));
  if ((spec.after || []).some(a => a?.kind === 'run' && chain.has(a.id))) return null;
  const w = live[0];
  return `lane busy: ${spec.worktree ? `worktree ${String(spec.worktree).replace(/\\/g, '/')}` : `lane ${spec.lane}`} has live run ${w.id}${w.data?.stage ? ` (${w.data.lane ?? ''} ${w.data.stage})` : ''}`
    + ` - a check-in chains behind it (norn run --queue --after run:${w.id}:ended) or leaves it to the next tick`;
}

/** Guard B. q: the question item a ruling answers ({ id, state, data: { owner_only } }); actor: the writer's role (only 'checkin' is
 *  refused). -> words or null. */
export function ownerOnlyRefusal(q, actor) {
  if (!q || q.state !== 'open' || q.data?.owner_only !== true || actor !== 'checkin') return null;
  return `owner-only ask: ${q.id} is owner_only - only the owner answers it (a check-in never rules it; past 24 h re-send it: norn notify --class ask)`;
}
