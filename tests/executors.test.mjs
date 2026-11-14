// META-EXEC-S1: configurable Claude-compatible executors (data in project.json) + allowed work classes per executor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkProject, ConfigError } from '../engine/lib/config.mjs';
import { providersOf, providerEnv, capsOfRun, PROVIDER_CLASSES } from '../engine/lib/executors.mjs';
import { buildCommand, startRun, RunRefused, RunError } from '../engine/lib/runs.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { POLICY_DEFAULTS, applySettings, settingsView, settingsFor, split, generatedLines, allowedClasses, WORK_CLASSES } from '../engine/lib/policy.mjs';
import { cacheRSince } from '../engine/lib/usage.mjs';
import { agentsTree } from '../engine/lib/agents.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// monotonic deadline: a wall-clock step (the WSL runner's ~16 s) never expires it early
async function waitFor(fn, ms = 20000) { const t0 = performance.now(); for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); } }

const GLM = { type: 'claude-compatible', base_url: 'https://api.z.ai/api/anthropic', api_key_env: 'META_TEST_GLM_KEY', model: 'glm-5.3', small_model: 'glm-5.3-flash', effort: 'medium' };
const proj = (executors, extra = {}) => ({ schema: 1, name: 'demo', title: 'Demo', root: '/r', executors, ...extra });
const SECRET = 'meta-test-SECRET-4242';

function sandbox() {
  const t = mkTmp('meta-exec-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), wt: path.join(t, 'wt'), wt2: path.join(t, 'wt2'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks', 'wt', 'wt2']) fs.mkdirSync(d[k], { recursive: true });
  d.brief = (body, name = 'brief.md') => { const f = path.join(t, name); fs.writeFileSync(f, body); return f; };
  d.item = id => loadState(d.state).items[id];
  // ended AND its supervisor gone: its end-of-run tail (queue fill under queue.lock, lock release) is done (FINDING L1)
  d.ended = id => waitFor(() => { const it = d.item(id); return settled(it) && it; });
  return d;
}

// ---------- 1. config parse ----------
test('config: a claude-compatible entry is data; missing fields, builtin names and literal keys are refused', () => {
  assert.doesNotThrow(() => checkProject(proj({ glm: GLM, claude: { agent: 'kestrel-implementer' } })));
  assert.deepEqual(Object.keys(providersOf(proj({ glm: GLM, kimi: { ...GLM, api_key_env: 'MOONSHOT_API_KEY' }, grok: { enabled: true } }))), ['glm', 'kimi']);
  for (const k of ['base_url', 'api_key_env', 'model']) { const e = { ...GLM }; delete e[k]; assert.throws(() => checkProject(proj({ glm: e })), new RegExp(k)); }
  assert.throws(() => checkProject(proj({ glm: { ...GLM, api_key_env: 'lower-case-key' } })), /api_key_env/);
  assert.throws(() => checkProject(proj({ claude: GLM })), ConfigError);   // a built-in name
  assert.throws(() => checkProject(proj({ glm: { ...GLM, env: { ANTHROPIC_AUTH_TOKEN: 'x' } } })), /api_key_env/);
  assert.throws(() => checkProject(proj({ glm: { ...GLM, api_key: 'x' } })), /api_key/);
});

// ---------- 4. command + env ----------
test('command: a provider runs the claude CLI path with its own model, no remote control; env carries base url / token / models', () => {
  const base = { brief: '/b/brief.md', worktree: '/w', notes: '/n/NOTES.md', lane: 'gen', project: 'kestrel', final: '/s/f.json', resumes: 0, session_id: 'sid' };
  const c = buildCommand({ ...base, executor: 'glm', provider: GLM, exe: '/x/claude', agent: 'kestrel-implementer', model: 'glm-5.3', effort: 'medium' });
  const at = f => c.args[c.args.indexOf(f) + 1];
  assert.equal(c.exe, '/x/claude'); assert.equal(c.parse, 'claude'); assert.equal(at('--model'), 'glm-5.3'); assert.equal(at('--session-id'), 'sid');
  assert.ok(!c.args.includes('--remote-control'));
  const e = providerEnv(GLM, { META_TEST_GLM_KEY: SECRET, ANTHROPIC_API_KEY: 'other' });
  assert.equal(e.missing, null);
  assert.equal(e.vars.ANTHROPIC_BASE_URL, GLM.base_url); assert.equal(e.vars.ANTHROPIC_AUTH_TOKEN, SECRET); assert.equal(e.vars.ANTHROPIC_API_KEY, null);
  assert.equal(e.vars.ANTHROPIC_MODEL, 'glm-5.3'); assert.equal(e.vars.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.3'); assert.equal(e.vars.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-5.3');
  assert.equal(e.vars.ANTHROPIC_SMALL_FAST_MODEL, 'glm-5.3-flash'); assert.equal(e.vars.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3-flash');
  assert.equal(providerEnv(GLM, {}).missing, 'META_TEST_GLM_KEY');
  // the built-in claude command is untouched (additive only)
  const cl = buildCommand({ ...base, executor: 'claude', exe: '/x/claude', model: 'claude-opus-5-5', effort: 'medium' });
  assert.ok(cl.args.includes('--remote-control'));
});

// ---------- 2. caps + 5. key never logged + 3. usage under the executor name ----------
test('provider run (fake runner): own cap max_<name>, never counted as a Claude worker, usage recorded, key never in any file', async () => {
  const d = sandbox();
  const prov = { ...GLM, runner: 'fake' };
  const opts = (o = {}) => ({ state: d.state, locksDir: d.locks, executor: 'glm', provider: prov, lane: 'p1', worktree: d.wt, notes: d.notes, hbMs: 150, staleMs: 3000,
    policy: { auto_resume_max: 0 }, budget: { max_claude_workers: 0, max_glm: 1 }, tick: null, model: 'glm-5.3', effort: 'medium', ...o });
  process.env.META_TEST_GLM_KEY = SECRET;
  try {
    assert.throws(() => startRun(opts({ brief: d.brief('mode: done\n', 'b0.md'), provider: { ...prov, api_key_env: 'META_TEST_UNSET_KEY_X' } })), e => e instanceof RunError && /META_TEST_UNSET_KEY_X is not set/.test(e.message));
    const r = startRun(opts({ brief: d.brief('mode: sleep\nms: 1500\n') }));
    const it0 = d.item(r.run);
    assert.equal(it0.data.kind, 'provider'); assert.equal(it0.data.executor, 'glm');
    assert.deepEqual(capsOfRun(it0.data), ['max_glm']);
    assert.throws(() => startRun(opts({ lane: 'p2', worktree: d.wt2, brief: d.brief('mode: done\n', 'b2.md') })), e => e instanceof RunRefused && e.code === 4 && /max_glm=1/.test(e.message));
    const it = await d.ended(r.run);
    assert.equal(it.end.outcome, 'done'); assert.equal(it.end.usage.cache_read_input_tokens, 20); assert.equal(it.end.cost_usd, 0);
    const log = fs.readFileSync(it.data.log, 'utf8');
    assert.match(log, /provider base_url=https:\/\/api\.z\.ai\/api\/anthropic model=glm-5\.3 token=set/);
    const all = [];
    const walk = p => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else all.push(f); } };
    walk(d.t);
    for (const f of all) assert.ok(!fs.readFileSync(f, 'utf8').includes(SECRET), `key leaked into ${f}`);
  } finally { delete process.env.META_TEST_GLM_KEY; }
});

test('norn run --executor <configured name> + disabled entry refused; doctor-style key status needs no key value', () => {
  const d = sandbox();
  const pf = path.join(d.t, 'project.json');
  fs.writeFileSync(pf, JSON.stringify(proj({ glm: { ...GLM, runner: 'fake' }, kimi: { ...GLM, api_key_env: 'META_TEST_KIMI', enabled: false } }, { root: d.t })));
  // a temp META_ROOT (as the e2e): the project's own state (<META_ROOT>/state/demo) is never the real tree's
  const metaRoot = path.join(d.t, 'meta');
  const env = { ...process.env, META_HB_MS: '150', META_NO_TICK: '1', META_TEST_GLM_KEY: SECRET, META_ROOT: metaRoot };
  const cli = (...a) => { const x = spawnSync(process.execPath, [META, ...a], { env, encoding: 'utf8' }); return { code: x.status, out: x.stdout + x.stderr }; };
  const common = ['--project', pf, '--state', d.state, '--locks', d.locks, '--notes', d.notes, '--budget', path.join(d.t, 'nobudget.json')];
  fs.writeFileSync(path.join(d.t, 'nobudget.json'), '{}');
  const a = cli('run', '--executor', 'glm', ...common, '--lane', 'one', '--worktree', d.wt, '--brief', d.brief('mode: done\n'));
  assert.equal(a.code, 0, a.out); assert.match(a.out, /STARTED RUN-\d+ lane one glm glm-5\.3 medium/);
  // --project + --state: --state wins (as `norn deliverables`; its resolve dispatches `norn run --project P --state S`)
  assert.ok(d.item(a.out.match(/STARTED (RUN-\d+)/)[1]), 'the run is recorded in --state');
  assert.equal(fs.existsSync(path.join(metaRoot, 'state', 'demo')), false, 'nothing in the project\'s own state');
  const k = cli('run', '--executor', 'kimi', ...common, '--lane', 'two', '--worktree', d.wt2, '--brief', d.brief('mode: done\n', 'b2.md'));
  assert.equal(k.code, 2); assert.match(k.out, /executor kimi is disabled/);
  const u = cli('run', '--executor', 'nope', ...common, '--lane', 'two', '--worktree', d.wt2, '--brief', d.brief('mode: done\n', 'b3.md'));
  assert.equal(u.code, 2); assert.match(u.out, /unknown executor "nope"/);
});

// ---------- allowed work classes (the rank) ----------
test('allowed classes: defaults (typed executors - grok, glm - chores/passfail, others all); refused pairing is a 400 naming the executor', () => {
  const ex = { providers: ['grok', 'glm'] };   // grok = a configured cli executor (DATA), glm = claude-compatible
  const hl = { policy: { executors: { chores: { executor: 'grok', model: '', effort: '' }, passfail: { executor: 'grok', model: '', effort: '' } } } };   // kestrel's routing
  assert.deepEqual(allowedClasses(POLICY_DEFAULTS, 'grok', ex.providers), PROVIDER_CLASSES);
  assert.deepEqual(allowedClasses(POLICY_DEFAULTS, 'glm', ex.providers), ['chores', 'passfail']);
  assert.deepEqual(allowedClasses(POLICY_DEFAULTS, 'codex-sol', ex.providers), Object.keys(WORK_CLASSES));
  assert.throws(() => applySettings({}, { 'policy.executors.review.executor': 'grok' }, ex), e => e.status === 400 && /grok is not allowed to do review work/.test(e.message));
  assert.throws(() => applySettings({}, { 'policy.executors.review.executor': 'glm' }, ex), e => e.status === 400 && /glm is not allowed/.test(e.message));
  assert.equal(applySettings({}, { 'policy.executors.chores.executor': 'glm' }, ex).policy.executors.chores.executor, 'glm');
  assert.throws(() => applySettings({}, { 'policy.executors.chores.executor': 'glm' }), e => e.status === 400);  // not configured -> unknown
  const w = applySettings({}, { 'policy.allowed_classes.glm': ['chores', 'passfail', 'review'], 'policy.executors.review.executor': 'glm' }, ex);
  assert.deepEqual(w.policy.allowed_classes.glm, ['chores', 'passfail', 'review']);
  assert.throws(() => applySettings(hl, { 'policy.allowed_classes.grok': ['chores'] }, ex), /grok is not allowed to do pass\/fail runs work/);
  assert.throws(() => applySettings({}, { 'policy.executors.chores.executor': 'grok' }, { providers: ['glm'] }), e => e.status === 400, 'grok unconfigured -> unknown');
  assert.throws(() => applySettings({}, { 'policy.allowed_classes.glm': ['bogus'] }, ex), e => e.status === 400);
  const v = settingsView({}, ex);
  assert.deepEqual(v.find(s => s.key === 'policy.executors.review.executor').options.filter(o => ['grok', 'glm', 'codex-sol'].includes(o)), ['codex-sol']);
  assert.ok(v.find(s => s.key === 'policy.executors.chores.executor').options.includes('glm'));
  assert.deepEqual(v.find(s => s.key === 'policy.allowed_classes.glm').value, ['chores', 'passfail']);
  assert.match(generatedLines({}, ex).executors, /Allowed classes: grok chores\+passfail; glm chores\+passfail; others all\./);
});

// ---------- usage: the Claude-plan burn never counts provider traffic ----------
test('burn: transcript records of a non-Claude model are not Claude cacheR; a provider node has no burn and its own billing', () => {
  const t = mkTmp('meta-exec-u-'), dir = path.join(t, 'proj');
  fs.mkdirSync(dir);
  const ts = new Date().toISOString();
  const line = (id, model, cr) => JSON.stringify({ timestamp: ts, requestId: 'r' + id, message: { id: 'm' + id, model, usage: { cache_read_input_tokens: cr } } });
  fs.writeFileSync(path.join(dir, 'a.jsonl'), [line(1, 'claude-opus-5-5', 100), line(2, 'glm-5.3', 5000), line(3, '<synthetic>', 0)].join('\n') + '\n');
  assert.equal(cacheRSince(t, 0).cr, 100);
  const run = { id: 'RUN-1', kind: 'run', state: 'exited', created: ts, updated: ts, data: { kind: 'provider', executor: 'glm', model: 'glm-5.3' },
    end: { outcome: 'done', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 }, cost_usd: 0.01 } };
  const [n] = agentsTree([run], { projectsDir: t });
  assert.equal(n.burn30, null); assert.equal(n.billing, 'glm'); assert.equal(n.tokens, 65); assert.equal(n.tokens_src, 'end');
});

// ---------- fit for `norn delegate` (addendum): parent run id + executors by work class from code ----------
test('delegate-ready: executorsFor(class) lists the allowed executors; a run records its parent run id', async () => {
  const { executorsFor } = await import('../engine/lib/policy.mjs');
  assert.deepEqual(executorsFor(POLICY_DEFAULTS, 'chores', ['grok', 'glm']).filter(e => ['grok', 'glm', 'codex-sol'].includes(e)), ['codex-sol', 'grok', 'glm']);
  assert.ok(!executorsFor(POLICY_DEFAULTS, 'chores', ['glm']).includes('grok'), 'grok is no built-in');
  assert.ok(!executorsFor(POLICY_DEFAULTS, 'review', ['glm']).includes('glm'));
  const d = sandbox();
  const r = startRun({ state: d.state, locksDir: d.locks, executor: 'fake', lane: 'kid', worktree: d.wt, notes: d.notes, hbMs: 150, staleMs: 3000,
    policy: { auto_resume_max: 0 }, budget: {}, tick: null, parent: 'RUN-7', brief: d.brief('mode: done\n') });
  assert.equal(d.item(r.run).data.parent, 'RUN-7');
  // the run this test started settles here (progress, no fixed deadline): left to the exit reap, its supervisor outlived the file on
  // Linux (CI 43540726632 LEAK RED, RUN-1)
  await d.ended(r.run);
});
