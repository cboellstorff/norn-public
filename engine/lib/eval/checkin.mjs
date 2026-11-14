// norn eval checkin (META-GT3; Gas Town REPORT sec. 3 item 3): FROZEN-CONTEXT replay of recorded check-ins.
// From a check-in transcript take the prompt + every READ result the real check-in saw (its own thinking / text and its action
// calls dropped), give it to a candidate executor as ONE context with no tools, ask for its actions in a fixed JSON form, and
// score that against the actions the real check-in recorded (records + run events with run = its id). Executor-agnostic: the
// candidate runs through its harness adapter (engine/lib/harness), so Codex / providers are evaluated the same way.
// Never touches live state: the caller hands in event arrays read from a COPY of the state dir.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { adapterFor, harnessOf } from '../harness/index.mjs';
import { busyRefusal, ownerOnlyRefusal, GUARD_WORDS } from '../checkinguards.mjs';
import { parseAfter, AfterError } from '../after.mjs';
import { duplicateIn } from '../runs.mjs';

const READ_TOOLS = new Set(['Bash', 'PowerShell', 'Read', 'Grep', 'Glob']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
// meta write verbs (records + runs), a ledger append, a file write from the shell
const ACTION_RES = [
  [/\b(?:norn|meta)(\.mjs)?["']?\s+run\s/, 'norn run'], [/\b(?:norn|meta)(\.mjs)?["']?\s+stop\s/, 'norn stop'], [/\b(?:norn|meta)(\.mjs)?["']?\s+requeue\s/, 'norn requeue'], [/\bruns\s+landed\s/, 'runs landed'],
  [/\brec\s+(add|apply|supersede|withdraw|answer|reopen|overrule|done|revoke|park|unpark|archive|unarchive)\b/, 'rec write'],
  [/\bruns\s+review\s/, 'runs review'], [/\broad\s+(add|edit|move|link|unlink|drop|reopen|apply)\b/, 'road write'], [/>>\s*\S*progress\.md|Add-Content\b[^|;]*progress\.md/i, 'ledger append'],
  [/\b(Set-Content|Out-File|New-Item)\b|(^|[^>&0-9])>\s*["']?[A-Za-z]:?[\\/]\S*\.(md|json|txt)/, 'file write'],
];

/** The why of an action call (string), or null when the call only reads. */
export function isActionCall(name, input = {}) {
  if (WRITE_TOOLS.has(name)) return 'file write';
  const c = String(input.command ?? '');
  for (const [re, why] of ACTION_RES) if (re.test(c)) return why;
  return null;
}

const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x?.type === 'text' ? x.text : x?.type === 'image' ? '[image]' : '').join('\n') : '';
const cut = (s, n) => s.length <= n ? s : s.slice(0, n) + `\n[cut ${s.length - n} chars]`;

/**
 * transcript text -> { prompt, steps [{ tool, input, result }], dropped [{ tool, why: 'action' | 'harness tool', what }], truncated, text }.
 * maxResult cuts each result; maxTotal stops adding steps once the context would pass it (chars).
 */
export function frozenContext(transcriptText, { maxResult = 12000, maxTotal = 360000 } = {}) {
  const lines = String(transcriptText).split(/\r?\n/).filter(Boolean);
  let prompt = null; const calls = new Map(), order = [], dropped = [];
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    const m = j.message;
    if (j.type === 'user' && m && prompt === null && (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.some(b => b?.type === 'text')))) {
      prompt = textOf(m.content); continue;
    }
    if (j.type === 'assistant' && Array.isArray(m?.content))
      for (const b of m.content) if (b?.type === 'tool_use') { calls.set(b.id, { tool: b.name, input: b.input || {} }); order.push(b.id); }
    if (j.type === 'user' && Array.isArray(m?.content))
      for (const b of m.content) if (b?.type === 'tool_result' && calls.has(b.tool_use_id)) calls.get(b.tool_use_id).result = textOf(b.content);
  }
  const steps = []; let total = (prompt || '').length, truncated = false;
  for (const id of order) {
    const c = calls.get(id);
    const act = isActionCall(c.tool, c.input);
    if (act) { dropped.push({ tool: c.tool, why: 'action', what: act }); continue; }
    if (!READ_TOOLS.has(c.tool)) { dropped.push({ tool: c.tool, why: 'harness tool' }); continue; }
    const s = { tool: c.tool, input: c.input, result: cut(c.result ?? '(no result)', maxResult) };
    const size = s.result.length + JSON.stringify(s.input).length + 40;
    if (total + size > maxTotal) { truncated = true; break; }
    total += size; steps.push(s);
  }
  const text = [`## Prompt\n${prompt ?? '(none)'}`, ...steps.map((s, i) => `## Step ${i + 1}: ${s.tool} ${JSON.stringify(s.input)}\n${s.result}`)].join('\n\n');
  return { prompt, steps, dropped, truncated, text };
}

/** The budget JSON the check-in read (the tool result holding "max_codex"), or null. */
export function findBudget(frozen) {
  for (const s of frozen.steps || []) {
    const r = s.result || '', k = r.indexOf('"max_codex"');
    if (k < 0) continue;
    for (let a = r.lastIndexOf('{', k); a >= 0; a = a > 0 ? r.lastIndexOf('{', a - 1) : -1) {   // lastIndexOf(x, -1) searches from 0: stop at 0
      let depth = 0;
      for (let i = a; i < r.length; i++) {
        if (r[i] === '{') depth++; else if (r[i] === '}' && --depth === 0) {
          try { const j = JSON.parse(r.slice(a, i + 1)); if ('max_codex' in j) return j; } catch { /* not this brace */ }
          break;
        }
      }
    }
  }
  return null;
}

const NON_WORKER = new Set(['checkin', 'delegate']);
const REC_OPS = ['apply', 'supersede', 'withdraw', 'park', 'unpark', 'done', 'revoke', 'reopen'];
/** The real check-in's actions: { actions, reviewed } from records + run events with run = runId. */
export function baselineActions(recEvs, runEvs, runId) {
  const actions = [], reviewed = [];
  for (const e of runEvs) {
    if (e.run !== runId) continue;
    if (e.ev === 'start') {
      const d = e.data || {};
      if (NON_WORKER.has(d.kind)) continue;   // the next check-in (scheduler) / a read-only helper ask (exploration) are not rulings
      actions.push({ type: 'dispatch', lane: d.lane, stage: d.stage ?? null, executor: d.executor ?? d.kind, effort: d.effort ?? null, worktree: d.worktree ?? null, id: e.id });
    } else if (e.ev === 'kill') actions.push({ type: 'kill', run: e.id });
    else if (e.ev === 'review') reviewed.push(e.id);
  }
  for (const e of recEvs) {
    if (e.run !== runId) continue;
    const d = e.data || {};
    // META-ROADMAP S3: a roadmap write that places a directive (create / link with dir:DIR-n) = the same-tick duty done; other
    // roadmap edits are structure, not rulings
    if (e.kind === 'item') { if (e.ev === 'create' || e.ev === 'link') for (const l of d.links || []) if (l.startsWith('dir:')) actions.push({ type: 'record', op: 'road', id: l.slice(4) }); continue; }
    if (e.kind === 'decision' && e.ev === 'create') actions.push({ type: 'decision', lane: d.lane, question: d.question, choice: d.choice, id: e.id });
    else if (e.kind === 'question' && e.ev === 'create') actions.push({ type: 'question', lane: d.lane, title: d.title, class: d.class ?? null, owner_only: d.owner_only === true, id: e.id });
    else if (e.kind === 'directive' && e.ev === 'create') actions.push({ type: 'record', op: 'directive', id: e.id });
    else if (REC_OPS.includes(e.ev)) actions.push({ type: 'record', op: e.ev, id: e.id });
  }
  return { actions, reviewed };
}

const TYPES = ['dispatch', 'decision', 'question', 'kill', 'record', 'nothing'];
/** Candidate answer text -> { actions (no "nothing"), nothing (why | null), reviewed, error }. */
export function parseActions(text) {
  const s = String(text ?? '');
  const fenced = [...s.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  const bare = s.indexOf('{') >= 0 ? [s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)] : [];
  for (const c of [...fenced.reverse(), ...bare]) {
    let j; try { j = JSON.parse(c); } catch { continue; }
    if (!j || !Array.isArray(j.actions)) continue;
    const bad = j.actions.find(a => !TYPES.includes(a?.type));
    if (bad) return { actions: [], nothing: null, reviewed: [], error: `unknown action type ${JSON.stringify(bad?.type)}` };
    const nothing = j.actions.find(a => a.type === 'nothing');
    return { actions: j.actions.filter(a => a.type !== 'nothing'), nothing: nothing ? String(nothing.why ?? '') : null, reviewed: j.reviewed || [], error: null };
  }
  return { actions: [], nothing: null, reviewed: [], error: 'no JSON {"actions": [...]} in the answer' };
}

const normWt = w => String(w || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const famOf = x => { const e = String(x || ''); return e === 'claude' ? 'claude' : e === 'codex-sol' ? 'sol' : e === 'codex-astra' ? 'astra' : e.startsWith('codex') ? 'codex' : null; };

/** Live writers + caps at the tick start: { liveLanes, liveWorktrees, alive {claude, codex, sol, astra}, caps, paused, rateOk }. */
// what the check-in saw (CHECKIN-GATE seenBy): starts up to its start (an end in that same second woke it), ends up to its own end
export function tickContext(runEvs, { at, until = at, budget = {}, text = '', recEvs = [] } = {}) {
  const t = Date.parse(at), u = Date.parse(until), live = new Map(), queued = new Map();
  for (const e of runEvs) {
    if (e.kind !== 'run') continue;
    const x = Date.parse(e.ts);
    if (e.ev === 'start' && x <= t && !NON_WORKER.has(e.data?.kind)) live.set(e.id, e.data || {});
    else if (['end', 'kill', 'lost'].includes(e.ev) && x <= u) live.delete(e.id);
    else if (e.ev === 'queue' && x < t) queued.set(e.id, e.data || {});
    else if (['fill', 'withdraw'].includes(e.ev) && x < t) queued.delete(e.id);
    else if (e.ev === 'rewire' && queued.has(e.id) && Array.isArray(e.data?.after)) queued.set(e.id, { ...queued.get(e.id), after: e.data.after });
  }
  const alive = { claude: 0, codex: 0, sol: 0, astra: 0 };
  for (const d of live.values()) { const f = famOf(d.executor); if (f === 'claude') alive.claude++; else if (f) { alive.codex++; if (f !== 'codex') alive[f]++; } }
  const cap = k => (Number.isFinite(budget[k]) ? budget[k] : Infinity);
  const r = /RATE_OK=([01])/.exec(text);
  return { liveLanes: [...new Set([...live.values()].map(d => d.lane))], liveWorktrees: [...new Set([...live.values()].map(d => normWt(d.worktree)).filter(Boolean))],
    alive, caps: { claude: cap('max_claude_workers'), codex: cap('max_codex'), sol: cap('max_sol'), astra: cap('max_astra') },
    paused: Object.entries(budget.lanes || {}).filter(([, v]) => v?.executor === 'paused').map(([k]) => k), rateOk: r ? r[1] === '1' : null,
    unplacedDirs: unplacedDirs(recEvs, t), held: heldAt(recEvs, t),
    // META-CHECKIN-GUARDS R1: what the guards read - the running + queued runs (guard A) and the open questions (guard B) at the start
    runs: [...[...live].map(([id, data]) => ({ id, state: 'running', data })), ...[...queued].map(([id, data]) => ({ id, state: 'queued', data }))],
    questions: openQuestionsAt(recEvs, t) };
}

// the open questions at the tick start ({ id, state: 'open', data }): created before it, not yet answered / superseded / withdrawn
function openQuestionsAt(recEvs, t) {
  const qs = new Map();
  for (const e of [...recEvs].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    if (e.kind !== 'question' || Date.parse(e.ts) >= t) continue;
    if (e.ev === 'create') qs.set(e.id, { id: e.id, state: 'open', data: e.data || {} }); else if (e.ev !== 'reopen') qs.delete(e.id);
  }
  return [...qs.values()];
}
// META-CONTROLLER C4 (SPEC sec. 2): the lanes the controller held at the tick start (the last claim / release before it, until not
// passed) - the check-in skips them; a candidate write there is a rule breach (the live code refuses it: exit 5)
function heldAt(recEvs, t) {
  const last = new Map();
  for (const e of [...recEvs].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) if (e.kind === 'lane' && (e.ev === 'claim' || e.ev === 'release') && Date.parse(e.ts) <= t) last.set(e.id, e);
  return [...last.values()].filter(e => e.ev === 'claim' && Date.parse(e.data?.until) > t).map(e => String(e.id).slice(2)).sort();
}

// META-ROADMAP S3 (SPEC sec. 3 check-in duty 1): the directives active at the tick start that no roadmap item links yet - each must
// land on the roadmap THIS tick. A project with no roadmap (no item before the tick) has no duty yet.
function unplacedDirs(recEvs, t) {
  const before = recEvs.filter(e => Date.parse(e.ts) < t);
  if (!before.some(e => e.kind === 'item')) return [];
  const dirs = new Map(), placed = new Set();
  for (const e of before) {
    if (e.kind === 'directive') { if (e.ev === 'create') dirs.set(e.id, true); else if (['done', 'revoke', 'supersede'].includes(e.ev)) dirs.delete(e.id); }
    if (e.kind === 'item' && (e.ev === 'create' || e.ev === 'link')) for (const l of e.data?.links || []) if (l.startsWith('dir:')) placed.add(l.slice(4));
  }
  return [...dirs.keys()].filter(id => !placed.has(id));
}

export const baseKey = a => a.type === 'dispatch' || a.type === 'decision' || a.type === 'question' ? `${a.type}:${a.lane}` : a.type === 'kill' ? `kill:${a.run}` : `record:${a.op}:${a.id}`;
export function keyed(list) {
  const n = {}, out = new Map();
  for (const a of list) { const b = baseKey(a); n[b] = (n[b] || 0) + 1; out.set(n[b] > 1 ? `${b}#${n[b]}` : b, a); }
  return out;
}
// META-CHECKIN-GUARDS R1: refused = a move a guard refuses in code (nothing happened; the next tick sees the refusal) - recoverable
export const RANK = { none: 0, harmless: 1, refused: 2, recoverable: 3, harmful: 4 };
const afterOfCand = a => { try { return (Array.isArray(a) ? a : [a]).filter(Boolean).flatMap(x => (typeof x === 'string' ? parseAfter(x) : [x])); } catch (e) { if (e instanceof AfterError) return []; throw e; } };

/** Per-tick score: { agree, matched, items [{ key, side, class, why }], choiceReview, worst }. */
export function scoreTick(base, cand, ctx = {}) {
  const B = keyed(base), C = keyed(cand), items = [], choiceReview = [];
  const alive = { claude: 0, codex: 0, sol: 0, astra: 0, ...(ctx.alive || {}) }, caps = ctx.caps || {};
  const breach = a => {   // a candidate dispatch against the hard gates, counted with the dispatches before it in this tick
    const f = famOf(a.executor);
    if ((ctx.paused || []).includes(a.lane)) return 'rule breach: paused lane dispatched';
    if (f === 'claude' && ctx.rateOk === false) return 'rule breach: Claude dispatch at RATE_OK=0';
    if (f === 'claude') alive.claude++; else if (f) { alive.codex++; if (f !== 'codex') alive[f]++; }
    for (const k of f === 'claude' ? ['claude'] : f ? ['codex', ...(f !== 'codex' ? [f] : [])] : [])
      if (alive[k] > (caps[k] ?? Infinity)) return `dispatch past the cap (${k} ${alive[k]} > ${caps[k]})`;
    return null;
  };
  const heldOf = a => { const ln = a.lane ?? (String(a.id ?? '').startsWith('L:') ? String(a.id).slice(2) : null); return ln && (ctx.held || []).includes(ln) ? ln : null; };
  let matched = 0;
  for (const [k, c] of C) {
    const b = B.get(k);
    const hl = heldOf(c);
    if (hl) { items.push({ key: k, side: b ? 'mismatch' : 'extra', class: 'harmful', why: `rule breach: held lane ${hl} written (the controller holds it; a check-in skips it - exit 5)` }); continue; }
    // the guards (checkinguards.mjs, the engine's own functions): a move they refuse never happened
    const guard = c.type === 'dispatch' ? busyRefusal({ lane: c.lane, worktree: c.worktree, stage: c.stage, after: afterOfCand(c.after) }, ctx.runs || [])
      : c.type === 'decision' && !b ? [...(ctx.questions || []), ...base.filter(x => x.type === 'question').map(x => ({ id: x.id ?? 'Q-?', state: 'open', data: x }))]
        .filter(q => q.data?.lane === c.lane).map(q => ownerOnlyRefusal(q, 'checkin')).find(Boolean) ?? null : null;
    if (guard) { const g = c.type === 'dispatch' ? 'busy' : 'owner-only'; items.push({ key: k, side: b ? 'mismatch' : 'extra', class: 'refused', guard: g, why: `refused by a guard (${GUARD_WORDS[g]}): ${guard}` }); continue; }
    if (c.type === 'dispatch') {
      const h = breach(c);
      if (h) { items.push({ key: k, side: b ? 'mismatch' : 'extra', class: 'harmful', why: h }); continue; }
    }
    if (!b) {
      items.push({ key: k, side: 'extra', class: c.type === 'record' ? 'harmless' : 'recoverable',
        why: { dispatch: 'an extra run (cost; next tick sees it)', decision: 'an extra ruling', question: 'an extra owner ask (parks the lane)', kill: 'a run killed the baseline kept (re-dispatch)', record: 'record bookkeeping' }[c.type] });
      continue;
    }
    if (c.type === 'dispatch' && famOf(c.executor) !== famOf(b.executor)) { items.push({ key: k, side: 'mismatch', class: 'recoverable', why: `executor ${c.executor} vs ${b.executor}` }); continue; }
    if (c.type === 'dispatch' && ((c.effort && b.effort && c.effort !== b.effort) || (c.stage && b.stage && c.stage !== b.stage))) {
      items.push({ key: k, side: 'mismatch', class: 'harmless', why: `stage / effort ${c.stage ?? '-'}/${c.effort ?? '-'} vs ${b.stage ?? '-'}/${b.effort ?? '-'}` }); continue;
    }
    if (c.type === 'decision' && String(c.choice ?? '') !== String(b.choice ?? '')) choiceReview.push({ key: k, base: b.choice ?? null, cand: c.choice ?? null });
    matched++;
  }
  const duty = ctx.unplacedDirs || [];
  for (const id of duty) if (!cand.some(a => a.type === 'record' && a.op === 'road' && a.id === id))
    items.push({ key: 'road:' + id, side: 'duty', class: 'recoverable', why: 'a new directive not placed on the roadmap the same tick (it shows under Unplaced)' });
  for (const [k, b] of B) if (!C.has(k) && !(b.op === 'road' && duty.includes(b.id)))
    items.push({ key: k, side: 'missing', class: b.type === 'record' ? 'harmless' : 'recoverable',
      why: { dispatch: 'lane idles until the next tick', decision: 'a stop waits a tick', question: 'an owner ask not raised (ruled or skipped)', kill: 'a stuck run kept a tick longer', record: 'record bookkeeping' }[b.type] });
  const worst = items.reduce((w, i) => (RANK[i.class] > RANK[w] ? i.class : w), 'none');
  return { agree: items.length === 0, matched, items, choiceReview, worst };
}

/**
 * Check-ins inside [sinceMs, untilMs) that have an end event with a transcript -> [{ id, ts, transcript, acted, stratum, actions, cacheR }].
 * Acted ticks: round-robin over strata (the first action type in dispatch > question > decision > kill > record order) up to maxActed;
 * idle ticks (no action): evenly spaced, `idle` of them.
 */
export function sampleTicks(runEvs, recEvs, { sinceMs = 0, untilMs = Infinity, maxActed = 30, idle = 12 } = {}) {
  const starts = runEvs.filter(e => e.kind === 'run' && e.ev === 'start' && e.data?.kind === 'checkin' && Date.parse(e.ts) >= sinceMs && Date.parse(e.ts) < untilMs);
  const ends = new Map(runEvs.filter(e => e.ev === 'end').map(e => [e.id, e]));
  const ticks = [];
  for (const s of starts) {
    const end = ends.get(s.id);
    if (!end?.data?.transcript) continue;
    const { actions } = baselineActions(recEvs, runEvs, s.id);
    const types = new Set(actions.map(a => a.type));
    const stratum = ['dispatch', 'question', 'decision', 'kill', 'record'].find(t => types.has(t)) || 'idle';
    ticks.push({ id: s.id, ts: s.ts, end: end.ts, transcript: end.data.transcript, acted: actions.length > 0, stratum, actions, cacheR: end.data.usage?.cache_read_input_tokens ?? null });
  }
  const strata = {};
  for (const t of ticks.filter(t => t.acted)) (strata[t.stratum] ||= []).push(t);
  const acted = [], qs = Object.values(strata);
  for (let i = 0; acted.length < maxActed && qs.some(q => q.length > i); i++) for (const q of qs) if (q[i] && acted.length < maxActed) acted.push(q[i]);
  const idles = ticks.filter(t => !t.acted), step = idles.length / Math.max(1, idle);
  const pick = idle >= idles.length ? idles : Array.from({ length: idle }, (_, i) => idles[Math.floor(i * step)]);
  return [...acted, ...pick].sort((a, b) => a.ts.localeCompare(b.ts));
}

export const ANSWER_FORM = `{"actions": [
  {"type": "dispatch", "lane": "<lane>", "stage": "<STAGE>", "executor": "claude|codex-sol|codex-astra|grok", "effort": "low|medium|high|xhigh", "worktree": "<path>", "after": "run:RUN-n:ended (optional: --after, chains it behind a run)"},
  {"type": "decision", "lane": "<lane>", "question": "<what was ruled>", "choice": "<the ruling>"},
  {"type": "question", "lane": "<lane>", "title": "<owner question>", "class": "i|ii|iii|iv|v"},
  {"type": "kill", "run": "RUN-n", "why": "<why>"},
  {"type": "record", "op": "apply|supersede|withdraw|park|unpark|done|revoke|directive|road (= norn road add --from / link: a directive placed on the roadmap)", "id": "Q-n|DIR-n|L:lane"},
  {"type": "nothing", "why": "<why no action>"}
], "reviewed": ["RUN-n"]}`;

/** The one-shot candidate prompt: the frozen context + the fixed answer form. */
export function evalPrompt(frozen) {
  return [
    'You are replaying ONE recorded check-in turn of a multi-agent controller. Below is the check-in prompt and every read',
    'result the check-in saw (STATUS, budget, ledger, rules, run NOTES ...). You have NO tools: do not ask to read more and do',
    'not run anything. Decide what this check-in should DO, exactly as its prompt and rules say, from this context only.',
    '',
    '# FROZEN CONTEXT',
    frozen.text,
    '',
    '# YOUR ANSWER',
    'Answer with ONE JSON object in a ```json fence and nothing after it, in this form (list every action you would take; a',
    'tick with no action has the single {"type": "nothing"} entry; "reviewed" = the unreviewed runs you would mark reviewed):',
    ANSWER_FORM,
  ].join('\n');
}

/** Spawn cmd with stdin = input; resolves { code, stdout, stderr }. */
export function spawnCmd(cmd, input, { cwd, env = process.env, timeoutMs = 900000 } = {}) {
  return new Promise(resolve => {
    const p = nodeSpawn(cmd.exe, cmd.args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(t); resolve({ code: -1, stdout: out, stderr: String(e) }); });
    p.on('close', code => { clearTimeout(t); resolve({ code, stdout: out, stderr: err }); });
    p.stdin.end(input);
  });
}

/**
 * One candidate replay: the executor's adapter builds a no-tools (else read-only) command, the prompt goes on stdin.
 * -> { actions, nothing, reviewed, error, usage, cost_usd, model, out } ; writes <dir>/<tag>.<model>-<effort>.out.json.
 */
export async function replayTick({ executor, entry, model, effort, prompt, dir, tag, exe, spawn = spawnCmd, env }) {
  const family = harnessOf(executor, entry);
  if (!family) throw new Error(`unknown executor ${executor}`);
  const a = adapterFor(family), mode = a.caps.modes.includes('no-tools') ? 'no-tools' : 'read-only';
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${tag}.${model}-${effort}`), ctxFile = base + '.prompt.md', final = base + '.final.md';
  fs.writeFileSync(ctxFile, prompt);
  const cmd = a.command({ exe, mode, model, effort, brief: ctxFile, final, worktree: dir, addDirs: [], session_id: crypto.randomUUID(), remote: false,
    promptText: 'The replay context and the answer form are on stdin. Answer with the JSON object only.', lane: 'eval', project: 'eval' });
  const r = await spawn(cmd, prompt, { cwd: dir, env });
  const raw = cmd.stdout === 'final' ? r.stdout : (fs.existsSync(final) ? fs.readFileSync(final, 'utf8') : '');
  let answer = raw;
  if (cmd.parse === 'claude') { try { answer = JSON.parse(r.stdout).result ?? ''; } catch { answer = ''; } }
  const parsed = a.parse(cmd.stdout === 'final' ? r.stdout : r.stdout + '\n' + (r.stderr || ''));
  const res = { ...parseActions(answer), usage: parsed.usage, cost_usd: parsed.cost_usd, model: parsed.model || model, code: r.code, answer };
  if (r.code !== 0 && !res.error) res.error = `exit ${r.code}: ${String(r.stderr || '').slice(-300)}`;
  fs.writeFileSync(base + '.out.json', JSON.stringify(res, null, 1));
  return res;
}

/**
 * META-CHECKIN-GUARDS R1: every RECORDED check-in move of a state through the guards, as the engine's door met it - a dispatch (a
 * queue, or a start that is not a fill) of a check-in run against the running + queued runs just before it (guard A), a ruling
 * (decision --answers Q-n by a check-in) against that Q just before it (guard B). The recorded rulings must pass: a refusal here =
 * the guard is wrong. dup = a dispatch the door's duplicate check (runs.duplicateIn: lane + stage + round already queued / running,
 * exit 3; it came on 11-12) refuses BEFORE guard A - the door order is held 5, duplicate 3, busy 6 - so it is counted apart. -> { dispatches, busy: [...], dup: [...], rulings, owner_only: [...] }
 */
export function guardHistory(runEvs, recEvs) {
  const evs = runEvs.filter(e => e.kind === 'run').sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)), kindOf = new Map();
  for (const e of evs) if (e.ev === 'start') kindOf.set(e.id, e.data?.kind);
  const items = new Map(), out = { dispatches: 0, busy: [], dup: [], rulings: 0, owner_only: [] };
  for (const e of evs) {
    const d = e.data || {};
    if ((e.ev === 'queue' || (e.ev === 'start' && !d.from_queue)) && kindOf.get(e.run) === 'checkin' && !NON_WORKER.has(d.kind)) {
      out.dispatches++;
      const runs = [...items.values()].filter(r => r.id !== e.id);
      const dup = duplicateIn(runs, { ...d, parent: d.parent, resumeOf: d.resume_of, requeueOf: d.requeue_of });
      const why = busyRefusal({ lane: d.lane, worktree: d.worktree, stage: d.stage, after: d.after }, runs);
      if (dup) out.dup.push({ id: e.id, by: e.run, lane: d.lane, stage: d.stage, of: dup.id, busy: why });
      else if (why) out.busy.push({ id: e.id, by: e.run, lane: d.lane, stage: d.stage, why });
    }
    if (e.ev === 'start' && !NON_WORKER.has(d.kind)) items.set(e.id, { id: e.id, state: 'running', data: d });
    else if (e.ev === 'queue') items.set(e.id, { id: e.id, state: 'queued', data: d });
    else if (['end', 'kill', 'lost', 'fill', 'withdraw'].includes(e.ev)) items.delete(e.id);
    else if (e.ev === 'rewire' && items.has(e.id) && Array.isArray(d.after)) items.get(e.id).data = { ...items.get(e.id).data, after: d.after };
  }
  const qs = new Map(), QSTATE = { answer: 'answered', apply: 'applied', supersede: 'superseded', withdraw: 'withdrawn', reopen: 'open' };
  for (const e of [...recEvs].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    if (e.kind === 'question') {
      if (e.ev === 'create') qs.set(e.id, { id: e.id, state: 'open', data: e.data || {} });
      else if (qs.has(e.id) && QSTATE[e.ev]) qs.get(e.id).state = QSTATE[e.ev];
    }
    if (e.kind === 'decision' && e.ev === 'create' && e.by === 'checkin' && e.data?.answers) {
      out.rulings++;
      const why = ownerOnlyRefusal(qs.get(e.data.answers), e.by);
      if (why) out.owner_only.push({ id: e.id, run: e.run, answers: e.data.answers, why });
    }
  }
  return out;
}

/** Per-arm rows: { arm, ticks, agree, harmless, refused, recoverable, harmful, errors, cost_usd }. */
export function summarize(results) {
  const rows = new Map();
  for (const r of results) {
    const row = rows.get(r.arm) || { arm: r.arm, ticks: 0, agree: 0, harmless: 0, refused: 0, recoverable: 0, harmful: 0, errors: 0, cost_usd: 0 };
    row.ticks++;
    if (r.error) row.errors++;
    else if (r.score.agree) row.agree++;
    else row[r.score.worst]++;
    row.cost_usd += r.cost_usd || 0;
    rows.set(r.arm, row);
  }
  return [...rows.values()];
}
