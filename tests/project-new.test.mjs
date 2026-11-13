// META-ONBOARD S3 (SPEC 3.2 / 3.3): `norn project new` - a project.json for the user's repo from detected values, validated before
// it is written, written under machine.json projects_home (never inside the engine's tracked tree), registered. Temp meta root,
// temp HOME, a fake claude (and codex) first on PATH, the real git after it; nothing touches the live machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp } from './helpers/tmp.mjs';
import { which } from '../engine/lib/paths.mjs';
import { loadProject } from '../engine/lib/config.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const WIN = process.platform === 'win32';
const fwd = p => p.split(path.sep).join('/');
const GIT_DIR = path.dirname(which('git'));

function sandbox({ codex = false } = {}) {
  const t = mkTmp('meta-pnew-');
  const d = { root: path.join(t, 'meta'), home: path.join(t, 'home'), bin: path.join(t, 'bin'), cfg: path.join(t, 'claude-cfg'), t };
  for (const x of [d.root, d.home, d.bin, d.cfg]) fs.mkdirSync(x, { recursive: true });
  for (const n of ['claude', ...(codex ? ['codex'] : [])]) fs.writeFileSync(path.join(d.bin, WIN ? n + '.exe' : n), '');
  const env = { ...process.env, PATH: d.bin + path.delimiter + GIT_DIR, HOME: d.home, USERPROFILE: d.home, CLAUDE_CONFIG_DIR: d.cfg,
    LOCALAPPDATA: path.join(d.home, 'AppData', 'Local'), APPDATA: path.join(d.home, 'AppData', 'Roaming'), META_ROOT: d.root };
  for (const k of ['NPM_CONFIG_PREFIX', 'npm_config_prefix', 'META_STATE', 'META_PROJECT']) delete env[k];
  const run = (args, { input, extra } = {}) => {
    const r = spawnSync(process.execPath, [META, ...args], { env: { ...env, ...extra }, encoding: 'utf8', input: input ?? '' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const r = run(['setup', '--non-interactive', '--no-scheduler']);
  assert.equal(r.code, 0, r.err + r.out);
  return { ...d, run, machine: () => JSON.parse(fs.readFileSync(path.join(d.root, 'local', 'machine.json'), 'utf8')) };
}

function repo(sb, name = 'My Widget', { origin, branch = 'main', originHead } = {}) {
  const r = path.join(sb.t, name);
  fs.mkdirSync(r, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: r, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  g('init', '-q', '-b', branch);
  if (origin) g('remote', 'add', 'origin', origin);
  if (originHead) g('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/' + originHead);
  return { dir: r, g };
}
const newP = (sb, root, ...more) => sb.run(['project', 'new', '--root', root, '--non-interactive', ...more]);
const fileOf = (sb, name) => path.join(sb.home, '.norn', 'projects', name, 'project.json');
const json = f => JSON.parse(fs.readFileSync(f, 'utf8'));

test('setup writes projects_home = ${home}/.norn/projects (kept on a re-setup)', () => {
  const sb = sandbox();
  assert.equal(sb.machine().projects_home, '${home}/.norn/projects');
});

test('new: https github origin -> ci.repo; name slugified from the root; written under projects_home, validated, registered', () => {
  const sb = sandbox(), r = repo(sb, 'My Widget', { origin: 'https://github.com/acme/widget.git' });
  const x = newP(sb, r.dir);
  assert.equal(x.code, 0, x.err + x.out);
  const f = fileOf(sb, 'my-widget');
  assert.match(x.out.trimEnd(), new RegExp(`project my-widget: OK \\(${fwd(f).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)$`));
  const p = json(f);
  assert.equal(p.name, 'my-widget'); assert.equal(p.title, 'my-widget'); assert.equal(p.root, fwd(r.dir));
  assert.deepEqual(p.ci, { repo: 'acme/widget', branch: 'main' });
  assert.ok(fs.statSync(path.join(path.dirname(f), 'rules')).isDirectory(), 'an empty rules/ dir');
  assert.equal(p.ledger, '${state}/progress.md'); assert.equal(p.lane_defaults.worktree, '${state}/wt/${lane}');
  loadProject(f, { home: sb.home, meta: sb.root });   // validates
  assert.ok(sb.machine().projects.some(q => q.name === 'my-widget'), 'registered');
});

test('new: ssh origin -> ci.repo; no origin -> no ci; --ci none omits it; --name / --title / --ci override', () => {
  const sb = sandbox();
  const a = repo(sb, 'a', { origin: 'git@github.com:acme/alpha.git' });
  assert.equal(newP(sb, a.dir).code, 0);
  assert.deepEqual(json(fileOf(sb, 'a')).ci, { repo: 'acme/alpha', branch: 'main' });
  const b = repo(sb, 'b');
  assert.equal(newP(sb, b.dir).code, 0);
  assert.equal(json(fileOf(sb, 'b')).ci, undefined);
  const c = repo(sb, 'c', { origin: 'https://github.com/acme/gamma' });
  assert.equal(newP(sb, c.dir, '--ci', 'none').code, 0);
  assert.equal(json(fileOf(sb, 'c')).ci, undefined);
  const d = repo(sb, 'd', { origin: 'https://gitlab.com/acme/delta.git' });
  const x = newP(sb, d.dir, '--name', 'dee', '--title', 'The D', '--ci', 'other/repo');
  assert.equal(x.code, 0, x.err);
  const p = json(fileOf(sb, 'dee'));
  assert.equal(p.title, 'The D'); assert.deepEqual(p.ci, { repo: 'other/repo', branch: 'main' });
});

test('new: branch = --branch, else origin/HEAD, else the current branch, else main', () => {
  const sb = sandbox();
  const o = 'https://github.com/acme/w.git';
  const a = repo(sb, 'a', { origin: o, branch: 'dev', originHead: 'trunk' });
  assert.equal(newP(sb, a.dir).code, 0); assert.equal(json(fileOf(sb, 'a')).ci.branch, 'trunk');
  const b = repo(sb, 'b', { origin: o, branch: 'dev' });
  assert.equal(newP(sb, b.dir).code, 0); assert.equal(json(fileOf(sb, 'b')).ci.branch, 'dev');
  const c = repo(sb, 'c', { origin: o, branch: 'dev' });
  c.g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'); c.g('checkout', '-q', '--detach');
  assert.equal(newP(sb, c.dir).code, 0); assert.equal(json(fileOf(sb, 'c')).ci.branch, 'main');
  const d = repo(sb, 'd', { origin: o, originHead: 'trunk' });
  assert.equal(newP(sb, d.dir, '--branch', 'rel').code, 0); assert.equal(json(fileOf(sb, 'd')).ci.branch, 'rel');
});

test('new: executors = what the machine has (codex only with machine.codex); --executors narrows; unknown / undetected = exit 2', () => {
  const plain = sandbox(), r1 = repo(plain, 'p');
  assert.equal(newP(plain, r1.dir).code, 0);
  assert.deepEqual(json(fileOf(plain, 'p')).executors, { 'codex-sol': { enabled: false }, 'codex-astra': { enabled: false } });
  const x = newP(plain, repo(plain, 'q').dir, '--executors', 'claude,codex-sol');
  assert.equal(x.code, 2); assert.match(x.err, /codex-sol.*not (found|detected)/);
  const y = newP(plain, repo(plain, 'r').dir, '--executors', 'claude,nope');
  assert.equal(y.code, 2); assert.match(y.err, /unknown executor nope/);
  const cx = sandbox({ codex: true }), r2 = repo(cx, 'p');
  assert.equal(newP(cx, r2.dir).code, 0);
  assert.deepEqual(json(fileOf(cx, 'p')).executors, { 'codex-sol': { enabled: true }, 'codex-astra': { enabled: true } });
  assert.equal(newP(cx, repo(cx, 'q').dir, '--executors', 'claude,codex-astra').code, 0);
  assert.deepEqual(json(fileOf(cx, 'q')).executors, { 'codex-sol': { enabled: false }, 'codex-astra': { enabled: true } });
});

test('new refuses: a non-git root, a registered name, an existing file, a target inside the engine tree (local/ allowed)', () => {
  const sb = sandbox();
  const plain = path.join(sb.t, 'plain'); fs.mkdirSync(plain);
  let x = newP(sb, plain);
  assert.equal(x.code, 2); assert.match(x.err, /not a git repo/);
  const a = repo(sb, 'a');
  assert.equal(newP(sb, a.dir).code, 0);
  x = newP(sb, repo(sb, 'a2').dir, '--name', 'a', '--dir', path.join(sb.t, 'elsewhere'));
  assert.equal(x.code, 2); assert.match(x.err, /already registered/);
  const pre = path.join(sb.t, 'pre'); fs.mkdirSync(pre); fs.writeFileSync(path.join(pre, 'project.json'), 'mine');
  x = newP(sb, repo(sb, 'b').dir, '--dir', pre);
  assert.equal(x.code, 2); assert.match(x.err, /exists/); assert.equal(fs.readFileSync(path.join(pre, 'project.json'), 'utf8'), 'mine');
  x = newP(sb, repo(sb, 'c').dir, '--dir', path.join(sb.root, 'projects', 'c'));
  assert.equal(x.code, 2); assert.match(x.err, /inside the engine/); assert.equal(fs.existsSync(path.join(sb.root, 'projects', 'c')), false);
  x = newP(sb, repo(sb, 'd').dir, '--dir', path.join(sb.root, 'local', 'projects', 'd'));
  assert.equal(x.code, 0, x.err);
});

test('new --print prints the JSON and writes / registers nothing; --no-register writes but does not register', () => {
  const sb = sandbox(), r = repo(sb, 'pp', { origin: 'https://github.com/acme/pp.git' });
  const x = newP(sb, r.dir, '--print');
  assert.equal(x.code, 0, x.err);
  assert.equal(JSON.parse(x.out).name, 'pp');
  assert.equal(fs.existsSync(path.dirname(fileOf(sb, 'pp'))), false); assert.equal(sb.machine().projects.length, 0);
  assert.equal(newP(sb, r.dir, '--no-register').code, 0);
  assert.ok(fs.existsSync(fileOf(sb, 'pp'))); assert.equal(sb.machine().projects.length, 0);
});

test('new: an invalid draft writes nothing (exit 2, the schema error listed)', () => {
  const sb = sandbox(), r = repo(sb, 'v', { origin: 'https://github.com/acme/v.git' });
  const x = newP(sb, r.dir, '--name', 'Bad Name!');
  assert.equal(x.code, 2); assert.match(x.err, /\$\.name must match/);
  assert.equal(fs.existsSync(path.join(sb.home, '.norn')), false);
});

test('new interactive (piped stdin): each value asked with the detected default; blank = default', () => {
  const sb = sandbox(), r = repo(sb, 'iv', { origin: 'https://github.com/acme/iv.git' });
  const x = sb.run(['project', 'new', '--root', r.dir], { input: '\nInteractive Title\n\n\n\n', extra: { META_INTERACTIVE: '1' } });
  assert.equal(x.code, 0, x.err + x.out);
  assert.match(x.out, /name \[iv\]/); assert.match(x.out, /ci \[acme\/iv\]/);
  const p = json(fileOf(sb, 'iv'));
  assert.equal(p.title, 'Interactive Title'); assert.deepEqual(p.ci, { repo: 'acme/iv', branch: 'main' });
});

test('${project_dir} renders in installed agents (a project dir anywhere)', () => {
  const sb = sandbox(), r = repo(sb, 'pd');
  const dir = path.join(sb.t, 'somewhere', 'pd');
  assert.equal(newP(sb, r.dir, '--dir', dir, '--no-register').code, 0);
  const f = path.join(dir, 'project.json'), p = json(f);
  // project new made agents/ (META-OOTB F-2: the generic role agents)
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true }); fs.writeFileSync(path.join(dir, 'agents', 'pd-impl.md'), 'rules: ${project_dir}/rules/R.md\n');
  p.install = { agents: '${project_dir}/agents' }; fs.writeFileSync(f, JSON.stringify(p));
  const x = sb.run(['project', 'add', f]);
  assert.equal(x.code, 0, x.err + x.out);
  assert.equal(fs.readFileSync(path.join(sb.cfg, 'agents', 'pd-impl.md'), 'utf8'), `rules: ${fwd(dir)}/rules/R.md\n`);
});
