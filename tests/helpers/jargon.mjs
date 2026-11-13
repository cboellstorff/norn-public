// META-OOTB-POLISH F-9: the owner's project vocabulary a newcomer must not meet in user-facing text. Executor ids (codex-astra) and
// key names (cacheR_per_pct) stay: they are data, written lower-case / snake_case, so the capitalised words below never match them.
import assert from 'node:assert/strict';
export const JARGON = /\b(Astra|Sol|CALIB|cacheR|QUIET|SPEED MODE|[Ss]peed mode|Fable|GT-[A-Z0-9-]+|DEC-\d+|OWNER a\d+)\b|\b[Dd]oors?\b|\b[a-z-]+\.ps1\b|codex-impl\.sh/;
export function jargonIn(where, text) {
  const m = String(text).match(JARGON), at = m?.index ?? 0;
  assert.equal(m, null, `${where}: "${m?.[0]}" in ${String(text).slice(Math.max(0, at - 60), at + 60)}`);
}
