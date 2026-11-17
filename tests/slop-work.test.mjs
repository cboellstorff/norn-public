// Slop > In progress (lib/fixwork.mjs): a Fix all send followed through its steps (sent -> fixer -> your review -> applying -> done), the
// fixer's result card (its drafted hunks; apply all / decline / one by one through POST /api/fixall-review), one Inbox row per send
// that waits for review. And Context > Per file: the worst offenders with advice. Sandbox only: temp dirs and the shared dash fixture.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { fixWork, fixerRuns, applyText } from '../engine/lib/fixwork.mjs';
import { auditHunks } from '../engine/lib/audit.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { guardSummary, guardPart } from '../engine/dash/guardparts.mjs';
import { fileAdvice, worstFiles, perDay, FILE_BUDGET } from '../engine/dash/insparts.mjs';
import { fixture } from './helpers/dash-fixture.mjs';

after(cleanTmp);
const NOTES = file => `# DIR-2 docs fixer: draft hunks (DEC-1, fix all)

## Draft hunks

#### 1. \`${file}:2\` - medium - A-1 - remove

\`\`\`diff
--- a/${file}
+++ b/${file}
@@ -2,1 +2,0 @@ F1
-an old line
\`\`\`

#### 2. \`${file}:5\` - low - A-2 - rewrite

\`\`\`diff
--- a/${file}
+++ b/${file}
@@ -5,1 +5,1 @@ F2
-a wordy line
+a short line
\`\`\`

## DONE
`;
/** a project state with one Fix all send (DEC + DIR); fixer: none | running | done (its notes hold 2 hunks) */
function sendState(fixer = 'none') {
  const state = mkTmp('slopwork-'), root = mkTmp('slopwork-root-'), file = path.join(root, 'CLAUDE.md').replace(/\\/g, '/');
  fs.writeFileSync(file, 'a\nan old line\nb\nc\na wordy line\n');
  const by = 'dashboard', o = { views: false };
  const dec = record(state, { kind: 'decision', ev: 'create', by, data: { lane: 'fixall', question: 'Fix all on p: 2 finding(s)', choice: 'send the fixer', why: 'w', findings: ['A-1', 'A-2'] } }, o);
  const dir = record(state, { kind: 'directive', ev: 'create', by, data: { text: `Fix all (${dec.id}): start ONE fixer run`, via: 'dashboard', findings: ['A-1', 'A-2'], fixall: dec.id } }, o);
  let run = null;
  if (fixer !== 'none') {
    const brief = path.join(state, 'brief.md'), notes = path.join(state, 'NOTES.md');
    fs.writeFileSync(brief, `# ${dir.id} docs fixer (${dec.id}: fix all)\nDraft every change.\n`);
    fs.writeFileSync(notes, NOTES(file).replace('DIR-2', dir.id).replace('DEC-1', dec.id));   // the fixer's notes name its own send
    run = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'docs-fixer', brief, notes, worktree: root } }, o).id;
    if (fixer === 'done') record(state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data: { exit: 0, outcome: 'done' } }, o);
  }
  return { state, root, file, dec: dec.id, dir: dir.id, run, p: { state, root, name: 'p' } };
}

test('fixWork: a send moves sent -> fixer -> your review -> applying -> done, with one line saying what it waits for', () => {
  const a = sendState('none'), wa = fixWork(a.p, loadState(a.state).items);
  assert.equal(wa.sends.length, 1);
  assert.deepEqual([wa.sends[0].step, wa.sends[0].n, wa.sends[0].directive], ['sent', 2, a.dir]);
  assert.match(wa.sends[0].line, /waiting for the next check-in/);
  const b = sendState('running'), wb = fixWork(b.p, loadState(b.state).items).sends[0];
  assert.deepEqual([wb.step, wb.run], ['fixer', b.run]); assert.match(wb.line, /is drafting/);
  const c = sendState('done'), items = loadState(c.state).items, wc = fixWork(c.p, items).sends[0];
  assert.equal(fixerRuns(items, { id: c.dec, directive: c.dir, created: items[c.dec].created }).length, 1, 'the fixer is found by its brief naming the directive');
  assert.deepEqual([wc.step, wc.counts.hunks, wc.counts.open], ['review', 2, 2]);
  assert.equal(fixWork(c.p, items).counts.review, 2);
  // the owner applies one and keeps one: applying; the check-in marks the directive done: done
  const [h1, h2] = auditHunks(items[c.run], c.p, items);
  record(c.state, { kind: 'decision', ev: 'create', by: 'dashboard', data: { lane: 'audit', advisory: h1.id, question: 'q', choice: 'accepted: apply the hunk', why: 'w' } }, { views: false });
  record(c.state, { kind: 'decision', ev: 'create', by: 'dashboard', data: { lane: 'audit', advisory: h2.id, question: 'q', choice: 'declined: keep the text', why: 'w' } }, { views: false });
  const wd = fixWork(c.p, loadState(c.state).items).sends[0];
  assert.deepEqual([wd.step, wd.counts.accepted, wd.counts.declined], ['applying', 1, 1]);
  record(c.state, { kind: 'directive', ev: 'done', id: c.dir, by: 'checkin', data: { refs: [c.run] } }, { views: false });
  assert.equal(fixWork(c.p, loadState(c.state).items).sends[0].step, 'done');
  // the apply text names each hunk with its patch and asks for the send's directive to be marked done
  const t = applyText({ id: c.dec, directive: c.dir }, items[c.run], [h1, h2]);
  assert.match(t, new RegExp(`Apply 2 drafted change\\(s\\) of Fix all ${c.dec}[^]*mark ${c.dir} done[^]*${h1.id}[^]*an old line[^]*${h2.id}`));
});

test('the In progress page: a step track, the result card with Apply all (n), Decline all and one button pair per change; nothing in progress says so', () => {
  const c = sendState('done'), work = fixWork(c.p, loadState(c.state).items, { holds: [{ branch: 'norn/p/x', run: 'RUN-9', lane: 'x', blocks: [1] }] });
  const g = { project: 'p', rows: [], work, pending: false, slop: true, voice: {} }, s = guardSummary(g);
  assert.equal(s.counts.work, 2, 'the sub-view count = sends in progress + holds');
  const html = renderTab('slop', { ...s, sub: 'work', limit: 40, ...guardPart(g, 'work'), parts_loading: false }, { project: 'p' });
  assert.match(html, /class="fxtrack"[^]*✓ Sent[^]*✓ Fixer run[^]*class="now">Your review/);
  assert.match(html, /<button class="primary" data-act="fxr" data-verdict="accept" data-send="DEC-1">Apply all 2<\/button>/);
  assert.match(html, /data-act="fxr" data-verdict="decline" data-send="DEC-1">Decline all/);
  assert.equal((html.match(/data-act="fxr" data-verdict="accept" data-send="DEC-1" data-ids=/g) || []).length, 2, 'one Apply this one per change');
  assert.match(html, /an old line/, 'the change itself is shown');
  assert.match(html, /id="slop-holds"[^]*norn\/p\/x/);
  const empty = { project: 'p', rows: [], work: { sends: [], holds: [], counts: { live: 0, review: 0, holds: 0, done: 0 } }, pending: false, slop: true, voice: {} };
  assert.match(renderTab('slop', { ...guardSummary(empty), sub: 'work', limit: 40, ...guardPart(empty, 'work'), parts_loading: false }, { project: 'p' }), /Nothing is being worked on for slop/);
});

test('POST /api/fixall-review: apply all = one decision per change + ONE directive; the Inbox row goes; a second tap is refused', { timeout: 240000 }, async () => {
  const f = await fixture();
  try {
    const S = f.pa.state, root = f.pa.root, file = path.join(root, 'CLAUDE.md').replace(/\\/g, '/');
    const dec = record(S, { kind: 'decision', ev: 'create', by: 'dashboard', data: { lane: 'fixall', question: 'Fix all', choice: 'send', why: 'w', findings: ['A-1', 'A-2'] } }, { views: false });
    const dir = record(S, { kind: 'directive', ev: 'create', by: 'dashboard', data: { text: `Fix all (${dec.id})`, via: 'dashboard', findings: ['A-1', 'A-2'], fixall: dec.id } }, { views: false });
    const brief = path.join(S, 'fixer-brief.md'), notes = path.join(S, 'fixer-NOTES.md');
    fs.writeFileSync(brief, `# ${dir.id} docs fixer (${dec.id}: fix all)\n`); fs.writeFileSync(notes, NOTES(file).replace(/DIR-2|DEC-1/g, m => (m.startsWith('DIR') ? dir.id : dec.id)));
    const run = record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'docs-fixer', brief, notes, worktree: root } }, { views: false });
    record(S, { kind: 'run', ev: 'end', id: run.id, by: 'launcher', data: { exit: 0, outcome: 'done' } }, { views: false });
    const inbox = async () => (await f.get('/api/inbox?project=kestrel')).data.items.filter(i => i.type === 'fixall');
    assert.deepEqual((await inbox()).map(i => [i.id, i.n]), [[dec.id, 2]], 'one Inbox row for the send');
    const r = await f.post('/api/fixall-review', { project: 'kestrel', send: dec.id, verdict: 'accept' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual([r.data.decided, r.data.verdict], [2, 'accept']);
    const items = loadState(S).items, d = items[r.data.directive];
    assert.equal(d.data.fixall_apply, dec.id); assert.equal(d.data.hunks.length, 2);
    assert.match(d.data.text, new RegExp(`mark ${dir.id} done`));
    assert.equal(Object.values(items).filter(i => i.kind === 'decision' && i.data.fixall === dec.id && i.data.lane === 'audit').length, 2);
    assert.deepEqual(await inbox(), [], 'nothing left to review: the row goes');
    assert.equal((await f.post('/api/fixall-review', { project: 'kestrel', send: dec.id, verdict: 'accept' })).status, 409, 'decided already');
    assert.equal((await f.post('/api/fixall-review', { project: 'kestrel', send: 'DEC-999', verdict: 'accept' })).status, 409);
    assert.equal((await f.post('/api/fixall-review', { project: 'kestrel', send: dec.id, verdict: 'maybe' })).status, 400);
  } finally { await f.done(); }
});

test('Per file: advice per problem, the worst offenders ranked by cost per day and how bad, a file with nothing to do left out', () => {
  const rows = [
    { id: 'a', name: 'CLAUDE.md', exists: true, load: 'session', tokens: 5200, standing_tokens: 5200, loads_day: 40, stale: 2, findings: 3 },
    { id: 'b', name: 'small.md', exists: true, load: 'session', tokens: 400, loads_day: 40 },
    { id: 'c', name: 'agent.md', exists: true, load: 'role', tokens: 900, loads_day: 5, hints: 1 },
    { id: 'd', name: 'gone.md', exists: false, load: 'on-demand', tokens: 0, loads_day: 0 },
    { id: 'e', name: 'gen.md', exists: true, generated: true, drift: 'drift', load: 'checkin', tokens: 800, loads_day: 90 },
  ];
  const a = fileAdvice(rows[0]).map(x => x.text);
  assert.match(a[0], new RegExp(`every session loads it at ~5.2k tokens \\(budget ${FILE_BUDGET / 1000}.0k\\)`));
  assert.ok(a.some(t => /2 paragraphs no run has read lately/.test(t)) && a.some(t => /3 findings/.test(t)));
  assert.deepEqual(fileAdvice(rows[1]), [], 'within budget, nothing found: no advice');
  assert.match(fileAdvice(rows[3])[0].text, /missing/);
  assert.match(fileAdvice(rows[4])[0].text, /out of sync/);
  assert.equal(perDay(rows[0]), 208000);
  const w = worstFiles(rows);
  assert.deepEqual(w.map(x => x.r.id), ['a', 'e', 'c', 'd'], 'the costliest problem file first; the clean file left out');
  const html = renderTab('context', { sub: 'file', rows, counts: { files: 5 }, total: 1, sessions: 1, method: 'm', parts_loading: false, measured: null }, { project: 'p' });
  assert.match(html, /id="ins-worst"[^]*Look at these first[^]*CLAUDE\.md[^]*every session loads it/);
  assert.match(html, /<tr id="ins-row-a" class="ins-hot">/);
  assert.doesNotMatch(html, /<tr id="ins-row-b" class="ins-hot">/);
  assert.ok(html.indexOf('ins-row-a') < html.indexOf('ins-row-b') && html.indexOf('ins-row-e') < html.indexOf('ins-row-c'), 'the table: most tokens per day first');
  const clean = renderTab('context', { sub: 'file', rows: [rows[1]], counts: { files: 1 }, total: 1, sessions: 1, method: 'm', parts_loading: false, measured: null }, { project: 'p' });
  assert.match(clean, /No file needs attention/);
});

test('a later fixer whose notes are an earlier send\'s drafted nothing for its send: failed, no changes shown, a line says to send again', () => {
  const c = sendState('done'), items = loadState(c.state).items;
  // a second send on the same lane: its fixer reused the first fixer's notes (they name DIR-2 / DEC-1)
  const dec = record(c.state, { kind: 'decision', ev: 'create', by: 'dashboard', data: { lane: 'fixall', question: 'Fix all 2', choice: 'send', why: 'w', findings: ['A-9'] } }, { views: false });
  const dir = record(c.state, { kind: 'directive', ev: 'create', by: 'dashboard', data: { text: `Fix all (${dec.id})`, via: 'dashboard', findings: ['A-9'], fixall: dec.id } }, { views: false });
  const brief = path.join(c.state, 'brief-2.md'); fs.writeFileSync(brief, `# ${dir.id} docs fixer (${dec.id}: fix all)\n`);
  const run = record(c.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'docs-fixer', brief, notes: items[c.run].data.notes, worktree: c.root } }, { views: false });
  record(c.state, { kind: 'run', ev: 'end', id: run.id, by: 'launcher', data: { exit: 0, outcome: 'done' } }, { views: false });
  const w = fixWork(c.p, loadState(c.state).items).sends, second = w.find(s => s.id === dec.id), first = w.find(s => s.id === c.dec);
  assert.deepEqual([second.step, second.failed, second.counts.hunks], ['fixer', true, 0]);
  assert.match(second.line, /drafted nothing|ended without drafting anything for this send/);
  assert.deepEqual([first.step, first.failed, first.counts.hunks], ['review', false, 2], 'the first send keeps its own drafts');
});

test('a drafted change reads as what + why (no ids, no second severity, no diff header)', () => {
  const c = sendState('done'), w = fixWork(c.p, loadState(c.state).items);
  const g = { project: 'p', rows: [], work: w, pending: false, slop: true, voice: {} };
  const html = renderTab('slop', { ...guardSummary(g), sub: 'work', limit: 40, ...guardPart(g, 'work'), parts_loading: false }, { project: 'p' });
  assert.match(html, /<b>Remove 1 line<\/b>/); assert.match(html, /<b>Rewrite 1 line<\/b>/);
  assert.doesNotMatch(html.slice(html.indexOf('fxhunks')), /\+\+\+ b\//, 'no diff header lines');
  assert.doesNotMatch(html.slice(html.indexOf('fxhunks')), /why: [^<]*A-1\b/, 'no finding id in the why');
  // the Overview needs-you row of a review: ui.mjs needItem's fixall branch (it fell through to the run row: "run UNDEFINED")
});
