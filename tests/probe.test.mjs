// metaexec X1: `norn doctor --probe <name>` - one minimal request through an executor's real command line (endpoint + model +
// agent resolve). Never prints a key value; providers without a key are refused before any spawn; Codex is never probed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeCommand, runProbe, ProbeRefused } from '../engine/lib/probe.mjs';
import { GROK } from './helpers/command-matrix.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const SECRET = 'meta-probe-SECRET-4242';
const GLM = { type: 'claude-compatible', base_url: 'https://api.z.ai/api/anthropic', api_key_env: 'META_TEST_GLM_KEY', model: 'glm-5.3', agent: 'kestrel-implementer' };
const KIMI = { ...GLM, base_url: 'https://api.moonshot.ai/anthropic', api_key_env: 'META_TEST_KIMI_KEY', model: 'kimi-k3' };
const machine = { claude: { exe: '/x/claude' } };
const tmp = () => mkTmp('meta-probe-t-');
const at = (args, f) => args[args.indexOf(f) + 1];

test('probe: claude-compatible providers without a key are refused cleanly ("key var X unset"), before any spawn', () => {
  for (const [n, x] of [['glm', GLM], ['kimi', KIMI]]) {
    assert.throws(() => probeCommand({ name: n, entry: x, machine, env: {}, dir: tmp() }),
      e => e instanceof ProbeRefused && e.message === `key var ${x.api_key_env} unset`);
    const lines = [];
    assert.equal(runProbe({ name: n, entry: x, machine, env: {}, out: l => lines.push(l) }), 1);
    assert.equal(lines.length, 1); assert.match(lines[0], new RegExp(`^PROBE FAILED ${n}: key var ${x.api_key_env} unset$`));
  }
  assert.throws(() => probeCommand({ name: 'glm', entry: { ...GLM, runner: 'fake' }, machine, env: {}, dir: tmp() }), /key var META_TEST_GLM_KEY unset/);
});

test('probe: a keyed provider runs the claude CLI path (model + agent, 1 turn, no remote control); the key is only in the child env', () => {
  const c = probeCommand({ name: 'glm', entry: GLM, machine, env: { META_TEST_GLM_KEY: SECRET }, dir: tmp() });
  assert.equal(c.exe, '/x/claude'); assert.equal(at(c.args, '--model'), 'glm-5.3'); assert.equal(at(c.args, '--agent'), 'kestrel-implementer');
  assert.equal(at(c.args, '--max-turns'), '1'); assert.ok(!c.args.includes('--remote-control'));
  assert.equal(c.env.ANTHROPIC_BASE_URL, GLM.base_url); assert.equal(c.env.ANTHROPIC_AUTH_TOKEN, SECRET); assert.equal(c.env.ANTHROPIC_MODEL, 'glm-5.3');
  assert.ok(!JSON.stringify(c.args).includes(SECRET));
  assert.throws(() => probeCommand({ name: 'glm', entry: GLM, machine: null, env: { META_TEST_GLM_KEY: SECRET }, dir: tmp() }), /no claude executable/);
});

test('probe: Codex is never probed; a disabled entry is refused; grok gets a 1-turn read-only command line', () => {
  for (const n of ['codex-sol', 'codex-astra']) assert.throws(() => probeCommand({ name: n, entry: {}, machine, env: {}, dir: tmp() }), e => e instanceof ProbeRefused && /codex/i.test(e.message));
  assert.throws(() => probeCommand({ name: 'glm', entry: { ...GLM, enabled: false }, machine, env: { META_TEST_GLM_KEY: SECRET }, dir: tmp() }), /disabled/);
  const g = probeCommand({ name: 'grok', entry: { ...GROK, exe: '/x/grok' }, machine, env: {}, dir: tmp() });
  assert.equal(g.exe, '/x/grok'); assert.equal(at(g.args, '--max-turns'), '1'); assert.equal(at(g.args, '-m'), 'grok-4.7');
  assert.equal(at(g.args, '--permission-mode'), 'dontAsk'); assert.ok(fs.existsSync(at(g.args, '--prompt-file')));
  assert.throws(() => probeCommand({ name: 'grok', entry: { ...GROK, exe: '' }, machine: {}, env: {}, dir: tmp() }), /no grok executable/);
  assert.throws(() => probeCommand({ name: 'grok', entry: {}, machine, env: {}, dir: tmp() }), /unknown executor/, 'grok without its entry is no executor');
});

test('probe: fake + a fake-runner provider pass (exit 0, one ok line, no key value); a failing command is one line, non-zero', () => {
  let lines = [];
  assert.equal(runProbe({ name: 'fake', entry: {}, machine: null, env: process.env, out: l => lines.push(l) }), 0, lines.join('\n'));
  assert.equal(lines.length, 1); assert.match(lines[0], /^ok probe fake: /);
  lines = [];
  assert.equal(runProbe({ name: 'glm', entry: { ...GLM, runner: 'fake' }, machine: null, env: { ...process.env, META_TEST_GLM_KEY: SECRET }, out: l => lines.push(l) }), 0, lines.join('\n'));
  assert.match(lines[0], /^ok probe glm: .*model glm-5\.3 .*agent kestrel-implementer/); assert.ok(!lines.join('\n').includes(SECRET));
  lines = [];   // grok with node as its "exe": node rejects --cwd -> the probe fails with node's first error line
  assert.notEqual(runProbe({ name: 'grok', entry: { ...GROK, exe: process.execPath }, machine: {}, env: process.env, out: l => lines.push(l) }), 0);
  assert.equal(lines.length, 1); assert.match(lines[0], /^PROBE FAILED grok: \S/); assert.ok(!lines[0].includes('\n'));
});

test('norn doctor --probe: fake ok (0); unknown executor 2; an unkeyed project provider 1 with the key var name only', () => {
  const t = tmp(), pf = path.join(t, 'project.json');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'demo', title: 'Demo', root: t, executors: { glm: GLM } }));
  const env = { ...process.env, META_ROOT: t }; delete env.META_TEST_GLM_KEY;
  const cli = (...a) => { const x = spawnSync(process.execPath, [META, ...a], { env, encoding: 'utf8' }); return { code: x.status, out: x.stdout + x.stderr }; };
  let r = cli('doctor', '--probe', 'fake'); assert.equal(r.code, 0, r.out); assert.match(r.out, /^ok probe fake: /m);
  r = cli('doctor', '--probe', 'nope'); assert.equal(r.code, 2, r.out); assert.match(r.out, /unknown executor "nope"/);
  r = cli('doctor', '--probe', 'glm', '--project', pf); assert.equal(r.code, 1, r.out); assert.equal(r.out.trim(), 'PROBE FAILED glm: key var META_TEST_GLM_KEY unset');
  r = cli('doctor', '--probe'); assert.equal(r.code, 2, r.out);
});
