// NORN-WATCH go-live fixes (DEC-688): (1) a MERGE stage is exempt from RATE_OK (caps + the weekly guard still bind); (2) Norn's
// gate sees meta-* run ends that live in OTHER project states (checkin.watch_lanes); (3) the Norn ledger lives in state/norn.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadProject } from '../engine/lib/config.mjs';
import { renderCheckin } from '../engine/lib/tick.mjs';
import { record } from '../engine/lib/records.mjs';
import { checkinGate, noteCheckin } from '../engine/lib/gate.mjs';
import { watchProbe } from '../engine/lib/watch.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const DEMO = path.join(REPO, 'tests', 'fixtures', 'projects', 'demo', 'project.json');   // norn's own config: norn-projects tests/owner-config.test.mjs
const tmp = p => mkTmp(p);
const fwd = p => p.replace(/\\/g, '/');
const T0 = Date.parse('2026-11-09T10:00:00Z');
const at = min => () => new Date(T0 + min * 60000);
const LIVE = { band: 14, rate_ok: 1, rate_band: 2, quiet: false };
const B = { max_claude_workers: 2, max_codex: 2 };

test('(2) watch_lanes: a meta-* run end in another project state wakes the norn gate once; an unwatched lane does not', () => {
  const t = tmp('meta-golive2-');
  const norn = path.join(t, 'state', 'norn'), kestrel = path.join(t, 'state', 'kestrel');
  const c = record(norn, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'checkin', executor: 'fake', lane: 'checkin' } }, { now: at(0), run: null });
  noteCheckin(norn, { run: c.id, start: new Date(T0).toISOString(), live: LIVE, budget: B });
  record(norn, { kind: 'run', ev: 'end', id: c.id, by: 'launcher', data: { outcome: 'done', exit: 0 } }, { now: at(5), run: null });
  const start = (lane, min) => record(kestrel, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane } }, { now: at(min), run: null }).id;
  const endIt = (id, min) => record(kestrel, { kind: 'run', ev: 'end', id, by: 'launcher', data: { outcome: 'done', exit: 0 } }, { now: at(min), run: null });
  const old = start('meta-visual', -30); endIt(old, -10);   // ended before the baseline: seen
  const other = start('water', 10); endIt(other, 12);
  const probe = () => watchProbe({ name: 'norn', state: norn, checkin: { watch_lanes: ['meta-*'] } }, { projects: [{ name: 'kestrel' }, { name: 'norn' }] });
  const gate = min => checkinGate({ state: norn, budget: B, live: LIVE, now: new Date(T0 + min * 60000), probes: [probe()] });
  assert.equal(gate(15).run, false, 'an unwatched lane and an end the baseline saw do not wake');
  const vb = start('meta-visual-b', 16); endIt(vb, 18);
  const g = gate(20);
  assert.equal(g.run, true, g.why);
  assert.ok(g.changes.includes(`+xend:kestrel:${vb}:end`), g.changes.join(' '));
  const c2 = record(norn, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'checkin', executor: 'fake', lane: 'checkin' } }, { now: at(25), run: null });
  noteCheckin(norn, { run: c2.id, start: new Date(T0 + 25 * 60000).toISOString(), live: LIVE, budget: B });
  record(norn, { kind: 'run', ev: 'end', id: c2.id, by: 'launcher', data: { outcome: 'done', exit: 0 } }, { now: at(30), run: null });
  assert.equal(gate(40).run, false, 'seen once: no re-wake');
  assert.equal(watchProbe({ name: 'kestrel', state: kestrel, checkin: {} }, { projects: [{ name: 'norn' }] }), null, 'no watch_lanes = no probe');
});

test('(3) state/ is untracked: a ledger in state/<project> (norn) is not in the repo the MERGE stage merges in', () => {
  const ig = spawnSync('git', ['-C', REPO, 'check-ignore', '-q', 'state/norn/NORN-LEDGER.md']);
  assert.equal(ig.status, 0, 'state/ is gitignored: a check-in append never dirties the main checkout');
});

// NORN-WATCH S5 (notice policy): a due FYI batch leaves on the next tick, not only on the next notice (CHECKIN-V2 had not wired it)
test('S5 norn tick: a pending FYI batch older than notify.batch_h is sent as one digest notice by the tick (paused or not)', () => {
  const t = tmp('meta-s5flush-');
  const META = path.join(REPO, 'engine', 'bin', 'norn.mjs');
  const root = path.join(t, 'root'); fs.mkdirSync(root, { recursive: true });
  const pf = path.join(t, 'demo.project.json');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'demo', title: 'demo', root: fwd(root), ledger: '${root}/progress.md', briefs_dir: '${root}', checkin: { cwd: '${root}' } }));
  fs.mkdirSync(path.join(t, 'local'));
  fs.writeFileSync(path.join(t, 'local', 'machine.json'), JSON.stringify({ schema: 1, home: fwd(t), node: fwd(process.execPath),
    claude: { exe: fwd(process.execPath), config_dir: fwd(path.join(t, 'cfg')), projects_dir: fwd(path.join(t, 'cfg', 'projects')) }, codex: null, git: { exe: fwd(process.execPath) },
    scheduler: { kind: 'cron', name: 'x', interval_min: 15 }, dash: { port: 8737, bind: '127.0.0.1' }, projects: [{ name: 'demo', config: fwd(pf) }] }));
  const state = path.join(t, 'state', 'demo'); fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(t, 'state', 'PAUSED'), '');
  const old = new Date(Date.now() - 4 * 3600e3).toISOString();
  fs.writeFileSync(path.join(state, 'notify-batch.jsonl'), JSON.stringify({ ts: old, title: 'DEC-9 ruled', body: 'b' }) + '\n');
  const r = spawnSync(process.execPath, [META, 'tick', '--reason', 'test'], { env: { ...process.env, META_ROOT: t }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(state, 'notify-batch.jsonl'), 'utf8'), '');
  const lines = fs.readFileSync(path.join(state, 'notify.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.at(-1).class, 'digest'); assert.match(lines.at(-1).body, /DEC-9 ruled/);
});
