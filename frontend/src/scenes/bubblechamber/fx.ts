/**
 * Bubble chamber: colors, easing, the shared BUBBLE POOL (every track in the scene is drawn by one Points ring
 * buffer whose fade runs on the GPU), a pooled dashed/flowing line buffer, curve helpers, per-agent kinks, the
 * primary vertex of each run (placement is the scene kit's) and the chamber VOLUME: the magnetic field runs along
 * stage z (the camera's start axis), so charged tracks are helices along z; the kit's xy layout gives every
 * agent its home and this file gives it a depth (runs at different depths, subagents scattered round their run).
 */
import * as THREE from "three";
import { TYPE_COLOR, hash01, type AgentType } from "../shared/world";
import { fit, type KitAgent } from "../shared/kit";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ easing
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
export const easeInOut = (x: number) => {
  x = clamp01(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
/** seconds on the bubble clock (birth times and the shader's uTime share it) */
export const nowS = () => performance.now() / 1000;

// ------------------------------------------------------------------ palette
export const WHITE = new THREE.Color(1, 1, 1);
/** the chamber light: a pale cyan, the colour bubbles scatter */
export const FILM = new THREE.Color("#bff3ff");
export const TEAL = new THREE.Color("#2dd4bf");
export const AMBER = new THREE.Color("#fbbf24");
export const RED = new THREE.Color("#ff3048");
/** track tint per role: mostly chamber-light with a clear hint of the role colour (the HUD legend still maps) */
export const TRACK_C = Object.fromEntries(Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v).lerp(FILM, 0.38)])) as Record<AgentType, THREE.Color>;
export const ROLE_C = Object.fromEntries(Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v)])) as Record<AgentType, THREE.Color>;

// ------------------------------------------------------------------ textures / materials
let _glow: THREE.Texture | null = null;
export function glowTexture() {
  if (_glow) return _glow;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.1, "rgba(255,255,255,0.7)");
  grd.addColorStop(0.35, "rgba(255,255,255,0.14)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  _glow = new THREE.CanvasTexture(c);
  _glow.colorSpace = THREE.SRGBColorSpace;
  return _glow;
}
export function spriteMat(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
}
export function additive(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, side: THREE.DoubleSide });
}
export function lineMat(color?: THREE.ColorRepresentation) {
  return new THREE.LineBasicMaterial({ color: color ?? "#fff", vertexColors: color === undefined, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
}

/** Dashed unit circle (physicist's annotation ring): selection and MCP-wait marks. */
export const DASH_RING = (() => {
  const v: number[] = [];
  const n = 48;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 0.55) / n) * Math.PI * 2;
    v.push(Math.cos(a0), Math.sin(a0), 0, Math.cos(a1), Math.sin(a1), 0);
  }
  return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
})();
/** pick volume round an agent's home (a sphere: clickable from any orbit angle) */
export const HIT_GEO = new THREE.SphereGeometry(1, 12, 8);

// ------------------------------------------------------------------ curves
export function bezier(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, out: THREE.Vector3) {
  const a = 1 - t;
  return out.set(a * a * p0.x + 2 * a * t * p1.x + t * t * p2.x, a * a * p0.y + 2 * a * t * p1.y + t * t * p2.y, a * a * p0.z + 2 * a * t * p1.z + t * t * p2.z);
}
/** Control point for a charged track a -> b: midpoint pushed sideways (in xy) by `bend` x the length. */
export function curl(a: THREE.Vector3, b: THREE.Vector3, bend: number, out: THREE.Vector3) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  out.copy(a).add(b).multiplyScalar(0.5);
  out.x += -dy * bend;
  out.y += dx * bend;
  return out;
}

// ------------------------------------------------------------------ the bubble pool
/*
 * Every bubble / flash is written ONCE (position, birth, life, size, kind, colour) into a ring buffer; the vertex
 * shader ages it (uTime - birth) so nothing is touched per frame except the slots written that frame. Births in
 * the future draw a track progressively (delta-ray curls, event stars).
 *   kind 0 = bubble (pops in bright, grows a little, then fades: the bubble-chamber dot)
 *   kind 1 = flash (soft glow that swells and fades: vertices, sparks, moving heads)
 *   kind 2 = ring (thin expanding shock ring: decays, run vertices, denies)
 */
const bubbleVert = /* glsl */ `
attribute vec4 aData; attribute vec3 aColor;
uniform float uTime; uniform float uScale; uniform float uMinPx;
varying vec3 vC; varying float vKind;
void main(){
  float age = uTime - aData.x;
  float u = age / aData.y;
  if (age < 0.0 || u >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float kind = aData.w;
  float sz; float a;
  if (kind < 0.5) {
    sz = aData.z * (0.6 + 0.4 * smoothstep(0.0, 0.08, u));
    a = (1.0 - smoothstep(0.3, 1.0, u)) * (1.0 + 1.6 * exp(-age * 7.0));
  } else if (kind < 1.5) {
    sz = aData.z * (0.55 + 0.9 * sqrt(u));
    a = (1.0 - u) * (1.0 - u);
  } else {
    sz = aData.z * (0.15 + 1.6 * sqrt(u));
    a = (1.0 - u) * (1.0 - u) * 1.2;
  }
  vC = aColor * a; vKind = kind;
  float px = sz * uScale / -mv.z;
  // tiny far bubbles keep a readable dot (a little dimmer instead of vanishing)
  if (kind < 0.5 && px < uMinPx) { vC *= 0.55 + 0.45 * px / uMinPx; px = uMinPx; }
  gl_PointSize = clamp(px, 0.0, 256.0);
  gl_Position = projectionMatrix * mv;
}`;
const bubbleFrag = /* glsl */ `
varying vec3 vC; varying float vKind;
void main(){
  vec2 p = gl_PointCoord - 0.5;
  float r = length(p) * 2.0;
  if (r > 1.0) discard;
  float k;
  if (vKind < 0.5) {
    // a bubble: bright core with a faint refracting rim
    k = smoothstep(1.0, 0.15, r) * 0.9 + smoothstep(0.55, 0.8, r) * smoothstep(1.0, 0.82, r) * 0.45;
  } else if (vKind < 1.5) {
    k = exp(-r * r * 9.0) * 1.5 + pow(1.0 - r, 3.0) * 0.4;
  } else {
    k = smoothstep(0.72, 0.9, r) * smoothstep(1.0, 0.92, r) * 1.6;
  }
  gl_FragColor = vec4(vC * k, 1.0);
}`;

export const POOL_N = 32768;
export class BubblePool {
  geo = new THREE.BufferGeometry();
  mat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uScale: { value: 400 }, uMinPx: { value: 2.4 } }, vertexShader: bubbleVert, fragmentShader: bubbleFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  obj: THREE.Points;
  private P: THREE.BufferAttribute;
  private D: THREE.BufferAttribute;
  private C: THREE.BufferAttribute;
  private head = 0;
  private lo = -1;
  private n = 0;
  constructor(private max = POOL_N) {
    this.P = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const d = new Float32Array(max * 4);
    for (let i = 0; i < max; i++) d[i * 4 + 1] = 1e-3; // born at 0, dead
    this.D = new THREE.BufferAttribute(d, 4).setUsage(THREE.DynamicDrawUsage);
    this.C = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", this.P);
    this.geo.setAttribute("aData", this.D);
    this.geo.setAttribute("aColor", this.C);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.obj = new THREE.Points(this.geo, this.mat);
    this.obj.frustumCulled = false;
    this.obj.renderOrder = 2;
  }
  /** one bubble/flash; `birth` in nowS() seconds (future = drawn later), colour premultiplied by `k` */
  emit(x: number, y: number, z: number, size: number, c: THREE.Color, k: number, life: number, birth: number, kind = 0) {
    const i = this.head;
    this.head = (i + 1) % this.max;
    if (this.lo < 0) this.lo = i;
    this.n++;
    const P = this.P.array as Float32Array;
    const D = this.D.array as Float32Array;
    const C = this.C.array as Float32Array;
    P[i * 3] = x;
    P[i * 3 + 1] = y;
    P[i * 3 + 2] = z;
    D[i * 4] = birth;
    D[i * 4 + 1] = life;
    D[i * 4 + 2] = size;
    D[i * 4 + 3] = kind;
    C[i * 3] = c.r * k;
    C[i * 3 + 1] = c.g * k;
    C[i * 3 + 2] = c.b * k;
  }
  /** upload the slots written since the last flush (one or two ranges) */
  flush() {
    if (this.lo < 0) return;
    const attrs = [this.P, this.D, this.C];
    for (const a of attrs) {
      a.clearUpdateRanges();
      const s = a.itemSize;
      if (this.n >= this.max) a.addUpdateRange(0, this.max * s);
      else if (this.lo + this.n <= this.max) a.addUpdateRange(this.lo * s, this.n * s);
      else {
        a.addUpdateRange(this.lo * s, (this.max - this.lo) * s);
        a.addUpdateRange(0, (this.lo + this.n - this.max) * s);
      }
      a.needsUpdate = true;
    }
    this.lo = -1;
    this.n = 0;
  }
  setScale(h: number, dpr: number, fov: number) {
    this.mat.uniforms.uScale.value = (h * dpr) / (2 * Math.tan((fov * Math.PI) / 360));
    this.mat.uniforms.uMinPx.value = 2.4 * dpr;
  }
}
let _pool: BubblePool | null = null;
/** the scene's single bubble pool (mounted by <Bubbles/>) */
export const bubbles = () => (_pool ??= new BubblePool());

/** a burst of bubbles scattered in a ball around p (LLM call, graph shower) */
export function burst(p: THREE.Vector3, n: number, radius: number, size: number, c: THREE.Color, k: number, life: number, t: number) {
  const pool = bubbles();
  for (let i = 0; i < n; i++) {
    // uniform direction, radius ~ cbrt(u): an even little cloud, not a disc
    const zc = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const rr = Math.sqrt(1 - zc * zc);
    const r = radius * Math.cbrt(Math.random());
    pool.emit(p.x + Math.cos(a) * rr * r, p.y + Math.sin(a) * rr * r, p.z + zc * r, size * (0.7 + Math.random() * 0.7), c, k * (0.7 + Math.random() * 0.5), life * (0.8 + Math.random() * 0.4), t + Math.random() * 0.08, 0);
  }
}
/**
 * A delta ray: a small low-energy electron knocked out of the track that spirals in to a stop, drawn
 * progressively (staggered births). `dir` sign = charge. In the z field the spiral also drifts `dz` along the
 * axis (a conical helix: it reads as a coil from the side).
 */
export function deltaRay(p: THREE.Vector3, ang: number, r0: number, turns: number, n: number, size: number, c: THREE.Color, k: number, life: number, t: number, dir: number, dz = 0) {
  const pool = bubbles();
  // the spiral starts AT p heading along `ang` and curls (shrinking radius) around a centre to its side
  const cx = p.x + Math.cos(ang + dir * Math.PI * 0.5) * r0;
  const cy = p.y + Math.sin(ang + dir * Math.PI * 0.5) * r0;
  const a0 = ang - dir * Math.PI * 0.5;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const a = a0 + dir * u * turns * Math.PI * 2;
    const r = r0 * (1 - 0.82 * u);
    pool.emit(cx + Math.cos(a) * r, cy + Math.sin(a) * r, p.z + dz * Math.sqrt(u), size * (1 - 0.35 * u), c, k, life, t + u * 0.35, 0);
  }
}

// ------------------------------------------------------------------ dashed / flowing line pool
/**
 * Many thin curves (quadratic beziers) in ONE LineSegments buffer. `dash` 0 = solid, else on/off pattern with
 * `dashN` dashes along the curve, moving with `flow` (dash phase); `head` = bright travelling head (0..1, -1 none).
 */
export class LinePool {
  geo = new THREE.BufferGeometry();
  obj: THREE.LineSegments;
  private P: THREE.BufferAttribute;
  private C: THREE.BufferAttribute;
  private n = 0;
  private p = new THREE.Vector3();
  constructor(private max: number, private seg = 32) {
    this.P = new THREE.BufferAttribute(new Float32Array(max * seg * 6), 3).setUsage(THREE.DynamicDrawUsage);
    this.C = new THREE.BufferAttribute(new Float32Array(max * seg * 6), 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", this.P);
    this.geo.setAttribute("color", this.C);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.obj = new THREE.LineSegments(this.geo, lineMat());
    this.obj.frustumCulled = false;
  }
  begin() {
    this.n = 0;
  }
  add(a: THREE.Vector3, ctrl: THREE.Vector3, b: THREE.Vector3, col: THREE.Color, k: number, t0: number, t1: number, dashN: number, flow: number, head: number, headK: number) {
    if (this.n >= this.max || t1 <= t0 || (k < 0.003 && headK < 0.003)) return;
    const S = this.seg;
    const P = this.P;
    const C = this.C;
    for (let i = 0; i < S; i++) {
      // dashed: every segment either on or off (by its middle), so dashes stay crisp
      const tm = t0 + ((t1 - t0) * (i + 0.5)) / S;
      let on = 1;
      if (dashN > 0) on = Math.sin((tm * dashN - flow) * Math.PI * 2) > -0.1 ? 1 : 0;
      for (let e = 0; e < 2; e++) {
        const t = t0 + ((t1 - t0) * (i + e)) / S;
        bezier(a, ctrl, b, t, this.p);
        const vi = (this.n * S + i) * 2 + e;
        P.setXYZ(vi, this.p.x, this.p.y, this.p.z);
        let lum = k * on;
        if (head >= 0) lum += headK * Math.exp(-(((t - head) / 0.05) ** 2));
        C.setXYZ(vi, col.r * lum, col.g * lum, col.b * lum);
      }
    }
    this.n++;
  }
  end() {
    this.geo.setDrawRange(0, this.n * this.seg * 2);
    this.P.needsUpdate = true;
    this.C.needsUpdate = true;
  }
}

/**
 * Lays bubbles along a moving point: call with the head position each frame; drops a bubble every `gap` world units
 * travelled (capped per frame). One instance per moving thing; no allocations.
 */
export class Trail {
  x = 0;
  y = 0;
  z = 0;
  acc = 0;
  started = false;
  reset() {
    this.started = false;
    this.acc = 0;
  }
  step(p: THREE.Vector3, gap: number, size: number, c: THREE.Color, k: number, life: number, t: number, maxPerFrame = 8) {
    if (!this.started) {
      this.started = true;
      this.x = p.x;
      this.y = p.y;
      this.z = p.z;
      return;
    }
    const dx = p.x - this.x;
    const dy = p.y - this.y;
    const dz = p.z - this.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > gap * 40) {
      // teleport (layout snap / remount): no streak across the chamber
      this.x = p.x;
      this.y = p.y;
      this.z = p.z;
      this.acc = 0;
      return;
    }
    this.acc += d;
    const pool = bubbles();
    let n = 0;
    while (this.acc >= gap && n < maxPerFrame) {
      this.acc -= gap;
      const f = d > 1e-6 ? 1 - this.acc / d : 1;
      // bubble-chamber dots are irregular: jitter spacing, size and a hair across the track
      const j = (Math.random() - 0.5) * gap * 0.35;
      pool.emit(this.x + dx * f + j, this.y + dy * f - j, this.z + dz * f, size * (0.65 + Math.random() * 0.7), c, k * (0.75 + Math.random() * 0.4), life, t, 0);
      n++;
    }
    if (this.acc > gap) this.acc = gap;
    this.x = p.x;
    this.y = p.y;
    this.z = p.z;
  }
}

// ------------------------------------------------------------------ cross-slot state (keyed by id, objects reused)
/** a kink impulse on an agent's track (tool call, deny, decay recoil): offset that snaps out and relaxes */
export type Kink = { x: number; y: number; z: number; at: number };
export const kinks = new Map<string, Kink>();
export function kick(id: string, x: number, y: number, z: number, at = performance.now()) {
  let k = kinks.get(id);
  if (!k) kinks.set(id, (k = { x: 0, y: 0, z: 0, at: -1e9 }));
  k.x = x;
  k.y = y;
  k.z = z;
  k.at = at;
}
/** offset multiplier of a kink `ms` after it: snaps out in 50ms, relaxes in ~0.4s */
export const kinkShape = (ms: number) => (ms < 0 ? 0 : ms < 50 ? ms / 50 : Math.exp(-(ms - 50) / 260));

/** the primary interaction vertex of each drawn run (stage space; written by the RunMarker slot) */
export const vertices = new Map<string, THREE.Vector3>();

// ------------------------------------------------------------------ the chamber volume (depth along the field)
/**
 * The tank: an elliptic cylinder round the core, axis = stage z = the field. `rx`/`ry` follow the kit core
 * (eased), `hz` is its half length. Written by <Chamber/> (mounted first), read by every slot.
 */
export const tank = { rx: 9, ry: 6, hz: 5 };
/** eased depth (stage z) of each drawn run, keyed by run id (written by the RunMarker slot) */
export const runDepth = new Map<string, { z: number; tz: number }>();

/** target depth of a run: several runs spread along the field axis (oldest at the back), one run sits mid-tank */
export function runDepthTarget(index: number, count: number) {
  if (count < 2) return 0;
  const span = Math.min(2 * (tank.hz - 2.6), (count - 1) * 5);
  // interleave so neighbouring runs (neighbours in the layout too) land at clearly different depths
  const order = index % 2 === 0 ? index / 2 : count - 1 - (index - 1) / 2;
  return (order / (count - 1) - 0.5) * span;
}

/** depth of a top-level agent: its run's depth plus a small stable per-agent scatter */
function topDepth(a: KitAgent) {
  const rz = runDepth.get(a.run.id)?.z ?? 0;
  const h = hash01(a.id, 77) - 0.5;
  const amp = Math.max(1.2, tank.hz * 0.14);
  return rz + h * 2 * amp * Math.max(0.85, Math.min(1.2, fit.spread));
}
/**
 * home depth of an agent: a top-level agent at its run's depth plus a stable scatter; a subagent at its tree root's
 * depth plus its out-of-plane offset in the kit's 3D radial tree (eased `ew`), so subtrees fill the drum in 3D and
 * straight lineage lines still never cross
 */
export function agentDepth(a: KitAgent) {
  const z = a.depth > 0 && a.tr ? topDepth(a.tr) + a.ew : topDepth(a);
  const lim = Math.max(0.5, tank.hz - 1.1);
  return z < -lim ? -lim : z > lim ? lim : z;
}
