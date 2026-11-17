// META-GTP-CI FIXTURES (DEC-85): shared git fixtures. A test file's fixture recipe (git init + commits + branches + worktrees) is
// built ONCE per test process into a template dir, and every test gets a filesystem copy of it: an isolated repo it may mutate,
// without paying the recipe's git spawns again (Windows: ~230 ms per git spawn under suite load, CIRED-60fa8b6 R2).
// The copy is a working repo: the absolute paths git writes (a clone's remote URL in `config`, a worktree's `.git` file, the main
// repo's `worktrees/<name>/gitdir`) are rewritten from the template dir to the copy, and so are the paths in the returned data.
// Every dir comes from mkTmp (DEC-60). The template's commit SHAs are shared by all its copies (same objects, same tips).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkTmp } from './tmp.mjs';

const templates = new Map();   // recipe key -> { root, data }
const fwd = p => p.split(path.sep).join('/');
const GIT_PATH_FILES = new Set(['config', 'gitdir', '.git']);

function walk(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'objects') walk(p, fn); }
    else fn(p, e.name);
  }
}
const swap = (s, pairs) => pairs.reduce((t, [a, b]) => t.split(a).join(b), s);
function remap(v, pairs) {
  if (typeof v === 'string') return swap(v, pairs);
  if (Array.isArray(v)) return v.map(x => remap(x, pairs));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x, pairs)]));
  return v;
}

/** the fixture `key` (built by build(root) -> JSON-able data, once per process) copied into dest (made if missing); returns the
 *  build's data with every template path rewritten to dest. build must put everything it makes under root. */
export function fromTemplate(key, build, dest) {
  let t = templates.get(key);
  if (!t) {
    // a short dir name: the recipe key (a JSON branch list) spelled out pushed git's object paths past Windows MAX_PATH under
    // ci-suite's per-file TEMP (CI 43518267986: "Filename too long", "'$GIT_DIR' too big") - a readable head + a hash of the key
    const slug = key.replace(/[^\w-]/g, '_').slice(0, 12), hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
    const root = mkTmp(`meta-gtpl-${slug}-${hash}-`);
    let data;
    try { data = build(root); }
    catch (e) { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); throw e; }
    // git init's hooks/*.sample files are inert (never run): not copying them keeps a copy to a few dozen files
    walk(root, (p, name) => { if (name.endsWith('.sample') && path.basename(path.dirname(p)) === 'hooks') fs.rmSync(p, { force: true }); });
    t = { root, data: data ?? {} };
    templates.set(key, t);
  }
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(t.root, dest, { recursive: true, preserveTimestamps: true });
  // the forms a path takes: git config escapes a backslash (\\), a worktree .git file has forward slashes, the data the native form
  // - and in git's spelling too: git writes a worktree's paths canonical (a Windows 8.3 short TEMP under RUNNER~1, comes
  // back long), so the template root as given would not match them (CI-RED-7E52345)
  const esc = p => p.split('\\').join('\\\\');
  const real = fs.realpathSync.native(t.root), realDest = fs.realpathSync.native(dest);
  const pairs = [[esc(t.root), esc(dest)], [t.root, dest], [fwd(t.root), fwd(dest)], [esc(real), esc(realDest)], [real, realDest], [fwd(real), fwd(realDest)]]
    .filter(([a], i, all) => all.findIndex(([b]) => b === a) === i);
  walk(dest, (p, name) => {
    if (!GIT_PATH_FILES.has(name)) return;
    const s = fs.readFileSync(p, 'utf8'), r = swap(s, pairs);
    // in place (r+): Git for Windows marks a worktree's .git file hidden, and opening a hidden file with 'w' is EPERM
    if (r !== s) { const fd = fs.openSync(p, 'r+'); try { fs.ftruncateSync(fd, 0); fs.writeSync(fd, r, 0, 'utf8'); } finally { fs.closeSync(fd); } }
  });
  return remap(t.data, pairs);
}
