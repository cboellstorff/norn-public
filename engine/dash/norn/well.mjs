// The Well (HD-2D; ported from VISUAL-A2 norn-well/look.mjs, META-VISUAL-B S2): the Well of Urd beneath Yggdrasil, seen from
// a tilted orthographic camera. The three Norns stand at the well; every lane is a thread spun out of the well across the
// ground to its stake; runs are beads on it, the newest nearest the well (just spun). Check-ins are the beads the Norns hold;
// their dispatch / review sparks arc over the water.
// S2 fixes: the camera is FITTED to the crown + the stake ring (`frame`; A2's fixed texel cropped the crown at 1080p), the
// Norn names reserve their place first instead of overlapping knot labels, every stake carries a label (name + state word
// + questions) that sits outward from the ring; archived lanes stay off the ring unless the map's toggle asks for them.
import { THREE } from './stage.mjs';
import { weave, threadMat, tube, labelSet, mkKnot } from './weave.mjs';

export const look = {
  stage: { base: 3, bloom: 1.0, thr: 0.6, dither: 0.085, edgeK: 0.9 },
  sparkPx: 3, motePx: 2,
  build({ scene, stage, graph, theme, P, col }) {
    const dark = theme === 'dark', W = weave(graph), knots = new Map(), threads = new Map(), at = new Map(), pickExtra = [];
    scene.background = col(dark ? 'void' : 'snow');
    scene.fog = new THREE.Fog(col(dark ? 'night' : 'snow'), 222, 262);
    stage.renderer.shadowMap.enabled = true; stage.renderer.shadowMap.type = THREE.BasicShadowMap; stage.renderer.shadowMap.autoUpdate = false; stage.renderer.shadowMap.needsUpdate = true;
    scene.add(new THREE.HemisphereLight(col(dark ? 'slate' : 'snow'), col(dark ? 'bark-deep' : 'oak'), dark ? 2.2 : 1.3));
    const sun = new THREE.DirectionalLight(col(dark ? 'frost' : 'spark'), dark ? 3.2 : 2.0); sun.position.set(-30, 50, 24); sun.castShadow = true;
    Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 140 }); sun.shadow.mapSize.set(1024, 1024); scene.add(sun);
    const wellLight = new THREE.PointLight(col('wellglow'), dark ? 12 : 6, 22, 1.6); wellLight.position.set(0, 3, 0); scene.add(wellLight);

    // ground, well, tree
    const ground = new THREE.Mesh(new THREE.CircleGeometry(70, 40), new THREE.MeshStandardMaterial({ color: col(dark ? 'moss-deep' : 'leaf'), roughness: 1, flatShading: true }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
    const stone = new THREE.MeshStandardMaterial({ color: col(dark ? 'dusk' : 'frost'), roughness: 0.9, flatShading: true });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(6.6, 0.9, 5, 20), stone); rim.rotation.x = -Math.PI / 2; rim.position.y = 0.7; rim.castShadow = rim.receiveShadow = true; scene.add(rim);
    const water = new THREE.Mesh(new THREE.CircleGeometry(6.0, 24), new THREE.MeshStandardMaterial({ color: col('well'), emissive: col('teal'), emissiveIntensity: dark ? 0.8 : 0.35, roughness: 0.2, flatShading: true }));
    water.rotation.x = -Math.PI / 2; water.position.y = 0.55; scene.add(water);
    const bark = new THREE.MeshStandardMaterial({ color: col(dark ? 'bark' : 'wood'), roughness: 1, flatShading: true });
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.8, 24, 7), bark); trunk.position.set(0, 11, -14); trunk.castShadow = true; scene.add(trunk);
    for (const [a, b] of [[-0.9, 1], [0.15, 1.2], [1.1, 0.9], [-2.2, 0.8], [2.4, 0.7]]) // roots: one dips into the well (the Norns water it)
      { const r = tube([new THREE.Vector3(Math.sin(a) * 2.5, 2, -14 + Math.cos(a) * 1.5), new THREE.Vector3(Math.sin(a) * 6 * b, 0.6, -11 + Math.cos(a) * 2), new THREE.Vector3(Math.sin(a) * 9 * b, 0.1, -7 + Math.abs(a))], 0.9 * b, bark, 12); r.castShadow = true; scene.add(r); }
    const leaf = [col(dark ? 'moss' : 'leaf'), col(dark ? 'moss-deep' : 'moss'), col(dark ? 'teal' : 'leaf')], frame = [];
    [[0, 26, -14, 9], [-10, 23, -17, 7], [10, 24, -16, 7.5], [-5, 30, -19, 7], [6, 31, -18, 6], [0, 21, -8, 5]].forEach(([x, y, z, r], i) => {
      const c = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), new THREE.MeshStandardMaterial({ color: leaf[i % 3], roughness: 1, flatShading: true })); c.position.set(x, y, z); c.castShadow = true; c.userData.crown = true; scene.add(c);
      for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) for (const d of [-1, 0, 1]) { const l = Math.hypot(a, b, d); if (l) frame.push([x + a / l * r, y + b / l * r, z + d / l * r]); } });   // the crown sphere, 26 ways
    for (let i = 0; i < 18; i++) { const a = i * 2.39, r = 27 + (i * 7) % 14, s = 0.6 + (i % 4) * 0.35; // standing stones at the edge
      const m = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), stone); m.position.set(Math.sin(a) * r, s * 0.6, Math.cos(a) * r); m.castShadow = true; scene.add(m); }

    // the three Norns at the back of the well, by the root; each holds the controller's knots
    const robe = { urd: dark ? 'teal' : 'well', verdandi: 'gold', skuld: dark ? 'frost' : 'mist' }, nornAt = {};
    [['urd', -2.2], ['verdandi', Math.PI], ['skuld', 2.2]].forEach(([k], i) => {
      const a = Math.PI + (i - 1) * 0.62, x = Math.sin(a) * 9, z = Math.cos(a) * 9, g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.ConeGeometry(1.2, 3.6, 6), new THREE.MeshStandardMaterial({ color: col(robe[k]), roughness: 0.8, flatShading: true })); body.position.y = 1.8;
      const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 0), new THREE.MeshStandardMaterial({ color: col(dark ? 'snow' : 'parchment'), flatShading: true })); head.position.y = 3.9;
      g.add(body, head); g.position.set(x, 0, z); g.traverse(o => { if (o.isMesh) o.castShadow = true; }); scene.add(g); nornAt[k] = new THREE.Vector3(x, 0, z);
    });
    W.checkins.forEach((k, i) => { const n = nornAt[['verdandi', 'urd', 'skuld'][i % 3]], m = mkKnot(k, k.faded ? 0.45 : 0.65); m.position.set(n.x * 0.8, 5.4, n.z * 0.8 + 0.6); scene.add(m); knots.set(k.id, m); at.set(k.id, m.position); });

    // lanes: threads radiating over 300 degrees (the tree side stays open), stakes at r = 30
    const N = W.lanes.length, R0 = 7.4, R1 = 23, span = Math.PI * 2 * (300 / 360);
    for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2; frame.push([Math.sin(a) * (R1 + 3), 0, Math.cos(a) * (R1 + 3)]); }   // the stake ring + label room
    W.lanes.forEach((l, i) => { // index 0 (running first) faces the camera; older lanes wrap round to the tree
      const a = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * span / Math.max(1, N - 1), dx = Math.sin(a), dz = Math.cos(a), mat = threadMat(l, theme);
      const p0 = new THREE.Vector3(dx * R0, 0.9, dz * R0), p1 = new THREE.Vector3(dx * R1, 0.35, dz * R1);
      const t = tube([p0, p0.clone().lerp(p1, 0.5).setY(0.45), p1], l.live ? 0.17 : 0.11, mat, 10); t.receiveShadow = true; scene.add(t);
      const stake = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.8, 0.6), new THREE.MeshStandardMaterial({ color: col(l.live ? 'thread' : dark ? 'oak' : 'wood'), emissive: col('gold'), emissiveIntensity: l.live ? 0.4 : 0, flatShading: true }));
      stake.position.set(dx * (R1 + 0.6), 0.9, dz * (R1 + 0.6)); stake.castShadow = true; stake.userData.id = l.node.id; scene.add(stake); pickExtra.push(stake);
      at.set(l.node.id, stake.position.clone().setY(2.4)); l.side = dx;
      l.knots.forEach((k, j) => { const r = R0 + 2.6 + j * 2.9, m = mkKnot(k, j === 0 ? 0.62 : 0.42); m.position.set(dx * r, 0.95, dz * r); scene.add(m); knots.set(k.id, m); at.set(k.id, m.position); threads.set(k.id, mat); });
    });
    const pos = id => at.get(id) || new THREE.Vector3();
    return {
      knots, threads, pos, pickExtra, stripFocus: new THREE.Vector3(0, 1, 8),
      path(e) {
        const a = pos(e.id).clone();
        if (e.type === 'edge') { const b = pos(e.edge.to).clone(), m = a.clone().lerp(b, 0.5); m.y += 9; return new THREE.QuadraticBezierCurve3(a, m, b); }
        const out = a.clone().setY(0).normalize().multiplyScalar(R1 + 1).setY(3.5); return new THREE.QuadraticBezierCurve3(a, a.clone().lerp(out, 0.5).setY(4.5), out);
      },
      // stake labels sit outward: left of the ring = text to the left, right = to the right, the front = under the stake
      labels: [...labelSet(W, pos, l => at.get(l.node.id), { stakeCands: l => Math.abs(l.side) < 0.3
        ? [[0, 14, 'center'], [0, 30, 'center'], [8, 0, 'left'], [-8, 0, 'right']]
        : l.side < 0 ? [[-8, 0, 'right'], [-8, -14, 'right'], [-8, 14, 'right'], [0, -16, 'center']] : [[8, 0, 'left'], [8, -14, 'left'], [8, 14, 'left'], [0, -16, 'center']] }),
        ...Object.entries(nornAt).map(([k, p]) => ({ pos: p.clone().setY(-0.6), html: k.toUpperCase(), cls: 'norn', prio: 0, cands: [[0, 0, 'center'], [0, -16, 'center'], [0, 16, 'center'], [0, -32, 'center']] }))],
      camera: { target: new THREE.Vector3(0, 4, -3), dir: new THREE.Vector3(0, -Math.sin(0.68), -Math.cos(0.68)), up: new THREE.Vector3(0, 1, 0), texel: 0.15 },
      frame, fit: 'both',
    };
  },
};
