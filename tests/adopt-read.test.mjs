// META-ADOPT A2 (SPEC meta-adopt sec. 2-3, 7): the read-only agent run (ADOPT.md brief, lane adopt, ingest at run end, checkDraft,
// one retry, the facts-only fallback, the time cap) and the NEW interview. The fake executor stands in for the agent (FAKE_RESULT =
// its canned final). Synthetic repos in temp dirs only; nothing real starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadState } from '../engine/lib/records.mjs';
import { loadRoadmap } from '../engine/lib/roadmap.mjs';
import { loadProject } from '../engine/lib/config.mjs';
import { scan, AdoptError, draftFacts, proposalOf, adoptStart, adoptDecide, adoptApply, adoptClose, interviewOf, checkDraft, draftRead, parseRead,
  readBrief, readStart, readWait, ingestRead } from '../engine/lib/adopt.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const git = (cwd, ...a) => { const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t.test', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
function repo(dir, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); }
  if (Object.keys(files).length) { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init'); }
  return dir;
}
const base = () => path.dirname(path.dirname(mkTmp('meta-adopt-read-', 'demo')));
const CI = 'name: ci\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n';
const NODE = { 'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node --test', lint: 'eslint .' } }, null, 1), '.github/workflows/ci.yml': CI,
  'README.md': '# x\n\nRun the slow suite with `npm run e2e`.\n', 'AGENTS.md': '# agents\nkeep it small\n', 'CONTRIBUTING.md': '# contributing\n',
  'ROADMAP.md': '# Roadmap\n\n## Sync\n- [IN PROGRESS] Offline sync (branch feat/sync)\n- [ ] Retry queue\n\n## Now\n- [ ] Export to CSV\n' };
/** a project over repo files (default: the node sample + a merged feat/sync + a live feat/live); META_ROOT = base */
function sample(files = NODE, { branches = files === NODE } = {}) {
  const b = base(), root = repo(path.join(b, 'repo'), files);
  if (branches) {
    git(root, 'checkout', '-q', '-b', 'feat/sync'); fs.writeFileSync(path.join(root, 'sync.js'), 'x\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'sync');
    git(root, 'checkout', '-q', 'main'); git(root, 'merge', '-q', '--no-ff', '-m', 'merge sync', 'feat/sync');
    git(root, 'checkout', '-q', '-b', 'feat/live'); fs.writeFileSync(path.join(root, 'live.js'), 'x\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'live');
    git(root, 'checkout', '-q', 'main');
  }
  const pdir = path.join(b, 'proj'); fs.mkdirSync(path.join(pdir, 'rules'), { recursive: true });
  const file = path.join(pdir, 'project.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, name: 'demo', title: 'Demo', root: root.replace(/\\/g, '/'), briefs_dir: '${state}/briefs',
    lane_defaults: { worktree: '${state}/wt/${lane}', notes: '${state}/notes/${lane}/NOTES.md' } }, null, 1) + '\n');
  const load = () => loadProject(file, { meta: b });
  return { b, root, file, pdir, load, state: load().state };
}
const meta = (args, env = {}) => {
  const r = spawnSync(process.execPath, [META, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROLE: '', META_PROJECT: '', META_STATE: '', META_NO_TICK: '1', ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
/** the canned read of the node sample: one invented command, one doc-stated one, a ghost rule, a ghost branch / doc, a typed status */
const CANNED = {
  schema: 1, summary: 'x is a small tool.', goals: [{ text: 'Work offline', source: 'ROADMAP.md:4' }],
  commands: [{ id: 'test', cmd: 'npm test', source: '.github/workflows/ci.yml:9' }, { id: 'e2e', cmd: 'npm run e2e', source: 'README.md:3' },
    { id: 'build', cmd: 'npm run build', source: 'package.json:1' }],
  rules: [{ text: 'Keep it small.', source: 'AGENTS.md:2' }, { text: 'Ghost rule.', source: 'NOPE.md:4' }],
  roadmap: { themes: [
    { title: 'Work offline', items: [
      { title: 'Offline sync', horizon: null, links: ['branch:feat/sync'], claim: 'IN PROGRESS', sources: ['ROADMAP.md:4'], stages: ['Retry queue'] },
      { title: 'Live thing', horizon: 'now', links: ['branch:feat/live', 'branch:feat/ghost', 'doc:docs/nope.md'], sources: ['ROADMAP.md:8'], status: 'shipped' }] },
    { title: 'Data out', items: [{ title: 'Export to CSV', horizon: 'now', claim: null, sources: ['ROADMAP.md:8'] }] }] },
  first_tasks: [{ task: 'Export to CSV', item: 'Export to CSV', source: 'ROADMAP.md:8' }],
  questions: [{ id: 'q1', text: 'Which first?', options: ['a', 'b'], why: 'order' }], unsure: ['the release cadence'] };
const canned = (b, text = JSON.stringify(CANNED, null, 1) + '\n## DONE\n') => { const f = path.join(b, 'canned.txt'); fs.writeFileSync(f, text); return f; };
const fakeLaunch = s => ({ state: s.state, locksDir: path.join(s.b, 'locks'), executor: 'fake', model: 'fake', effort: '-', project: 'demo', budget: {}, tick: null });

// ---------- the NEW interview ----------
test('interview: NEW asks goal / month / first (+ tests when files but no test command); ADOPT asks priority / never; an unknown answer is refused', () => {
  const young = repo(path.join(base(), 'young'), { 'README.md': '# y\n' });
  assert.deepEqual(interviewOf(scan(young)).map(q => q.id), ['goal', 'month', 'first']);
  const code = repo(path.join(base(), 'code'), { 'README.md': '# c\n', 'src/main.c': 'int main(){}\n' });
  const f = scan(code);
  assert.equal(f.path, 'new');
  assert.deepEqual(interviewOf(f).map(q => q.id), ['goal', 'month', 'first', 'tests']);
  for (const q of interviewOf(f)) assert.ok(q.text.endsWith('?') && q.why, q.id);
  const s = sample();
  assert.deepEqual(interviewOf(scan(s.root)).map(q => q.id), ['priority', 'never']);
  assert.throws(() => adoptStart(s.state, { project: s.load(), by: 'owner', answers: { colour: 'blue' } }), e => e instanceof AdoptError && /colour.*goal/.test(e.message));
});

// ---------- checkDraft: the engine checks the read before anyone sees it ----------
test('checkDraft: an unbacked command / an unresolved source is unverified (off); a doc-stated command is backed by its line; ghost links and typed status are dropped', () => {
  const s = sample(), facts = scan(s.root);
  const { read, problems } = checkDraft(structuredClone(CANNED), facts);
  const cmd = id => read.commands.find(c => c.id === id);
  assert.equal(cmd('test').unverified, undefined);
  assert.equal(cmd('e2e').unverified, undefined, 'README.md:3 states it');
  assert.equal(cmd('build').unverified, true);
  assert.ok(problems.some(p => /npm run build/.test(p) && /unverified/.test(p)));
  assert.equal(read.rules.find(r => r.text === 'Ghost rule.').unverified, true);
  assert.ok(problems.some(p => /NOPE\.md:4/.test(p)));
  const live = read.roadmap.themes[0].items[1];
  assert.deepEqual(live.links, ['branch:feat/live']);
  assert.equal(live.status, undefined);
  for (const re of [/feat\/ghost/, /docs\/nope\.md/, /status/]) assert.ok(problems.some(p => re.test(p)), String(re));
  assert.equal(problems.filter(p => /Offline sync|Export to CSV/.test(p)).length, 0, 'a clean item raises nothing');
});

test('draftRead -> parts; unverified lines start off; approve + apply writes only verified lines; the claim shows as drift', async () => {
  const s = sample();
  adoptStart(s.state, { project: s.load(), by: 'owner' });
  const facts = scan(s.root);
  const d = draftRead(facts, checkDraft(structuredClone(CANNED), facts), {});
  assert.deepEqual(d.parts.map(p => p.id), ['profile', 'commands', 'rules', 'instructions', 'roadmap', 'first']);
  const road = d.parts.find(p => p.id === 'roadmap');
  assert.deepEqual(road.lines.map(l => [l.text, l.theme, l.source]), [['Offline sync', 'Work offline', 'ROADMAP.md:4'], ['Live thing', 'Work offline', 'ROADMAP.md:8'], ['Export to CSV', 'Data out', 'ROADMAP.md:8']]);
  assert.deepEqual(road.lines[0].legacy, { word: 'IN PROGRESS', text: 'Offline sync', line: 4, file: 'ROADMAP.md' });
  assert.deepEqual(road.lines[0].stages, ['Retry queue']);
  assert.equal(d.parts.find(p => p.id === 'first').lines[0].item, road.lines[2].id);
  assert.equal(d.summary, 'x is a small tool.'); assert.equal(d.questions.length, 1); assert.ok(d.problems.length >= 4);
  // record it as a read draft (what the ingest does), then review + apply
  const p = proposalOf(s.state);
  ingestRead(s.state, { adopt: { id: p.id, attempt: 1 }, run: 'RUN-1', notes: canned(s.b) }, { outcome: 'done' });
  assert.equal(proposalOf(s.state).draft.source, 'RUN-1');
  adoptDecide(s.state, { part: 'commands', verdict: 'approve', by: 'owner' });
  adoptDecide(s.state, { part: 'rules', verdict: 'approve', on: [proposalOf(s.state).parts.find(x => x.id === 'rules').lines.find(l => l.text === 'Ghost rule.').id], by: 'owner' });
  adoptDecide(s.state, { part: 'roadmap', verdict: 'approve', by: 'owner' });
  await adoptApply(s.state, { project: s.load(), by: 'owner' });
  const rules = fs.readFileSync(path.join(s.pdir, 'rules', 'RULES.md'), 'utf8');
  assert.match(rules, /Keep it small\./); assert.match(rules, /Ghost rule\./, 'turned on by --on');
  assert.match(rules, /npm run e2e/); assert.doesNotMatch(rules, /npm run build/, 'unverified stays off');
  assert.equal(s.load().merge.gate.cmd, 'npm test');
  const items = Object.values(loadRoadmap(s.state).items).filter(i => i.kind === 'item');
  assert.deepEqual(items.map(i => i.title).sort(), ['Export to CSV', 'Live thing', 'Offline sync']);
  assert.deepEqual(items.find(i => i.title === 'Offline sync').stages, ['Retry queue']);
  const show = meta(['road', 'show', '--project', s.file], { META_ROOT: s.b });
  assert.match(show.out, /drift: legacy says IN PROGRESS/);
});

// ---------- the run: lane adopt, read-only, ingest at run end ----------
test('norn adopt draft: no choice = the consent line (executor, cap, privacy) and exit 2; nothing starts', () => {
  const s = sample();
  const r = meta(['adopt', 'draft', '--project', s.file, '--as', 'owner', '--executor', 'fake'], { META_ROOT: s.b });
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /--read/); assert.match(r.err, /--no-read/); assert.match(r.err, /15 min/); assert.match(r.err, /file text goes to/);
  assert.equal(proposalOf(s.state), null);
});

test('norn adopt draft --read: a read-only run on lane adopt; its final is ingested, checked and recorded as the draft; the repo is untouched', () => {
  const s = sample(), head = git(s.root, 'rev-parse', 'HEAD');
  const r = meta(['adopt', 'draft', '--project', s.file, '--as', 'owner', '--read', '--executor', 'fake', '--wait'], { META_ROOT: s.b, FAKE_RESULT: canned(s.b) });
  assert.equal(r.code, 0, r.out + r.err);
  const run = /RUN-\d+/.exec(r.out)[0];
  assert.match(r.out, new RegExp(`drafted from ${run}`));
  const it = loadState(s.state).items[run];
  assert.equal(it.data.lane, 'adopt'); assert.equal(it.data.role, 'helper'); assert.equal(it.end.outcome, 'done');
  const p = proposalOf(s.state);
  assert.equal(p.draft.source, run);
  assert.deepEqual(p.parts.find(x => x.id === 'roadmap').lines.map(l => l.text), ['Offline sync', 'Live thing', 'Export to CSV']);
  assert.match(fs.readFileSync(it.data.brief, 'utf8'), /Adopt read/);
  assert.equal(git(s.root, 'rev-parse', 'HEAD'), head); assert.equal(git(s.root, 'status', '--porcelain'), '');
  const show = meta(['adopt', 'show', '--project', s.file], { META_ROOT: s.b });
  assert.match(show.out, /x is a small tool\./); assert.match(show.out, /unverified/); assert.match(show.out, /Which first\?/);
});

test('an invalid final: one retry run, then the facts-only draft with the reason; the time cap ends a read that runs on', () => {
  const s = sample();
  const r = meta(['adopt', 'draft', '--project', s.file, '--as', 'owner', '--read', '--executor', 'fake', '--wait'], { META_ROOT: s.b, FAKE_RESULT: canned(s.b, 'I could not decide.\n## DONE\n') });
  assert.equal(r.code, 0, r.out + r.err);
  const reads = Object.values(loadState(s.state).items).filter(i => i.kind === 'run' && i.data.lane === 'adopt');
  assert.equal(reads.length, 2, 'one retry');
  assert.match(fs.readFileSync(reads.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))[1].data.brief, 'utf8'), /RETRY/);
  const p = proposalOf(s.state);
  assert.equal(p.draft.source, 'facts'); assert.match(p.draft.note, /no valid draft/);
  assert.match(r.out, /facts-only/);
  // the cap: a read that runs on is stopped and falls back at once (no retry)
  const t = sample(), prev = process.env.FAKE_MS;
  process.env.FAKE_MS = '60000';
  try {
    const x = readStart(t.state, { project: t.load(), by: 'owner', launch: { ...fakeLaunch(t), capMs: 1500 } });
    const w = readWait(t.state, { id: x.id, run: x.run, maxS: 60 });
    assert.equal(w.source, 'facts'); assert.match(proposalOf(t.state).draft.note, /time cap/);
    assert.equal(Object.values(loadState(t.state).items).filter(i => i.kind === 'run' && i.data.lane === 'adopt').length, 1);
  } finally { if (prev === undefined) delete process.env.FAKE_MS; else process.env.FAKE_MS = prev; }
});

test('ingest: a proposal closed while the read ran gets no draft; a read of a closed one never retries', () => {
  const s = sample();
  adoptStart(s.state, { project: s.load(), by: 'owner' });
  const id = proposalOf(s.state).id;
  adoptClose(s.state, { why: 'not now', by: 'owner' });
  assert.equal(ingestRead(s.state, { adopt: { id, attempt: 1 }, run: 'RUN-9', notes: canned(s.b, 'bad') }, { outcome: 'done' }).ev, 'skipped');
  assert.equal(proposalOf(s.state).draft.n, 1);
});

test('a full cap refuses the read cleanly (REFUSED, exit 4); a refused retry ends in the facts-only draft, not in a hang', () => {
  const s = sample();
  fs.mkdirSync(path.join(s.b, 'local'), { recursive: true });
  fs.writeFileSync(path.join(s.b, 'local', 'budget.json'), JSON.stringify({ max_claude_workers: 0 }));
  const r = meta(['adopt', 'draft', '--project', s.file, '--as', 'owner', '--read', '--executor', 'fake'], { META_ROOT: s.b });
  assert.equal(r.code, 4, r.out + r.err); assert.match(r.out, /^REFUSED: .*max_claude_workers=0/m);
  const p = proposalOf(s.state);
  const x = ingestRead(s.state, { adopt: { id: p.id, attempt: 1, project: s.load(), by: 'owner', launch: { ...fakeLaunch(s), budget: { max_claude_workers: 0 } } }, run: 'RUN-7', notes: canned(s.b, 'bad') }, {});
  assert.equal(x.ev, 'fallback');
  assert.match(proposalOf(s.state).draft.note, /the retry did not start: .*max_claude_workers=0/);
});

test('scan of a clone: origin/HEAD is no branch (a read could link "branch:origin"); the clone\'s origin/* branches are', () => {
  const s = sample(), copy = path.join(s.b, 'clone');
  git(s.b, 'clone', '-q', s.root, copy);
  const names = scan(copy).branches.map(b => b.name).sort();
  assert.deepEqual(names, ['feat/live', 'feat/sync']);
});
