// NORN-WATCH go-live (DEC-688 (2)): a project's check-in gate also sees runs of WATCHED lanes that live in other project states
// (another project state may hold the pre-go-live meta-* runs). project.json checkin.watch_lanes ["meta-*"] -> a gate probe adding the level
// fact `xend:<project>:<RUN>:<end|lost|kill>` per watched run that ended at or before the fingerprint time. A new end wakes once;
// an end the last check-in saw does not re-wake. Other states = the machine's registered projects, as sibling state dirs.
import path from 'node:path';
import { fold, readEvents, recordsFile } from './records.mjs';

const ENDS = ['end', 'lost', 'kill'];
const globRe = g => new RegExp('^' + String(g).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

/** p: loaded project (name, state, checkin.watch_lanes); machine: { projects: [{ name }] }. Returns a gate probe or null. */
export function watchProbe(p, machine = {}) {
  const lanes = (p?.checkin?.watch_lanes || []).map(globRe);
  const others = (machine?.projects || []).map(x => x.name).filter(n => n && n !== p.name);
  if (!lanes.length || !others.length) return null;
  let ends = null;   // [{ fact, ms }] read once per probe (the gate evaluates it for the baseline and for now)
  const load = () => ends ??= others.flatMap(name => {
    let items;
    try { items = Object.values(fold(readEvents(recordsFile(path.join(path.dirname(path.resolve(p.state)), name), 'run'))).items); } catch { return []; }
    return items.filter(r => lanes.some(re => re.test(r.data?.lane || ''))).flatMap(r => {
      const h = r.history.find(x => ENDS.includes(x.ev));
      return h ? [{ fact: `xend:${name}:${r.id}:${h.ev}`, ms: Date.parse(h.ts) }] : [];
    });
  });
  return ({ at }) => load().filter(e => e.ms <= at).map(e => e.fact);
}
