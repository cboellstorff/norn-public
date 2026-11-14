// Agents tab data (META-GENERAL-DESIGN 6, 12-S6): one root per RUN, children from the transcript. Transcripts and Codex rollouts
// are tailed incrementally (byte offset cache; only complete appended lines are parsed). Unknown records are ignored (design 13).
import fs from 'node:fs';
import path from 'node:path';
import { parseCodexLog } from './runs.mjs';
import { runName } from './names.mjs';
import { findTranscript, usageCtx } from './harness/claude.mjs';
import { ctxView } from './ctxlimit.mjs';
import { findRollout } from './harness/codex.mjs';

const RECENT_MS = 2 * 3600000;   // ended runs stay in the tree for 2 h
const BURN_MS = 30 * 60000;      // "burning" window (design 6)

// tail(file, cache, onRecord): parse the complete lines appended since the cached offset; returns { c, bytesRead }
export function tail(file, cache, init, onRecord) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  let c = cache.get(file);
  if (!c || st.size < c.offset) { c = { offset: 0, ...init() }; cache.set(file, c); }
  let bytesRead = 0;
  if (st.size > c.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - c.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, c.offset);
      const nl = buf.subarray(0, n).lastIndexOf(10);
      if (nl >= 0) {
        for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          onRecord(c, j);
        }
        c.offset += nl + 1; bytesRead = nl + 1;
      }
    } finally { fs.closeSync(fd); }
  }
  return { c, bytesRead };
}

function onTranscript(c, j) {
  if (j.timestamp && (!c.first || j.timestamp < c.first)) c.first = j.timestamp;
  if (j.timestamp && (!c.last || j.timestamp > c.last)) c.last = j.timestamp;
  const m = j.message, u = m?.usage;
  if (j.type !== 'assistant' || !u) return;
  const key = (m.id || '') + ':' + (j.requestId || '');
  if (c.seen.has(key)) return;
  c.seen.add(key);
  if (m.model) c.model = m.model;
  if (j.effort) c.effort = j.effort;
  c.ctx = usageCtx(u);
  c.peak = Math.max(c.peak ?? 0, c.ctx);
  c.entries.push([Date.parse(j.timestamp), u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0]);
}
const tInit = () => ({ seen: new Set(), entries: [], model: null, effort: null, ctx: null, peak: null, first: null, last: null });

/** One transcript: { model, effort, first, last, ctx (last call in+cacheR+cacheC), peak (its largest call), cacheR (sum), burn30, bytesRead }. */
export function transcriptInfo(file, cache = new Map(), { now = Date.now() } = {}) {
  const r = tail(file, cache, tInit, onTranscript);
  if (!r) return null;
  const { c } = r;
  let cacheR = 0, burn30 = 0;
  for (const [t, cr, cc] of c.entries) { cacheR += cr; if (t >= now - BURN_MS) burn30 += cr + cc; }
  return { model: c.model, effort: c.effort, first: c.first, last: c.last, ctx: c.ctx, peak: c.peak, cacheR, burn30, bytesRead: r.bytesRead };
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** Subagents of a main transcript: <sid>/subagents/agent-<id>.jsonl + agent-<id>.meta.json. */
export function subagents(mainFile, cache = new Map(), { now = Date.now() } = {}) {
  const dir = path.join(mainFile.replace(/\.jsonl$/, ''), 'subagents');
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /^agent-.+\.jsonl$/.test(n)).sort(); } catch { return []; }
  return names.map(n => {
    const id = n.slice('agent-'.length, -'.jsonl'.length);
    const meta = readJson(path.join(dir, `agent-${id}.meta.json`)) || {};
    const t = transcriptInfo(path.join(dir, n), cache, { now }) || {};
    const finished = meta.finished === true;
    return { id, kind: 'subagent', agentType: meta.agentType ?? null, description: meta.description ?? null, model: t.model ?? null,
      effort: meta.effort ?? t.effort ?? null, finished, state: finished ? 'finished' : 'running', first: t.first ?? null,
      last: t.last ?? null, ctx: t.ctx ?? null, cacheR: t.cacheR ?? 0, burn30: t.burn30 ?? 0 };
  });
}

/** Codex rollout: the last token_count event -> { total, last, window, ts }. */
export function codexInfo(file, cache = new Map()) {
  const r = tail(file, cache, () => ({ total: null, last: null, window: null, ts: null }), (c, j) => {
    const info = j.type === 'event_msg' && j.payload?.type === 'token_count' ? j.payload.info : null;
    if (!info) return;
    c.total = info.total_token_usage?.total_tokens ?? c.total;
    c.last = info.last_token_usage?.total_tokens ?? c.last;
    c.window = info.model_context_window ?? c.window;
    c.ts = j.timestamp ?? c.ts;
  });
  return r ? { total: r.c.total, last: r.c.last, window: r.c.window, ts: r.c.ts } : null;
}

// the file locations are the adapters' (harness-agnostic feed, LANE-MAP-DESIGN 2); re-exported for the Agents tab and its tests
export { findTranscript } from './harness/claude.mjs';
export { findRollout } from './harness/codex.mjs';

const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const ended = r => r.state !== 'running';
const QUEUE_STATES = ['queued', 'filled', 'withdrawn'];
// a queue entry is no session: the Agents tab lists the queued ones apart (META-GT12); ended runs stay RECENT_MS
const shown = (r, now) => !QUEUE_STATES.includes(r.state) && !(ended(r) && now - Date.parse(r.updated) > RECENT_MS);
/** The run ids the Agents tree lists now (the Ledger tab links only those, LEDGER-UX R1). */
export const shownRunIds = (runs, now = Date.now()) => new Set([...runs].filter(r => r.kind === 'run' && shown(r, now)).map(r => r.id));

/**
 * Agents tree (design 6): one root per RUN (running, or ended < 2 h ago) + one root per talk session.
 * o: { projectsDir, codexDir, cache (Map, kept by the server), now, policy (the project's: each run's context lines), sessions [{name, model, effort, alive, context}] }
 * META-CTX-ENFORCE R1: ctx = the run's CURRENT context (its last request), ctx_peak beside it, ctx_limit / ctx_hard = its role's policy lines.
 */
export function agentsTree(runs, o = {}) {
  const now = o.now ?? Date.now(), cache = o.cache || new Map();
  const roots = [];
  for (const r of [...runs].filter(x => x.kind === 'run').sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)))) {
    if (!shown(r, now)) continue;
    const d = r.data || {}, end = r.end || {};
    const node = { id: r.id, name: runName(r), kind: d.kind ?? null, executor: d.executor ?? null, lane: d.lane ?? null, stage: d.stage ?? null,
      model: end.model ?? d.model ?? null, effort: end.effort ?? d.effort ?? null, state: r.state, outcome: end.outcome ?? null,
      started: r.created, age_min: Math.round((now - Date.parse(r.created)) / 60000), budget_min: d.budget_min ?? null,
      ctx: null, ctx_peak: null, ctx_limit: null, ctx_hard: null, cacheR: null, burn30: null, tokens: null, tokens_src: null, children: [] };
    const exe = d.executor || '';
    if (exe.startsWith('codex')) {
      const b = d.log ? parseCodexLog(readText(d.log)) : {};
      node.model = b.model ?? node.model; node.effort = b.effort ?? node.effort;
      const rollout = findRollout(o.codexDir, end.codex_session ?? b.session_id);
      const ci = rollout ? codexInfo(rollout, cache) : null;
      if (ci && ci.total !== null) { node.tokens = ci.total; node.tokens_src = 'live'; node.ctx = ci.last; }
      else if (Number.isInteger(end.tokens ?? b.tokens)) { node.tokens = end.tokens ?? b.tokens; node.tokens_src = 'end'; }
    } else if (d.kind === 'cli') {   // a cli executor's plain output carries no usage
      node.tokens = '-';
    } else {   // a check-in too: its end usage SUMS its requests (RUN-869: "1176k" for a 64k session) - the transcript has the truth
      const file = end.transcript || d.transcript || findTranscript(o.projectsDir, d.session_id);
      const t = file ? transcriptInfo(file, cache, { now }) : null;
      if (t) {
        Object.assign(node, { ctx: t.ctx, ctx_peak: t.peak, cacheR: t.cacheR, burn30: t.burn30, model: t.model ?? node.model, effort: t.effort ?? node.effort });
        node.children = subagents(file, cache, { now });
      }
      // a claude-compatible provider bills its own account: no Claude-plan burn; tokens from the CLI final json (META-EXEC-S1)
      if (d.kind === 'provider') {
        node.burn30 = null; node.billing = exe; node.children = node.children.map(c => ({ ...c, burn30: null }));
        const u = end.usage;
        if (u) { node.tokens = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((a, k) => a + (Number(u[k]) || 0), 0); node.tokens_src = 'end'; }
      }
    }
    if (d.kind !== 'interactive' && d.kind !== 'cli') { const v = ctxView(d, o.policy); node.ctx_limit = v.ctx_limit; node.ctx_hard = v.ctx_hard; }
    if (d.role === 'helper') Object.assign(node, { kind: 'helper', parent: d.parent ?? null, q: d.q ?? null, class: d.class ?? null });
    if (node.tokens === null && end.usage) { node.tokens = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((a, k) => a + (Number(end.usage[k]) || 0), 0); node.tokens_src = 'end'; }
    roots.push(node);
  }
  // helpers (norn delegate) nest under their parent run; the parent carries its helper usage { n, running, tokens }
  const byId = new Map(roots.map(n => [n.id, n]));
  for (const n of [...roots]) {
    const p = n.kind === 'helper' && byId.get(n.parent);
    if (!p || p === n) continue;
    roots.splice(roots.indexOf(n), 1);
    p.children.push(n);
    const h = p.helpers ??= { n: 0, running: 0, tokens: 0 };
    h.n++; if (n.state === 'running') h.running++; if (Number.isFinite(n.tokens)) h.tokens += n.tokens;
  }
  for (const s of o.sessions || []) roots.push({ id: `talk:${s.name}`, kind: 'talk', executor: 'claude', lane: null, model: s.model ?? null,
    effort: s.effort ?? null, state: s.alive ? 'alive' : 'stopped', started: s.created ?? null, ctx: s.context ?? null, children: [] });
  return roots;
}
