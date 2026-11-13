// Harness adapters (HARNESS-DESIGN sec. 3): one module per CLI family. An executor names its family (executors.mjs BUILTIN
// .harness; a typed entry: claude-compatible -> claude, openai-compatible -> codex, cli -> cli, runner fake -> fake). Roles stay data, harnesses code.
import claude from './claude.mjs';
import codex from './codex.mjs';
import cli from './cli.mjs';
import fake from './fake.mjs';
import { executorInfo, BUILTIN, isCli, isTyped } from '../executors.mjs';
import { presetFor, presetExe, loadPresets } from '../presets.mjs';
import { detectExe } from './common.mjs';

export const ADAPTERS = { claude, codex, cli, fake };

/** The family of executor `name` (entry = its project.json executors.<name>, if any); null = unknown. */
export function harnessOf(name, entry) {
  return executorInfo(name, entry)?.harness ?? null;
}

export function adapterFor(family) {
  const a = ADAPTERS[family];
  if (!a) throw new Error(`unknown harness family ${JSON.stringify(family)} (${Object.keys(ADAPTERS).join(' | ')})`);
  return a;
}

/**
 * The capability flags of executor `name` (entry = its project.json executors.<name>); null = unknown. A built-in / API type: its
 * family's caps. A cli entry: the cli family's (which claim nothing) < the preset's (entry.preset, else the preset of the same name,
 * as limitPatterns) < the entry's own `caps`.
 */
export function capsOf(name, entry) {
  const fam = harnessOf(name, entry);
  if (!fam) return null;
  const base = adapterFor(fam).caps;
  if (fam !== 'cli') return base;
  return { ...base, ...(presetFor(entry?.preset || name)?.caps || {}), ...(entry?.caps || {}) };
}

const CAP_COLS = ['fork', 'hooks', 'resume_style', 'noninteractive', 'chat'];
/**
 * `norn executors --caps`: one row per built-in (not fake), shipped preset and (with a project) typed project executor:
 * { name, kind: builtin | preset | project, family, detected (preset / cli: the exe found; else null), version, listed (preset:
 * the project lists it), modes, fork, hooks, resume_style, noninteractive, chat }. detect(entry) -> exe | null (default presetExe).
 */
export function capsMatrix({ project = null, env = process.env, detect, version = detectExe } = {}) {
  const pex = project?.executors || {};
  const found = detect || (x => presetExe({ preset: 'x', ...x }, env));
  const row = (name, kind, family, caps, x) => {
    const exe = x ? found(x) : null;
    return { name, kind, family, detected: x ? !!exe : null, version: exe ? version(exe)?.version ?? null : null,
      listed: kind === 'preset' ? Object.entries(pex).some(([n, e]) => e?.preset === name || (n === name && isCli(e))) : null,
      modes: caps.modes, ...Object.fromEntries(CAP_COLS.map(k => [k, caps[k]])) };
  };
  return [
    ...Object.entries(BUILTIN).filter(([n]) => n !== 'fake').map(([n, b]) => row(n, 'builtin', b.harness, adapterFor(b.harness).caps)),
    ...Object.entries(loadPresets()).map(([n, p]) => row(n, 'preset', 'cli', { ...ADAPTERS.cli.caps, ...(p.caps || {}) }, p)),
    ...Object.entries(pex).filter(([, x]) => isTyped(x)).map(([n, x]) => row(n, 'project', harnessOf(n, x), capsOf(n, x), isCli(x) ? x : null)),
  ];
}

/** The matrix as text: one padded line per row. */
export function formatCapsMatrix(rows) {
  const yn = v => (v === null ? '-' : v ? 'yes' : 'no');
  const cells = [['name', 'kind', 'detected', 'listed', 'family', 'modes', ...CAP_COLS, 'version'],
    ...rows.map(r => [r.name, r.kind, yn(r.detected), yn(r.listed), r.family, r.modes.join(','), String(r.fork), r.hooks, r.resume_style, r.noninteractive ?? '-', r.chat ?? 'none', r.version ?? '-'])];
  const w = cells[0].map((_, i) => Math.max(...cells.map(c => c[i].length)));
  return cells.map(c => c.map((s, i) => s.padEnd(w[i])).join('  ').trimEnd());
}
