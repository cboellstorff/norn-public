// CHECKIN-V2 piece 0 (GT-PARITY-PLAN sec. 0 FINDING): ONE home for "may this run start now on the account's usage" - the weekly
// guard (budget.weekly_stop_pct vs STATUS "estimated weekly now") and the usage-rate cap (STATUS RATE_OK, when the budget has a
// cap). The queue fill applies both to every run on the Claude account (a MERGE stage is exempt from RATE_OK only: NORN-WATCH S4,
// DEC-688); the HANDOFF auto-resume applies the guard (supervisor.mjs, its rule since S1). An unknown value refuses (fail closed).
import fs from 'node:fs';
import path from 'node:path';

export const isMergeStage = stage => String(stage ?? '').toUpperCase() === 'MERGE';
// a run on the Claude account = one the Claude worker cap counts (executors.BUILTIN claude / fake); typed executors have their own
export const onAccount = info => (info?.caps || []).includes('max_claude_workers');

/** null = may start; else the reason it may not. spec: a run spec { budget, stage, statusFile }; rate: false = the guard only. */
export function usageRefusal(spec, state, { rate = true } = {}) {
  const B = spec?.budget || {};
  const wantGuard = typeof B.weekly_stop_pct === 'number';
  const wantRate = rate && typeof B.usage_rate_cap_pct_per_h === 'number' && !isMergeStage(spec.stage);
  if (!wantGuard && !wantRate) return null;
  let txt = '';
  try { txt = fs.readFileSync(spec.statusFile || path.join(state, 'STATUS.md'), 'utf8'); } catch { /* unknown below */ }
  if (wantGuard) {
    const m = txt.match(/estimated weekly now ~([\d.]+) %/);
    if (!m) return 'weekly unknown';
    if (Number(m[1]) >= B.weekly_stop_pct) return `weekly ${m[1]} % >= guard ${B.weekly_stop_pct} %`;
  }
  if (wantRate) {
    const m = txt.match(/^RATE_OK=([01])\b/m);
    if (!m) return 'RATE_OK unknown';
    if (m[1] === '0') return 'RATE_OK=0';
  }
  return null;
}
