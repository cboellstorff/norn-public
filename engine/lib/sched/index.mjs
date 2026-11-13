// Scheduler adapters (META-GENERAL-DESIGN D13): each turns { name, interval_min, node, meta, home, user?, command? } into a plan
// { files [{path, content, encoding?}], install [argv], remove [argv] } and runs it through an injectable io { run, write, rm }
// (tests / WSL proofs inject; the default io touches the real machine). `rm <file>` steps go to io.rm, not a process.
import { realIo, LEGACY_NAME, schedName, schedState, normDir } from './common.mjs';
import win from './win.mjs';
import systemd from './systemd.mjs';
import cron from './cron.mjs';
import launchd from './launchd.mjs';

export { realIo, LEGACY_NAME, schedName, schedState, normDir };
export const ADAPTERS = { 'windows-task': win, systemd, cron, launchd };
export function adapterFor(kind) {
  const a = ADAPTERS[kind];
  if (!a) throw new Error(`no scheduler adapter for ${JSON.stringify(kind)} (${Object.keys(ADAPTERS).join(' | ')}): set machine.json scheduler.kind to one of them, or run "norn tick --reason schedule" every <interval_min> min from your own scheduler`);
  return a;
}
