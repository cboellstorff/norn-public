// META-GUARD R1 item 3 (DIR-23): brief drift at run end - read-only, no model call. The brief's numbered items vs the run's NOTES
// (claimed = the item's label, or most of its key words, appear in the NOTES; else not mentioned) and the files the branch changed
// outside the areas (paths) the brief names. A hint for the check-in (digest row 8), never a verdict.
import fs from 'node:fs';

const STOP = new Set(['about', 'after', 'again', 'their', 'there', 'these', 'those', 'which', 'while', 'where', 'every', 'never', 'other', 'under', 'within', 'without', 'should', 'would', 'could']);
const words = s => [...new Set(String(s).toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) || [])].filter(w => !STOP.has(w));

/** the numbered items of a brief: [{ n, label, text }] (continuation lines - indented, no new number or heading - joined) */
export function briefItems(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s{0,3}(\d{1,2})[.)]\s+(.+)$/);
    if (m) { cur = { n: Number(m[1]), text: m[2].trim() }; out.push(cur); continue; }
    if (cur && /^\s{2,}\S/.test(line) && !/^\s*(?:[-*]|#)/.test(line)) cur.text += ' ' + line.trim();
    else cur = null;
  }
  for (const it of out) {
    const up = it.text.match(/^([A-Z][A-Z0-9 /&-]{2,}?)(?:\s*\([^)]*\))?\s*:/);
    it.label = up ? up[1].trim() : it.text.split(/\s+/).slice(0, 6).join(' ').replace(/[.:;]+$/, '');
  }
  return out;
}

/** the repo-relative paths a brief names (absolute paths, URLs and bare words are not areas), in order of first mention */
export function briefAreas(text) {
  const out = [];
  for (const m of String(text).matchAll(/(?<![\w:/.~-])((?:[\w.-]+\/)+[\w.*-]*)/g)) {
    const p = m[1].replace(/[.,;:]+$/, '');
    if (!p.includes('/') || /^\d+\/\d+/.test(p) || out.includes(p)) continue;
    out.push(p);
  }
  return out;
}
const inside = (f, areas) => areas.some(a => f === a || f.startsWith(a.endsWith('/') ? a : a + '/'));

/** { brief (text), notes (text), files (changed, repo-relative) } -> { items [{ n, label, status }], areas, outside, hint | null } */
export function briefDrift({ brief = '', notes = '', files = [] } = {}) {
  const N = String(notes).toLowerCase(), have = new Set(words(notes));
  const items = briefItems(brief).map(it => {
    const kw = words(it.text).sort((a, b) => b.length - a.length).slice(0, 6);
    const hit = kw.filter(w => have.has(w)).length;
    const claimed = N.includes(it.label.toLowerCase()) || (kw.length > 0 && hit / kw.length >= 0.6);
    return { n: it.n, label: it.label, status: claimed ? 'claimed' : 'not mentioned' };
  });
  const areas = briefAreas(brief), outside = areas.length ? files.filter(f => !inside(f.replace(/\\/g, '/'), areas)) : [];
  const miss = items.filter(i => i.status !== 'claimed'), parts = [];
  if (miss.length) parts.push(`${miss.length} of ${items.length} brief items not mentioned in the NOTES (${miss.map(i => `${i.n}. ${i.label}`).join('; ')})`);
  if (outside.length) parts.push(`${outside.length} changed files outside the areas the brief names (${outside.slice(0, 6).join(', ')}${outside.length > 6 ? ', ...' : ''})`);
  return { items, areas, outside, hint: parts.length ? parts.join('; ') + ' - a hint, not a verdict' : null };
}

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
/** one ended run (a fold item) -> briefDrift + { run } | null (no brief / NOTES file). git(repo, args, { allowFail }) as dlvgit makeGit. */
export function runDrift(r, { git, main = 'main' } = {}) {
  const d = r.data || {}, e = r.end || {}, brief = d.brief && read(d.brief), notes = d.notes && read(d.notes);
  if (!brief || notes === null || notes === undefined) return null;
  let files = [];
  const wt = d.worktree, head = e.head || 'HEAD';
  if (wt && git) {
    const base = String(git(wt, ['merge-base', main, head], { allowFail: true }) || '').trim();
    if (base) files = String(git(wt, ['diff', '--name-only', base, head], { allowFail: true }) || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  return { run: r.id, ...briefDrift({ brief, notes, files }) };
}
