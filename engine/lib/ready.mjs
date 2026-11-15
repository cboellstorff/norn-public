// The Ready lines of a brief (META-DOD 1): Scope: / Tests: / Done:, and whether a path is inside Scope. A leaf module: the Ready
// gate (dod.mjs) and the run scope guard (scope.mjs, META-DOD 2) both read it.
const KEYS = ['Scope', 'Tests', 'Done'];
const fwd = p => String(p).replace(/\\/g, '/');
/** a Ready-line word without its quotes / backticks / trailing punctuation */
export const clean = w => w.replace(/^[`'"(]+|[`'")]+$/g, '').replace(/[.,;:]+$/, '').replace(/[`'")]+$/, '');

/** the Ready lines of a brief text: { scope: [path | glob], tests, done, missing: ['Tests:', ..] } (first line of each key wins) */
export function parseReady(text) {
  const got = {};
  for (const l of String(text ?? '').split(/\r?\n/)) {
    const m = l.match(/^\s*(?:[-*]\s+)?(Scope|Tests|Done):[ \t]*(.*?)\s*$/);
    if (m && !(m[1] in got)) got[m[1]] = m[2];
  }
  const scope = (got.Scope ?? '').split(/[\s,]+/).map(clean).filter(Boolean);
  const missing = KEYS.filter(k => !(k === 'Scope' ? scope.length : (got[k] ?? '').trim())).map(k => k + ':');
  return { scope, tests: got.Tests ?? null, done: got.Done ?? null, missing };
}

const globRe = g => new RegExp('^' + g.split(/(\*\*\/|\*\*|\*|\?)/).map(t => t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : t === '?' ? '[^/]'
  : t.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('') + '$');
/** a repo-relative path inside Scope: a glob (** / * / ?) matches it, a bare entry = that file or every path under that folder */
export function inScope(p, scope) {
  const f = fwd(p);
  return scope.some(s => { const g = fwd(s).replace(/^\.\//, '').replace(/\/+$/, ''); return /[*?]/.test(g) ? globRe(g).test(f) : f === g || f.startsWith(g + '/'); });
}
