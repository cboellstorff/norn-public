// META-Q-RECONCILE R1 (owner 11-13): an owner answer given anywhere closes the question. Pure functions over folded record items
// (no imports from records.mjs: records.mjs calls these inside its lock). Deterministic: text tests, no LLM.
// - write time: a decision that carries an owner pick / owner words on a lane with an OPEN question is refused unless it names the
//   Q (--answers) or says it is not an answer (--not-an-answer) - ownerPickGuard.
// - afterwards: an open Q with a later decision on its lane carrying owner words / OWNER PICK / the Q's evidence paths = a
//   "possibly answered by DEC-m" row (digest, dashboard Inbox) - possibleAnswers. The check-in closes it with
//   `norn rec answer Q-n --from DEC-m` or `norn rec not-an-answer DEC-m --q Q-n`.

export const OWNER_PICK_RE = /\bOWNER\s+PICK\b|\bowner\s+(?:verbatim|words|said|picked|answered)\b/i;
const QUOTED_RE = /\bowner\s+(?:verbatim|words|said)\s*:?\s*["“']([^"”']{1,2000})["”']/i;
const decText = d => [d?.question, d?.choice, d?.why].filter(x => typeof x === 'string').join('\n');

/** the owner's verbatim words a decision carries: data.owner_words, else a quote after "owner verbatim:" / "owner words:" / "owner said:" */
export function ownerWordsOf(dec) {
  const d = dec?.data ?? dec ?? {};
  if (typeof d.owner_words === 'string' && d.owner_words.trim()) return d.owner_words;
  const m = QUOTED_RE.exec(decText(d));
  return m ? m[1] : null;
}
/** does the decision data carry an owner pick (owner words, OWNER PICK, "owner verbatim ...")? */
export const carriesOwnerPick = d => !!(typeof d?.owner_words === 'string' && d.owner_words.trim()) || OWNER_PICK_RE.test(decText(d));

const FILE_RE = /[A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z][A-Za-z0-9]{1,4}\b/g;
/** the file names a question cites in its body / source (its evidence: sheets, notes) - basenames, deduped */
export function evidencePaths(q) {
  const t = [q?.data?.body, q?.data?.source].filter(x => typeof x === 'string').join('\n');
  return [...new Set([...t.matchAll(FILE_RE)].map(m => m[0]).filter(x => !/^(?:e\.g|i\.e)$/i.test(x)))];
}

/** the option key a decision's choice starts with ("C: ...", "(c) ...", "c - ..."), when the Q has that key; else undefined */
export function choiceKeyOf(q, dec) {
  const keys = (q?.data?.options || []).map(o => o.key);
  const m = /^\s*\(?([A-Za-z0-9]{1,8})\)?\s*(?:[:.)]|\s-\s)/.exec(String(dec?.data?.choice ?? ''));
  return m ? keys.find(k => k.toLowerCase() === m[1].toLowerCase()) : undefined;
}

const firstSeq = i => i.history?.[0]?.seq ?? 0;
const markedNot = (dec, qid) => dec.data?.not_an_answer === true || (dec.history || []).some(h => h.ev === 'notanswer' && h.data?.q === qid);

/** write-time check of a decision create (data d): the first open Q on its lane it would leave open, else null */
export function ownerPickGuard(items, d) {
  if (!d || d.not_an_answer === true || !carriesOwnerPick(d)) return null;
  const open = Object.values(items).filter(i => i.kind === 'question' && i.state === 'open' && i.data.lane === d.lane && i.id !== d.answers)
    .sort((a, b) => firstSeq(a) - firstSeq(b));
  return d.answers && items[d.answers]?.kind === 'question' ? null : open[0] || null;
}

/** [{ q, dec, words, why }]: each open Q with a later decision on its lane that may hold its answer (the earliest such DEC) */
export function possibleAnswers(itemsIn) {
  const items = Array.isArray(itemsIn) ? itemsIn : Object.values(itemsIn);
  const decs = items.filter(i => i.kind === 'decision' && i.state === 'in-force').sort((a, b) => firstSeq(a) - firstSeq(b));
  const out = [];
  for (const q of items.filter(i => i.kind === 'question' && i.state === 'open').sort((a, b) => firstSeq(a) - firstSeq(b))) {
    const ev = evidencePaths(q);
    for (const dec of decs) {
      if (dec.data.lane !== q.data.lane || firstSeq(dec) <= firstSeq(q) || markedNot(dec, q.id)) continue;
      if (dec.data.answers && dec.data.answers !== q.id) continue;
      const words = ownerWordsOf(dec), text = decText(dec.data);
      const why = words ? 'owner words' : OWNER_PICK_RE.test(text) ? 'OWNER PICK' : ev.find(p => text.includes(p)) ? `evidence ${ev.find(p => text.includes(p))}` : null;
      if (!why) continue;
      out.push({ q: q.id, dec: dec.id, words, why, lane: q.data.lane });
      break;
    }
  }
  return out;
}
