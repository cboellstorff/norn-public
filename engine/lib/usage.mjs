// Usage (META-GENERAL-DESIGN 6, 12-S5): Claude cacheR from transcripts, the port of usage/tokens.js with a byte-offset cache
// (only appended bytes are parsed on the next call), plus the no-persistence result jsons status.ps1 adds. Node built-ins only.
// Semantics = tokens.js: files with mtime >= since, records with timestamp >= since, dedupe on message.id + requestId.
import fs from 'node:fs';
import path from 'node:path';

const CACHE_V = 1;
function loadCache(file) {
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.v === CACHE_V) return c; } catch { /* none / torn */ }
  return { v: CACHE_V, files: {} };
}
function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (p.endsWith('.jsonl')) out.push(p); }
  return out;
}
// Claude-plan traffic: a claude-* model, a synthetic message or none recorded; any other model came from a provider endpoint
export const claudePlan = model => typeof model !== 'string' || !model || model.startsWith('claude') || model.startsWith('<');
// parse complete lines of buf; entries = [tMs, key, cacheR]; unknown record types / fields ignored (design 13: tolerant reader)
function parse(buf, entries) {
  const nl = buf.lastIndexOf(10);
  if (nl < 0) return 0;
  for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) {
    if (!line.includes('"usage"')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const m = j.message;
    if (!m || !m.usage || !j.timestamp) continue;
    if (!claudePlan(m.model)) continue;  // a claude-compatible provider run (GLM / Kimi ...) bills its own account (META-EXEC-S1)
    const t = Date.parse(j.timestamp);
    if (Number.isNaN(t)) continue;
    entries.push([t, m.id + ':' + (j.requestId || ''), m.usage.cache_read_input_tokens || 0]);
  }
  return nl + 1;
}

/** cacheR summed over transcripts under projectsDir since sinceMs. Returns { cr, bytesRead, files }. */
export function cacheRSince(projectsDir, sinceMs, { cacheFile } = {}) {
  const cache = cacheFile ? loadCache(cacheFile) : { v: CACHE_V, files: {} };
  let bytesRead = 0, files = 0;
  const seen = new Set();
  let cr = 0;
  for (const f of walk(projectsDir)) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < sinceMs) continue;
    files++;
    let c = cache.files[f];
    if (!c || st.size < c.offset) c = cache.files[f] = { offset: 0, entries: [] };
    if (st.size > c.offset) {
      const fd = fs.openSync(f, 'r');
      try {
        const buf = Buffer.alloc(st.size - c.offset);
        const n = fs.readSync(fd, buf, 0, buf.length, c.offset);
        const used = parse(buf.subarray(0, n), c.entries);
        c.offset += used; bytesRead += used;
      } finally { fs.closeSync(fd); }
    }
    for (const [t, k, v] of c.entries) { if (t < sinceMs || seen.has(k)) continue; seen.add(k); cr += v; }
  }
  if (cacheFile) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, cacheFile);
  }
  return { cr, bytesRead, files };
}

// "dir/prefix-*.json" (one * in the file name) -> files; result jsons (claude -p --output-format json) with mtime >= since
function globFiles(pattern) {
  const dir = path.dirname(pattern), base = path.basename(pattern);
  const [pre, post = ''] = base.split('*');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => base.includes('*') ? n.startsWith(pre) && n.endsWith(post) && n.length >= pre.length + post.length : n === base).map(n => path.join(dir, n));
}
export function jsonCacheRSince(patterns = [], sinceMs) {
  let cr = 0;
  for (const p of patterns) for (const f of globFiles(p)) {
    try {
      if (fs.statSync(f).mtimeMs < sinceMs) continue;
      cr += Number(JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')).usage?.cache_read_input_tokens) || 0;
    } catch { /* torn / not a result json */ }
  }
  return cr;
}
