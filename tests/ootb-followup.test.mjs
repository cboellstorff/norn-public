// META-OOTB FOLLOWUP R1 (norn DEC-86): the two defects BLOCKERS R1 left open.
// 1. starterPolicy routes only to executors the caps in force allow (Codex found + 0 Codex caps -> Claude roles, never codex-*).
// 2. the generic role agents installed under shared names survive `project remove` of ONE project while another still uses them.
// Temp meta root, temp HOME / USERPROFILE / CLAUDE_CONFIG_DIR, PATH = the sandbox bin + git only: nothing touches the live install.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp } from './helpers/tmp.mjs';
import { which } from '../engine/lib/paths.mjs';
import { POLICY_DEFAULTS, ROLE_AGENTS, STARTER_CAPS, starterPolicy } from '../engine/lib/policy.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const WIN = process.platform === 'win32';
const GIT_DIR = path.dirname(which('git'));

function sandbox({ codex = false } = {}) {
  const t = mkTmp('meta-ootb-fu-');
  const dirs = { t, root: path.join(t, 'meta'), home: path.join(t, 'home'), bin: path.join(t, 'bin'), cfg: path.join(t, 'claude-cfg') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  for (const n of ['claude', ...(codex ? ['codex'] : [])]) fs.writeFileSync(path.join(dirs.bin, WIN ? n + '.exe' : n), '');
  const env = { ...process.env, PATH: dirs.bin + path.delimiter + GIT_DIR, HOME: dirs.home, USERPROFILE: dirs.home, CLAUDE_CONFIG_DIR: dirs.cfg,
    LOCALAPPDATA: path.join(dirs.home, 'AppData', 'Local'), APPDATA: path.join(dirs.home, 'AppData', 'Roaming'), META_ROOT: dirs.root, META_NO_TICK: '1' };
  for (const k of ['NPM_CONFIG_PREFIX', 'npm_config_prefix', 'META_STATE', 'META_PROJECT', 'META_ROLE', 'META_RUN_ID']) delete env[k];
  const run = (...args) => { const r = spawnSync(process.execPath, [META, ...args], { env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  return { ...dirs, env, run, budgetFile: path.join(dirs.root, 'local', 'budget.json') };
}
function gitRepo(sb, name) {
  const r = path.join(sb.t, name);
  fs.mkdirSync(r, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: r, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(r, 'README.md'), '# app\n'); g('add', '.'); g('commit', '-q', '-m', 'init');
  return r;
}
const routed = p => [...Object.values(p.executors).map(e => e.executor), ...Object.values(p.fallbacks)];
const CODEX = ['claude', 'codex-sol', 'codex-astra'];

// ---------- 1. starterPolicy: caps in force + found executors ----------
test('FU-1 starterPolicy: Codex found but the starter caps give 0 Codex -> no codex route (same routes as no Codex found)', () => {
  const p = starterPolicy(CODEX, STARTER_CAPS);
  assert.ok(!routed(p).some(n => /codex/.test(n)), routed(p).join(','));
  assert.deepEqual(p, starterPolicy(['claude'], STARTER_CAPS));
  assert.deepEqual(p, starterPolicy(['claude']));
});

test('FU-1 starterPolicy: each Codex executor is allowed only by its own cap and the Codex total; unset caps = no limit', () => {
  assert.deepEqual(starterPolicy(CODEX, {}).executors, POLICY_DEFAULTS.executors, 'no caps: the engine defaults');
  assert.deepEqual(starterPolicy(CODEX).executors, POLICY_DEFAULTS.executors);
  const solOnly = starterPolicy(CODEX, { max_codex: 2, max_sol: 2, max_astra: 0 });
  assert.ok(routed(solOnly).includes('codex-sol'));
  assert.ok(!routed(solOnly).includes('codex-astra'), 'astra capped at 0: never routed');
  const astraOnly = starterPolicy(CODEX, { max_codex: 2, max_sol: 0 });
  assert.ok(!routed(astraOnly).includes('codex-sol'), 'sol capped at 0: never routed');
  for (const n of routed(astraOnly)) assert.ok(['auto', 'wait', 'opus-xhigh', ...ROLE_AGENTS, 'codex-astra'].includes(n), n);
  // the Codex total wins over a per-kind cap
  assert.ok(!routed(starterPolicy(CODEX, { max_codex: 0, max_sol: 5, max_astra: 5 })).some(n => /codex/.test(n)));
});

test('FU-1 project new with Codex found and the starter caps writes a policy with no codex route', () => {
  const sb = sandbox({ codex: true });
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler').code, 0);
  assert.equal(JSON.parse(fs.readFileSync(sb.budgetFile, 'utf8')).max_codex, 0, 'the starter caps are in force');
  const r = sb.run('project', 'new', '--root', gitRepo(sb, 'my-app'), '--non-interactive');
  assert.equal(r.code, 0, r.err + r.out);
  const pj = JSON.parse(fs.readFileSync(path.join(sb.home, '.norn', 'projects', 'my-app', 'project.json'), 'utf8'));
  assert.ok(!routed(pj.policy).some(n => /codex/.test(n)), routed(pj.policy).join(','));
  for (const k of ['review', 'diagnosis', 'images']) assert.ok(ROLE_AGENTS.includes(pj.policy.executors[k].executor), k);
});

// ---------- 2. shared generic agents survive removing one of two projects ----------
test('FU-2 two projects share the generic agents: removing one keeps them, removing the last deletes them; an unmanaged file is never touched', () => {
  const sb = sandbox();
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler').code, 0);
  const agents = path.join(sb.cfg, 'agents');
  fs.mkdirSync(agents, { recursive: true });
  const mine = path.join(agents, 'my-own.md');
  fs.writeFileSync(mine, '---\nname: my-own\ndescription: the user\'s\n---\nhand kept\n');
  for (const n of ['app-a', 'app-b']) { const r = sb.run('project', 'new', '--root', gitRepo(sb, n), '--non-interactive'); assert.equal(r.code, 0, r.err + r.out); }
  for (const n of ROLE_AGENTS) assert.ok(fs.existsSync(path.join(agents, n + '.md')), n);

  const ra = sb.run('project', 'remove', 'app-a');
  assert.equal(ra.code, 0, ra.err + ra.out);
  for (const n of ROLE_AGENTS) assert.ok(fs.existsSync(path.join(agents, n + '.md')), `${n} kept: app-b still uses it`);
  assert.match(ra.out, /kept .*implementer\.md.*app-b/);
  const chk = sb.run('gen', '--check');
  assert.equal(chk.code, 0, chk.err + chk.out);
  assert.doesNotMatch(chk.out + chk.err, /missing|orphan|not managed/);

  const rb = sb.run('project', 'remove', 'app-b');
  assert.equal(rb.code, 0, rb.err + rb.out);
  for (const n of ROLE_AGENTS) assert.ok(!fs.existsSync(path.join(agents, n + '.md')), `${n} deleted with the last project`);
  assert.equal(fs.readFileSync(mine, 'utf8'), '---\nname: my-own\ndescription: the user\'s\n---\nhand kept\n', 'unmanaged file untouched');
});

test('FU-2 an existing unmanaged implementer.md is never overwritten by project new nor deleted by project remove', () => {
  const sb = sandbox();
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler').code, 0);
  const own = path.join(sb.cfg, 'agents', 'implementer.md');
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, 'the user\'s own implementer\n');
  for (const n of ['app-a', 'app-b']) sb.run('project', 'new', '--root', gitRepo(sb, n), '--non-interactive');
  assert.equal(fs.readFileSync(own, 'utf8'), 'the user\'s own implementer\n');
  for (const n of ['app-a', 'app-b']) assert.equal(sb.run('project', 'remove', n).code, 0);
  assert.equal(fs.readFileSync(own, 'utf8'), 'the user\'s own implementer\n');
});
