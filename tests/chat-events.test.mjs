// META-CONTROLLER C0 (SPEC sec. 8): the streams recorded on the real login (tests/fixtures/chat, see its README) replay
// through the adapters' chatEvents parser into Norn's normalised chat events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { adapterFor } from '../engine/lib/harness/index.mjs';

const fx = name => fs.readFileSync(new URL(`./fixtures/chat/${name}`, import.meta.url), 'utf8');
const replay = (family, name) => fx(name).split('\n').flatMap(l => adapterFor(family).chatEvents(l));
const kinds = (evs, k) => evs.filter(e => e.kind === k);

test('chatEvents claude: one long-lived stream-json process, 3 turns, one session, the chat MCP connected', () => {
  const evs = replay('claude', 'claude-stream.jsonl');
  const sessions = kinds(evs, 'session');
  assert.equal(new Set(sessions.map(s => s.session_id)).size, 1);
  assert.deepEqual(sessions[0].mcp, [{ name: 'norn', status: 'connected' }]);
  assert.equal(sessions[0].permission_mode, 'default');
  const turns = kinds(evs, 'turn');
  assert.equal(turns.length, 3);
  assert.ok(turns.every(t => t.ok && t.session_id === sessions[0].session_id && t.cost_usd > 0));
  assert.deepEqual(kinds(evs, 'text').map(t => t.text).filter(t => t === 'OK' || t === '3'), ['OK', '3']);
  assert.ok(kinds(evs, 'usage').every(u => u.ctx > 0) && kinds(evs, 'usage').length > 0);
});

test('chatEvents claude: the MCP tool call, its result and the permission decision of the prompt tool', () => {
  const evs = replay('claude', 'claude-stream.jsonl');
  const call = kinds(evs, 'tool').find(t => t.name === 'mcp__norn__norn_status');
  assert.ok(call, 'tool call mcp__norn__norn_status');
  const res = kinds(evs, 'result').find(r => r.id === call.id);
  assert.equal(res.is_error, false);
  assert.match(res.text, /STATUS\.md/);
  assert.deepEqual(res.permission, { decision: 'accept', source: 'user_temporary' });
  // the --permission-prompt-tool side: the stub norn_approve was called for exactly that tool use
  const asked = fx('claude-approvals.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(asked.map(a => [a.args.tool_name, a.args.tool_use_id, a.verdict.behavior]), [['mcp__norn__norn_status', call.id, 'allow']]);
});

test('chatEvents claude: a killed session resumed by id keeps the conversation', () => {
  const first = kinds(replay('claude', 'claude-stream.jsonl'), 'session')[0].session_id;
  const evs = replay('claude', 'claude-resume.jsonl');
  assert.ok(kinds(evs, 'session').every(s => s.session_id === first));
  assert.deepEqual(kinds(evs, 'text').map(t => t.text), ['PLUM-7342']);
  assert.deepEqual(kinds(evs, 'turn').map(t => [t.ok, t.session_id]), [[true, first]]);
});

test('chatEvents codex: exec --json refused for quota = a session and a failed turn with the reason', () => {
  const evs = replay('codex', 'codex-exec-quota.jsonl');
  assert.deepEqual(kinds(evs, 'session').map(s => s.session_id), ['01a1d420-966c-7de2-9272-3403684f5b19']);
  const turns = kinds(evs, 'turn');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].ok, false);
  assert.match(turns[0].error, /usage limit/);
  assert.equal(kinds(evs, 'text').length, 0);
});
