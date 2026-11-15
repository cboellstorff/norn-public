// A real headless browser page for dashboard tests (norn shot's launcher, engine/lib/shot.mjs; the Chrome DevTools protocol over
// the built-in WebSocket): open(size) -> { go(url) (waits for body data-ready), ev(expr), until(expr), close() } - a timeout throws with the page's state and the test process's loop (loopwatch.mjs). browser null = skip.
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp } from './tmp.mjs';
import { mark, slowStep, loopReport } from './loopwatch.mjs';

let shotLib = null;
try { shotLib = await import('../../engine/lib/shot.mjs'); } catch { /* norn shot not on this branch */ }
export const browser = shotLib?.findBrowser?.() ?? null;
export const skipWhy = !shotLib ? 'engine/lib/shot.mjs (norn shot) is not on this branch' : !browser ? 'no Edge / Chrome / Chromium installed' : false;

export async function openPage(size = [1440, 900]) {
  const profile = mkTmp('meta-shot-'), child = shotLib.launchBrowser({ browser, profile, size });
  let port = null;
  for (let i = 0; i < 300 && !port; i++) { try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]) || null; } catch { await new Promise(r => setTimeout(r, 100)); } }
  if (!port) throw new Error('no DevTools port');
  let page = null;
  for (let i = 0; i < 100 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not yet */ } if (!page) await new Promise(r => setTimeout(r, 100)); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(), on = new Map();
  // META-CI-WORKCLASS R2 (DEC-332): the page's own story, kept for a timeout's message - console errors, uncaught exceptions /
  // unhandled rejections (Runtime.exceptionThrown), browser log errors (a failed module load) and the requests still in flight
  const story = { errors: [], net: new Map() }, note = t => { story.errors.push(t.slice(0, 300)); if (story.errors.length > 20) story.errors.shift(); };
  const watch = {
    'Runtime.consoleAPICalled': p => { if (p.type === 'error' || p.type === 'warning' || p.type === 'assert') note(`console.${p.type}: ${p.args.map(a => a.value ?? a.description ?? a.type).join(' ')}`); },
    'Runtime.exceptionThrown': p => note(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`),
    'Log.entryAdded': p => { if (p.entry.level === 'error') note(`log: ${p.entry.text} ${p.entry.url ?? ''}`); },
    'Network.requestWillBeSent': p => story.net.set(p.requestId, { url: p.request.url, t0: Date.now() }),
    'Network.loadingFinished': p => story.net.delete(p.requestId),
    'Network.loadingFailed': p => { const r = story.net.get(p.requestId); if (r) note(`request failed: ${r.url} ${p.errorText}`); story.net.delete(p.requestId); },
  };
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); return; }
    if (m.method && watch[m.method]) watch[m.method](m.params);
    if (m.method && on.has(m.method)) { on.get(m.method)(m.params); on.delete(m.method); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Log.enable');
  const pageState = async m => {
    const st = await Promise.race([ev(`JSON.stringify({ href: location.href, readyState: document.readyState, dataset: { ...document.body?.dataset }, error: document.querySelector('#error')?.textContent || null })`),
      new Promise(r => setTimeout(() => r('(the page did not answer Runtime.evaluate in 5 s: its main thread is blocked)'), 5000))]);
    const now = Date.now(), pending = [...story.net.values()].map(r => `${r.url.replace(/^https?:\/\/[^/]+/, '')} (${now - r.t0} ms)`);
    return `page: ${st}
pending: ${pending.join(', ') || 'none'}
errors: ${story.errors.join(' | ') || 'none'}
${await loopReport(m)}`;
  };
  // a timeout FAILS with the page's state (the limit is the caller's; nothing here retries or waits longer)
  const until = async (expr, ms = 15000, m = mark()) => { const t0 = Date.now(); for (;;) { const v = await ev(expr); if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`until(${expr}) still falsy after ${ms} ms (last value ${JSON.stringify(v)})
${await pageState(m)}`); await new Promise(r => setTimeout(r, 100)); } };
  return {
    send, ev, until,
    async go(url, ms = 15000) {
      const m = mark(), t0 = Date.now(), loaded = new Promise(r => on.set('Page.loadEventFired', () => r(true)));
      story.net.clear(); story.errors.length = 0; await send('Page.navigate', { url });
      if (!await Promise.race([loaded, new Promise(r => setTimeout(() => r(false), ms))])) throw new Error(`go(${url}): no load event in ${ms} ms
${await pageState(m)}`);
      // META-CI-WORKCLASS R3: the stall is intermittent - a slow go() (> 2 s, or a loop gap > 500 ms) that still made it also says whose time it was (stderr, CI log)
      try { const v = await until('document.body.dataset.ready', Math.max(0, ms - (Date.now() - t0)), m);
        await slowStep(m, `go(${url})`); return v; }
      catch (e) { throw new Error(`go(${url}): body.dataset.ready not set in ${ms} ms
${e.message}`); }
    },
    async close() { try { ws.close(); } catch { /* the socket is already closed: nothing to do, the browser is closed next */ } return shotLib.closeBrowser(child, profile, { dir: path.dirname(path.dirname(profile)) }); },
  };
}
