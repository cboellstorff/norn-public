// project.json / machine.json loading (META-GENERAL-DESIGN 4.2 / 4.3): schema check, then ${var} expansion with cycle detection.
// Builtins: home, meta (engine root), name, root, state (= ${meta}/state/<name>), dev (default: parent of root; a project var may set it),
// project_dir (the directory of the project.json: a project's own files, wherever it lives - META-ONBOARD 3.2).
// ${lane} is late-bound (lane_defaults): it survives loading and is filled by expandLate at use.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerProblems } from './executors.mjs';
import { expandPresets } from './presets.mjs';

export class ConfigError extends Error {}

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSchema = n => JSON.parse(fs.readFileSync(path.join(ENGINE, 'schema', n), 'utf8'));
export const PROJECT_SCHEMA = readSchema('project.schema.json');
export const MACHINE_SCHEMA = readSchema('machine.schema.json');
export const fwd = p => String(p).replace(/\\/g, '/');
export const metaRoot = (env = process.env) => fwd(env.META_ROOT || path.resolve(ENGINE, '..'));
export const homeDir = () => fwd(os.homedir());
const BUILTINS = ['home', 'meta', 'state', 'name', 'root', 'lane', 'project_dir'];
const LATE = ['lane'];
const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// JSON-schema subset: type (incl. lists, "integer"), enum, required, properties, additionalProperties (bool | schema), items, minimum, pattern.
export function validate(schema, v, at = '$') {
  const errs = [];
  const typeOf = x => (x === null ? 'null' : Array.isArray(x) ? 'array' : Number.isInteger(x) ? 'integer' : typeof x);
  if (schema.enum && !schema.enum.some(e => e === v)) return [`${at} must be one of ${schema.enum.join(', ')}`];
  if (schema.type) {
    const want = [].concat(schema.type), t = typeOf(v);
    if (!want.some(w => w === t || (w === 'number' && t === 'integer'))) return [`${at} must be ${want.join(' or ')}`];
  }
  if (typeof v === 'number' && schema.minimum !== undefined && v < schema.minimum) errs.push(`${at} must be >= ${schema.minimum}`);
  if (typeof v === 'string' && schema.pattern && !new RegExp(schema.pattern).test(v)) errs.push(`${at} must match ${schema.pattern}`);
  if (Array.isArray(v) && schema.items) v.forEach((x, i) => errs.push(...validate(schema.items, x, `${at}[${i}]`)));
  if (v && typeOf(v) === 'object') {
    for (const r of schema.required || []) if (!(r in v)) errs.push(`${at}.${r} is required`);
    for (const [k, x] of Object.entries(v)) {
      const ps = schema.properties?.[k];
      if (ps) errs.push(...validate(ps, x, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}.${k} is not allowed`);
      else if (typeof schema.additionalProperties === 'object') errs.push(...validate(schema.additionalProperties, x, `${at}.${k}`));
    }
  }
  return errs;
}

// vars: name -> template string (or a function returning one). Resolution is memoised; a revisit on the stack is a cycle.
function resolver(vars, late) {
  const done = new Map();
  const get = (name, stack) => {
    if (done.has(name)) return done.get(name);
    if (stack.includes(name)) throw new ConfigError(`cycle: ${[...stack.slice(stack.indexOf(name)), name].join(' -> ')}`);
    if (!Object.hasOwn(vars, name)) throw new ConfigError(`unknown variable \${${name}}`);
    const raw = typeof vars[name] === 'function' ? vars[name](n => get(n, [...stack, name])) : vars[name];
    const v = sub(raw, [...stack, name]);
    done.set(name, v);
    return v;
  };
  const sub = (s, stack) => String(s).replace(VAR, (m, n) => (late.includes(n) && !Object.hasOwn(vars, n) ? m : get(n, stack)));
  return s => sub(s, []);
}

export function expandVars(str, vars, { late = [] } = {}) { return resolver(vars, late)(str); }

export function expandLate(str, vars) {
  return String(str).replace(VAR, (m, n) => { if (!Object.hasOwn(vars, n)) throw new ConfigError(`unknown variable \${${n}}`); return String(vars[n]); });
}

function walk(v, f, at = '$') {
  if (typeof v === 'string') { try { return f(v); } catch (e) { throw new ConfigError(`${at}: ${e.message}`); } }
  if (Array.isArray(v)) return v.map((x, i) => walk(x, f, `${at}[${i}]`));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, f, `${at}.${k}`)]));
  return v;
}

function readJson(file) {
  const label = path.basename(file);
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { throw new ConfigError(`${label}: ${e.code === 'ENOENT' ? 'not found: ' + fwd(file) : e.message}`); }
  return { label, obj };
}

/** The project with its preset-based executors expanded (presets.mjs); an unknown preset is a ConfigError. */
export function withPresets(obj, label = 'project.json') {
  try { return expandPresets(obj); } catch (e) { throw new ConfigError(`${label}: ${e.message}`); }
}

export function checkProject(obj, label = 'project.json') {
  obj = withPresets(obj, label);
  const errs = validate(PROJECT_SCHEMA, obj);
  if (errs.length) throw new ConfigError(`${label}: ${errs.join('; ')}`);
  for (const k of Object.keys(obj.vars || {})) if (BUILTINS.includes(k)) throw new ConfigError(`${label}: vars.${k} shadows a builtin`);
  const pe = providerProblems(obj);
  if (pe.length) throw new ConfigError(`${label}: ${pe.join('; ')}`);
}

// META-ONBOARD cut-over EXPAND: <meta>/local/compat.json { swap, runs, paths: [{ from, to }], retained } maps a pre-swap project.json
// path to its new home, so a run started before the swap (its exit tick, its resume, a command it types) loads the project from the
// new layout. Its own file (not machine.json): it names the old paths on purpose, outside the stale-reference proof; --contract deletes it.
export const compatFile = (meta = metaRoot()) => path.join(meta, 'local', 'compat.json');
export function readCompat(meta = metaRoot()) { try { return JSON.parse(fs.readFileSync(compatFile(meta), 'utf8')); } catch { return null; } }
export function compatTarget(file, meta = metaRoot()) {
  const c = readCompat(meta);
  const key = p => { const s = fwd(path.resolve(p)); return process.platform === 'win32' ? s.toLowerCase() : s; };
  const hit = (c?.paths || []).find(x => key(x.from) === key(file));
  return hit ? hit.to : file;
}

export function loadProject(file, { home = homeDir(), meta = metaRoot() } = {}) {
  file = compatTarget(file, meta);
  const { label, obj: raw } = readJson(file);
  const obj = withPresets(raw, label);
  checkProject(obj, label);
  const vars = { ...obj.vars, home: fwd(home), meta: fwd(meta), name: obj.name, root: obj.root, state: '${meta}/state/${name}', project_dir: fwd(path.dirname(path.resolve(file))) };
  if (!Object.hasOwn(vars, 'dev')) vars.dev = get => get('root').replace(/\/+$/, '').replace(/\/[^/]*$/, '');
  const exp = resolver(vars, LATE);
  let out;
  try { out = walk(obj, exp); } catch (e) { throw new ConfigError(`${label}: ${e.message}`); }
  return { ...out, state: exp('${state}'), dev: exp('${dev}'), meta: fwd(meta), file: fwd(path.resolve(file)), project_dir: exp('${project_dir}') };
}

// machine.json slots that moved out (META-AGNOSTIC-EXEC: grok -> the project's executors.grok); `norn migrate` drops them
export const MOVED_SLOTS = ['grok'];
export function loadMachine(file, { home = homeDir(), meta = metaRoot() } = {}) {
  const { label, obj } = readJson(file);
  const errs = validate(MACHINE_SCHEMA, obj).map(e => (MOVED_SLOTS.some(k => e === `$.${k} is not allowed`) ? `${e} - run \`norn migrate\`` : e));
  if (errs.length) throw new ConfigError(`${label}: ${errs.join('; ')}`);
  const exp = resolver({ home: fwd(obj.home || home), meta: fwd(meta) }, []);
  try { return walk(obj, exp); } catch (e) { throw new ConfigError(`${label}: ${e.message}`); }
}

// the stored (unexpanded) form of a path: ${meta}/... when under the engine root, else absolute with forward slashes
export function portable(p, { meta = metaRoot() } = {}) {
  const a = fwd(path.resolve(p)), m = fwd(meta).replace(/\/+$/, '');
  const same = process.platform === 'win32' ? a.toLowerCase().startsWith(m.toLowerCase() + '/') : a.startsWith(m + '/');
  return same ? '${meta}' + a.slice(m.length) : a;
}
