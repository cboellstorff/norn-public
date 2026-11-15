// META-UX-BUILD S3 (REPORT s.2, "Docs = the one reader"): the Docs file list = the project's own docs (project.json "docs") + every
// file the instruction scan finds, grouped by who loads it; each group capped (subviews.mjs capList) with its full count. A file is
// its own part (GET /api/docs?part=file&file=<key>, through ui.mjs loadParts); each scan finding sits beside its paragraph / line.
// The list and the findings come from the ONE instruction scan (server insCache); nothing here reads a file. Pure: the browser loads it.
import { capList, SUB_CAP } from './subviews.mjs';

/** [id, label] in the order the list shows them: who loads the file */
export const DOC_GROUPS = [['session', 'Loaded every session'], ['checkin', 'Check-ins read'], ['chat', 'The chat reads'], ['role', 'Roles load'],
  ['on-demand', 'Read on demand'], ['memory', 'Memory · the index and its topic files'], ['skills', 'Skills'], ['source', 'Sources (they generate files above)'],
  ['project', 'Project docs']];
const fwd = s => String(s ?? '').replace(/\\/g, '/').toLowerCase();
/** a project doc's key (its index in project.json "docs"); a scan file's key is its row id */
export const docKey = i => `doc-${i}`;

/** the group of one scan row: memory + its topic files, skills + their sources, else its load class */
export function groupOf(r) {
  if (r.kind === 'memory' || r.kind === 'memory-topic') return 'memory';
  if (r.kind === 'skill' || r.kind === 'skill-source') return 'skills';
  return DOC_GROUPS.some(([k]) => k === r.load) ? r.load : 'on-demand';
}
const note = r => [r.where === 'home' ? 'user' : '', r.role ? `role ${r.role}` : '', (r.harness || []).length === 1 && r.harness[0] !== 'claude' ? r.harness[0] : ''].filter(Boolean).join(', ');

/**
 * docsList({ v (the instruction view or null while the first scan runs), docs (project docs [{ i, tab, path, exists }]), limit })
 * -> { files (every file), groups: [{ id, label, n, rows: [{ key, name, note, path, tokens, findings, exists, linked? }] }] (capped,
 * empty groups left out), memory (the gauge numbers, no topic list) }. A project doc the scan also lists shows once, in its load group.
 */
export function docsList({ v = null, docs = [], limit = SUB_CAP } = {}) {
  const scanned = new Set((v?.rows || []).map(r => fwd(r.path)));
  const perPath = new Map();
  for (const f of v?.findings || []) for (const p of new Set([f.path, f.other].filter(Boolean).map(fwd))) perPath.set(p, (perPath.get(p) || 0) + 1);
  const linked = new Map((v?.memory_map?.topics || []).map(t => [t.id, t.linked]));
  const all = new Map(DOC_GROUPS.map(([k]) => [k, []]));
  for (const r of v?.rows || []) all.get(groupOf(r)).push({ key: r.id, name: r.name, note: note(r), path: r.path, tokens: r.tokens ?? null, findings: r.findings || 0, exists: !!r.exists,
    ...(r.kind === 'memory-topic' ? { linked: linked.get(r.id) ?? 0 } : {}) });
  for (const d of docs) if (!scanned.has(fwd(d.path))) all.get('project').push({ key: docKey(d.i), name: d.tab, note: '', path: d.path, tokens: null, findings: perPath.get(fwd(d.path)) || 0, exists: !!d.exists });
  const mem = all.get('memory'); mem.sort((a, b) => (a.linked === undefined ? -1 : b.linked === undefined ? 1 : 0));   // the index first
  const groups = DOC_GROUPS.filter(([k]) => all.get(k).length).map(([id, label]) => ({ id, label, ...capList(all.get(id), limit) }));
  const m = v?.memory_map;
  return { files: [...all.values()].reduce((n, xs) => n + xs.length, 0), groups,
    memory: m ? { lines: m.lines, kb: m.kb, max_lines: m.max_lines, max_kb: m.max_kb, topics: (m.topics || []).length, orphans: (m.orphans || []).length, broken: (m.broken || []).length } : null };
}

/** the first file a wide screen opens when the URL names none: the first one that exists */
export const firstDoc = list => list.groups.flatMap(g => g.rows).find(r => r.exists)?.key ?? null;

/**
 * placeFindings(paras [{ anchor, line, end }], findings [{ line? }]) -> { at: Map anchor -> findings, whole: findings }. A finding sits
 * beside the paragraph that holds its line (else the last one that starts before it); a finding with no line is about the whole file.
 */
export function placeFindings(paras = [], findings = []) {
  const at = new Map(), whole = [];
  for (const f of findings) {
    const L = Number(f.line);
    const p = L ? paras.find(x => x.line <= L && L <= x.end) ?? [...paras].reverse().find(x => x.line <= L) : null;
    if (p) { if (!at.has(p.anchor)) at.set(p.anchor, []); at.get(p.anchor).push(f); } else whole.push(f);
  }
  return { at, whole };
}

/** the same, by line (the Source view): Map line -> findings, + the whole-file ones */
export function findingsByLine(findings = [], lines = Infinity) {
  const at = new Map(), whole = [];
  for (const f of findings) { const L = Number(f.line); if (L >= 1 && L <= lines) { if (!at.has(L)) at.set(L, []); at.get(L).push(f); } else whole.push(f); }
  return { at, whole };
}
