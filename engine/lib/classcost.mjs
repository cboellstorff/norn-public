// META-TEND P2 (REPORT 4.3): what each kind of work costs. Unit = a COMPLETED stage: every run of one lane + stage (resumes, hand-offs
// and fix rounds fold into the stage they finish; a run with no stage chains to its first run by resume_of / fallback_of /
// requeue_of / replaces). A stage takes the class / executor / model / effort of its LAST run. Per class x executor x model x effort:
// stages, runs, done / stopped / merged rates, median + p90 cache reads and output per done stage, and the cost per done stage =
// weighted tokens of ALL its stages (cost.mjs WEIGHTS; the not-done ones are the waste) / done stages. Stages still running are out
// (counted as open). A stage with any run whose class is inferred (recorded before the stamp, workclass.mjs) is an `inferred` row,
// never mixed into a stamped one. Plus the window's Fable runs (owner Q4: the cost class).
import { usageOfRun } from './cost.mjs';
import { classOfRun, CLASS_LABELS, isFable } from './workclass.mjs';

const RUNS = ['running', 'exited', 'killed', 'lost'];
const nearest = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const LINKS = ['resume_of', 'fallback_of', 'requeue_of', 'replaces'];

function unitKey(r, byId) {
  const d = r.data || {};
  if (d.stage) return `${d.lane ?? '-'}|${d.stage}`;
  let x = r;
  for (let i = 0; i < 50; i++) { const up = LINKS.map(k => x.data?.[k]).find(id => id && byId.has(id)); if (!up) break; x = byId.get(up); }
  return `${d.lane ?? '-'}|#${x.id}`;
}

/**
 * parts: [{ project, items (fold items), dlvs: [{ id, runs, merged_at }], policy ({ executors, critical_lanes }) }];
 * o: { now, since (ms), projectsDir, codexDir, cache, memo } -> { since, rows, byClass, byClassModel, open, inferred_runs, fable }
 */
export function classCost(parts, o = {}) {
  const now = o.now ?? Date.now(), since = o.since ?? now - 7 * 86400000, uo = { projectsDir: o.projectsDir, codexDir: o.codexDir, cache: o.cache || new Map(), memo: o.memo || new Map() };
  const units = [], fable = { runs: [], projects: {} };
  let open = 0, inferred = 0;
  for (const p of parts) {
    const all = (p.items || []).filter(i => i.kind === 'run'), byId = new Map(all.map(i => [i.id, i]));
    const runs = all.filter(i => RUNS.includes(i.state) && Date.parse(i.created) >= since && Date.parse(i.created) <= now).sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
    const merged = new Set();
    for (const d of p.dlvs || []) if (d.merged_at) for (const id of d.runs || []) merged.add(id);
    const groups = new Map();
    for (const r of runs) {
      const k = unitKey(r, byId);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
      if (isFable(r.data)) { fable.runs.push(r.id); fable.projects[p.project] = (fable.projects[p.project] || 0) + 1; }
    }
    for (const rs of groups.values()) {
      if (rs.some(r => r.state === 'running')) { open++; continue; }
      const cls = rs.map(r => classOfRun(r.data, p.policy)), last = rs[rs.length - 1], lc = cls[cls.length - 1], d = last.data || {};
      inferred += cls.filter(c => c.inferred).length;
      const done = rs.some(r => r.state === 'exited' && r.end?.outcome === 'done');
      const t = { cache_read: 0, output: 0, weighted: 0, other: 0, measured: true };
      for (const r of rs) {
        const u = usageOfRun(r, uo);
        if (u.tokens) { t.cache_read += u.tokens.cache_read; t.output += u.tokens.output; t.weighted += u.tokens.weighted; }
        else { t.measured = false; if (Number.isFinite(u.total)) t.other += u.total; }
      }
      units.push({ project: p.project, class: lc.class, src: cls.some(c => c.inferred) ? 'inferred' : 'stamped', basis: lc.basis,
        executor: d.agent || d.executor || '-', model: d.model || '-', effort: d.effort || '-', runs: rs.length, done,
        stopped: !done && (last.end?.outcome === 'stopped' || ['killed', 'lost'].includes(last.state)), merged: rs.some(r => merged.has(r.id)), t });
    }
  }
  const group = keys => {
    const m = new Map();
    for (const u of units) { const k = keys.map(x => u[x]).join('|'); if (!m.has(k)) m.set(k, []); m.get(k).push(u); }
    return [...m.values()].map(us => {
      const row = Object.fromEntries(keys.map(x => [x, us[0][x]])), n = us.length, dn = us.filter(u => u.done), ms = dn.filter(u => u.t.measured);
      const weighted = us.reduce((a, u) => a + u.t.weighted, 0), cr = ms.map(u => u.t.cache_read), out = ms.map(u => u.t.output);
      return { ...row, label: CLASS_LABELS[row.class] || row.class, basis: [...new Set(us.map(u => u.basis))], stages: n, runs: us.reduce((a, u) => a + u.runs, 0),
        done: dn.length, stopped: us.filter(u => u.stopped).length, merged: us.filter(u => u.merged).length,
        done_rate: dn.length / n, stop_rate: us.filter(u => u.stopped).length / n, merged_rate: us.filter(u => u.merged).length / n,
        runs_per_done: dn.length ? dn.reduce((a, u) => a + u.runs, 0) / dn.length : null,
        cache_read: { median: median(cr), p90: nearest(cr, 0.9) }, output: { median: median(out), p90: nearest(out, 0.9) },
        cost_per_done: dn.length && weighted ? weighted / dn.length : null, other_tokens: us.reduce((a, u) => a + u.t.other, 0), measured: ms.length };
    }).sort((a, b) => String(a.project).localeCompare(String(b.project)) || (b.cost_per_done ?? -1) - (a.cost_per_done ?? -1) || b.stages - a.stages);
  };
  return { since: new Date(since).toISOString(), now: new Date(now).toISOString(), rows: group(['project', 'class', 'src', 'executor', 'model', 'effort']),
    byClass: group(['project', 'class', 'src']), byClassModel: group(['project', 'class', 'src', 'model']), open, inferred_runs: inferred, fable: { ...fable, count: fable.runs.length } };
}
