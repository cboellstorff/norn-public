// META-LIMIT-GATE R1: an executor out of quota is never dispatched. The one source is the run records: the newest `end` with outcome
// `limit` of an executor family (built-ins: their harness - codex-sol + codex-astra share the Codex account; typed executors: their own
// name) whose reset is still ahead closes the family until that reset. A later done / stopped / handoff run of the family opens it (the
// quota is back whatever the parse said), and so does a later decision on lane `limit-<family>` (LIMIT_LANE); an unread reset (null)
// closes nothing (the supervisor's re-queue already waits 60 min). A family stays closed LIMIT_GRACE_MS past its reset: a launch on the
// dot can meet the old limit and read the NEXT such reset ("resets 2pm" read at 14:00:05 = tomorrow). The gate is the only hold on a
// limit re-queue with a read reset (supervisor.requeue sets no not_before), so a limit-<family> decision releases it at once (DEC-337).
// `norn run` refuses a closed executor (exit 4, runs.startRun), the queue fill holds it (runs.walkQueue), and STATUS / doctor /
// `norn executors` / the dashboard show "out of quota until X".
import { loadState } from './records.mjs';
import { BUILTIN } from './executors.mjs';

const OPENS = ['done', 'stopped', 'handoff', 'nudged'];
export const LIMIT_GRACE_MS = 120000;
const DISPATCHABLE = Object.keys(BUILTIN).filter(n => n !== 'fake');
/** The family of executor `name`: a built-in's harness, else the name itself. */
export const limitKey = name => (Object.hasOwn(BUILTIN, name ?? '') ? BUILTIN[name].harness : String(name));
const members = key => Object.keys(BUILTIN).filter(n => limitKey(n) === key);

// The quota can come back before the parsed reset (owner 11-15: a plan reset at 100 %), and a closed family can start no run to
// prove it. So a recorded decision on lane `limit-<family>` ("the quota is back", by the owner or the controller relaying the owner)
// opens a limit recorded BEFORE it. Run events and decisions keep separate seq counters (records.loadState), so the order between
// them is their timestamp; in the same second the limit stands (record the decision again).
export const LIMIT_LANE = /^limit-(.+)$/;

/** { <family>: { reset, run, line, executor } } - every family closed at `now` (ms). */
export function openLimits(state, { now = Date.now() } = {}) {
  const ends = [], opened = [];
  for (const it of Object.values(loadState(state).items)) {
    if (it.kind === 'decision' && LIMIT_LANE.test(it.data?.lane ?? '')) {
      const h = it.history.find(x => x.ev === 'create');
      if (h?.ts) opened.push({ key: LIMIT_LANE.exec(it.data.lane)[1], at: Date.parse(h.ts) });
      continue;
    }
    if (it.kind !== 'run' || !it.end || !it.data?.executor) continue;
    const h = it.history.find(x => x.ev === 'end');
    ends.push({ seq: h?.seq ?? 0, at: Date.parse(h?.ts ?? '') || 0, run: it.id, executor: it.data.executor, end: it.end });
  }
  const last = {};
  for (const e of ends.sort((a, b) => a.seq - b.seq)) {
    const key = limitKey(e.executor);
    if (e.end.outcome === 'limit' && e.end.reset) last[key] = { reset: e.end.reset, run: e.run, line: e.end.limit_line ?? null, executor: e.executor, at: e.at };
    else if (e.end.outcome === 'limit' || OPENS.includes(e.end.outcome)) delete last[key];
  }
  for (const o of opened) if (last[o.key] && o.at > last[o.key].at) delete last[o.key];
  for (const v of Object.values(last)) delete v.at;
  return Object.fromEntries(Object.entries(last).filter(([, v]) => Date.parse(v.reset) + LIMIT_GRACE_MS > now));
}

/** The refusal of run spec `spec` ({ executor }) while its family is out of quota, else null. o.limits: a precomputed openLimits. */
export function limitRefusal(state, spec, { now = Date.now(), limits } = {}) {
  if (!state || !spec?.executor) return null;
  const all = limits ?? openLimits(state, { now }), l = all[limitKey(spec.executor)];
  if (!l) return null;
  const open = DISPATCHABLE.filter(n => !all[limitKey(n)]);
  const route = open.length ? `route the work to an open executor instead (${open.join(', ')})` : 'no built-in executor is open: queue it (norn run --queue waits for the reset)';
  return `limit: ${spec.executor} out of quota until ${l.reset} (${l.run}${l.line ? `: ${l.line}` : ''}) - ${route}`;
}

/** One line per closed family, for STATUS / doctor / norn executors / the dashboard. */
export function limitLines(state, { now = Date.now() } = {}) {
  return Object.entries(openLimits(state, { now })).map(([k, l]) => {
    const m = members(k);
    return `${k}${m.length && !(m.length === 1 && m[0] === k) ? ` (${m.join(', ')})` : ''}: out of quota until ${l.reset} (${l.run})`;
  });
}
