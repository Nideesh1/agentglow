/**
 * Generic primitives (docs/SPEC.md "Generic primitives", world state in prims.ts), the same in every theme:
 *  - <PrimMark> per agent (mounted on its first primitive event): ONE billboarded ring mesh (progress arc, lifecycle
 *    tint ring, dashed spin while loading / warming, an amber flash on `rejected`, an expanding pulse on restart) and
 *    one compact status line under the node (max 3 segments: job state, session timer, stages, progress, gate,
 *    capacity, lifecycle, awaiting callback, metric).
 *  - <EventChip> per agent: a business `event` pops a small cyan ticket (`<kind> <label>`) like an order chip.
 *  - <PrimEdges> once per scene: pooled dashed ribbons for fallbacks (amber) and completed deferred callbacks (green),
 *    and backlog ribbons between the producer and consumer services (thicker with depth), each with a midpoint label.
 *  - <ResourceStat> per backend node: `2/4 busy · wait 12ms`, `hit 82%`, `RTF 0.21` under it.
 * No per-frame allocations (module scratch objects, pooled meshes / labels).
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle, type LabelSeg } from "../Label3D";
import { AMBER, BACKLOG_STALE_MS, EDGE_LIFE_MS, EVENT_LIFE_MS, fmtMs, LIFE_COLOR, primLine, PRIM_TEAL, REJECT_SHOW_MS, RES_STALE_MS, resStatText, type PrimSeg } from "../prims";
import { presence, world } from "../world";
import { fit } from "./fit";
import { CHIP_FRAG, CHIP_VERT } from "./HighVolume";
import { labels } from "./labels";
import { satellitePos, satelliteRadius } from "./Crystal";
import { agentLive, kit, reduced, type KitAgent, type KitBackend, type KitMcp } from "./state";

const PLANE = new THREE.PlaneGeometry(2, 2);
const PLANE1 = new THREE.PlaneGeometry(1, 1);
const noRaycast = () => {};
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const UP = new THREE.Vector3();
const RIGHT = new THREE.Vector3();
const DIR = new THREE.Vector3();
const SIDE = new THREE.Vector3();
const VIEW = new THREE.Vector3();
const NRM = new THREE.Vector3();
const M4 = new THREE.Matrix4();
const TEXT = "#e6fffb";
const SEP = "#5b7a78";
/** ring radius on screen (css px) */
const RING_PX: [number, number] = [20, 70];
const LINE = { size: 0.24, px: [10, 12.5] as [number, number] };
const Q = 1.7; // quad half size in ring radii

function wppAt(camera: THREE.Camera, p: THREE.Vector3, vpH: number) {
  const pc = camera as THREE.PerspectiveCamera;
  const dist = p.distanceTo(camera.position) || 1;
  return pc.isPerspectiveCamera ? (2 * dist * Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2)) / (pc.zoom * vpH) : 0.01;
}
function centre(a: KitAgent, height: number, out: THREE.Vector3) {
  out.copy(a.live);
  if (kit.plane === "xz") out.y += height * a.scale * 0.5;
  return out;
}

// ------------------------------------------------------------------ ring + status line
const RING_VERT = /* glsl */ `
varying vec2 vP;
void main() { vP = position.xy * ${Q.toFixed(2)}; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
// vP in ring radii. uProg = (frac, alpha); uLife = (alpha, dashed, unused, unused); uFlash = (alpha, radius offset)
const RING_FRAG = /* glsl */ `
uniform vec2 uProg; uniform vec3 uProgC; uniform vec4 uLife; uniform vec3 uLifeC; uniform vec2 uFlash; uniform vec3 uFlashC;
uniform vec2 uPulse; uniform float uT;
varying vec2 vP;
const float PI = 3.14159265;
float band(float d, float w, float aa) { return 1.0 - smoothstep(w, w + aa, abs(d)); }
void main() {
  float r = length(vP);
  float aa = max(fwidth(r), 1e-4) * 1.2;
  float t = mod(PI * 0.5 - atan(vP.y, vP.x) + 2.0 * PI, 2.0 * PI) / (2.0 * PI);
  vec3 col = vec3(0.0); float a = 0.0;
  // progress: faint full track + bright arc clockwise from the top
  float pb = band(r - 1.0, 0.045, aa);
  float arc = step(t, uProg.x);
  float pa = pb * uProg.y * (0.18 + 0.82 * arc);
  col += uProgC * pa; a += pa;
  // lifecycle: thin ring just outside, dashed + spinning while loading / warming
  float lb = band(r - 1.17, 0.03, aa);
  float dash = mix(1.0, step(0.45, fract(t * 18.0 - uT * 0.6)), uLife.y);
  float la = lb * dash * uLife.x;
  col += uLifeC * la; a += la;
  // amber flash (rejected) and an expanding restart pulse
  float fb = band(r - (1.08 + uFlash.y), 0.06, aa) + exp(-abs(r - 1.08) * 7.0) * 0.4;
  float fa = fb * uFlash.x;
  col += uFlashC * fa; a += fa;
  float rb = band(r - (1.0 + uPulse.y), 0.04, aa) * uPulse.x;
  col += uLifeC * rb; a += rb;
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, 1.0);
}`;

/** Mounts the ring + status line on the agent's first primitive event. */
export function PrimMark({ agent, radius, height }: { agent: KitAgent; radius: number; height: number }) {
  const [on, setOn] = useState(() => !!agent.inst.prim);
  useFrame(() => {
    if (!on && agent.inst.prim) setOn(true);
  });
  return on ? <Mark agent={agent} radius={radius} height={height} /> : null;
}

const PROG = new THREE.Color(PRIM_TEAL);
const FLASH = new THREE.Color(AMBER);

function Mark({ agent, radius, height }: { agent: KitAgent; radius: number; height: number }) {
  const quad = useRef<THREE.Mesh>(null);
  const tag = useRef<THREE.Group>(null);
  const lbl = useRef<Label3DHandle>(null);
  const st = useMemo(() => ({ key: "", at: 0, segs: [] as PrimSeg[], out: [] as LabelSeg[], prog: 0, life: 0 }), []);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        uniforms: {
          uProg: { value: new THREE.Vector2() },
          uProgC: { value: PROG.clone() },
          uLife: { value: new THREE.Vector4() },
          uLifeC: { value: new THREE.Color("#60a5fa") },
          uFlash: { value: new THREE.Vector2() },
          uFlashC: { value: FLASH.clone() },
          uPulse: { value: new THREE.Vector2() },
          uT: { value: 0 },
        },
      }),
    [],
  );
  useEffect(() => () => mat.dispose(), [mat]);
  useFrame(({ camera, size: vp, clock }) => {
    const m = quad.current;
    const g = tag.current;
    const p = agent.inst.prim;
    if (!m || !g || !p) return;
    const now = performance.now();
    const k0 = presence(agent.inst, now) * (1 - 0.55 * agent.dim);
    // ---- ring
    const u = mat.uniforms;
    const pr = p.progress;
    const progOn = pr && now - pr.at < 60_000 && (pr.frac < 1 || now - pr.at < 1500) ? 1 : 0;
    st.prog += (progOn - st.prog) * 0.12;
    if (pr) u.uProg.value.set(pr.frac, st.prog * k0);
    const life = p.life;
    const lifeOn = life && (life.state !== "ready" || now - life.at < 2000) ? 1 : 0;
    st.life += (lifeOn - st.life) * 0.1;
    if (life) {
      (u.uLifeC.value as THREE.Color).set(LIFE_COLOR[life.state] ?? "#94a3b8");
      u.uLife.value.set(st.life * k0 * (life.state === "ready" ? Math.max(0, 1 - (now - life.at) / 2000) : 0.85), life.state === "loading" || life.state === "warming" ? 1 : 0, 0, 0);
      const rt = life.restartAt ? (now - life.restartAt) / 1100 : 9;
      u.uPulse.value.set(rt < 1 ? (1 - rt) * k0 : 0, rt < 1 ? rt * 0.55 : 0);
    } else u.uLife.value.x = 0;
    const ft = p.rejectedAt ? (now - p.rejectedAt) / 900 : 9;
    u.uFlash.value.set(ft < 1 ? (1 - ft) * (1 - ft) * k0 * 1.3 : 0, ft < 1 ? ft * 0.35 : 0);
    u.uT.value = reduced ? 0 : clock.elapsedTime;
    const ringOn = u.uProg.value.y > 0.003 || u.uLife.value.x > 0.003 || u.uFlash.value.x > 0.003 || u.uPulse.value.x > 0.003;
    centre(agent, height, V1);
    const wpp = wppAt(camera, V1, vp.height);
    const R = THREE.MathUtils.clamp(Math.max(radius, height * 0.55) * agent.scale * 1.3, RING_PX[0] * wpp * labels.pxk, RING_PX[1] * wpp * labels.pxk);
    m.visible = ringOn;
    if (ringOn) {
      m.position.copy(V1);
      m.quaternion.copy(camera.quaternion);
      m.scale.setScalar(R * Q);
    }
    // ---- status line (re-texted at most ~4x/s, only on change)
    if (now - st.at > 250) {
      st.at = now;
      const segs = primLine(agent.inst, now, st.segs);
      let key = "";
      for (const s of segs) key += s.text + "|";
      if (key !== st.key) {
        st.key = key;
        st.out.length = 0;
        segs.forEach((s, k) => {
          if (k) st.out.push({ text: " · ", color: SEP });
          st.out.push({ text: s.text, color: s.color });
        });
      }
      // every tick (a no-op once applied): the text mesh may mount a few frames after the label
      if (st.out.length) lbl.current?.setText(st.out);
    }
    const show = st.key !== "" ? k0 : 0;
    g.visible = show > 0.003;
    lbl.current?.setOpacity(Math.min(1, show * 1.2) * 0.95, true);
    if (!g.visible) return;
    UP.set(0, 1, 0).applyQuaternion(camera.quaternion);
    // under the node and below its name label (themes put the name ~0.8 radii under the node)
    g.position.copy(V1).addScaledVector(UP, -(R * 1.05 + 26 * wpp * labels.pxk));
  });
  return (
    <>
      <mesh ref={quad} geometry={PLANE} material={mat} renderOrder={22} raycast={noRaycast} visible={false} frustumCulled={false} />
      <group ref={tag} visible={false}>
        <Label3D ref={lbl} text="" color={PRIM_TEAL} textColor={TEXT} size={LINE.size} pxRange={LINE.px} anchorY="top" plate="none" font="mono" opacity={0} fadeMs={0} glow={1} renderOrder={25} declutter="skill" fit />
      </group>
    </>
  );
}

// ------------------------------------------------------------------ business event chip
const CHIP = { size: 0.28, px: [11, 14] as [number, number] };
const EVENT_C = "#22d3ee";

export function EventChip({ agent, radius, height }: { agent: KitAgent; radius: number; height: number }) {
  const [on, setOn] = useState(() => !!agent.inst.prim?.events.length);
  useFrame(() => {
    if (!on && agent.inst.prim?.events.length) setOn(true);
  });
  return on ? <EventChipOn agent={agent} radius={radius} height={height} /> : null;
}

function EventChipOn({ agent, radius, height }: { agent: KitAgent; radius: number; height: number }) {
  const g = useRef<THREE.Group>(null);
  const quad = useRef<THREE.Mesh>(null);
  const l = useRef<Label3DHandle>(null);
  const st = useMemo(() => ({ cur: null as unknown, chars: 0 }), []);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: CHIP_VERT,
        fragmentShader: CHIP_FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        uniforms: { uSize: { value: new THREE.Vector2(80, 22) }, uColor: { value: new THREE.Color(EVENT_C) }, uA: { value: 0 }, uDash: { value: 0 }, uStrike: { value: 0 } },
      }),
    [],
  );
  useEffect(() => () => mat.dispose(), [mat]);
  useFrame(({ camera, size: vp }) => {
    const o = g.current;
    const m = quad.current;
    const list = agent.inst.prim?.events;
    if (!o || !m || !list) return;
    const now = performance.now();
    const last = list[list.length - 1];
    // an order chip on the same agent plays at the same spot: events yield to a fresh order
    const order = agent.inst.orders[agent.inst.orders.length - 1];
    const live = last && now - last.at < EVENT_LIFE_MS && !(order && now - order.at < 1500) ? last : null;
    if (live !== st.cur) {
      st.cur = live;
      if (live) {
        const txt = `${live.kind}${live.label ? ` ${live.label}` : ""}`.slice(0, 40);
        st.chars = txt.length;
        l.current?.setText([{ text: txt, color: TEXT }]);
      }
    }
    o.visible = !!live;
    if (!live) {
      l.current?.setOpacity(0, true);
      return;
    }
    const t = now - live.at;
    const fade = t < EVENT_LIFE_MS - 400 ? 1 : (EVENT_LIFE_MS - t) / 400;
    const x = Math.min(1, t / 220);
    const pop = reduced ? 1 : 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
    const A = fade * presence(agent.inst, now) * Math.min(1, t / 60);
    centre(agent, height, V1);
    const R = Math.max(radius, height * 0.55) * agent.scale * 1.12;
    UP.set(0, 1, 0).applyQuaternion(camera.quaternion);
    RIGHT.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const wpp = wppAt(camera, V1, vp.height);
    const px = THREE.MathUtils.clamp((CHIP.size * fit.label) / Math.max(wpp, 1e-6), CHIP.px[0] * labels.pxk, CHIP.px[1] * labels.pxk);
    const wPx = st.chars * px * 0.6 + px * 1.3;
    const hPx = px * 1.75;
    mat.uniforms.uSize.value.set(wPx, hPx);
    mat.uniforms.uA.value = A;
    const rise = (R * 1.15 + 10 * wpp) * pop + R * 0.2 * (t / EVENT_LIFE_MS);
    o.position.copy(V1).addScaledVector(RIGHT, (R * 1.05 + (wPx * 0.5 + 4) * wpp) * pop).addScaledVector(UP, rise);
    m.quaternion.copy(camera.quaternion);
    const ps = Math.max(0.0001, pop);
    m.scale.set(wPx * wpp * ps, hPx * wpp * ps, 1);
    l.current?.setOpacity(A * Math.min(1, x * 1.5), true);
  });
  return (
    <group ref={g} visible={false}>
      <mesh ref={quad} geometry={PLANE1} material={mat} renderOrder={27} raycast={noRaycast} frustumCulled={false} />
      <Label3D ref={l} text="" color={EVENT_C} textColor={TEXT} size={CHIP.size} pxRange={CHIP.px} anchorX="center" anchorY="middle" plate="none" font="mono" opacity={0} fadeMs={0} glow={1.05} renderOrder={28} declutter="decision" fit />
    </group>
  );
}

// ------------------------------------------------------------------ edges (fallback, callback, backlog)
const EDGE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
// uv.x along the edge (0 = from, 1 = to); uDash = (dash count, dashed 0/1, flow speed); soft edges across
const EDGE_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uA; uniform vec3 uDash; uniform float uT;
varying vec2 vUv;
void main() {
  float across = 1.0 - smoothstep(0.25, 0.5, abs(vUv.y - 0.5));
  float d = fract(vUv.x * uDash.x - uT * uDash.z);
  float dash = mix(1.0, step(d, 0.55), uDash.y);
  float ends = smoothstep(0.0, 0.04, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
  float a = across * dash * ends * uA;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * a, 1.0);
}`;
const EDGE_POOL = 18;
const EDGE_LBL = { size: 0.22, px: [9.5, 12] as [number, number] };
const C_FALLBACK = "#fbbf24";
const C_CALLBACK = "#4ade80";
const C_BACKLOG = "#a78bfa";

type Slot = { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; key: string; text: LabelSeg[]; textAt: number };

/** Mount once per KitScene. */
export function PrimEdges({ radius }: { radius: number }) {
  const slots = useMemo<Slot[]>(
    () =>
      Array.from({ length: EDGE_POOL }, () => {
        const mat = new THREE.ShaderMaterial({
          vertexShader: EDGE_VERT,
          fragmentShader: EDGE_FRAG,
          transparent: true,
          depthTest: false,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
          side: THREE.DoubleSide,
          uniforms: { uColor: { value: new THREE.Color() }, uA: { value: 0 }, uDash: { value: new THREE.Vector3(8, 1, 0) }, uT: { value: 0 } },
        });
        const mesh = new THREE.Mesh(PLANE1, mat);
        mesh.renderOrder = 20;
        mesh.frustumCulled = false;
        mesh.raycast = noRaycast;
        mesh.visible = false;
        return { mesh, mat, key: "", text: [] as LabelSeg[], textAt: 0 };
      }),
    [],
  );
  useEffect(() => () => slots.forEach((s) => s.mat.dispose()), [slots]);
  const lbls = useRef<(Label3DHandle | null)[]>([]);
  const groups = useRef<(THREE.Group | null)[]>([]);
  useFrame(({ camera, size: vp, clock }) => {
    const now = performance.now();
    let n = 0;
    const draw = (from: THREE.Vector3, to: THREE.Vector3, color: string, a: number, widthPx: number, dashed: boolean, flow: number, key: string, text: string, textColor: string) => {
      if (n >= EDGE_POOL) return;
      const s = slots[n];
      const grp = groups.current[n];
      const lb = lbls.current[n];
      n++;
      V2.copy(from).add(to).multiplyScalar(0.5);
      const wpp = wppAt(camera, V2, vp.height);
      DIR.subVectors(to, from);
      const len = DIR.length();
      if (len < 1e-4) {
        s.mesh.visible = false;
        return;
      }
      DIR.divideScalar(len);
      VIEW.subVectors(camera.position, V2).normalize();
      SIDE.crossVectors(DIR, VIEW).normalize();
      NRM.crossVectors(DIR, SIDE);
      const w = widthPx * wpp * labels.pxk;
      M4.makeBasis(DIR.multiplyScalar(len), SIDE.multiplyScalar(w), NRM);
      M4.setPosition(V2);
      s.mesh.matrixAutoUpdate = false;
      s.mesh.matrix.copy(M4);
      s.mesh.matrixWorldNeedsUpdate = true;
      s.mesh.visible = a > 0.003;
      const u = s.mat.uniforms;
      if (s.key !== key) {
        s.key = key;
        (u.uColor.value as THREE.Color).set(color);
        s.text = [{ text, color: textColor }];
        s.textAt = 0;
        lb?.setColor(color);
      }
      if (now - s.textAt > 400) {
        // re-applied now and then (a no-op once applied): the text mesh may mount after the first frame
        s.textAt = now;
        lb?.setText(s.text);
      }
      u.uA.value = a;
      u.uDash.value.set(Math.max(2, len / (9 * wpp)), dashed ? 1 : 0.35, flow);
      u.uT.value = reduced ? 0 : clock.elapsedTime;
      if (grp) {
        grp.visible = a > 0.05;
        UP.set(0, 1, 0).applyQuaternion(camera.quaternion);
        grp.position.copy(V2).addScaledVector(UP, 6 * wpp);
      }
      lb?.setOpacity(Math.min(1, a * 1.3), true);
    };
    for (const e of world.primEdges) {
      const t = now - e.start;
      if (t >= EDGE_LIFE_MS) continue;
      const a0 = agentLive(e.from);
      if (!a0) continue;
      let b0 = e.to ? agentLive(e.to) : undefined;
      if (!b0) {
        // no target node: a short stub pointing outward from the stage centre
        const ag = kit.agents.get(e.from);
        V1.copy(a0);
        if (V1.lengthSq() < 1e-6) V1.set(0, 1, 0);
        V1.normalize().multiplyScalar(radius * (ag?.scale ?? 1) * 3.2).add(a0);
        b0 = V1;
      }
      const a = Math.min(1, t / 200) * (t < EDGE_LIFE_MS - 900 ? 1 : (EDGE_LIFE_MS - t) / 900);
      const fb = e.kind === "fallback";
      draw(a0, b0, fb ? C_FALLBACK : C_CALLBACK, a * 0.95, 5, true, 1.4, `${e.id}`, e.text, fb ? "#fde68a" : "#bbf7d0");
    }
    for (const b of world.backlogs.values()) {
      if (now - b.at > BACKLOG_STALE_MS || b.depth <= 0 || !b.from || !b.to) continue;
      const a0 = agentLive(b.from), b0 = agentLive(b.to);
      if (!a0 || !b0) continue;
      const k = Math.min(1, Math.log10(1 + b.depth) / 3);
      const fade = Math.min(1, (BACKLOG_STALE_MS - (now - b.at)) / 2000);
      const text = `${b.topic} ${b.depth}${b.lag ? ` · lag ${fmtMs(b.lag)}` : ""}`;
      draw(a0, b0, C_BACKLOG, (0.35 + 0.5 * k) * fade, 3 + 9 * k, false, 0.6, `bl|${text}`, text, "#ddd6fe");
    }
    for (let k = n; k < EDGE_POOL; k++) {
      if (!slots[k].mesh.visible && !groups.current[k]?.visible) continue;
      slots[k].mesh.visible = false;
      slots[k].key = "";
      if (groups.current[k]) groups.current[k]!.visible = false;
      lbls.current[k]?.setOpacity(0, true);
    }
  });
  return (
    <>
      {slots.map((s, k) => (
        <primitive key={k} object={s.mesh} />
      ))}
      {slots.map((_, k) => (
        <group key={`l${k}`} ref={(g) => void (groups.current[k] = g)} visible={false}>
          <Label3D ref={(h) => void (lbls.current[k] = h)} text="" color={C_FALLBACK} textColor={TEXT} size={EDGE_LBL.size} pxRange={EDGE_LBL.px} anchorY="bottom" plate="pill" font="mono" opacity={0} fadeMs={0} renderOrder={26} declutter="extra" fit />
        </group>
      ))}
    </>
  );
}

// ------------------------------------------------------------------ resource stats under a backend node
const STAT = { size: 0.2, px: [9, 11.5] as [number, number] };

export function ResourceStat({ mcp, backend }: { mcp: KitMcp; backend: KitBackend }) {
  const g = useRef<THREE.Group>(null);
  const l = useRef<Label3DHandle>(null);
  const st = useMemo(() => ({ key: "", at: 0, segs: [] as LabelSeg[] }), []);
  const key = `${mcp.srv.name}|${backend.res.name}`;
  useFrame(({ camera, size: vp }) => {
    const o = g.current;
    if (!o) return;
    const now = performance.now();
    const s = world.resStats.get(key);
    let txt = "";
    if (now - st.at > 300) {
      st.at = now;
      txt = s && now - s.at < RES_STALE_MS ? resStatText(s) : "";
      if (txt !== st.key) {
        st.key = txt;
        if (txt) st.segs = [{ text: txt, color: s && s.waiting ? AMBER : "#cbd5e1" }];
      }
      if (txt) l.current?.setText(st.segs);
    }
    o.visible = st.key !== "";
    l.current?.setOpacity(o.visible ? 0.9 : 0, true);
    if (!o.visible) return;
    // the kit crystal look: under the moving satellite's name label (left-aligned with it); else under the slot
    const sp = satellitePos(mcp.srv.name, backend.res.name);
    const at = sp ?? backend.pos;
    const wpp = wppAt(camera, at, vp.height);
    UP.set(0, 1, 0).applyQuaternion(camera.quaternion);
    if (sp) {
      RIGHT.set(1, 0, 0).applyQuaternion(camera.quaternion);
      o.position.copy(sp).addScaledVector(RIGHT, (satelliteRadius(mcp.srv.name, backend.res.name) ?? 0) * 1.25).addScaledVector(UP, -17 * wpp * labels.pxk);
    } else o.position.copy(backend.pos).addScaledVector(UP, -24 * wpp * labels.pxk);
  });
  const onSat = !!satellitePos(mcp.srv.name, backend.res.name);
  return (
    <group ref={g} visible={false}>
      <Label3D ref={l} text="" color="#94a3b8" textColor="#cbd5e1" size={STAT.size} pxRange={STAT.px} anchorY="top" anchorX={onSat ? "left" : "center"} plate="none" font="mono" opacity={0} fadeMs={0} renderOrder={24} fit />
    </group>
  );
}

/** rejected flash still showing (HUD / tests) */
export const rejectedShowing = (id: string, now = performance.now()) => {
  const p = world.instances.get(id)?.prim;
  return !!p && now - p.rejectedAt < REJECT_SHOW_MS;
};
