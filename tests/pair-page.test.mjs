// META-PAIR-LOOK R1: the pairing page (engine/dash/pair.html) in Norn's own look. An unpaired device may load ONLY this page and
// the claim endpoint (C6, tests/remote.test.mjs), so everything the page needs (the font, the mark, the panel) is inlined - the
// page asks the server for nothing but POST /api/remote/claim. Rendered at 390 (phone, both grounds): no sideways scroll, the
// pixel font loaded from the page itself, the code field monospaced and large, the panel framed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE } from './helpers/dash-fixture.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const PAGE = path.join(ENGINE, 'dash', 'pair.html');

test('pair page: self-contained - no same-origin asset (src, href, url(), import), the one fetch is the claim', () => {
  const h = fs.readFileSync(PAGE, 'utf8');
  assert.doesNotMatch(h, /\b(?:src|href)\s*=\s*["']?\/(?!\/)/, 'no src / href to a server path');
  assert.doesNotMatch(h, /url\(\s*["']?\/(?!\/)/, 'no CSS url() to a server path');
  assert.doesNotMatch(h, /\bimport\b[^;\n]*['"]\//, 'no module import from the server');
  assert.deepEqual([...h.matchAll(/fetch\(\s*'([^']+)'/g)].map(m => m[1]), ['/api/remote/claim']);
  assert.match(h, /font-family:\s*'Silkscreen';\s*src:\s*url\(data:font\/woff2;base64,/, 'the pixel font inlined');
  assert.match(h, /id="pair-code"/);
});

let shotLib = null;
try { shotLib = await import('../engine/lib/shot.mjs'); } catch { /* norn shot not on this branch */ }
const browser = shotLib?.findBrowser?.() ?? null;
test('pair page at 390 x 844 (phone, both grounds) and 1440: scrollWidth == width, Silkscreen loaded, framed panel, a large monospaced code field', {
  skip: !shotLib ? 'engine/lib/shot.mjs is not on this branch' : !browser ? 'no Edge / Chrome / Chromium installed' : false, timeout: 120000 }, async () => {
  const { launchBrowser, killTree, killProfileProcs, removeProfile } = shotLib;
  const profile = mkTmp('meta-shot-');
  const child = launchBrowser({ browser, profile, size: [390, 844] });
  let ws;
  try {
    const port = await shotLib.waitDevToolsPort({ browser, profile, child });
    let page = null;
    for (let i = 0; i < 100 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not yet */ } if (!page) await new Promise(r => setTimeout(r, 100)); }
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pend = new Map(), on = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } else if (m.method && on.has(m.method)) { on.get(m.method)(m.params); on.delete(m.method); } };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
    const measure = async (w, h, ground, mobile) => {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: ground }] });
      const loaded = new Promise(r => on.set('Page.loadEventFired', r));
      await send('Page.navigate', { url: pathToFileURL(PAGE).href });
      await loaded;
      return ev(`document.fonts.ready.then(() => { const code = getComputedStyle(document.getElementById('pair-code')), main = getComputedStyle(document.querySelector('main'));
        return { sw: document.documentElement.scrollWidth, w: innerWidth, ground: document.documentElement.dataset.ground, font: [...document.fonts].some(f => /Silkscreen/.test(f.family) && f.status === 'loaded'),
          frame: main.borderImageSource.startsWith('url("data:image/png'), codeFont: code.fontFamily, codeSize: parseFloat(code.fontSize) }; })`);
    };
    await send('Page.enable'); await send('Runtime.enable');
    for (const ground of ['dark', 'light']) {
      const m = await measure(390, 844, ground, true);
      assert.equal(m.w, 390); assert.equal(m.sw, m.w, `${ground}: no sideways scroll at 390 (${JSON.stringify(m)})`);
      assert.equal(m.ground, ground, JSON.stringify(m)); assert.equal(m.font, true, `${ground}: Silkscreen loaded (${JSON.stringify(m)})`);
      assert.equal(m.frame, true, `${ground}: the panel is the Norn 9-slice frame (${JSON.stringify(m)})`);
      assert.match(m.codeFont, /monospace/); assert.ok(m.codeSize >= 24, JSON.stringify(m));
    }
    const d = await measure(1440, 900, 'dark', false);
    assert.equal(d.sw, 1440, JSON.stringify(d));
  } finally {
    try { ws?.close(); } catch { /* closed */ }
    await killTree(child); await killProfileProcs(profile); await removeProfile(profile); fs.rmSync(path.dirname(path.dirname(profile)), { recursive: true, force: true });
  }
});
