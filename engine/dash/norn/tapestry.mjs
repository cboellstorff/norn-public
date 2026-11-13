// The Tapestry (flat, SNES-style; ported from VISUAL-A2 norn-tapestry/look.mjs) - the Map's selectable DENSE view (META-VISUAL-B
// S2): its camera fits the width and anchors the top, so a long weave pans down. The record hangs as a woven tapestry. Each
// lane is a weft row; its runs are knots tied along it, the newest at the right edge (the fell - where the weaving is
// happening now). The Norns' band runs along the top; a dispatch drops a spark down the warp to the row it touches. Flat
// ambient light, chunky texels (k = 4).
import { THREE } from './stage.mjs';
import { weave, threadMat, labelSet, mkKnot, clothTexture, polyPath } from './weave.mjs';

export const look = {
  stage: { base: 4, bloom: 0.8, thr: 0.66, dither: 0.11, edgeK: 1.0, creaseK: 0.1 },
  sparkPx: 2, motePx: 1,
  build({ scene, graph, theme, P, col }) {
    const dark = theme === 'dark', W = weave(graph), knots = new Map(), threads = new Map(), at = new Map(), pickExtra = [];
    scene.background = col(dark ? 'void' : 'linen');
    scene.add(new THREE.AmbientLight(0xffffff, dark ? 3.1 : 2.1)); // day: the parchment ground needs less light or the threads clip to the spark colour
    const ROW = 2.2, TOP = -7, X0 = -40, X1 = 40, n = W.lanes.length, bottom = TOP - n * ROW - 3;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(X1 - X0 + 12, -bottom + 8), new THREE.MeshLambertMaterial({ map: clothTexture(P[dark ? 'night' : 'parchment'], P[dark ? 'deep' : 'vellum'], P[dark ? 'void' : 'linen'], [(X1 - X0 + 12) / 2, (-bottom + 8) / 2]) }));
    cloth.position.set(0, bottom / 2 + 1, -1); scene.add(cloth);
    const flat = c => new THREE.MeshLambertMaterial({ color: col(c) });
    // the woven border: gold + teal blocks, a rune notch every 4 units
    const border = (x, y, w, h, c) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.6), flat(c)); m.position.set(x, y, -0.4); scene.add(m); };
    const L = X0 - 6, R = X1 + 6, T = 4, B = bottom - 1;
    border(0, T, R - L, 1.2, dark ? 'gold' : 'gold-deep'); border(0, B, R - L, 1.2, dark ? 'gold' : 'gold-deep'); border(L, (T + B) / 2, 1.2, T - B, dark ? 'gold' : 'gold-deep'); border(R, (T + B) / 2, 1.2, T - B, dark ? 'gold' : 'gold-deep');
    for (let x = L + 2; x < R - 1; x += 4) { border(x, T, 1, 0.5, 'teal'); border(x, B, 1, 0.5, 'teal'); }
    for (let y = B + 2; y < T - 1; y += 4) { border(L, y, 0.5, 1, 'teal'); border(R, y, 0.5, 1, 'teal'); }
    // the Norns' band: three woven emblems, the controller's knots between them
    const nornAt = {};
    [['urd', -24, 'aqua'], ['verdandi', 0, 'thread'], ['skuld', 24, 'frost']].forEach(([k, x, c]) => {
      const e = new THREE.Mesh(new THREE.OctahedronGeometry(1.5, 0), new THREE.MeshLambertMaterial({ color: col(c), emissive: col(c), emissiveIntensity: 0.25 })); e.position.set(x, -1.2, 0.2); e.scale.set(1, 1.3, 0.4); scene.add(e); nornAt[k] = e.position.clone();
    });
    border(0, TOP + 1.6, X1 - X0 + 6, 0.35, dark ? 'dusk' : 'ink');
    W.checkins.forEach((k, i) => { const m = mkKnot(k, k.faded ? 0.5 : 0.75, true); m.position.set(8 + i * 4, -1.2, 0.4); scene.add(m); knots.set(k.id, m); at.set(k.id, m.position); });
    // lanes: weft rows; knots newest-right
    W.lanes.forEach((l, i) => {
      const y = TOP - i * ROW, mat = threadMat(l, theme);
      const weft = new THREE.Mesh(new THREE.BoxGeometry(X1 - X0, l.live ? 0.5 : 0.32, 0.3), mat); weft.position.set((X0 + X1) / 2, y, 0); scene.add(weft);
      const tab = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 0.5), new THREE.MeshLambertMaterial({ color: col(l.live ? 'thread' : dark ? 'slate' : 'linen'), emissive: col('gold'), emissiveIntensity: l.live ? 0.3 : 0 }));
      tab.position.set(X0 - 1, y, 0.1); tab.userData.id = l.node.id; scene.add(tab); pickExtra.push(tab); at.set(l.node.id, tab.position.clone());
      l.knots.forEach((k, j) => { const m = mkKnot(k, j === 0 ? 0.75 : 0.5, true); m.position.set(X1 - 4 - j * 7, y, 0.4); scene.add(m); knots.set(k.id, m); at.set(k.id, m.position); threads.set(k.id, mat); });
    });
    const pos = id => at.get(id) || new THREE.Vector3();
    return {
      knots, threads, pos, pickExtra, stripFocus: new THREE.Vector3(X1 - 14, TOP - 9, 0),
      path(e) {
        const a = pos(e.id).clone().setZ(0.9);
        if (e.type === 'edge') { const b = pos(e.edge.to).clone().setZ(0.9); return polyPath([a, new THREE.Vector3(b.x + 2, a.y, 0.9), new THREE.Vector3(b.x + 2, b.y, 0.9), b]); }
        return polyPath([a, new THREE.Vector3(X1 + 4, a.y, 0.9)]); // the shuttle leaves along the weft
      },
      labels: [...labelSet(W, pos, l => at.get(l.node.id), { stakeCands: () => [[-12, 0, 'right'], [-12, -12, 'right']], knotDx: 12 }),
        ...Object.entries(nornAt).map(([k, p]) => ({ pos: p.clone().setY(p.y - 2.6), html: k.toUpperCase(), cls: 'norn', prio: 0, cands: [[0, 0, 'center']] }))],
      camera: { target: new THREE.Vector3(0, -18, 0), dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0), texel: 0.2 },
      frame: [[L - 22, T + 1, 0], [R + 1, T + 1, 0], [L - 22, B, 0], [R + 1, B, 0]], fit: 'x',
    };
  },
};
