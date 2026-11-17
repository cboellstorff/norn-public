// Billing modes: how the Claude account Norn runs on is paid for, and so which usage guard applies (engine/presets/billing.json).
// - a plan (pro, max-5x, max-20x, ultra): a weekly limit. The weekly guard (weekly_stop_pct against the calibrated weekly %) and
//   the hourly rate cap hold new Claude work, as before. A plan mode also suggests the caps that fit the plan (Settings fills them).
// - api: pay per token, no weekly limit. The weekly guard and the rate cap are off (no calibration is asked for); the optional
//   api_usd_per_day cap holds new Claude work once the last 24 h of Claude runs on this machine cost that much.
// No billing key = a plan (the behaviour before billing modes existed).
// Spend = each ended Claude run's cost_usd, the Claude CLI's own figure (harness/claude.mjs), summed over every project's run log
// under the state root. A run still running counts once it ends; dashboard chats and own-account executors are not counted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets', 'billing.json');
const DATA = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, ''));
export const BILLING_MODES = Object.entries(DATA.modes).sort((a, b) => a[1].order - b[1].order).map(([name, m]) => ({ name, ...m }));
export const BILLING_NAMES = BILLING_MODES.map(m => m.name);
export const BILLING_DEFAULT = DATA.default;
export const DAY_MS = 24 * 3600000;

/** the mode entry of a budget (null = no billing key: treated as a plan) */
export const billingOf = B => BILLING_MODES.find(m => m.name === B?.billing) ?? null;
export const isApi = B => billingOf(B)?.type === 'api';
/** the daily $ cap of an API budget, or null (no cap) */
export const usdCap = B => { const n = Number(B?.api_usd_per_day); return B?.api_usd_per_day !== undefined && B?.api_usd_per_day !== null && B?.api_usd_per_day !== '' && Number.isFinite(n) && n > 0 ? n : null; };

export function billingMode(name) {
  const m = BILLING_MODES.find(x => x.name === name);
  if (!m) throw new Error(`unknown billing mode ${name} (known: ${BILLING_NAMES.join(', ')})`);
  return m;
}
/** the budget keys a mode sets: billing + its suggested caps (+ api_usd_per_day when given; 0 / 'off' = no cap) */
export function billingChanges(name, { usdPerDay } = {}) {
  const m = billingMode(name), ch = { billing: m.name, ...m.budget };
  if (usdPerDay !== undefined) {
    if (m.type !== 'api') throw new Error('a daily $ cap is for the api billing mode only');
    const off = usdPerDay === null || usdPerDay === 'off' || Number(usdPerDay) === 0;
    if (!off && !(Number(usdPerDay) > 0)) throw new Error(`--usd-per-day must be a number of dollars > 0, or off (got ${usdPerDay})`);
    ch.api_usd_per_day = off ? 0 : Number(usdPerDay);
  }
  return ch;
}
/** the dashboard's billing list: name, label, summary, type and the Settings changes it fills */
export const billingChoices = () => BILLING_MODES.map(m => ({ name: m.name, label: m.label, summary: m.summary, type: m.type, default: m.name === BILLING_DEFAULT, changes: billingChanges(m.name) }));

// ---------- spend: the Claude runs' cost_usd, from every project's runs.jsonl (cached per file on size + mtime) ----------
const cache = new Map();
function runCosts(file) {
  let st; try { st = fs.statSync(file); } catch { return []; }
  const c = cache.get(file);
  if (c && c.size === st.size && c.mtime === st.mtimeMs) return c.rows;
  const starts = new Map(), rows = [];
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  for (const line of text.split('\n')) {
    if (!line.includes('"kind":"run"')) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.ev === 'start' || r.ev === 'create') starts.set(r.id, r.data || {});
    else if (r.ev === 'end' && typeof r.data?.cost_usd === 'number') {
      const s = starts.get(r.id) || {};
      if (s.kind === 'provider') continue;   // an own-account executor: not billed to this Claude account
      rows.push({ id: r.id, at: Date.parse(r.ts), usd: r.data.cost_usd });
    }
  }
  cache.set(file, { size: st.size, mtime: st.mtimeMs, rows });
  return rows;
}
/** { usd, runs } of the Claude runs that ended in [since, now] in every project under stateRoot */
export function spendUsd(stateRoot, { since, now = Date.now() } = {}) {
  let usd = 0, runs = 0, dirs = [];
  try { dirs = fs.readdirSync(stateRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(stateRoot, d.name, 'runs.jsonl')); } catch { /* no state yet */ }
  for (const f of dirs) for (const r of runCosts(f)) if (r.at >= since && r.at <= now) { usd += r.usd; runs++; }
  return { usd: Math.round(usd * 100) / 100, runs };
}
export const spendDay = (stateRoot, now = Date.now()) => spendUsd(stateRoot, { since: now - DAY_MS, now });

/** null = may start; else why not (an API budget whose daily $ cap is reached). state: one project's state dir (its parent = the root) */
export function apiRefusal(B, state, { now = Date.now(), stateRoot } = {}) {
  const cap = usdCap(B);
  if (!isApi(B) || cap === null) return null;
  const s = spendDay(stateRoot ?? path.dirname(state), now);
  return s.usd >= cap ? `api spend $${s.usd.toFixed(2)} in 24 h >= cap $${cap.toFixed(2)}` : null;
}

// a queued run keeps a copy of the budget it was queued with (runs.mjs queue spec), so a billing change would not reach it: the
// usage keys of every queued spec under the state root are set to the new budget's (the other keys stay as queued)
export const USAGE_KEYS = ['billing', 'api_usd_per_day', 'weekly_stop_pct', 'usage_rate_cap_pct_per_h', 'desired_burn_pct_per_h'];
/** budget: the machine budget now in force -> the queued spec files changed */
export function refreshQueued(stateRoot, budget) {
  const changed = [];
  let dirs = []; try { dirs = fs.readdirSync(stateRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(stateRoot, d.name, 'runs')); } catch { return changed; }
  for (const d of dirs) {
    let files = []; try { files = fs.readdirSync(d).filter(f => f.endsWith('.queue.json')); } catch { continue; }
    for (const f of files) {
      const file = path.join(d, f);
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8')), b = { ...(j.budget || {}) };
        for (const k of USAGE_KEYS) if (budget[k] === undefined) delete b[k]; else b[k] = budget[k];
        if (JSON.stringify(b) === JSON.stringify(j.budget || {})) continue;
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ ...j, budget: b }, null, 2)); fs.renameSync(tmp, file);
        changed.push(file);
      } catch { /* a spec mid-write or gone: the next change reaches it */ }
    }
  }
  return changed;
}

/** one line in words: the mode and, for API billing, the last 24 h of spend against the cap */
export function billingLine(B, state, { now = Date.now(), stateRoot } = {}) {
  const m = billingOf(B);
  if (!m) return 'billing: not set (treated as a plan: the weekly guard applies)';
  if (m.type !== 'api') return `billing: ${m.label} (plan: the weekly guard applies)`;
  const s = spendDay(stateRoot ?? path.dirname(state), now), cap = usdCap(B);
  return `billing: API (pay per token, no weekly limit); api spend last 24 h $${s.usd.toFixed(2)} (${s.runs} run${s.runs === 1 ? '' : 's'})${cap === null ? '; no daily cap' : ` of the $${cap.toFixed(2)} daily cap${s.usd >= cap ? ' -> CAP REACHED: no new Claude work' : ''}`}`;
}
