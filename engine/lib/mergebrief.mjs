// NORN-WATCH S2: the MERGE stage brief (engine/prompts/MERGE.md) filled from the lane + the project. The merge-shots mode is the
// project policy value policy.merge.shots (DIR-86 Q2: default "after" = merge on evidence, then show the owner the shots + the
// one-command revert; "before" = shots to the owner first, no merge in this run). A worker runs it; the check-in only writes it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MERGE_TEMPLATE = path.join(ENGINE, 'prompts', 'MERGE.md');
export const MERGE_SHA_TEMPLATE = path.join(ENGINE, 'prompts', 'MERGE-SHA.md');   // META-GTP-MERGEQ piece 0: the staged merge (--sha)
export const SHOTS_MODES = ['after', 'before'];
const fwd = p => String(p).replace(/\\/g, '/');

export function shotsMode(p) {
  const m = p?.policy?.merge?.shots ?? 'after';
  if (!SHOTS_MODES.includes(m)) throw new Error(`${p?.name ?? 'project'}: policy.merge.shots must be one of ${SHOTS_MODES.join(', ')} (got ${m})`);
  return m;
}

// DIR-24: policy.merge.suite - full (default: the ci-suite step) | skip (no ci-suite; a merge with conflicts runs only the test
// files of the conflicted areas, a red there = STOPPED; a clean merge runs none; the smoke always stays). The batch gate obeys it too.
export const SUITE_MODES = ['full', 'skip'];
export function suiteMode(p) {
  const m = p?.policy?.merge?.suite ?? 'full';
  if (!SUITE_MODES.includes(m)) throw new Error(`${p?.name ?? 'project'}: policy.merge.suite must be one of ${SUITE_MODES.join(', ')} (got ${m})`);
  return m;
}
// META-TEND TESTS (owner DIR-19 + DIR-47): after the suite step, the advisory tests check of the changed test files (no new coverage,
// copy-paste, suite time vs the last merge) - a finding never blocks the merge. Mutation score is not part of it: the trial measured
// 390-1225 s of test-process CPU for ONE 66-line file, far over the ~2 min a merge may spend (META-TEND TESTS NOTES).
const testsCheck = (p, dir, base, metaRoot) => `\n   Then the TESTS CHECK (advisory, never a merge block): \`node "${metaRoot}/engine/bin/norn.mjs" tests check --project ${p.name} --base ${base} --repo ${dir}\`;\n   copy its lines into NOTES and go on whatever it finds.`;
/** the suite step of MERGE.md (rebase) / MERGE-SHA.md (staged) + what ran (the notify body and NOTES line); full = today's text */
function suiteStep(p, rebase, dir, metaRoot) {
  const st = suiteText(p, rebase, dir);
  return { ...st, step: st.step + testsCheck(p, dir, rebase ? `origin/${p.deliverables?.main || 'main'}` : 'HEAD', metaRoot) };
}
function suiteText(p, rebase, dir) {
  if (suiteMode(p) === 'full') return { ran: 'suite', step: rebase
    ? `Suite in ${dir}: \`node engine/bin/ci-suite.mjs\` (smoke.test.mjs runs alone after the rest). Only the known reds of the project's known-red list may be\n   red; a load red must pass alone (run it alone, name it). Any other red = STOPPED, nothing merged.`
    : `Suite in ${dir} on the uncommitted merge: \`node engine/bin/ci-suite.mjs\` (smoke.test.mjs runs alone after the rest). Only the known reds of\n   the project's known-red list may be red; a load red must pass alone (run it alone, name it). Any other red =\n   \`git -C ${dir} merge --abort\`, STOPPED, nothing merged.` };
  const [what, where, abort, smoke] = rebase ? ["step 1's rebase", dir, '', 4] : ["step 2's merge", `${dir} on the uncommitted merge`, `\`git -C ${dir} merge --abort\`, `, 5];
  return {
    ran: 'suite skipped (policy merge.suite = skip), conflicted-area tests <the test files run, or none>',
    step: `SUITE SKIPPED (project policy merge.suite = skip): never \`node engine/bin/ci-suite.mjs\`. If ${what} had conflicts, run\n   only the test files of the conflicted areas in ${where} (\`node --test <file>\` each: the tests/*.test.mjs of the conflicted\n   code; name them); a red there = ${abort}\`norn done --outcome stopped --why "red in a conflicted area"\`, nothing merged. A clean ${rebase ? 'rebase' : 'merge'} runs no test\n   (the smoke of step ${smoke} always runs).`,
  };
}

// META-GTP-MERGEQ piece 0: the last line of every rendered MERGE brief says what it does to the lane worktree, for `norn run
// --stage MERGE` (runs.mjs mergeStageRefusal): rebase = the brief rebases + pushes in the lane worktree (refused while that
// worktree holds a live run); staged = it merges one tested commit in the main checkout and never touches the lane worktree.
const MARK_RE = /^<!-- meta-merge (\{.*\}) -->$/m;
const marker = m => `\n<!-- meta-merge ${JSON.stringify(Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)))} -->\n`;
/** the meta-merge marker of a brief text: { mode: rebase | staged, lane, branch, worktree, sha?, main (the main checkout it writes; META-MERGELOCK), notes (the NOTES file the brief names = the run's notes; META-MERGE-MARKER) } | null (a hand-written brief) */
export function briefMarker(text) {
  const m = String(text ?? '').match(MARK_RE);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
export const SHA_RE = /^[0-9a-f]{7,40}$/;
const fill = (file, v) => fs.readFileSync(file, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => { if (!(k in v)) throw new Error(`${path.basename(file)}: unknown placeholder {{${k}}}`); return v[k]; });

/** o: { lane, branch, worktree, notes, ui (the branch changes the dash / UI), sha (piece 0: the staged merge of THAT commit in the
 *  main checkout; the lane worktree is only named, never written) }. Returns the brief text. */
export function renderMergeBrief(p, o) {
  for (const k of ['lane', 'branch', 'notes', ...(o?.sha ? [] : ['worktree'])]) if (!o?.[k]) throw new Error(`merge brief: ${k} is required`);
  if (o.sha !== undefined && !SHA_RE.test(String(o.sha))) throw new Error(`merge brief: --sha must be a commit id (7-40 hex), got ${o.sha}`);
  if (o.sha) return renderStaged(p, o);
  const mode = shotsMode(p), metaRoot = fwd(p.meta || path.join(ENGINE, '..')), st = suiteStep(p, true, fwd(o.worktree), metaRoot);
  const shotsDir = fwd(path.join(path.dirname(o.notes), 'shots'));
  const shots = !o.ui ? 'Shots: no dash / UI change: no screenshots (the notice names the merge only).'
    : mode === 'after'
      ? `SHOTS AFTER (project policy merge.shots = after): take offscreen screenshots of every changed dash / UI view with \`norn shot\` (\`node "${metaRoot}/engine/bin/norn.mjs" shot <url> --out <png> [--phone] [--theme dark]\`; never start a browser by hand) from ${o.worktree} into ${shotsDir}/ (never a gitignored folder of a worktree), then merge on evidence (suite + smoke + shots); the owner sees them in the notice of step 6.`
      : `SHOTS BEFORE (project policy merge.shots = before): take offscreen screenshots of every changed dash / UI view with \`norn shot\` (\`node "${metaRoot}/engine/bin/norn.mjs" shot <url> --out <png> [--phone] [--theme dark]\`; never start a browser by hand) from ${o.worktree} into ${shotsDir}/, send them (\`norn notify --title "shots before merge ${o.branch}" --file <shot>\` per shot), write NOTES and end \`norn done --outcome stopped --why "shots sent before the merge"\` - do NOT do steps 4-6; the check-in re-briefs the merge once the owner answered.`;
  const v = {
    lane: o.lane, branch: o.branch, worktree: fwd(o.worktree), notes: fwd(o.notes), project: p.name, main: p.deliverables?.main || 'main',
    main_checkout: fwd(p.deliverables?.repo || p.root), meta_root: metaRoot, norn: `node "${metaRoot}/engine/bin/norn.mjs"`, meta: `node "${metaRoot}/engine/bin/norn.mjs"`, shots, suite: st.step, suite_ran: st.ran,
    shot_flag: o.ui && mode === 'after' ? `; then send up to 3 key shots (the changed views, dark first) as attachments, one \`node "${metaRoot}/engine/bin/norn.mjs" notify --class merge --title "<view>" --file <shot>\` each - the phone cannot open a local path; the shots folder path may follow in the body` : '',
  };
  return fill(MERGE_TEMPLATE, v) + marker({ mode: 'rebase', lane: o.lane, branch: o.branch, worktree: fwd(o.worktree), main: v.main_checkout, notes: v.notes });
}

// the staged merge (MERGE-SHA.md): the suite and the shots run on the merged tree in the main checkout
function renderStaged(p, o) {
  const mode = shotsMode(p), metaRoot = fwd(p.meta || path.join(ENGINE, '..')), mainCo = fwd(p.deliverables?.repo || p.root);
  const shotsDir = fwd(path.join(path.dirname(o.notes), 'shots')), sha = String(o.sha), st = suiteStep(p, false, mainCo, metaRoot);
  const shots = !o.ui ? 'Shots: no dash / UI change: no screenshots (the notice names the merge only).'
    : mode === 'after'
      ? `SHOTS AFTER (project policy merge.shots = after): after step 5's commit and before the push, take offscreen screenshots of every changed dash / UI view with \`norn shot\` (\`node "${metaRoot}/engine/bin/norn.mjs" shot <url> --out <png> [--phone] [--theme dark]\`; never start a browser by hand) from ${mainCo} into ${shotsDir}/; the owner sees them in the notice of step 7.`
      : `SHOTS BEFORE (project policy merge.shots = before): take offscreen screenshots of every changed dash / UI view with \`norn shot\` (\`node "${metaRoot}/engine/bin/norn.mjs" shot <url> --out <png> [--phone] [--theme dark]\`; never start a browser by hand) from ${mainCo} (the uncommitted merge) into ${shotsDir}/, send them (\`norn notify --title "shots before merge ${o.branch}" --file <shot>\` per shot), then \`git -C ${mainCo} merge --abort\`, write NOTES and end \`norn done --outcome stopped --why "shots sent before the merge"\` - do NOT do steps 5-7; the check-in re-briefs the merge once the owner answered.`;
  const v = {
    lane: o.lane, branch: o.branch, worktree: o.worktree ? fwd(o.worktree) : '(the lane worktree)', notes: fwd(o.notes), project: p.name, main: p.deliverables?.main || 'main',
    main_checkout: mainCo, meta_root: metaRoot, norn: `node "${metaRoot}/engine/bin/norn.mjs"`, meta: `node "${metaRoot}/engine/bin/norn.mjs"`, shots, sha, sha_short: sha.slice(0, 7), suite: st.step, suite_ran: st.ran,
    shot_flag: o.ui && mode === 'after' ? `; then send up to 3 key shots (the changed views, dark first) as attachments, one \`node "${metaRoot}/engine/bin/norn.mjs" notify --class merge --title "<view>" --file <shot>\` each - the phone cannot open a local path; the shots folder path may follow in the body` : '',
  };
  return fill(MERGE_SHA_TEMPLATE, v) + marker({ mode: 'staged', lane: o.lane, branch: o.branch, worktree: o.worktree ? fwd(o.worktree) : undefined, sha, main: mainCo, notes: v.notes });
}

// META-GTP-MERGEQ piece 3: the ONE MERGE stage of a green merge-queue batch (MERGE-BATCH.md): fast-forward main to the gated tip.
// b: { n, tip, base, gate (cmd), gate_log, retried, scratch, notes, ui, members: [{ id, branch, lane, sha, merge }] }
export const MERGE_BATCH_TEMPLATE = path.join(ENGINE, 'prompts', 'MERGE-BATCH.md');
export function renderBatchBrief(p, b) {
  for (const k of ['n', 'tip', 'base', 'gate', 'scratch', 'notes']) if (b?.[k] === undefined || b[k] === '') throw new Error(`batch brief: ${k} is required`);
  if (!b.members?.length) throw new Error('batch brief: no members');
  const mode = shotsMode(p), metaRoot = fwd(p.meta || path.join(ENGINE, '..')), mainCo = fwd(p.deliverables?.repo || p.root), batch = `batch-${b.n}`;
  const full = suiteMode(p) === 'full';   // skip: mergeq ran no gate (its members merge clean: no conflicted area to test)
  const shotsDir = fwd(path.join(path.dirname(b.notes), 'shots'));
  const shots = !b.ui ? 'Shots: no dash / UI change in the batch: no screenshots (the notice names the merge only).'
    : mode === 'after'
      ? `SHOTS AFTER (project policy merge.shots = after): after step 3's fast-forward (the main checkout = the batch tip) and before step 4's push, take offscreen screenshots of every changed dash / UI view with \`norn shot\` (\`node "${metaRoot}/engine/bin/norn.mjs" shot <url> --out <png> [--phone] [--theme dark]\`; never start a browser by hand) from ${mainCo} into ${shotsDir}/; the owner sees them in the notice of step 5.`
      : `SHOTS BEFORE (project policy merge.shots = before): \`git -C ${mainCo} worktree add --detach ${shotsDir}/tree ${b.tip}\`, take offscreen screenshots of every changed dash / UI view with \`norn shot\` (\`node "${metaRoot}/engine/bin/norn.mjs" shot <url> --out <png> [--phone] [--theme dark]\`; never start a browser by hand) from it into ${shotsDir}/, \`git -C ${mainCo} worktree remove --force ${shotsDir}/tree\`, send them (\`norn notify --title "shots before merge ${batch}" --file <shot>\` per shot), write NOTES and end \`norn done --outcome stopped --why "shots sent before the merge"\` - do NOT do steps 3-5.`;
  const v = {
    batch, count: String(b.members.length), project: p.name, main: p.deliverables?.main || 'main', main_checkout: mainCo, meta_root: metaRoot,
    norn: `node "${metaRoot}/engine/bin/norn.mjs"`, meta: `node "${metaRoot}/engine/bin/norn.mjs"`,   // meta = the old name (META-NAME-W3)
    suite: full ? `The gate \`${b.gate}\` ran GREEN${b.retried ? ' on its one retry (the first run was red: a flaky gate; recorded)' : ''} on`
      : 'No gate ran (project policy merge.suite = skip: every branch below merged clean, so no test file ran; "gated" below = built) on',
    suite_ran: full ? 'gate' : 'gate skipped (policy merge.suite = skip)',
    tip: b.tip, base: b.base, base_short: String(b.base).slice(0, 7), gate_log: fwd(b.gate_log || '-'), scratch: fwd(b.scratch), notes: fwd(b.notes), shots,
    members: b.members.map(m => `- ${m.id} ${m.branch} (lane ${m.lane ?? '-'}) at ${String(m.sha).slice(0, 7)}: merge commit ${m.merge}; revert: \`git -C ${mainCo} revert -m 1 ${m.merge}\``).join('\n'),
    shot_flag: b.ui && mode === 'after' ? `; then send up to 3 key shots (the changed views, dark first) as attachments, one \`node "${metaRoot}/engine/bin/norn.mjs" notify --class merge --title "<view>" --file <shot>\` each` : '',
  };
  return fill(MERGE_BATCH_TEMPLATE, v) + marker({ mode: 'staged', lane: 'mq', branch: `mq/${batch}`, sha: b.tip, main: mainCo, notes: fwd(b.notes) });
}
