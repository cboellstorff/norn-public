// Truthful lanes (META-GENERAL-DESIGN 5, 12-S6): the lane list is LANE records only (no folder scan); a lane's state text is its
// latest RUN on that lane, any executor. Pure over a loadState() fold; heartbeat age comes from the caller.
import { STALE_MS } from './runs.mjs';
import { runName } from './names.mjs';
import { loginCommand } from './authguard.mjs';

const runNum = id => Number(String(id).slice(4));

function runText(r, { now, hbAge, staleMs, items = {} }) {
  const d = r.data || {}, end = r.end || {};
  // OOTB-R2 N-5: a queued run is queued (it has no end), and one re-queued after an auth exit says it waits for the login
  if (r.state === 'queued' || r.state === 'claimed') {
    const prev = items[d.requeue_of];
    if (prev?.end?.outcome === 'auth' && prev.end.auth_class === 'vendor') return `queued: held for a vendor outage (${prev.id} exited: auth) - resumes by itself, no login needed`;
    return prev?.end?.outcome === 'auth' ? `queued: held for login (${prev.id} exited: auth) - run ${loginCommand(d.executor)}` : r.state;
  }
  if (r.state === 'running') {
    if (hbAge && hbAge(r.id, r) > staleMs) return 'lost';
    const min = Math.max(0, Math.round((now - Date.parse(r.created)) / 60000));
    const who = [d.executor, d.model, d.effort].filter(Boolean).join(' ');
    return `running ${who} for ${min} min` + (d.budget_min ? ` / budget ${d.budget_min}` : '');
  }
  if (r.state === 'lost') return 'lost';
  if (r.state === 'killed') return 'killed' + (r.kill?.why ? `: ${r.kill.why}` : '');
  if (r.resume?.refused) return `waiting: auto-resume refused (${r.resume.refused})`;
  const o = end.outcome;
  if (o === 'done') return 'exited: DONE';
  if (o === 'stopped') return `exited: STOPPED: ${end.why ?? ''}`.trimEnd();
  if (o === 'handoff') return 'exited: HANDOFF' + (r.resume?.next ? ` -> ${r.resume.next}` : '');
  if (o === 'crash') return `exited: crash (exit ${end.exit ?? '?'})`;
  if (o === 'auth') return end.auth_class === 'vendor' ? 'exited: auth - a vendor outage (no login needed)' : `exited: auth - run ${loginCommand(d.executor)}`;
  return `exited: ${o ?? 'no-result'}`;
}

// RM-19 S1: the Lanes page shows what is live first - running, then needs you (parked, stopped, lost, a hand-off with no resume ...),
// then queued, then done, then archived; newest first in each group (row.at). Done = the lane record is done or the latest run
// exited DONE; an old done lane (ended over oldDays ago) is faded and reads stopped.
export const LANE_GROUPS = ['running', 'needs', 'queued', 'done', 'archived'];
function laneGroup(l, r) {
  if (l.state === 'archived') return 'archived';
  if (l.state === 'parked') return 'needs';   // parked = waiting on the owner, whatever its last run said
  if (r?.state === 'running') return 'running';
  if (r?.state === 'queued' || r?.state === 'claimed' || (!r && l.state === 'active')) return 'queued';
  if (l.state === 'done' || (r?.state === 'exited' && r.end?.outcome === 'done')) return 'done';
  return 'needs';
}
export const sortLanes = rows => rows.sort((a, b) => LANE_GROUPS.indexOf(a.group) - LANE_GROUPS.indexOf(b.group) || String(b.at ?? '').localeCompare(String(a.at ?? '')));

/**
 * Lanes view: LANE records active | parked (all states with all), in sortLanes order. Each row: { name, id, state, data, run,
 * executor, text, group, created, ended, at, old }.
 * o: { all, now, hbAge (runId, run) -> ms since the last heartbeat, staleMs, oldDays (policy.done_lanes.old_days) }
 */
export function lanesView(st, { all = false, now = Date.now(), hbAge = null, staleMs = STALE_MS, oldDays = 2 } = {}) {
  const items = Object.values(st.items);
  const latest = {};
  for (const r of items) if (r.kind === 'run' && r.data?.lane && (!latest[r.data.lane] || runNum(r.id) > runNum(latest[r.data.lane].id))) latest[r.data.lane] = r;
  return sortLanes(items.filter(l => l.kind === 'lane' && (all || l.state === 'active' || l.state === 'parked')).map(l => {
    const name = l.id.slice(2), r = latest[name];
    const park = l.state === 'parked' ? [...l.history].reverse().find(h => h.ev === 'park')?.data || {} : null;
    const text = park ? (park.q ? `parked by ${park.q}` : `parked: ${park.why ?? ''}`.trimEnd())
      : r ? runText(r, { now, hbAge, staleMs, items: st.items }) : 'no runs';
    const group = laneGroup(l, r), ended = r?.history.findLast(h => h.ev === 'end')?.ts ?? l.history.findLast(h => h.ev === 'done')?.ts ?? null;
    const at = group === 'running' || group === 'queued' ? r?.created ?? l.created : group === 'done' ? ended ?? l.updated : l.updated;
    const old = group === 'done' && !!ended && now - Date.parse(ended) > oldDays * 864e5;
    return { name, id: l.id, state: l.state, data: l.data, run: r?.id ?? null, run_name: r ? runName(r) : null, executor: r?.data.executor ?? null, run_state: r?.state ?? null, text,
      group, created: l.created, ended, at, old };
  }));
}
