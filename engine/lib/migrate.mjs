// S2 migration importer (META-GENERAL-DESIGN 11): today's OWNER-QUESTIONS / DIRECTIVES / DECISIONS-LOG / lanes / BUDGET -> records.
// Every event is written through record() as role `migration`; the legacy author is data.legacy_by. Text is kept byte-equal
// (data.legacy_text + data.source = FILE:line[-line]); any line or key the rules below do not map FAILS the whole import.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { record, loadState, recordsFile } from './records.mjs';
import { writeViews } from './views.mjs';

export class MigrationError extends Error { constructor(msg) { super(msg); this.code = 2; } }
const fail = msg => { throw new MigrationError(msg); };
const BY = 'migration';
const noBom = s => s.replace(/^\uFEFF/, '');
// No CRLF normalising: text stays byte-equal (DECISIONS-LOG l.196 ends in a stray CR).
const splitLines = s => { const L = noBom(s).split('\n'); if (L.at(-1) === '') L.pop(); return L; };
const src = (file, a, b = a) => `${file}:${a}${b !== a ? '-' + b : ''}`;

/** Read the legacy files: <dir>/OWNER-QUESTIONS.md, DIRECTIVES.md, BUDGET.json, lanes/*.json, DECISIONS-LOG.md (or opts.decisions). */
export function readSources(dir, { decisions } = {}) {
  const rd = f => noBom(fs.readFileSync(f, 'utf8'));
  const ld = path.join(dir, 'lanes');
  const lanes = {};
  for (const f of fs.readdirSync(ld).filter(f => f.endsWith('.json')).sort()) lanes[f.slice(0, -5)] = rd(path.join(ld, f));
  return { questions: rd(path.join(dir, 'OWNER-QUESTIONS.md')), directives: rd(path.join(dir, 'DIRECTIVES.md')),
    decisions: rd(decisions || path.join(dir, 'DECISIONS-LOG.md')), budget: rd(path.join(dir, 'BUDGET.json')), lanes };
}

// ---------- DECISIONS-LOG.md ----------
const tableAuthor = (date, question, choice, where) => {
  if (/^OWNER\b/.test(question) || /^OWNER\b/.test(choice)) return 'owner';
  if (/\bmeta(\s+\d\d:\d\dZ)?$/.test(date)) return 'checkin';
  if (/\ba\d+(\s+\d\d:\d\dZ)?$/.test(date)) return 'controller';
  return fail(`${where}: date cell ${JSON.stringify(date)} names no author (meta | aNN | OWNER)`);
};
const proseAuthor = (first, where) => /\bOWNER\b/.test(first) ? 'owner' : /\ba\d+\b/.test(first) ? 'controller' : /\bmeta\b/.test(first) ? 'checkin'
  : fail(`${where}: names no author (meta | aNN | OWNER)`);

function parseDecisions(text, file = 'DECISIONS-LOG.md') {
  const L = splitLines(text);
  if (!L[0]?.startsWith('# ') || !/^\| date \| lane \| question \| choice \+ why \| cost \|\s*$/.test(L[1] || '') || !/^\|(-+\|)+\s*$/.test(L[2] || ''))
    fail(`${file}: lines 1-3 are not the title + table header + separator`);
  const out = [];
  let open = null; // a ## section or a bullet still collecting continuation lines
  const close = () => { if (open) { out.push(open); open = null; } };
  for (let i = 3; i < L.length; i++) {
    const l = L[i], n = i + 1, where = `${file}:${n}`;
    if (l.trim() === '') { close(); continue; }
    if (l.startsWith('| ')) {
      close();
      const t = l.replace(/\s+$/, '');
      if (!t.endsWith(' |')) fail(`${where}: table row does not end with " |"`);
      const c = t.slice(2, -2).split(' | ');
      if (c.length < 3 || c.length > 5) fail(`${where}: ${c.length} cells (3-5 expected)`);
      const [date, lane, question, choice = '-', cost] = c;
      out.push({ a: n, b: n, form: 'row', data: { date, lane, question, choice, why: '-', ...(cost !== undefined ? { cost } : {}),
        legacy_by: tableAuthor(date, question, choice, where) } });
      continue;
    }
    if (l.startsWith('## ')) { close(); open = { a: n, b: n, form: 'section', head: l.slice(3), body: [] }; continue; }
    if (l.startsWith('- ') && (!open || open.form === 'bullet')) { close(); open = { a: n, b: n, form: 'bullet', head: l.slice(2), body: [] }; continue; }
    if (open && (open.form === 'section' || /^\s/.test(l))) { open.b = n; open.body.push(l); continue; }
    fail(`${where}: unmapped line (not a table row, ## section, bullet ruling, header or blank): ${l.slice(0, 80)}`);
  }
  close();
  return out.map(e => {
    if (e.form === 'row') return { ...e, data: { ...e.data, form: 'row', source: src(file, e.a), legacy_text: L[e.a - 1] } };
    const legacy_by = proseAuthor(e.head, src(file, e.a));
    const choice = e.form === 'bullet' && e.body.length === 0 ? '-' : e.body.join('\n');
    return { ...e, data: { form: e.form, lane: 'legacy', question: e.head, choice: choice || '-', why: '-', ...(e.form === 'section' ? { note: true } : {}),
      legacy_by, source: src(file, e.a, e.b), legacy_text: L.slice(e.a - 1, e.b).join('\n') } };
  });
}

// ---------- OWNER-QUESTIONS.md ----------
const QLINE = /^- (\d{4}-\d\d-\d\d)T(\d\d:\d\dZ) (.+?): (.*)$/;
const titleOf = body => {
  const m = body.match(/: |\. | - /);
  let t = (m ? body.slice(0, m.index) : body).trim();
  if (t.length > 120) t = t.slice(0, 117).replace(/\s+\S*$/, '') + '...';
  return t;
};

function parseQuestions(text, file = 'OWNER-QUESTIONS.md') {
  const L = splitLines(text);
  const items = []; // { type: question|fyi|answer|superseded, n, ... }
  L.forEach((l, i) => {
    const n = i + 1, where = `${file}:${n}`;
    if (l.trim() === '') return;
    const m = l.match(QLINE);
    if (!m) fail(`${where}: unmapped line (expected "- <UTC> <lane>: <text>")`);
    const [, date, time, head, body] = m;
    const base = { n, date, time, head, body, source: src(file, n), legacy_text: l };
    const ans = head.match(/^OWNER ANSWER \((.+)\)$/);
    if (ans) {
      const t = ans[1].match(/(?:(\d{4}-\d\d-\d\d)T)?(\d\d:\d\dZ)/);
      if (!t) fail(`${where}: the answer cites no question time`);
      const qs = items.filter(q => q.type === 'question' && q.time === t[2] && (!t[1] || q.date === t[1]));
      if (qs.length !== 1) fail(`${where}: the answer's citation "${ans[1]}" matches ${qs.length} questions (1 needed)`);
      if (items.some(x => x.q === qs[0] && x.type !== 'question')) fail(`${where}: ${qs[0].source} is answered twice`);
      if (/^SUPERSEDED\b/.test(body)) {
        const d = body.match(/DIRECTIVES (a\d+) ~(\d\d:\d\dZ)/);
        if (!d) fail(`${where}: SUPERSEDED names no directive ("DIRECTIVES aNN ~HH:MMZ")`);
        items.push({ ...base, type: 'superseded', q: qs[0], dir: { who: d[1], time: d[2] } });
      } else items.push({ ...base, type: 'answer', q: qs[0], choice: body.match(/^ACCEPTED\b[^(]*?\(([a-z])\)/)?.[1] });
      return;
    }
    const fyi = head.match(/^(\S+) \(FYI, ruled\b/);
    if (fyi) { items.push({ ...base, type: 'fyi', lane: fyi[1] }); return; }
    const q = head.match(/^([A-Za-z0-9_.-]+)( a\d+)?(?: \(([^()]+)\))?$/);
    if (!q) fail(`${where}: unmapped question head ${JSON.stringify(head)}`);
    items.push({ ...base, type: 'question', lane: q[1], author: q[2] ? 'controller' : 'checkin', ref: q[3] });
  });
  return items;
}

// ---------- DIRECTIVES.md ----------
// Supersessions the design (section 11) reads from the later lines' own words. Each matcher must hit exactly one entry.
const DIR_SUPERSEDES = [
  { by: /^OWNER a16 2026-10-30 ~22:25Z: CODEX BRAKE/, target: /^OWNER a14 2026-10-30 ~20:30Z: keep Codex at >= 4 runs/,
    why: "its own words: supersedes the a14 '>= 4 Codex runs' directive" },
  { by: /^OWNER a16 2026-10-30 ~22:25Z: CODEX BRAKE/, target: /^OWNER a15 2026-10-30 ~21:10Z: Codex usage RESET/,
    why: "the CODEX BRAKE voids a15's 'the >= 4 Codex runs DIRECTIVE binds again'" },
  { by: /^OWNER a16 2026-10-30 ~22:50Z \(amends the CODEX BRAKE above\)/, target: /^OWNER a16 2026-10-30 ~22:25Z: CODEX BRAKE/,
    why: 'its own words: amends the CODEX BRAKE (Codex = Sol only, max 2)' },
];

function parseDirectives(text, file = 'DIRECTIVES.md') {
  const L = splitLines(text);
  const es = [];
  L.forEach((l, i) => {
    const n = i + 1;
    if (l.trim() === '') return;
    if (l.startsWith('- ')) { es.push({ a: n, b: n }); return; }
    if (/^\s/.test(l) && es.length && es.at(-1).b === n - 1) { es.at(-1).b = n; return; }
    fail(`${file}:${n}: unmapped line (not "- " entry or its indented continuation)`);
  });
  return es.map(e => {
    const legacy_text = L.slice(e.a - 1, e.b).join('\n'), text = legacy_text.slice(2);
    const who = text.match(/^(OWNER|controller) (a\d+)\b/);
    if (!who) fail(`${src(file, e.a)}: entry names no author ("OWNER aNN" | "controller aNN")`);
    return { ...e, text, legacy_text, owner: who[1] === 'OWNER', who: who[2], source: src(file, e.a, e.b) };
  });
}

// ---------- lanes/*.json ----------
const parseTs = s => (s ? Date.parse(String(s).replace(/(\.\d{3})\d+/, '$1')) : NaN);

// ---------- BUDGET.json ----------
const ACCOUNT = ['max_claude_workers', 'max_codex', 'max_astra', 'max_sol', 'usage_rate_cap_pct_per_h', 'reset', 'calib_time_utc', 'calib_pct',
  'cacheR_per_pct', 'checkin_model', 'checkin_effort', 'claude_model', 'claude_effort', 'codex_astra_effort', 'codex_sol_effort'];
const POLICY = ['agents', 'executors', 'critical_lanes', 'critical_effort', 'fallbacks', 'context', 'iteration', 'cadence', 'speed_mode'];
const isObj = v => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;
const leaves = (o, p = []) => (isObj(o) ? Object.entries(o).flatMap(([k, v]) => leaves(v, [...p, k])) : [[p, o]]);
function budgetTarget(p) {
  const [a, b] = p;
  if (p.length === 1 && ACCOUNT.includes(a)) return ['budget', a];
  if (a === 'overnight_claude_slot' && p.length === 2) {
    if (b === 'weekly_stop_pct') return ['budget', b];
    if (['until_utc', 'max', 'order'].includes(b)) return ['policy', 'dispatch_window', b];
  }
  if (a === 'lanes') return ['policy', ...p];
  if (a === 'policy' && b === 'budget' && p.length === 3 && ['desired_burn_pct_per_h', 'reserve_pct_for_doors'].includes(p[2])) return ['budget', p[2]];
  if (a === 'policy' && POLICY.includes(b)) return ['policy', ...p.slice(1)];
  return fail(`BUDGET.json: unmapped key ${p.join('.')}`);
}
function mapBudget(text) {
  let old;
  try { old = JSON.parse(noBom(text)); } catch (e) { fail(`BUDGET.json: not JSON (${e.message})`); }
  const out = { budget: {}, policy: {} }, table = [];
  for (const [p, v] of leaves(old)) {
    const t = budgetTarget(p);
    let o = out;
    for (const k of t.slice(0, -1)) o = (o[k] ||= {});
    if (Object.hasOwn(o, t.at(-1))) fail(`BUDGET.json: ${p.join('.')} -> ${t.join('.')} collides`);
    o[t.at(-1)] = v;
    table.push({ from: p.join('.'), to: t.join('.') });
  }
  return { ...out, table };
}

// ---------- plan ----------
/** Pure: legacy texts -> ordered events (with predicted ids) + mapping rows + budget split. Throws MigrationError on any unmapped input. */
export function planMigration(s, { now = () => new Date(), project = 'legacy' } = {}) {
  const next = { decision: 0, question: 0, directive: 0, run: 0 };
  const id = (kind, pre) => `${pre}${++next[kind]}`;
  const events = [], rows = [];
  const push = (e, row) => { events.push(e); if (row) rows.push({ ...row, id: e.predicted || e.id }); };

  for (const d of parseDecisions(s.decisions))
    push({ kind: 'decision', ev: 'create', predicted: id('decision', 'DEC-'), data: d.data }, { source: d.data.source, event: `create (${d.form}, ${d.data.legacy_by})` });

  const qs = parseQuestions(s.questions);
  const dirs = parseDirectives(s.directives);
  const qid = new Map(), late = [];
  for (const q of qs) {
    const legacy = { source: q.source, legacy_text: q.legacy_text };
    if (q.type === 'question') {
      qid.set(q, id('question', 'Q-'));
      push({ kind: 'question', ev: 'create', predicted: qid.get(q), data: { title: ((q.ref ? q.ref + ': ' : '') + titleOf(q.body)).slice(0, 120), lane: q.lane, body: q.body, options: [],
        asked_utc: `${q.date}T${q.time}`, legacy_by: q.author, ...legacy } }, { source: q.source, event: 'create' });
    } else if (q.type === 'fyi') {
      push({ kind: 'decision', ev: 'create', predicted: id('decision', 'DEC-'), data: { lane: q.lane, question: titleOf(q.body), choice: q.body, why: '-',
        notify: true, legacy_by: 'controller', ...legacy } }, { source: q.source, event: 'create (FYI, notify)' });
    } else if (q.type === 'answer') {
      const target = qid.get(q.q);
      push({ kind: 'question', ev: 'answer', id: target, data: { ...(q.choice ? { choice: q.choice } : {}), text: q.body, via: 'chat',
        answered_utc: `${q.date}T${q.time}`, legacy_by: 'owner', ...legacy } }, { source: q.source, event: `answer${q.choice ? ' ' + q.choice : ''} + apply legacy` });
      push({ kind: 'question', ev: 'apply', id: target, data: { refs: ['legacy'] } });
    } else late.push(q);
  }
  const dirId = new Map();
  for (const d of dirs) {
    const data = { source: d.source, legacy_text: d.legacy_text };
    if (d.owner) {
      dirId.set(d, id('directive', 'DIR-'));
      push({ kind: 'directive', ev: 'create', predicted: dirId.get(d), data: { text: d.text, via: 'chat', legacy_by: 'owner', ...data } }, { source: d.source, event: 'create' });
    } else {
      push({ kind: 'decision', ev: 'create', predicted: id('decision', 'DEC-'), data: { lane: 'legacy', question: titleOf(d.text), choice: d.text, why: '-',
        form: 'directive-line', legacy_by: 'controller', ...data } }, { source: d.source, event: 'create (controller line, not an owner directive)' });
    }
  }
  const owned = dirs.filter(d => d.owner);
  const one = (re, what) => { const h = owned.filter(d => re.test(d.text)); if (h.length !== 1) fail(`DIRECTIVES.md: ${what} ${re} matches ${h.length} entries (1 needed)`); return h[0]; };
  const sups = [];
  owned.forEach((d, i) => { if (/\(supersedes the line above\)/.test(d.text)) { if (!i) fail(`${d.source}: supersedes a line above that does not exist`); sups.push([owned[i - 1], d, 'its own words: supersedes the line above']); } });
  for (const r of DIR_SUPERSEDES) sups.push([one(r.target, 'target'), one(r.by, 'citation'), r.why]);
  for (const [t, by, why] of sups) {
    const tid = dirId.get(t), bid = dirId.get(by);
    push({ kind: 'directive', ev: 'supersede', id: tid, data: { by: bid, why } });
    rows.push({ source: t.source, id: tid, event: `supersede by ${bid}` });
  }
  for (const q of late) {
    const d = owned.filter(x => new RegExp(`^OWNER ${q.dir.who} \\d{4}-\\d\\d-\\d\\d ~${q.dir.time}\\b`).test(x.text));
    if (d.length !== 1) fail(`${q.source}: "DIRECTIVES ${q.dir.who} ~${q.dir.time}" matches ${d.length} directives (1 needed)`);
    push({ kind: 'question', ev: 'supersede', id: qid.get(q.q), data: { by: dirId.get(d[0]), why: q.body, legacy_by: 'controller', source: q.source, legacy_text: q.legacy_text } },
      { source: q.source, event: `supersede by ${dirId.get(d[0])}` });
  }

  const t0 = now().getTime();
  for (const [name, text] of Object.entries(s.lanes)) {
    let j;
    try { j = JSON.parse(noBom(text)); } catch (e) { fail(`lanes/${name}.json: not JSON (${e.message})`); }
    const source = `lanes/${name}.json`;
    const running = j.end == null && j.exit == null;
    const ended = parseTs(j.end);
    if (!running && Number.isNaN(ended)) fail(`${source}: ended run without a parsable end time`);
    const brief_dir = j.brief ? path.win32.dirname(j.brief) : undefined;
    push({ kind: 'lane', ev: 'create', id: `L:${name}`, data: { name, worktree: j.worktree, notes: j.notes, ...(brief_dir ? { brief_dir } : {}), legacy: true, source } },
      { source, event: 'create' });
    if (!running && t0 - ended > 48 * 3600e3) { push({ kind: 'lane', ev: 'archive', id: `L:${name}`, data: { why: 'last run ended > 48 h before the migration' } }); rows.at(-1).event += ' + archive (> 48 h)'; }
    const rid = id('run', 'RUN-');
    push({ kind: 'run', ev: 'start', predicted: rid, data: { kind: 'worker', project, lane: name, executor: 'claude', agent: j.agent, model: j.model, effort: j.effort,
      worktree: j.worktree, brief: j.brief, notes: j.notes, log: j.log, final: j.final, pid: j.pid, auto_resumes: j.auto_resumes, started: j.start, legacy: true, source } },
    { source, event: running ? 'legacy RUN start (running)' : 'legacy RUN start + end' });
    if (!running) push({ kind: 'run', ev: 'end', id: rid, data: { exit: j.exit ?? null, outcome: 'legacy', ended: j.end } });
  }
  return { events, rows, budget: mapBudget(s.budget) };
}

// ---------- run ----------
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(o, null, 1) + '\n'); fs.renameSync(t, f); };

/**
 * Import into an EMPTY state dir. opts: { state, budgetOut, projectOut, project (the legacy runs' project; CLI default: the state dir name), views (paths), now, dryRun }.
 * dryRun imports into a temp dir (so every record() check runs), returns the same report, and deletes it.
 * Returns { rows (with final state), counts, budget, table (markdown) }.
 */
export function runMigration(s, opts = {}) {
  const plan = planMigration(s, opts);
  if (opts.dryRun) {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-migrate-dry-'));
    try { return runMigration(s, { ...opts, dryRun: false, state: t, budgetOut: path.join(t, 'budget.json'), projectOut: path.join(t, 'project.json'), views: undefined, map: false }); }
    finally { fs.rmSync(t, { recursive: true, force: true }); }
  }
  const state = opts.state;
  if (!state) fail('no state dir');
  if (fs.existsSync(state) && fs.readdirSync(state).length) fail(`state dir ${state} is not empty - the importer runs once, into an empty state`);
  let project = null;
  if (opts.projectOut && fs.existsSync(opts.projectOut)) {
    project = JSON.parse(noBom(fs.readFileSync(opts.projectOut, 'utf8')));
    for (const k of Object.keys(plan.budget.policy)) if (project.policy && Object.hasOwn(project.policy, k)) fail(`${opts.projectOut}: policy.${k} already set`);
  }
  if (opts.budgetOut && fs.existsSync(opts.budgetOut)) fail(`${opts.budgetOut} already exists`);
  const ropts = { views: false, run: null, now: opts.now };
  for (const e of plan.events) {
    const { predicted, ...ev } = e;
    const got = record(state, { ...ev, by: BY }, ropts);
    if (predicted && got.id !== predicted) fail(`id drift: expected ${predicted}, record() gave ${got.id}`);
  }
  const st = loadState(state);
  const v = writeViews(state, st, opts.views || {});
  if (v.refused.length) fail(`views refused (hand-edited / not generated by meta): ${v.refused.join(', ')} - move the old files aside first`);
  if (opts.budgetOut) writeJson(opts.budgetOut, plan.budget.budget);
  if (opts.projectOut) writeJson(opts.projectOut, project ? { ...project, policy: { ...(project.policy || {}), ...plan.budget.policy } } : { policy: plan.budget.policy });
  const items = Object.values(st.items), n = (k, f = () => true) => items.filter(i => i.kind === k && f(i)).length;
  const counts = { Q: n('question'), open: n('question', i => i.state === 'open'), DEC: n('decision'), DIR: n('directive'),
    active: n('directive', i => i.state === 'active'), L: n('lane'), RUN: n('run'), BUDGET: plan.budget.table.length };
  const rows = plan.rows.map(r => ({ ...r, final: st.items[r.id]?.state }));
  const table = ['| source | record | event | final state |', '|---|---|---|---|', ...rows.map(r => `| ${r.source} | ${r.id} | ${r.event} | ${r.final} |`), '',
    '| BUDGET.json key | target |', '|---|---|', ...plan.budget.table.map(t => `| BUDGET.json ${t.from} | ${t.to} |`), '',
    `${counts.Q} Q (${counts.open} open) · ${counts.DEC} DEC · ${counts.DIR} DIR (${counts.active} active) · ${counts.L} L · ${counts.RUN} RUN · ${counts.BUDGET} BUDGET keys`].join('\n') + '\n';
  if (opts.map !== false) fs.writeFileSync(path.join(state, 'migration-map.md'), table);
  return { rows, counts, budget: plan.budget, table, state: recordsFile(state) };
}

// ---------- local/machine.json -> the current shape (META-AGNOSTIC-EXEC round 2) ----------
// Drops the slots that moved out (MOVED_SLOTS: grok - its exe lives in the project's executors.grok.exe). The old file is kept as
// <file>.pre-migrate; the new one is written atomically. Nothing to drop = no write. Returns the report lines.
export function migrateMachine(file, { dryRun = false, moved = ['grok'] } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { fail(e.code === 'ENOENT' ? `no machine.json at ${file}` : e.message); }
  let obj;
  try { obj = JSON.parse(noBom(raw)); } catch (e) { fail(`${file}: ${e.message}`); }
  const hit = moved.filter(k => Object.hasOwn(obj, k));
  if (!hit.length) return [`${file}: nothing to migrate`];
  const lines = hit.map(k => `${dryRun ? 'would drop' : 'dropped'} ${k} (exe ${obj[k]?.exe ?? '-'}): the exe lives in the project's executors.${k}.exe`);
  if (dryRun) return lines;
  const next = Object.fromEntries(Object.entries(obj).filter(([k]) => !hit.includes(k)));
  fs.writeFileSync(file + '.pre-migrate', raw);
  fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 1) + '\n');
  fs.renameSync(file + '.tmp', file);
  return [...lines, `${file}: migrated (old file: ${path.basename(file)}.pre-migrate)`];
}
