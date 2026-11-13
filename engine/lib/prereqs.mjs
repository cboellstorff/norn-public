// Prerequisites and their install lines (META-ONBOARD SPEC 3.1, DEC: print, never run). ONE table: each command is the vendor's
// documented one, `source` = the page it was copied from (checked 2026-11-09). meta never runs an install command; SETUP.md has an
// agent show the line to its human and run it only with the human's consent, in the human's shell. A family whose documented path
// is a multi-step repo setup (gh on apt / dnf) or unknown (`other`) gets the page URL instead of a guessed one-liner.
import fs from 'node:fs';

const NVM = 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash && . "$HOME/.nvm/nvm.sh" && nvm install 22';
const GH_LINUX = 'https://github.com/cli/cli/blob/trunk/docs/install_linux.md';
const CLAUDE_SH = 'curl -fsSL https://claude.ai/install.sh | bash';

export const PREREQS = {
  // win32: winget-pkgs OpenJS.NodeJS.LTS; darwin: formulae.brew.sh/formula/node; Linux: nodejs.org's nvm commands (distro packages lag 22)
  node: { required: true, why: 'runs meta (>= 22)', source: 'https://nodejs.org/en/download',
    install: { win32: 'winget install OpenJS.NodeJS.LTS', darwin: 'brew install node', apt: NVM, dnf: NVM, other: NVM } },
  git: { required: true, why: 'worktrees, the ledger, merges', source: 'https://git-scm.com/downloads',
    install: { win32: 'winget install --id Git.Git -e --source winget', darwin: 'brew install git', apt: 'sudo apt-get install git', dnf: 'sudo dnf install git', other: null } },
  claude: { required: true, why: 'the controller and the default executor', source: 'https://docs.claude.com/en/docs/claude-code/setup',
    install: { win32: 'irm https://claude.ai/install.ps1 | iex', darwin: CLAUDE_SH, apt: CLAUDE_SH, dnf: CLAUDE_SH, other: CLAUDE_SH } },
  codex: { required: false, why: 'the codex-sol / codex-astra executors', source: 'https://github.com/openai/codex',
    install: { win32: 'npm install -g @openai/codex', darwin: 'npm install -g @openai/codex', apt: 'npm install -g @openai/codex', dnf: 'npm install -g @openai/codex', other: 'npm install -g @openai/codex' } },
  gh: { required: false, why: 'CI runs, pull requests, remote repos', source: 'https://github.com/cli/cli',
    install: { win32: 'winget install --id GitHub.cli', darwin: 'brew install gh', apt: GH_LINUX, dnf: GH_LINUX, other: GH_LINUX } },
};
// `other: null` = the source page itself
for (const p of Object.values(PREREQS)) for (const f of Object.keys(p.install)) p.install[f] ??= p.source;

/** /etc/os-release text -> 'apt' | 'dnf' | 'other' (ID + ID_LIKE) */
export function linuxFamily(osRelease) {
  const ids = [];
  for (const l of String(osRelease || '').split(/\r?\n/)) {
    const m = /^(ID|ID_LIKE)=("?)([^"]*)\2\s*$/.exec(l);
    if (m) ids.push(...m[3].toLowerCase().split(/\s+/).filter(Boolean));
  }
  if (ids.some(i => ['debian', 'ubuntu'].includes(i))) return 'apt';
  if (ids.some(i => ['fedora', 'rhel', 'centos'].includes(i))) return 'dnf';
  return 'other';
}

const readOsRelease = () => { try { return fs.readFileSync('/etc/os-release', 'utf8'); } catch { return ''; } };
const familyOf = (platform, osRelease) => (platform === 'win32' || platform === 'darwin' ? platform : linuxFamily(osRelease ?? readOsRelease()));

/** one line: `install: <command>   (<source>)`, or `install: see <url>` when the documented path is the page itself */
export function hint(tool, { platform = process.platform, osRelease } = {}) {
  const p = PREREQS[tool];
  if (!p) throw new Error(`unknown prerequisite ${tool}`);
  const c = p.install[familyOf(platform, osRelease)];
  return /^https:\/\/\S+$/.test(c) ? `install: see ${c}` : `install: ${c}   (${p.source})`;
}

export const nodeOk = v => Number(String(v).replace(/^v/, '').split('.')[0]) >= 22;
