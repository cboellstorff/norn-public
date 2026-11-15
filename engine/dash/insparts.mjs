// META-UX-BUILD S1: the Instructions view in parts - the first answer is a small summary (the lists' counts, no list); each list is
// its own part (GET /api/instructions?part=<name>), capped at what the page shows + its full count. Shared by the server (it cuts
// the parts from the cached view) and the page (the ladder's column order and caps). Pure, no I/O: the browser loads it too.
export const INS_PARTS = ['files', 'rules', 'findings', 'hints', 'suggest'];
// suggest 30 = the Tighten list's length; ladder 40 cards per state column; advisories 60 lines per group (the ladder's findings);
// hints / findings: the first 60 / 120 (the Guard lists every finding)
export const INS_CAPS = { suggest: 30, hints: 60, findings: 120, ladder: 40, advisories: 60 };
const LISTS = ['rows', 'hints', 'suggest', 'findings', 'rules', 'evidence'];
// the ladder's column order (most homes / repeats / newest fired / newest retired first)
export const LADDER_ORDER = { prose: (a, b) => b.homes.length - a.homes.length, repeated: (a, b) => b.repeats - a.repeats,
  enforced: (a, b) => String(b.fired?.at ?? '').localeCompare(String(a.fired?.at ?? '')), retired: (a, b) => String(b.retired_at ?? '').localeCompare(String(a.retired_at ?? '')) };
export const LADDER_STATES = Object.keys(LADDER_ORDER);

/** the view without its lists + { counts: { files, hints, suggest, findings, rules, advisories } } */
export function insSummary(v) {
  const out = Object.fromEntries(Object.entries(v).filter(([k]) => !LISTS.includes(k)));
  out.counts = { files: (v.rows || []).length, hints: (v.hints || []).length, suggest: (v.suggest || []).length, findings: (v.findings || []).length,
    rules: (v.rules?.rules || []).length, advisories: (v.rules?.advisories || []).length };
  return out;
}

/** one part of the view, capped; throws on an unknown name */
export function insPart(v, name) {
  if (name === 'files') return { rows: v.rows || [] };
  if (name === 'suggest') return { suggest: (v.suggest || []).slice(0, INS_CAPS.suggest), suggest_n: (v.suggest || []).length };
  if (name === 'hints') return { hints: (v.hints || []).slice(0, INS_CAPS.hints), hints_n: (v.hints || []).length };
  if (name === 'findings') return { findings: (v.findings || []).slice(0, INS_CAPS.findings), findings_n: (v.findings || []).length };
  if (name === 'rules') {
    const L = v.rules;
    if (!L) return { rules: null };
    const rules = LADDER_STATES.flatMap(st => L.rules.filter(r => r.state === st).sort(LADDER_ORDER[st]).slice(0, INS_CAPS.ladder));
    const adv = [], adv_counts = {};
    for (const a of L.advisories || []) { adv_counts[a.key] = (adv_counts[a.key] || 0) + 1; if (adv_counts[a.key] <= INS_CAPS.advisories) adv.push(a); }
    return { rules: { ...L, rules, advisories: adv, adv_counts } };
  }
  throw Object.assign(new Error(`unknown part ${name} (one of ${INS_PARTS.join(', ')})`), { status: 400 });
}

// META-UX-BUILD S4 (REPORT s.2, owner DIR-65 "3) A"): the Context tab = the Instructions view's cost half, in the sub-view pattern
// (subviews.mjs). The summary answer carries what Per role, Is it growing? and Check-ins per day show; Per file loads the files
// part; the checks are one link away and load their lists.
/** [id, label]: the 4 sub-views of Context (the stop rule: never a fifth) */
export const CONTEXT_SUBS = [['role', 'Per role'], ['file', 'Per file'], ['growing', 'Is it growing?'], ['checkins', 'Check-ins per day']];
/** the parts each Context view loads beyond the summary (checks = the page one link away, not a sub-view) */
// META-UX-BUILD S5: hints and suggest (Tighten) are Slop rows now - the checks page no longer loads them
export const contextParts = sub => (sub === 'file' ? ['files'] : sub === 'checks' ? INS_PARTS.filter(k => k !== 'hints' && k !== 'suggest') : []);
const tk = n => (!Number.isFinite(n) ? '-' : n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${n}`);
const roleOf = (m, key) => (m?.roles || []).find(r => r.key === key);

/** the summary numbers (4): one check-in and one worker before any work (measured median), today's load, the check-in load trend */
export function contextNumbers(v) {
  const m = v.measured, c = roleOf(m, 'checkin'), w = roleOf(m, 'worker');
  const pts = (m?.trend?.rows || []).filter(r => r.key === 'checkin' && Number.isFinite(r.median_turn1) && r.median_turn1 > 0).sort((a, b) => a.day.localeCompare(b.day));
  const pct = pts.length > 1 ? Math.round(100 * (pts.at(-1).median_turn1 - pts[0].median_turn1) / pts[0].median_turn1) : null;
  return [{ n: tk(c?.median_turn1), label: 'tokens: one check-in, before any work' }, { n: tk(w?.median_turn1), label: 'tokens: one worker, before any work' },
    { n: tk(v.total), label: `tokens loaded today by ${v.sessions ?? 0} sessions` },
    pct === null ? { n: '-', label: 'check-in load: no trend yet' } : { n: `${pct > 0 ? '+' : ''}${pct} %`, label: `check-in load since ${pts[0].day} (${pct < 0 ? 'shrinking' : pct > 0 ? 'growing' : 'flat'})`, cls: pct < 0 ? 'ok' : pct > 0 ? 'warn' : '' }];
}

// a launch profile (instructions.mjs profileKey: checkin:<tick> | chat | worker:<family>[:<agent>]) -> the measured role key (standing.mjs keyOf)
const profileRole = k => { const [kind, fam] = k.split(':'); return kind === 'worker' ? (fam === 'claude' ? 'worker' : `worker (${fam})`) : kind; };
/** the ONE standing table: each measured role (median per session) with the per-profile estimates of the same role beneath it;
 * an estimate with no measured run is its own row (measured: null) */
export function standingRows(measured, standing = []) {
  const out = (measured?.roles || []).map(r => ({ key: r.key, measured: r, profiles: [] }));
  for (const s of standing || []) {
    const k = profileRole(s.key);
    let r = out.find(x => x.key === k);
    if (!r) out.push(r = { key: k, measured: null, profiles: [] });
    r.profiles.push(s);
  }
  return out;
}
