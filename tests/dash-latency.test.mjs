// dash-latency (owner 2026-11-18: "why norn can be slow to respond sometimes"): the page's render is not a request waterfall, one
// render fetches a URL once, and a render a newer one overtook never paints. Sandbox only: the shared dash fixture and a private
// headless browser; the page's fetch is wrapped so the test sees when each request starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

// every request the page sends from now on: { u, t0 } (page clock); a URL matching slow waits `ms` before it goes out
const wrap = (slow, ms) => `(() => { window.__req = []; const of = window.__of ??= window.fetch, re = new RegExp(${JSON.stringify(slow)});
  window.fetch = async (u, ...a) => { window.__req.push({ u: String(u), t0: performance.now() }); if (re.test(String(u))) await new Promise(r => setTimeout(r, ${ms})); return of(u, ...a); }; return true; })()`;
const tap = id => `(() => { document.body.dataset.ready = ''; document.querySelector('#tab-${id}').click(); return true; })()`;

test('the browser: a tab render fetches the header and the tab at once, and /api/overview once', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage();
  try {
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes'`, 90000), 'Lanes painted');
    // the header's /api/overview is held 800 ms: the Inbox's own request must not wait behind it
    await pg.ev(wrap('/api/overview\\?', 800)); await pg.ev(tap('inbox'));
    assert.ok(await pg.until(`document.body.dataset.ready === 'inbox'`, 30000), 'Inbox painted');
    const r = await pg.ev('window.__req'), ov = r.find(x => x.u.startsWith('/api/overview?')), ib = r.find(x => x.u.startsWith('/api/inbox?'));
    assert.ok(ov && ib, JSON.stringify(r));
    assert.ok(ib.t0 - ov.t0 < 400, `the Inbox request went out ${Math.round(ib.t0 - ov.t0)} ms after the header's: a waterfall`);
    // the Overview tab reads /api/overview too: one request serves the header and the tab
    await pg.ev(wrap('^$', 0)); await pg.ev(tap('overview'));
    assert.ok(await pg.until(`document.body.dataset.ready === 'overview'`, 30000), 'Overview painted');
    const o = (await pg.ev('window.__req')).filter(x => x.u.startsWith('/api/overview?'));
    assert.equal(o.length, 1, JSON.stringify(o));
  } finally { await pg.close(); await f.done(); }
});

test('the browser: a slow render that a click overtook does not paint over the newer tab', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage();
  try {
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes'`, 90000), 'Lanes painted');
    await pg.ev(wrap('/api/records\\?', 1500)); await pg.ev(tap('history'));   // History waits 1.5 s on its records ...
    await new Promise(r => setTimeout(r, 200));
    await pg.ev(tap('inbox'));                                                   // ... and Inbox is tapped meanwhile
    assert.ok(await pg.until(`document.body.dataset.ready === 'inbox'`, 30000), 'Inbox painted');
    await new Promise(r => setTimeout(r, 2000));                                 // the records fetch has answered by now
    const st = await pg.ev(`JSON.stringify({ ready: document.body.dataset.ready, tab: document.body.dataset.tab, error: document.querySelector('#error')?.textContent || '',
      inbox: /choose a relief model/.test(document.querySelector('#main #panel-inbox')?.textContent ?? ''), history: !!document.querySelector('#main #panel-history') })`);
    assert.deepEqual(JSON.parse(st), { ready: 'inbox', tab: 'inbox', error: '', inbox: true, history: false });
  } finally { await pg.close(); await f.done(); }
});
