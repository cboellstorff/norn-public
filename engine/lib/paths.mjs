// Prerequisite discovery for `norn setup` / `norn doctor` (META-GENERAL-DESIGN 8). Every input is injectable (platform, env, home,
// fs, probe) so each OS's rules are tested on any host with a fake PATH and a virtual file system. Paths come back with "/".
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fwd = p => p.replace(/\\/g, '/');
const realFs = {
  isFile: p => { try { return fs.statSync(p).isFile(); } catch { return false; } },
  listDir: d => { try { return fs.readdirSync(d); } catch { return []; } },
  mtimeMs: p => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } },
  readText: p => fs.readFileSync(p, 'utf8'),
};
export function probeVersion(exe) {
  let sp;
  try { sp = resolveShim(exe, ['--version']); } catch { return null; }
  const r = spawnSync(sp.exe, sp.args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

// Windows npm .cmd / .bat shim -> [node, JS entry, ...args] so it spawns without a shell: Node >= 18.20.2 refuses .cmd/.bat
// without `shell: true` (EINVAL, CVE-2024-27980), and a shell would re-quote the prompt args. cross-spawn / cmd-shim practice:
// the npm shim's last line runs "%_prog%" "%dp0%\<entry>.js" %* (and %dp0%\node.exe when bundled). POSIX / .exe: unchanged.
// win32 paths (path.win32) on any host; `fs` = { isFile, readText } (default: the real disk), as which / discover.
export function resolveShim(exe, args = [], { platform = process.platform, execPath = process.execPath, fs: vfs = realFs } = {}) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(exe)) return { exe, args };
  let text;
  try { text = vfs.readText(exe); } catch (e) { throw new Error(`cannot resolve ${exe}: ${e.message}`); }
  let m = text.match(/"%(?:~?dp0%?)\\?([^"%]+\.(?:c|m)?js)"\s+%\*/i);
  // npm >= 10's npm.cmd / npx.cmd name the entry in a variable: SET "NPX_CLI_JS=%~dp0\node_modules\npm\bin\npx-cli.js" ...
  // "%NODE_EXE%" "%NPX_CLI_JS%" %* - the npm that ships beside that node (its global-prefix override is not read)
  const v = m ? null : text.match(/"%NODE_EXE%"\s+"%(\w+)%"\s+%\*/i);
  if (v) m = text.match(new RegExp(`SET\\s+"${v[1]}=%~?dp0%?\\\\?([^"%]+\\.(?:c|m)?js)"`, 'i'));
  if (!m) throw new Error(`cannot resolve ${exe}: not an npm node shim (no "%dp0%\\<entry>.js" %*)`);
  const dir = path.win32.dirname(exe), entry = path.win32.join(dir, m[1]);
  if (!vfs.isFile(entry)) throw new Error(`cannot resolve ${exe}: entry ${entry} does not exist`);
  const local = path.win32.join(dir, 'node.exe');
  return { exe: vfs.isFile(local) ? local : execPath, args: [entry, ...args] };
}

const win = platform => platform === 'win32';
const P = platform => (win(platform) ? path.win32 : path.posix);
const exts = (platform, env) => (win(platform) ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean) : ['']);
const first = (cands, vfs) => { const hit = cands.find(c => vfs.isFile(c)); return hit ? fwd(hit) : null; };

export function which(name, { platform = process.platform, env = process.env, fs: vfs = realFs } = {}) {
  const dirs = (env.PATH ?? env.Path ?? '').split(win(platform) ? ';' : ':').filter(Boolean);
  return first(dirs.flatMap(d => exts(platform, env).map(e => P(platform).join(d, name + e))), vfs);
}

const SCHED = { win32: 'windows-task', darwin: 'launchd', linux: 'systemd' };

export function discover({ platform = process.platform, env = process.env, home, fs: vfs = realFs, execPath = process.execPath,
  nodeVersion = process.versions.node, probe = probeVersion } = {}) {
  const p = P(platform), W = win(platform), exe = n => (W ? n + '.exe' : n);
  const ctx = { platform, env, fs: vfs };
  const problems = [];
  if (Number(nodeVersion.split('.')[0]) < 22) problems.push({ tool: 'node', msg: `node ${nodeVersion} < 22 (required)` });

  const gitExe = which('git', ctx);
  if (!gitExe) problems.push({ tool: 'git', msg: 'git not found (required: PATH)' });

  const npmPrefix = env.NPM_CONFIG_PREFIX || env.npm_config_prefix;
  const npmBins = W ? [npmPrefix || (env.APPDATA && p.join(env.APPDATA, 'npm'))].filter(Boolean).flatMap(d => [p.join(d, 'claude.cmd'), p.join(d, 'claude.exe')])
    : (npmPrefix ? [npmPrefix] : ['/usr/local', p.join(home, '.npm-global')]).map(d => p.join(d, 'bin', 'claude'));
  const claudeExe = which('claude', ctx) || first([p.join(home, '.local', 'bin', exe('claude')), ...npmBins], vfs);
  const configDir = fwd(env.CLAUDE_CONFIG_DIR || p.join(home, '.claude'));
  let claude = null;
  if (claudeExe) {
    const v = probe(claudeExe);
    claude = { exe: claudeExe, version: v?.match(/\d+\.\d+\.\d+/)?.[0] ?? null, config_dir: configDir, projects_dir: configDir + '/projects' };
  } else problems.push({ tool: 'claude', msg: 'claude not found (required: PATH, ~/.local/bin, npm global prefix)' });

  let codexExe = which('codex', ctx);
  if (!codexExe && W && env.LOCALAPPDATA) {
    const bin = p.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    const c = vfs.listDir(bin).map(d => p.join(bin, d, 'codex.exe')).filter(f => vfs.isFile(f))
      .sort((a, b) => vfs.mtimeMs(b) - vfs.mtimeMs(a) || b.localeCompare(a)); // newest install first
    codexExe = c[0] ? fwd(c[0]) : null;
  }

  return {
    node: { exe: fwd(execPath), version: nodeVersion }, git: gitExe && { exe: gitExe }, claude,
    codex: codexExe && { exe: codexExe, optional: true },
    scheduler: { kind: SCHED[platform] || 'cron', name: 'norn-tick', interval_min: 15 }, problems,
  };
}

// "Is this module the program node was started with?" by real path: argv[1] is the path as given (a symlink - macOS /var ->
// /private/var -, a junction or a Windows 8.3 short name), import.meta.url is the module's real path. Comparing them raw made the
// CLI silently do nothing (exit 0) when started through a link (META-ONBOARD S1).
export function isMain(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const a = real(path.resolve(argv1)), b = real(fileURLToPath(moduleUrl));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
