// `norn eval checkin` (META-GT3): replay sampled check-ins of a COPY of a state dir on a candidate executor; results.jsonl +
// per-tick files under --out. Reads the state copy and the recorded transcripts only; writes only under --out.
import fs from 'node:fs';
import path from 'node:path';
import { frozenContext, baselineActions, sampleTicks, evalPrompt, replayTick, scoreTick, tickContext, findBudget, summarize } from './checkin.mjs';

export const EVAL_USAGE = 'norn eval checkin --state <COPY of a state dir> --out <dir> [--executor claude|codex-sol|codex-astra|<provider>] [--model M] [--effort E] [--exe F] [--since-h 48] [--until ISO] [--acted 30] [--idle 12] [--ticks RUN-a,RUN-b] [--max-calls N] [--concurrency 3] [--dry]    (--dry = sample + frozen-context sizes, no calls)';
const FLAGS = ['state', 'out', 'executor', 'model', 'effort', 'exe', 'since-h', 'until', 'acted', 'idle', 'ticks', 'max-calls', 'concurrency', 'dry!'];

export const readJsonl = f => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

function parse(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], k = a.replace(/^--/, '');
    if (!a.startsWith('--')) throw new Error(`unexpected ${a}`);
    if (FLAGS.includes(k + '!')) { f[k] = true; continue; }
    if (!FLAGS.includes(k)) throw new Error(`unknown flag ${a}`);
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    f[k] = argv[++i];
  }
  return f;
}

/** -> exit code. o.spawn / o.now for tests. */
export async function evalCmd(argv, { out = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n'), spawn, now = Date.now(), liveStates = [] } = {}) {
  let f;
  try {
    if (argv[0] !== 'checkin') throw new Error(argv[0] ? `unknown eval subcommand ${argv[0]}` : 'eval needs checkin');
    f = parse(argv.slice(1));
    if (!f.state || !f.out) throw new Error('--state and --out are required');
    const st = path.resolve(f.state), o = path.resolve(f.out);
    if (liveStates.some(s => path.resolve(s).toLowerCase() === st.toLowerCase())) throw new Error(`--state ${st} is a LIVE state dir: copy it first`);
    if ((o + path.sep).toLowerCase().startsWith(st.toLowerCase() + path.sep)) throw new Error('--out must not be inside --state');
  } catch (e) { err('error: ' + e.message); err('usage: ' + EVAL_USAGE); return 2; }
  const st = path.resolve(f.state), outDir = path.resolve(f.out);
  const runEvs = readJsonl(path.join(st, 'runs.jsonl')), recEvs = readJsonl(path.join(st, 'records.jsonl'));
  if (fs.existsSync(path.join(st, 'roadmap.jsonl'))) recEvs.push(...readJsonl(path.join(st, 'roadmap.jsonl')));   // META-ROADMAP S3: the same-tick duty
  const untilMs = f.until ? Date.parse(f.until) : now, sinceMs = untilMs - Number(f['since-h'] ?? 48) * 3600e3;
  let ticks = sampleTicks(runEvs, recEvs, { sinceMs, untilMs, maxActed: Number(f.acted ?? 30), idle: Number(f.idle ?? 12) });
  if (f.ticks) {
    const want = new Set(f.ticks.split(',').map(s => s.trim()));
    ticks = sampleTicks(runEvs, recEvs, { sinceMs: 0, untilMs: Infinity, maxActed: 1e9, idle: 1e9 }).filter(t => want.has(t.id));
  }
  const executor = f.executor || 'claude', model = f.model || 'claude-sonnet-5-5', effort = f.effort || 'medium', arm = `${executor}:${model}:${effort}`;
  fs.mkdirSync(outDir, { recursive: true });
  const resFile = path.join(outDir, 'results.jsonl');
  const done = new Set(fs.existsSync(resFile) ? readJsonl(resFile).filter(r => r.arm === arm && !r.error).map(r => r.tick) : []);
  const todo = ticks.filter(t => !done.has(t.id) && fs.existsSync(t.transcript)).slice(0, Number(f['max-calls'] ?? Infinity));
  out(`eval checkin ${arm}: ${ticks.length} sampled (${ticks.filter(t => t.acted).length} acted), ${done.size} done, ${todo.length} to run`);
  const jobs = todo.map(t => async () => {
    const fr = frozenContext(fs.readFileSync(t.transcript, 'utf8'));
    const ctx = tickContext(runEvs, { at: t.ts, until: t.end, budget: findBudget(fr) || {}, text: fr.text, recEvs });
    const line = `${t.id} ${t.ts} ${t.stratum} steps ${fr.steps.length} dropped ${fr.dropped.length}${fr.truncated ? ' TRUNCATED' : ''} chars ${fr.text.length} base [${t.actions.map(a => a.type).join(',')}]`;
    if (f.dry) { out(line); return; }
    const r = await replayTick({ executor, model, effort, prompt: evalPrompt(fr), dir: path.join(outDir, 'ticks'), tag: t.id, exe: f.exe, spawn });
    const score = r.error ? null : scoreTick(t.actions, r.actions, ctx);
    const row = { tick: t.id, ts: t.ts, arm, stratum: t.stratum, base: t.actions.map(({ question, ...a }) => a), cand: r.actions, nothing: r.nothing, error: r.error,
      score, ctx, usage: r.usage, cost_usd: r.cost_usd, base_cacheR: t.cacheR, chars: fr.text.length, steps: fr.steps.length, dropped: fr.dropped.length };
    fs.appendFileSync(resFile, JSON.stringify(row) + '\n');
    out(`${line} -> ${r.error ? 'ERROR ' + r.error : score.agree ? 'AGREE' : 'DIFF ' + score.worst}`);
  });
  const n = Math.max(1, Number(f.concurrency ?? 3));
  await Promise.all(Array.from({ length: n }, async () => { while (jobs.length) await jobs.shift()(); }));
  if (!f.dry && fs.existsSync(resFile)) for (const r of summarize(readJsonl(resFile))) out(JSON.stringify(r));
  return 0;
}
