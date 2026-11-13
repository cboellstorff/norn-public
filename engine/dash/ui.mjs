// Engine dashboard UI (META-GENERAL-DESIGN 7, 12-S7): pure renderers, data -> HTML strings, fed by the S6 /api endpoints.
// The same module runs in the browser (index.html imports /ui.mjs) and in node --test (server-side render check of the ids).
// Rules (section 7): status = text + colour (a chip always carries a word), numbers with units, ids everywhere, tabular
// numerals (CSS), one accent colour for "needs you", no animation and no timer (index.html re-renders from the /api/stream state stream).
import { renderMarkdown } from './docs.mjs';
import { parseLedger, ledgerInline, LEDGER_KINDS, recordBlocks } from './ledger.mjs';
import { renderAdopt, adoptStep } from './adopt.mjs';
import { renderHome } from './home.mjs';
export const TABS = [['home', 'Home'], ['overview', 'Overview'], ['inbox', 'Inbox'], ['lanes', 'Lanes'], ['agents', 'Agents'], ['map', 'Map'], ['roadmap', 'Roadmap'], ['plan', 'Plan'], ['records', 'Records'],
  ['usage', 'Usage'],
  ['docs', 'Docs'], ['instructions', 'Instructions'], ['ledger', 'Ledger'], ['settings', 'Settings']];
export const ONE_PROJECT = ['home', 'map', 'roadmap', 'records', 'docs', 'instructions', 'ledger', 'settings'];

// ---------- formatting ----------
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fin = v => typeof v === 'number' && Number.isFinite(v);
const dash = '<span class="mute">-</span>';
const int = n => fin(n) ? Math.round(n).toLocaleString('en-US') : '-';
const pct = (n, d = 1) => fin(n) ? `${n.toFixed(d)} %` : '-';
const kTok = n => fin(n) ? `${Math.round(n / 1000)}k` : '-';
const mTok = n => !fin(n) ? '-' : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`;
export function fmtMin(m) {
  if (!fin(m)) return '-';
  m = Math.max(0, Math.round(m));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
const minsSince = (iso, now) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? (now - t) / 60000 : null; };
// UTC times with a Z, ids and dates as the records carry them: today "02:14Z", older "10-30 22:20Z".
export function fmtTime(iso, now = Date.now()) {
  const t = Date.parse(iso ?? ''); if (!Number.isFinite(t)) return '-';
  const d = new Date(t), hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
  return new Date(now).toISOString().slice(0, 10) === d.toISOString().slice(0, 10) ? hm : `${d.toISOString().slice(5, 10)} ${hm}`;
}
const fmtLocal = iso => { const t = Date.parse(iso ?? ''); if (!Number.isFinite(t)) return '-';
  const d = new Date(t); return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} local`; };

// run name (META-UX-R1 C): stable human name next to the RUN id everywhere a run shows
const aname = n => n ? ` <b class="aname">${esc(n)}</b>` : '';
export const chip = (cls, txt) => `<span class="chip ${esc(cls)}">${esc(txt ?? cls)}</span>`;
// built-ins by name; every configured (typed) executor - API or cli - is an own-account executor ('prov')
const exClass = ex => String(ex ?? '').startsWith('codex') ? 'codex' : !ex || ['claude', 'fake'].includes(ex) ? 'claude' : 'prov';
export function exChip(ex, model, effort) {
  const t = [ex, model && ex && String(model).startsWith(ex + '-') ? String(model).slice(ex.length + 1) : model].filter(Boolean).join(' ') + (effort && effort !== '-' ? ` · ${effort}` : '');
  return t ? chip(exClass(ex), t) : dash;
}
export function bar(v, max, mark, cls = '') {
  if (!fin(v) || !fin(max) || max <= 0) return dash;
  return `<div class="bar ${cls}" title="${esc(v)} of ${esc(max)}"><i style="width:${Math.min(100, 100 * v / max).toFixed(1)}%"></i>${fin(mark) ? `<u style="left:${Math.min(100, 100 * mark / max).toFixed(1)}%"></u>` : ''}</div>`;
}
// Lane / run state text -> chip class + short word (lanes.mjs text grammar, design 5).
export function stateOf(text) {
  const t = String(text ?? '');
  if (t.startsWith('running')) return ['running', 'running'];
  if (t.startsWith('parked')) return ['parked', 'parked'];
  if (t === 'exited: DONE') return ['done', 'DONE'];
  if (t.startsWith('exited: STOPPED')) return ['stopped', 'STOPPED'];
  if (t.startsWith('exited: HANDOFF')) return ['handoff', 'HANDOFF'];
  if (t.startsWith('exited: no-marker')) return ['no-marker', 'no-marker'];
  if (t.startsWith('exited: crash')) return ['bad', 'crash'];
  if (t === 'lost') return ['lost', 'lost'];
  if (t.startsWith('killed')) return ['bad', 'killed'];
  if (t.startsWith('waiting')) return ['warn', 'waiting'];
  if (t === 'no runs') return ['idle', 'no runs'];
  return ['idle', t || '-'];
}
const runChip = s => chip({ running: 'running', exited: 'done', finished: 'done', alive: 'running', stopped: 'idle', lost: 'lost', killed: 'bad' }[s] ?? 'idle', s ?? '-');
const projTag = (ctx, p) => ctx.project === 'all' && p ? `<span class="id">${esc(p)}</span> ` : '';
const panel = (tab, html) => `<div id="panel-${tab}">${html}</div>`;
const oneProject = tab => panel(tab, `<div class="card"><p class="mute">Choose one project in the header: the ${esc(tab)} tab belongs to one project (its own records / files).</p></div>`);

export const needsCount = ov => (ov && fin(ov.needs_you) ? ov.needs_you : 0);
export const pageTitle = (n, project, look = 'classic') => `${n > 0 ? `(${n}) ` : ''}${look === 'norn' ? 'Norn' : 'norn'} - ${project === 'all' ? 'all projects' : project}`;
// Norn vocabulary (META-VISUAL-B S3, VISUAL-A2 CONCEPTS): display labels only - the Norn look groups the same tab ids under
// the three Norns; routes, record kinds and the CLI are unchanged. [key, name, what it shows, tab ids in display order]
export const NORN_GROUPS = [
  ['norn', 'Norn', 'the thread', ['home']],   // META-CONTROLLER C2 (Look 3, owner Q-25): the conversation is the home page
  ['verdandi', 'Verdandi', 'what is', ['overview', 'map', 'agents', 'lanes', 'usage']],
  ['urd', 'Urd', 'what was', ['records', 'ledger', 'docs', 'instructions']],
  ['skuld', 'Skuld', 'what shall be', ['plan', 'inbox', 'settings']],   // META-PLAN R1: the near term first
  ['wyrd', 'Wyrd', 'all three', ['roadmap']],   // META-ROADMAP S2: one roadmap row is all three at once (SPEC sec. 4 "Where it sits")
];
export const NORN_LORE = {
  verdandi: 'Verdandi - what is: the threads being spun at the Well of Urd right now.',
  urd: 'Urd - what was: every knot tied stays tied; the record cannot be unwoven.',
  skuld: 'Skuld - what shall be: the loose ends, the questions, the cloth not yet hung.',
  wyrd: 'Wyrd - all three: one thread from what was through what is to what shall be.',
};
const tabButton = (tab, counts) => ([k, l]) => `<button role="tab" id="tab-${k}" data-tab="${k}" aria-selected="${k === tab}">${esc(l)}${counts[k] ? `<span class="count" aria-label="${counts[k]} need you">${counts[k]}</span>` : ''}</button>`;
export function renderNav(tab, counts = {}, look = 'classic') {
  if (look !== 'norn') return TABS.map(tabButton(tab, counts)).join('');
  const label = Object.fromEntries(TABS);
  return NORN_GROUPS.map(([g, name, sub, ids]) => `<span class="ng ng-${g}" role="presentation"><span class="nh" aria-hidden="true"><span class="nn">${name}</span><small>${sub}</small></span>${ids.map(k => tabButton(tab, counts)([k, label[k]])).join('')}</span>`).join('');
}
// a picked art image (the asset map) - Norn look only, and only where the page passes its asset function (none in node)
const art = (ctx, name, cls = '') => (ctx.look === 'norn' && ctx.art ? ctx.art(name, cls) : '');

// ---------- data: one loader per tab over the S6 endpoints; get(path) -> JSON (throws on non-200) ----------
// the deliverables card is extra: a missing / failing /api/deliverables never breaks the tab
const dlvGet = (get, q) => Promise.resolve().then(() => get(`/api/deliverables?${q}`)).catch(() => null);
export async function loadTab(tab, project, get, ctx = {}) {
  // META-ADOPT A3: the setup page (not a nav tab) - Add a project with no project (or "+ Add a project"), else GET /api/adopt
  if (tab === 'adopt') {
    if (ctx.adoptScan) return ctx.adoptScan;
    if (!project || project === 'all' || ctx.adoptAdd) return { project: null, repos: (await get('/api/adopt/repos')).repos, projects: ctx.projects ?? [] };
    return get(`/api/adopt?project=${encodeURIComponent(project)}`);
  }
  const q = `project=${encodeURIComponent(project)}`, all = project === 'all';
  if (all && ONE_PROJECT.includes(tab)) return { one: true };
  if (tab === 'home') return get(`/api/home?${q}`);   // META-CONTROLLER C2
  if (tab === 'overview') {
    const [overview, agents, records, ledger, deliverables] = await Promise.all([get(`/api/overview?${q}`), get(`/api/agents?${q}`),
      all ? null : get(`/api/records?${q}`), all ? null : get(`/api/ledger?${q}`), dlvGet(get, q)]);
    return { overview, agents, records, ledger, deliverables };
  }
  if (tab === 'inbox') { const [ib, deliverables] = await Promise.all([get(`/api/inbox?${q}`), dlvGet(get, q)]); return { ...ib, deliverables }; }
  if (tab === 'lanes') return { ...(await get(`/api/lanes?${q}${ctx.allLanes ? '&all=1' : ''}`)), allLanes: !!ctx.allLanes };
  if (tab === 'map') return get(`/api/map?${q}${ctx.mapMore?.size ? `&more=${encodeURIComponent([...ctx.mapMore].join(','))}` : ''}${ctx.mapAll ? '&all=1' : ''}`);
  if (tab === 'agents') { const [a, o] = await Promise.all([get(`/api/agents?${q}`), get(`/api/overview?${q}`)]); return { ...a, top: o.burn.top }; }
  if (tab === 'records') return get(`/api/records?${q}`);
  if (tab === 'roadmap') {
    const d = await get(`/api/roadmap?${q}`);
    if (d && !d.error && !(d.themes || []).length) {   // META-ADOPT A3: an empty roadmap names what the repository holds and offers the draft
      const a = await Promise.resolve().then(() => get(`/api/adopt?${q}`)).catch(() => null);
      const f = a?.facts;
      if (f) d.adopt = { plans: (f.plans || []).length, items: (f.plans || []).reduce((n, p) => n + p.items, 0), branches: (f.branches || []).filter(b => !b.merged).length };
    }
    return d;
  }
  if (tab === 'docs') {
    const { docs } = await get(`/api/docs?${q}`);
    const pickI = docs.some(d => d.i === ctx.doc && d.exists) ? ctx.doc : docs.find(d => d.exists)?.i;
    return { docs, doc: pickI === undefined ? null : await get(`/api/docs/${pickI}?${q}`) };
  }
  if (tab === 'instructions') {   // META-INSTRUCTIONS R1
    const v = await get(`/api/instructions?${q}`);
    const pick = ctx.ins && (v.rows || []).some(r => r.id === ctx.ins && r.exists) ? ctx.ins : null;
    return { ...v, file: pick ? await get(`/api/instructions/${encodeURIComponent(pick)}?${q}`) : null };
  }
  if (tab === 'ledger') return get(`/api/ledger?${q}${ctx.ledgerN ? `&count=${ctx.ledgerN}` : ''}`);
  if (tab === 'settings') {   // C6: /api/remote exists only while dash.remote is on (404 = off)
    const [d, remote] = await Promise.all([get(`/api/settings?${q}`), get('/api/remote').catch(() => null)]);
    return { ...d, remote: remote?.on === true ? remote : null };
  }
  if (tab === 'usage') return get(`/api/usage?${q}`);
  if (tab === 'plan') return get(`/api/plan?${q}`);
  throw new Error('unknown tab ' + tab);
}

// ---------- tabs ----------
export function renderTab(tab, d, ctx = {}) {
  if (tab === 'adopt') return panel(tab, renderAdopt(adoptStep(d, ctx.adoptAsk), d, ctx));
  if (d?.one) return oneProject(tab);
  const now = ctx.now ?? Date.now();
  if (tab === 'usage') return panel(tab, usage(d, { ...ctx, now }));
  if (tab === 'plan') return panel(tab, plan(d, { ...ctx, now }));
  if (tab === 'home') return panel(tab, renderHome(d, { ...ctx, now }));
  return panel(tab, ({ overview, inbox, lanes, agents, map, roadmap, records, docs, instructions, ledger, settings })[tab](d, { ...ctx, now }));
}

// OOTB-R2 N-5: runs held for a login (the command to type, the held runs, the failing line)
const loginRow = (i, ctx) => `<div class="item">${chip('needs', i.id)}<div><b>${esc(i.title)}</b><div class="small mute">${projTag(ctx, i.project)}${i.cls === 'vendor' ? 'nothing to do - a vendor outage, not your login' : `open a terminal and run <span class="mono">${esc(i.command)}</span>`}; held: ${esc((i.runs || []).join(', '))} - they resume by themselves${i.line ? ` · "${esc(i.line)}"` : ''}</div></div></div>`;
function needItem(i, ctx) {
  const ago = fmtMin(minsSince(i.created, ctx.now));
  if (i.type === 'question') {
    const rec = i.recommend ? (i.options || []).find(o => (o.key ?? o.k) === (i.recommend.key ?? i.recommend.k)) : null;
    return `<div class="item">${chip('open', i.id)}<div><b>${esc(i.title)}</b><div class="small mute">${projTag(ctx, i.project)}${esc(i.lane ?? '-')} · asked ${ago} ago${i.class ? ` · class ${esc(i.class)}` : ''}</div>
      ${rec ? `<div class="small">Recommended <b>(${esc(rec.key ?? rec.k)})</b> ${esc(rec.text ?? rec.t)}</div>` : ''}</div><span class="spacer"></span><button class="primary" data-tab="inbox">Answer</button></div>`;
  }
  if (i.type === 'setup') return setupRow(i, ctx);
  if (i.type === 'login') return loginRow(i, ctx);
  if (i.type === 'parked') return `<div class="item">${chip('parked', i.id)}<div><b>lane ${esc(i.id.slice(2))} parked</b><div class="small mute">${projTag(ctx, i.project)}${i.q ? `by ${esc(i.q)}` : esc(i.why ?? 'no reason recorded')}</div></div></div>`;
  const [cls] = stateOf(i.state === 'exited' ? `exited: ${String(i.outcome).toUpperCase()}` : i.state);
  return `<div class="item">${chip(cls === 'idle' ? 'stopped' : cls, i.id)}<div><b>${esc(i.lane ?? 'run')} ${esc(String(i.outcome ?? i.state).toUpperCase())}${i.why ? `: ${esc(i.why)}` : ''}</b><div class="small mute">${projTag(ctx, i.project)}${aname(i.name)} unreviewed - no review event yet</div></div></div>`;
}

// META-ADOPT A3: ONE needs-you row while a drafted setup waits (Review / Not now = a close with the reason)
const setupRow = (i, ctx) => `<div class="item">${chip('open', i.id)}<div><b>${esc(i.title)}</b><div class="small mute">${projTag(ctx, i.project)}drafted ${fmtMin(minsSince(i.created, ctx.now))} ago · nothing is applied before you approve it</div></div><span class="spacer"></span><button class="primary" data-act="adopt-review" data-project="${esc(i.project)}">Review</button><button data-act="adopt-notnow" data-project="${esc(i.project)}">Not now</button></div>`;
// META-ADOPT A3 (SPEC sec. 5): the setup gaps of one project - each names what is missing in one line and offers the next action
function setupGaps(g) {
  if (!g) return '';
  const p = esc(g.project), rows = [];
  const row = (what, text, acts) => rows.push(`<div class="item">${chip('warn', what)}<div><b>${text}</b><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${acts}</div></div></div>`);
  if (!g.roadmap) row('roadmap', 'No roadmap yet.', `<button data-act="adopt-open" data-project="${p}">Draft it from the repository</button><button class="ghost" data-tab="roadmap">Open the roadmap</button>`);
  if (!g.rules) row('rules', `No project rules yet. Workers follow the repo's own ${esc((g.agent_files || []).join(', ') || 'instruction files')}.`,
    `<button data-act="adopt-open" data-project="${p}">Draft them</button><button class="ghost" data-act="adopt-rule" data-project="${p}">Write one rule</button>`);
  if (!g.caps_chosen && !g.caps_kept) row('caps', 'Starter caps are in force. Nobody chose them. The scheduler stays off until then.',
    `<button data-tab="settings">Choose a profile</button><button class="ghost" data-act="adopt-caps-keep" data-project="${p}">Keep the starter caps</button>`);
  if (!g.gate) row('merge gate', `Merges are not gated. ${g.found_gate ? `The scan found <span class="mono">${esc(g.found_gate)}</span>.` : 'No test command is on record.'}`,
    `<button data-act="adopt-open" data-project="${p}">Set it</button>`);
  return rows.length ? `<section class="card" id="setup-gaps" style="margin-bottom:12px"><h2>Set up ${p}</h2>${rows.join('')}</section>` : '';
}
// META-OOTB F-1: a project with no records yet - one text box = an owner directive + lane `first` with its own worktree and branch
const capShown = v => (v === null || v === undefined ? 'unset (no limit)' : String(v));
function firstTask(f) {
  if (!f) return '';
  const c = f.caps || {}, unit = (v, u) => (v === null || v === undefined ? capShown(v) : `${v} ${u}`);
  return `<section class="card" id="first-task" style="margin-bottom:12px"><h2>Give Norn its first task</h2>
   <p class="small mute">Say in one sentence what Norn should do in <b>${esc(f.project)}</b>. It is recorded as your directive, lane <b>${esc(f.lane)}</b> gets its own git worktree on branch <span class="mono">norn/${esc(f.lane)}</span> and a first brief, and the next check-in picks it up.</p>
   <div style="display:flex;gap:8px;flex-wrap:wrap"><input type="text" id="first-task-text" placeholder="e.g. Add a usage section to the README" style="flex:1;min-width:260px"><button class="primary" data-act="first-task" data-project="${esc(f.project)}">Start</button></div>
   <p class="small" style="margin:10px 0 0">Or let Norn look at the repo and draft a roadmap, rules and a first task <button data-tab="adopt">Look at the repo</button></p>
   <div class="small mute" style="margin-top:8px">Caps in force: <b>${esc(capShown(c.max_claude_workers))}</b> Claude worker(s) · <b>${esc(capShown(c.max_codex))}</b> Codex · weekly stop <b>${esc(unit(c.weekly_stop_pct, '%'))}</b> · rate cap <b>${esc(unit(c.usage_rate_cap_pct_per_h, '%/h'))}</b> (Settings, Workers &amp; budget)</div></section>`;
}
function overview(d, ctx) {
  const o = d.overview, tree = d.agents?.tree || [], byId = Object.fromEntries(tree.map(n => [n.id, n]));
  const top = Object.fromEntries((o.burn.top || []).map(t => [t.id, t]));
  const needs = o.needs.length ? o.needs.map(i => needItem(i, ctx)).join('') : `<div class="item">${art(ctx, 'empty-nothing-needs-you', 'empty')}${chip('ok', 'all clear')}<span>Nothing needs you</span></div>`;
  const rows = o.running.lanes.map(l => {
    const n = byId[l.run] || {}, age = n.age_min, b = n.budget_min, ck = fin(n.ctx) ? n.ctx / 1000 : null, lk = fin(n.ctx_limit) ? n.ctx_limit / 1000 : null;
    const ageCell = fin(b) ? `${bar(age, b * 2, b, age > b ? 'hot' : '')}<div class="small mute">${fmtMin(age)} / budget ${b} min</div>` : `<div class="small mute">${fmtMin(age)} (no time budget)</div>`;
    const ctxCell = ck === null ? `<span class="small mute">${String(n.executor ?? '').startsWith('codex') ? 'n/a (codex: tokens at end)' : '-'}</span>`
      : `${bar(ck, Math.max(150, ck), lk, lk && ck > lk ? 'hot' : '')}<div class="small mute">${kTok(n.ctx)} ctx${lk ? ` / hand-off ${lk}k` : ''}</div>`;
    return `<tr id="run-${esc(l.run)}"><td><b>${projTag(ctx, l.project)}${esc(l.name)}</b><div class="small mute"><span class="id">${esc(l.run)}</span>${aname(l.run_name ?? n.name)}${n.stage ? ' ' + esc(n.stage) : ''}</div></td>
      <td>${exChip(n.executor ?? l.executor, n.model, n.effort)}</td><td style="width:24%">${ageCell}</td><td style="width:22%">${ctxCell}</td>
      <td class="mono">${fin(top[l.run]?.pct_per_h) ? top[l.run].pct_per_h.toFixed(2) + ' %/h' : '-'}</td></tr>`;
  }).join('') || `<tr><td colspan="5" class="mute">${art(ctx, 'empty-no-runs', 'empty')}No lane is running.</td></tr>`;
  const u = o.burn.usage, used = u.weeklyUsed, stop = u.weeklyStopPct;
  const guardChip = u.guard === 'STOP' ? chip('bad', 'guard tripped: no new Claude worker') : u.guard === 'ok' ? chip('ok', 'under guard') : chip('idle', 'guard unknown');
  const rateChip = u.rateOK === false ? chip('bad', 'over cap: Claude dispatch off') : u.rateOK === true ? chip('ok', 'under cap') : '';
  const trip = fin(used) && fin(stop) && fin(u.rate) && u.rate > 0 && used < stop
    ? (() => { const h = (stop - used) / u.rate; return `in ~${h.toFixed(1)} h · <b>${esc(fmtLocal(new Date(ctx.now + h * 3600000).toISOString()))}</b>`; })()
    : fin(used) && fin(stop) && used >= stop ? '<b>tripped</b>' : '<span class="mute">- (no trailing rate)</span>';
  const provLine = (o.burn.executors || []).length ? `<div class="small mute" id="exec-usage" style="margin-top:8px">Own-account executors (7 days, not in burn): ${o.burn.executors.map(x => `<b>${esc(x.name)}</b> ${x.runs} runs ${mTok(x.tokens)} tok${x.cost_usd ? ` $${x.cost_usd.toFixed(2)}` : ''}`).join(' · ')}</div>` : '';
  const burners = (o.burn.top || []).map(t => `<div class="item"><span class="mono" style="width:76px">${fin(t.pct_per_h) ? t.pct_per_h.toFixed(2) + ' %/h' : mTok(t.burn30)}</span><span class="small"><span class="id">${esc(t.id)}</span> ${projTag(ctx, t.project)}${esc(t.lane ?? '')}</span></div>`).join('')
    || '<div class="small mute">no cache reads in the last 30 min</div>';
  const recs = d.records ? [...d.records.decisions, ...d.records.directives].sort((a, b) => String(b.updated).localeCompare(String(a.updated))).slice(0, 5)
    .map(r => `<tr><td class="id">${esc(r.id)}</td><td>${chip(r.state)}</td><td>${r.kind === 'decision' ? `<b>${esc(r.data.lane ?? '')}</b> ${esc(r.data.question ?? '')}<div class="small mute">${esc(r.data.choice ?? '')}${r.data.why ? ' - ' + esc(r.data.why) : ''}</div>` : esc(r.data.text)}</td><td class="small mute">${esc(r.by)} ${fmtTime(r.updated, ctx.now)}</td></tr>`).join('') : '';
  const led = d.ledger ? ledgerRows(parseLedger(d.ledger.ledger).slice(-4), d.ledger, ctx, true) : '';
  const hero = ctx.look === 'norn' && ctx.art ? `<div class="hero">${art(ctx, 'hero-night', 'hero-n')}${art(ctx, 'hero-day', 'hero-d')}<div class="lore">${NORN_GROUPS.filter(([g]) => NORN_LORE[g]).map(([g]) => `<p>${esc(NORN_LORE[g])}</p>`).join('')}</div></div>` : '';
  return `${hero}${firstTask(o.first_run)}${setupGaps(o.setup)}<div class="glance">
   <section class="card${o.needs_you ? ' needs' : ''}" id="needs"><h2>Needs you <b>${o.needs_you}</b></h2>${needs}</section>
   <section class="card" id="running"><h2>Running <b>${o.running.claude.n}/${o.running.claude.cap ?? '-'}</b> Claude · <b>${o.running.codex.n}/${o.running.codex.cap ?? '-'}</b> Codex</h2>
     <table><thead><tr><th>lane</th><th>executor</th><th>age vs time budget (mark = budget, end = 2x)</th><th>context</th><th>burn</th></tr></thead><tbody>${rows}</tbody></table></section>
   <section class="card" id="burn"><h2>Burn</h2>
     <div class="kv"><span class="mute small">weekly</span><div><span class="big">${pct(used)}</span> <span class="mute">of ${pct(stop, 0)} guard</span> ${guardChip}${bar(used, 100, stop, fin(used) && fin(stop) && used > stop - 10 ? 'hot' : '')}</div>
     <span class="mute small">trailing 2 h</span><div><b>${fin(u.rate) ? u.rate.toFixed(2) + ' %/h' : '-'}</b> <span class="mute">vs cap ${fin(u.cap) ? u.cap.toFixed(2) + ' %/h' : '-'}</span> ${rateChip}</div>
     <span class="mute small">guard trips</span><div>${trip}</div>
     <span class="mute small">reset</span><div>${esc(fmtLocal(u.resetAt))}</div>
     <span class="mute small">source</span><div class="small mute">${esc(u.source)}${u.source === 'live' && u.estimate && fin(u.estimate.weekly) ? ` (estimate ${pct(u.estimate.weekly)})` : ''}</div></div>
     <h2 style="margin-top:14px">Top burners (last 30 min)</h2>${burners}${provLine}</section></div>
   ${d.deliverables ? deliverablesCard(d.deliverables, ctx) : ''}
   ${d.records ? `<div class="grid2"><div class="tablecard"><h3>Latest records <span class="mute small">newest first</span></h3><table><tbody>${recs || '<tr><td class="mute">no records yet</td></tr>'}</tbody></table></div>
   <div class="tablecard"><h3>Ledger <span class="mute small">last 4 entries, newest first</span></h3><table class="ledtab compact"><tbody>${led || '<tr><td class="mute">no ledger file</td></tr>'}</tbody></table></div></div>` : ''}`;
}

function inbox(d, ctx) {
  const items = d.items || [];
  const qs = items.filter(i => i.type === 'question').map(q => {
    const rk = q.recommend ? q.recommend.key ?? q.recommend.k : null, opts = q.options || [];
    return `<article class="q openq" id="q-${esc(q.id)}"><div style="display:flex;gap:10px;align-items:center">${chip('open', q.id + ' open')}<b style="font-size:15px">${esc(q.title)}</b><span class="spacer"></span><span class="small mute">${projTag(ctx, q.project)}${esc(q.lane ?? '-')} · ${fmtMin(minsSince(q.created, ctx.now))} ago${q.class ? ` · class ${esc(q.class)}` : ''}</span></div>
    ${q.body ? `<p style="margin:8px 0">${esc(q.body)}</p>` : ''}
    ${opts.length ? `<div class="opts">${opts.map(o => { const k = o.key ?? o.k; return `<div class="opt ${k === rk ? 'rec' : ''}"><b>(${esc(k)})</b> ${esc(o.text ?? o.t)}${o.cost ?? o.c ? `<div class="small mute">cost: ${esc(o.cost ?? o.c)}</div>` : ''}</div>`; }).join('')}</div>` : ''}
    ${rk ? `<p class="small" style="margin:8px 0 10px"><b>Recommendation (${esc(rk)}):</b> ${esc(q.recommend.why ?? '')}</p>` : ''}
    ${q.answered_by ? `<div class="card needs" style="margin:8px 0;padding:8px 10px"><span class="small">Possibly answered in <b class="mono">${esc(q.answered_by.id)}</b>${q.answered_by.words ? `: <q>${esc(q.answered_by.words)}</q>` : ` (${esc(q.answered_by.why ?? '')})`}</span>
      ${q.answered_by.words ? `<button class="primary" style="margin-left:8px" data-act="answer-from" data-project="${esc(q.project)}" data-id="${esc(q.id)}" data-from="${esc(q.answered_by.id)}">Yes - already answered in ${esc(q.answered_by.id)}</button>` : ''}</div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${opts.map(o => { const k = o.key ?? o.k; return `<button class="${k === rk ? 'primary' : ''}" data-act="answer" data-project="${esc(q.project)}" data-id="${esc(q.id)}" data-choice="${esc(k)}" data-text="${esc(`(${k}) ${o.text ?? o.t ?? ''}`)}">Choose (${esc(k)})${k === rk ? ' - recommended' : ''}</button>`; }).join('')}
    <input type="search" id="ans-${esc(q.id)}" placeholder="or answer in your words ..." style="flex:1;min-width:220px"><button data-act="answer-text" data-project="${esc(q.project)}" data-id="${esc(q.id)}">Send</button></div>
    <div class="small mute" style="margin-top:6px">Writes <span class="mono">answer ${esc(q.id)}</span> (by dashboard). The next tick applies it${q.lane ? ` and unparks ${esc(q.lane)}` : ''}.</div></article>`;
  }).join('') || `<div class="card" style="margin-bottom:12px">${art(ctx, 'empty-no-questions', 'empty')}${chip('ok', 'all clear')} <span>No open question.</span></div>`;
  const dlvCard = (items.some(i => i.type === 'setup' || i.type === 'login') ? `<section class="card needs" style="margin-bottom:12px">${items.filter(i => i.type === 'login').map(i => loginRow(i, ctx)).join('')}${items.filter(i => i.type === 'setup').map(i => setupRow(i, ctx)).join('')}</section>` : '')
    + (d.deliverables ? `<div style="margin-bottom:12px">${deliverablesCard(d.deliverables, ctx)}</div>` : '');
  const row = (i, st, what) => `<tr id="in-${esc(i.id)}"><td class="id">${esc(i.id)}</td><td>${st}</td><td>${projTag(ctx, i.project)}${what}</td></tr>`;
  const other = [
    ...items.filter(i => i.type === 'parked').map(i => row(i, chip('parked'), `lane <b>${esc(i.id.slice(2))}</b> ${i.q ? `parked by ${esc(i.q)}` : esc(i.why ?? '')}`)),
    ...items.filter(i => i.type === 'unreviewed').map(i => row(i, chip(stateOf(i.state === 'exited' ? `exited: ${String(i.outcome).toUpperCase()}` : i.state)[0], String(i.outcome ?? i.state).toUpperCase()),
      `<b>${esc(i.lane ?? '-')}</b> ${esc(i.why ?? '')}<div class="small mute">${aname(i.name)} unreviewed: ended with no review event</div>`)),
    ...items.filter(i => i.type === 'answered').map(i => row(i, chip('answered'), `${esc(i.title)}<div class="small mute">${esc(i.answer?.text ?? '')} · ${fmtTime(i.updated, ctx.now)} · waits for the next tick to apply</div>`)),
  ].join('');
  return `<div class="legend small mute">States: ${['open', 'answered', 'applied', 'superseded', 'withdrawn'].map(s => chip(s)).join(' ')} - set by explicit events only; this page never guesses.</div>${qs}${dlvCard}
   <div class="tablecard"><h3>Also needs a look <span class="mute small">parked lanes · unreviewed runs · answered, not yet applied</span></h3><table><thead><tr><th>id</th><th>state</th><th>what</th></tr></thead><tbody>${other || '<tr><td colspan="3" class="mute">nothing</td></tr>'}</tbody></table></div>`;
}

function lanes(d, ctx) {
  const rows = (d.lanes || []).map(l => {
    const [cls, word] = stateOf(l.text), log = l.run ? `<a href="/log?run=${encodeURIComponent(l.run)}&project=${encodeURIComponent(l.project)}" target="_blank"><button>Log</button></a>` : '';
    const act = cls === 'running' ? `${log} <button data-act="stop" data-project="${esc(l.project)}" data-run="${esc(l.run)}">Stop</button>`
      : l.state === 'parked' ? `<button data-tab="inbox">Open Q</button>` : l.state !== 'archived' ? `${log} <button class="ghost" data-act="archive" data-project="${esc(l.project)}" data-lane="${esc(l.name)}">Archive</button>` : log;
    return `<tr id="lane-${esc(l.name)}"><td><b>${projTag(ctx, l.project)}${esc(l.name)}</b><div class="id">${esc(l.id)}</div></td><td>${chip(l.state)}</td><td>${chip(cls, word)}</td>
      <td>${l.executor ? chip(exClass(l.executor), l.executor) : dash}</td><td>${esc(l.text)}</td><td><span class="id">${esc(l.run ?? '-')}</span>${l.run_name ? `<div>${aname(l.run_name)}</div>` : ''}</td><td>${act}</td></tr>`;
  }).join('') || '<tr><td colspan="7" class="mute">No LANE records.</td></tr>';
  return `<div class="banner">Lanes come from LANE records only (no folder scan); state = the latest run on the lane, whatever executor owns the tree.</div>
   <div class="filters"><input type="search" data-filter="lanes" placeholder="filter lanes"><label class="small"><input type="checkbox" data-act="lanes-all"${d.allLanes ? ' checked' : ''}> show done / archived</label></div>
   <div class="tablecard"><table data-rows="lanes"><thead><tr><th>lane</th><th>record</th><th>run state</th><th>executor</th><th>now</th><th>latest run</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function agents(d, ctx) {
  const top = Object.fromEntries((d.top || []).map(t => [t.id, t]));
  const name = n => n.kind === 'subagent' ? `${esc(n.agentType ?? 'subagent')}${n.description ? ` "${esc(n.description)}"` : ''}`
    : n.kind === 'helper' ? `<span class="id">${esc(n.id)}</span>${aname(n.name)} helper${n.class ? ' · ' + esc(n.class) : ''}${n.q ? ` "${esc(n.q)}"` : ''}${n.outcome ? ' · ' + esc(String(n.outcome).toUpperCase()) : ''}`
    : `<span class="id">${esc(n.id)}</span>${aname(n.name)} ${esc(n.lane ?? '')}${n.stage ? ' · ' + esc(n.stage) : ''}${n.outcome ? ' · ' + esc(String(n.outcome).toUpperCase()) : ''}${n.helpers ? ` · helpers ${n.helpers.n}${n.helpers.running ? ` (${n.helpers.running} running)` : ''}, ${int(n.helpers.tokens)} tok` : ''}`;
  const tok = n => n.tokens === '-' ? '-' : fin(n.tokens) ? `${int(n.tokens)}${n.tokens_src ? ` (${esc(n.tokens_src)})` : ''}` : fin(n.cacheR) ? `${mTok(n.cacheR)} cacheR` : String(n.executor ?? '').startsWith('codex') ? 'at end' : '-';
  const age = n => fin(n.age_min) ? fmtMin(n.age_min) : n.first ? fmtMin(minsSince(n.first, ctx.now)) : n.started ? fmtMin(minsSince(n.started, ctx.now)) : '-';
  const one = (n, lvl, kids, pid) => {
    const ck = fin(n.ctx) ? n.ctx / 1000 : null, lk = fin(n.ctx_limit) ? n.ctx_limit / 1000 : null, b = top[n.id];
    const feed = /^RUN-\d+$/.test(n.id) ? ` data-feed="${esc(n.id)}" data-project="${esc(n.project)}" title="Open the live feed"` : '';
    return `<div class="node lvl${lvl}" id="node-${esc(n.id)}"${lvl ? ` data-p="${esc(pid)}"` : ''}${feed}><div class="name">${kids ? `<span class="caret" data-t="${esc(pid)}">&#9662;</span>` : '<span class="caret"></span>'}${chip(n.kind === 'subagent' ? 'idle' : exClass(n.executor), n.kind ?? 'run')}<span class="t">${projTag(ctx, n.project)}${name(n)}</span>${(n.guard || []).map(g => `<span class="guard-chip" title="${esc(`${g.id}: ${g.why}`)}">${chip(g.state === 'ruled' ? 'idle' : g.cls === 'runaway' ? 'bad' : 'warn', `${g.cls}${g.action ? ': ' + g.action : ''}`)}</span>`).join('')}</div>
     <div>${exChip(n.kind === 'subagent' ? null : n.executor, n.model, n.effort)}</div><div>${runChip(n.state)}</div><div class="small">${age(n)}</div><div class="mono small">${tok(n)}</div>
     <div>${ck === null ? dash : `${bar(ck, Math.max(150, ck), lk, lk && ck > lk ? 'hot' : '')}<span class="small mute">${kTok(n.ctx)}${lk ? ` / ${lk}k` : ''}</span>`}</div><div class="mono small">${fin(b?.pct_per_h) ? b.pct_per_h.toFixed(2) + ' %/h' : fin(n.burn30) && n.burn30 > 0 ? mTok(n.burn30) + ' /30 min' : '-'}</div></div>`;
  };
  const tree = d.tree || [], rows = tree.map(n => one(n, 0, (n.children || []).length, 'p-' + n.id) + (n.children || []).map(k => one(k, 1, false, 'p-' + n.id)).join('')).join('')
    || '<div class="node"><div class="mute">No running or recent (2 h) sessions.</div></div>';
  const by = k => tree.filter(n => exClass(n.executor) === k).length;
  return `<div class="legend small mute"><span>Tree = every run of the last 2 h (workers, check-ins, Codex, own-account executors), talk sessions and their subagents. Click a run for its live feed.</span>
    <span>Sources: RUN records + transcript <span class="mono">&lt;session&gt;.jsonl</span>, <span class="mono">subagents/agent-*.meta.json</span>, Codex log banner / rollout.</span></div>
   <div class="tree"><div class="node head"><div>session</div><div>model · effort</div><div>state</div><div>age</div><div>tokens</div><div>context (mark = hand-off)</div><div>burn</div></div>${rows}</div>
   <p class="small mute">Sessions: Claude ${by('claude')} · Codex ${by('codex')} · own-account ${by('prov')}. Runs waiting to start: the Plan tab.</p>`;
}
// ---------- the Plan tab (META-PLAN R1, norn DIR-13): what happens next, and when - /api/plan = engine/lib/plan.mjs per project ----------
// Up next (the queue in fill order, hold-ups in plain words; it moved here from Agents), Chains (one line per dependency chain), Landing
// next (heading to main), Forecast (usage now vs the cap and the weekly stop). Status shapes: check / play / ring / pause / stop / !
// (text + colour, as every chip).
const PL_SHAPE = { check: ['done', '✓'], play: ['running', '▶'], ring: ['idle', '○'], pause: ['parked', '‖'], stop: ['stopped', '■'], '!': ['needs', '!'] };
const PL_STATUS = { ready: ['ok', 'ready'], waiting: ['idle', 'waiting'], held: ['parked', 'held'], offered: ['idle', 'offered'], ruling: ['needs', 'needs a ruling'] };
// R2: one day-aware clock, the same as engine/lib/plan.mjs dayClock ("today 21:41", "Fri 02:13", farther "Fri 11-20 02:13"), drawn here in
// the VIEWER's zone from the model's ISO times (named once at the top of the tab)
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function dayClock(ms, now = Date.now()) {
  const p = n => String(n).padStart(2, '0'), d = new Date(ms), n = new Date(now), hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const mid = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(), days = Math.round(Math.abs(mid(d) - mid(n)) / 86400000);
  return days === 0 ? `today ${hm}` : days < 7 ? `${DAY_NAMES[d.getDay()]} ${hm}` : `${DAY_NAMES[d.getDay()]} ${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}
const viewerZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'your local time'; } catch { return 'your local time'; } };
const plAt = (iso, now) => (Number.isFinite(Date.parse(iso ?? '')) ? dayClock(Date.parse(iso), now) : null);
// one shape per step: the glyph is the classic look's; the norn look draws its status token instead (norn.css hides .pl-g)
const plShape = (cls, g, word) => `<span class="chip ${esc(cls)}" aria-label="${esc(word)}"><span class="pl-g" aria-hidden="true">${esc(g)}</span></span>`;
const plSection = (id, title, note, body) => `<div class="tablecard pl-sec" id="${id}"><h3>${esc(title)} <span class="mute small">${esc(note)}</span></h3>${body}</div>`;
const plEmpty = t => `<p class="pl-empty mute">${esc(t)}</p>`;
const plBasis = e => (e.basis === 'history' ? `median of ${e.n} finished runs` : e.basis === 'budget' ? 'its time budget' : 'no basis');
function planPart(p, ctx) {
  const now = ctx.now ?? Date.now(), head = ctx.project === 'all' ? `<h2 class="pl-proj">${esc(p.project)}</h2>` : '';
  if (p.pending) return `${head}<div class="card pl-sec"><p class="mute">Working out the plan for ${esc(p.project)} ...</p></div>`;
  if (p.error) return `${head}<div class="card pl-sec"><p class="mute">The plan could not be worked out: ${esc(p.error)}</p></div>`;
  const up = (p.upnext || []).map(u => {
    const [c, w] = PL_STATUS[u.status] ?? ['idle', u.status];
    return `<div class="pl-row" id="pl-${esc(u.id)}"><span class="mono pl-pos">#${esc(u.position)}</span><span class="pl-what"><b>${esc(u.label)}</b> <span class="id">${esc(u.id)}</span>${aname(u.name)}</span>
      ${chip(c, w)}<span class="small pl-est" title="${esc(plBasis(u.estimate))}">${esc(u.estimate.word)}</span><span class="small pl-start"${u.start.why ? ` title="${esc(u.start.why)}"` : ''}>start ${esc(u.start.at && u.start.word !== 'now' ? `~${plAt(u.start.at, now)}` : u.start.word)}</span>
      <span class="pl-holds small">${u.holds.map((h, i) => esc(u.holdAt?.[i] ? `not before ${plAt(u.holdAt[i], now)}` : h)).join('<br>')}</span></div>`;
  }).join('');
  const step = st => {
    const [cls, g] = PL_SHAPE[st.shape] ?? PL_SHAPE.ring;
    return `<span class="pl-step s-${st.shape === '!' ? 'bang' : esc(st.shape)}" title="${esc(`${st.id}${st.now ? ` (now ${st.now})` : ''}: ${st.word}`)}">${plShape(cls, g, st.word)} ${esc(st.label)}</span>`;
  };
  const chains = (p.chains || []).map(c => `<div class="pl-chain">${c.steps.map(step).join('<span class="pl-sep mute">›</span>')}
    <div class="small pl-meta">${c.broken ? `${plShape('needs', '!', 'broken')} <b>${esc(c.broken)}</b>` : c.finished ? esc(`finished ${plAt(c.finish.at, now) ?? ''}`) : `finish ${esc(c.finish.at ? `~${plAt(c.finish.at, now)}${c.finish.note ? ` ${c.finish.note}` : ''}` : c.finish.word)}`}${c.rm ? ` · ${chip('idle', c.rm.id)} ${esc(c.rm.title)}` : ''}</div></div>`).join('');
  const landCls = w => (/^blocked/.test(w) ? 'bad' : w === 'merging now' ? 'running' : w === 'ready to merge' ? 'ok' : 'idle');
  const land = (p.landing || []).map((l, i) => `<div class="pl-row"><span class="mono pl-pos">${i + 1}.</span><span class="pl-what"><b>${esc(l.label)}</b> <span class="id">${esc(l.id)}</span>${l.what ? ` <span class="small mute">${esc(l.what)}</span>` : ''}</span>${chip(landCls(l.word), l.word)}</div>`).join('');
  const f = p.forecast || {};
  const fc = !fin(f.weekly) ? `${plEmpty('Usage not measured yet.')}` : `<div class="pl-fc"><div class="kv">
    <span class="small mute">rate now</span><span>${bar(f.rate, Math.max(f.cap ?? 0, f.rate ?? 0) || 1, f.cap, f.over ? 'hot' : '')} <span class="small">${pct(f.rate, 2)}/h of the ${pct(f.cap, 1)}/h cap</span></span>
    <span class="small mute">this week</span><span>${bar(f.weekly, 100, f.stop, fin(f.stop) && f.weekly >= f.stop ? 'hot' : '')} <span class="small">~${pct(f.weekly)}${fin(f.stop) ? ` of the ${pct(f.stop, 0)} stop` : ''}</span></span>
    <span class="small mute">reset</span><span class="small">${f.reset ? esc(plAt(f.reset, now)) : '-'}</span></div>
    <p><b>${esc(f.lineAt ? `${f.linePre}${plAt(f.lineAt, now)}${f.linePost}` : f.line)}</b>${f.costLine ? `<br><span class="small">${esc(f.costLine)}</span>` : ''}</p></div>`;
  return `${head}${plSection('pl-up', 'Up next', 'every queued run, in the order it will start', up || plEmpty('Nothing is waiting to start.'))}
    ${plSection('pl-chains', 'Chains', 'runs that wait for other runs', chains || plEmpty('No queued run waits for another run.'))}
    ${plSection('pl-land', 'Landing next', 'heading to main, in merge order', land || plEmpty(`Nothing is heading to main.${p.landing_error ? ` (${p.landing_error})` : ''}`))}
    ${plSection('pl-fc', 'Forecast', 'usage', fc)}<p class="small mute pl-method">${esc(p.method ?? '')}</p>`;
}
function plan(d, ctx) {
  const parts = d.parts || [];
  return `<div class="plan"><p class="small mute pl-zone">times in ${esc(viewerZone())}</p>${parts.map(p => planPart(p, ctx)).join('') || '<p class="mute">No project.</p>'}</div>`;
}

// ---------- Map (LANE-MAP-DESIGN 1): the server's graph + layout drawn as inline SVG; pan = scroll, zoom = 3 fixed steps ----------
export const ZOOMS = [0.75, 1, 1.25];
const cut = (t, n) => { t = String(t ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const MAP_LEGEND = [['owns', 'lane -> run'], ['resumes', 'HANDOFF -> next run (dashed)'], ['delegates', 'run -> helper / subagent'],
  ['dispatched', 'check-in started it'], ['reviewed', 'check-in reviewed it'], ['asks', 'open question parks the lane']];
function edgePath(a, b, kind) {
  const ya = a.y + a.h / 2, yb = b.y + b.h / 2;
  if (a.x === b.x && kind === 'resumes') { const x = a.x, k = 18 + Math.min(30, Math.abs(yb - ya) / 8); return `M${x} ${ya} C${x - k} ${ya} ${x - k} ${yb} ${x} ${yb}`; }
  if (a.x === b.x) { const x = a.x + a.w, k = 14 + Math.min(44, Math.abs(yb - ya) / 12); return `M${x} ${ya} C${x + k} ${ya} ${x + k} ${yb} ${x} ${yb}`; }
  const x1 = a.x + a.w, x2 = b.x, m = (x1 + x2) / 2;
  return `M${x1} ${ya} C${m} ${ya} ${m} ${yb} ${x2} ${yb}`;
}
function mapNode(n, project) {
  const small = n.h < 46, feed = n.feed ? ` data-feed="${esc(n.feed)}" data-project="${esc(project)}" role="button" tabindex="0"` : '';
  const tip = [n.label, n.sub, n.word, n.feed ? 'click: live feed' : ''].filter(Boolean).join(' · ');
  const more = n.type === 'lane' && (n.more > 0 || n.expanded)
    ? `<text class="more" x="12" y="${n.h + 14}" data-act="map-more" data-lane="${esc(n.lane)}">${n.expanded ? `${n.capped ? 'latest 30 · ' : ''}show last 3` : `+${n.more} more`}</text>` : '';
  const room = Math.max(6, Math.floor((n.w - 30 - String(n.word ?? '').length * 7) / 7.6)); // label chars beside the state word
  return `<g class="mn t-${n.type} c-${esc(n.cls)}${n.faded ? ' faded' : ''}${n.needs ? ' needs' : ''}" id="mn-${esc(n.id)}" transform="translate(${n.x} ${n.y})"${feed}><title>${esc(tip)}</title>
    <rect class="box" width="${n.w}" height="${n.h}" rx="8"/><rect class="st" width="5" height="${n.h}" rx="2"/>
    <text class="nl" x="14" y="${small ? 16 : 22}">${esc(cut(n.label, Math.min(room, small ? 22 : 24)))}</text><text class="nw" x="${n.w - 10}" y="${small ? 16 : 22}" text-anchor="end">${esc(n.word)}</text>
    <text class="ns" x="14" y="${n.h - (small ? 8 : 12)}">${esc(cut(n.sub, 40))}</text>${more}</g>`;
}
// ---------- Map in the Norn look (META-VISUAL-B S2): the Well (default) or the Tapestry (the dense view) - a three.js stage the
// page mounts into #map-host (norn/mapview.mjs), live from the state stream. This is only its frame: view switch, archived-lanes
// toggle, zoom, legend. The classic look keeps the SVG map below. ----------
export const MAP_VIEWS = [['well', 'The Well'], ['tapestry', 'The Tapestry']];
const MAP_STATES = [['running', 'running'], ['done', 'DONE'], ['handoff', 'HANDOFF'], ['stopped', 'STOPPED'], ['parked', 'parked'], ['needs', 'needs you'], ['idle', 'idle']];
function nornMap(d, ctx) {
  const view = MAP_VIEWS.some(v => v[0] === ctx.mapView) ? ctx.mapView : 'well', nz = ctx.nornZoom || 1;
  const views = MAP_VIEWS.map(([k, w]) => `<button data-act="map-view" data-view="${k}" aria-pressed="${k === view}"${k === view ? ' class="strong"' : ''}>${w}</button>`).join('');
  const zoom = [1, 1.5, 2].map(z => `<button data-act="map-nz" data-z="${z}" aria-pressed="${z === nz}"${z === nz ? ' class="strong"' : ''}>${z}x</button>`).join('');
  const lanes = (d.nodes || []).filter(n => n.type === 'lane' && n.lane !== 'checkin').length;
  const say = view === 'well' ? 'Every lane is a thread spun from the Well of Urd to its stake (running lanes face you); runs are beads, the newest by the well; the Norns hold the check-ins.'
    : 'Every lane is a weft row, its runs are knots along it (the newest at the right edge); the band of the Norns holds the check-ins.';
  return `<div class="filters"><span class="small mute">${say} Click a bead or its label for the live feed.</span>
    <span class="spacer"></span><span class="views" role="group" aria-label="Map view">${views}</span><label class="small"><input type="checkbox" data-act="map-all"${ctx.mapAll ? ' checked' : ''}> done / archived lanes</label><span class="zoom">${zoom}</span></div>
   <div class="norn-map" data-view="${view}" role="img" aria-label="${esc(MAP_VIEWS.find(v => v[0] === view)[1])}: ${lanes} lanes"><div class="map-host" id="map-host"></div><div class="map-hud small" id="map-hud"></div></div>
   <div class="legend small">${MAP_STATES.map(([c, w]) => chip(c, w)).join(' ')} <span class="mute">· pulse + motes = a record from the run · shuttle = dispatch / review / delegation · a bright thread = its run just acted</span></div>`;
}
function map(d, ctx) {
  if (ctx.look === 'norn') return nornMap(d, ctx);
  const z = ZOOMS.includes(ctx.mapZoom) ? ctx.mapZoom : 1, N = Object.fromEntries((d.nodes || []).map(n => [n.id, n]));
  const bands = (d.bands || []).map((b, i) => `<rect class="band${i % 2 ? ' alt' : ''}" x="0" y="${b.y}" width="${d.width}" height="${b.h}" rx="6"/>`).join('');
  const edges = (d.edges || []).filter(e => N[e.from] && N[e.to]).map(e => `<path class="me e-${e.kind}" d="${edgePath(N[e.from], N[e.to], e.kind)}" marker-end="url(#arr)"><title>${esc(`${e.word}: ${e.from} -> ${e.to}`)}</title></path>`).join('');
  const nodes = (d.nodes || []).map(n => mapNode(n, d.project)).join('');
  const pills = (d.bands || []).map(b => dlvPill(b, d.project)).join('');
  const zoom = ZOOMS.map(v => `<button data-act="map-zoom" data-z="${v}"${v === z ? ' class="strong" aria-pressed="true"' : ''}>${Math.round(v * 100)} %</button>`).join('');
  const legend = MAP_LEGEND.map(([k, w]) => `<span><svg width="34" height="10" aria-hidden="true"><path class="me e-${k}" d="M2 5 L32 5"/></svg> <b>${k}</b> ${esc(w)}</span>`).join('');
  const states = [['running', 'running'], ['done', 'DONE'], ['handoff', 'HANDOFF'], ['stopped', 'STOPPED'], ['parked', 'parked'], ['needs', 'needs you'], ['idle', 'idle']].map(([c, w]) => chip(c, w)).join(' ');
  return `<div class="filters"><span class="small mute">Lanes as bands (running > parked > idle), the controller's check-ins on top; last 3 runs per lane (latest large). Click a run, helper or check-in for its live feed.</span>
    <span class="spacer"></span><label class="small"><input type="checkbox" data-act="map-all"${ctx.mapAll ? ' checked' : ''}> done / archived lanes</label><span class="zoom">${zoom}</span></div>
   <div class="mapwrap"><svg class="map" xmlns="http://www.w3.org/2000/svg" width="${Math.round(d.width * z)}" height="${Math.round(d.height * z)}" viewBox="0 0 ${d.width} ${d.height}" role="img" aria-label="Lane to agent map">
    <defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z"/></marker></defs>${bands}${edges}${nodes}${pills}</svg></div>
   <div class="legend small mute">${legend}</div><div class="legend small">${states}</div>`;
}

// ---------- deliverables (DELIVERABLES-SPEC 3): "Done, not installed" card (Overview + Inbox), the drawer, the Map band pill ----------
const DLV_WORD = { done: 'DONE', merged: 'merged', installed: 'installed' };
const dlvChip = r => r.record_state === 'parked'
  ? chip('parked', `parked ${Math.floor(r.park?.days ?? 0)} d${r.park?.expired ? ' (expired)' : ''}`)
  : chip(r.state === 'done' ? 'warn' : r.state === 'merged' ? 'running' : 'ok', DLV_WORD[r.state] ?? r.state);
const dlvNative = r => (r.native === true ? chip('bad', 'native') : r.native === false ? '<span class="small mute">no</span>' : '<span class="small mute">?</span>');
export function deliverablesCard(dl, ctx = {}) {
  const rows = (dl?.rows || []).filter(r => !r.at_target).sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  const body = rows.map(r => `<tr id="dlv-${esc(r.id)}"><td><b>${projTag(ctx, r.project)}${esc(r.branch)}</b><div class="small mute"><span class="id">${esc(r.id)}</span> ${esc(r.lane ?? '')}</div></td>
    <td>${esc(cut(r.delivers, 90))}${r.park ? `<div class="small mute">${esc(r.park.why)}</div>` : ''}</td>
    <td class="mono">${fin(r.days) ? r.days.toFixed(1) + ' d' : '-'}</td>
    <td class="mono">${fin(r.behind) ? r.behind + ' behind' : r.state === 'done' ? '-' : 'on main'}</td>
    <td>${dlvNative(r)}</td>
    <td>${dlvChip(r)}${r.due ? ' ' + chip('open', 'question due') : r.asked ? ` <span class="small mute">asked ${esc(r.asked)}</span>` : ''}</td>
    <td><button data-dlv="${esc(r.id)}" data-project="${esc(r.project)}">Open</button></td></tr>`).join('');
  if (dl?.pending && !rows.length) return `<section class="card" id="deliverables"><h2>Done, not installed <b>-</b></h2><div class="small mute">reading git and the install receipts ... (the next refresh shows them)</div></section>`;
  return `<section class="card" id="deliverables"><h2>Done, not installed <b>${rows.length}</b> <span class="mute small">oldest first · state from git + the last install receipt</span></h2>
   ${dl?.error ? `<div class="small" style="color:var(--bad)">${esc(dl.error)}</div>` : ''}
   ${rows.length ? `<table><thead><tr><th>branch</th><th>delivers</th><th>done</th><th>vs main</th><th>native</th><th>state</th><th></th></tr></thead><tbody>${body}</tbody></table>`
    : `<div class="item">${art(ctx, 'empty-all-delivered', 'empty')}${chip('ok', 'all clear')}<span>Nothing done-not-installed</span></div>`}</section>`;
}
export function renderDeliverable(r, ctx = {}) {
  if (!r) return '<div class="small mute">deliverable not found (refresh the page)</div>';
  const reached = { done: 1, merged: 2, installed: 3 }[r.state] ?? 0;
  const steps = ['done', 'merged', 'installed'].map((s, i) => chip(i < reached ? 'ok' : 'idle', s.toUpperCase())).join(' <span class="mute">&rarr;</span> ');
  const kv = (k, v) => `<span class="mute small">${esc(k)}</span><div>${v}</div>`;
  const nat = r.native === null ? '<span class="mute">unknown (no native globs for this repo)</span>' : r.native
    ? `${chip('bad', 'native')}<div class="mono small">${(r.native_files || []).map(esc).join('<br>')}</div>` : 'no native code';
  return `<div class="dlvd"><h3 style="margin:10px 0 4px"><span class="id">${esc(r.id)}</span> ${esc(r.branch)}</h3><div class="small" style="margin-bottom:8px">${esc(r.delivers ?? '')}</div>
   <div style="margin:6px 0 12px">${steps} <span class="small mute">target ${esc(r.target)}${r.at_target ? ' · reached' : ''}</span></div>
   <div class="kv">${kv('repo', `<span class="mono small">${esc(r.repo)}</span>`)}${kv('tip', `<span class="mono">${esc(String(r.tip ?? '-').slice(0, 9))}</span>${r.branch_exists === false ? ' <span class="small mute">(branch gone: the tip recorded at DONE)</span>' : ''}`)}
   ${kv('lane / run', `${esc(r.lane ?? '-')} · ${esc(r.run ?? '-')}`)}${kv('done', `${esc(fmtTime(r.done_utc, ctx.now ?? Date.now()))} · ${fin(r.days) ? r.days.toFixed(1) + ' d ago' : '-'}`)}
   ${kv('vs main', fin(r.behind) ? `${r.behind} behind · ${r.ahead ?? '?'} ahead` : r.state === 'done' ? '-' : 'on main')}${kv('native', nat)}
   ${r.rehearsal ? kv('merge rehearsal', r.rehearsal.clean ? chip('ok', 'clean') : `${chip('bad', 'conflict')}<div class="mono small">${r.rehearsal.files.map(esc).join('<br>')}</div>`) : ''}
   ${kv('park', r.park ? `${chip('parked', `parked ${Math.floor(r.park.days)} d`)} ${esc(r.park.why)} <span class="small mute">by ${esc(r.park.by ?? '-')}${r.park.expired ? ' · expired: back on the list' : ''}</span>` : '<span class="mute">not parked</span>')}
   ${kv('question', r.asked ? `<a href="#" data-rid="${esc(r.asked)}">${esc(r.asked)}</a> (one per deliverable)` : r.due ? chip('open', 'question due: the next check-in asks') : '<span class="mute">none</span>')}</div>
   <h3 style="margin:14px 0 4px">Move it</h3><div class="mono small" style="white-space:pre-wrap">norn deliverables park ${esc(r.id)} --why "&lt;the owner's reason&gt;"
norn deliverables unpark ${esc(r.id)}
norn deliverables ask ${esc(r.id)}      (the check-in: one question per deliverable)${r.resolve ? `
norn deliverables resolve ${esc(r.id)}  (${esc(r.resolve.why)}; native = door work)` : ''}</div>
   <div class="small mute" style="margin-top:8px">DONE / MERGED / INSTALLED come from git and the last install receipt - nobody types them.</div></div>`;
}
function dlvPill(b, project) {
  const r = b.deliverables?.[0];
  if (!r) return '';
  const word = r.record_state === 'parked' ? 'parked' : r.state;
  const txt = `${r.id} ${word} ${fin(r.days) ? r.days.toFixed(1) + ' d' : ''}${fin(r.behind) ? ` · ${r.behind} behind` : ''}${r.native ? ' · native' : ''}${b.deliverables.length > 1 ? ` · +${b.deliverables.length - 1}` : ''}`;
  const tip = `${r.branch}: ${word}${r.park_why ? ` (${r.park_why})` : ''}${r.due ? ' · question due' : ''} · click: open the deliverable`;
  return `<g class="dlv ${esc(r.state)}${r.record_state === 'parked' ? ' parked' : ''}${r.due ? ' due' : ''}" data-dlv="${esc(r.id)}" data-project="${esc(r.project ?? project)}" role="button" tabindex="0" transform="translate(16 ${b.y + b.h - 32})"><title>${esc(tip)}</title>
    <rect width="${Math.min(260, 16 + txt.length * 6.6).toFixed(0)}" height="20" rx="10"/><text x="9" y="14">${esc(txt)}</text></g>`;
}

// ---------- live feed drawer (LANE-MAP-DESIGN 2): head + one line per normalised event; index.html streams /api/feed into it ----------
const OUTCOME = { done: 'DONE', stopped: 'STOPPED', handoff: 'HANDOFF' };
const MARK = { DONE: 'done', STOPPED: 'stopped', HANDOFF: 'handoff' };
export function renderFeedHead(h, now = Date.now()) {
  const st = h.state === 'exited' ? `exited: ${OUTCOME[h.outcome] ?? h.outcome ?? 'no-marker'}` : h.state;
  const [cls, word] = stateOf(st);
  const over = fin(h.elapsed_min) && fin(h.budget_min) && h.elapsed_min > h.budget_min;
  const lim = fin(h.ctx_limit) ? h.ctx_limit : null, hot = lim && fin(h.ctx) && h.ctx > lim;
  const c = h.commit;
  return `<div class="fh-top"><b class="aname">${esc(h.name ?? h.run)}</b><span class="id">${esc(h.run)}</span>${h.lane ? `<span class="tag">${esc(h.lane)}</span>` : ''}${chip(cls, word)}${h.marker ? chip(MARK[h.marker] ?? 'idle', h.marker) : ''}</div>
   <div class="fh-ex">${exChip(h.executor, h.model, h.effort)}${h.role === 'helper' ? ' <span class="tag">helper</span>' : ''}</div>
   <div class="kv small fh-kv"><span class="mute">elapsed</span><span>${fmtMin(h.elapsed_min)}${fin(h.budget_min) ? ` of ${fmtMin(h.budget_min)} budget` : ''}${fin(h.budget_min) ? bar(h.elapsed_min, Math.max(h.budget_min, h.elapsed_min ?? 0), h.budget_min, over ? 'over' : '') : ''}</span>
   <span class="mute">context</span><span>${kTok(h.ctx)}${lim ? ` of ${kTok(lim)} ${h.executor && String(h.executor).startsWith('codex') ? 'window' : 'hand-off'}` : ''}${lim && fin(h.ctx) ? bar(h.ctx, Math.max(lim, h.ctx), lim, hot ? 'hot' : '') : ''}</span>
   <span class="mute">last commit</span><span>${c ? `<span class="mono">${esc(c.sha)}</span> ${esc(c.subject)} <span class="mute">${fmtMin(c.age_min)} ago</span>` : dash}</span></div>`;
}
const hms = ts => { const t = Date.parse(ts ?? ''); return Number.isFinite(t) ? new Date(t).toISOString().slice(11, 19) : ''; };
const FEED_KINDS = ['tool', 'text', 'step', 'marker', 'error'];
export function renderFeedEvent(e) {
  const k = FEED_KINDS.includes(e.kind) ? e.kind : 'text';
  return `<div class="fl k-${k}"${k === 'tool' && e.id ? ` data-tid="${esc(e.id)}"` : ''}><span class="ts">${hms(e.ts)}</span><span class="fk">${esc(k === 'tool' ? e.name ?? 'tool' : k)}</span><span class="fs">${esc(e.summary)}</span><span class="dur"></span></div>`;
}

function history(r, ctx) {
  return `<details><summary class="small mute">history (${(r.history || []).length})</summary><div class="small mono">${(r.history || []).map(h => `${esc(h.seq)} ${fmtTime(h.ts, ctx.now)} ${esc(h.ev)} by ${esc(h.by)}${h.data?.text && h.ev !== 'create' ? ': ' + esc(h.data.text) : ''}`).join('<br>')}</div></details>`;
}
// RECORDS-TEXT R1: a text cell = the ledger-style blocks (ledger.mjs recordBlocks); over ~3 lines it clamps behind a "more" button
// (index.html drops the button when the text fits); the full text stays in the DOM, so the search filter matches all of it
function recText(key, parts) {
  const lines = parts.reduce((n, p) => n + p.lines, 0), long = lines > 3;
  return `<div class="rtext${long ? ' rclamp' : ''}" data-key="${esc(key)}">${parts.map(p => p.html).join('')}</div>${long ? '<button type="button" class="ghost rmore" data-act="rec-more" aria-expanded="false">more</button>' : ''}`;
}
function records(d, ctx) {
  const o = { project: ctx.project }, blk = (t, cpl) => recordBlocks(t, { ...o, cpl });
  const why = r => { if (!r.data.why) return { html: '', lines: 0 }; const b = blk(r.data.why, 50); return { html: `<div class="rwhy small mute">${b.html}</div>`, lines: b.lines }; };
  const dir = d.directives.map(r => `<tr id="rec-${esc(r.id)}" data-state="${esc(r.state)}"><td class="id rnw">${esc(r.id)}</td><td>${chip(r.state)}</td><td class="rt">${recText(`${r.id}:text`, [blk(r.data.text, 110)])}${r.superseded_by ? `<div class="small mute">superseded by ${esc(r.superseded_by)}</div>` : ''}${history(r, ctx)}</td>
    <td class="small mute rnw">${fmtTime(r.created, ctx.now)} · ${esc(r.data.via ?? r.by)}</td><td>${r.state === 'active' ? `<button class="ghost" data-act="revoke" data-project="${esc(d.project)}" data-id="${esc(r.id)}">Revoke</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="5" class="mute">no directives</td></tr>';
  const dec = d.decisions.map(r => `<tr id="rec-${esc(r.id)}" data-state="${esc(r.state)}"><td class="id rnw">${esc(r.id)}</td><td>${chip(r.state)}${r.data.fyi ? ' ' + chip('needs', 'FYI') : ''}</td><td>${esc(r.data.lane ?? '-')}</td><td class="rt" data-label="question">${recText(`${r.id}:q`, [blk(r.data.question, 50)])}</td>
    <td class="rt" data-label="choice + why">${recText(`${r.id}:c`, [blk(r.data.choice, 50), why(r)])}${history(r, ctx)}</td><td class="small mute rnw">${esc(r.by)} · ${fmtTime(r.created, ctx.now)}</td><td class="small mute">${esc(r.data.source ?? '-')}</td>
    <td>${r.state === 'in-force' ? `<button class="ghost" data-act="overrule" data-project="${esc(d.project)}" data-id="${esc(r.id)}">Overrule</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="8" class="mute">no decisions</td></tr>';
  const active = d.directives.filter(r => r.state === 'active').length;
  return `<div class="filters"><input type="search" data-filter="records" placeholder="search id, lane, text  (e.g. DEC-1, relief)"><select data-filter-state="records"><option value="">all states</option><option value="in-force active">in force / active</option><option value="superseded overruled revoked done">ended</option></select>
    <span class="small mute">${d.decisions.length} decisions · ${d.directives.length} directives (${active} active)</span></div>
   <div class="tablecard"><h3>Directives <span class="mute small">only active ones bind the check-in</span><span class="spacer"></span><button class="strong" data-act="directive" data-project="${esc(d.project)}">Add directive</button></h3><table class="rectab" data-rows="records"><thead><tr><th>id</th><th>state</th><th>text</th><th>when · via</th><th></th></tr></thead><tbody>${dir}</tbody></table></div>
   <div class="tablecard"><h3>Decisions</h3><table class="rectab" data-rows="records"><thead><tr><th>id</th><th>state</th><th>lane</th><th>question</th><th>choice + why</th><th>by</th><th>source</th><th></th></tr></thead><tbody>${dec}</tbody></table></div>`;
}

function docs(d, ctx) {
  const btns = d.docs.map(x => x.exists ? `<button id="doc-${x.i}" data-doc="${x.i}" class="${d.doc?.i === x.i ? 'strong' : ''}" aria-pressed="${d.doc?.i === x.i}">${esc(x.tab)}</button>`
    : `<button id="doc-${x.i}" disabled title="${esc(x.path)}">${esc(x.tab)} ${chip('bad', 'missing')}</button>`).join('');
  return `<div class="filters">${btns || '<span class="mute">project.json lists no docs</span>'}<span class="small mute">tabs come from project.json "docs"</span></div>
   ${d.doc ? docBody(d.doc, ctx) : ''}`;
}
// META-INSTRUCTIONS R1: every file that steers the agents - load class, ~size, what it cost today, drift, read-only hints; a row
// opens the file rendered. R2 (the chat's verbs) adds "ask the controller to tighten this": a disabled stub until then.
const INS_LOAD = { session: 'every session', checkin: 'check-ins', chat: 'chat', role: 'role', 'on-demand': 'on demand', source: 'source' };
const INS_CHIP = { session: 'warn', checkin: 'claude', chat: 'claude', role: 'prov', 'on-demand': 'idle', source: 'idle' };
const DRIFT_CHIP = { ok: 'ok', missing: 'bad', drift: 'bad', unmanaged: 'bad', stale: 'warn', adoptable: 'idle', same: 'idle' };
const tk = n => (!fin(n) ? '-' : n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${n}`);
function instructions(d, ctx) {
  const now = ctx.now ?? Date.now();
  const load = r => r.load === 'role' ? `role ${r.role}` : r.load === 'session' && r.standing_tokens < r.tokens ? 'every session (description)' : INS_LOAD[r.load] ?? r.load;
  const rows = (d.rows || []).map(r => `<tr id="ins-row-${esc(r.id)}"${d.file?.id === r.id ? ' class="sel"' : ''}>
    <td><button class="lnk" data-ins="${esc(r.id)}"${r.exists ? '' : ' disabled'}>${esc(r.name)}</button>${r.exists || r.generated ? '' : ` ${chip('bad', 'missing')}`}${r.generated ? ` ${chip(DRIFT_CHIP[r.drift] ?? 'idle', `generated · ${r.drift || '?'}`)}` : ''}${r.stale ? ` ${chip('warn', `${r.stale} stale`)}` : ''}<div class="inspath mute">${esc(r.path)}</div></td>
    <td>${chip(INS_CHIP[r.load] ?? 'idle', load(r))}</td><td class="insopt">${esc((r.harness || []).join(', ') || 'any')}</td>
    <td class="num">${tk(r.tokens)}</td><td class="num">${r.cost_today ? `${tk(r.cost_today)}${r.via ? ' <span class="mute small">via</span>' : ''}<div class="small mute">${int(r.loads_today)} load(s)</div>` : dash}</td>
    <td class="insopt">${r.changed ? `${esc(fmtTime(r.changed, now))} <span class="small mute">${esc(r.changed_by)}</span>` : dash}</td>
    <td class="num">${r.hints ? chip('warn', `${r.hints} hint${r.hints > 1 ? 's' : ''}`) : dash}</td></tr>`).join('');
  const standing = (d.standing || []).map(s => `<tr><td>${esc(s.label)}</td><td class="num">${int(s.sessions)}</td><td class="num">${tk(s.tokens)}</td></tr>`).join('');
  const hints = (d.hints || []).map(h => `<li class="inshint">${chip('warn', h.kind)} <button class="lnk" data-ins="${esc(h.id)}">${esc(h.path.split('/').pop())}:${esc(h.line)}</button> ${esc(h.text)}</li>`).join('');
  return `${insMeasured(d.measured)}${insCheckins(d.checkins)}<div class="card"><b>${int((d.rows || []).length)} files steer the agents</b> · ${tk(d.total)} tokens loaded today by ${int(d.sessions)} session(s)
     <div class="small mute">${esc(d.method)}. Cost today = size x the sessions that loaded it (runs.jsonl + the chat's starts). Read-only: hints are never applied.</div></div>
   ${d.file ? insBody(d.file, ctx) : ''}
   <div class="tablecard"><h3>Standing context per role <span class="mute small">what one session of it loads before any work</span></h3><div class="inswrap"><table><thead><tr><th>role</th><th>sessions today</th><th>~tokens / session</th></tr></thead><tbody>${standing || `<tr><td colspan="3">${dash}</td></tr>`}</tbody></table></div></div>
   <div class="tablecard"><h3>Files</h3><div class="inswrap"><table class="instab" id="ins-table"><thead><tr><th>file</th><th>loaded</th><th class="insopt">harness</th><th>size</th><th>today</th><th class="insopt">changed</th><th>hints</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="mute">no instruction files found</td></tr>`}</tbody></table></div></div>
   <div class="tablecard"><h3>Hints <span class="mute small">${int((d.hints || []).length)} · lint, read-only</span></h3>${hints ? `<ul id="ins-hints">${hints}</ul>` : '<p class="mute" style="padding:0 12px">none</p>'}</div>
   ${insSuggest(d)}`;
}
// META-STANDING-CONTEXT R1: the measured standing context (median per session, last 7 days) per role + where it goes (the parts)
const ROLE_LABEL = { worker: 'workers', merge: 'merge runs', checkin: 'check-ins', chat: 'chat' };
// META-CHECKIN-DIET R1: per day "check-ins: n (m mechanical, k minor, j full)" - mechanical = a routine end the tick handled by code
function insCheckins(days) {
  if (!days?.length) return '';
  const li = days.map(x => `<tr><td>${esc(x.day)}</td><td>check-ins: <b>${int(x.n)}</b> (${int(x.mechanical)} mechanical, ${int(x.minor)} minor, ${int(x.full)} full)</td></tr>`).join('');
  return `<div class="tablecard" id="ins-checkins"><h3>Check-ins per day <span class="mute small">mechanical = a routine end handled by code, no model · minor = the reduced tick · full = the full check-in</span></h3><div class="inswrap"><table class="instab"><tbody>${li}</tbody></table></div></div>`;
}
function insMeasured(m) {
  if (!m?.roles?.length) return '';
  const lab = k => esc(k.replace(/^(\w+)/, w => ROLE_LABEL[w] ?? w));
  const rows = m.roles.map(r => `<tr><td>${lab(r.key)}</td><td class="num">${int(r.runs)}</td><td class="num"><b>${tk(r.median_turn1)}</b></td><td class="num insopt">${tk(r.median_create1)}</td><td class="num insopt">${r.median_turns ?? dash}</td><td class="num">${r.cache_read >= 1e6 ? `~${(r.cache_read / 1e6).toFixed(1)}M` : tk(r.cache_read)}</td></tr>`).join('');
  const bars = Object.entries(m.parts || {}).map(([k, s]) => {
    const ps = (s.parts || []).filter(x => x.tokens > 0), tot = ps.reduce((n, x) => n + x.tokens, 0) || 1;
    return `<div class="insbarrow"><div class="small"><b>${lab(k)}</b> <span class="mute">${tk(s.total)} · ${esc(s.run)} · ${esc(s.method)}</span></div>
      <div class="insbar" role="img" aria-label="${esc(ps.map(x => `${x.label} ${x.tokens}`).join(', '))}">${ps.map(x => `<span class="insseg seg-${esc(x.key)}${x.ours ? '' : ' fixed'}" style="width:${(100 * x.tokens / tot).toFixed(2)}%" title="${esc(x.label)} ${tk(x.tokens)}"></span>`).join('')}</div>
      <div class="small inslegend">${ps.map(x => `<span><i class="insdot seg-${esc(x.key)}${x.ours ? '' : ' fixed'}"></i>${esc(x.label)} ${tk(x.tokens)}${x.ours ? '' : ' <span class="mute">(fixed)</span>'}</span>`).join(' ')}</div></div>`;
  }).join('');
  return `<div class="tablecard" id="ins-standing"><h3>Standing context <span class="mute small">what one session loads before any work, re-read every turn · median per session, last ${int(m.window_days ?? 7)} days</span></h3>
   <div class="inswrap"><table class="instab"><thead><tr><th>role</th><th>runs</th><th>turn 1</th><th class="insopt">cache create</th><th class="insopt">turns</th><th>cache reads</th></tr></thead><tbody>${rows}</tbody></table></div>
   <div style="padding:6px 12px">${bars}<div class="small mute" style="margin-top:4px;overflow-wrap:anywhere">${esc(m.method)}</div></div></div>`;
}
const SUG_CHIP = { superseded: 'bad', duplicate: 'warn', stale: 'warn', 'one-role': 'prov', large: 'idle', lean: 'claude' };
function insSuggest(d) {
  const s = d.suggest || [];
  const li = s.slice(0, 30).map(x => `<li class="inssug">${chip(SUG_CHIP[x.class] ?? 'idle', x.class)} <b>${tk(x.saved_per_day)} / day</b> <span class="mute small">${esc(x.id)}</span>
    <div>${x.path ? `<button class="lnk" data-ins="${esc((d.rows || []).find(r => r.path === x.path)?.id ?? '')}">${esc(x.file)}:${esc(x.line)}</button> ` : `<b>${esc(x.file)}</b> `}<span class="mute">"${esc(x.head.slice(0, 120))}"</span>${x.owner_file ? ` ${chip('bad', 'owner file')}` : ''}</div>
    <div class="small">${esc(x.why)} · <i>${esc(x.action)}</i></div>${x.patch ? `<details><summary class="small">patch (norn instructions apply ${esc(x.id)})</summary><pre class="inspatch">${esc(x.patch)}</pre></details>` : ''}</li>`).join('');
  return `<div class="tablecard"><h3>Tighten <span class="mute small">${int(s.length)} candidates, ranked by ~tokens saved per day · read-only; apply = the owner's tap in the chat</span></h3>${li ? `<ul id="ins-suggest">${li}</ul>` : '<p class="mute" style="padding:0 12px">none</p>'}</div>`;
}

function insBody(f, ctx) {
  const src = /\.json$/i.test(f.path) ? '```json\n' + (f.text ?? '') + '\n```' : (f.text ?? '');
  let { html, toc } = renderMarkdown(src, { sanitize: ctx.sanitize });
  // META-STANDING-CONTEXT R1: each paragraph with its age badge (stated date / last commit / first seen; STALE; confirmed)
  if (f.paras?.length && !/\.json$/i.test(f.path)) {
    const lines = src.split(/\r?\n/);
    html = f.paras.map(p => `<div class="inspara${p.stale ? ' stale' : ''}" id="ins-${esc(p.anchor)}"><span class="agebadge chip ${p.stale ? 'warn' : p.confirmed ? 'ok' : 'idle'}" title="${esc([p.stated ? `stated ${p.stated}` : '', p.changed ? `changed ${p.changed.slice(0, 10)}` : '', p.confirmed ? 'confirmed' : '', p.why].filter(Boolean).join(' · '))}">${p.age_days ?? '?'} d${p.stale ? ' · STALE' : p.confirmed ? ' · confirmed' : ''}</span> <span class="small mute">#${esc(p.anchor)} L${esc(p.line)}</span>${renderMarkdown(lines.slice(p.line - 1, p.end).join('\n'), { sanitize: ctx.sanitize }).html}</div>`).join('');
  }
  const links = toc.map(t => `<a class="toc${t.depth}" href="#${esc(t.id)}">${esc(t.text)}</a>`).join('');
  return `<div class="small mute" style="margin-bottom:6px;overflow-wrap:anywhere">${esc(f.path)} · ${tk(f.tokens)} tokens · ${esc(int(f.lines))} lines <button data-ins="">Close</button>
   <button disabled title="R2: needs the chat's verbs">Ask the controller to tighten this</button></div><div class="docwrap"><nav class="doctoc" aria-label="Contents"><b class="small">Contents</b>${links || '<span class="small mute">no headings</span>'}</nav>
   <article class="card md" id="ins-body">${html}</article></div>`;
}

// rendered markdown + contents sidebar (META-UX-R1 A); ctx.sanitize = DOMPurify in the browser
function docBody(doc, ctx) {
  const { html, toc } = renderMarkdown(doc.text ?? '', { sanitize: ctx.sanitize });
  const links = toc.map(t => `<a class="toc${t.depth}" href="#${esc(t.id)}">${esc(t.text)}</a>`).join('');
  return `<div class="small mute" style="margin-bottom:6px">${esc(doc.path)}</div><div class="docwrap"><nav class="doctoc" id="doc-toc" aria-label="Contents"><b class="small">Contents</b>${links || '<span class="small mute">no headings</span>'}</nav>
   <article class="card md" id="doc-body">${html}</article></div>`;
}

// Ledger (LEDGER-UX R1): one row per entry in the Records look, newest first - time, kind chip, headline + labelled sub-lines;
// record ids link where they live (ledger.mjs), headings / prose render as markdown; search + kind filter like Records
const LED_CHIP = { 'check-in': 'ok', minor: 'idle', auto: 'warn', controller: 'claude', other: 'idle' };
// compact (the Overview card): the sub-lines go on one muted line, clamped by CSS, so 4 entries stay a glance
export function ledgerRows(entries, d, ctx, compact = false) {
  const o = { runs: d.runs || [], project: ctx.project };
  const subOf = x => `${x.label ? `<b>${esc(x.label)}</b> ` : ''}${ledgerInline(x.text, o)}`;
  return [...entries].reverse().map((e, i) => {
    const subs = !e.subs.length ? '' : compact ? `<div class="ledsub clamp">${e.subs.map(subOf).join(' · ')}</div>` : e.subs.map(x => `<div class="ledsub">${subOf(x)}</div>`).join('');
    const body = e.kind === 'other' ? `<div class="md ledmd">${renderMarkdown(e.raw, { sanitize: ctx.sanitize }).html}</div>`
      : `<div class="ledhead">${ledgerInline(e.headline, o)}</div>${subs}`;
    const who = e.kind === 'controller' ? `<div class="id">${esc(e.label)}</div>` : '';
    return `<tr${compact ? '' : ` id="led-${entries.length - 1 - i}" data-state="${esc(e.kind)}"`}><td class="small mute ledt">${e.ts ? fmtTime(e.ts, ctx.now) : ''}</td><td class="ledk">${chip(LED_CHIP[e.kind], e.kind === 'other' ? 'note' : e.kind)}${who}</td><td class="ledb">${body}</td></tr>`;
  }).join('');
}
function ledger(d, ctx) {
  const entries = parseLedger(d.ledger), more = d.more ? `<button class="ghost" data-act="ledger-more">Show older (${esc(d.count ?? 100)} more lines)</button>` : '';
  return `<div class="filters"><input type="search" data-filter="ledger" placeholder="search text, ids  (e.g. RUN-12, merged)"><select data-filter-state="ledger"><option value="">all kinds</option>${LEDGER_KINDS.map(k => `<option value="${k}">${k === 'other' ? 'notes / headings' : k}</option>`).join('')}</select>
    <span class="small mute">${entries.length} entries · ${esc(d.ledger.length)} of ${esc(d.total ?? d.ledger.length)} lines</span></div>
   <div class="tablecard"><h3>Ledger <span class="mute small">${esc(d.file ?? 'no ledger file in project.json')} · newest first</span></h3>
   <table class="ledtab" id="ledger-lines" data-rows="ledger"><thead><tr><th>when</th><th>kind</th><th>entry</th></tr></thead><tbody>${ledgerRows(entries, d, ctx) || '<tr><td colspan="3" class="mute">empty</td></tr>'}</tbody></table>
   ${more ? `<div style="padding:10px 14px">${more}</div>` : ''}</div>`;
}

// ---------- Settings (META-UX-R1): categories -> sub-categories from the schema (policy.mjs SECTIONS, served in /api/settings),
// left nav + search, one-line help per row, modified-from-default marker + reset, danger zone. Controls keep data-key = the key.
const showVal = v => Array.isArray(v) ? v.join(', ') || '(none)' : typeof v === 'boolean' ? (v ? 'on' : 'off') : v === '' ? '(default)' : v;
const ctlVal = v => Array.isArray(v) ? v.join(', ') : v ?? '';
/** Search text of one setting row (label, key, help, value, recommended) - the browser filters on the same string. */
export const searchText = s => [s.label, s.key, s.help, showVal(s.value), s.recommended].join(' ').toLowerCase();
/** All words of q in the text; the token @modified also requires the modified flag. Empty q matches everything. */
export function matchText(text, q, modified) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return words.every(w => w === '@modified' ? !!modified : text.includes(w));
}
export const settingsMatch = (s, q) => matchText(searchText(s), q, s.modified);
function input(s) {
  const id = esc(s.key), dis = s.readonly || s.scope === 'file' ? ' disabled' : '', orig = esc(JSON.stringify(s.value ?? null));
  const attrs = `id="in-${id}" data-key="${id}" data-type="${esc(s.type)}" data-orig="${orig}"${dis}`;
  if (s.type === 'bool') return `<select ${attrs}><option value="true"${s.value ? ' selected' : ''}>on</option><option value="false"${s.value ? '' : ' selected'}>off</option></select>`;
  // an unset enum (no value, no blank option) shows "(unset)": the browser must not read the first option as a change
  const unset = s.type === 'enum' && (s.value === undefined || s.value === null) && !(s.options || []).includes('');
  if (s.type === 'enum') return `<select ${attrs}>${unset ? '<option value="" selected>(unset)</option>' : ''}${(s.options || []).map(o => `<option value="${esc(o)}"${o === s.value ? ' selected' : ''}>${esc(o || '(default)')}</option>`).join('')}</select>`;
  if (s.type === 'classes') return `<input type="text" ${attrs} value="${esc(ctlVal(s.value))}" placeholder="none" title="${esc((s.options || []).join(', '))}" class="wide">`;
  if (s.type === 'int' || s.type === 'num') return `<input type="number" ${attrs} value="${esc(s.value)}" placeholder="unset" min="${esc(s.min)}" max="${esc(s.max)}" step="${s.type === 'int' ? 1 : 0.01}" class="num">`;
  if (s.scope === 'file') return `<span class="small mono">${esc(s.value)}</span>`;
  return `<input type="text" ${attrs} value="${esc(ctlVal(s.value))}" placeholder="unset" class="text">`;
}
const modChip = s => s.modified ? ` <span class="mod" title="default ${esc(showVal(s.default))}">modified</span>` : '';
const resetBtn = s => s.default !== undefined && !s.readonly && s.scope !== 'file'
  ? `<button class="ghost reset" data-act="set-reset" data-for="${esc(s.key)}" data-default="${esc(JSON.stringify(s.default))}" title="Reset to the default ${esc(showVal(s.default))}"${s.modified ? '' : ' hidden'}>&#8634;</button>` : '';
const tip = s => esc(`${s.key} (${s.scope === 'machine' ? 'machine, all projects' : s.scope === 'project' ? 'project policy' : 'rules file'})\nRecommended: ${s.recommended}\nCost: ${s.cost}\nRead by: ${(s.readers || []).join('; ')}`);
const scopeTag = s => `<span class="tag" title="${esc(s.home ?? '')}">${s.scope === 'machine' ? 'machine' : s.scope === 'project' ? 'project' : 'rules file'}</span>`;
function row(s) {
  return `<div class="srow${s.modified ? ' modrow' : ''}" id="set-${esc(s.key)}"${s.basic ? ' data-basic="1"' : ''} data-search="${esc(searchText(s))}" data-mod="${s.modified ? 1 : 0}"><div class="sl"><label for="in-${esc(s.key)}" title="${tip(s)}"><b>${esc(s.label)}</b></label>${modChip(s)} ${scopeTag(s)}<span class="key">${esc(s.key)}</span><span class="help">${esc(s.help)}${s.recommended ? ` <span class="rec">Recommended: ${esc(s.recommended)}.</span>` : ''}</span></div><div class="sc">${input(s)}${resetBtn(s)}</div></div>`;
}
function inlineGroup(cat, sub, x, items) {
  const short = s => String(s.label).replace(/^[^:]+:\s*/, ''), mod = items.some(s => s.modified);
  const cells = items.map(s => `<span class="mini" id="set-${esc(s.key)}" title="${tip(s)}"><span><label for="in-${esc(s.key)}">${esc(short(s))}</label>${modChip(s)}</span><span>${input(s)}${resetBtn(s)}</span></span>`).join('');
  return `<div class="srow inline${mod ? ' modrow' : ''}" id="grp-${esc([cat.id, sub.id, x.id].join('-'))}" data-search="${esc([x.label, ...items.map(searchText)].join(' ').toLowerCase())}" data-mod="${mod ? 1 : 0}"><div class="sl"><b>${esc(x.label)}</b> ${scopeTag(items[0])}<span class="help">${esc(items[0].help)}</span></div><div class="sc">${cells}</div></div>`;
}
function filesPane(d) {
  const tg = d.targets.map(t => `<div class="item">${t.exists ? chip('ok', `${t.markers.length} markers`) : chip('bad', 'missing')}<span class="mono small">${esc(t.file)}</span>${t.markers.length ? `<span class="small mute">${esc(t.markers.join(', '))}</span>` : ''}</div>`).join('');
  return `<div class="ssub" id="sub-files-sources"><h3>Source files <span class="help">every key keeps one home; the tag on each row says which file</span></h3>
    <div class="kv"><span class="tag">machine</span><span class="mono small" id="settings-machine">${esc(d.files.machine)} <span class="mute">(all projects)</span></span>
    <span class="tag">project</span><span class="mono small" id="settings-project">${esc(d.files.project)} <span class="mute">policy</span></span>
    <span class="tag">rules file</span><span class="small mute">read-only rows, edited by hand</span></div></div>
   <div class="ssub" id="sub-files-targets"><h3>Policy targets <span class="help">generated lines (&lt;!-- policy:key --&gt;) rewritten on Save</span></h3>${tg || '<span class="mute">none</span>'}</div>`;
}
// META-NOTIFY-SETUP R1: the Notifications row (machine.json notify; changed with norn setup --notify) + "send a test"
const PING_EVENTS = [['Questions to you', 'at once'], ['Work finished (merged / ready)', 'at once'], ['CI red on main, a killed or crashed run', 'at once, high']];
function notifyPane(d) {
  const n = d.notify || { backend: 'none' }, on = n.backend && n.backend !== 'none';
  const what = { ntfy: 'ntfy (phone app)', toast: 'desktop toast (Windows)', desktop: 'desktop notification', pushover: 'Pushover' }[n.backend] || 'off';
  const where = n.backend === 'ntfy' ? ` <span class="small mute">${esc(n.server)} · topic ${n.topic_set ? 'set (private)' : 'MISSING'}</span>` : '';
  const ev = PING_EVENTS.map(([e, w]) => `<li>${esc(e)} <span class="mute">- ${esc(w)}</span></li>`).join('')
    + `<li>FYI notes (rulings, other news) <span class="mute">- batched: one digest every ${esc(n.batch_h ?? 3)} h</span></li>`;
  return `<div class="ssub" id="sub-notify-ping"><h3>Phone / desktop ping <span class="help">machine.json notify, all projects - change it with norn setup --notify ntfy|toast|desktop|pushover|none</span></h3>
    <div class="srow" id="set-notify" data-basic="1" data-search="notifications notify ping phone desktop ntfy toast pushover ${esc(n.backend)}" data-mod="0"><div class="sl"><b>Notifications</b> <span class="tag">machine</span> ${on ? chip('ok', what) : chip('warn', 'off')}${where}
      <span class="help">${on ? 'Norn pings you when it needs you:' : 'Off: questions can sit unseen. Turn on with <span class="mono">norn setup --notify ntfy</span> (the free ntfy phone app) or <span class="mono">--notify toast</span> (this computer).'}</span>
      ${on ? `<ul class="small ping-events">${ev}</ul>` : ''}</div>
     <div class="sc">${on ? '<button class="ghost" data-act="notify-test">Send a test</button>' : ''}<span class="small mute" id="notify-test-out" role="status"></span></div></div></div>`;
}
// META-CONTROLLER C6 (SPEC sec. 5): reach Norn from your phone. r = /api/remote, or null when off. Off: how to start. On: the address,
// the paired devices (Revoke) and, on the desktop only, Pair a device (a single-use code).
function remotePane(r) {
  const head = '<h3>Reach Norn from your phone <span class="help">machine.json dash.remote, all projects - your own private network (Tailscale Serve); the dashboard stays on 127.0.0.1</span></h3>';
  const wrap = (body, sc = '') => `<div class="ssub" id="sub-notify-remote">${head}<div class="srow" id="set-remote" data-basic="1" data-search="remote phone tailscale pair device" data-mod="0"><div class="sl">${body}</div><div class="sc">${sc}</div></div></div>`;
  if (!r) return wrap(`<b>Phone access</b> <span class="tag">machine</span> ${chip('warn', 'off')}
    <span class="help">Off: this dashboard answers on this computer only. To reach it from your phone through Tailscale (free, about 10 minutes), run <span class="mono">norn remote setup</span>: it checks, prints each command and changes nothing until you add <span class="mono">--apply</span>. SETUP.md "Reach Norn from your phone" has the steps and the Cloudflare Access option.</span>`);
  const dev = d => `<li><b>${esc(d.name)}</b>${d.id === r.viewer ? ' <span class="tag">this device</span>' : ''} <span class="mute">${esc(d.login)} · paired ${esc(fmtTime(d.created))} · seen ${esc(fmtTime(d.last_seen))}</span>
    <button class="ghost" data-act="remote-revoke" data-id="${esc(d.id)}" data-name="${esc(d.name)}">Revoke</button></li>`;
  const pair = r.viewer ? '<span class="small mute">You are on a paired device: a new device is paired from the desktop.</span>'
    : '<button class="strong" data-act="remote-pair">Pair a device</button><div id="remote-code" class="remote-code" role="status"></div>';
  return wrap(`<b>Phone access</b> <span class="tag">machine</span> ${chip('ok', r.trust === 'tailscale' ? 'on · Tailscale Serve' : 'on · Cloudflare Access')}
    <span class="small mute"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a> · ${r.logins.length ? esc(r.logins.join(', ')) : 'any login of your private network'}</span>
    <span class="help">Open the address on a phone signed in to the same private network and pair it once with a code from here. Approvals and every other write from a phone count only on a paired device, and each is stamped with it.</span>
    <ul class="small devices">${r.devices.length ? r.devices.map(dev).join('') : '<li class="mute">No paired device yet.</li>'}</ul>`, pair);
}
// META-OOTB-POLISH F-6: start from a profile (fills the form only: Review + Save stay the human step) and a basic / all split
// (basic = the rows flagged by policy.mjs BASIC_KEYS; the browser hides the rest, setFilter)
function profileBar(d, level) {
  const ps = d.profiles || [], opt = p => `<option value="${esc(p.name)}" title="${esc(p.summary)}">${esc(p.label)}${p.default ? ' (default)' : ''}</option>`;
  const lv = (v, t) => `<button class="${v === level ? 'strong' : 'ghost'}" data-set-level="${v}" aria-pressed="${v === level}">${t}</button>`;
  return `<div class="sprofile card" id="set-profile">${ps.length ? `<label>Start from a profile <select data-set-profile data-profiles="${esc(JSON.stringify(Object.fromEntries(ps.map(p => [p.name, p.changes]))))}">${ps.map(opt).join('')}</select></label>
    <label>cost <select data-set-cost><option value="cheap">cheap</option><option value="balanced" selected>balanced</option><option value="quality">quality</option></select></label>
    <button class="ghost" data-act="set-profile">Fill in</button>` : ''}<span class="small mute" id="set-profile-note">${ps.length ? esc(ps[0].summary) : ''}</span>
    <span class="lvl">Show ${lv('basic', 'Basic')}${lv('all', 'All')}</span></div>`;
}
function settings(d, ctx) {
  const sections = d.sections || [], at = s => (s.section || []).join('/'), sel = sections.some(c => c.id === ctx.setCat) ? ctx.setCat : sections[0]?.id;
  const nav = sections.map(c => {
    const rows = d.settings.filter(s => s.section?.[0] === c.id), mods = rows.filter(s => s.modified).length, basicIn = x => !!c.basic || rows.some(s => s.basic && s.section[1] === x);
    return `<button class="navcat${c.id === sel ? ' on' : ''}" id="nav-${esc(c.id)}" data-setcat="${esc(c.id)}" data-basic="${c.basic || rows.some(s => s.basic) ? 1 : 0}" aria-pressed="${c.id === sel}">${esc(c.label)}${mods ? `<span class="mcount" title="${mods} modified from default">${mods}</span>` : ''}</button>`
      + `<div class="navsubs">${c.subs.map(x => `<button class="navsub" data-setcat="${esc(c.id)}" data-basic="${basicIn(x.id) ? 1 : 0}" data-setsub="sub-${esc(c.id)}-${esc(x.id)}">${esc(x.label)}</button>`).join('')}</div>`;
  }).join('');
  const panes = sections.map(c => {
    const subs = c.info ? (c.id === 'notify' ? notifyPane(d) + remotePane(d.remote) : filesPane(d)) : c.subs.map(x => {
      const items = d.settings.filter(s => at(s) === `${c.id}/${x.id}` || at(s).startsWith(`${c.id}/${x.id}/`));
      const body = x.subs ? x.subs.map(y => { const g = items.filter(s => s.section[2] === y.id); return g.length ? (x.inline ? inlineGroup(c, x, y, g) : g.map(row).join('')) : ''; }).join('') : items.map(row).join('');
      return `<div class="ssub${x.danger ? ' danger' : ''}" id="sub-${esc(c.id)}-${esc(x.id)}"><h3>${esc(x.label)}${x.help ? ` <span class="help">${esc(x.help)}</span>` : ''}</h3>${body}</div>`;
    }).join('');
    return `<section class="scat" id="cat-${esc(c.id)}" data-cat="${esc(c.id)}"${c.id === sel ? '' : ' hidden'}><h2>${esc(c.label)}</h2><p class="small mute">${esc(c.help)}</p>${subs}</section>`;
  }).join('');
  return `${profileBar(d, ctx.setLevel ?? 'basic')}<div class="settings"><aside class="snav"><input type="search" id="set-search" data-set-search placeholder="Search settings  ·  @modified" aria-label="Search settings">${nav}</aside>
   <div class="spane"><p class="small mute" id="set-nohit" hidden>No setting matches.</p>${panes}</div></div>
   <div class="savebar"><span class="small" id="dirty-count">No unsaved changes</span><button class="strong" data-act="settings-review" data-project="${esc(d.project)}" data-version="${esc(d.version)}">Review changes</button><button class="ghost" data-act="settings-discard">Discard</button>
   <span class="small mute">Review shows a diff; Save writes atomically and refuses a stale version (409).</span><div id="settings-diff"></div></div>`;
}

// ---------- usage (META-OPS-R1 #7): cost per lane / stage / executor / day from /api/usage (engine/lib/cost.mjs) ----------
/** Group roll-up rows by keys: Claude token types + % summed, Codex / provider tokens apart; sorted by % then Codex tokens. */
export function usageGroup(rows, keys) {
  const m = new Map();
  for (const r of rows) {
    const k = keys.map(x => r[x]).join('|');
    let g = m.get(k);
    if (!g) m.set(k, g = { ...Object.fromEntries(keys.map(x => [x, r[x]])), runs: 0, running: 0, cache_read: 0, cache_create: 0, input: 0, output: 0,
      pct: null, codex: 0, provider: 0, executors: [] });
    g.runs += r.runs; g.running += r.running;
    if (!g.executors.includes(r.executor)) g.executors.push(r.executor);
    if (r.family === 'claude') { for (const t of ['cache_read', 'cache_create', 'input', 'output']) g[t] += r[t] || 0; if (fin(r.pct)) g.pct = (g.pct ?? 0) + r.pct; }
    else if (r.family === 'codex') g.codex += r.tokens || 0;
    else if (r.family === 'provider') g.provider += r.tokens || 0;
  }
  return [...m.values()].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.codex - a.codex || String(keys.map(x => a[x])).localeCompare(String(keys.map(x => b[x]))));
}
const pct2 = n => (fin(n) ? `${n < 0.1 && n > 0 ? n.toFixed(3) : n.toFixed(2)} %` : '-');
const fmtS = s => (fin(s) ? (s < 90 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`) : '-');
function usageTable(id, title, note, rows, keys, maxPct) {
  const head = keys.map(k => `<th>${esc(k)}</th>`).join('');
  const body = rows.map(g => `<tr>${keys.map((k, i) => `<td>${i ? esc(g[k]) : `<b>${esc(g[k])}</b>`}</td>`).join('')}
    <td class="mono">${g.runs}${g.running ? ' ' + chip('running', g.running + ' live') : ''}</td>
    <td class="small">${g.executors.map(e => chip(exClass(e), e)).join(' ')}</td>
    <td class="mono">${mTok(g.cache_read)}</td><td class="mono">${mTok(g.cache_create)}</td><td class="mono">${mTok(g.input)}</td><td class="mono">${mTok(g.output)}</td>
    <td style="width:16%">${fin(g.pct) ? `<span class="mono">${pct2(g.pct)}</span>${bar(g.pct, maxPct)}` : dash}</td>
    <td class="mono">${g.codex ? mTok(g.codex) : dash}</td><td class="mono">${g.provider ? mTok(g.provider) : dash}</td></tr>`).join('')
    || `<tr><td colspan="${keys.length + 9}" class="mute">No runs in the window.</td></tr>`;
  return `<div class="tablecard" id="${esc(id)}"><h3>${esc(title)} <span class="mute small">${esc(note)}</span></h3><table><thead><tr>${head}<th>runs</th><th>executors</th>
    <th>cache read</th><th>cache create</th><th>input</th><th>output</th><th>% of week (Claude)</th><th>Codex tok</th><th>own-account tok</th></tr></thead><tbody>${body}</tbody></table></div>`;
}
const fmtUtc = iso => { const t = Date.parse(iso ?? ''); if (!Number.isFinite(t)) return '-';
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(t).getUTCDay()]} ${new Date(t).toISOString().slice(0, 16).replace('T', ' ')}Z`; };
function usagePart(p, ctx) {
  const t = p.totals, c = p.checkins, k = p.calib, rows = p.rows || [], sec = p.secondary;
  const head = p.window === 'week' ? `since the weekly reset ${fmtUtc(p.since)}` : `runs started in the last ${p.days} days (no weekly reset in the budget)`;
  const secRows = sec ? `<span class="mute small">rolling ${sec.rolling.days} days</span><div class="mono" id="usage-rolling">${pct2(sec.rolling.pct)} · ${sec.rolling.runs} runs · ${mTok(sec.rolling.cache_read)} cache read</div>
     <span class="mute small">last 24 h</span><div class="mono" id="usage-24h">${pct2(sec.last24h.pct)} · ${sec.last24h.runs} runs · ${mTok(sec.last24h.cache_read)} cache read</div>` : '';
  const maxPct = Math.max(0.01, ...usageGroup(rows, ['lane']).map(g => g.pct ?? 0));
  // META-OPS-R3: the headline is the account's number (every Claude session since the reset) when the cache has it; lanes stay runs
  const A = p.account, hp = p.headline ? p.headline.pct : t.claude.pct, rf = ctx.refresh || {}, out = A ? A.outside : null;
  const acctRows = A ? `<span class="mute small">account, since the weekly reset</span><div class="mono"><b>${pct2(A.pct)}</b> · ${int(A.messages)} messages · ${mTok(A.cache_read)} cache read · <span class="mute">cache age ${fmtS(A.age_s)} (scanned ${esc(fmtUtc(A.at))})${rf.running ? ', refreshing' : ''}</span></div>
     <span class="mute small">norn runs</span><div class="mono">${pct2(t.claude.pct)} · ${t.claude.runs} runs <span class="small mute">(the lane rows below)</span></div>
     <span class="mute small">outside runs (interactive)</span><div class="mono"><b>${pct2(out.pct)}</b> · ${mTok(out.cache_read)} cache read${out.clamped ? ` <span class="small">(runs exceed the account: raw delta ${out.raw_pct.toFixed(2)} %)</span>` : ''} <span class="small mute">controller / owner sessions not launched by norn run</span></div>`
    : `<span class="mute small">account: n/a</span><div class="small mute">${rf.running ? 'account scan running (the first one reads the whole transcripts root: minutes)' : 'no account-usage cache for this provider'} - the headline is the norn runs only</div>`;
  const pt = c.per_tick, l24 = c.last24h;
  const ck = c.ticks ? `<div class="kv">
     <span class="mute small">last 24 h</span><div><span class="big">${l24.ticks}</span> ticks · ${mTok(l24.cache_read)} cache read · ${mTok(l24.cache_create)} cache create · <b>${pct2(l24.pct)}</b> of week</div>
     <span class="mute small">ticks / day</span><div><b>${c.ticks_per_day.toFixed(1)}</b> <span class="mute">(${c.ticks} in ${(c.days ?? p.days).toFixed(1)} days)</span> · mean ${fmtS(c.mean_s)} a tick</div>
     <span class="mute small">tokens / tick</span><div class="mono">${mTok(pt.cache_read)} cache read · ${mTok(pt.cache_create)} cache create · ${int(pt.input)} input · ${mTok(pt.output)} output · ${pct2(pt.pct)}</div>
     <span class="mute small">% of week / day</span><div><b>${pct2(c.pct_per_day)}</b> <span class="small mute">the baseline the event-driven check-ins are judged against</span></div></div>`
    : '<div class="small mute">No check-in with a measured usage in the window.</div>';
  return `<div id="usage-${esc(p.project)}">${ctx.project === 'all' ? `<h2>${esc(p.project)}</h2>` : ''}
   <div class="grid2"><section class="card" id="usage-summary"><h2>Usage <b style="white-space:nowrap">${pct2(hp)}</b> of week <span class="mute small">Claude ${A ? 'account' : 'norn runs'}, ${esc(head)}${p.next_reset ? ` · next ${esc(fmtUtc(p.next_reset))}` : ''}</span></h2>
     <div class="kv" id="usage-account">${acctRows}</div><div class="kv">${secRows}<span class="mute small">Claude</span><div class="mono">${t.claude.runs} runs · ${mTok(t.claude.cache_read)} cache read · ${mTok(t.claude.cache_create)} cache create · ${mTok(t.claude.input)} input · ${mTok(t.claude.output)} output</div>
     <span class="mute small">Codex</span><div class="mono">${t.codex.runs} runs · ${mTok(t.codex.tokens)} tokens <span class="small mute">(totals only; its own plan)</span></div>
     <span class="mute small">own account</span><div class="mono">${t.provider.runs} runs · ${mTok(t.provider.tokens)} tokens <span class="small mute">(providers; not in the Claude %)</span></div>
     <span class="mute small">unmeasured</span><div class="small">${t.unmeasured} runs <span class="mute">(no final usage and no transcript, or grok)</span></div>
     <span class="mute small">calibration</span><div class="small">cacheR_per_pct ${fin(k.cacheR_per_pct) ? mTok(k.cacheR_per_pct) : '- (not set: no %)'} · ${fin(k.mix) ? `1 weighted token = ${k.mix.toFixed(3)} cache read` : 'no Claude tokens'}
       <div class="mute">weights per token, in cache reads: input ${k.weights.input}, output ${k.weights.output}, cache create ${k.weights.cache_create_1h} (1 h) / ${k.weights.cache_create_5m} (5 min)</div></div>
     <span class="mute small">roll-up</span><div class="small mute">${p.cost.runs} runs scanned in ${p.cost.ms.toFixed(1)} ms · ${mTok(p.cost.bytesRead)} B of transcript read</div></div></section>
   <section class="card" id="usage-checkins"><h2>Check-ins <span class="mute small">lane checkin, the 15-min heartbeat</span></h2>${ck}</section></div>
   ${weekCard(p.week)}
   ${usageTable('usage-lane', 'By lane', 'cost of each lane in the window', usageGroup(rows, ['lane']), ['lane'], maxPct)}
   ${usageTable('usage-stage', 'By lane and stage', '', usageGroup(rows, ['lane', 'stage']), ['lane', 'stage'], maxPct)}
   ${usageTable('usage-executor', 'By executor', '', usageGroup(rows, ['executor']), ['executor'], maxPct)}
   ${usageTable('usage-day', 'By day', 'UTC day the run started', usageGroup(rows, ['day']).sort((a, b) => String(b.day).localeCompare(String(a.day))), ['day'], maxPct)}</div>`;
}
// META-GUARD R1 item 2: where the week's tokens went - per lane + stage, outcomes, merged, per merged branch; the top 5 spenders with why
const pcA = x => (fin(x) ? '~' + pct2(x) : dash);
function weekCard(w) {
  if (!w || w.error) return w?.error ? `<div class="tablecard" id="usage-week"><h3>Where the tokens went</h3><div class="small mute">${esc(w.error)}</div></div>` : '';
  const body = (w.rows || []).map(r => `<tr><td><b>${esc(r.lane)}</b></td><td>${esc(r.stage)}</td><td class="mono">${r.runs}${r.running ? ' ' + chip('running', r.running + ' live') : ''}</td>
    <td class="mono">${mTok(r.tokens.input)}</td><td class="mono">${mTok(r.tokens.cache_create)}</td><td class="mono">${mTok(r.tokens.cache_read)}</td><td class="mono">${mTok(r.tokens.output)}</td>
    <td class="mono">${pcA(r.pct)}</td><td class="small">${r.outcomes.done} done · ${r.outcomes.stopped} stopped · ${r.outcomes.handoff} handoff</td><td class="mono">${r.merged}</td>
    <td class="mono small">${r.per_merged ? `${mTok(r.per_merged.cache_read)} cache read · ${mTok(r.per_merged.output)} out${fin(r.per_merged.pct) ? ' · ' + pcA(r.per_merged.pct) : ''}` : dash}</td></tr>`).join('')
    || '<tr><td colspan="11" class="mute">No runs in the window.</td></tr>';
  const top = (w.top || []).map(t => `<li><span class="id">${esc(t.id)}</span> <b>${esc(t.lane)}</b> ${esc(t.stage)} ${chip(t.outcome === 'done' ? 'done' : t.state === 'running' ? 'running' : 'idle', t.outcome ?? t.state)} <span class="mono">${pcA(t.pct)}</span> · ${mTok(t.cache_read)} cache read <span class="small mute">- ${esc(t.why)}</span></li>`).join('');
  return `<div class="tablecard" id="usage-week"><h3>Where the tokens went <span class="mute small">${w.window === 'week' ? 'this plan week' : 'last 7 days'} · ${w.totals.runs} runs · ${pcA(w.totals.pct)} of the plan · ${w.totals.merged} merged · token types are never added up</span></h3>
   <table><thead><tr><th>lane</th><th>stage</th><th>runs</th><th>input</th><th>cache write</th><th>cache read</th><th>output</th><th>~plan</th><th>outcome</th><th>merged</th><th>per merged branch</th></tr></thead><tbody>${body}</tbody></table>
   <h3 style="margin-top:10px">Top 5 spenders <span class="mute small">why = turns x mean context (each turn re-reads it)</span></h3><ol id="usage-top" class="small">${top || '<li class="mute">none</li>'}</ol></div>`;
}
function usage(d, ctx) {
  const parts = d.parts || [];
  return `<div class="banner">Headline: the Claude account (every session since the weekly reset, from the account-usage cache a background scan writes); the lane rows are norn runs. Cost per lane: Claude runs count their CLI final usage (running / killed ones their transcript, live); the % of week is
   the current weekly window's (since the budget's reset) cache reads / the budget's cacheR_per_pct (the calibration), shared out by price-weighted tokens. Codex: totals only.
   ${d.cached ? 'Cached view (one 15 s tick).' : `Computed in ${fin(d.ms) ? d.ms.toFixed(0) : '-'} ms.`}</div>
   ${parts.map(p => usagePart(p, { ...ctx, refresh: d.account_refresh })).join('') || '<p class="mute">No project.</p>'}`;
}

// ---------- the Roadmap tab (META-ROADMAP S2, SPEC sec. 4 option A; owner Q-17): the tree with a NOW line ----------
// One tree per project from /api/roadmap (derived status, never typed). Per theme: the past folded above a NOW rule, the present
// rows in full, the future folded below. The scope strip is a tap-to-filter switch (Urd was / Verdandi is / Skuld shall be; classic:
// Past / Now / Next; tap the active one again = all; the scope lives in the URL hash). Every row carries a time line: first activity
// -> now with one stretch per run (colour = run state) and a NOW tick, one shared window per theme; planned rows a dashed stub.
// The views list: a switch is drawn only when there is more than one. S2b (owner Q-17): the board (Urd was / Verdandi is / Skuld
// shall be columns, the themes as rows aligned across them) is the second view; the tree stays the default.
export const RM_VIEWS = [['tree', 'Tree'], ['board', 'Board']];
const rmView = f => (RM_VIEWS.some(v => v[0] === f?.view) ? f.view : RM_VIEWS[0][0]);
export const RM_SCOPES = ['past', 'present', 'future'];
const RM_ST = { shipped: ['shipped', 'ok'], dropped: ['dropped', 'idle'], building: ['building', 'running'], waiting: ['needs you', 'needs'], built: ['built, not merged', 'warn'],
  merged: ['merged, not installed', 'warn'], queued: ['queued', 'idle'], planned: ['planned', 'idle'], idea: ['idea', 'idle'] };
const RM_SG = { done: 'ok', live: 'running', queued: 'idle', planned: 'plan', stopped: 'bad', handoff: 'warn', ended: 'warn', killed: 'bad', lost: 'bad' };
const RM_WORDS = { norn: [['Urd', 'was'], ['Verdandi', 'is'], ['Skuld', 'shall be']], classic: [['Past', 'done'], ['Now', 'in flight'], ['Next', 'planned']] };
const RM_NOW = 88;   // % of a time line: the theme window 0 .. 88, NOW at 88, the future side (stubs, no dates) 88 .. 100
/** the scope after a tap: the tapped one, or all (null) when it was already active */
export const rmScopeNext = (cur, tapped) => (cur === tapped ? null : tapped);
// the hash: the tree keeps the S2 words (#past, #rm-RM-3); another view is a prefix (#board, #board-past, #board-rm-RM-3)
const rmPre = view => (view && view !== RM_VIEWS[0][0] && RM_VIEWS.some(v => v[0] === view) ? view : '');
export const rmHash = (scope, view) => { const p = rmPre(view), s = RM_SCOPES.includes(scope) ? scope : ''; return p || s ? '#' + [p, s].filter(Boolean).join('-') : ''; };
/** the whole Roadmap hash from its state: a deep link wins over the scope; the view rides along */
export const rmUrlHash = (rm = {}) => (rm.item ? `#${rmPre(rm.view) ? rmPre(rm.view) + '-' : ''}rm-${rm.item}` : rmHash(rm.scope, rm.view));
/** '#past' -> { scope }, '#rm-RM-3' -> { item } (a deep link), '#board-past' -> { view, scope }, anything else -> {} */
export function parseRmHash(h) {
  let s = String(h || '').replace(/^#/, '');
  const v = RM_VIEWS.find(([k]) => s === k || s.startsWith(k + '-'))?.[0], o = v ? { view: v } : {};
  if (v) s = s.slice(v.length + 1);
  if (!s) return o;
  if (RM_SCOPES.includes(s)) return { ...o, scope: s };
  const m = s.match(/^rm-(RM-\d+)$/);
  return m ? { ...o, item: m[1] } : {};
}
/** one item against the filters (scope, theme, status, live only, drift only, text over title / id / links / branches); pure */
export function rmMatch(i, f = {}, theme = null) {
  if (f.scope && i.phase !== f.scope) return false;
  if (f.theme && theme && f.theme !== theme) return false;
  if (f.status && i.status !== f.status) return false;
  if (f.live && !(i.live || []).length) return false;
  if (f.drift && !(i.flags?.drift || []).length) return false;
  const q = String(f.q || '').trim().toLowerCase();
  if (q && !q.split(/\s+/).every(w => [i.title, i.id, ...(i.links || []), ...(i.branches || []).map(b => b.name)].join(' ').toLowerCase().includes(w))) return false;
  return true;
}
const rmFiltered = f => !!(f.scope || f.theme || f.status || f.live || f.drift || String(f.q || '').trim());
const rmAgo = (iso, now) => { if (!iso) return ''; const d = (now - Date.parse(iso)) / 864e5; return d < 1 ? `${Math.max(1, Math.round(d * 24))} h ago` : `${Math.round(d)} d ago`; };
const rmDay = iso => (iso ? new Date(iso).toISOString().slice(5, 10) : '');
const rmFlat = (ns, depth = 0) => ns.flatMap(n => [...(n.kind === 'item' ? [{ ...n, depth }] : []), ...rmFlat(n.children || [], n.kind === 'item' ? depth + 1 : depth)]);
// an id as the dashboard's id chip: DIR / DEC / Q / RUN / L: jump to their tab, DLV opens the drawer
function rmRid(id, ctx) {
  if (/^DLV-/.test(id)) return `<a class="rid r-dlv" href="#" data-dlv="${esc(id)}" data-project="${esc(ctx.project)}">${esc(id)}</a>`;
  const k = id.split(/[-:]/)[0].toLowerCase();
  return `<a class="rid r-${k === 'l' ? 'l' : esc(k)}" href="#" data-rid="${esc(id)}">${esc(id)}</a>`;
}
const rmChip = i => `<span class="chip ${(RM_ST[i.status] || ['', 'idle'])[1]}">${esc((RM_ST[i.status] || [i.status])[0])}</span>${i.flags?.claimed ? `<span class="chip idle claimed" title="${esc(i.flags.claimed)}">claimed</span>` : ''}`;
const rmLive = (i, ctx) => (i.live || []).map(id => `<span class="rmlive" role="button" tabindex="0" data-feed="${esc(id)}" data-project="${esc(ctx.project)}" title="open the live feed"><i></i>${esc(id)}</span>`).join('');
const rmProg = i => (i.progress?.total ? `<span class="rmprog" title="stages DONE + branches at the target, of all"><span class="bar"><i style="width:${Math.round(100 * i.progress.done / i.progress.total)}%"></i></span>${i.progress.done}/${i.progress.total}</span>` : '');
function rmStages(i, max = 7) {
  const real = (i.stages || []).filter(s => s.state !== 'planned'), plan = (i.stages || []).filter(s => s.state === 'planned');
  const cut = Math.max(0, real.length - max), shown = real.slice(cut).concat(plan);
  if (!shown.length) return '';
  return `<div class="rmstages">${cut ? `<span class="mute small">+${cut} earlier</span>` : ''}${shown.map(s => `<span class="rmst sg-${RM_SG[s.state] || 'idle'}" title="${esc(s.lane ? `lane ${s.lane}, ` : '')}${s.runs || 0} run(s)${s.run ? `, latest ${s.run}` : ''}"><i></i>${esc(s.key)}<small>${esc(s.state)}</small></span>`).join('')}</div>`;
}
function rmLinks(i, ctx) {
  const by = k => (i.links || []).filter(t => t.startsWith(k + ':')).map(t => t.slice(k.length + 1));
  const ids = [...by('dir'), ...by('dec'), ...by('q'), ...by('ep'), ...by('run'), ...by('dlv'), ...by('lane').map(l => 'L:' + l)];
  const shown = ids.slice(0, 8).map(id => rmRid(id, ctx)).join(' ') + (ids.length > 8 ? ` <span class="mute small">+${ids.length - 8}</span>` : '');
  const known = new Set((i.branches || []).map(b => b.name));
  const br = [...(i.branches || []), ...by('branch').filter(b => !known.has(b)).map(name => ({ name, state: null }))].slice(0, 3)
    .map(b => `<span class="rmbr b-${esc(b.state || 'linked')}">${esc(b.name)}${b.dlv ? ' ' + rmRid(b.dlv, ctx) : ''}${b.state ? ` <small>${esc(b.state === 'done' ? 'not on main' : b.state)}</small>` : ''}</span>`).join(' ');
  return [shown, br].filter(Boolean).join(' ');
}
/** the theme's shared time window: the oldest first activity (or evidence) of any of its items .. now; null when none has a date */
function rmWindow(items, now) {
  const ts = items.flatMap(i => [i.first, i.last_evidence]).filter(Boolean).map(Date.parse).filter(Number.isFinite);
  if (!ts.length) return null;
  const t0 = Math.min(now, ...ts);
  return { t0, span: Math.max(now - t0, 36e5), now };
}
const rmPct = x => Math.round(x * 10) / 10;
/** one row's time line: a track to NOW, the item's thread, one stretch per run, a knot for dated evidence without runs, a stub for the future */
function rmTime(i, win) {
  const x = t => rmPct(RM_NOW * Math.min(1, Math.max(0, (t - win.t0) / win.span)));
  const spans = win ? (i.spans || []) : [];
  const parts = [];
  if (spans.length) {
    const a = x(Date.parse(spans[0].from)), end = i.phase === 'past' ? Math.max(...spans.map(s => (s.to ? Date.parse(s.to) : win.now))) : win.now;
    parts.push(`<i class="rmthr" style="left:${a}%;width:${rmPct(x(end) - a)}%"></i>`);
    for (const s of spans) {
      const l = x(Date.parse(s.from)), r = s.to ? x(Date.parse(s.to)) : RM_NOW;
      parts.push(`<i class="rmsp sg-${RM_SG[s.state] || 'idle'}" style="left:${l}%;width:${rmPct(r - l)}%" title="${esc(`${s.run} ${s.state} ${rmDay(s.from)}${s.to ? ' to ' + rmDay(s.to) : ', live'}`)}"></i>`);
    }
  } else if (win && i.last_evidence) parts.push(`<i class="rmknot" style="left:${x(Date.parse(i.last_evidence))}%" title="${esc('evidence ' + rmDay(i.last_evidence))}"></i>`);
  if (i.phase === 'future' || (i.stages || []).some(s => s.state === 'planned') || (i.queued || []).length) parts.push('<i class="rmstub"></i>');
  const label = spans.length ? `${spans.length} run${spans.length === 1 ? '' : 's'} since ${rmDay(spans[0].from)}` : i.phase === 'future' ? `${i.status}, no dates yet` : 'no runs';
  return `<div class="rmtl${spans.length ? '' : ' empty'}" role="img" aria-label="${esc('time line: ' + label)}" title="${esc(label)}"><i class="rmtrack"></i>${parts.join('')}<i class="rmnow"></i></div>`;
}
const rmHead = (i, ctx, par, compact) => `<div class="rmh">${rmChip(i)}${par}<b class="rmt">${esc(i.title)}</b><span class="id">${esc(i.id)}</span>${i.horizon ? `<span class="tg tg-hz">${esc(i.horizon)}</span>` : ''}${rmLive(i, ctx)}${(i.flags?.drift || []).length ? '<span class="chip bad">drift</span>' : ''}${compact ? '' : rmProg(i)}${rmEditBtn(i)}</div>`;
function rmRow(i, ctx, win, compact) {
  const f = ctx.rm || {}, hit = f.item === i.id ? ' hit' : '';
  const par = i.depth ? `<span class="rmpar mute small" title="nested item">${'&#8250; '.repeat(i.depth)}</span>` : '';
  const head = rmHead(i, ctx, par, compact);
  const why = `<span class="mute">${esc(i.why)}${compact && i.last ? ' · ' + rmAgo(i.last, ctx.now) : ''}${i.flags?.idle != null ? ` · idle ${i.flags.idle} d` : ''}</span>`;
  const body = compact ? `<div class="rmw small">${why} ${rmLinks(i, ctx)}</div>`
    : `<div class="rmw small">${why} ${rmLinks(i, ctx)}</div>${rmStages(i)}${(i.flags?.drift || []).length || (i.flags?.gone || []).length ? `<div class="rmdrift">${i.flags.drift.map(d => `<div>Drift: ${esc(d)}</div>`).join('')}${(i.flags.gone || []).map(g => `<div>Link gone: ${esc(g)}</div>`).join('')}</div>` : ''}`;
  return `<div class="rmi${compact ? ' c' : ''} ph-${esc(i.phase)}${hit}" id="rm-${esc(i.id)}" data-rm-row>${head}${rmTime(i, win)}${body}</div>`;   // desktop: the time line in its own column; phone: under the title
}
const rmPlural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const rmFoldText = (items, phase) => (phase === 'past' ? [['shipped', 'shipped'], ['dropped', 'dropped']] : [['queued', 'queued'], ['planned', 'planned'], ['idea', 'idea']])
  .map(([k, w]) => [items.filter(i => i.status === k).length, w]).filter(([n]) => n).map(([n, w]) => (w === 'idea' ? rmPlural(n, 'idea') : `${n} ${w}`)).join(' · ');
const rmFutOrder = i => ['queued', 'planned', 'idea'].indexOf(i.status) * 10 + ({ now: 0, next: 1, later: 3 }[i.horizon] ?? 2);
const RM_SORT = { past: (a, b) => String(b.last || '').localeCompare(String(a.last || '')), present: (a, b) => ((b.live || []).length - (a.live || []).length) || String(b.last || '').localeCompare(String(a.last || '')),
  future: (a, b) => rmFutOrder(a) - rmFutOrder(b) };
const rmPhase = (xs, k) => xs.filter(i => i.phase === k).sort(RM_SORT[k]);
function rmTheme(t, d, ctx, nThemes) {
  const f = ctx.rm || {}, now = ctx.now, filtered = rmFiltered(f);
  const all = rmFlat(t.children || []), win = rmWindow(all, Date.parse(d.generated) || now);
  const vis = all.filter(i => rmMatch(i, f, t.id));
  if (filtered && !vis.length && !all.some(i => i.id === f.item)) return '';
  const [past, pres, fut] = RM_SCOPES.map(k => rmPhase(vis, k));
  const deep = id => [past, pres, fut].findIndex(g => g.some(i => i.id === id));
  const live = all.filter(i => (i.live || []).length).length, c = t.counts || {}, tot = Math.max(1, all.length);
  const open = filtered || deep(f.item) >= 0 || live > 0 || (nThemes <= 5 && (c.present || 0) > 0);
  const rows = (xs, compact) => xs.map(i => rmRow(i, ctx, win, compact)).join('');
  const fold = (xs, ph, isOpen) => (xs.length ? `<details class="rmfold f-${ph}"${isOpen ? ' open' : ''}><summary>${rmFoldText(xs, ph) || rmPlural(xs.length, 'item')}${ph === 'past' ? `<span class="mute small"> · latest ${rmAgo(xs[0].last, now) || 'n/a'}</span>` : ''}</summary>${rows(xs, true)}</details>` : '');
  const winText = win ? `time line ${rmDay(new Date(win.t0).toISOString())} to now` : 'no run yet';
  return `<details class="rmth" id="rmt-${esc(t.id)}"${open ? ' open' : ''}><summary><span class="tw"></span><b>${esc(t.title)}</b><span class="id">${esc(t.id)}</span>${t.state === 'dropped' ? '<span class="chip idle">dropped</span>' : ''}${rmEditBtn(t)}
    <span class="rmthread mini" aria-hidden="true"><i class="th-past" style="flex:${(c.past || 0) / tot}"></i><i class="th-present" style="flex:${(c.present || 0) / tot}"></i><i class="th-future" style="flex:${(c.future || 0) / tot}"></i></span>
    <span class="small mute">${c.past || 0} was · <b class="c-now">${c.present || 0} is</b> · ${c.future || 0} shall be · ${winText}</span>${live ? `<span class="chip running">${live} live</span>` : ''}</summary>
    <div class="rmbody">${fold(past, 'past', filtered || deep(f.item) === 0)}<div class="nowline"><span>NOW</span></div>${f.scope === 'past' || f.scope === 'future' ? '' : rows(pres, false) || '<div class="rmi c mute small">nothing in flight</div>'}${fold(fut, 'future', filtered || deep(f.item) === 2 || fut.length <= 3)}</div></details>`;
}
function rmTop(d, ctx) {
  const f = ctx.rm || {}, c = d.counts || {}, tot = Math.max(1, c.items || 0), words = RM_WORDS[ctx.look === 'norn' ? 'norn' : 'classic'];
  const scope = RM_SCOPES.map((k, n) => `<button type="button" class="sc sc-${k}" data-rm-scope="${k}" aria-pressed="${f.scope === k}" title="${f.scope === k ? 'show all again' : `show only ${['what was', 'what is', 'what shall be'][n]}`}"><span class="nn">${words[n][0]}</span><small>${words[n][1]}</small><b>${c[k] || 0}</b></button>`).join('');
  const sel = (k, label, opts) => `<select data-rmf="${k}" aria-label="${label}"><option value="">${label}</option>${opts.map(([v, t]) => `<option value="${esc(v)}"${String(f[k] || '') === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  const statuses = Object.keys(RM_ST).filter(s => rmFlat(d.themes).some(i => i.status === s));
  const views = RM_VIEWS.length > 1 ? `<span class="rmviews" role="group" aria-label="Roadmap view">${RM_VIEWS.map(([k, w]) => `<button type="button" data-rm-view="${k}" aria-pressed="${rmView(f) === k}">${esc(w)}</button>`).join('')}</span>` : '';
  const items = rmFlat(d.themes), shown = items.filter(i => rmMatch(i, f, rmThemeOf(d, i.id))).length;
  return `<div class="rmtop"><div class="rmscope" role="group" aria-label="Show what was, what is or what shall be (tap again for all)">${scope}</div>
    ${c.live ? `<button type="button" class="chip running" data-rmf-set="live" title="show only live items">${c.live} live</button>` : ''}${c.drift ? `<button type="button" class="chip bad" data-rm-jump="rm-drift">${c.drift} drift</button>` : ''}${c.unplaced ? `<button type="button" class="chip warn" data-rm-jump="rm-unplaced">${c.unplaced} unplaced</button>` : ''}${c.claimed ? `<span class="chip idle claimed">${c.claimed} claimed</span>` : ''}${views}<button type="button" class="rmadd" data-rm-edit="new" title="add an item or a theme">+ Add</button></div>
  <div class="rmthread" aria-hidden="true">${RM_SCOPES.map(k => `<i class="th-${k}" style="flex:${(c[k] || 0) / tot}"></i>`).join('')}</div>
  <div class="filters rmfilters"><input type="search" data-rmf="q" value="${esc(f.q || '')}" placeholder="filter titles, ids, branches" aria-label="Filter the roadmap">${sel('theme', 'all themes', (d.themes || []).map(t => [t.id, t.title]))}${sel('status', 'all states', statuses.map(s => [s, RM_ST[s][0]]))}
    <label class="small"><input type="checkbox" data-rmf="live"${f.live ? ' checked' : ''}> live only</label><label class="small"><input type="checkbox" data-rmf="drift"${f.drift ? ' checked' : ''}> drift only</label>
    ${rmFiltered(f) ? `<span class="small mute">showing ${shown} of ${items.length}</span><button type="button" data-rm-clear>show all</button>` : ''}</div>
  <div class="small mute rmsrc">${esc(d.title || d.project)} · ${c.items || 0} items in ${(d.themes || []).length} themes · derived ${esc(fmtTime(d.generated, ctx.now))}${d.error ? ` · <span class="chip bad">error</span> ${esc(d.error)}` : ''}</div>`;
}
const rmThemeOf = (d, id) => (d.themes || []).find(t => rmFlat(t.children || []).some(i => i.id === id))?.id ?? null;
function rmAudit(d, ctx) {
  const dr = rmFlat(d.themes).filter(i => (i.flags?.drift || []).length);
  return `${dr.length ? `<details class="tablecard rmaudit" id="rm-drift"><summary><h3>Drift <span class="chip bad">${dr.length}</span> <span class="mute small">typed text that disagrees with the records - shown, not trusted</span></h3></summary>
    ${dr.map(i => `<div class="rmau"><span class="id">${esc(i.id)}</span> <b>${esc(i.title)}</b><div class="small">${i.flags.drift.map(esc).join('<br>')}</div></div>`).join('')}</details>` : ''}
  ${(d.unplaced || []).length ? `<details class="tablecard rmaudit" id="rm-unplaced"><summary><h3>Unplaced work <span class="chip warn">${d.unplaced.length}</span> <span class="mute small">live lanes, finished branches and directives no roadmap item links</span></h3></summary>
    ${d.unplaced.map(u => `<div class="rmau">${/^(DIR|DEC|Q|RUN|DLV|L:)/.test(u.id) ? rmRid(u.id, ctx) : `<span class="id">${esc(u.id)}</span>`} <span class="small">${esc(u.why || u.text || '')}</span></div>`).join('')}</details>` : ''}`;
}
// ---------- view B (META-ROADMAP S2b, SPEC sec. 4 option B, owner Q-17): the three Norns board ----------
// Columns Urd was / Verdandi is / Skuld shall be (classic: Past / Now / Next); every theme is one grid row, so its heading stands in
// each column at the same height (sticky under the sticky column heads on a desktop). Cards are compact: the head and the time
// line (the reason text is the card's tooltip); the past and the future show four per theme, the rest folded. A scope leaves its column.
function rmCard(i, ctx, win) {
  const hit = (ctx.rm || {}).item === i.id ? ' hit' : '';
  return `<div class="rmi rmcard ph-${esc(i.phase)}${hit}" id="rm-${esc(i.id)}" data-rm-row title="${esc(i.why || '')}">${rmHead(i, ctx, '', true)}${rmTime(i, win)}</div>`;
}
function rmBoard(d, ctx) {
  const f = ctx.rm || {}, filtered = rmFiltered(f), c = d.counts || {}, words = RM_WORDS[ctx.look === 'norn' ? 'norn' : 'classic'];
  const ks = f.scope ? [f.scope] : RM_SCOPES, word = k => words[RM_SCOPES.indexOf(k)];
  const heads = ks.map(k => `<div class="rmcolh col-${k}"><span class="nn">${word(k)[0]}</span><small>${word(k)[1]}</small><b>${c[k] || 0}</b></div>`).join('');
  const rows = d.themes.map(t => {
    const all = rmFlat(t.children || []), win = rmWindow(all, Date.parse(d.generated) || ctx.now), vis = all.filter(i => rmMatch(i, f, t.id));
    if (filtered && !vis.length && !all.some(i => i.id === f.item)) return '';
    return ks.map(k => {
      const its = rmPhase(vis, k), cap = k === 'present' ? its.length : 4, more = its.slice(cap);
      const open = filtered || more.some(i => i.id === f.item);
      const fold = more.length ? `<details class="rmfold f-${k}"${open ? ' open' : ''}><summary>${more.length} more</summary>${more.map(i => rmCard(i, ctx, win)).join('')}</details>` : '';
      return `<div class="rmcell col-${k}" data-theme="${esc(t.id)}"><h4 class="rmgh"><span class="rmgk">${word(k)[0]} · </span>${esc(t.title)} <span class="mute">${its.length}</span></h4>${its.slice(0, cap).map(i => rmCard(i, ctx, win)).join('') || '<div class="rmnone mute small">nothing</div>'}${fold}</div>`;
    }).join('');
  }).join('');
  return rows ? `<section class="rmboard${ks.length === 1 ? ' n1' : ''}">${heads}${rows}</section>` : '';
}
// ---------- META-ROADMAP S3 (SPEC sec. 3): the edit drawer - structure only (title, place, horizon, note, links, drop / reopen) ----------
// Status is never an input: it stays derived. Each action is ONE POST /api/roadmap/<op> = one record by dashboard; a body carries the
// rev the page saw (and a move the order it saw under the target parent), so a stale page gets a 409 instead of a lost edit.
const rmEditBtn = n => `<button type="button" class="rmedit" data-rm-edit="${esc(n.id)}" title="edit ${esc(n.id)}" aria-label="edit ${esc(n.id)}">&#8943;</button>`;
/** id -> { node, parent (node | null), sibs (the ids under the same parent, in record order) } | null */
export function rmFind(d, id) {
  let hit = null;
  const walk = (xs, parent) => { for (const n of xs) { if (n.id === id) hit = { node: n, parent, sibs: xs.map(x => x.id) }; walk(n.children || [], n); } };
  walk(d?.themes || [], null);
  return hit;
}
const RM_HZ = ['now', 'next', 'later'];
const rmList = v => String(v || '').split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
/** a drawer action -> { op, body } (the POST /api/roadmap/<op> body without the project) | { error } */
export function rmEditBody(act, d, id, v = {}) {
  const txt = k => String(v[k] ?? '').trim();
  if (act === 'add') {
    if (!txt('title')) return { error: 'A title is needed.' };
    if (v.parent === 'theme') return { op: 'add', body: { title: txt('title'), kind: 'theme' } };
    if (!v.parent) return { error: 'Pick a theme.' };
    const links = rmList(v.links);
    return { op: 'add', body: { title: txt('title'), parent: v.parent, ...(v.horizon ? { horizon: v.horizon } : {}), ...(txt('note') ? { note: txt('note') } : {}), ...(links.length ? { links } : {}) } };
  }
  const hit = rmFind(d, id);
  if (!hit) return { error: `${id} is not in this roadmap any more. Reload.` };
  const n = hit.node, base = { id, rev: n.rev };
  if (act === 'edit') {
    const ch = {};
    if (v.title !== undefined && txt('title') && txt('title') !== n.title) ch.title = txt('title');
    if (v.note !== undefined && txt('note') !== (n.note || '')) ch.note = txt('note');
    if (v.horizon !== undefined && (v.horizon || null) !== (n.horizon || null)) ch.horizon = v.horizon || '';
    return Object.keys(ch).length ? { op: 'edit', body: { ...base, ...ch } } : { error: 'Nothing changed.' };
  }
  if (act === 'up' || act === 'down') {
    const s = hit.sibs, i = s.indexOf(id);
    if (act === 'up' ? i === 0 : i === s.length - 1) return { error: `Already ${act === 'up' ? 'first' : 'last'}.` };
    return { op: 'move', body: { ...base, after: act === 'up' ? (i >= 2 ? s[i - 2] : null) : s[i + 1], order: s } };
  }
  if (act === 'theme') {
    const t = v.theme && rmFind(d, v.theme);
    if (!t || v.theme === hit.parent?.id) return { error: 'Pick another theme.' };
    return { op: 'move', body: { ...base, parent: v.theme, order: (t.node.children || []).map(x => x.id) } };
  }
  if (act === 'link') { const links = rmList(v.link); return links.length ? { op: 'link', body: { ...base, links } } : { error: 'Name a link: kind:id (dir:DIR-n, lane:name, branch:feat/x ...).' }; }
  if (act === 'unlink') return { op: 'unlink', body: { ...base, links: [v.link] } };
  if (act === 'drop') {
    if (!txt('why')) return { error: 'Say why it is dropped.' };
    if (!/^(DEC|DIR)-[\w-]+$/.test(txt('ref'))) return { error: 'Cite the ruling: a DEC-n or DIR-n.' };
    return { op: 'drop', body: { ...base, why: txt('why'), ref: txt('ref') } };
  }
  if (act === 'reopen') return txt('why') ? { op: 'reopen', body: { ...base, why: txt('why') } } : { error: 'Say why it comes back.' };
  return { error: `unknown action ${act}` };
}
const rmOpt = (v, t, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(t)}</option>`;
/** the drawer body: id = an RM id, or 'new' (add an item or a theme) */
export function renderRmEditor(d, id, ctx = {}) {
  const themes = d?.themes || [], btn = (act, label, cls = '') => `<button type="button" data-rme-act="${act}"${cls ? ` class="${cls}"` : ''}>${label}</button>`;
  const field = (label, html) => `<label class="rmef"><span class="small mute">${label}</span>${html}</label>`;
  const hz = cur => `<select data-rme="horizon">${rmOpt('', 'none', !cur)}${RM_HZ.map(h => rmOpt(h, h, cur === h)).join('')}</select>`;
  const foot = '<p class="small mute">Status is derived from the links, never typed. Each change is one record (by dashboard); every open tab shows it within about 2 s.</p>';
  if (id === 'new') {
    const first = ctx.theme || themes[0]?.id;
    return `<div class="rmed" data-rmed="new"><h3>Add to the roadmap</h3>
      ${field('Under', `<select data-rme="parent">${themes.map(t => rmOpt(t.id, `${t.title} (${t.id})`, t.id === first)).join('')}${rmOpt('theme', '(a new theme)', !themes.length)}</select>`)}
      ${field('Title', '<input data-rme="title" maxlength="200" placeholder="what it is, in a few words">')}
      ${field('Horizon', hz(null))}${field('Note', '<textarea data-rme="note" rows="3" maxlength="4000"></textarea>')}
      ${field('Links', '<input data-rme="links" placeholder="dir:DIR-n, lane:name, branch:feat/x (optional)">')}
      <div class="rmea">${btn('add', 'Add', 'strong')}</div>${foot}</div>`;
  }
  const hit = rmFind(d, id);
  if (!hit) return `<div class="rmed"><p class="mute">${esc(id)} is not in this roadmap any more. ${btn('reload', 'Reload')}</p></div>`;
  const n = hit.node, item = n.kind === 'item', dropped = n.state === 'dropped';
  const sibs = hit.sibs.map(s => rmFind(d, s)?.node).filter(Boolean);
  const place = `<ol class="rmesibs small">${sibs.map(s => `<li${s.id === id ? ' class="me"' : ''}>${esc(s.title)} <span class="id">${esc(s.id)}</span>${s.state === 'dropped' ? ' <span class="mute">dropped</span>' : ''}</li>`).join('')}</ol>`;
  const otherThemes = themes.filter(t => t.id !== hit.parent?.id);
  const ref = (n.links || []).map(l => /^(?:dir|dec):(.+)$/.exec(l)?.[1]).find(Boolean) || '';
  const links = (n.links || []).map(l => `<li><span class="mono small">${esc(l)}</span> <button type="button" class="ghost" data-rme-act="unlink" data-link="${esc(l)}" aria-label="unlink ${esc(l)}" title="unlink">&#215;</button></li>`).join('');
  return `<div class="rmed" data-rmed="${esc(id)}"><h3><span class="id">${esc(id)}</span> ${item ? rmChip(n) : '<span class="chip idle">theme</span>'}${dropped ? ' <span class="chip idle">dropped</span>' : ''}</h3>
    ${item ? `<p class="small mute">${esc(n.why || '')}</p>` : ''}
    ${field('Title', `<input data-rme="title" maxlength="200" value="${esc(n.title)}">`)}${item ? field('Horizon', hz(n.horizon)) : ''}
    ${field('Note', `<textarea data-rme="note" rows="3" maxlength="4000">${esc(n.note || '')}</textarea>`)}
    <div class="rmea">${btn('edit', 'Save', 'strong')}</div>
    <h4>Place</h4>${place}<div class="rmea">${btn('up', '&#8593; Up')}${btn('down', '&#8595; Down')}</div>
    ${item && hit.parent?.kind === 'theme' && otherThemes.length ? `<div class="rmea"><select data-rme="theme" aria-label="move to theme">${otherThemes.map(t => rmOpt(t.id, `${t.title} (${t.id})`, false)).join('')}</select>${btn('theme', 'Move to theme')}</div>` : ''}
    <h4>Links</h4>${links ? `<ul class="rmelinks">${links}</ul>` : '<p class="small mute">no links yet: an item gets its status from what it links</p>'}
    <div class="rmea"><input data-rme="link" placeholder="dir:DIR-n, lane:name, run:RUN-n, branch:feat/x" aria-label="link">${btn('link', 'Link')}</div>
    ${dropped ? `<h4>Dropped</h4><p class="small">${esc(n.dropped?.why || '')}${n.dropped?.ref ? ` (${esc(n.dropped.ref)})` : ''}</p><div class="rmea"><input data-rme="why" placeholder="why it comes back" aria-label="why">${btn('reopen', 'Reopen')}</div>`
      : `<h4>Drop</h4><div class="rmea"><input data-rme="why" placeholder="why" aria-label="why"><input data-rme="ref" value="${esc(ref)}" placeholder="DEC-n or DIR-n" aria-label="the ruling" size="9">${btn('drop', 'Drop', 'bad')}</div>`}
    ${foot}</div>`;
}
function roadmap(d, ctx) {
  if (!d || !(d.themes || []).length) {   // META-ADOPT A3: what the repository holds + the draft, the questions, or one item by hand
    const a = d?.adopt;
    return `<div class="card" id="rm-empty"><p><b>No roadmap yet</b> for ${esc(ctx.project)}.${a ? ` The repository has ${a.items} planned line(s) in ${a.plans} file(s), ${a.branches} branch(es) in flight.` : ''}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="primary" type="button" data-act="adopt-open" data-project="${esc(ctx.project)}">Draft it from the repository</button><button type="button" data-act="adopt-open" data-ask="scan" data-project="${esc(ctx.project)}">Answer 3 questions instead</button><button type="button" class="rmadd" data-rm-edit="new">+ Add one item</button></div>
      <p class="small mute" style="margin:10px 0 0">Or <code>norn road add</code> / <code>norn road apply plan.json</code>; status is derived from the records, never typed.</p>${d?.error ? `<p class="small">${esc(d.error)}</p>` : ''}</div>`;
  }
  const f = ctx.rm || {}, n = d.themes.length;
  const view = rmView(f), body = view === 'board' ? rmBoard(d, ctx) : d.themes.map(t => rmTheme(t, d, ctx, n)).join('');
  return `<div class="rm rm-${view}">${rmTop(d, ctx)}${body || '<div class="card"><p class="mute">No item matches these filters. <button type="button" data-rm-clear>show all</button></p></div>'}${rmAudit(d, ctx)}</div>`;
}
