// The Norn Map (META-VISUAL-B S2): the Well / Tapestry over /api/map, live events from the state stream (fire time = record
// ts), render on change only (0 frames idle), QUIET = one static frame, reduced motion = no travel, label placement without
// collisions, the camera fitted to the crown + the stake ring (A2 cropped the crown), stake labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { graphOf, weave, sceneSig, eventsOfRecords, beatOf, createEvents, framePlan, nextFire, wakeIn, createLoop, placeLabels, knotCands, fitView, inView, PULSE, MARK, LAG }
  from '../engine/dash/norn/live.mjs';
import * as THREE from '../engine/dash/vendor/three.module.js';
import { P } from '../engine/dash/norn/pixel.mjs';

// a /api/map-shaped answer: the controller band + n lanes (lane 0 running), 3 runs each, a question on lane 1
function mapOf(n = 6) {
  const nodes = [{ id: 'L:checkin', type: 'lane', lane: 'checkin', label: 'controller', cls: 'idle', x: 0, y: 8 },
    { id: 'RUN-900', type: 'checkin', lane: 'checkin', label: 'tick', cls: 'done', x: 1, y: 10 }], edges = [];
  for (let i = 0; i < n; i++) {
    const lane = `lane${i}`, y = 100 + i * 100;
    nodes.push({ id: 'L:' + lane, type: 'lane', lane, label: lane, cls: i === 0 ? 'running' : 'idle', x: 0, y });
    for (let j = 0; j < 3; j++) { const id = `RUN-${100 + i * 3 + j}`; nodes.push({ id, type: 'run', lane, label: `name-${i}-${j}`, cls: i === 0 && j === 0 ? 'running' : j === 0 && i === 2 ? 'handoff' : 'done', faded: j > 0, x: 1, y: y + j * 10 }); edges.push({ from: 'L:' + lane, to: id, kind: 'owns' }); }
    if (i === 1) nodes.push({ id: 'Q-1', type: 'question', lane, label: 'Q-1', cls: 'needs', x: 3, y });
  }
  edges.push({ from: 'RUN-900', to: 'RUN-100', kind: 'dispatched' });
  return { nodes, edges };
}
const ts = s => new Date(s * 1000).toISOString();

test('graph + weave: running lanes first, run knots only (questions counted on the lane), the controller apart; one picture = one sig', () => {
  const W = weave(graphOf(mapOf()));
  assert.equal(W.lanes[0].name, 'lane0'); assert.equal(W.lanes[0].live, true);
  assert.ok(W.lanes.every(l => l.knots.every(k => k.type === 'run')));
  assert.equal(W.lanes.find(l => l.name === 'lane1').questions, 1);
  assert.deepEqual(W.checkins.map(k => k.id), ['RUN-900']);
  assert.equal(sceneSig(mapOf(), 'dark'), sceneSig(mapOf(), 'dark'));
  assert.notEqual(sceneSig(mapOf(), 'dark'), sceneSig(mapOf(), 'light'));
  assert.notEqual(sceneSig(mapOf(), 'dark'), sceneSig(mapOf(7), 'dark'));
});

test('stream records -> events at fire time = record ts: dispatch spark, delegation shuttle, step / tool / question; heartbeat', () => {
  const t = 1_800_000_000;
  const evs = eventsOfRecords([
    { ts: ts(t), id: 'RUN-101', kind: 'run', ev: 'start', run: 'RUN-900', data: { lane: 'lane0' } },
    { ts: ts(t + 1), id: 'RUN-150', kind: 'run', ev: 'start', run: 'RUN-101', data: { role: 'helper', parent: 'RUN-101' } },
    { ts: ts(t + 2), id: 'RUN-101', kind: 'run', ev: 'usage', run: null, data: {} },
    { ts: ts(t + 3), id: 'DEC-1', kind: 'decision', ev: 'create', run: 'RUN-101', data: {} },
    { ts: ts(t + 4), id: 'Q-9', kind: 'question', ev: 'create', run: 'RUN-101', data: {} },
    { id: 'X', kind: 'run', ev: 'start' }]);
  assert.deepEqual(evs.map(e => [e.f - t, e.id, e.type, e.to ?? null]), [
    [0, 'RUN-900', 'edge', 'RUN-101'], [0, 'RUN-101', 'step', null],
    [1, 'RUN-101', 'deleg', null], [1, 'RUN-101', 'edge', 'RUN-150'], [1, 'RUN-150', 'step', null],
    [2, 'RUN-101', 'tool', null], [3, 'RUN-101', 'tool', null], [4, 'RUN-101', 'error', null]]);
  assert.deepEqual(beatOf(ts(t)), [{ f: t, id: '*running', type: 'step' }]);
  const S = createEvents(); S.push(evs, t + 10); S.push(eventsOfRecords([{ ts: ts(t - 500), id: 'RUN-1', kind: 'run', ev: 'exit' }]), t + 10);
  assert.equal(S.list.length, evs.length, 'history older than KEEP is dropped'); assert.ok(S.list.every((e, i) => i === 0 || S.list[i - 1].f <= e.f));
});

test('frame plan: pulse + motes + sparks while in flight; QUIET = the static frame; reduced motion = no travel, the knot is marked', () => {
  const evs = [{ f: 10, id: 'A', type: 'tool', i: 0 }, { f: 10, id: 'C', type: 'edge', to: 'A', i: 1 }, { f: 10, id: 'Z', type: 'tool', i: 2 }];
  const resolve = id => id === 'Z' ? [] : [id];   // Z is not in the scene
  const live = framePlan(evs, 10.2, {}, resolve);
  assert.ok(live.pulses.get('A').scale > 1); assert.equal(live.motes.length, 1); assert.equal(live.sparks.length, 1); assert.ok(live.moving);
  assert.ok(!live.pulses.has('Z'));
  const quiet = framePlan(evs, 10.2, { quiet: true }, resolve);
  assert.deepEqual([quiet.pulses.size, quiet.sparks.length, quiet.motes.length, quiet.moving], [0, 0, 0, false]);
  const red = framePlan(evs, 10.2, { reduced: true }, resolve);
  assert.deepEqual([red.sparks.length, red.motes.length, red.pulses.get('A').scale], [0, 0, 1], 'no travel, no motes, no swelling');
  assert.ok(framePlan(evs, 10 + PULSE + 0.5, { reduced: true }, resolve).pulses.has('A'), 'marked past the pulse');
  assert.ok(!framePlan(evs, 10 + MARK + 0.1, { reduced: true }, resolve).pulses.has('A'), 'the mark ends');
  assert.equal(framePlan(evs, 9.9, {}, resolve).moving, false, 'nothing before its fire time');
  assert.equal(framePlan(evs, 20, {}, resolve).moving, false, 'nothing long after');
  assert.equal(nextFire(evs, 9), 1); assert.equal(nextFire(evs, 10), null);
  assert.equal(wakeIn(evs, 10.5), 0, 'in flight'); assert.equal(wakeIn(evs, 13), null);
});

// a fake clock + raf + timers: counts what the loop asks for
function env(t0 = 1000) {
  let t = t0, id = 0; const q = [];
  const add = (fn, at) => { const i = ++id; q.push({ i, at, fn }); return i; }, del = i => { const k = q.findIndex(x => x.i === i); if (k >= 0) q.splice(k, 1); };
  return { now: () => t, raf: fn => add(fn, t + 1 / 60), caf: del, setT: (fn, ms) => add(fn, t + ms / 1000), clrT: del, hidden: () => E.hid,
    run(until) { for (;;) { q.sort((a, b) => a.at - b.at); const n = q[0]; if (!n || n.at > until) break; q.shift(); t = n.at; n.fn(); } t = until; }, get t() { return t; }, pending: () => q.length };
}
let E;
function rig(flags = {}) {
  E = env(); E.hid = false; const S = createEvents();
  const loop = createLoop({ ...E, flags, draw: (rt, still) => framePlan(S.list, rt, { quiet: still, reduced: flags.reduced }).moving, pending: rt => nextFire(S.list, rt), wake: rt => wakeIn(S.list, rt) });
  return { loop, S };
}

test('render on change: 0 frames idle; an arriving event costs no frame until it fires, frames while it moves, then nothing', () => {
  const { loop, S } = rig();
  loop.invalidate(); E.run(1000.1); assert.equal(loop.frames, 1, 'one first frame');
  E.run(1060); assert.equal(loop.frames, 1, 'idle minute: 0 frames'); assert.ok(loop.idle); assert.equal(E.pending(), 0, 'no timer, no rAF');
  S.push([{ f: 1065, id: 'A', type: 'tool' }], E.t); loop.poke();
  E.run(1064.9); assert.equal(loop.frames, 1, 'no frame before the fire time');
  E.run(1070); const n = loop.frames; assert.ok(n > 30 && n < 200, `frames while it moves: ${n}`);
  E.run(1200); assert.equal(loop.frames, n, 'then nothing'); assert.ok(loop.idle);
});

test('QUIET: exactly one static frame per change, events never start the loop; hidden: no frames at all', () => {
  const { loop, S } = rig({ quiet: true });
  loop.invalidate(); E.run(1001); assert.equal(loop.frames, 1);
  S.push([{ f: 1002, id: 'A', type: 'tool' }], E.t); loop.poke(); E.run(1010); assert.equal(loop.frames, 1, 'QUIET: an event is not a frame');
  loop.invalidate(); E.run(1011); assert.equal(loop.frames, 2, 'a change (e.g. a refetch) = one static frame'); assert.ok(loop.idle);
  S.push([{ f: 1015, id: 'A', type: 'tool' }], E.t); loop.invalidate(); E.run(1030);
  assert.equal(loop.frames, 3, 'QUIET with an event pending: still one static frame, no timer to its fire time'); assert.ok(loop.idle);
  loop.setQuiet(false); E.run(1030.1); assert.equal(loop.frames, 4);
  const h = rig(); E.hid = true; h.S.push([{ f: 1001, id: 'A', type: 'tool' }], E.t); h.loop.invalidate(); h.loop.poke(); E.run(1100);
  assert.equal(h.loop.frames, 0, 'hidden tab: nothing');
});

test('reduced motion: frames only while a knot is marked (no travel), then idle', () => {
  const { loop, S } = rig({ reduced: true });
  S.push([{ f: 1001, id: 'A', type: 'edge', to: 'B' }, { f: 1001, id: 'A', type: 'tool' }], E.t); loop.poke();
  E.run(1001 + MARK + 1); assert.ok(loop.frames > 0); E.run(1100); assert.ok(loop.idle);
});

test('labels: priority order, candidates before culling, placed boxes never overlap, off-screen culled', () => {
  const C = knotCands(10);
  const items = [{ x: 400, y: 300, w: 60, h: 14, prio: 0, cands: [[0, 0, 'center']] },   // a Norn name
    ...Array.from({ length: 6 }, (_, i) => ({ x: 400 + i * 3, y: 300 + i * 2, w: 150, h: 16, prio: 1, cands: C })),   // six live runs at the rim
    { x: 5, y: 5, w: 100, h: 16, prio: 6, cands: [[0, 0, 'right']] }];   // off-screen
  const out = placeLabels(items, 1280, 700);
  const shown = out.map((p, i) => ({ ...p, w: items[i].w, h: items[i].h })).filter(p => !p.hidden);
  for (const a of shown) for (const b of shown) if (a !== b) assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), 'overlap');
  assert.equal(out.slice(0, 7).filter(p => !p.hidden).length, 7, 'the Norn name + every live run placed');
  assert.ok(out[7].hidden);
});

// the Well built in node (three.js maths, no WebGL): a fixed camera crops the crown; the fitted one holds crown + stakes
async function wellScene(n) {
  const { look } = await import('../engine/dash/norn/well.mjs');
  const scene = new THREE.Scene(), stage = { renderer: { shadowMap: {} } };
  const L = look.build({ THREE, scene, stage, graph: graphOf(mapOf(n)), theme: 'dark', P, col: c => new THREE.Color(P[c] || c) });
  scene.updateMatrixWorld(true);
  const crown = [];
  const p = new THREE.Vector3();   // every vertex of every crown mesh, in world space
  scene.traverse(o => { if (o.userData.crown) { const a = o.geometry.attributes.position; for (let i = 0; i < a.count; i++) crown.push(p.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld).toArray()); } });
  return { L, crown };
}
