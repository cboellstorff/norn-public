// Lane lifecycle (lane norn-lifecycle, owner 2026-11-18: "why was the lane orphaned? why didn't norn handle that itself?"): no lane
// sits. One rule per lane, pure over a loadState() fold (laneRules); the tick acts on the `tick` rules (tickLanes), the check-in on the
// `checkin` ones (digest section `lanes`, CHECKIN.md 2j, a gate wake through lanesProbe), the Lanes page shows each row's words.
//   orphan   a lane a check-in created and dispatched no run on before that check-in ended (solve-shack docs-fixer-2: the brief went to
//            RUN-26 on docs-fixer) - the tick archives it. Archive, not a refusal at create time: the check-in cannot know at its
//            `rec add lane` whether it will dispatch on it later in the same pass, and its end is the first moment that is known.
//   idle     an active lane with no live run, and no run at all or none ended for policy.idle_lanes.hours (model-tab-visualization:
//            a brief, no run, its item on horizon next) - a check-in finding: start it, park it with a why, or archive it
//   stopped  the latest run exited STOPPED and no run is live: archived by the tick when its work landed anyway (a `norn runs landed`
//            ruling, or the lane's deliverables merged: solve-shack run-efficiency); else a check-in finding every pass (resume it,
//            park it with a question, or archive it) - never archived by the tick while its work did not land
//   archive  a done lane (record done, or its latest run exited DONE) whose work is merged, with no open deliverable (no open PR) and no
//            live run: the tick archives it policy.done_lanes.archive_days after its end (0 = never). Its worktree goes only when it is
//            clean and fully on main; otherwise it stays and the archive records it as work at risk.
// An archive by the tick is the owner's Archive event by role `tick` with its why; the Lanes page Unarchive undoes it.
import fs from 'node:fs';
import path from 'node:path';
import { loadState, record, readEvents, recordsFile, fold } from './records.mjs';
import { makeEval, workOnMain } from './after.mjs';
import { makeGit } from './dlvgit.mjs';

export const IDLE_H = 6, ARCHIVE_DAYS = 7;
const H = 3600e3, D = 24 * H;
const runNum = id => Number(String(id).slice(4));
const LIVE = ['queued', 'claimed', 'running'];
const endTs = r => r?.history.findLast(h => ['end', 'lost', 'kill', 'withdraw', 'fill'].includes(h.ev))?.ts ?? r?.updated ?? null;
const inDays = ms => { const d = Math.ceil(ms / D); return d <= 0 ? 'at the next tick' : `in ${d} day${d === 1 ? '' : 's'}`; };

/** the lane policy in force: { idleH, archiveDays } from a project policy (policy.idle_lanes.hours, policy.done_lanes.archive_days) */
export const lanePolicy = (policy = {}) => ({ idleH: Number.isFinite(policy?.idle_lanes?.hours) ? policy.idle_lanes.hours : IDLE_H,
  archiveDays: Number.isFinite(policy?.done_lanes?.archive_days) ? policy.done_lanes.archive_days : ARCHIVE_DAYS });

/**
 * One rule per active / done lane that has one: [{ lane (name), id, rule: orphan | idle | stopped | archive, act: tick | checkin | wait,
 * at (ISO: when the tick acts, archive only), run (the latest run id), text (the Lanes page words), why (the archive why / the finding) }].
 * o: { now, idleH, archiveDays, landed (lane, run) -> the stopped run's work landed, merged (lane, run) -> the done lane's work is merged
 * and nothing of it is open (git: the tick's probe; default false = the tick never archives on a guess) }
 */
export function laneRules(st, { now = Date.now(), idleH = IDLE_H, archiveDays = ARCHIVE_DAYS, landed = () => false, merged = () => false } = {}) {
  const items = Object.values(st.items), byLane = {};
  for (const r of items) if (r.kind === 'run' && r.data?.lane) (byLane[r.data.lane] ??= []).push(r);
  const out = [];
  for (const l of items) {
    if (l.kind !== 'lane' || !['active', 'done'].includes(l.state)) continue;
    const name = l.id.slice(2), runs = (byLane[name] || []).sort((a, b) => runNum(a.id) - runNum(b.id)), r = runs.at(-1);
    if (runs.some(x => LIVE.includes(x.state))) continue;
    const row = (rule, act, text, why, at = null) => out.push({ lane: name, id: l.id, rule, act, at, run: r?.id ?? null, text, why });
    const maker = l.run ? st.items[l.run] : null;
    if (l.state === 'active' && !r && maker?.data?.kind === 'checkin' && maker.state !== 'running') {
      row('orphan', 'tick', 'orphan: its check-in dispatched nothing on it - archives at the next tick', `created by check-in ${maker.id}, which ended with no run on it (its work went to another lane or nowhere)`);
      continue;
    }
    const doneLane = l.state === 'done' || (r?.state === 'exited' && r.end?.outcome === 'done');
    if (doneLane) {
      if (!archiveDays || !r) continue;
      const ended = Date.parse(endTs(r) ?? l.updated);
      if (!merged(name, r)) { row('archive', 'wait', 'done, not merged: stays until its work is on main', null); continue; }
      const at = ended + archiveDays * D;
      row('archive', 'tick', `archives ${inDays(at - now)}`, `done, its work merged, nothing open: archived ${archiveDays} d after its end (policy.done_lanes.archive_days)`, new Date(at).toISOString());
      continue;
    }
    if (l.state !== 'active') continue;
    if (r?.state === 'exited' && r.end?.outcome === 'stopped') {
      if (landed(name, r)) row('stopped', 'tick', 'stopped, its work landed - archives at the next tick', `stopped (${r.id}) but its work landed (${r.landed ? `ruled landed: ${r.landed.why}` : 'its deliverables merged'})`);
      else row('stopped', 'checkin', 'stopped: needs a check-in decision', `${r.id} stopped${r.end.why ? `: ${r.end.why}` : ''} - resume it, park it with a question, or archive it`);
      continue;
    }
    const since = Date.parse(r ? endTs(r) : l.created);
    if (now - since > idleH * H) row('idle', 'checkin', r ? `idle: no run for ${Math.floor((now - since) / H)} h` : 'idle: no run',
      `${r ? `no run since ${r.id} ended ${Math.floor((now - since) / H)} h ago` : `no run since it was created ${Math.floor((now - since) / H)} h ago`} - start it, park it with a why, or archive it`);
  }
  return out;
}

// the tick's git answers for the Lanes page (the dash never runs git per lane): { at, landed: [lane], merged: [lane] }
export const laneRulesFile = state => path.join(state, 'lane-rules.json');
/** lanesView's landed / merged hooks from the tick's cache: a ruling, or the lane named there */
export function laneHooks(state) {
  let c = null; try { c = JSON.parse(fs.readFileSync(laneRulesFile(state), 'utf8')); } catch { c = null; }
  const has = k => (l, r) => !!r.landed || !!c?.[k]?.includes(l);
  return { landed: has('landed'), merged: has('merged') };
}

/** the gate probe: a lane finding the check-in must act on (idle / stopped, from the facts the gate folded at that time) = `lanes:<rule>:L:x`, a MAJOR wake once */
export const lanesProbe = policy => ({ at, items, runs }) => {
  const st = { items: Object.fromEntries([...(items || []), ...(runs || [])].map(i => [i.id, i])) };
  return laneRules(st, { now: at, ...lanePolicy(policy) }).filter(x => x.act === 'checkin').map(x => `lanes:${x.rule}:${x.id}`);
};

/**
 * The tick's step: archive every `tick` rule (orphan, stopped + landed, done + merged past archive_days), each a lane archive event by
 * role tick with { why, rule, worktree: removed | kept, at_risk? }. o: { now (ms), git, project (deliverables main), dry }. -> [{ id, rule, why, worktree, at_risk }]
 */
export function tickLanes(state, { project = {}, now = Date.now(), git = makeGit(), dry = false } = {}) {
  const st = loadState(state), ev = makeEval(state, { git }), main = project.deliverables?.main || 'main';
  const dlvs = Object.values(fold(readEvents(recordsFile(state, 'deliverable'))).items).filter(d => d.kind === 'deliverable');
  const laneDlvs = lane => dlvs.filter(d => d.data.lane === lane && d.state !== 'superseded');
  const dlvMerged = d => ev({ kind: 'dlv', id: d.id }).met;
  const landed = (lane, r) => !!r.landed || (laneDlvs(lane).length > 0 && laneDlvs(lane).every(dlvMerged));
  const merged = (lane, r) => ev({ kind: 'run', id: r.id, state: 'merged' }).met && laneDlvs(lane).every(dlvMerged);
  const out = [], seen = { landed: [], merged: [] };
  const rules = laneRules(st, { now, ...lanePolicy(project.policy), landed: (l, r) => landed(l, r) && !!seen.landed.push(l), merged: (l, r) => merged(l, r) && !!seen.merged.push(l) });
  if (!dry) try { fs.writeFileSync(laneRulesFile(state), JSON.stringify({ at: new Date(now).toISOString(), ...seen }) + '\n'); } catch { /* the Lanes page falls back to the rulings */ }
  for (const x of rules) {
    if (x.act !== 'tick' || (x.at && Date.parse(x.at) > now)) continue;
    const wt = x.run ? st.items[x.run]?.data?.worktree : null, w = x.rule === 'orphan' || dry ? { worktree: 'none' } : worktreeVerdict(wt, { main, git });
    const data = { why: `${x.why} - by the tick`, rule: x.rule, ...w };
    // a guard's refusal (records.mjs archiveGuard: a deliverable done and not merged) leaves this lane as it is, the others go on
    if (!dry) try { record(state, { kind: 'lane', ev: 'archive', id: x.id, by: 'tick', data }, { views: project.views || {} }); } catch (e) { out.push({ id: x.id, rule: x.rule, refused: e.message }); continue; }
    if (w.worktree === 'removed' && !removeWorktree(wt, { root: project.root, git })) { w.worktree = 'kept'; w.at_risk = `${wt}: git worktree remove failed`; }
    out.push({ id: x.id, rule: x.rule, why: data.why, worktree: w.worktree, ...(w.at_risk ? { at_risk: w.at_risk } : {}) });
  }
  return out;
}

// the archived lane's worktree goes only when it is clean (no change, no untracked file) and its HEAD is on main; otherwise it stays
// and the archive names it: { worktree: removed | kept | none, at_risk?: '<path>: <why>' } (removed = to remove, after the archive is written)
function worktreeVerdict(wt, { main, git }) {
  if (!wt || !fs.existsSync(wt)) return { worktree: 'none' };
  const dirty = git(wt, ['status', '--porcelain'], { allowFail: true });
  const head = git(wt, ['rev-parse', 'HEAD'], { allowFail: true })?.trim();
  const why = dirty === null || dirty === undefined ? 'not a git worktree' : dirty.trim() ? 'uncommitted changes' : !head || !workOnMain(wt, head, main, { git }) ? 'commits not on main' : null;
  return why ? { worktree: 'kept', at_risk: `${wt}: ${why}` } : { worktree: 'removed' };
}
const removeWorktree = (wt, { root, git }) => git(root && fs.existsSync(root) ? root : path.dirname(wt), ['worktree', 'remove', wt], { allowFail: true }) !== null && !fs.existsSync(wt);

// ---------- one CI-fix lane (lane norn-lifecycle item 7: ci-fix2, ci-fix3, ci-fix4 were a new lane per red; ci-fix2 died at start and sat) ----------
// Every red on main is a new stage (CI-<run id>) on THE one lane ci-fix - created on the first red, unarchived when the rules above
// archived it, never a second lane. Its branch is reset from main before the new stage when its previous work landed (the worker's
// first step: the lane worktree is clean and its HEAD is on main). A red met while a fix run is live waits for it (one writer).
// -> { lane, stage, round, create, unarchive, live (RUN id | null), reset, line (the digest's words) }
export const CI_FIX_LANE = 'ci-fix';
export function ciFixPlan(st, red, { landed = r => !!r.landed } = {}) {
  const l = st.items[`L:${CI_FIX_LANE}`], stage = `CI-${red.run}`;
  const runs = Object.values(st.items).filter(r => r.kind === 'run' && r.data?.lane === CI_FIX_LANE).sort((a, b) => runNum(a.id) - runNum(b.id));
  const live = runs.find(r => LIVE.includes(r.state))?.id ?? null, last = runs.at(-1);
  const round = Math.max(0, ...runs.filter(r => r.data.stage === stage).map(r => Number(r.data.round) || 1)) + 1;
  const reset = !!last && last.data.stage !== stage && landed(last);
  const steps = [!l ? `META rec add lane --name ${CI_FIX_LANE}` : l.state === 'archived' ? `META rec unarchive L:${CI_FIX_LANE}` : l.state === 'parked' ? `unpark L:${CI_FIX_LANE} (or rule its Q)` : null,
    live ? `queue it after ${live} (--after run:${live}:ended)` : null, reset ? `the brief's first step: reset the lane branch from main (its last work ${last.id} landed)` : null].filter(Boolean);
  return { lane: CI_FIX_LANE, stage, round, create: !l, unarchive: l?.state === 'archived', live, reset,
    line: `fix it on lane ${CI_FIX_LANE} stage ${stage} round ${round}${steps.length ? ' - ' + steps.join('; ') : ''}` };
}
