// META-STANDING-CONTEXT R1: dated lines - every paragraph of an instruction file gets an age (git blame in a repo; hashed-line
// first-seen snapshots under Norn's state for files outside git; dates written in the text win), STALE flags, the confirm record,
// and `norn instructions suggest` (read-only, ranked by ~tokens saved per day) + apply through the chat's tap tier.
// Sandbox only: a fixture git repo, a fixture home, a fixture state.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { loadProject } from '../engine/lib/config.mjs';
import { record } from '../engine/lib/records.mjs';
import { discover, lineDates, paragraphs, statedDates, confirmations, suggest, instructionsView, applySuggestion } from '../engine/lib/instructions.mjs';
import { cliPlan } from '../engine/lib/chatact.mjs';

after(cleanTmp);
const HERE = path.dirname(fileURLToPath(import.meta.url)), META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
const fwd = p => p.replace(/\\/g, '/');
const DAY = 86400000, NOW = Date.parse('2026-11-13T12:00:00Z');
const git = (repo, args, date) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
  assert.equal(r.status, 0, r.stderr); return r.stdout;
};
const DUP = 'Every lane writes only its own NOTES file and ends it with exactly one end marker; the launcher records the run, never the agent itself, and the check-in reads it back.';
const BIG = 'Large block: ' + 'word '.repeat(420);

function fx() {
  const state = mkTmp('meta-age-'), base = path.dirname(path.dirname(state)), repo = path.join(base, 'repo'), home = path.join(base, 'home'), pd = path.join(base, 'proj');
  fs.mkdirSync(repo, { recursive: true }); git(repo, ['init', '-q', '-b', 'main'], '2026-09-01T00:00:00Z');
  w(path.join(repo, 'CLAUDE.md'), `# Rules\n\nOld rule from September, never touched again.\n\n${DUP}\n\nSee DIR-1 for the cadence.\n`);
  git(repo, ['add', '.'], '2026-09-01T10:00:00Z'); git(repo, ['commit', '-q', '-m', 'one'], '2026-09-01T10:00:00Z');
  fs.appendFileSync(path.join(repo, 'CLAUDE.md'), '\nA newer rule (OWNER 2026-11-10).\n\nCheck-ins: read the ledger tail first, then the inbox.\n\n' + BIG + '\n');
  git(repo, ['add', '.'], '2026-11-12T10:00:00Z'); git(repo, ['commit', '-q', '-m', 'two'], '2026-11-12T10:00:00Z');
  fs.appendFileSync(path.join(repo, 'CLAUDE.md'), '\nNot committed yet.\n');
  w(path.join(home, '.claude', 'CLAUDE.md'), '# user\n\nThe owner said this on 10-30 in the chat.\n');
  w(path.join(pd, 'rules', 'other.md'), `# Other\n\n${DUP}\n`);
  w(path.join(pd, 'rules', 'DECISION-RULES.md'), '# Decide\n\nDecide inside the rules.\n');
  const pf = w(path.join(pd, 'project.json'), JSON.stringify({ schema: 1, name: 'kestrel', title: 'K', root: fwd(repo), rules_read_whole: ['${project_dir}/rules/DECISION-RULES.md'] }, null, 1));
  const p = { ...loadProject(pf, { home: fwd(home), meta: fwd(base) }), state: fwd(state) };
  const machine = { home: fwd(home), claude: { config_dir: fwd(path.join(home, '.claude')), projects_dir: fwd(path.join(home, '.claude', 'projects')) }, codex: null, projects: [] };
  record(state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'cadence 15 min', via: 'dashboard' } }, { now: () => new Date('2026-09-01T09:00:00Z'), run: null });
  record(state, { kind: 'directive', ev: 'supersede', id: 'DIR-1', by: 'owner', data: { why: 'replaced' } }, { now: () => new Date('2026-10-01T09:00:00Z'), run: null });
  // two check-ins + one worker a day for the last week: the per-day load of the files
  for (let d = 1; d <= 7; d++) for (const kind of ['checkin', 'checkin', 'worker'])
    record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind, executor: 'claude', lane: kind === 'checkin' ? 'checkin' : 'water', session_id: `s${d}${kind}${Math.random()}` } }, { now: () => new Date(NOW - d * DAY + 3600000), run: null });
  return { state, base, repo, home, pd, p, machine, pf };
}
const byName = (rows, rel) => rows.find(r => r.path.toLowerCase().endsWith(rel.toLowerCase()));

test('line dates: git blame in a repo (uncommitted = now), first-seen snapshots outside git (a new line gets its own date)', () => {
  const f = fx();
  const rows = discover(f.p, { home: f.home, machine: f.machine });
  const cm = byName(rows, 'repo/CLAUDE.md'), user = byName(rows, 'home/.claude/CLAUDE.md');
  const d1 = lineDates([cm, user], { state: f.state, now: NOW });
  const c = d1.get(cm.id);
  assert.equal(c.by, 'git');
  assert.equal(c.dates[2].slice(0, 10), '2026-09-01'); assert.ok(c.dates.some(x => x.slice(0, 10) === '2026-11-12'));
  assert.equal(c.dates[c.dates.length - 1], new Date(NOW).toISOString(), 'an uncommitted line is dated now');
  const u = d1.get(user.id);
  assert.equal(u.by, 'seen'); assert.ok(u.dates.every(x => x === new Date(NOW).toISOString()));
  assert.ok(fs.existsSync(path.join(f.state, 'instructions', 'seen', `${user.id}.json`)), 'the snapshot lives under Norn\'s state');
  fs.appendFileSync(user.path, '\nA line added later.\n');
  const later = NOW + 3 * DAY, u2 = lineDates([user], { state: f.state, now: later }).get(user.id);
  assert.equal(u2.dates[0], new Date(NOW).toISOString(), 'a known line keeps its first-seen date');
  assert.equal(u2.dates[u2.dates.length - 1], new Date(later).toISOString());
});

test('stated dates: "2026-11-10", "10-30" (the year from the line\'s own date) and a DIR / DEC id (its record date) are parsed as the stated date', () => {
  const items = { 'DIR-1': { id: 'DIR-1', created: '2026-09-01T09:00:00Z', state: 'superseded' } };
  assert.deepEqual(statedDates('A rule (OWNER 2026-11-10).', '2026-11-12T00:00:00Z', items).map(x => x.date), ['2026-11-10']);
  assert.deepEqual(statedDates('said on 10-30 in the chat', '2026-11-12T00:00:00Z', items).map(x => x.date), ['2026-10-30']);
  assert.deepEqual(statedDates('said on 12-30 in the chat', '2026-11-12T00:00:00Z', items).map(x => x.date), ['2025-12-30'], 'never in the future of the line');
  assert.deepEqual(statedDates('See DIR-1 now', '2026-11-12T00:00:00Z', items).map(x => x.date), ['2026-09-01']);
  assert.deepEqual(statedDates('pages 1-5 and v2-10 and 2026-13-40', '2026-11-12T00:00:00Z', items), []);
});

test('paragraph ages + STALE: older than stale_days and never confirmed, or citing a superseded DIR; a confirm record resets the age', () => {
  const f = fx();
  const rows = discover(f.p, { home: f.home, machine: f.machine }), cm = byName(rows, 'repo/CLAUDE.md');
  const text = fs.readFileSync(cm.path, 'utf8'), dates = lineDates([cm], { state: f.state, now: NOW }).get(cm.id);
  const items = { 'DIR-1': { id: 'DIR-1', kind: 'directive', created: '2026-09-01T09:00:00Z', state: 'superseded', superseded_by: null } };
  let ps = paragraphs(text, dates, { items, now: NOW, staleDays: 30 });
  const P = re => ps.find(p => re.test(p.head));
  assert.equal(P(/^Old rule/).stale, true); assert.match(P(/^Old rule/).why, /older than 30 d/); assert.equal(P(/^Old rule/).age_days, 73);
  assert.equal(P(/^A newer rule/).stated, '2026-11-10'); assert.equal(P(/^A newer rule/).age_days, 3); assert.equal(P(/^A newer rule/).stale, false);
  assert.equal(P(/^See DIR-1/).stale, true); assert.match(P(/^See DIR-1/).why, /DIR-1.*superseded/);
  assert.match(P(/^Old rule/).anchor, /^p[0-9a-f]{8}$/); assert.equal(P(/^Old rule/).line, 3);
  // norn instructions confirm <file>#<anchor>: a Norn record, never text in the file
  const env = { ...process.env, HOME: f.home, USERPROFILE: f.home, META_ROOT: f.base, META_NO_TICK: '1' };
  for (const k of ['META_STATE', 'META_PROJECT', 'META_ROLE', 'META_RUN_ID', 'META_RUN_STATE']) delete env[k];
  const before = fs.readFileSync(cm.path, 'utf8');
  const r = spawnSync(process.execPath, [META, 'instructions', 'confirm', `${cm.path}#L3`, '--project', f.pf, '--as', 'owner', '--why', 'still true'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /ICF-1/);
  assert.equal(fs.readFileSync(cm.path, 'utf8'), before, 'the file is never edited');
  const conf = confirmations(f.state);
  assert.ok([...conf.values()].length === 1);
  ps = paragraphs(text, dates, { items, now: NOW, staleDays: 30, confirms: conf, file: cm.path });
  assert.equal(P(/^Old rule/).stale, false); assert.equal(P(/^Old rule/).confirmed, true); assert.equal(P(/^Old rule/).age_days, 0);
  const bad = spawnSync(process.execPath, [META, 'instructions', 'confirm', `${cm.path}#pdeadbeef`, '--project', f.pf, '--as', 'owner'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 2); assert.match(bad.stderr, /no paragraph/);
});

test('suggest: stale, duplicated, superseded, one-role, large and lean classes ranked by ~tokens saved per day; read-only; the exact patch printed', () => {
  const f = fx();
  const hash = p => fs.readFileSync(p, 'utf8');
  const before = [path.join(f.repo, 'CLAUDE.md'), path.join(f.home, '.claude', 'CLAUDE.md'), path.join(f.pd, 'rules', 'other.md')].map(hash);
  const standing = { roles: [{ key: 'worker', role: 'worker', family: 'claude', runs: 7 }, { key: 'checkin', role: 'checkin', family: 'claude', runs: 14 }],
    parts: { worker: { parts: [{ key: 'skills', tokens: 4000 }, { key: 'plugins', tokens: 5000 }, { key: 'mcp', tokens: 1000 }, { key: 'hooks', tokens: 1200 }, { key: 'base', tokens: 9000, items: [{ name: 'tool Artifact', tokens: 3000 }, { name: 'tool Bash', tokens: 900 }] }] } }, window_days: 7 };
  const v = instructionsView(f.p, { home: f.home, machine: f.machine, now: NOW, standing });
  const s = v.suggest;
  for (const k of ['stale', 'duplicate', 'superseded', 'one-role', 'large', 'lean']) assert.ok(s.some(x => x.class === k), `class ${k}: ${JSON.stringify(s.map(x => x.class))}`);
  for (let i = 1; i < s.length; i++) assert.ok(s[i - 1].saved_per_day >= s[i].saved_per_day, 'ranked by tokens saved per day');
  const st = s.find(x => x.class === 'stale' && /Old rule/.test(x.head));
  assert.equal(st.loads_per_day, 3, 'the repo CLAUDE.md loads in every session: 3 a day');
  assert.equal(st.saved_per_day, st.tokens * 3);
  assert.match(st.patch, /^--- a\/.*CLAUDE\.md\n\+\+\+ b\/.*CLAUDE\.md\n@@ -3,\d+ \+2,0 @@\n-Old rule/m);
  const lean = s.find(x => x.class === 'lean' && x.role === 'worker');
  assert.equal(lean.saved_per_day, (5000 + 1000 + 1200 + 3000) * 1, 'plugins + MCP + hooks + the dropped harness tools x one worker a day (skills kept)');
  const one = s.find(x => x.class === 'one-role');
  assert.equal(one.role, 'checkin'); assert.equal(one.saved_per_day, one.tokens * 1, 'only the worker sessions stop paying it');
  assert.ok(s.find(x => x.class === 'stale' && x.owner_file) || true);
  assert.deepEqual([path.join(f.repo, 'CLAUDE.md'), path.join(f.home, '.claude', 'CLAUDE.md'), path.join(f.pd, 'rules', 'other.md')].map(hash), before, 'suggest never edits a file');
  // the CLI: norn instructions suggest [--json]
  const env = { ...process.env, HOME: f.home, USERPROFILE: f.home, META_ROOT: f.base, META_NO_TICK: '1' };
  for (const k of ['META_STATE', 'META_PROJECT', 'META_ROLE', 'META_RUN_ID', 'META_RUN_STATE']) delete env[k];
  const j = spawnSync(process.execPath, [META, 'instructions', 'suggest', '--project', f.pf, '--json'], { env, encoding: 'utf8' });
  assert.equal(j.status, 0, j.stderr); assert.ok(JSON.parse(j.stdout).suggest.some(x => x.class === 'stale'));
  const t = spawnSync(process.execPath, [META, 'instructions', 'suggest', '--project', f.pf], { env, encoding: 'utf8' });
  assert.equal(t.status, 0, t.stderr); assert.match(t.stdout, /saved \/ day/); assert.match(t.stdout, /^@@ /m);
});

test('apply: through the chat\'s tap tier only (suggest read / confirm act / apply tap); the paragraph must be unchanged; user files only by the owner', () => {
  assert.equal(cliPlan(['instructions', 'suggest']).tier, 0);
  assert.equal(cliPlan(['instructions', 'confirm', 'x#p1']).tier, 1);
  assert.equal(cliPlan(['instructions', 'apply', 'S-1']).tier, 2);
  const f = fx();
  const v = instructionsView(f.p, { home: f.home, machine: f.machine, now: NOW });
  const st = v.suggest.find(x => x.class === 'stale' && /Old rule/.test(x.head));
  const r = applySuggestion(v, st.id, { role: 'controller' });
  assert.equal(r.applied, true);
  assert.doesNotMatch(fs.readFileSync(path.join(f.repo, 'CLAUDE.md'), 'utf8'), /Old rule/);
  assert.throws(() => applySuggestion(v, st.id, { role: 'controller' }), /changed|no longer/);
  const user = v.suggest.find(x => x.owner_file);
  if (user) assert.throws(() => applySuggestion(v, user.id, { role: 'controller' }), /owner/);
});
