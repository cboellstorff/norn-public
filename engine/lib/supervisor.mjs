// The detached run SUPERVISOR (META-GENERAL-DESIGN D7): `node supervisor.mjs <spec.json>`, started by runs.startRun.
// Spawns the executor, refreshes heartbeat + worktree lock every hbMs, records exit + outcome + usage, does the HANDOFF
// auto-resume (policy cadence auto_resume_handoff / auto_resume_max, PAUSED, weekly guard), classifies usage-limit exits (outcome
// limit, re-queued after the reset; META-GT12), fills the run queue, triggers the tick on exit.
// Port of meta/worker-run.ps1 + the launch half of codex-impl.sh. Never prompts; every failure ends as a recorded event.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { record, RecordError, loadState } from './records.mjs';
import { providerEnv, limitPatterns, authPatterns, executorInfo } from './executors.mjs';
import { classifyAuth, markAuthDown, AUTH_REQUEUE_MAX, AUTH_RESUME_PROMPT } from './authguard.mjs';
import { ADAPTERS, capsOf } from './harness/index.mjs';
import { nudgeDue, nudgePrompt, NUDGE_AFTER_MIN } from './mail.mjs';
import { buildCommand, parseOutcome, hbPath, refreshLock, releaseLock, startRun, stopOrphans, RunRefused, classifyLimit, queueRun, fillQueue, killTree } from './runs.mjs';
import { resolveShim } from './paths.mjs';
import { onRunDone } from './deliverables.mjs';
import { ingestRead } from './adopt.mjs';
import { holdJob, reapJob, reapGroup } from './jobguard.mjs';
import { usageRefusal, onAccount } from './usageguard.mjs';
import { nodeUsage } from './fed.mjs';
import { readGate, noteCheckin } from './gate.mjs';
import { ledgerStep } from './ledger.mjs';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { run, state } = spec;
const iso = () => new Date().toISOString();
const logLine = s => { try { fs.appendFileSync(spec.log, `${iso()} ${s}\n`); } catch { /* log dir gone */ } };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const TAIL = 8192;
const tail = f => { const t = read(f); return t === null ? '' : t.slice(-TAIL); };
// META-MERGELOCK: every lock the run holds (runs.writeTrees: a MERGE holds the main checkout's beside its own worktree's)
const lockFiles = spec.lockFiles ?? (spec.lockFile ? [spec.lockFile] : []);
let childPid = null;
let finished = false;
// META-ADOPT A2: a hard time cap (spec.capMs, the adopt read): the executor's tree is killed when it passes; the end says capped
let capTimer = null, capped = false;
let nudging = null, nudgeTimer = null, nudgeWaitLast = null;   // META-GTP-MAIL piece 3 (nudgeCheck)

const beat = () => {
  try {
    const f = hbPath(state, run), t = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(t, JSON.stringify({ run, pid: childPid, supervisor_pid: process.pid, ts: iso() }));
    fs.renameSync(t, f);
  } catch { /* next beat */ }
  for (const lf of lockFiles) { try { refreshLock(lf, run, { pid: process.pid }); } catch { /* next beat */ } }
};
beat();
const timer = setInterval(beat, spec.hbMs);

const env = { ...process.env };
// executor env from the project: null deletes; "${env:NAME}" expands from this process (e.g. PATH prepends); Windows keys
// are case-insensitive, so a set replaces any same-name key ("Path") instead of adding a duplicate
for (const [k, v] of Object.entries(spec.env || {})) {
  for (const old of Object.keys(env)) if (old.toUpperCase() === k.toUpperCase()) delete env[old];
  if (v !== null) env[k] = String(v).replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => process.env[n] ?? '');
}
// a typed executor: claude-compatible gets ANTHROPIC_* from its entry (openai-compatible / cli: none); the key comes from this process's env only (never the spec / a record)
if (spec.provider) for (const [k, v] of Object.entries(providerEnv(spec.provider, process.env).vars)) { if (v === null) delete env[k]; else env[k] = String(v); }
// OOTB-R2 N-16: META_RUN_STATE = the state dir of this run: META_RUN_ID / META_ROLE speak only for records of THAT state
Object.assign(env, { META_RUN_ID: run, META_RUN_STATE: path.resolve(state), META_RESUMES: String(spec.resumes || 0), ...(spec.notes ? { META_NOTES: spec.notes } : {}), ...(spec.session_id ? { META_SESSION_ID: spec.session_id } : {}) });

let cmd;
try { cmd = buildCommand(spec); } catch (e) { finish(null, null, String(e.message)); }
// NORN-WATCH S5 (DEC-683): the whole tree ends with the run - Windows: this supervisor enters a job before the executor is born
// (jobguard.mjs); POSIX: the executor leads its own process group. Check-ins are not guarded (they dispatch the workers: a worker
// must never hang on its dispatcher's job), nor is policy reap "off".
const guard = !!cmd && spec.kind !== 'checkin' && (spec.policy?.reap ?? 'job') !== 'off';
let job = null;
delete env.META_JOB;
if (guard && process.platform === 'win32') {
  const j = await holdJob(process.pid);
  // K3 round 2: process.env too - the runs THIS process starts (auto-resume, nudge, queue fill, fallback) break away from its job
  if (j.error) logLine(`reap: unguarded (${j.error})`); else { job = j; env.META_JOB = j.name; process.env.META_JOB = j.name; }
}
logLine(`start ${run} executor=${spec.executor} model=${spec.model ?? '-'} effort=${spec.effort ?? '-'} resumes=${spec.resumes || 0} brief=${spec.brief}`);
const fds = [];
const open = (f, m) => { const fd = fs.openSync(f, m); fds.push(fd); return fd; };
let child;
if (cmd) {
  try {
    const logFd = open(spec.log, 'a');
    const outFd = cmd.stdout === 'final' ? open(spec.final, 'w') : logFd;
    const inFd = cmd.stdin ? open(cmd.stdin, 'r') : 'ignore';
    const sp = resolveShim(cmd.exe, cmd.args);  // npm .cmd shim -> node + JS entry, no shell (S10)
    child = spawn(sp.exe, sp.args, { cwd: spec.worktree, env, stdio: [inFd, outFd, logFd], windowsHide: true, ...(guard && process.platform !== 'win32' ? { detached: true } : {}) });
    childPid = child.pid ?? null;
    beat();
    child.on('error', e => finish(null, null, String(e.message)));
    child.on('exit', (code, signal) => finish(code, signal, null));
    if (nudgeable()) nudgeTimer = setInterval(nudgeCheck, spec.hbMs);
    if (spec.capMs) capTimer = setTimeout(() => { capped = true; logLine(`time cap ${spec.capMs} ms: stopping the executor`); killTree(childPid); }, spec.capMs);
  } catch (e) { finish(null, null, String(e.message)); }
}

function finish(code, signal, error) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  if (nudgeTimer) clearInterval(nudgeTimer);
  if (capTimer) clearTimeout(capTimer);
  for (const fd of fds) { try { fs.closeSync(fd); } catch { /* closed */ } }
  logLine(`exit=${code}${signal ? ' signal=' + signal : ''}${error ? ' error=' + error : ''}`);
  // a read-only helper cannot write: its final message (claude json result / a cli executor's plain stdout) becomes the answer file
  if (spec.role === 'helper' && spec.notes && !(read(spec.notes) || '').trim()) {
    const raw = read(spec.final) || '';
    let text = raw;
    if (cmd?.parse === 'claude') { try { text = String(JSON.parse(raw).result ?? ''); } catch { text = ''; } }
    try { if (text.trim()) fs.writeFileSync(spec.notes, text.endsWith('\n') ? text : text + '\n'); } catch (e) { logLine(`answer not written: ${e.message}`); }
  }
  const marker = parseOutcome(spec.notes ? read(spec.notes) : null);
  // a check-in has no NOTES end marker: its outcome is its exit (S5)
  let outcome = code !== 0 ? 'crash' : spec.kind === 'checkin' ? 'done' : marker.outcome;
  // META-AUTH: a crash whose log tail / final carries the executor's auth-failure signature is `auth` (its login is down), not a crash
  let auth = null;
  try {
    if (outcome === 'crash' && cmd) auth = classifyAuth(`${tail(spec.log)}
${tail(spec.final)}`, authPatterns(spec.executor, spec.provider || (spec.auth ? { auth: spec.auth } : undefined)));
  } catch (e) { logLine(`auth patterns failed: ${e.message}`); }
  if (auth) outcome = 'auth';
  // a crash / no-marker exit whose log tail carries the executor's usage-limit signature is a `limit` (META-GT12)
  let limit = null;
  try {
    if (!auth && ['crash', 'no-marker'].includes(outcome) && cmd) limit = classifyLimit(`${tail(spec.log)}\n${tail(spec.final)}`, limitPatterns(spec.executor, spec.provider || (spec.limit ? { limit: spec.limit } : undefined)));
  } catch (e) { logLine(`limit patterns failed: ${e.message}`); }   // a broken project pattern never costs the end record
  if (limit) outcome = 'limit';
  if (nudging) { outcome = 'nudged'; limit = null; auth = null; }   // stopped by the nudge: whatever the killed tree exited with
  const data = { exit: Number.isInteger(code) ? code : null, outcome, marker_line: marker.marker_line, pid: childPid, supervisor_pid: process.pid, ...(capped ? { capped: true } : {}) };
  if (limit) { data.reset = limit.reset; data.limit_line = limit.line; }
  if (auth) { data.auth_line = auth.line; data.auth_class = auth.cls; }   // META-AUTH-VENDOR: login | vendor
  if (outcome === 'stopped') data.why = marker.why;
  if (nudging) data.nudge = nudging.mail.id;
  if (signal) data.signal = signal;
  if (error) data.error = error;
  // NORN-WATCH S5 evidence: an exit no `norn stop` explains, the worktree's uncommitted state, the branch + head it ended on
  if ((code === 143 || signal === 'SIGTERM') && !killedByMeta()) data.external_term = true;
  if (spec.worktree && spec.role !== 'helper') Object.assign(data, gitEvidence(spec.worktree));
  if (job) { const r = reapJob(job, process.pid); if (r.error) data.reap_error = r.error; else data.reaped = r.killed.length; }
  else if (guard && process.platform !== 'win32' && childPid) { const r = reapGroup(childPid); if (r.error) data.reap_error = r.error; else data.reaped = r.killed.length; }
  if (data.reaped) logLine(`reaped ${data.reaped} process(es) left in the run's tree`);
  // usage fields of the end record, by the adapter that parses this output (claude json final / codex log; cli plain: none)
  if (cmd && ADAPTERS[cmd.parse]) Object.assign(data, ADAPTERS[cmd.parse].endData({ final: spec.final, log: spec.log }));
  // META-GTP-FED-2 piece 2: a node run (claim_of) carries its usage for the home guard (fed.mjs nodeUsage; 0 for non-Claude)
  if (spec.claim_of) { try { data.node_usage = nodeUsage(data, onAccount(executorInfo(spec.executor, spec.provider))); } catch (e) { logLine(`node usage: ${e.message}`); data.node_usage = { tokens: 0, cache_read: 0 }; } }
  if (spec.session_id && spec.projectsDir) {
    try {
      for (const d of fs.readdirSync(spec.projectsDir)) {
        const t = path.join(spec.projectsDir, d, spec.session_id + '.jsonl');
        if (fs.existsSync(t)) { data.transcript = t.replace(/\\/g, '/'); break; }
      }
    } catch { /* no projects dir */ }
  }
  try { record(state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data }); }
  catch (e) {   // killed meanwhile: `norn stop` owns the cleanup
    logLine(`end not recorded: ${e.message}`);
    // CIRED-7b3d67d: swept lost meanwhile (a stall, not a death): nobody else frees its locks or fills the queue - this exit does
    if (!killedByMeta()) {
      try { fs.unlinkSync(hbPath(state, run)); } catch { /* gone */ }
      for (const lf of lockFiles) releaseLock(lf, run);
      try { for (const f of fillQueue(state)) logLine(`queue: ${f.queued} -> ${f.next}`); } catch (e2) { logLine(`queue fill failed: ${e2.message}`); }
    }
    process.exit(0);
  }
  // DELIVERABLES-SPEC 1: a DONE run's branch becomes (or refreshes) its deliverable; never fails the exit
  if (outcome === 'done') { try { const d = onRunDone(state, run); if (d) logLine(`deliverable ${d.id} ${d.ev}`); } catch (e) { logLine(`deliverable not recorded: ${e.message}`); } }
  // META-ADOPT A2: the adopt read's final becomes its proposal's draft (or one retry, or the facts-only draft); a norn stop ingests nothing
  if (spec.adopt && !killedByMeta()) {
    try { const a = ingestRead(state, spec, { capped }); logLine(`adopt ${a.id}: ${a.ev}${a.ev === 'retry' ? ' ' + a.run : ''}${a.why ? ` (${a.why})` : ''}`); }
    catch (e) { logLine(`adopt draft not ingested: ${e.message}`); }
  }
  // GTP-LEDGER: the run end (after its `end` record) is a ledger commit; a failure is logged, never the run's
  if (spec.git_ledger) { try { const n = ledgerStep(spec.git_ledger, `run end ${run} (${outcome})`); if (n) logLine(n); } catch (e) { logLine(`ledger: failed: ${e.message}`); } }
  try { fs.unlinkSync(hbPath(state, run)); } catch { /* gone */ }
  for (const lf of lockFiles) releaseLock(lf, run);
  try { const gone = stopOrphans(state); if (gone.length) logLine(`helpers stopped with the parent: ${gone.join(', ')}`); } catch (e) { logLine(`helper stop failed: ${e.message}`); }

  if (limit && spec.kind !== 'checkin' && spec.role !== 'helper') requeue(limit);
  if (auth) authExit(auth, data);
  if (spec.kind === 'checkin' && spec.fallback && (outcome !== 'done' || !(read(spec.final) || '').trim())) fallback(outcome === 'done' ? 'no final' : outcome);
  let resumed = false;
  if (outcome === 'handoff') resumed = autoResume();
  else if (outcome === 'nudged') resumed = nudgeResume();
  try { for (const f of fillQueue(state)) logLine(`queue: ${f.queued} -> ${f.next}`); } catch (e) { logLine(`queue fill failed: ${e.message}`); }
  if (!resumed && spec.tick && spec.policy?.trigger_on_exit !== false) {
    try { spawn(spec.tick[0], spec.tick.slice(1), { detached: true, stdio: 'ignore', windowsHide: true }).unref(); logLine('tick triggered'); }
    catch (e) { logLine(`tick failed: ${e.message}`); }
  }
  process.exit(0);
}

function killedByMeta() {
  try { return !!loadState(state).items[run]?.history.some(h => h.ev === 'kill'); } catch { return false; }
}

// one `git status --porcelain=v2 --branch` (5 s): { dirty: {files, untracked}, branch, head }; any failure = no fields
function gitEvidence(wt) {
  try {
    const r = spawnSync(spec.git || 'git', ['status', '--porcelain=v2', '--branch'], { cwd: wt, encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.status !== 0 || r.error) return {};
    const lines = r.stdout.split(/\r?\n/).filter(Boolean), hdr = k => lines.find(l => l.startsWith(`# branch.${k} `))?.slice(`# branch.${k} `.length);
    const out = { dirty: { files: lines.filter(l => /^[12u] /.test(l)).length, untracked: lines.filter(l => l.startsWith('? ')).length } };
    const b = hdr('head'), h = hdr('oid');
    if (b && b !== '(detached)') out.branch = b;
    if (h && /^[0-9a-f]{7,}$/.test(h)) out.head = h;
    return out;
  } catch { return {}; }
}

// a usage-limit exit runs again, same spec, once the limit resets (+2 min) or in 60 min when the reset is not in the log
function requeue(limit) {
  const notBefore = new Date(limit.reset ? Date.parse(limit.reset) + 120000 : Date.now() + 3600000).toISOString();
  try {
    const { run: _r, log: _l, final: _f, session_id: _s, lockFile: _k, fromQueue: _q, ...rest } = spec;
    logLine(`usage limit (${limit.line}) -> re-queued ${queueRun({ ...rest, notBefore, requeueOf: run }).run} not before ${notBefore}`);
  } catch (e) { logLine(`re-queue failed: ${e.message}`); }
}

// META-AUTH: the login is down - mark the harness gate (authguard.mjs: every new launch on it holds until a probe passes) and re-queue
// the work run: its own session resumed when the executor resumes by flag and the session exists (a launch that died at its first
// call has none: the same spec again). The queued run is held by the gate, not by a clock. A check-in / helper is not re-queued (the
// next tick / the parent asks again); at most AUTH_REQUEUE_MAX re-queues in a row.
function authExit(auth, data) {
  try { markAuthDown(state, { harness: executorInfo(spec.executor, spec.provider)?.harness ?? spec.executor, line: auth.line, cls: auth.cls, run }); }
  catch (e) { logLine(`auth gate not marked: ${e.message}`); }
  const n = spec.auth_requeues || 0;
  if (spec.kind === 'checkin' || spec.role === 'helper') { logLine(`auth failure (${auth.line}): not re-queued (${spec.kind === 'checkin' ? 'check-in' : 'helper'})`); return; }
  if (n >= AUTH_REQUEUE_MAX) { logLine(`auth failure (${auth.line}): not re-queued (${n}/${AUTH_REQUEUE_MAX} in a row)`); return; }
  try {
    const { run: _r, log: _l, final: _f, session_id: sid, lockFile: _k, fromQueue: _q, resumeSid: _rs, nudge: _n, ...rest } = spec;
    let c = null;
    try { c = capsOf(spec.executor, spec.provider); } catch { /* none */ }
    const resume = !!sid && !!c?.resume && c.resume_style === 'flag' && (!!data.transcript || !spec.projectsDir);
    const q = queueRun({ ...rest, ...(resume ? { resumeSid: sid, promptText: AUTH_RESUME_PROMPT } : spec.nudge ? { promptText: undefined } : {}), auth_requeues: n + 1, requeueOf: run });
    logLine(`auth failure (${auth.line}) -> re-queued ${q.run} (${resume ? 'session ' + sid + ' resumed' : 'same spec, new session'}), held until the login probe passes`);
  } catch (e) { logLine(`auth re-queue failed: ${e.message}`); }
}

// CHECKIN-V2 piece 4 (H7 trial): a trial check-in that ended non-DONE is re-run at once on its fallback executor (claude); the new
// run records fallback_of and becomes the gate baseline in its place (its own actions are then not news to the next tick)
function fallback(why) {
  const { run: _r, log: _l, final: _f, session_id: _s, lockFile: _k, fromQueue: _q, trial: _t, mcp: _m, writable_roots: _w, fallback: fb, ...rest } = spec;
  let next;
  try { next = startRun({ ...rest, ...fb, fallbackOf: run }).run; }
  catch (e) { logLine(`trial check-in ${spec.trial} ${why}: fallback failed: ${e.message}`); return; }
  logLine(`trial check-in ${spec.trial} ${why} -> fallback ${fb.executor} ${next}`);
  try {
    const g = readGate(state);
    if (g?.run === run) noteCheckin(state, { run: next, start: loadState(state).items[next]?.created, live: g.live, budget: g.caps, forced: g.forced, quiet_n: g.quiet_n });
  } catch (e) { logLine(`gate baseline not moved: ${e.message}`); }
}

function autoResume() {
  const pol = spec.policy || {};
  const count = spec.resumes || 0;
  const max = Number.isInteger(pol.auto_resume_max) ? pol.auto_resume_max : 2;
  let refused = null;
  if (pol.auto_resume_handoff === false) refused = 'auto-resume off';
  else if (count >= max) refused = `cap ${count}/${max}`;
  else if ((spec.paused || []).some(f => fs.existsSync(f))) refused = 'paused';
  else refused = usageRefusal(spec, state, { rate: false });   // the weekly guard (one home with the queue fill: usageguard.mjs)
  let next = null, spawned = null;
  if (!refused) {
    try {
      // a HANDOFF is a fresh agent on the same brief: never the nudged session or its mail prompt (META-GTP-MAIL)
      const { run: _r, log: _l, final: _f, session_id: _s, lockFile: _k, resumeSid: _rs, nudge: _n, ...rest } = spec;
      if (spec.nudge) delete rest.promptText;
      ({ run: next, spawned } = startRun({ ...rest, resumes: count + 1, resumeOf: run }));
    } catch (e) { refused = e instanceof RunRefused ? `${e.code === 3 ? 'writer' : 'worker cap'}: ${e.message}` : `error: ${e.message}`; }
  }
  try { record(state, { kind: 'run', ev: 'resume', id: run, by: 'launcher', data: next ? { next, count: count + 1, max } : { refused, count, max } }); }
  catch (e) { if (!(e instanceof RecordError)) throw e; logLine(`resume not recorded: ${e.message}`); }
  logLine(next ? `auto-resume -> ${next} (${count + 1}/${max}) ${spawned}` : `auto-resume refused: ${refused}`);
  if (next && spec.ledger) {
    const utc = new Date().toISOString().replace(/:\d\d\.\d+Z$/, 'Z');
    try { fs.appendFileSync(spec.ledger, `- auto ${utc}: lane ${spec.lane} HANDOFF -> auto-resumed (${count + 1}/${max}, same brief, ${spec.executor} ${spec.model ?? '-'} ${spec.effort ?? '-'}) ${next}\n`); }
    catch (e) { logLine(`ledger append failed: ${e.message}`); }
  }
  return !!next;
}

// ---------- META-GTP-MAIL piece 3: NUDGE (GT-PARITY-PLAN 2.7; Gas Town internal/cmd/nudge.go:49-68,267-291, internal/nudge/queue.go:68-92
// cited: they type into an idle tmux pane or queue with DeliverAfter - a headless run has no pane). An urgent mail not acked within
// policy mail.nudge_after_min on THIS running run: claim it (mail nudge, once), stop the executor's tree, end as outcome nudged and
// resume the SAME session (--resume <sid>) with the mail as the prompt - the HANDOFF auto-resume path. Never during QUIET or while
// the GPU lock is held, never when the resume would be refused (paused, the weekly guard): then it waits and checks again.
// Only a work run whose executor resumes a session by flag (caps.resume + resume_style, a session id: claude, the fake).
function nudgeable() {
  if (spec.kind === 'checkin' || spec.role === 'helper' || !spec.session_id) return false;
  try { const c = capsOf(spec.executor, spec.provider); return !!c?.resume && c.resume_style === 'flag'; } catch { return false; }
}
const afterMin = () => spec.policy?.mail?.nudge_after_min ?? NUDGE_AFTER_MIN;
function nudgeWait(why) { if (why !== nudgeWaitLast) logLine(`nudge waits: ${why}`); nudgeWaitLast = why; }
function nudgeCheck() {
  if (finished || nudging || !childPid) return;
  let due;
  try { due = nudgeDue(state, { run, afterMin: afterMin(), quiet: spec.quiet, gpuLock: spec.gpu_lock }); }
  catch (e) { nudgeWait(`mail not readable: ${e.message}`); return; }
  if (!due) return;
  const why = due.wait || ((spec.paused || []).some(f => fs.existsSync(f)) ? 'paused' : null) || usageRefusal(spec, state, { rate: false });
  if (why) { nudgeWait(`${why} (${due.mail.id})`); return; }
  try { record(state, { kind: 'mail', ev: 'nudge', id: due.mail.id, by: 'launcher', data: { run } }, { run }); }
  catch (e) { if (!(e instanceof RecordError)) throw e; logLine(`nudge ${due.mail.id} not claimed: ${e.message}`); return; }   // acked meanwhile
  nudging = { mail: due.mail, afterMin: afterMin() };
  logLine(`nudge: ${due.mail.id} (urgent, not acked in ${afterMin()} min) -> stopping the run's tree, resuming session ${spec.session_id}`);
  killTree(childPid);
}
function nudgeResume() {
  const id = nudging.mail.id;
  let next = null, refused = null;
  try {
    const { run: _r, log: _l, final: _f, session_id: sid, lockFile: _k, ...rest } = spec;
    next = startRun({ ...rest, resumeOf: run, resumeSid: sid, nudge: id, promptText: nudgePrompt(nudging.mail, nudging.afterMin) }).run;
  } catch (e) { refused = e instanceof RunRefused ? `${e.code === 3 ? 'writer' : 'worker cap'}: ${e.message}` : `error: ${e.message}`; }
  try { record(state, { kind: 'run', ev: 'resume', id: run, by: 'launcher', data: next ? { next, nudge: id } : { refused, nudge: id } }); }
  catch (e) { if (!(e instanceof RecordError)) throw e; logLine(`resume not recorded: ${e.message}`); }
  logLine(next ? `nudge ${id} -> resumed ${next} (session ${spec.session_id})` : `nudge ${id}: resume refused: ${refused}`);
  return !!next;
}
