// META-UX-BUILD S7 (REPORT meta-ux-plan s.3 "End to end" 3-5, DIR-65 Q2 A): the fixer run of a Fix all directive - its plan (one
// bounded batch per approved run, never more than the tap approved), its generated brief, its answer (audit-format hunks + one line
// per finding) and `rec show` printing a long id list as its first ids + a count. Sandbox only (temp dirs, no live state).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixPlan, fixerBrief, fixResult, briefIds, fixBatch, runsFor } from '../engine/lib/fixer.mjs';
import { withDefaults } from '../engine/lib/policy.mjs';
import { main } from '../engine/bin/norn.mjs';

const ids = n => Array.from({ length: n }, (_, i) => `I-c16-${String(i).padStart(3, '0')}`);
function world({ n = 90, runs = 0, decRuns, rest = 0 } = {}) {
  const items = { 'DEC-1': { id: 'DEC-1', kind: 'decision', state: 'in-force', created: '2026-11-17T05:57:00Z', data: { lane: 'fixall', findings: ids(n), ...(decRuns ? { runs: decRuns } : {}) } },
    'DIR-9': { id: 'DIR-9', kind: 'directive', state: 'active', created: '2026-11-17T05:57:01Z', data: { fixall: 'DEC-1', findings: ids(n), text: 'Fix all' } } };
  const briefs = {};
  for (let i = 0; i < runs; i++) {
    const id = `RUN-${i + 1}`, b = `/s/fixer/DIR-9-${i}.brief.md`;
    items[id] = { id, kind: 'run', state: 'ended', created: `2026-11-17T06:0${i}:00Z`, end: { outcome: 'done' }, data: { lane: 'fixall', kind: 'audit', brief: b } };
    briefs[b] = ids(n).slice(i * 40, i * 40 + 40).map(x => `- id: ${x}`).join('\n');
  }
  if (rest) items['DEC-2'] = { id: 'DEC-2', kind: 'decision', state: 'in-force', created: '2026-11-17T07:00:00Z', data: { lane: 'fixall', rest_of: 'DIR-9', runs: rest } };
  return { items, readBrief: r => briefs[r.data.brief] ?? '' };
}

test('the batch lives with the class limits (policy.fixer.batch) and a send of n needs ceil(n / batch) runs', () => {
  assert.equal(fixBatch(withDefaults({}).policy), 40);
  assert.deepEqual([runsFor(1, 40), runsFor(40, 40), runsFor(41, 40), runsFor(302, 40)], [1, 1, 2, 8]);
});

test('plan: no run yet = ONE bounded batch; a directive approved as one run runs ONE batch, then offers the rest as a new tap', () => {
  const w = world(), p0 = fixPlan(w.items['DIR-9'], w.items, { batch: 40, readBrief: w.readBrief });
  assert.deepEqual([p0.approved, p0.next.length, p0.next[0], p0.more], [1, 40, 'I-c16-000', 3], 'a decision without runs approved ONE run (a send made before the runs field)');
  const w1 = world({ runs: 1 }), p1 = fixPlan(w1.items['DIR-9'], w1.items, { batch: 40, readBrief: w1.readBrief });
  assert.equal(p1.next, null, 'never more than the tap approved');
  assert.deepEqual([p1.left.length, p1.more], [50, 2], 'n left: the rest needs m runs');
  const w2 = world({ runs: 1, rest: 2 }), p2 = fixPlan(w2.items['DIR-9'], w2.items, { batch: 40, readBrief: w2.readBrief });
  assert.deepEqual([p2.approved, p2.next[0], p2.next.length], [3, 'I-c16-040', 40], 'the rest tap approves more runs: the next batch starts after the first');
  const w3 = world({ decRuns: 3 }); w3.items['RUN-7'] = { id: 'RUN-7', kind: 'run', state: 'queued', created: '2026-11-17T06:00:00Z', data: { lane: 'fixall', brief: '/s/fixer/DIR-9-x.brief.md' } };
  assert.equal(fixPlan(w3.items['DIR-9'], w3.items, { batch: 40, readBrief: () => '' }).next, null, 'a queued or running fixer run: start nothing');
  const w4 = world(); w4.items['DIR-9'].state = 'done';
  assert.equal(fixPlan(w4.items['DIR-9'], w4.items, { batch: 40 }).next, null, 'a closed directive starts nothing');
});

test('the brief is generated: each id with its file:line, fix sentence, ready patch and picked way; briefIds reads the batch back', () => {
  const rows = [{ id: 'I-1', key: 'instr-c16', path: 'C:\\r\\CLAUDE.md', line: 12, why: 'history in a rule file', action: 'move the history to a dated note' },
    { id: 'T-S-2', key: 'tighten-superseded', path: 'C:/r/AGENTS.md', line: 30, why: 'cites DEC-1', action: 'delete it', patch: '@@ -30,1 +29,0 @@\n-old' },
    { id: 'R-3', key: 'rule-drift-claim', path: 'C:/r/CLAUDE.md', line: 9, why: 'claims', action: 'add or drop' }];
  const b = fixerBrief({ project: 'kestrel', dir: 'DIR-9', dec: 'DEC-1', rows, picks: [{ key: 'rule-drift-claim|call', way: 'Drop the claim' }] });
  assert.match(b, /READ-ONLY/);
  assert.match(b, /- id: I-1\n  file: C:\/r\/CLAUDE\.md:12\n  finding: history in a rule file\n  fix: move the history to a dated note/);
  assert.match(b, /patch \(ready\):\n    @@ -30,1 \+29,0 @@\n    -old/);
  assert.match(b, /- id: R-3[\s\S]*the owner picked: Drop the claim/);
  assert.match(b, /- <id>: drafted` or `- <id>: skipped: <why>/);
  assert.deepEqual(briefIds(b), ['I-1', 'T-S-2', 'R-3']);
});

test('the answer: audit-format hunks + one line per finding; no parsable hunk = failed', () => {
  const text = ['### `CLAUDE.md:12` - medium - rewrite', '```diff', '--- a/CLAUDE.md', '+++ b/CLAUDE.md', '@@ -12,1 +12,1 @@', '-history 2026-10', '+See notes/history.md.', '```',
    '### `AGENTS.md:30` - medium - remove', '```diff', '--- a/AGENTS.md', '+++ b/AGENTS.md', '@@ -30,1 +29,0 @@', '-cites DEC-1', '```',
    '## Findings', '- I-1: drafted', '- `T-S-2`: drafted', '- R-3: skipped: no way picked'].join('\n');
  const r = fixResult(text, ['I-1', 'T-S-2', 'R-3', 'X-4']);
  assert.equal(r.failed, false);
  assert.deepEqual(r.hunks.map(h => [h.file, h.line]), [['CLAUDE.md', 12], ['AGENTS.md', 30]]);
  assert.match(r.hunks[0].id, /^[0-9a-f]{12}$/);
  assert.deepEqual(r.status.map(s => [s.id, s.state, s.why]), [['I-1', 'drafted', null], ['T-S-2', 'drafted', null], ['R-3', 'skipped', 'no way picked'], ['X-4', 'missing', null]]);
  assert.equal(fixResult('I could not read the files.', ['I-1']).failed, true);
});

test('rec show: a long id list prints as its first ids + a count; --full prints all', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-show-')), env = { META_STATE: state, META_ROLE: 'owner' }, o = [], e = [];
  const run = argv => main(argv, env, s => o.push(s), s => e.push(s));
  assert.equal(run(['rec', 'add', 'directive', '--text', 'Fix all '.padEnd(1200, 'x'), '--via', 'cli']), 0, e.join('\n'));
  const id = o.join('\n').match(/DIR-\d+/)[0], ev = fs.readdirSync(state).map(f => path.join(state, f)).find(f => /\.jsonl$/.test(f) && fs.readFileSync(f, 'utf8').includes(id));
  const lines = fs.readFileSync(ev, 'utf8').trim().split('\n'), first = JSON.parse(lines[0]);
  first.data.findings = ids(302); fs.writeFileSync(ev, [JSON.stringify(first), ...lines.slice(1)].join('\n') + '\n');
  o.length = 0; assert.equal(run(['rec', 'show', id]), 0, e.join('\n'));
  const short = o.join('\n');
  assert.match(short, /"I-c16-004","\+297 more \(--full prints all\)"/);
  assert.ok(!short.includes('I-c16-005'));
  assert.match(short, /\(\+\d+ chars, --full prints all\)/);
  o.length = 0; assert.equal(run(['rec', 'show', id, '--full']), 0);
  assert.ok(o.join('\n').includes('I-c16-301'));
  const full = o.join('\n');
  assert.ok(short.length * 4 < full.length, `the short show is a fraction of the full one (${short.length} vs ${full.length})`);
});
