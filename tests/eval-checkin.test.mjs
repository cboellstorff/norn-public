// norn eval checkin (META-GT3): frozen-context replay of recorded check-ins on a candidate executor, scored against the
// real check-in's recorded actions. Fake transcripts / records / a fake spawn only: no network, no live state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkTmp } from './helpers/tmp.mjs';
import { frozenContext, isActionCall, baselineActions, parseActions, scoreTick, tickContext, sampleTicks, evalPrompt,
  replayTick, findBudget, summarize, ANSWER_FORM } from '../engine/lib/eval/checkin.mjs';

const J = o => JSON.stringify(o);
const tu = (id, name, input) => J({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const tr = (id, content) => J({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const transcript = [
  J({ type: 'user', message: { content: 'Read C:/s/CHECKIN.rendered.md and do exactly that.' } }),
  J({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'I will dispatch relief' }, { type: 'text', text: 'dispatching relief now' }] } }),
  tu('a', 'Bash', { command: 'cat C:/s/CHECKIN.rendered.md; cat budget.json' }), tr('a', '# META CHECK-IN\n{"max_codex": 2, "max_sol": 2, "lanes": {"x": {"executor": "paused"}}}'),
  tu('b', 'Read', { file_path: 'C:/s/STATUS.md' }), tr('b', [{ type: 'text', text: 'RATE_OK=1 status body' }]),
  tu('c', 'Bash', { command: 'node engine/bin/norn.mjs run --lane relief --stage S1 --executor codex-sol' }), tr('c', 'RUN-9 started'),
  tu('d', 'PowerShell', { command: 'node norn.mjs rec add decision --lane relief --question q' }), tr('d', 'DEC-1'),
  tu('e', 'Write', { file_path: 'C:/b/task-relief-S1-brief.md', content: 'brief' }), tr('e', 'ok'),
  tu('f', 'ToolSearch', { query: 'select:Monitor' }), tr('f', 'x'),
  tu('g', 'Grep', { pattern: 'RUN-1', path: 'C:/n/NOTES.md' }), tr('g', 'x'.repeat(50)),
].join('\n');

test('frozenContext keeps the prompt + read results, drops actions, thinking, own text and harness tools', () => {
  const f = frozenContext(transcript, { maxResult: 20 });
  assert.match(f.prompt, /CHECKIN\.rendered\.md/);
  assert.deepEqual(f.steps.map(s => s.tool), ['Bash', 'Read', 'Grep']);
  assert.match(f.steps[1].result, /RATE_OK=1/);
  assert.equal(f.steps[2].result.length < 50, true, 'a long result is cut to maxResult');
  assert.match(f.steps[2].result, /\[cut \d+ chars\]/);
  assert.deepEqual(f.dropped.map(d => d.why).sort(), ['action', 'action', 'action', 'harness tool']);
  assert.ok(!f.text.includes('dispatching relief now') && !f.text.includes('I will dispatch'));
  assert.ok(f.text.includes('RATE_OK=1') && f.text.includes('C:/s/STATUS.md'));
});

test('isActionCall: meta write verbs, ledger appends and file writes are actions; reads are not', () => {
  for (const c of ['node norn.mjs run --lane a', 'norn rec add question --lane a', 'node norn.mjs rec apply Q-1 --refs DEC-2',
    'norn rec supersede DIR-1 --by DIR-2', 'norn runs review RUN-3 --refs X', 'node norn.mjs stop RUN-4 --as controller',
    'echo "- meta x" >> C:/p/progress.md', 'Add-Content -Path C:/p/progress.md -Value $line', 'norn rec park L:x --why w'])
    assert.ok(isActionCall('Bash', { command: c }), c);
  assert.ok(isActionCall('Write', { file_path: 'x' }) && isActionCall('Edit', { file_path: 'x' }));
  for (const c of ['node norn.mjs runs --unreviewed', 'norn rec list --open --kind DIR', 'tail -40 progress.md', 'norn rec show Q-1', 'norn runs show RUN-1'])
    assert.equal(isActionCall('Bash', { command: c }), null, c);
});

const ev = (seq, kind, evn, id, run, data, by = 'checkin', ts = '2026-11-08T10:00:00Z') => ({ v: 1, seq, ts, id, kind, ev: evn, by, run, data });
const runEvs = [
  ev(1, 'run', 'start', 'RUN-1', null, { kind: 'checkin', lane: 'checkin', worktree: 'C:/m' }, 'launcher'),
  ev(2, 'run', 'start', 'RUN-2', 'RUN-1', { kind: 'codex', executor: 'codex-sol', lane: 'relief', stage: 'S1', effort: 'medium', worktree: 'C:/m-relief' }, 'launcher'),
  ev(3, 'run', 'review', 'RUN-0', 'RUN-1', { refs: ['DEC-1'] }),
  ev(4, 'run', 'kill', 'RUN-7', 'RUN-1', { why: 'idle' }),
  ev(5, 'run', 'start', 'RUN-8', 'RUN-1', { kind: 'checkin', lane: 'checkin' }, 'launcher'),   // the next tick: scheduler, not a ruling
  ev(6, 'run', 'start', 'RUN-9', 'RUN-1', { kind: 'delegate', executor: 'grok', lane: 'x' }, 'launcher'),   // a helper ask = exploration
];
const recEvs = [
  ev(1, 'decision', 'create', 'DEC-1', 'RUN-1', { lane: 'relief', question: 'q', choice: 'c' }),
  ev(2, 'question', 'create', 'Q-1', 'RUN-1', { lane: 'door', title: 't', class: 'iii' }),
  ev(3, 'question', 'apply', 'Q-0', 'RUN-1', { refs: ['DEC-1'] }),
  ev(4, 'decision', 'create', 'DEC-2', 'RUN-5', { lane: 'other' }),
];

test('baselineActions = the records and run events the check-in wrote (run = its id), reviews kept apart', () => {
  const b = baselineActions(recEvs, runEvs, 'RUN-1');
  assert.deepEqual(b.actions.map(a => a.type).sort(), ['decision', 'dispatch', 'kill', 'question', 'record']);
  assert.deepEqual(b.actions.find(a => a.type === 'dispatch'), { type: 'dispatch', lane: 'relief', stage: 'S1', executor: 'codex-sol', effort: 'medium', worktree: 'C:/m-relief', id: 'RUN-2' });
  assert.deepEqual(b.actions.find(a => a.type === 'record'), { type: 'record', op: 'apply', id: 'Q-0' });
  assert.deepEqual(b.reviewed, ['RUN-0']);
});

const ctx = { liveWorktrees: ['c:/m-busy'], liveLanes: ['busy'], alive: { claude: 1, codex: 1, sol: 1, astra: 0 },
  caps: { claude: 2, codex: 2, sol: 2, astra: 0 }, paused: ['frozen'], rateOk: true };

test('scoreTick classes: missing dispatch recoverable, effort-only mismatch harmless, record op harmless', () => {
  const s = scoreTick([{ type: 'dispatch', lane: 'a', executor: 'codex-sol', effort: 'medium' }, { type: 'dispatch', lane: 'b', executor: 'codex-sol', effort: 'medium' },
    { type: 'record', op: 'apply', id: 'Q-1' }], [{ type: 'dispatch', lane: 'b', executor: 'codex-sol', effort: 'low' }], ctx);
  assert.equal(s.agree, false);
  const by = Object.fromEntries(s.items.map(i => [i.key, i.class]));
  assert.deepEqual(by, { 'dispatch:a': 'recoverable', 'dispatch:b': 'harmless', 'record:apply:Q-1': 'harmless' });
  assert.equal(s.worst, 'recoverable');
});

test('scoreTick harmful: wrong worktree writer, paused lane, RATE_OK=0 claude, past the cap, owner-only ask ruled', () => {
  const one = (cand, base = [], c = ctx) => scoreTick(base, cand, c).items.filter(i => i.class === 'harmful').map(i => i.why);
  assert.match(one([{ type: 'dispatch', lane: 'busy', executor: 'codex-sol' }]).join(), /worktree writer/);
  assert.match(one([{ type: 'dispatch', lane: 'n', executor: 'codex-sol', worktree: 'C:\\m-busy' }]).join(), /worktree writer/);
  assert.match(one([{ type: 'dispatch', lane: 'frozen', executor: 'codex-sol' }]).join(), /paused/);
  assert.match(one([{ type: 'dispatch', lane: 'n', executor: 'claude' }], [], { ...ctx, rateOk: false }).join(), /RATE_OK/);
  assert.match(one([{ type: 'dispatch', lane: 'n', executor: 'codex-astra' }]).join(), /cap/);
  assert.match(one([{ type: 'dispatch', lane: 'n', executor: 'codex-sol' }, { type: 'dispatch', lane: 'm', executor: 'codex-sol' }]).join(), /cap/);
  assert.match(one([{ type: 'decision', lane: 'door', choice: 'merge it' }], [{ type: 'question', lane: 'door', class: 'iii' }]).join(), /owner-only/);
  assert.deepEqual(one([{ type: 'decision', lane: 'door' }], [{ type: 'question', lane: 'door', class: 'ii' }]), [], 'a DIR-47 delegated class is ruled, not asked');
  assert.deepEqual(one([{ type: 'dispatch', lane: 'n', executor: 'codex-sol' }]), [], 'one sol slot is free');
});

test('tickContext: live runs at the tick start, caps from the budget, paused lanes, RATE_OK from the frozen text', () => {
  const evs = [
    ev(1, 'run', 'start', 'RUN-2', null, { kind: 'codex', executor: 'codex-sol', lane: 'relief', worktree: 'C:/M-Relief' }, 'launcher', '2026-11-08T09:00:00Z'),
    ev(2, 'run', 'start', 'RUN-3', null, { kind: 'claude', executor: 'claude', lane: 'dx12', worktree: 'C:/dx' }, 'launcher', '2026-11-08T09:10:00Z'),
    ev(3, 'run', 'end', 'RUN-3', null, {}, 'launcher', '2026-11-08T09:50:00Z'),
    ev(4, 'run', 'start', 'RUN-4', null, { kind: 'checkin', executor: 'claude', lane: 'checkin', worktree: 'C:/m' }, 'launcher', '2026-11-08T10:00:00Z'),
    ev(5, 'run', 'start', 'RUN-5', null, { kind: 'claude', executor: 'claude', lane: 'late', worktree: 'C:/late' }, 'launcher', '2026-11-08T11:00:00Z'),
    ev(6, 'run', 'start', 'RUN-6', null, { kind: 'claude', executor: 'claude', lane: 'trees', worktree: 'C:/t' }, 'launcher', '2026-11-08T09:20:00Z'),
    ev(7, 'run', 'end', 'RUN-6', null, {}, 'launcher', '2026-11-08T10:00:00Z'),   // its end woke this tick (same second): not live
  ];
  const c = tickContext(evs, { at: '2026-11-08T10:00:00Z', budget: { max_claude_workers: 3, max_codex: 2, max_sol: 2, max_astra: 0, lanes: { x: { executor: 'paused' } } }, text: 'RATE_OK=0' });
  assert.deepEqual(c.liveLanes, ['relief']);
  assert.deepEqual(c.liveWorktrees, ['c:/m-relief']);
  assert.deepEqual(c.alive, { claude: 0, codex: 1, sol: 1, astra: 0 });
  assert.deepEqual(c.caps, { claude: 3, codex: 2, sol: 2, astra: 0 });
  assert.deepEqual(c.paused, ['x']);
  assert.equal(c.rateOk, false);
  const late = [...evs, ev(8, 'run', 'end', 'RUN-2', null, {}, 'launcher', '2026-11-08T10:00:13Z')];   // ended while the check-in ran
  assert.deepEqual(tickContext(late, { at: '2026-11-08T10:00:00Z', until: '2026-11-08T10:05:00Z' }).liveLanes, [], 'an end the check-in could see');
  assert.deepEqual(tickContext(late, { at: '2026-11-08T10:00:00Z' }).liveLanes, ['relief'], 'no until = the tick start');
});

test('sampleTicks: acted ticks stratified by action type up to the cap, plus idle ticks, inside the window', () => {
  const evs = [], recs = [];
  for (let i = 0; i < 20; i++) {
    const id = `RUN-${100 + i}`, ts = `2026-11-08T${String(i).padStart(2, '0')}:00:00Z`;
    evs.push(ev(i * 3, 'run', 'start', id, null, { kind: 'checkin' }, 'launcher', ts));
    evs.push(ev(i * 3 + 1, 'run', 'end', id, null, { transcript: `C:/t/${id}.jsonl`, usage: { cache_read_input_tokens: 1000 } }, 'launcher', ts));
    if (i % 4 === 0) evs.push(ev(i * 3 + 2, 'run', 'start', `RUN-${200 + i}`, id, { kind: 'codex', lane: 'l' }, 'launcher', ts));
    else if (i % 4 === 1) recs.push(ev(i, 'decision', 'create', `DEC-${i}`, id, { lane: 'l' }, 'checkin', ts));
  }
  evs.push(ev(99, 'run', 'start', 'RUN-1', null, { kind: 'checkin' }, 'launcher', '2026-11-01T00:00:00Z'));
  const s = sampleTicks(evs, recs, { sinceMs: Date.parse('2026-11-08T00:00:00Z'), maxActed: 6, idle: 3 });
  const acted = s.filter(t => t.acted), idle = s.filter(t => !t.acted);
  assert.equal(acted.length, 6);
  assert.equal(idle.length, 3);
  assert.deepEqual([...new Set(acted.map(t => t.stratum))].sort(), ['decision', 'dispatch']);
  assert.equal(acted.filter(t => t.stratum === 'dispatch').length, 3, 'round-robin over strata');
  assert.ok(s.every(t => t.transcript && t.id !== 'RUN-1'));
  assert.equal(s[0].cacheR, 1000);
  const all = sampleTicks(evs, recs, { sinceMs: 0, maxActed: 1e9, idle: 1e9 });
  assert.equal(all.length, 20, 'idle >= the idle pool takes every idle tick once');
  assert.equal(new Set(all.map(t => t.id)).size, 20);
});

test('replayTick runs the candidate through its harness adapter (fake spawn) and returns its actions + usage', async () => {
  const dir = mkTmp('ckeval-');
  let seen;
  const spawn = async (cmd, input) => {
    seen = { cmd, input };
    return { code: 0, stdout: J({ result: '{"actions":[{"type":"dispatch","lane":"relief","executor":"codex-sol"}]}', session_id: 's', total_cost_usd: 0.5,
      usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 900, output_tokens: 40 } }) };
  };
  const r = await replayTick({ executor: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', prompt: 'CONTEXT', dir, tag: 'RUN-1', spawn, exe: 'claude' });
  assert.ok(seen.cmd.args.includes('--tools') && seen.cmd.args[seen.cmd.args.indexOf('--tools') + 1] === '', 'no tools');
  assert.ok(!seen.cmd.args.includes('--remote-control'));
  assert.equal(seen.cmd.args[seen.cmd.args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.equal(seen.input, 'CONTEXT', 'the frozen context goes on stdin (no 32k command line limit)');
  assert.equal(r.actions[0].lane, 'relief');
  assert.equal(r.usage.cache_write, 900);
  assert.equal(r.cost_usd, 0.5);
  assert.ok(fs.existsSync(path.join(dir, 'RUN-1.claude-sonnet-5-5-medium.out.json')));
});

test('norn eval checkin: refuses a live state, replays a state copy through a fake spawn, writes only under --out, resumes', async () => {
  const { evalCmd } = await import('../engine/lib/eval/cli.mjs');
  const d = mkTmp('ckeval-cli-'), st = path.join(d, 'state'), out = path.join(d, 'out');
  fs.mkdirSync(st);
  const tx = path.join(d, 't.jsonl');
  fs.writeFileSync(tx, transcript);
  const evs = [ev(1, 'run', 'start', 'RUN-1', null, { kind: 'checkin' }, 'launcher', '2026-11-08T10:00:00Z'),
    ev(2, 'run', 'end', 'RUN-1', null, { transcript: tx, usage: { cache_read_input_tokens: 5 } }, 'launcher', '2026-11-08T10:05:00Z'),
    ev(3, 'run', 'start', 'RUN-2', 'RUN-1', { kind: 'codex', executor: 'codex-sol', lane: 'relief', stage: 'S1', effort: 'medium' }, 'launcher', '2026-11-08T10:03:00Z')];
  fs.writeFileSync(path.join(st, 'runs.jsonl'), evs.map(J).join('\n') + '\n');
  fs.writeFileSync(path.join(st, 'records.jsonl'), '');
  const before = fs.readdirSync(st).sort();
  const lines = [], errs = [];
  const o = { out: s => lines.push(s), err: s => errs.push(s), now: Date.parse('2026-11-08T12:00:00Z'), liveStates: [path.join(d, 'live')] };
  assert.equal(await evalCmd(['checkin', '--state', path.join(d, 'live'), '--out', out], o), 2);
  let calls = 0;
  const spawn = async () => { calls++; return { code: 0, stdout: J({ result: '```json\n{"actions":[{"type":"dispatch","lane":"relief","stage":"S1","executor":"codex-sol","effort":"medium"}]}\n```', usage: {} }) }; };
  assert.equal(await evalCmd(['checkin', '--state', st, '--out', out], { ...o, spawn }), 0);
  assert.equal(calls, 1);
  const r = fs.readFileSync(path.join(out, 'results.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(r.length, 1);
  assert.equal(r[0].score.agree, true);
  assert.deepEqual(fs.readdirSync(st).sort(), before, 'the state copy is not written');
  assert.equal(await evalCmd(['checkin', '--state', st, '--out', out], { ...o, spawn }), 0);
  assert.equal(calls, 1, 'a tick already scored for this arm is not replayed again');
});

// META-ROADMAP S3 (SPEC sec. 3 check-in duty 1): a new owner directive lands on the roadmap the SAME tick (`norn road add --from
// DIR-n` / `norn road link RM-n dir:DIR-n`); a tick that leaves it unplaced is a recoverable duty miss (it shows under Unplaced)
test('eval: new DIR -> roadmap item the same tick (road writes are actions, the baseline records them, a miss is a duty item)', () => {
  for (const c of ['node norn.mjs road add --from DIR-5 --theme RM-1', 'norn road link RM-2 dir:DIR-5', 'norn road move RM-2 --first --ref DEC-1'])
    assert.ok(isActionCall('Bash', { command: c }), c);
  for (const c of ['norn road audit', 'node norn.mjs road show RM-2', 'norn road list --json']) assert.equal(isActionCall('Bash', { command: c }), null, c);
  const at = '2026-11-08T10:00:00Z', early = '2026-11-08T09:00:00Z';
  const recs = [
    ev(10, 'item', 'create', 'RM-1', null, { title: 'Core', kind: 'theme' }, 'controller', early),
    ev(11, 'directive', 'create', 'DIR-5', null, { text: 'a new wish', via: 'chat' }, 'owner', early),
    ev(12, 'directive', 'create', 'DIR-6', null, { text: 'an old one, placed', via: 'chat' }, 'owner', early),
    ev(13, 'item', 'create', 'RM-2', null, { title: 'old', kind: 'item', parent: 'RM-1', links: ['dir:DIR-6'] }, 'controller', early),
    ev(14, 'item', 'create', 'RM-3', 'RUN-1', { title: 'a new wish', kind: 'item', parent: 'RM-1', links: ['dir:DIR-5'] }, 'checkin', at),
  ];
  const b = baselineActions(recs, runEvs, 'RUN-1');
  assert.deepEqual(b.actions.filter(a => a.op === 'road'), [{ type: 'record', op: 'road', id: 'DIR-5' }]);
  const c = tickContext(runEvs, { at, recEvs: recs });
  assert.deepEqual(c.unplacedDirs, ['DIR-5'], 'active at the tick start, no item links it yet');
  assert.deepEqual(tickContext(runEvs, { at, recEvs: recs.filter(e => e.kind !== 'item') }).unplacedDirs, [], 'no roadmap yet: no duty');
  const road = { type: 'record', op: 'road', id: 'DIR-5' };
  assert.equal(scoreTick(b.actions.filter(a => a.op === 'road'), [road], c).agree, true);
  const miss = scoreTick([road], [], c);
  assert.equal(miss.agree, false);
  assert.deepEqual(miss.items.map(i => [i.key, i.side, i.class]), [['road:DIR-5', 'duty', 'recoverable']]);
  assert.match(miss.items[0].why, /roadmap the same tick/);
  assert.equal(scoreTick([], [], c).items[0]?.side, 'duty', 'a baseline that missed it too is still a duty miss');
  assert.match(ANSWER_FORM, /"op": "[^"]*road/);
});
