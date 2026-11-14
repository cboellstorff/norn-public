// S3 discovery (META-GENERAL-DESIGN 8): fake PATH + a virtual file system per OS, so every OS's rules run on any host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../engine/lib/paths.mjs';

// virtual fs: { '<path>': mtimeMs } ; dirs are implied by the file paths; windows names are case-insensitive like NTFS
const vfs = (files, sep) => ({
  isFile: p => (sep === '\\' ? Object.keys(files).some(f => f.toLowerCase() === p.toLowerCase()) : Object.hasOwn(files, p)),
  listDir: d => [...new Set(Object.keys(files).filter(f => f.startsWith(d + sep)).map(f => f.slice(d.length + 1).split(sep)[0]))],
  mtimeMs: p => files[p] ?? 0,
});
const base = { execPath: '/x/node', nodeVersion: '24.1.0', probe: exe => (exe.includes('claude') ? '2.1.314 (Claude Code)' : null) };

test('windows: PATH + PATHEXT, claude from ~/.local/bin, codex newest under LOCALAPPDATA; no grok slot (a cli executor names its exe in project.json)', () => {
  const H = 'D:\\hh\\u';
  const files = {
    'D:\\bin\\git.EXE': 1, [`${H}\\.local\\bin\\claude.exe`]: 1,
    [`${H}\\AppData\\Local\\OpenAI\\Codex\\bin\\0.9\\codex.exe`]: 100, [`${H}\\AppData\\Local\\OpenAI\\Codex\\bin\\1.2\\codex.exe`]: 300,
    [`${H}\\AppData\\Local\\OpenAI\\Codex\\bin\\1.10\\codex.exe`]: 200, [`${H}\\.grok\\bin\\grok.exe`]: 1,
  };
  const env = { PATH: 'D:\\nope;D:\\bin', PATHEXT: '.COM;.EXE;.CMD', LOCALAPPDATA: `${H}\\AppData\\Local`, APPDATA: `${H}\\AppData\\Roaming` };
  const d = discover({ ...base, platform: 'win32', env, home: H, fs: vfs(files, '\\') });
  assert.equal(d.git.exe, 'D:/bin/git.exe'); // PATHEXT .EXE -> .exe (case-insensitive fs)
  assert.equal(d.claude.exe, 'D:/hh/u/.local/bin/claude.exe');
  assert.equal(d.claude.version, '2.1.314');
  assert.equal(d.claude.config_dir, 'D:/hh/u/.claude'); assert.equal(d.claude.projects_dir, 'D:/hh/u/.claude/projects');
  assert.equal(d.codex.exe, 'D:/hh/u/AppData/Local/OpenAI/Codex/bin/1.2/codex.exe'); // newest = latest mtime
  assert.equal(d.grok, undefined);
  assert.equal(d.scheduler.kind, 'windows-task');
  assert.deepEqual(d.problems, []);
});

test('windows: claude from the npm global prefix (claude.cmd) when nothing else has it; PATH wins over home dirs', () => {
  const H = 'D:\\hh\\u';
  const env = { PATH: 'D:\\bin', PATHEXT: '.EXE;.CMD', APPDATA: `${H}\\AppData\\Roaming` };
  let d = discover({ ...base, platform: 'win32', env, home: H, fs: vfs({ 'D:\\bin\\git.exe': 1, [`${H}\\AppData\\Roaming\\npm\\claude.cmd`]: 1 }, '\\') });
  assert.equal(d.claude.exe, 'D:/hh/u/AppData/Roaming/npm/claude.cmd');
  d = discover({ ...base, platform: 'win32', env, home: H, fs: vfs({ 'D:\\bin\\git.exe': 1, 'D:\\bin\\claude.exe': 1, [`${H}\\.local\\bin\\claude.exe`]: 1 }, '\\') });
  assert.equal(d.claude.exe, 'D:/bin/claude.exe');
});

test('linux: ":" PATH, no extensions, CLAUDE_CONFIG_DIR honoured, optional executors missing = null, not a problem', () => {
  const H = '/hh/u';
  const env = { PATH: '/usr/bin:/opt/x', CLAUDE_CONFIG_DIR: '/cfg/claude' };
  const d = discover({ ...base, platform: 'linux', env, home: H, fs: vfs({ '/usr/bin/git': 1, '/opt/x/claude': 1 }, '/') });
  assert.equal(d.git.exe, '/usr/bin/git'); assert.equal(d.claude.exe, '/opt/x/claude');
  assert.equal(d.claude.config_dir, '/cfg/claude'); assert.equal(d.claude.projects_dir, '/cfg/claude/projects');
  assert.equal(d.codex, null); assert.equal(d.grok, undefined);
  assert.equal(d.scheduler.kind, 'systemd');
  assert.deepEqual(d.problems, []);
});

test('macos: claude from ~/.local/bin, npm prefix from NPM_CONFIG_PREFIX, scheduler launchd', () => {
  const H = '/hh/u';
  let d = discover({ ...base, platform: 'darwin', env: { PATH: '/usr/bin' }, home: H, fs: vfs({ '/usr/bin/git': 1, '/hh/u/.local/bin/claude': 1 }, '/') });
  assert.equal(d.claude.exe, '/hh/u/.local/bin/claude'); assert.equal(d.scheduler.kind, 'launchd');
  d = discover({ ...base, platform: 'darwin', env: { PATH: '/usr/bin', NPM_CONFIG_PREFIX: '/np' }, home: H, fs: vfs({ '/usr/bin/git': 1, '/np/bin/claude': 1 }, '/') });
  assert.equal(d.claude.exe, '/np/bin/claude');
});

test('required prerequisites missing or node < 22 are problems', () => {
  const d = discover({ ...base, nodeVersion: '20.11.0', platform: 'linux', env: { PATH: '/usr/bin' }, home: '/hh/u', fs: vfs({}, '/') });
  assert.equal(d.git, null); assert.equal(d.claude, null);
  assert.deepEqual(d.problems.map(p => p.msg), ['node 20.11.0 < 22 (required)', 'git not found (required: PATH)',
    'claude not found (required: PATH, ~/.local/bin, npm global prefix)']);
});
