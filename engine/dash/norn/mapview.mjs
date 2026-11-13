// The live Map engine (META-VISUAL-B S2; ported from VISUAL-A2 norn/mapview.mjs). A look (well.mjs / tapestry.mjs) builds
// the scene from /api/map; this file owns the pixel stage, the live events (the state stream's records, fire time = record
// ts, see live.mjs), render on change only (live.mjs createLoop: no idle loop, hidden = nothing, QUIET = one static frame,
// reduced motion = no travel), DOM labels on whole texels placed with candidates (live.mjs placeLabels), picking, pan (drag /
// wheel) + 3 zoom steps over a FITTED camera (live.mjs fitView), and the motion strip for shots.
// One stage (one WebGL context) per mount: a refetch with a new picture rebuilds the scene in it; the same picture costs nothing.
import { createStage, THREE } from './stage.mjs';
import { P } from './pixel.mjs';
import { graphOf, framePlan, nextFire, wakeIn, createLoop, placeLabels, fitView, sceneSig } from './live.mjs';

const hash = (i, k) => { const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };

export function createMap(host, look, { map, events, flags, theme, onPick }) {
  const el = document.createElement('div'); el.className = 'map-stage'; host.append(el);
  const stage = createStage(el, look.stage), { scene, camera } = stage;
  const labelsEl = document.createElement('div'); labelsEl.className = 'map-labels'; el.append(labelsEl);
  const C = { spark: new THREE.Color(P.spark), thread: new THREE.Color(P.thread), gold: new THREE.Color(P.gold), glow: new THREE.Color(P.wellglow), aqua: new THREE.Color(P.aqua), ember: new THREE.Color(P.ember) };
  const v = new THREE.Vector3();
  let B = null, selected = null, sig = null, zoom = 1, fitted = null;

  const mkPts = (n, size) => {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false })); p.layers.set(1); p.frustumCulled = false; g.setDrawRange(0, 0); return p;
  };
  function disposeScene() {
    scene.traverse(o => { o.geometry?.dispose(); for (const m of [].concat(o.material || [])) { m.map?.dispose(); m.dispose(); } });
    scene.clear(); scene.fog = null; scene.background = null; labelsEl.textContent = '';
  }
  // (re)build the scene from one /api/map answer
  function build(mapData, th) {
    disposeScene(); theme = th;
    const graph = graphOf(mapData), ctx = { THREE, scene, stage, graph, theme, P, col: n => new THREE.Color(P[n] || n) };
    const L = look.build(ctx);
    stage.setEdge(theme === 'dark' ? P.void : P['bark-deep']);
    stage.setBloom(theme === 'light' ? (look.stage.bloom ?? 0.9) * 0.45 : (look.stage.bloom ?? 0.9));   // day keeps less bloom
    const knots = L.knots, base = new Map([...knots].map(([id, m]) => [id, { s: m.scale.x, e: m.material.emissiveIntensity ?? 1 }]));
    const thr = L.threads || new Map(), thrBase = new Map([...thr].map(([id, m]) => [id, m.emissiveIntensity ?? 1]));
    const running = [...knots.keys()].filter(id => graph.by.get(id)?.cls === 'running');
    const sparks = mkPts(256, look.sparkPx || 3), motes = mkPts(512, look.motePx || 2); scene.add(sparks, motes);
    const lbls = (L.labels || []).map(l => { const e = document.createElement('div'); e.className = `lbl ${l.cls || ''}`; e.innerHTML = l.html; if (l.id) e.dataset.id = l.id; labelsEl.append(e); return { ...l, el: e }; });
    B = { L, graph, knots, base, thr, thrBase, running, sparks, motes, lbls, curves: new WeakMap(), pick: [...knots.values(), ...(L.pickExtra || [])] };
    fit(); measure();
  }
  // the camera: the look's direction, FITTED to the look's frame points at zoom 1 (the crown and every stake on screen)
  function fit() {
    const c = B.L.camera; Object.assign(stage.view, { dir: c.dir, up: c.up, target: c.target.clone(), texel: c.texel });
    if (B.L.frame) {
      const { W, H } = stage.size, f = fitView(B.L.frame, c.dir.toArray(), c.up.toArray(), W, H, { axis: B.L.fit === 'x' ? 'x' : 'both' });
      stage.view.texel = f.texel; stage.view.target.fromArray(f.target);
    }
    fitted = stage.view.texel; stage.setZoom(zoom);
  }
  const resolve = id => id === '*running' ? B.running : B.knots.has(id) ? [id] : [];
  function curveOf(e) {
    if (B.curves.has(e)) return B.curves.get(e);
    const c = e.type === 'edge' ? (B.knots.has(e.to) ? B.L.path({ ...e, edge: { to: e.to } }) : null) : B.L.path(e);
    B.curves.set(e, c); return c;
  }

  function draw(rt, still = flags.quiet) {
    if (!B) return false;
    const { knots, base, thr, thrBase, sparks, motes, L } = B;
    for (const [id, m] of knots) { const b = base.get(id); m.scale.setScalar(b.s); if (m.material.emissiveIntensity != null) m.material.emissiveIntensity = b.e * (id === selected ? 2.2 : 1); }
    for (const [id, m] of thr) m.emissiveIntensity = thrBase.get(id);
    const plan = framePlan(events.list, rt, { quiet: still, reduced: flags.reduced }, resolve);
    for (const [id, p] of plan.pulses) { const k = knots.get(id), b = base.get(id); k.scale.setScalar(b.s * p.scale); if (k.material.emissiveIntensity != null) k.material.emissiveIntensity = Math.max(k.material.emissiveIntensity, b.e + p.glow); }
    const sp = sparks.geometry.attributes, mo = motes.geometry.attributes; let ns = 0, nm = 0;
    for (const { e, id, a } of plan.motes) { // 5 motes rise from the knot (embers / fireflies)
      const p = L.pos(id);
      for (let q = 0; q < 5 && nm < 512; q++, nm++) {
        const ang = hash(e.i, q) * 6.283, r = 0.4 + hash(e.i, q + 9) * 1.6;
        mo.position.setXYZ(nm, p.x + Math.cos(ang) * r * a * 2, p.y + 0.6 + a * (2.5 + hash(e.i, q + 3) * 3), p.z + Math.sin(ang) * r * a * 2);
        const c = a < 0.35 ? C.spark : a < 0.7 ? (e.type === 'error' ? C.ember : C.thread) : C.gold; mo.color.setXYZ(nm, c.r, c.g, c.b);
      }
    }
    for (const { e, u } of plan.sparks) { // the shuttle: a head + 5-point trail along the path
      const cu = curveOf(e); if (!cu) continue;
      for (let q = 0; q < 6 && ns < 256; q++, ns++) {
        cu.getPoint(Math.max(0, u - q * 0.035), v); sp.position.setXYZ(ns, v.x, v.y, v.z);
        const c = q === 0 ? C.spark : q < 3 ? (e.type === 'edge' ? C.glow : C.thread) : (e.type === 'edge' ? C.aqua : C.gold); sp.color.setXYZ(ns, c.r, c.g, c.b);
      }
    }
    for (const [id, f] of plan.glow) { const m = thr.get(id); if (m) m.emissiveIntensity = thrBase.get(id) + 1.1 * Math.exp(-(rt - f) / 2.5 * 2); }
    sp.position.needsUpdate = sp.color.needsUpdate = mo.position.needsUpdate = mo.color.needsUpdate = true;
    sparks.geometry.setDrawRange(0, ns); motes.geometry.setDrawRange(0, nm);
    stage.render();
    return plan.moving;
  }
  const loop = createLoop({ draw, flags, pending: rt => nextFire(events.list, rt), wake: rt => wakeIn(events.list, rt), hidden: () => document.hidden });

  // ---------- labels (DOM, body font, whole texels): measured while shown, placed by priority with candidate offsets ----------
  function measure() {
    for (const l of B.lbls) { l.el.hidden = false; l.el.style.transform = 'translate(-9999px, 0)'; }
    for (const l of B.lbls) { l.w = l.el.offsetWidth; l.h = l.el.offsetHeight; }   // 0 while the host is not laid out: placed as hidden, re-measured on resize
  }
  function place() {
    if (!B) return;
    const W = el.clientWidth, H = el.clientHeight, at = B.lbls.map(l => { const s = l.w ? stage.toScreen(l.pos) : null; return { x: s?.x, y: s?.y, w: l.w, h: l.h, prio: l.prio, cands: l.cands }; });
    placeLabels(at, W, H).forEach((p, i) => { const l = B.lbls[i]; l.el.hidden = p.hidden; if (!p.hidden) l.el.style.transform = `translate(${p.x}px, ${p.y}px)`; });
  }
  const repaint = () => { place(); loop.invalidate(); };

  // ---------- input ----------
  const ray = new THREE.Raycaster();
  const hit = ev => { if (!B) return null; ray.setFromCamera(stage.ndc(ev), camera); const h = ray.intersectObjects(B.pick, true)[0]; let o = h?.object; while (o && !o.userData.id) o = o.parent; return o?.userData.id; };
  let drag = null;
  stage.canvas.addEventListener('pointerdown', ev => { drag = { x: ev.clientX, y: ev.clientY, moved: 0 }; stage.canvas.setPointerCapture(ev.pointerId); });
  stage.canvas.addEventListener('pointermove', ev => {
    if (drag) { const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) >= stage.size.cssK) { drag.moved += Math.abs(dx) + Math.abs(dy); stage.panBy(dx, dy); drag.x = ev.clientX; drag.y = ev.clientY; repaint(); } return; }
    stage.canvas.style.cursor = hit(ev) ? 'pointer' : 'grab';
  });
  stage.canvas.addEventListener('pointerup', ev => { const d = drag; drag = null; if (d && d.moved < 4) { const id = hit(ev); if (id) onPick?.(id); } });
  stage.canvas.addEventListener('wheel', ev => { ev.preventDefault(); stage.panBy(-ev.deltaX * 0.6, -ev.deltaY * 0.6); repaint(); }, { passive: false });
  labelsEl.addEventListener('click', ev => { const e = ev.target.closest('.lbl[data-id]'); if (e) onPick?.(e.dataset.id); });
  let lastW = 0, lastH = 0;
  const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); if (!r.width || (r.width === lastW && r.height === lastH)) return; lastW = r.width; lastH = r.height; stage.resize(); if (B) { fit(); measure(); } repaint(); });
  ro.observe(el);
  const onVis = () => { if (document.hidden) loop.hide(); else loop.invalidate(); };
  document.addEventListener('visibilitychange', onVis);

  // busiest n-second window of the stored events (the motion strip starts there)
  function busiest(n) { const e = events.list; let best = 0, at = e[0]?.f ?? 0; for (let i = 0, j = 0; i < e.length; i++) { while (e[j].f < e[i].f - n) j++; if (i - j > best) { best = i - j; at = Math.max(0, e[j].f - 0.2); } } return { at, count: e.length ? best + 1 : 0 }; }

  const api = {
    el,
    // a new /api/map answer: rebuild only when the picture changed (same picture = nothing at all)
    update(mapData, th = theme) { const s = sceneSig(mapData, th); if (s === sig) return false; sig = s; build(mapData, th); repaint(); return true; },
    // new events in the store: no frame now - one timer until the first fires (a frame now would show nothing new)
    poke() { loop.poke(); },
    // the mount moved into a fresh host (the tab re-rendered): re-attach, same stage
    attach(h) { if (el.parentElement !== h) h.append(el); },
    select(id, keepClear = 0) { // keepClear: CSS px at the right covered by the drawer - pan (whole texels) until the knot is clear of it
      selected = id; if (!B) return; for (const l of B.lbls) l.el.classList.toggle('sel', l.id === id);
      const p = id && (B.knots.get(id)?.position || B.L.pos(id)), s = p && stage.toScreen(p), w = el.clientWidth - keepClear;
      if (s && (s.x > w - 140 || s.x < 60)) stage.panBy(-(s.x - Math.min(w - 220, w * 0.66)), 0);
      repaint(); },
    setQuiet(q) { if (flags.quiet === !!q) return; loop.setQuiet(q); },
    setReduced(r) { if (flags.reduced === !!r) return; flags.reduced = !!r; loop.invalidate(); },
    zoom(z) { zoom = z; stage.setZoom(z); repaint(); }, get zoomLevel() { return zoom; },
    seek(t) { draw(t, false); place(); },
    strip(n = 8, step = 0.25) { // n frames step s apart from the busiest window -> one PNG: a W/2 x H/2 texel crop around the
      // focus of the look, enlarged 2x by whole texels (nearest), 4 frames per row, captioned
      const { at } = busiest(n * step), { W, H } = stage.size, cw = W >> 1, ch = H >> 1, cols = 4, rows = Math.ceil(n / cols), pad = 16;
      const fo = B.L.stripFocus ? (v.copy(B.L.stripFocus).project(camera), { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H }) : { x: W / 2, y: H / 2 };
      const sx = Math.max(0, Math.min(W - cw, Math.round(fo.x - cw / 2))), sy = Math.max(0, Math.min(H - ch, Math.round(fo.y - ch / 2)));
      const c = document.createElement('canvas'); c.width = cols * cw * 2; c.height = rows * (ch * 2 + pad); const x = c.getContext('2d');
      x.fillStyle = P.void; x.fillRect(0, 0, c.width, c.height); x.imageSmoothingEnabled = false;
      for (let i = 0; i < n; i++) { draw(at + i * step, false); const cx = (i % cols) * cw * 2, cy = Math.floor(i / cols) * (ch * 2 + pad); x.drawImage(stage.canvas, sx, sy, cw, ch, cx, cy + pad, cw * 2, ch * 2);
        x.fillStyle = P.snow; x.font = '11px Segoe UI, sans-serif'; x.fillText(`t = ${(i * step).toFixed(2)} s  (${new Date(at * 1000 + i * step * 1000).toISOString().slice(11, 22)}Z)`, cx + 4, cy + 12); }
      loop.invalidate();
      return c.toDataURL('image/png');
    },
    busy(n = 4) { return busiest(n); },
    info() { const { W, H, k } = stage.size; return { W, H, k, texel: +(stage.view.texel / zoom).toFixed(4), fitted, events: events.list.length, frames: loop.frames, idle: loop.idle, quiet: !!flags.quiet, reduced: !!flags.reduced, labels: B ? B.lbls.filter(l => !l.el.hidden).length : 0, of: B ? B.lbls.length : 0 }; },
    dispose() { loop.dispose(); ro.disconnect(); document.removeEventListener('visibilitychange', onVis); disposeScene(); stage.dispose(); el.remove(); },
  };
  api.update(map, theme);
  return api;
}
