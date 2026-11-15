// META-AUTH-VENDOR: "is the vendor down right now" - the open incident on the executor vendor's public status page (executors
// AUTH_PATTERNS .status = { vendor, url }: Statuspage JSON, an incidents list). Read synchronously (the tick / doctor / dashboard
// paths are sync) by a child node with a short timeout; never sends a credential (no headers, no cookies, a bare env); the answer
// is cached machine-wide in <state home>/vendor-status.json for STATUS_TTL_MS so a tick storm is one request. A failed read = no
// incident known (the notice then says so); it never fails the caller.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonS } from './fsnap.mjs';
import { spawnSync } from 'node:child_process';
import { authPatterns } from './executors.mjs';

export const STATUS_TIMEOUT_MS = 5000;
export const STATUS_TTL_MS = 5 * 60000;
const DONE = new Set(['resolved', 'postmortem', 'completed']);

/** The status source of `harness` ({ vendor, url }) or null (none known: the fake, grok, a typed row without one). */
export function statusSource(harness, entry) {
  const s = authPatterns(harness, entry)?.status;
  return s?.url ? s : null;
}

// the child: a plain GET (fetch sends no cookies and, here, no auth header), the body on stdout, nothing on failure
const CHILD = `const u=process.argv[1],t=Number(process.argv[2]);fetch(u,{headers:{accept:'application/json'},redirect:'follow',signal:AbortSignal.timeout(t)})`
  + `.then(r=>r.ok?r.text():'').then(b=>process.stdout.write(b),()=>{}).finally(()=>process.exit(0));`;

/** GET `url` as JSON within timeoutMs (sync, a child process); null on any failure. */
export function fetchStatusJson(url, { timeoutMs = STATUS_TIMEOUT_MS } = {}) {
  try {
    const env = { PATH: process.env.PATH || '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
    const r = spawnSync(process.execPath, ['-e', CHILD, url, String(timeoutMs)], { encoding: 'utf8', timeout: timeoutMs + 2000, windowsHide: true, env });
    return r.stdout ? JSON.parse(r.stdout) : null;
  } catch { return null; }
}

/** The first open incident of a Statuspage incidents answer -> { name, since } (since = started_at | created_at), else null. */
export function openIncident(json) {
  const open = (Array.isArray(json?.incidents) ? json.incidents : []).filter(i => i && !i.resolved_at && !DONE.has(String(i.status || '').toLowerCase()));
  if (!open.length) return null;
  const at = i => i.started_at || i.created_at || null;
  const i = open.slice().sort((a, b) => String(at(a)).localeCompare(String(at(b))))[0];
  return { name: String(i.name || 'an unnamed incident'), since: at(i) };
}

export const cacheFile = state => path.join(path.dirname(path.resolve(state)), 'vendor-status.json');
function readCache(state) { return readJsonS(cacheFile(state)) || {}; }   // META-DASH-ASYNC R1: snapshot-aware (the dash primes cacheFile)

/**
 * The open incident of `harness`'s vendor ({ name, since } | null). o: { now, source (default statusSource(harness)), ttlMs,
 * cacheOnly (a view: the last answer only, never a request), fetch (url -> json | null; default fetchStatusJson) }.
 */
export function vendorIncident(state, harness, { now = Date.now(), source = statusSource(harness), ttlMs = STATUS_TTL_MS, cacheOnly = false, fetch = fetchStatusJson } = {}) {
  if (!source?.url) return null;
  const all = readCache(state), c = all[harness];
  if (c && c.url === source.url && (cacheOnly || now - Date.parse(c.at) < ttlMs)) return c.incident ?? null;
  if (cacheOnly) return null;
  const j = fetch(source.url);
  const incident = j ? openIncident(j) : null;
  try {
    all[harness] = { at: new Date(now).toISOString(), url: source.url, ok: !!j, incident };
    const f = cacheFile(state), t = `${f}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(t, JSON.stringify(all, null, 1));
    fs.renameSync(t, f);
  } catch { /* a cache that cannot be written only costs a request */ }
  return incident;
}
