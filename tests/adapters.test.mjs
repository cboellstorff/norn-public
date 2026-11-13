// H2 adapter contract (HARNESS-DESIGN sec. 3): engine/lib/harness/{claude,codex,cli,fake}.mjs. The refactor proof is the golden
// matrix (today's command lines, byte-same); the rest is the new surface: harness on executors, normalized usage, headless
// snippets, read-only + no-tools modes, MCP attach, checkin_executor / chat_executor Settings rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCommand } from '../engine/lib/runs.mjs';
import { probeCommand } from '../engine/lib/probe.mjs';
import { BUILTIN } from '../engine/lib/executors.mjs';
import { ADAPTERS, adapterFor, harnessOf } from '../engine/lib/harness/index.mjs';
import { settingsFor, withDefaults } from '../engine/lib/policy.mjs';
import { BASE, CASES, PROBES, MACHINE, GROK, stable } from './helpers/command-matrix.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLD = JSON.parse(fs.readFileSync(path.join(HERE, 'golden', 'commands', 'matrix.json'), 'utf8'));
const tmp = () => mkTmp('meta-h2-');
const at = (args, f) => args[args.indexOf(f) + 1];
const O = { ...BASE, executor: 'x' };
const G = { ...BASE, executor: 'grok', provider: GROK };   // grok = DATA (kestrel project.json, type cli) through the cli adapter

test('golden: every executor command line and probe is byte-same with the pre-adapter switch', () => {
  for (const [k, c] of Object.entries(CASES)) assert.deepEqual(stable(buildCommand({ ...BASE, ...c })), GOLD.commands[k], k);
  for (const [k, p] of Object.entries(PROBES)) { const dir = tmp(); assert.deepEqual(stable(probeCommand({ ...p, machine: MACHINE, env: { K: 'secret' }, dir }), dir), GOLD.probes[k], k); }
});

test('modes: read-only and no-tools per family; a mode a family lacks is refused', () => {
  const c = adapterFor('claude');
  assert.deepEqual(c.command({ ...O, mode: 'read-only' }), c.command({ ...O, readonly: true }));
  const nt = c.command({ ...O, mode: 'no-tools', agent: 'kestrel-implementer' }).args;
  assert.equal(at(nt, '--tools'), ''); assert.ok(nt.includes('--strict-mcp-config')); assert.ok(!nt.includes('--agent'));
  const cx = adapterFor('codex');
  assert.equal(at(cx.command({ ...O, mode: 'read-only' }).args, '-s'), 'read-only');
  assert.equal(at(cx.command(O).args, '-s'), 'workspace-write');
  assert.throws(() => cx.command({ ...O, mode: 'no-tools' }), /codex.*no-tools/);
  const g = adapterFor('cli');
  const gro = at(g.command({ ...G, mode: 'read-only' }).args, '--disallowed-tools').split(',');
  const gnt = at(g.command({ ...G, mode: 'no-tools' }).args, '--disallowed-tools').split(',');
  assert.ok(!gro.includes('read_file') && gnt.includes('read_file') && gnt.includes('grep') && gnt.includes('write'));
  assert.throws(() => c.command({ ...O, mode: 'sideways' }), /mode/);
});

test('MCP attach: claude by flag (strict, once), codex by -c overrides, cli / fake refuse (config / none)', () => {
  const mcp = { name: 'meta', command: 'C:/Program Files/nodejs/node.exe', args: ['C:/m/norn.mjs', 'mcp', '--profile', 'worker'] };
  const a = adapterFor('claude').command({ ...O, readonly: true, mcp }).args;
  assert.deepEqual(JSON.parse(at(a, '--mcp-config')), { mcpServers: { meta: { command: mcp.command, args: mcp.args } } });
  assert.equal(a.filter(x => x === '--strict-mcp-config').length, 1);
  const x = adapterFor('codex').command({ ...O, mcp }).args;
  assert.ok(x.includes(`mcp_servers.meta.command=${JSON.stringify(mcp.command)}`));
  assert.ok(x.includes(`mcp_servers.meta.args=${JSON.stringify(mcp.args)}`));
  assert.equal(x.at(-1), '-');
  assert.throws(() => adapterFor('cli').command({ ...G, mcp }), /norn harness install --family grok/);
  assert.throws(() => adapterFor('fake').command({ ...O, mcp }), /no MCP/);
});

test('normalized usage: { session_id, model, is_error, usage { input, cache_read, cache_write, output }, cost_usd }', () => {
  const cj = JSON.stringify({ session_id: 's1', is_error: false, total_cost_usd: 0.5, modelUsage: { 'claude-opus-5-5': {} },
    usage: { input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 4 } });
  assert.deepEqual(adapterFor('claude').parse(cj), { session_id: 's1', model: 'claude-opus-5-5', is_error: false,
    usage: { input: 10, cache_read: 200, cache_write: 30, output: 4 }, cost_usd: 0.5 });
  assert.deepEqual(adapterFor('fake').parse(cj), adapterFor('claude').parse(cj));
  assert.deepEqual(adapterFor('claude').parse('not json'), { session_id: null, model: null, is_error: null, usage: null, cost_usd: null });
  const log = 'OpenAI Codex\n--------\nmodel: gpt-6.1-sol\nreasoning effort: medium\nsession id: abc\n--------\nwork\ntokens used\n12,345\n';
  assert.deepEqual(adapterFor('codex').parse(log), { session_id: 'abc', model: 'gpt-6.1-sol', is_error: null,
    usage: { input: null, cache_read: null, cache_write: null, output: null, total: 12345 }, cost_usd: null });
  assert.deepEqual(adapterFor('cli').parse('plain text answer'), { session_id: null, model: null, is_error: null, usage: null, cost_usd: null });
});

test("end-record fields are today's (records schema unchanged): claude usage + cost_usd, codex tokens / model / effort / codex_session", () => {
  const d = tmp(), final = path.join(d, 'f.json'), log = path.join(d, 'l.log');
  fs.writeFileSync(final, JSON.stringify({ session_id: 's', total_cost_usd: 0.25, is_error: false, usage: { input_tokens: 1 } }));
  fs.writeFileSync(log, 'x\n--------\nmodel: gpt-6-astra\nreasoning effort: xhigh\nsession id: q9\n--------\ntokens used\n77\n');
  assert.deepEqual(adapterFor('claude').endData({ final, log }), { usage: { input_tokens: 1 }, cost_usd: 0.25 });
  assert.deepEqual(adapterFor('codex').endData({ final, log }), { tokens: 77, usage: { tokens: 77 }, model: 'gpt-6-astra', effort: 'xhigh', codex_session: 'q9' });
  assert.deepEqual(adapterFor('cli').endData({ final, log }), {});
  assert.deepEqual(adapterFor('claude').endData({ final: path.join(d, 'missing'), log }), { usage: null });
});

test('detect: exe + version from the machine, null when the family has no exe', () => {
  assert.equal(adapterFor('claude').detect({}), null);
  const r = adapterFor('cli').detect({ ...GROK, exe: process.execPath });   // a cli entry names its own exe
  assert.equal(r.exe, process.execPath); assert.match(r.version, /^v\d+\./);
  assert.equal(adapterFor('fake').detect({}).version, 'fake');
});

// CHECKIN-V2 piece 4 (H7 trial): the check-in executors = the built-ins whose adapter attaches MCP (caps.mcp); a non-claude
// check-in runs only under checkin_executor_trial and falls back to claude on a non-DONE tick (recorded: fallback_of)
test('Settings: checkin_executor lists the MCP-capable built-ins (claude, codex-*; not fake); chat stays claude; checkin_executor_trial off', () => {
  const rows = Object.fromEntries(settingsFor().map(s => [s.key, s]));
  assert.deepEqual([...rows.checkin_executor.options].sort(), ['claude', 'codex-astra', 'codex-sol']);
  for (const n of rows.checkin_executor.options) assert.notEqual(ADAPTERS[BUILTIN[n].harness].caps.mcp, 'none', n);
  assert.deepEqual(rows.chat_executor.options, ['claude'], 'the chat on adapters is H5, not this trial');
  assert.equal(rows.checkin_executor_trial.type, 'bool'); assert.equal(rows.checkin_executor_trial.recommended, 'off');
  assert.equal(withDefaults({}).checkin_executor_trial, false);
});

test('checkinExecutor: claude by default; another executor only under the trial (codex model, meta MCP checkin profile, claude fallback)', async () => {
  const { checkinExecutor } = await import('../engine/lib/tick.mjs');
  // the state dir is absolute ON THIS HOST (checkinExecutor path.resolve()s it; C:/s/... is cwd-relative on Linux)
  const abs = p => path.resolve(p).replace(/\\/g, '/'), ST = abs('/s/state');
  const machine = { claude: { exe: 'claude.exe' }, codex: { exe: 'codex.exe' } }, p = { name: 'demo', file: 'C:/p/project.json', state: ST + '/demo', ledger: 'C:/l/progress.md', briefs_dir: 'C:/b' };
  const B = { checkin_model: 'claude-opus-5-5', checkin_effort: 'medium' };
  assert.deepEqual(checkinExecutor({ B, machine, p }), { executor: 'claude', exe: 'claude.exe', model: 'claude-opus-5-5', effort: 'medium' });
  assert.match(checkinExecutor({ B: { ...B, checkin_executor: 'codex-astra' }, machine, p }).error, /checkin_executor_trial/);
  assert.match(checkinExecutor({ B: { ...B, checkin_executor: 'fake', checkin_executor_trial: true }, machine, p }).error, /not a check-in executor/);
  const c = checkinExecutor({ B: { ...B, checkin_executor: 'codex-astra', checkin_executor_trial: true }, machine, p });
  assert.equal(c.executor, 'codex-astra'); assert.equal(c.trial, 'codex-astra'); assert.equal(c.exe, 'codex.exe');
  assert.equal(c.model, 'gpt-6-astra'); assert.equal(c.effort, 'medium');
  assert.equal(c.mcp.name, 'meta'); assert.deepEqual(c.mcp.args.slice(-4), ['--project', 'C:/p/project.json', '--profile', 'checkin']);
  assert.ok(c.writable_roots.includes(ST), 'records + locks under the state root');
  assert.deepEqual(c.fallback, { executor: 'claude', exe: 'claude.exe', model: 'claude-opus-5-5', effort: 'medium' });
  assert.equal(checkinExecutor({ B: { ...B, checkin_executor: 'codex-sol', checkin_executor_trial: true }, machine, p }).model, 'gpt-6.1-sol');
  assert.match(checkinExecutor({ B: { ...B, checkin_executor: 'codex-sol', checkin_executor_trial: true }, machine: { claude: machine.claude }, p }).error, /no codex executable/);
  const d = checkinExecutor({ B: { ...B, checkin_executor: 'codex-sol', checkin_executor_trial: true }, machine, p, dry: true });
  assert.equal(d.executor, 'fake'); assert.equal(d.trial, 'codex-sol'); assert.equal(d.mcp, undefined, 'fake attaches no MCP'); assert.equal(d.fallback.executor, 'fake');
});
