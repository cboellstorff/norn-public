// META-ONBOARD S2 (SPEC 3.1): prerequisite install hints - printed, never run. hint() is pure: platform + /etc/os-release text injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PREREQS, hint, linuxFamily, nodeOk } from '../engine/lib/prereqs.mjs';
import { discover } from '../engine/lib/paths.mjs';

const UBUNTU = 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\n';
const MINT = 'NAME="Linux Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\n';
const FEDORA = 'NAME="Fedora Linux"\nID=fedora\nVERSION_ID=41\n';
const ROCKY = 'NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\n';
const ARCH = 'NAME="Arch Linux"\nID=arch\n';

test('every PREREQS entry: required flag, why, a command per family and an https source', () => {
  assert.deepEqual(Object.keys(PREREQS).sort(), ['claude', 'codex', 'gh', 'git', 'node']);
  for (const [k, p] of Object.entries(PREREQS)) {
    assert.equal(typeof p.required, 'boolean', k); assert.ok(p.why, k); assert.match(p.source, /^https:\/\//, k);
    for (const f of ['win32', 'darwin', 'apt', 'dnf', 'other']) assert.ok(p.install[f], `${k}.${f}`);
  }
  assert.deepEqual(Object.entries(PREREQS).filter(([, p]) => p.required).map(([k]) => k).sort(), ['claude', 'git', 'node']);
});

test('hint: the exact official line per OS x tool', () => {
  const h = (t, platform, osRelease) => hint(t, { platform, osRelease });
  assert.equal(h('git', 'win32'), 'install: winget install --id Git.Git -e --source winget   (https://git-scm.com/downloads)');
  assert.equal(h('git', 'darwin'), 'install: brew install git   (https://git-scm.com/downloads)');
  assert.equal(h('git', 'linux', UBUNTU), 'install: sudo apt-get install git   (https://git-scm.com/downloads)');
  assert.equal(h('git', 'linux', FEDORA), 'install: sudo dnf install git   (https://git-scm.com/downloads)');
  assert.equal(h('git', 'linux', ARCH), 'install: see https://git-scm.com/downloads');
  assert.equal(h('node', 'win32'), 'install: winget install OpenJS.NodeJS.LTS   (https://nodejs.org/en/download)');
  assert.equal(h('node', 'darwin'), 'install: brew install node   (https://nodejs.org/en/download)');
  for (const os of [UBUNTU, FEDORA]) assert.match(h('node', 'linux', os), /^install: curl -o- https:\/\/raw\.githubusercontent\.com\/nvm-sh\/nvm\/v[\d.]+\/install\.sh \| bash && \. "\$HOME\/\.nvm\/nvm\.sh" && nvm install 22 {3}\(https:\/\/nodejs\.org\/en\/download\)$/);
  assert.equal(h('claude', 'win32'), 'install: irm https://claude.ai/install.ps1 | iex   (https://docs.claude.com/en/docs/claude-code/setup)');
  for (const [p, o] of [['darwin'], ['linux', UBUNTU], ['linux', ARCH]]) assert.equal(h('claude', p, o), 'install: curl -fsSL https://claude.ai/install.sh | bash   (https://docs.claude.com/en/docs/claude-code/setup)');
  assert.equal(h('codex', 'linux', FEDORA), 'install: npm install -g @openai/codex   (https://github.com/openai/codex)');
  assert.equal(h('gh', 'win32'), 'install: winget install --id GitHub.cli   (https://github.com/cli/cli)');
  assert.equal(h('gh', 'darwin'), 'install: brew install gh   (https://github.com/cli/cli)');
  assert.equal(h('gh', 'linux', UBUNTU), 'install: see https://github.com/cli/cli/blob/trunk/docs/install_linux.md');
  assert.equal(h('gh', 'linux', FEDORA), 'install: see https://github.com/cli/cli/blob/trunk/docs/install_linux.md');
  assert.throws(() => hint('nope', { platform: 'linux' }), /unknown prerequisite/);
});

test('discover: problems are { tool, msg } so a caller can print the hint', () => {
  const d = discover({ execPath: '/x/node', nodeVersion: '20.11.0', probe: () => null, platform: 'linux', env: { PATH: '/usr/bin' }, home: '/hh/u',
    fs: { isFile: () => false, listDir: () => [], mtimeMs: () => 0 } });
  assert.deepEqual(d.problems.map(p => p.tool), ['node', 'git', 'claude']);
  assert.match(d.problems[1].msg, /^git not found \(required: PATH\)$/);
});
