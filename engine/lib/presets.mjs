// Executor PRESETS (META-GTP-HARNESS, GT-PARITY-PLAN sec. 2.5; Gas Town internal/config/agents.go:20-110 - cited, not ported):
// engine/presets/<name>.json = the DATA of a cli-typed executor (exe, args template, modes, caps, limit where known) plus `source`
// (the --help or the official docs page its command line was checked against: tests/fixtures/help/<fixture>). A preset is INERT:
// it runs only when a project lists it (executors.<name> = { "preset": "<preset>", "model": ..., ... }) AND its exe is detected.
// No keys or tokens live in a preset or are read by it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './paths.mjs';
import { cliProblems, capsProblems, CLI_TYPE } from './executors.mjs';

export const PRESETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets');
const cache = new Map();

/** { name: preset } of the preset files in `dir` (read once per dir). */
export function loadPresets(dir = PRESETS_DIR) {
  const key = path.resolve(dir);
  if (cache.has(key)) return cache.get(key);
  const out = {};
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
  for (const f of files) {
    const name = f.slice(0, -5);
    let p;
    try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { throw new Error(`preset ${name}: ${e.message}`); }
    const errs = presetProblems(name, p);
    if (errs.length) throw new Error(`preset ${name}: ${errs.join('; ')}`);
    out[name] = p;
  }
  cache.set(key, out);
  return out;
}

const KEY_FIELDS = ['api_key', 'api_key_env', 'auth_token', 'key', 'token', 'env'];
/** Problems with a preset file (refused at load): the cli entry rules (no model: the listing project picks it), full caps, no keys. */
export function presetProblems(name, p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['must be a JSON object'];
  const errs = [];
  if (p.type !== CLI_TYPE) errs.push(`type must be ${CLI_TYPE}`);
  if (typeof p.source?.fixture !== 'string') errs.push('source.fixture (the recorded --help it was checked against) is required');
  if (Object.hasOwn(p, 'model')) errs.push('model is the listing project choice, not a preset field');
  const keys = KEY_FIELDS.filter(k => Object.hasOwn(p, k));
  if (keys.length) errs.push(`no keys or env in a preset (${keys.join(', ')})`);
  const at = 'x', strip = s => s.replace(/^x./, '');
  errs.push(...cliProblems(at, { ...p, model: '-' }).filter(e => !e.startsWith('x.caps') && !/caps.modes lacks/.test(e)).map(strip));
  errs.push(...capsProblems(at, p, { required: true }).map(strip));
  return errs;
}

/** The preset `name`, or null. */
export const presetFor = (name, dir = PRESETS_DIR) => (name && Object.hasOwn(loadPresets(dir), name) ? loadPresets(dir)[name] : null);

/**
 * The project with each executors.<name> = { "preset": "<p>", ...overrides } expanded to the preset's data + the overrides (caps merge
 * key by key; `source` stays in the preset; `preset` stays on the entry - the run's detect gate and capsOf read it). Idempotent.
 * Throws on an unknown preset.
 */
export function expandPresets(obj, dir = PRESETS_DIR) {
  const ex = obj?.executors;
  if (!ex || !Object.values(ex).some(x => x && Object.hasOwn(x, 'preset'))) return obj;
  const out = {};
  for (const [name, x] of Object.entries(ex)) {
    if (!x || !Object.hasOwn(x, 'preset')) { out[name] = x; continue; }
    const p = presetFor(x.preset, dir);
    if (!p) throw new Error(`executors.${name}: unknown preset ${JSON.stringify(x.preset)} (${Object.keys(loadPresets(dir)).join(' | ')})`);
    const { source, ...data } = p;
    out[name] = { ...data, ...x, ...(data.caps || x.caps ? { caps: { ...(data.caps || {}), ...(x.caps || {}) } } : {}) };
  }
  return { ...obj, executors: out };
}

/**
 * The runnable exe of a cli entry. A preset-based entry (entry.preset) is INERT until its exe is detected: an absolute path that
 * exists, else the first hit on PATH (env) - null = not detected. A hand-written entry keeps its exe as written.
 */
export function presetExe(entry, env = process.env) {
  if (!entry?.preset) return entry?.exe;
  const exe = entry.exe;
  if (!exe) return null;
  if (path.isAbsolute(exe) || /[\/]/.test(exe)) return fs.existsSync(exe) ? exe : null;
  return which(exe, { env });
}
