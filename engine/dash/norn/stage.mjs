// The 3D-to-pixel pipeline (HD-2D / "3D pixel art" practice): a lit three.js scene rendered into a LOW-RES target
// (host size / k, k whole device px per texel, ~640 x 330 at 1080p), then in that low-res space:
//   1. scene -> rtScene (HalfFloat colour + depth texture), fog in the scene
//   2. normals -> rtNormal (scene.overrideMaterial, layer 0 only - particles / sparks are layer 1)
//   3. bloom: bright pass -> half-res, separable 9-tap blur (2 passes)
//   4. final: colour + bloom, depth + normal edge outlines, ordered 4x4 Bayer dither, PALETTE LOCK (nearest of the 32)
// The canvas backing store IS the low-res target; CSS enlarges it by k / dpr with image-rendering: pixelated, so one
// texel = k device pixels exactly. The orthographic camera is snapped to whole texels (no shimmer when it pans).
// Colour work is in display space (ColorManagement off) so the palette lock compares against the hex values as written.
import * as THREE from '../vendor/three.module.js';
import { PALETTE } from './palette.mjs';
export { THREE };
THREE.ColorManagement.enabled = false;

const VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const BRIGHT = `uniform sampler2D t; uniform float thr; varying vec2 vUv;
void main(){ vec3 c = texture2D(t, vUv).rgb; float l = max(c.r, max(c.g, c.b)); gl_FragColor = vec4(c * smoothstep(thr, thr + 0.25, l), 1.0); }`;
const BLUR = `uniform sampler2D t; uniform vec2 dir; varying vec2 vUv;
void main(){ vec3 s = texture2D(t, vUv).rgb * 0.227;
  s += (texture2D(t, vUv + dir).rgb + texture2D(t, vUv - dir).rgb) * 0.194; s += (texture2D(t, vUv + 2.0*dir).rgb + texture2D(t, vUv - 2.0*dir).rgb) * 0.121;
  s += (texture2D(t, vUv + 3.0*dir).rgb + texture2D(t, vUv - 3.0*dir).rgb) * 0.054; s += (texture2D(t, vUv + 4.0*dir).rgb + texture2D(t, vUv - 4.0*dir).rgb) * 0.016;
  gl_FragColor = vec4(s, 1.0); }`;
const FINAL = `uniform sampler2D tC, tD, tN, tB; uniform vec2 res; uniform vec3 pal[32]; uniform float dither, bloomK, edgeK, creaseK, lock;
uniform vec3 edgeCol; varying vec2 vUv;
float bayer(vec2 p){ int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0)); int i = x + y * 4;
  float b[16]; b[0]=0.;b[1]=8.;b[2]=2.;b[3]=10.;b[4]=12.;b[5]=4.;b[6]=14.;b[7]=6.;b[8]=3.;b[9]=11.;b[10]=1.;b[11]=9.;b[12]=15.;b[13]=7.;b[14]=13.;b[15]=5.;
  for (int k = 0; k < 16; k++) if (k == i) return b[k] / 16.0 - 0.469; return 0.0; }
void main(){
  vec2 px = 1.0 / res; vec3 c = texture2D(tC, vUv).rgb + texture2D(tB, vUv).rgb * bloomK;
  float d = texture2D(tD, vUv).x; vec3 n = texture2D(tN, vUv).xyz * 2.0 - 1.0;
  float de = 0.0, ne = 0.0;
  vec2 o[4]; o[0] = vec2(px.x, 0.0); o[1] = vec2(-px.x, 0.0); o[2] = vec2(0.0, px.y); o[3] = vec2(0.0, -px.y);
  for (int k = 0; k < 4; k++) {
    float dn = texture2D(tD, vUv + o[k]).x; de += max(0.0, dn - d);           // a farther neighbour: this texel is a silhouette
    vec3 nn = texture2D(tN, vUv + o[k]).xyz * 2.0 - 1.0; ne += max(0.0, 1.0 - dot(n, nn)) * step(abs(dn - d), 0.002);
  }
  if (d < 0.9999 && de > 0.0035) c = mix(c, edgeCol, edgeK);                    // outer outline (dark ink)
  else if (ne > 0.35 && d < 0.9999) c = c * (1.0 + creaseK);                     // inner crease highlight (lit edge)
  c += bayer(gl_FragCoord.xy) * dither;
  if (lock > 0.5) { float best = 1e9; vec3 pc = c;
    for (int k = 0; k < 32; k++) { vec3 e = c - pal[k]; float r = (c.r + pal[k].r) * 0.5;
      float dd = (2.0 + r) * e.r * e.r + 4.0 * e.g * e.g + (3.0 - r) * e.b * e.b;   // "redmean" weighted RGB distance
      if (dd < best) { best = dd; pc = pal[k]; } }
    c = pc; }
  gl_FragColor = vec4(c, 1.0);
}`;

export function createStage(host, opts = {}) {
  const o = { base: 3, bloom: 0.9, thr: 0.62, dither: 0.09, edgeK: 0.85, creaseK: 0.18, lock: true, fullres: false, ...opts };
  const canvas = document.createElement('canvas'); canvas.className = 'stage-canvas'; host.prepend(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: o.fullres, alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: true });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(1);
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 600);
  camera.layers.enable(1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)), qScene = new THREE.Scene(), qCam = new THREE.Camera(); qScene.add(quad);
  const mat = (fs, u) => new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms: u, depthTest: false, depthWrite: false });
  const pal = PALETTE.map(([, h]) => new THREE.Color('#' + h));
  const U = { tC: { value: null }, tD: { value: null }, tN: { value: null }, tB: { value: null }, res: { value: new THREE.Vector2() }, pal: { value: pal },
    dither: { value: o.dither }, bloomK: { value: o.bloom }, edgeK: { value: o.edgeK }, creaseK: { value: o.creaseK }, lock: { value: o.lock ? 1 : 0 }, edgeCol: { value: new THREE.Color('#0b0e1a') } };
  const mFinal = mat(FINAL, U), mBright = mat(BRIGHT, { t: { value: null }, thr: { value: o.thr } }), mBlur = mat(BLUR, { t: { value: null }, dir: { value: new THREE.Vector2() } });
  const normalMat = new THREE.MeshNormalMaterial();
  let rtC, rtN, rtH1, rtH2, W = 0, H = 0, k = 1, cssK = 1, zoom = 1;
  const view = { target: new THREE.Vector3(), dir: new THREE.Vector3(0, -1, -1).normalize(), up: new THREE.Vector3(0, 1, 0), texel: 0.25 }; // texel = world units per texel at zoom 1

  function alloc() {
    const r = host.getBoundingClientRect();
    k = o.fullres ? 1 : Math.max(1, Math.round(o.base * (devicePixelRatio || 1))); // whole device px per texel
    const devW = Math.round(r.width * devicePixelRatio), devH = Math.round(r.height * devicePixelRatio);
    W = Math.max(64, Math.floor(devW / k)); H = Math.max(64, Math.floor(devH / k)); cssK = k / devicePixelRatio;
    canvas.width = W; canvas.height = H; canvas.style.width = W * cssK + 'px'; canvas.style.height = H * cssK + 'px';
    renderer.setSize(W, H, false);
    for (const t of [rtC, rtN, rtH1, rtH2]) t?.dispose();
    const opt = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, type: THREE.HalfFloatType };
    rtC = new THREE.WebGLRenderTarget(W, H, opt); rtC.depthTexture = new THREE.DepthTexture(W, H); rtC.depthTexture.type = THREE.FloatType;
    rtN = new THREE.WebGLRenderTarget(W, H, { ...opt, type: THREE.UnsignedByteType });
    const hw = Math.max(1, W >> 1), hh = Math.max(1, H >> 1), lin = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType };
    rtH1 = new THREE.WebGLRenderTarget(hw, hh, lin); rtH2 = new THREE.WebGLRenderTarget(hw, hh, lin);
    U.res.value.set(W, H); placeCamera();
  }

  // camera: orthographic, looking along view.dir at view.target, frustum = texel * W x texel * H (one texel = view.texel / zoom)
  function placeCamera() {
    const t = view.texel / zoom, hw = W * t / 2, hh = H * t / 2;
    camera.left = -hw; camera.right = hw; camera.top = hh; camera.bottom = -hh;
    const fwd = view.dir.clone().normalize(), right = new THREE.Vector3().crossVectors(fwd, view.up).normalize(), up = new THREE.Vector3().crossVectors(right, fwd);
    // snap the target to whole texels in the view plane (the camera never sits between texels)
    const a = Math.round(view.target.dot(right) / t) * t, b = Math.round(view.target.dot(up) / t) * t, c = view.target.dot(fwd);
    const snapped = right.clone().multiplyScalar(a).add(up.clone().multiplyScalar(b)).add(fwd.clone().multiplyScalar(c));
    camera.position.copy(snapped).addScaledVector(fwd, -200); camera.up.copy(up); camera.lookAt(snapped);
    camera.near = 1; camera.far = 420; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  }

  let gpuExt = null, q = null; const gl = renderer.getContext(); try { gpuExt = gl.getExtension('EXT_disjoint_timer_query_webgl2'); } catch { }
  function render(perf) {
    let started = false;
    if (gpuExt && perf && !q) { q = gl.createQuery(); gl.beginQuery(gpuExt.TIME_ELAPSED_EXT, q); started = true; }
    if (o.fullres) { renderer.setRenderTarget(null); renderer.render(scene, camera); }
    else {
      renderer.setRenderTarget(rtC); renderer.render(scene, camera);
      const bg = scene.background; scene.background = null; scene.overrideMaterial = normalMat; camera.layers.disable(1);
      renderer.setRenderTarget(rtN); renderer.setClearColor(0x8080ff, 1); renderer.clear(); renderer.render(scene, camera);
      scene.overrideMaterial = null; scene.background = bg; camera.layers.enable(1);
      quad.material = mBright; mBright.uniforms.t.value = rtC.texture; renderer.setRenderTarget(rtH1); renderer.render(qScene, qCam);
      quad.material = mBlur; mBlur.uniforms.t.value = rtH1.texture; mBlur.uniforms.dir.value.set(1 / rtH1.width, 0); renderer.setRenderTarget(rtH2); renderer.render(qScene, qCam);
      mBlur.uniforms.t.value = rtH2.texture; mBlur.uniforms.dir.value.set(0, 1 / rtH1.height); renderer.setRenderTarget(rtH1); renderer.render(qScene, qCam);
      quad.material = mFinal; U.tC.value = rtC.texture; U.tD.value = rtC.depthTexture; U.tN.value = rtN.texture; U.tB.value = rtH1.texture;
      renderer.setRenderTarget(null); renderer.render(qScene, qCam);
    }
    if (started) gl.endQuery(gpuExt.TIME_ELAPSED_EXT);
    if (q && !started && gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
      if (!gl.getParameter(gpuExt.GPU_DISJOINT_EXT)) { perf.gpuMs += gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; perf.gpuN++; }
      gl.deleteQuery(q); q = null;
    }
  }

  // world -> CSS px inside host, snapped to the texel grid (labels sit on whole texels too)
  const v = new THREE.Vector3();
  function toScreen(p) { v.copy(p).project(camera); if (v.z > 1 || v.z < -1) return null; return { x: Math.floor((v.x + 1) / 2 * W) * cssK, y: Math.floor((1 - v.y) / 2 * H) * cssK }; }
  function ndc(ev) { const r = canvas.getBoundingClientRect(); return new THREE.Vector2((ev.clientX - r.left) / r.width * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1); }
  function panBy(dxCss, dyCss) { // drag in CSS px -> world, whole texels only
    const t = view.texel / zoom, fwd = view.dir.clone().normalize(), right = new THREE.Vector3().crossVectors(fwd, view.up).normalize(), up = new THREE.Vector3().crossVectors(right, fwd);
    view.target.addScaledVector(right, -Math.round(dxCss / cssK) * t).addScaledVector(up, Math.round(dyCss / cssK) * t); placeCamera();
  }
  function setZoom(z) { zoom = z; placeCamera(); }
  alloc();
  return { renderer, scene, camera, canvas, view, render, toScreen, ndc, panBy, setZoom, get zoom() { return zoom; }, placeCamera, resize: alloc, setEdge: c => U.edgeCol.value.set(c), setBloom: k => { U.bloomK.value = k; },
    get size() { return { W, H, k, cssK }; }, timer: !!gpuExt, dispose() { for (const r of [rtC, rtN, rtH1, rtH2]) r?.dispose(); renderer.dispose(); renderer.forceContextLoss(); canvas.remove(); } };
}
