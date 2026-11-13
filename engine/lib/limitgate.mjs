// META-LIMIT-GATE R1: an executor out of quota is never dispatched. The one source is the run records: the newest `end` with outcome
// `limit` of an executor family (built-ins: their harness - codex-sol + codex-astra share the Codex account; typed executors: their own
// name) whose reset is still ahead closes the family until that reset. A later done / stopped / handoff run of the family opens it (the
// quota is back whatever the parse said); an unread reset (null) closes nothing (the supervisor's re-queue already waits 60 min).
// `norn run` refuses a closed executor (exit 4, runs.startRun), the queue fill holds it (runs.walkQueue), and STATUS / doctor /
// `norn executors` / the dashboard show "out of quota until X".
import { loadState } from './records.mjs';
import { BUILTIN } from './executors.mjs';

const OPENS = ['done', 'stopped', 'handoff', 'nudged'];
const DISPATCHABLE = Object.keys(BUILTIN).filter(n => n !== 'fake');
/** The family of executor `name`: a built-in's harness, else the name itself. */
export const limitKey = name => (Object.hasOwn(BUILTIN, name ?? '') ? BUILTIN[name].harness : String(name));
const members = key => Object.keys(BUILTIN).filter(n => limitKey(n) === key);

/** { <family>: { reset, run, line, executor } } - every family closed at `now` (ms). */
export function openLimits(state, { now = Date.now() } = {}) {
  const ends = [];
  for (const it of Object.values(loadState(state).items)) {
    if (it.kind !== 'run' || !it.end || !it.data?.executor) continue;
    const h = it.history.find(x => x.ev === 'end');
    ends.push({ seq: h?.seq ?? 0, run: it.id, executor: it.data.executor, end: it.end });
  }
  const last = {};
  for (const e of ends.sort((a, b) => a.seq - b.seq)) {
    const key = limitKey(e.executor);
    if (e.end.outcome === 'limit' && e.end.reset) last[key] = { reset: e.end.reset, run: e.run, line: e.end.limit_line ?? null, executor: e.executor };
    else if (e.end.outcome === 'limit' || OPENS.includes(e.end.outcome)) delete last[key];
  }
  return Object.fromEntries(Object.entries(last).filter(([, v]) => Date.parse(v.reset) > now));
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
