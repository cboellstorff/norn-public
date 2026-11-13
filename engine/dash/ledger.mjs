// Ledger tab (LEDGER-UX R1): one ledger line -> one entry. Pure; the same module runs in the browser (/ledger.mjs) and in node --test.
// Shapes: "- meta <ISO>Z[ minor]: body" (check-in / minor), "- auto <ISO>Z: body", "- <label> <ISO>Z: body" (controller session);
// any other line (headings, prose) is kind "other" and renders as markdown. The body splits at top-level "; " into clauses:
// the first is the headline, later ones are sub-lines, labelled when they start "<words>: " or with a known label word.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ENTRY = /^- ([A-Za-z][\w.-]*) (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)( minor)?:\s?(.*)$/;
export const LEDGER_KINDS = ['check-in', 'minor', 'auto', 'controller', 'other'];
// later clauses the check-ins write as "<word> <rest>" with no colon (rate 1.2 %/h, records none new, digest 1 empty, ...)
const LABEL_WORDS = new Set(['rate', 'records', 'digest', 'band', 'dispatched', 'live', 'next', 'usage', 'ci']);

/** Split at "; " outside (), [], {} and `code`. */
export function splitClauses(body) {
  const out = []; let depth = 0, code = false, cur = '';
  const s = String(body ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '`') code = !code;
    else if (!code && '([{'.includes(c)) depth++;
    else if (!code && ')]}'.includes(c)) depth = Math.max(0, depth - 1);
    if (c === ';' && s[i + 1] === ' ' && !depth && !code) { out.push(cur.trim()); cur = ''; i++; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

function sub(clause) {
  const m = clause.match(/^([a-z][\w-]*(?: [a-z][\w-]*){0,2}):\s+(.+)$/);
  if (m) return { label: m[1], text: m[2] };
  const w = clause.match(/^([a-z]+) (.+)$/);
  if (w && LABEL_WORDS.has(w[1])) return { label: w[1], text: w[2] };
  return { label: null, text: clause };
}

/** line -> { kind, label, ts, headline, subs: [{ label, text }], raw } */
export function parseLedgerLine(line) {
  const raw = String(line ?? ''), m = raw.match(ENTRY);
  if (!m) return { kind: 'other', label: null, ts: null, headline: raw, subs: [], raw };
  const [, label, ts, minor, body] = m;
  const kind = label === 'meta' ? (minor ? 'minor' : 'check-in') : label === 'auto' ? 'auto' : 'controller';
  const [headline = '', ...rest] = splitClauses(body);
  return { kind, label, ts, headline, subs: rest.map(sub), raw };
}

/** lines (file order) -> entries (file order), blank lines dropped */
export const parseLedger = lines => (lines || []).filter(l => String(l ?? '').trim()).map(parseLedgerLine);

// record ids, short shas (7-12 hex with a digit and a letter); `code` spans are taken first
const TOKEN = /`([^`]+)`|\b(?:(DEC|DIR|Q|RUN|DLV|EP|RM)-(\d+))\b|\b([0-9a-f]{7,12})\b/g;
const isSha = s => /\d/.test(s) && /[a-f]/.test(s);
// o.rec (Records text): also paths (2+ slashes, an extension or a drive) and "->" arrows
const TOKEN_REC = new RegExp(TOKEN.source + String.raw`|(?<![\w/.-])((?:[A-Za-z]:)?(?:[\w.-]+\/)+[\w.-]*[\w-])|(->)`, 'g');
const isPath = s => /^[A-Za-z]:\//.test(s) || (s.match(/\//g) || []).length >= 2 || /\.[A-Za-z]\w{0,4}$/.test(s);
/** text -> safe HTML: DEC / DIR jump to the Records row, Q to the Inbox, RM to the Roadmap row, RUN to Agents when o.runs has it, DLV opens the drawer. */
export function ledgerInline(text, o = {}) {
  const s = String(text ?? ''), runs = o.runs instanceof Set ? o.runs : new Set(o.runs || []);
  let out = '', at = 0;
  for (const m of s.matchAll(o.rec ? TOKEN_REC : TOKEN)) {
    const [all, code, k, n, sha, p, arr] = m;
    let h;
    if (code !== undefined) h = `<code>${esc(code)}</code>`;
    else if (k) {
      const id = `${k}-${n}`, cls = `rid r-${k.toLowerCase()}`;
      h = k === 'DEC' || k === 'DIR' ? `<a class="${cls}" href="#rec-${id}" data-rid="${id}">${id}</a>`
        : k === 'Q' ? `<a class="${cls}" href="#q-${id}" data-rid="${id}">${id}</a>`
        : k === 'RM' ? `<a class="${cls}" href="#rm-${id}" data-rid="${id}">${id}</a>`   // META-ROADMAP S2: the Roadmap row
          : k === 'RUN' && runs.has(id) ? `<a class="${cls}" href="#node-${id}" data-rid="${id}">${id}</a>`
            : k === 'DLV' ? `<a class="${cls}" href="#" data-dlv="${id}"${o.project ? ` data-project="${esc(o.project)}"` : ''}>${id}</a>`
              : `<span class="id">${id}</span>`;
    } else if (sha && isSha(sha)) h = `<span class="sha">${sha}</span>`;
    else if (p && isPath(p)) h = `<span class="path">${esc(p)}</span>`;
    else if (arr) h = '<span class="arr">→</span>';
    else continue;
    out += esc(s.slice(at, m.index)) + h; at = m.index + all.length;
  }
  return out + esc(s.slice(at));
}

// ---------- Records text (RECORDS-TEXT R1): directive text / decision question, choice, why in the Ledger look ----------
// "OWNER a14 2026-10-30 ~20:15Z:" / "Owner 11-11 ~23:30Z (chat):" / "Owner 11-10 (amends DIR-93):" / "..., on the x note (..):"
const META = /^((?:OWNER|Owner)(?: [a-z]\d+)? (?:\d{4}-)?\d{2}-\d{2}(?: ~?\d{1,2}:\d{2}(?:Z| [A-Z]{2,4})?)?(?: \([^()]*\))?(?:, [^:'"]*)?):\s+/;
// a quote closes at its mark when no word character follows ("it's" stays inside)
function takeQuote(s) {
  const q = s[0];
  for (let i = 1; i < s.length; i++) if (s[i] === q && !/\w/.test(s[i + 1] ?? '')) return [s.slice(1, i), s.slice(i + 1)];
  return null;
}
// top-level "(1) .. (2) .." markers in sequence (outside parens / `code`); fewer than two = no list
function splitItems(s) {
  const marks = []; let depth = 0, code = false, want = 1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '`') { code = !code; continue; }
    if (code) continue;
    if (c === '(') {
      const m = !depth && (i === 0 || /[\s:;,.]/.test(s[i - 1])) ? s.slice(i).match(/^\((\d{1,2})\)\s/) : null;
      if (m && Number(m[1]) === want) { marks.push([i, m[0].length]); want++; i += m[0].length - 1; continue; }
      depth++;
    } else if ('[{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
  }
  if (marks.length < 2) return { pre: s, items: [] };
  const trim = t => t.trim().replace(/[\s;,+]+$/, '');
  return { pre: trim(s.slice(0, marks[0][0])), items: marks.map(([at, n], k) => trim(s.slice(at + n, marks[k + 1]?.[0] ?? s.length))) };
}
/** text -> { meta, quotes: [], head, subs: [{ label, text }], items: [] } */
export function parseRecordText(text) {
  let s = String(text ?? '').trim(), meta = null; const quotes = [];
  const m = s.match(META);
  if (m) {
    meta = m[1]; s = s.slice(m[0].length);
    for (let q; /^['"]/.test(s) && (q = takeQuote(s));) {
      quotes.push(q[0]); s = q[1];
      const more = s.match(/^\s*\+\s*(?=['"])/); if (!more) break; s = s.slice(more[0].length);
    }
    s = s.replace(/^[\s.]+/, '');
  }
  const { pre, items } = splitItems(s);
  const [head = '', ...rest] = splitClauses(pre.replace(/[\s;,]+$/, ''));
  return { meta, quotes, head, subs: rest.map(sub), items };
}
const lineCount = (t, cpl) => Math.max(1, Math.ceil(String(t).length / cpl));
/** text -> { html, lines }: muted meta line, quotes, headline + clause lines, list; lines = a rough rendered-line estimate at o.cpl chars */
export function recordBlocks(text, o = {}) {
  const p = parseRecordText(text), cpl = o.cpl || 100, inl = t => ledgerInline(t, { ...o, rec: true });
  let html = '', lines = 0;
  if (p.meta) { html += `<div class="rmeta">${esc(p.meta)}</div>`; lines++; }
  for (const q of p.quotes) { html += `<blockquote class="rquote">${inl(q)}</blockquote>`; lines += lineCount(q, cpl); }
  if (p.head) { html += `<div class="ledhead">${inl(p.head)}</div>`; lines += lineCount(p.head, cpl); }
  for (const x of p.subs) { html += `<div class="ledsub">${x.label ? `<b>${esc(x.label)}</b> ` : ''}${inl(x.text)}</div>`; lines += lineCount(x.text, cpl); }
  if (p.items.length) { html += `<ol class="rlist">${p.items.map(t => `<li>${inl(t)}</li>`).join('')}</ol>`; lines += p.items.reduce((n, t) => n + lineCount(t, cpl), 0); }
  return { html, lines };
}
