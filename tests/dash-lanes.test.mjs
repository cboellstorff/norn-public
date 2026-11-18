// RM-19 S1: the Lanes page shows what is live first - group order, done ages, the Old fade, the filter chips (URL), one-tap
// Archive with Undo, and the owner's archive that "did not take effect" (a guard refusal wiped by the next live re-render).
// Sandbox only: the shared dash fixture (temp dirs), fixture git repos and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { record } from '../engine/lib/records.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo, file, text, msg) => { fs.writeFileSync(path.join(repo, file), text); g(repo, 'add', file); g(repo, 'commit', '-q', '-m', msg); return g(repo, 'rev-parse', 'HEAD'); };
// a deliverable on lane seabed whose branch is not merged into main: archiveGuard refuses `lane archive` on seabed
function unmergedDlv(f) {
  const repo = f.pa.root;
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'commit.gpgsign', 'false'); commit(repo, 'README.md', 'r', 'init');
  g(repo, 'checkout', '-q', '-b', 'feat/s'); commit(repo, 's.txt', 's', 'feat: s'); g(repo, 'checkout', '-q', 'main');
  record(f.pa.state, { kind: 'deliverable', ev: 'create', by: 'controller', data: { repo, branch: 'feat/s', lane: 'seabed', delivers: 'the seabed' } }, { views: false });
}
// wait for the next paint of the Lanes page: a mark on the row is gone once #main is painted again
const repainted = async (pg, lane) => { await pg.ev(`document.querySelector('#lane-${lane}') && (document.querySelector('#lane-${lane}').dataset.mark = '1')`);
  return pg.until(`document.body.dataset.ready === 'lanes' && !document.querySelector('#lane-${lane}[data-mark]')`, 60000); };

test('the browser: a refused Archive keeps its reason on the row through a live re-render (the owner\'s archive that did not take effect)', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage();
  try {
    unmergedDlv(f);
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && !!document.querySelector('[data-act=archive][data-lane=seabed]')`, 90000), 'Lanes shows seabed with Archive');
    await pg.ev(`window.confirm = () => true; document.querySelector('[data-act=archive][data-lane=seabed]').click()`);
    assert.ok(await pg.until(`!!document.querySelector('#lane-seabed')`, 30000), 'the refused lane is back on the page');
    record(f.pa.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'poke the stream', via: 'chat' } });
    assert.ok(await repainted(pg, 'seabed'), 'the stream re-renders the page');
    assert.match(await pg.ev(`document.querySelector('#lane-seabed .lane-refused')?.textContent ?? ''`), /cannot be archived/, 'the refusal is still on the row');
  } finally { await pg.close(); await f.done(); }
});
