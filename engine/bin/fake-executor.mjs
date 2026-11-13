#!/usr/bin/env node
// The FAKE executor (`norn run --executor fake`): stands in for a headless claude worker in tests and `norn smoke`.
// The brief drives it, one "key: value" per line: mode (done | stopped | handoff | handoff-once | no-marker | crash | sleep | term | orphan),
// say (a line on stderr = the run log), cache_read (the final's cache_read_input_tokens, default 20), ms (wait before finishing), read (files read at the end, logged in NOTES; one missing = STOPPED), until (file: finish once it exists - no clock; a test releases it), pids (file: {pid, grandchild} - sleep mode spawns a grandchild so a tree kill can be checked).
// It appends a NOTES block ending in the mode's marker and prints a claude-like `--output-format json` result on stdout.
// FAKE_RESULT=<file> (env): a read-only agent's answer - its text is the final `result` and no NOTES block is written (META-ADOPT A2: a canned draft).
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const arg = n => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
const brief = Object.fromEntries(fs.readFileSync(arg('brief'), 'utf8').split(/\r?\n/).map(l => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
const notes = arg('notes');
const resumes = Number(arg('resumes') || 0);
// a nudge (META-GTP-MAIL): --resume <sid> --prompt <mail> = the same session resumed; it follows brief.resumed_mode (default done), no until
const resumeSid = arg('resume'), resumePrompt = arg('prompt');
let mode = resumeSid ? (brief.resumed_mode || 'done') : (brief.mode || 'done');
if (mode === 'handoff-once') mode = resumes === 0 ? 'handoff' : 'done';
const ms = Number(brief.ms || process.env.FAKE_MS || (mode === 'sleep' ? 60000 : 0));

// NORN-WATCH S5: orphan = a short-lived parent starts a detached sleeper and exits first (a shot tool's headless browser)
if (mode === 'orphan' && brief.pids) {
  const inner = `const g = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' }); g.unref(); require('fs').writeFileSync(${JSON.stringify(brief.pids)}, JSON.stringify({ orphan: g.pid, parent: process.pid }));`;
  spawnSync(process.execPath, ['-e', inner], { stdio: 'ignore', windowsHide: true });
}
if (mode === 'sleep' && brief.pids) {
  const g = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore' });
  // atomic: a test reads the file the moment it exists, and a stop can kill this process mid-write (an empty pids file)
  fs.writeFileSync(brief.pids + '.tmp', JSON.stringify({ pid: process.pid, grandchild: g.pid }));
  fs.renameSync(brief.pids + '.tmp', brief.pids);
}

// a provider run (META-EXEC-S1): say which endpoint reached the child, never the key itself
if (process.env.ANTHROPIC_BASE_URL) process.stderr.write(`fake: provider base_url=${process.env.ANTHROPIC_BASE_URL} model=${process.env.ANTHROPIC_MODEL ?? '-'} token=${process.env.ANTHROPIC_AUTH_TOKEN ? 'set' : 'unset'}\n`);

if (brief.say) process.stderr.write(brief.say + '\n');   // a log line (e.g. a usage-limit message)
// env: NAME,.. = log those env vars as the run saw them (OOTB-R2 N-16: what the supervisor hands the agent)
for (const k of (brief.env || '').split(',').map(x => x.trim()).filter(Boolean)) process.stderr.write(`fake env ${k}=${process.env[k] ?? ''}\n`);
const finishRun = () => {
  // `read`: files (comma-separated) the worker reads at its end, as a live worker reads its rules late (META-ONBOARD cut-over test);
  // each is logged in NOTES, one that does not resolve = STOPPED
  const reads = (brief.read || '').split(',').map(x => x.trim()).filter(Boolean).map(r => { try { return `read ${r}: ${fs.readFileSync(r).length} bytes`; } catch (e) { return `read ${r}: FAILED ${e.code}`; } });
  if (reads.some(r => r.includes(': FAILED '))) mode = 'stopped';
  if (notes && reads.length) fs.appendFileSync(notes, reads.join('\n') + '\n');
  const marker = { done: '## DONE', sleep: '## DONE', orphan: '## DONE', stopped: '## STOPPED: c - fixture says so', handoff: '## HANDOFF\nnext: the fake step', 'no-marker': '## fake notes\nno end marker' }[mode];
  const resumed = resumeSid ? `resumed session ${resumeSid} prompt: ${resumePrompt}\n` : '';
  const canned = process.env.FAKE_RESULT ? fs.readFileSync(process.env.FAKE_RESULT, 'utf8') : null;
  if (notes && marker && canned === null) fs.appendFileSync(notes, `## fake ${process.env.META_RUN_ID || ''} (resumes ${resumes})\n${resumed}work\n${marker}\n`);
  process.stdout.write(JSON.stringify({ type: 'result', is_error: mode === 'crash', result: canned ?? `fake ${mode}`, session_id: process.env.META_SESSION_ID || null,
    total_cost_usd: 0, usage: { input_tokens: 10, cache_read_input_tokens: Number(brief.cache_read ?? 20), cache_creation_input_tokens: 30, output_tokens: 5 } }));
  process.exitCode = mode === 'crash' ? 3 : mode === 'term' ? 143 : 0;   // term: an external SIGTERM's exit code (S5)
};
// `until`: live until the test releases the run (or stops it) - event-based, so a loaded machine cannot outrun a fixed clock
if (brief.until && !resumeSid) { const t = setInterval(() => { if (fs.existsSync(brief.until)) { clearInterval(t); finishRun(); } }, 50); }
else setTimeout(finishRun, ms);
