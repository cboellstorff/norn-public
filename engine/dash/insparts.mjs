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
