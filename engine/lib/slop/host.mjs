// META-SLOP-A (REVIEW-FABLE 2.5 "he returns data, Norn writes"): the ONE writer of SloppaChoppa. The checks, the line counts and
// the sweep return result objects; hostWrite turns them into Norn's files under <state>/slop/:
//   holds.json   { [branch]: { lane, run, base, head, at, blocks, resumed? } } - a branch with BLOCK findings; the merge waits on it
//   series.json  { days: { YYYY-MM-DD: { loc, sweep } } } - the daily points (trends)
//   REPORT.md + report.json - the daily report and its one digest line; baseline-<rule>.txt - a command rule's last run on main
// Waivers are records (WVR-n, waivers.jsonl); a block is open while no active waiver covers it.
import fs from 'node:fs';
import path from 'node:path';
import { fold, readEvents, recordsFile } from '../records.mjs';
import { globToRe } from '../dlvgit.mjs';

export const slopDir = state => path.join(state, 'slop');
const readJ = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return dflt; throw e; } };
function writeJ(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(f + '.tmp', f); }
const holdsFile = state => path.join(slopDir(state), 'holds.json');

export const slopHolds = state => readJ(holdsFile(state), {});
export const slopReport = state => readJ(path.join(slopDir(state), 'report.json'), null);
export const slopSeries = state => readJ(path.join(slopDir(state), 'series.json'), { days: {} });
export const baselineOf = (state, rule) => { try { return fs.readFileSync(path.join(slopDir(state), `baseline-${rule}.txt`), 'utf8'); } catch { return null; } };

export function activeWaivers(state, now = Date.now()) {
  return Object.values(fold(readEvents(recordsFile(state, 'waiver'))).items)
    .filter(w => w.kind === 'waiver' && w.state === 'active' && !(w.data.until && Date.parse(w.data.until) <= now));
}
export const covers = (w, f) => w.data.rule === f.rule && (w.data.scope === f.fp || globToRe(w.data.scope).test(f.file));
/** the BLOCK findings that still hold a branch's merge: its last check's blocks no active waiver covers */
export function openBlocks(state, branch, { now = Date.now() } = {}) {
  const h = slopHolds(state)[branch];
  if (!h) return [];
  const ws = activeWaivers(state, now);
  return h.blocks.filter(b => !ws.some(w => covers(w, b)));
}

/**
 * The one host write. payload.type:
 *  check  { branch, lane?, run?, base, head, blocks, findings, resumed? } -> the branch's hold set (blocks) or dropped (none); -> { open }
 *  daily  { day, report (markdown), line (the digest line), point ({ loc, sweep }), baselines ({ rule: text }) } -> the report files
 */
export function hostWrite(state, payload) {
  if (payload.type === 'check') {
    const holds = slopHolds(state), { branch } = payload;
    if (!branch) return { open: payload.blocks };
    if (payload.blocks.length) holds[branch] = { lane: payload.lane ?? null, run: payload.run ?? null, base: payload.base, head: payload.head,
      at: payload.at || new Date().toISOString(), blocks: payload.blocks, ...(payload.resumed ? { resumed: payload.resumed } : {}) };
    else delete holds[branch];
    writeJ(holdsFile(state), holds);
    return { open: openBlocks(state, branch) };
  }
  if (payload.type === 'daily') {
    const dir = slopDir(state);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'REPORT.md'), payload.report);
    writeJ(path.join(dir, 'report.json'), { day: payload.day, at: new Date().toISOString(), line: payload.line });
    const s = slopSeries(state);
    s.days[payload.day] = payload.point;
    writeJ(path.join(dir, 'series.json'), s);
    for (const [rule, text] of Object.entries(payload.baselines || {})) fs.writeFileSync(path.join(dir, `baseline-${rule}.txt`), text);
    return { file: path.join(dir, 'REPORT.md') };
  }
  throw new Error(`hostWrite: unknown payload type ${payload.type}`);
}

/** one line per finding for a worker / a resume prompt */
export const findingLine = f => `${f.rule} ${f.file}${f.line ? ':' + f.line : ''} ${f.msg} [${f.fp}]`;
