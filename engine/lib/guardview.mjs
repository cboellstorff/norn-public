// META-TEND P6 (REPORT s.5.0-5.1): the "Guard" overview - a QUERY over the advisory records every phase already makes (Instructions
// P1 / P3 / P5, Tests, the model advice of P4) and SloppaChoppa's open BLOCK findings. It owns no data: counts per type, the trend
// (the open findings by the day each was first seen, advisory.mjs crossings), the rule ledger summary, and per row the tab that fixes it.
// Pure: the server hands in the views it already builds. Node built-ins only.
import { CHECKS } from './instrchecks.mjs';

/** [type, label, the tab that owns it] in display order */
export const GUARD_TYPES = [['code', 'code', 'agents'], ['tests', 'tests', 'tests'], ['instructions', 'instruction files', 'instructions'],
  ['memory', 'memory', 'instructions'], ['rules', 'rules', 'instructions'], ['docs', 'docs', 'docs'], ['models', 'models', 'usage']];
const SEV_RANK = { high: 0, medium: 1, low: 2, count: 3 };
/** warn level or above: only these warn (the badge, a pop-up); low and count rows are listed, never announced */
export const WARNS = s => s === 'high' || s === 'medium';
const fwd = p => String(p ?? '').replace(/\\/g, '/').toLowerCase();
const RULE_KEY = /^(rule-|enforcement-)/;

/** the type of one Instructions advisory: memory (checks 1, 3-6), rules (P3), else instruction files */
export function insType(a) {
  if (a.phase === 'P3' || RULE_KEY.test(a.key)) return 'rules';
  return CHECKS[a.check]?.family === 'memory' ? 'memory' : 'instructions';
}

/**
 * guardRows({ ins, tests, advice, holds, docs }) -> rows [{ id, type, severity, surface, path, line, why, source, action, go }]
 * ins = instructionsView (findings + rules.advisories), tests = testsView, advice = adviceOf (cards), holds = [{ branch, run, lane,
 * blocks }] (slop holds with their OPEN blocks), docs = the project's docs list [{ i, path }]. go = where it is fixed: { tab, ins?,
 * line?, doc?, jump? }. A finding on a file the Docs tab lists is a docs row (fixed there).
 */
export function guardRows({ ins = null, tests = null, advice = null, holds = [], docs = [] } = {}) {
  const out = [], docAt = new Map(docs.map(d => [fwd(d.path), d.i]));
  const rowOf = a => a.row || (ins?.rows || []).find(r => fwd(r.path) === fwd(a.path))?.id || null;
  const seen = new Set();
  for (const a of [...(ins?.findings || []), ...(ins?.rules?.advisories || [])]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const doc = a.path ? docAt.get(fwd(a.path)) : undefined, row = rowOf(a);
    const type = doc !== undefined ? 'docs' : insType(a);
    out.push({ id: a.id, type, severity: a.severity, surface: a.surface, path: a.path, line: a.line, why: a.why, source: a.source, action: a.fix?.action ?? null,
      go: doc !== undefined ? { tab: 'docs', doc } : { tab: 'instructions', ...(row ? { ins: row } : {}), ...(row && a.line ? { line: a.line } : {}) } });
  }
  for (const a of tests?.advisories?.list || [])
    out.push({ id: a.id, type: 'tests', severity: a.severity, surface: a.surface, path: a.path, line: a.line, why: a.why, source: a.source, action: a.fix?.action ?? null, go: { tab: 'tests' } });
  for (const c of (advice?.cards || []).filter(x => !x.decided))
    out.push({ id: 'M-' + c.key, type: 'models', severity: c.severity, surface: `class ${c.id}`, path: null, line: null, why: c.title, source: c.source?.ref ?? c.source ?? null,
      action: c.fix ?? null, cls: c.id, go: { tab: 'usage', jump: 'usage-advice' } });
  for (const h of holds) for (const b of h.blocks || [])
    out.push({ id: 'S-' + b.fp, type: 'code', severity: 'high', surface: `branch ${h.branch}`, path: b.file, line: b.line ?? null, why: `${b.rule}: ${b.msg}`,
      source: 'SloppaChoppa (norn slop check)', action: 'fix it on the branch, or waive it (norn slop waive)', run: h.run ?? null,
      go: { tab: 'agents', ...(h.run ? { jump: 'node-' + h.run } : {}) } });
  return out;
}

/** the order rows are read in (and the one best action is picked from): warn level first (a low row never outranks a warning, new or
 * not), then new first, then severity, then type order */
export function rankRows(rows) {
  const t = Object.fromEntries(GUARD_TYPES.map(([k], i) => [k, i]));
  return [...rows].sort((a, b) => WARNS(b.severity) - WARNS(a.severity) || (b.new === true) - (a.new === true) || SEV_RANK[a.severity] - SEV_RANK[b.severity] || t[a.type] - t[b.type] || String(a.id).localeCompare(String(b.id)));
}

const DAY = 86400000, dayOf = ms => new Date(ms).toISOString().slice(0, 10);
/**
 * guardView(rows with first_seen / new (crossings), { rules (the rule ledger counts), now, days = 30 }) ->
 * { types: [{ type, label, tab, open, warn, new }], rows (ranked), trend: { days, series: [{ key, label, points }] }, ledger, total, new }
 * The trend counts, per type and day, the findings open now that were first seen on or before that day: how the open pile grew.
 */
export function guardView(rows, { rules = null, now = Date.now(), days = 30, slop = true } = {}) {
  const ranked = rankRows(rows);
  // META-BETA-PREP (DIR-52): the project's SloppaChoppa switch off = no code (slop) type in the counts
  const types = GUARD_TYPES.filter(([type]) => slop || type !== 'code').map(([type, label, tab]) => {
    const r = rows.filter(x => x.type === type);
    return { type, label, tab, open: r.length, warn: r.filter(x => WARNS(x.severity)).length, new: r.filter(x => x.new && WARNS(x.severity)).length };
  });
  const axis = Array.from({ length: days }, (_, i) => dayOf(now - (days - 1 - i) * DAY));
  const series = GUARD_TYPES.filter(([type]) => rows.some(x => x.type === type)).map(([type, label]) => {
    const firsts = rows.filter(x => x.type === type).map(x => (x.first_seen ? x.first_seen.slice(0, 10) : axis.at(-1)));
    return { key: type, label, points: axis.map(d => ({ x: d, y: firsts.filter(f => f <= d).length })) };
  });
  return { types, rows: ranked, trend: { days: axis, series }, ledger: rules ? { ...rules } : null, total: rows.length, new: types.reduce((n, t) => n + t.new, 0) };
}
