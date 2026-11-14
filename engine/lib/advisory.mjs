// META-TEND P1: the ONE advisory record - every finding of every TEND phase (instruction files, memory, usage, tests, rules) has this
// shape, and every fix is an approval card (REPORT s.3.7, s.5.0-5.1): nothing edits a steering file, memory, test or hook by itself.
//
// { id 'A-<sha10>' (stable: the same finding keeps its id), phase, check (the REPORT 3.2 number, or a phase's own key), key (a short
//   machine name), severity high | medium | low | count, surface (what it is about: "memory index", "CLAUDE.local.md", ...),
//   path | null, line | null, why (ONE plain-English line), source (where the rule comes from), items? [{ line?, text, path? }] (the
//   lines of an aggregated finding), fix { tier, action, patch? }, row? (the id of the row it sits on in its tab), other? (the path of the
//   second side of a conflict) }. The id hashes phase, key, path and subject - or the line when there is no subject (a finding with a
//   subject keeps its id when lines move above it).
// fix.tier: tap = an exact mechanical patch (one tap applies it); card = a hunk to read (judgment); flag = flag only (risky: a
// prohibition, a user-level file, anything outside the project). first_seen / new: crossings() - only a NEW crossing warns.
// Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SEVERITIES = ['high', 'medium', 'low', 'count'];
export const TIERS = ['tap', 'card', 'flag'];
export const TIER_LABEL = { tap: 'one tap, exact patch', card: 'card with a hunk to read', flag: 'flag only' };
const NEW_MS = 24 * 3600000;

/** one advisory record (validated; throws on a bad shape - a check bug, never data) */
export function advisory({ phase = 'P1', check, key, severity, surface, path: file = null, line = null, why, source, items, fix, subject = '', row, other }) {
  if (!key || !/^[a-z][a-z0-9-]*$/.test(key)) throw new Error(`advisory: key ${JSON.stringify(key)} is not a short machine name`);
  if (!SEVERITIES.includes(severity)) throw new Error(`advisory ${key}: severity ${JSON.stringify(severity)} (${SEVERITIES.join(' | ')})`);
  if (!why || /\n/.test(why) || why.length > 300) throw new Error(`advisory ${key}: why must be one line of at most 300 characters`);
  if (!source) throw new Error(`advisory ${key}: no source`);
  if (!fix || !TIERS.includes(fix.tier) || !fix.action) throw new Error(`advisory ${key}: fix needs a tier (${TIERS.join(' | ')}) and an action`);
  if (fix.tier === 'tap' && !fix.patch) throw new Error(`advisory ${key}: a one-tap fix carries its exact patch`);
  const id = 'A-' + createHash('sha1').update([phase, key, String(file ?? '').toLowerCase(), subject ? '' : line ?? '', subject].join('|')).digest('hex').slice(0, 10);
  return { id, phase, check: check ?? null, key, severity, surface, path: file, line, why, source, ...(items?.length ? { items } : {}),
    fix: { tier: fix.tier, action: fix.action, ...(fix.patch ? { patch: fix.patch } : {}) }, ...(row ? { row } : {}), ...(other ? { other } : {}) };
}

/**
 * first_seen per advisory id (<state>/advisory/seen.json) -> the list with first_seen and new (first seen in the last 24 h): only a
 * new crossing warns. Without a state nothing is stored and nothing is new.
 */
export function crossings(state, list, now = Date.now()) {
  if (!state) return list.map(a => ({ ...a, first_seen: null, new: false }));
  const f = path.join(state, 'advisory', 'seen.json');
  let seen; try { seen = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { seen = {}; }
  let dirty = false;
  const iso = new Date(now).toISOString();
  const out = list.map(a => { if (!seen[a.id]) { seen[a.id] = iso; dirty = true; } return { ...a, first_seen: seen[a.id], new: now - Date.parse(seen[a.id]) < NEW_MS }; });
  if (dirty) { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(seen)); fs.renameSync(tmp, f); }
  return out;
}
