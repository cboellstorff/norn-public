// META-DASH-ASYNC R1 (DEC-338): the request snapshot shared by the dash server and the libs its GET routes call. A request runs inside
// snap.run(newSnap(), ...); the files / stats / dirs it needs are read up front on fs.promises (prime*), so the libs' own small reads
// (readText / existsS / statS / readdirS) are memory lookups and a stalled syscall delays only its own request, never the event loop
// (Node docs, fs: the sync forms block the loop; the promise forms run on the libuv threadpool). Outside a snapshot (the CLI, a POST
// after its own write, a timer) every helper is the plain sync form.
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

export const snap = new AsyncLocalStorage();
export const newSnap = () => ({ folds: new Map(), files: new Map(), stats: new Map(), dirs: new Map(), marks: new Map() });
const key = p => path.resolve(String(p));
const bom = t => t.replace(/^\uFEFF/, '');
const store = (kind, p) => { const m = snap.getStore()?.[kind], k = key(p); return m?.has(k) ? { hit: true, v: m.get(k) } : { hit: false }; };

/** the text of p (BOM stripped), null when it is missing (ENOENT / EISDIR); a snapshot lookup when primed */
export function readText(p) {
  const s = store('files', p); if (s.hit) return s.v;
  try { return bom(fs.readFileSync(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT' || e.code === 'EISDIR' || e.code === 'ENOTDIR') return null; throw e; }
}
// A module that appends to a file in-process registers a marker (resolved path -> its mark, or undefined): readTextA keeps the mark
// taken BEFORE its read in the snapshot (the first one), so the module's reader can merge what landed after the read began (markOf).
// lib/chat.mjs: the thread lines of its write queue.
const markers = [];
export const addMarker = fn => { markers.push(fn); };
export const markOf = p => snap.getStore()?.marks?.get(key(p));
function markRead(k) {
  const m = snap.getStore()?.marks; if (!m || m.has(k)) return;
  for (const fn of markers) { const v = fn(k); if (v !== undefined) { m.set(k, v); return; } }
}
/** the async read (null when missing); the text lands in the snapshot */
export async function readTextA(p) {
  if (!p) return null;   // no path (a project without a file): missing
  const s = store('files', p); if (s.hit) return s.v;
  markRead(key(p));
  let t; try { t = bom(await fs.promises.readFile(p, 'utf8')); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'EISDIR' && e.code !== 'ENOTDIR') throw e; t = null; }
  snap.getStore()?.files.set(key(p), t);
  return t;
}
/** JSON of p, null when missing or not JSON */
export const readJsonS = p => { try { const t = readText(p); return t === null ? null : JSON.parse(t); } catch { return null; } };
/** fs.Stats of p or null; a snapshot lookup when primed */
export function statS(p) {
  const s = store('stats', p); if (s.hit) return s.v;
  try { return fs.statSync(p); } catch { return null; }
}
export async function statA(p) {
  if (!p) return null;
  const s = store('stats', p); if (s.hit) return s.v;
  const v = await fs.promises.stat(p).catch(() => null);
  snap.getStore()?.stats.set(key(p), v);
  return v;
}
export const existsS = p => statS(p) !== null;
export const existsA = async p => (await statA(p)) !== null;
/** readdir withFileTypes (Dirent[]), [] when missing; a snapshot lookup when primed */
export function readdirS(p) {
  const s = store('dirs', p); if (s.hit) return s.v;
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}
export async function readdirA(p) {
  if (!p) return [];
  const s = store('dirs', p); if (s.hit) return s.v;
  const v = await fs.promises.readdir(p, { withFileTypes: true }).catch(() => []);
  snap.getStore()?.dirs.set(key(p), v);
  return v;
}
/** prime many paths at once: { files, stats, dirs } (arrays of paths), concurrently */
export const prime = ({ files = [], stats = [], dirs = [] } = {}) =>
  Promise.all([...files.map(readTextA), ...stats.map(statA), ...dirs.map(readdirA)]);
/** a write inside a snapshot: the next lookup of p sees the new text, not the primed one */
export function forget(p) { const s = snap.getStore(); if (!s) return; const k = key(p); s.files.delete(k); s.stats.delete(k); s.dirs.delete(path.dirname(k)); }
