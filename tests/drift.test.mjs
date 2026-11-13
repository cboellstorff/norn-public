// META-GUARD R1 item 3: brief drift at run end (read-only, no model call) - the brief's numbered items vs the NOTES (claimed / not
// mentioned) and the files the branch changed outside the areas the brief names; a hint for the check-in, never a verdict.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { record } from '../engine/lib/records.mjs';
import { briefDrift, briefItems, briefAreas } from '../engine/lib/drift.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { renderDigest } from '../engine/lib/views.mjs';

after(cleanTmp);
const BRIEF = `# task X - the water picture
Worktree C:/w/x. Touch engine/lib/water.mjs, tests/water.test.mjs and engine/dash/ only.

## Build
1. FOAM PASS: a foam mask from the depth gradient, written into
   the water shader (engine/lib/water.mjs).
2. SHORE FADE: alpha falls off near the shore line within 2 m.
3. Caustics projected below the surface, animated by time.
Tests: the foam mask on a fixture.
`;
const NOTES = `# NOTES
## What was built
1. Foam pass: the mask from the depth gradient (water.mjs).
2. Caustics: projected below the surface, animated with the time uniform.
## DONE
`;

test('items: the numbered items of the brief (continuation lines joined), each claimed or not mentioned in the NOTES; areas = the paths the brief names', () => {
  const it = briefItems(BRIEF);
  assert.deepEqual(it.map(i => [i.n, i.label]), [[1, 'FOAM PASS'], [2, 'SHORE FADE'], [3, 'Caustics projected below the surface, animated']]);
  assert.match(it[0].text, /the water shader/);
  assert.deepEqual(briefAreas(BRIEF), ['engine/lib/water.mjs', 'tests/water.test.mjs', 'engine/dash/']);
  const d = briefDrift({ brief: BRIEF, notes: NOTES, files: ['engine/lib/water.mjs', 'engine/dash/ui.mjs', 'engine/lib/records.mjs', 'README.md'] });
  assert.deepEqual(d.items.map(i => i.status), ['claimed', 'not mentioned', 'claimed']);
  assert.deepEqual(d.outside, ['engine/lib/records.mjs', 'README.md']);
  assert.equal(d.hint, '1 of 3 brief items not mentioned in the NOTES (2. SHORE FADE); 2 changed files outside the areas the brief names (engine/lib/records.mjs, README.md) - a hint, not a verdict');
  assert.equal(briefDrift({ brief: 'no list here', notes: '', files: ['a.js'] }).hint, null, 'no items + no areas = nothing to say');
});

test('the check-in sees it: an ended, unreviewed run with a drift gets a digest row (git diff of its branch; read-only)', () => {
  const st = mkTmp('meta-drift-'), wt = path.join(st, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  const brief = path.join(st, 'brief.md'), notes = path.join(st, 'NOTES.md');
  fs.writeFileSync(brief, BRIEF); fs.writeFileSync(notes, NOTES);
  const id = record(st, { kind: 'run', ev: 'start', by: 'launcher', data: { executor: 'claude', kind: 'worker', lane: 'water', stage: 'S1', brief, notes, worktree: wt } }, { run: null, views: false }).id;
  record(st, { kind: 'run', ev: 'end', id, by: 'launcher', data: { outcome: 'done', exit: 0, branch: 'feat/water', head: 'abc' } }, { run: null, views: false });
  const calls = [];
  const git = (repo, args) => { calls.push(args.join(' ')); return args[0] === 'merge-base' ? 'base1\n' : args[0] === 'diff' ? 'engine/lib/water.mjs\nengine/lib/records.mjs\n' : ''; };
  const d = digest(st, { name: 'x' }, { git, dlv: [] });
  const row = d.sections.guard?.find(r => r.kind === 'drift');
  assert.ok(row, JSON.stringify(d.sections.guard));
  assert.equal(row.run, id);
  assert.match(renderDigest(d), new RegExp(`- ${id} drift water: 1 of 3 brief items not mentioned`));
  assert.ok(calls.some(c => /^diff --name-only base1 abc/.test(c)), calls.join(' | '));
  record(st, { kind: 'run', ev: 'review', id, by: 'checkin', data: { refs: [] } }, { run: null, views: false });
  assert.equal(digest(st, { name: 'x' }, { git, dlv: [] }).sections.guard, undefined, 'reviewed: the row leaves');
});
