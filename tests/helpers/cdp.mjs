// A real headless browser page for dashboard tests (norn shot's launcher, engine/lib/shot.mjs; the Chrome DevTools protocol over
// the built-in WebSocket): open(size) -> { go(url) (waits for body data-ready), ev(expr), until(expr), close() }. browser null = skip.
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp } from './tmp.mjs';

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
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } else if (m.method && on.has(m.method)) { on.get(m.method)(m.params); on.delete(m.method); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  await send('Page.enable'); await send('Runtime.enable');
  const until = async (expr, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await ev(expr); if (v) return v; if (Date.now() - t0 > ms) return v; await new Promise(r => setTimeout(r, 100)); } };
  return {
    send, ev, until,
    async go(url) { const loaded = new Promise(r => on.set('Page.loadEventFired', r)); await send('Page.navigate', { url }); await loaded; return until('document.body.dataset.ready'); },
    async close() { try { ws.close(); } catch { /* the socket is already closed: nothing to do, the browser is closed next */ } return shotLib.closeBrowser(child, profile, { dir: path.dirname(path.dirname(profile)) }); },
  };
}
