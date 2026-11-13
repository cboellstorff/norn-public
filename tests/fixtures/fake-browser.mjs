// META-SHOT R1: a fake Chromium for `meta shot` tests. Takes the browser command line, writes DevToolsActivePort into its
// --user-data-dir like the real one, serves /json/list and a DevTools WebSocket (hand-rolled RFC 6455, text frames) on 127.0.0.1,
// answers the methods meta shot sends and logs every one (and its argv / pid) as JSON lines to FAKE_BROWSER_LOG. After Fetch.enable
// it pauses one same-origin and one foreign request (FAKE_BROWSER_FOREIGN) so the test sees which the helper fails. It runs until
// killed, and starts a child node process so a tree kill is needed.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// FAKE_BROWSER_HANDOFF=1: like Edge's Windows launcher, start the real browser detached (out of the launcher's tree) and exit 0
if (process.env.FAKE_BROWSER_HANDOFF === '1') {
  spawn(process.execPath, process.argv.slice(1), { stdio: 'ignore', detached: true, env: { ...process.env, FAKE_BROWSER_HANDOFF: '0' } }).unref();
  process.exit(0);
}
const logf = process.env.FAKE_BROWSER_LOG;
const log = o => logf && fs.appendFileSync(logf, JSON.stringify(o) + '\n');
const argv = process.argv.slice(2);
const profile = argv.find(a => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const kid = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore' });
log({ argv, pid: process.pid, child: kid.pid, profile });
fs.writeFileSync(path.join(profile, 'Local State'), '{}');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/json')) {
    const port = srv.address().port;
    res.end(JSON.stringify([{ type: 'page', id: 'P1', url: 'about:blank', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/P1` }]));
  } else { res.statusCode = 404; res.end(); }
});
const frame = s => {
  const b = Buffer.from(s); const n = b.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const x = Buffer.alloc(8); x.writeBigUInt64BE(BigInt(n)); return x; })()]);
  return Buffer.concat([head, b]);
};
srv.on('upgrade', (req, sock) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const send = o => sock.write(frame(JSON.stringify(o)));
  let buf = Buffer.alloc(0), url = 'about:blank';
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((x, i) => x ^ mask[i % 4]);
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { sock.end(); return; }
      if (op !== 1) continue;
      const m = JSON.parse(data.toString());
      log({ method: m.method, params: m.params });
      let result = {};
      if (m.method === 'Page.navigate') { url = m.params.url; setTimeout(() => send({ method: 'Page.loadEventFired', params: { timestamp: 1 } }), 20); }
      else if (m.method === 'Page.captureScreenshot') result = { data: PNG };
      else if (m.method === 'Runtime.evaluate') result = { result: { type: 'string', value: `eval@${url}` } };
      send({ id: m.id, result });
      if (m.method === 'Fetch.enable') {
        send({ method: 'Fetch.requestPaused', params: { requestId: 'R-local', request: { url: 'http://127.0.0.1:1/app.js' } } });
        send({ method: 'Fetch.requestPaused', params: { requestId: 'R-foreign', request: { url: process.env.FAKE_BROWSER_FOREIGN || 'https://login.example.com/x' } } });
      }
    }
  });
  sock.on('error', () => {});
});
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), `${srv.address().port}\n/devtools/browser/fake\n`));
