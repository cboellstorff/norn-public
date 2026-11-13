// META-AGNOSTIC-EXEC (DIR-66, DEC-622): no Grok code - executors are DATA of three types (claude-compatible, openai-compatible,
// cli); `norn delegate --mode` runs a cli executor's named modes as recorded helper runs (also with no RUN id of the caller's own).
// Temp dirs + node as the "cli" only: no real executor, no paid provider is ever spawned.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkProject, loadProject, loadMachine, ConfigError } from '../engine/lib/config.mjs';
import { providerProblems, executorInfo, capsOfRun, capDefault, cliMode, providersOf, executorExtra, BUILTIN } from '../engine/lib/executors.mjs';
import { buildCommand, startRun, stopRun, RunError, RunRefused, lockPath, liveRuns } from '../engine/lib/runs.mjs';
import { loadState, record } from '../engine/lib/records.mjs';
import { delegateStart } from '../engine/lib/delegate.mjs';
import { probeCommand } from '../engine/lib/probe.mjs';
import { settingsView, generatedLines } from '../engine/lib/policy.mjs';
import { GROK } from './helpers/command-matrix.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { jargonIn } from './helpers/jargon.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const META = path.join(REPO, 'engine', 'bin', 'norn.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) { const t0 = performance.now(); for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); } }
const at = (args, f) => args[args.indexOf(f) + 1];
const proj = executors => ({ schema: 1, name: 'demo', title: 'Demo', root: '/r', executors });
const OA = { type: 'openai-compatible', base_url: 'https://openrouter.ai/api/v1', api_key_env: 'META_TEST_OA_KEY', model: 'openrouter/auto' };
// a cli executor that is node: prints an answer + the end marker on stdout (the final file); modes ro (read-only) + edit (write)
const TCLI = { type: 'cli', exe: process.execPath, model: 'm-1', effort: 'low', brief: 'file', output: 'plain',
  args: ['-e', "process.stdout.write('answer from the cli helper' + String.fromCharCode(10) + '## DONE' + String.fromCharCode(10))", '{mode}'],
  modes: { ro: { access: 'read-only', args: [] }, edit: { access: 'write', args: [] } } };

// parents hold until stopped: stop whatever a failed test left running
const held = [];
after(() => { for (const h of held) { try { if (h.d.item(h.run)?.state === 'running') stopRun({ state: h.d.state, locksDir: h.d.locks, run: h.run, by: 'owner' }); } catch { /* ended meanwhile */ } } });
function sandbox() {
  const t = mkTmp('meta-agn-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), wt: path.join(t, 'wt'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks', 'wt']) fs.mkdirSync(d[k], { recursive: true });
  d.item = id => loadState(d.state).items[id];
  // ended AND its supervisor gone: its end-of-run tail (lock release, queue fill, tick) is done (FINDING L1)
  d.ended = id => waitFor(() => { const it = d.item(id); return settled(it) && it; });
  // a running parent: the fake lives until the test stops it - no clock a loaded machine can outrun; after() stops leftovers
  d.parent = () => {
    const tag = Math.random().toString(16).slice(2), b = path.join(t, `parent-${tag}.md`);
    fs.writeFileSync(b, `mode: sleep\nuntil: ${path.join(t, `release-${tag}`)}\n`);
    const run = startRun({ state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt, notes: d.notes, brief: b, hbMs: 150, staleMs: 3000,
      policy: { auto_resume_max: 0 }, budget: {}, tick: null }).run;
    held.push({ d, run });
    return run;
  };
  d.project = { name: 'demo', executors: { tcli: TCLI, glm: { type: 'claude-compatible', base_url: 'https://g.test', api_key_env: 'META_TEST_NO_KEY', model: 'g' } } };
  d.opts = (o = {}) => ({ state: d.state, locksDir: d.locks, env: {}, cls: 'chores', executor: 'tcli', project: d.project, q: 'where is X built? cite file:line', hbMs: 150, staleMs: 3000, ...o });
  return d;
}

// ---------- 1. data: three types, validated ----------
test('config: cli + openai-compatible entries are data; the demo fixture + example load; bad cli / openai entries are refused', () => {
  for (const p of [['tests', 'fixtures', 'projects', 'demo'], ['projects', 'example']]) assert.doesNotThrow(() => checkProject(JSON.parse(fs.readFileSync(path.join(REPO, ...p, 'project.json'), 'utf8'))), p.join('/'));
  assert.deepEqual(providerProblems(proj({ grok: GROK, oa: OA })), []);
  assert.ok(!Object.hasOwn(BUILTIN, 'grok'), 'grok is no built-in');
  const bad = x => providerProblems(proj({ t: x })).join('; ');
  for (const k of ['exe', 'model']) { const e = { ...GROK }; delete e[k]; assert.match(bad(e), new RegExp(`${k} is required`)); }
  assert.match(bad({ ...GROK, modes: {} }), /at least one named mode/);
  assert.match(bad({ ...GROK, modes: { x: { access: 'all', args: [] } } }), /access must be/);
  assert.match(bad({ ...GROK, args: ['{cwd}', '{nope}'] }), /unknown placeholder \{nope\}/);
  assert.match(bad({ ...GROK, brief: 'pipe' }), /brief must be/);
  assert.match(bad({ ...OA, wire_api: 'grpc' }), /wire_api/);
  assert.match(bad({ ...OA, api_key: 'sk-x' }), /keys never live in a file/);
  assert.match(bad({ ...OA, api_key_env: 'lower' }), /env var NAME/);
  assert.match(bad({ type: 'mystery' }), /type must be/);
});

// ---------- 2. cli: named modes, placeholders ----------
test('cli: a mode by name or by access (first in entry order); {turns} from the entry or the run; stdin brief; unknown mode refused', () => {
  assert.equal(cliMode(GROK, 'write')[0], 'run'); assert.equal(cliMode(GROK, 'read-only')[0], 'ro'); assert.equal(cliMode(GROK, 'web')[0], 'web');
  assert.throws(() => cliMode(GROK, 'sideways'), /no mode/);
  const o = { executor: 'grok', provider: GROK, exe: '/x/g', worktree: '/w', brief: '/b.md', model: 'm', effort: 'high', final: '/f.json' };
  assert.equal(at(buildCommand(o).args, '--max-turns'), '80');
  assert.equal(at(buildCommand({ ...o, turns: 3 }).args, '--max-turns'), '3');
  assert.throws(() => buildCommand({ ...o, mode: 'sideways' }), /grok: no mode/);
  const { turns, ...noTurns } = GROK;
  assert.throws(() => buildCommand({ ...o, provider: noTurns }), /\{turns\} has no value/);
  const st = buildCommand({ ...o, executor: 't', provider: { ...TCLI, brief: 'stdin' } });
  assert.equal(st.stdin, '/b.md'); assert.equal(st.stdout, 'final'); assert.equal(st.exe, '/x/g');
  const app = buildCommand({ ...o, executor: 't', provider: { ...TCLI, args: ['run', '{model}'], modes: { w: { access: 'write', args: ['--yes'] } } } });
  assert.deepEqual(app.args, ['run', 'm', '--yes'], 'no {mode} -> the mode args are appended');
  assert.deepEqual(executorInfo('grok', GROK), { kind: 'cli', harness: 'cli', caps: ['max_grok'] });
});

const denied = m => at(GROK.modes[m].args, '--disallowed-tools').split(',');

test('grok deny lists name only real tools: the x_* search names grok warns "name no tool" about are gone from every mode', () => {
  for (const m of Object.keys(GROK.modes))
    for (const t of ['x_user_search', 'x_semantic_search', 'x_keyword_search', 'x_thread_fetch']) assert.ok(!denied(m).includes(t), `${m} still denies ${t}`);
});

// ---------- 3. openai-compatible: the codex CLI with a custom provider ----------
test('openai-compatible: codex exec + -c model_provider / model_providers.<name>.{name,base_url,env_key,wire_api}; roots like codex-sol; no key in args', () => {
  const o = { executor: 'openrouter-oa', provider: OA, exe: '/x/codex', brief: '/b.md', model: 'openrouter/auto', effort: 'medium', final: '/s/f.md',
    writable_roots: ['C:/r/.git'] };
  const c = buildCommand(o);
  assert.equal(c.exe, '/x/codex'); assert.equal(c.parse, 'codex'); assert.equal(c.stdin, '/b.md');
  const i = c.args.indexOf('model_provider="openrouter-oa"');
  assert.ok(i > 0 && c.args[i - 1] === '-c');
  assert.deepEqual(c.args.slice(i + 1, i + 9), ['-c', 'model_providers.openrouter-oa.name="openrouter-oa"', '-c', 'model_providers.openrouter-oa.base_url="https://openrouter.ai/api/v1"',
    '-c', 'model_providers.openrouter-oa.env_key="META_TEST_OA_KEY"', '-c', 'model_providers.openrouter-oa.wire_api="responses"']);
  assert.ok(c.args.includes("sandbox_workspace_write.writable_roots=['C:/r/.git']"));
  assert.ok(buildCommand({ ...o, provider: { ...OA, wire_api: 'chat' } }).args.includes('model_providers.openrouter-oa.wire_api="chat"'));
  assert.equal(at(buildCommand({ ...o, readonly: true }).args, '-s'), 'read-only');
  assert.deepEqual(executorInfo('or', OA), { kind: 'provider', harness: 'codex', caps: ['max_or'] });
  assert.throws(() => probeCommand({ name: 'or', entry: OA, machine: { codex: { exe: '/x/codex' } }, env: { META_TEST_OA_KEY: 'k' }, dir: mkTmp('meta-agn-probe-') }), /not probed/);
});

test('openai-compatible run: refused before any spawn when its key var is unset; with the key it records kind provider, a .md final, no session id', async () => {
  const d = sandbox();
  const b = path.join(d.t, 'b.md'); fs.writeFileSync(b, 'x');
  const o = { state: d.state, locksDir: d.locks, executor: 'oa', provider: OA, exe: process.execPath, lane: 'x', worktree: d.wt, brief: b, budget: {}, tick: null, hbMs: 150, staleMs: 3000 };
  delete process.env.META_TEST_OA_KEY;
  assert.throws(() => startRun(o), e => e instanceof RunError && /META_TEST_OA_KEY is not set/.test(e.message));
  process.env.META_TEST_OA_KEY = 'meta-test-oa-SECRET';
  try {
    const r = startRun(o);   // node rejects the codex args at once: a crash, never a network call
    const it = d.item(r.run);
    assert.equal(it.data.kind, 'provider'); assert.ok(it.data.final.endsWith('.md')); assert.equal(it.data.session_id, undefined);
    assert.deepEqual(capsOfRun(it.data), ['max_oa']);
    await d.ended(r.run);
    for (const f of [path.join(d.state, 'runs', r.run + '.spec.json'), it.data.log]) assert.ok(!fs.readFileSync(f, 'utf8').includes('meta-test-oa-SECRET'), f);
  } finally { delete process.env.META_TEST_OA_KEY; }
});

// ---------- 4. caps: max_<name> for every typed executor ----------
test('caps: max_<name> per typed executor; unset = the entry cap (kestrel grok 4), else 1; settings rows + generated text from the configured executors', () => {
  assert.equal(capDefault(GROK), 4); assert.equal(capDefault(OA), 1);
  assert.deepEqual(capsOfRun({ kind: 'cli', executor: 'grok' }), ['max_grok']); assert.deepEqual(capsOfRun({ kind: 'provider', executor: 'oa' }), ['max_oa']);
  assert.deepEqual(capsOfRun({ kind: 'grok', executor: 'grok' }), ['max_grok'], 'a legacy grok run still counts');
  const extra = executorExtra(proj({ grok: GROK, oa: { ...OA, enabled: false } }));
  assert.deepEqual(extra, { providers: ['grok', 'oa'], caps: { grok: 4, oa: 1 }, enabled: ['grok'], agents: [] });   // agents: META-OOTB F-2 (none: no agent files, no policy names)
  const rows = Object.fromEntries(settingsView({}, extra).map(s => [s.key, s]));
  assert.equal(rows.max_grok.value, 4); assert.equal(rows.max_oa.value, 1); assert.equal(rows['policy.agents.grok_enabled'], undefined);
  assert.equal(Object.fromEntries(settingsView({ max_grok: 2 }, extra).map(s => [s.key, s])).max_grok.value, 2);
  assert.match(generatedLines({}, extra).executors, /Own-account executors on: grok\./);
  assert.doesNotMatch(JSON.stringify(generatedLines({}, extra)), /Grok/);
});

// ---------- 5. norn delegate --mode ----------
test('delegate --mode: a cli helper in a named write mode under its parent (no lock of its own); default = the read-only mode; the answer is its stdout', async () => {
  const d = sandbox();
  const p = d.parent();
  const e = delegateStart(d.opts({ env: { META_RUN_ID: p }, mode: 'edit' }));
  assert.equal(e.mode, 'edit');
  const it = d.item(e.run);
  assert.equal(it.data.parent, p); assert.equal(it.data.role, 'helper'); assert.equal(it.data.executor, 'tcli'); assert.equal(it.data.kind, 'cli');
  const brief = fs.readFileSync(it.data.brief, 'utf8');
  assert.match(brief, /mode edit/); assert.match(brief, /never commit/); assert.doesNotMatch(brief, /READ-ONLY/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d.state, 'runs', e.run + '.spec.json'), 'utf8')).mode, 'edit');
  assert.equal(JSON.parse(fs.readFileSync(lockPath(d.locks, d.wt), 'utf8')).run, p, 'the parent keeps the lock');
  assert.equal((await d.ended(e.run)).end.outcome, 'done');
  assert.match(fs.readFileSync(e.out, 'utf8'), /answer from the cli helper/);
  const r = delegateStart(d.opts({ env: { META_RUN_ID: p } }));
  assert.equal(r.mode, 'ro'); assert.match(fs.readFileSync(r.brief, 'utf8'), /READ-ONLY/);
  await d.ended(r.run);
  assert.throws(() => delegateStart(d.opts({ env: { META_RUN_ID: p }, mode: 'sideways' })), x => x instanceof RunError && /no mode/.test(x.message));
  assert.throws(() => delegateStart(d.opts({ env: { META_RUN_ID: p }, executor: 'glm', mode: 'edit' })), x => x instanceof RunError && /only a cli executor has named modes/.test(x.message));
  stopRun({ state: d.state, locksDir: d.locks, run: p, by: 'owner' });
});

// META-ONBOARD S6: the house rules a helper brief cites are the project's <project_dir>/rules/common-rules.txt, never an engine-root copy
test('delegate: house rules = <project_dir>/rules/common-rules.txt when it exists; an engine-root common-rules.txt is not read', async () => {
  const d = sandbox();
  const pd = path.join(d.t, 'proj'), meta = path.join(d.t, 'meta');
  fs.mkdirSync(path.join(pd, 'rules'), { recursive: true }); fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, 'common-rules.txt'), 'engine copy\n');
  const p = d.parent();
  const none = delegateStart(d.opts({ env: { META_RUN_ID: p }, metaRoot: meta, project: { ...d.project, project_dir: pd.replace(/\\/g, '/') } }));
  assert.doesNotMatch(fs.readFileSync(none.brief, 'utf8'), /House rules/, 'no project rules file: no rules line (the engine root is not a rules home)');
  await d.ended(none.run);
  fs.writeFileSync(path.join(pd, 'rules', 'common-rules.txt'), 'QUIET\n');
  const r = delegateStart(d.opts({ env: { META_RUN_ID: p }, metaRoot: meta, project: { ...d.project, project_dir: pd.replace(/\\/g, '/') } }));
  assert.ok(fs.readFileSync(r.brief, 'utf8').includes(`House rules (for context only): ${pd.replace(/\\/g, '/')}/rules/common-rules.txt`));
  await d.ended(r.run);
  stopRun({ state: d.state, locksDir: d.locks, run: p, by: 'owner' });
});

test('delegate with no RUN id (a Claude subagent of an interactive session): --worktree; read-only takes no lock, a write mode takes the worktree lock (3 if held)', async () => {
  const d = sandbox();
  assert.throws(() => delegateStart(d.opts()), x => x instanceof RunError && x.code === 2 && /--worktree/.test(x.message));
  const r = delegateStart(d.opts({ worktree: d.wt }));
  const it = d.item(r.run);
  assert.equal(it.data.parent, undefined); assert.equal(it.data.role, 'helper'); assert.equal(it.data.worktree, d.wt); assert.equal(it.data.via, 'delegate');
  assert.ok(!fs.existsSync(lockPath(d.locks, d.wt)), 'read-only: no lock');
  assert.equal((await d.ended(r.run)).end.outcome, 'done');
  const w = delegateStart(d.opts({ worktree: d.wt, mode: 'edit' }));
  assert.equal(JSON.parse(fs.readFileSync(lockPath(d.locks, d.wt), 'utf8')).run, w.run, 'write mode: the helper holds the lock');
  await d.ended(w.run);
  const p = d.parent();
  assert.throws(() => delegateStart(d.opts({ worktree: d.wt, mode: 'edit' })), x => x instanceof RunRefused && x.code === 3);
  stopRun({ state: d.state, locksDir: d.locks, run: p, by: 'owner' });
});

// ---------- 6. round 2 (review RUN-1623): legacy grok caps, `norn migrate` of machine.json, wire_api ----------
test('caps follow the EXECUTOR NAME of every non-built-in run: a live legacy kind-grok run + 3 cli runs -> the 5th grok run refused at cap 4', () => {
  assert.deepEqual(capsOfRun({ kind: 'grok', executor: 'grok' }), ['max_grok'], 'legacy grok run counts against max_grok');
  assert.deepEqual(capsOfRun({ kind: 'anything', executor: 'gone' }), ['max_gone'], 'unconfigured / any kind: by name');
  assert.deepEqual(capsOfRun({ kind: 'worker' }), []);
  const d = sandbox();
  const legacy = { kind: 'grok', executor: 'grok', project: 'kestrel', lane: 'meta-visual', model: 'grok-4.7', effort: 'high', worktree: d.wt };
  // the live legacy start record as written before the merge (record() no longer accepts kind grok)
  fs.writeFileSync(path.join(d.state, 'runs.jsonl'), JSON.stringify({ v: 1, seq: 1, ts: new Date().toISOString(), id: 'RUN-1', kind: 'run', ev: 'start', by: 'launcher', run: null, data: legacy }) + '\n');
  for (let i = 0; i < 3; i++) record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { ...legacy, kind: 'cli' } });
  fs.mkdirSync(path.join(d.state, 'hb'), { recursive: true });
  for (const id of Object.keys(loadState(d.state).items)) fs.writeFileSync(path.join(d.state, 'hb', id + '.hb'), '{}');
  assert.equal(liveRuns(d.state).filter(r => capsOfRun(r.data).includes('max_grok')).length, 4);
  const b = path.join(d.t, 'b.md'); fs.writeFileSync(b, 'mode: done\n');
  assert.throws(() => startRun({ state: d.state, locksDir: d.locks, lane: 'helper', model: 'fake', effort: 'high', worktree: d.wt, brief: b, notes: d.notes,
    executor: 'grok', provider: { ...GROK, runner: 'fake' }, exe: process.execPath, budget: {}, tick: null }),
  e => e instanceof RunRefused && /max_grok=4/.test(e.message));
});

test('machine.json: a leftover grok slot says "run `norn migrate`"; norn migrate drops it (backup kept, rest unchanged, valid), a second run is a no-op', () => {
  const t = mkTmp('meta-mig-'), mf = path.join(t, 'local', 'machine.json');
  fs.mkdirSync(path.dirname(mf));
  const good = { schema: 1, home: '/h', claude: { exe: '/c', config_dir: '/h/.claude', projects_dir: '/h/.claude/projects' }, node: '/n',
    scheduler: { kind: 'cron', name: 'meta', interval_min: 5 }, dash: { port: 0, bind: '127.0.0.1' }, projects: [] };
  fs.writeFileSync(mf, JSON.stringify({ ...good, grok: { exe: '/h/.grok/bin/grok.exe', optional: true } }, null, 1) + '\n');
  assert.throws(() => loadMachine(mf), e => e instanceof ConfigError && e.message.includes('$.grok is not allowed - run `norn migrate`'));
  const run = (...a) => spawnSync(process.execPath, [META, 'migrate', ...a], { encoding: 'utf8', env: { ...process.env, META_ROOT: t } });
  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr); assert.match(dry.stdout, /grok/); assert.ok(JSON.parse(fs.readFileSync(mf, 'utf8')).grok, 'dry run writes nothing');
  const r = run();
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /dropped grok .*executors\.grok\.exe/);
  assert.deepEqual(JSON.parse(fs.readFileSync(mf, 'utf8')), good);
  assert.ok(JSON.parse(fs.readFileSync(mf + '.pre-migrate', 'utf8')).grok, 'backup of the old file');
  assert.doesNotThrow(() => loadMachine(mf));
  const again = run('--machine', mf);
  assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /nothing to migrate/);
});

test('openai-compatible: wire_api "chat" refused - the installed codex-cli runs only "responses"', () => {
  const errs = providerProblems(proj({ oa: { ...OA, wire_api: 'chat' } }));
  assert.equal(errs.length, 1); assert.match(errs[0], /executors\.oa\.wire_api "chat".*codex-cli.*responses/);
  assert.deepEqual(providerProblems(proj({ oa: { ...OA, wire_api: 'responses' } })), []);
});

