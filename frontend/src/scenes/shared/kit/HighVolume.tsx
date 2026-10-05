/**
 * High-volume decisions + orders, the same in every theme (docs/SPEC.md "Decisions" > "High volume", "Orders").
 *
 *  - <DecisionHalos>: ONE instanced mesh for every agent's decision halo (world `decision_stats`): a thin ring just
 *    outside the agent whose thickness / brightness follow its decision rate (log scale) and whose arc is split by
 *    outcome (allow green, deny red, check yes teal / no amber, route results in 4 accent colours, other grey), with a
 *    slow spark running round it. Smoothed in world.ts (EMA), fades when the agent goes quiet (haloMix).
 *  - <HaloLabel>: `jev 42/s · 3% deny` above the agent (a backend service from `service_stats`: `feed · 42 req/s`,
 *    `· 2% errors` only with errors; `feed · idle` after 10 s without traffic (the rate reads 0 within 3 s), world.svcIdle): rate + share only, re-texted at most ~4x/s and only when it changes. Latency
 *    (p50 / p95, in flight) is in the Selected panel and in the label's hover tooltip (`haloHover`, Hud's HaloTip).
 *  - <OrderChip>: a small ticket popping out of the agent for ORDER_LIFE_MS: green BUY/YES, red SELL/NO,
 *    `YES 3 @ 42c`, dashed outline + `paper` when dry_run, grey with a strike-through when rejected / cancelled.
 *
 * All per-frame work is in useFrame on refs (no React re-renders per decision), no per-frame allocations; HaloLabel
 * and OrderChip mount lazily on an agent's first stats / order.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../Label3D";
import { flashMix, HALO_CATS, HALO_COLORS, haloMix, hash01, isSvc, ORDER_LIFE_MS, orderText, presence, selectInstance, svcIdle, world, type OrderUse } from "../world";
import { fit } from "./fit";
import { focusAgent } from "./focus";
import { labels } from "./labels";
import { kit, reduced, type KitAgent } from "./state";

const MAX_HALOS = 512;
/** ring radius in agent radii (inside the skill sigil at 1.22 and the decision glyph at 1.3) */
const HALO_K = 1.12;
/** quad half size in ring radii */
const HALO_Q = 1.25;
const PLANE = new THREE.PlaneGeometry(2, 2);
const noRaycast = () => {};

const HALO_VERT = /* glsl */ `
attribute vec4 iSegA; attribute vec4 iSegB; attribute vec4 iP;
varying vec2 vP; varying vec4 vA; varying vec4 vB; varying vec4 vI;
void main() {
  vP = position.xy * ${HALO_Q.toFixed(2)};
  vA = iSegA; vB = iSegB; vI = iP;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
// vA/vB = cumulative ends of categories 0..7 (category 8 ends at 1); vI = (alpha, thickness, brightness, spark phase)
const HALO_FRAG = /* glsl */ `
uniform vec3 uC[${HALO_CATS.length}]; uniform float uM;
varying vec2 vP; varying vec4 vA; varying vec4 vB; varying vec4 vI;
const float PI = 3.14159265;
void main() {
  float r = length(vP);
  float aa = max(fwidth(r), 1e-4);
  float w = max(vI.y, aa * 0.9);
  float ring = 1.0 - smoothstep(w, w + aa * 1.2, abs(r - 1.0));
  if (ring < 0.002) discard;
  float t = mod(PI * 0.5 - atan(vP.y, vP.x) + 2.0 * PI, 2.0 * PI) / (2.0 * PI);
  float e[8]; e[0] = vA.x; e[1] = vA.y; e[2] = vA.z; e[3] = vA.w; e[4] = vB.x; e[5] = vB.y; e[6] = vB.z; e[7] = vB.w;
  vec3 col = uC[8];
  float lo = 0.0; float hi = 1.0; bool found = false;
  for (int k = 0; k < 8; k++) {
    if (!found && t < e[k]) { col = uC[k]; hi = e[k]; found = true; }
    if (!found) lo = e[k];
  }
  // small gaps between outcome segments (only where a segment really starts / ends)
  float g = min(t - lo, hi - t) * 2.0 * PI;
  float gap = (lo > 0.0005 || hi < 0.9995) ? smoothstep(0.012, 0.012 + aa * 2.0, g) : 1.0;
  float d = abs(fract(t - vI.w + 0.5) - 0.5);
  float spark = exp(-d * d * 900.0) * uM;
  float a = ring * gap * vI.x * (vI.z + spark * 1.4);
  gl_FragColor = vec4(mix(col, vec3(1.0), spark * 0.5) * a, 1.0);
}`;

const CAM_UP = new THREE.Vector3();
const CAM_RIGHT = new THREE.Vector3();
const V1 = new THREE.Vector3();
const S1 = new THREE.Vector3();
const M4 = new THREE.Matrix4();

/** agent's halo ring radius (world) and centre (into `out`) */
function haloFrame(a: KitAgent, radius: number, height: number, out: THREE.Vector3): number {
  out.copy(a.live);
  if (kit.plane === "xz") out.y += height * a.scale * 0.5;
  return Math.max(radius, height * 0.55) * a.scale * HALO_K;
}
/** 0..1 from a decision rate: 2/s -> 0, ~64/s -> 1 (log) */
const rateK = (r: number) => Math.min(1, Math.max(0, Math.log2(Math.max(r, 1e-3) / 2) / 5));

/** One instanced draw for every agent's decision halo. Mount once per KitScene. */
export function DecisionHalos({ radius, height }: { radius: number; height: number }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const { geo, mat, a, b, p } = useMemo(() => {
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = PLANE.index;
    geo.setAttribute("position", PLANE.getAttribute("position"));
    geo.setAttribute("uv", PLANE.getAttribute("uv"));
    const mk = () => new THREE.InstancedBufferAttribute(new Float32Array(MAX_HALOS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const a = mk(), b = mk(), p = mk();
    geo.setAttribute("iSegA", a);
    geo.setAttribute("iSegB", b);
    geo.setAttribute("iP", p);
    const mat = new THREE.ShaderMaterial({
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: { uC: { value: HALO_COLORS.map((c) => new THREE.Color(c)) }, uM: { value: reduced ? 0 : 1 } },
    });
    return { geo, mat, a, b, p };
  }, []);
  useEffect(() => () => (geo.dispose(), mat.dispose()), [geo, mat]);

  useFrame(({ camera }) => {
    const m = mesh.current;
    if (!m) return;
    const now = performance.now();
    let n = 0;
    for (const ag of kit.agents.values()) {
      const h = ag.inst.hv;
      if (!h && ag.inst.flash && n < MAX_HALOS) {
        // a job (long request) just ended: one full ring flash, green done / red failed
        const f = flashMix(ag.inst, now);
        if (f <= 0.003) continue;
        const R = haloFrame(ag, radius, height, V1);
        M4.compose(V1, camera.quaternion, S1.setScalar(R * HALO_Q * (1 + 0.35 * (1 - f))));
        m.setMatrixAt(n, M4);
        const red = ag.inst.flash.ok ? 0 : 1;
        for (let k = 0; k < 8; k++) (k < 4 ? a.array : b.array)[n * 4 + (k & 3)] = k === 0 ? 1 - red : 1;
        p.array[n * 4] = f;
        p.array[n * 4 + 1] = 0.07 / HALO_Q;
        p.array[n * 4 + 2] = 1.6;
        p.array[n * 4 + 3] = 0;
        n++;
        continue;
      }
      if (!h || n >= MAX_HALOS) continue;
      const mix = haloMix(h, now) * presence(ag.inst, now) * (1 - 0.5 * ag.dim);
      if (mix <= 0.003) continue;
      const R = haloFrame(ag, radius, height, V1);
      M4.compose(V1, camera.quaternion, S1.setScalar(R * HALO_Q));
      m.setMatrixAt(n, M4);
      let c = 0;
      for (let k = 0; k < 8; k++) {
        c += h.seg[k];
        (k < 4 ? a.array : b.array)[n * 4 + (k & 3)] = Math.min(1, c);
      }
      const rk = rateK(h.rate);
      p.array[n * 4] = mix;
      p.array[n * 4 + 1] = (0.018 + 0.05 * rk) / HALO_Q;
      // a decision that did not get a glyph (on-screen cap) flashes the halo instead
      const bump = h.bump ? Math.exp(-(now - h.bump) / 260) : 0;
      p.array[n * 4 + 2] = 0.45 + 0.75 * rk + bump * (h.bumpDeny ? 2.2 : 1.2);
      p.array[n * 4 + 3] = reduced ? 0 : (now / 1000) * (0.12 + 0.25 * rk) + hash01(ag.id);
      n++;
    }
    m.count = n;
    rankHalos(now);
    m.visible = n > 0;
    if (n) {
      m.instanceMatrix.needsUpdate = true;
      a.needsUpdate = b.needsUpdate = p.needsUpdate = true;
    }
  });
  return <instancedMesh ref={mesh} args={[geo, mat, MAX_HALOS]} renderOrder={21} raycast={noRaycast} frustumCulled={false} visible={false} />;
}

// ------------------------------------------------------------------ halo label
/** halo text shows only for the selected agent and the HALO_TEXT_TOP busiest (re-ranked ~1/s, no churn per frame) */
const HALO_TEXT_TOP = 3;
const haloTop = new Set<string>();
let rankedAt = 0;
const topIds: string[] = [];
const topRates: number[] = [];
function rankHalos(now: number) {
  if (now - rankedAt < 1000) return;
  rankedAt = now;
  topIds.length = topRates.length = 0;
  for (const ag of kit.agents.values()) {
    const h = ag.inst.hv;
    if (!h || haloMix(h, now) <= 0.05) continue;
    // current holders get a small bonus so near-equal rates don't swap every second
    const r = h.rate * (haloTop.has(ag.id) ? 1.15 : 1);
    let k = topIds.length;
    while (k > 0 && topRates[k - 1] < r) k--;
    if (k >= HALO_TEXT_TOP) continue;
    topIds.splice(k, 0, ag.id);
    topRates.splice(k, 0, r);
    if (topIds.length > HALO_TEXT_TOP) (topIds.length = HALO_TEXT_TOP), (topRates.length = HALO_TEXT_TOP);
  }
  haloTop.clear();
  for (const id of topIds) haloTop.add(id);
}
const TEXT = "#f1fffd";
const DIM = "#9fc4bf";
const BADGE = "#c4b5fd";
const RED = "#fb7185";
const HL = { size: 0.3, px: [11.5, 14] as [number, number] };
/** stats older than this (ms) mean no traffic: the label's rate reads 0 */
const STALE_RATE_MS = 3000;
const RETEXT_MS = 250;

/** Mounts the halo label on the agent's first decision_stats. */
export function HaloLabel({ agent, radius, height }: { agent: KitAgent; radius: number; height: number }) {
  // a backend service always has one (`feed · idle` before its first traffic)
  const want = () => !!agent.inst.hv || (agent.depth === 0 && isSvc(agent.inst));
  const [on, setOn] = useState(want);
  useFrame(() => {
    if (!on && want()) setOn(true);
  });
  return on ? <HaloLabelOn agent={agent} radius={radius} height={height} /> : null;
}

/** The halo label under the pointer (agent id, or null): the HUD shows its latency in a tooltip. */
export const haloHover = { id: null as string | null, subs: new Set<() => void>() };
function setHaloHover(id: string | null) {
  if (haloHover.id === id) return;
  haloHover.id = id;
  haloHover.subs.forEach((f) => f());
}

function HaloLabelOn({ agent, radius, height }: { agent: KitAgent; radius: number; height: number }) {
  const g = useRef<THREE.Group>(null);
  const l = useRef<Label3DHandle>(null);
  const st = useMemo(() => ({ at: 0, key: "", vis: 0, setAt: 0 }), []);
  useEffect(() => () => void (haloHover.id === agent.id && setHaloHover(null)), [agent.id]);
  useFrame(({ camera, size: vp }) => {
    const h = agent.inst.hv;
    const o = g.current;
    // a backend service always shows its label (its name + traffic, or `feed · idle`): the services group reads at a glance
    const svc = agent.depth === 0 && agent.id.startsWith("svc:");
    if ((!h && !svc) || !o) return;
    const now = performance.now();
    const idle = svc && (!h || svcIdle(agent.inst, now));
    const shown = svc || haloTop.has(agent.id) || world.selected === agent.id;
    st.vis += ((shown ? 1 : 0) - st.vis) * 0.15;
    const mix = (svc ? Math.max(0.75, haloMix(h, now)) : haloMix(h, now)) * presence(agent.inst, now) * (1 - 0.5 * agent.dim) * st.vis;
    o.visible = mix > 0.003;
    l.current?.setOpacity(Math.min(1, mix * 1.4) * 0.92, true);
    if (!o.visible) return;
    if (idle && now - st.at > RETEXT_MS) {
      st.at = now;
      // no traffic for a while (world.svcIdle): `feed · idle` until the next request / message
      if (l.current && (st.key !== "idle" || now - st.setAt > 3000)) {
        st.key = "idle";
        st.setAt = now;
        l.current.setText([
          { text: `${agent.inst.name} · `, color: TEXT },
          { text: "idle", color: DIM },
        ]);
      }
    } else if (h && now - st.at > RETEXT_MS) {
      st.at = now;
      // the rate is the last stats window's: once stats stop arriving it reads 0 right away (not the stale value)
      const rate = now - h.at > STALE_RATE_MS ? 0 : h.rate;
      const r = rate >= 10 ? `${Math.round(rate)}` : `${Math.round(rate * 10) / 10}`;
      const d = h.deny * 100;
      const dn = d > 0 && d < 1 ? "<1" : `${Math.round(d)}`;
      const reps = h.unit && (h.instances ?? 1) > 1 ? `×${h.instances} · ` : "";
      const key = `${h.provider}|${h.unit}|${r}|${dn}|${reps}|${svc}`;
      // (re-applied every few seconds: a text set before the label's mesh mounted would otherwise stay empty)
      if (l.current && (key !== st.key || now - st.setAt > 3000)) {
        st.key = key;
        st.setAt = now;
        // rate + error / deny share (only when > 0): `feed · 1.6 req/s · 3% errors`, `jev 2.3/s · 5% deny`, `×2`
        // replicas; latency is in the hover tooltip and the Selected panel
        l.current?.setText([
          ...(svc ? [{ text: `${agent.inst.name} · `, color: TEXT }] : []),
          ...(reps ? [{ text: reps, color: BADGE }] : []),
          { text: h.unit ? `${r} ` : `${h.provider} `, color: h.unit ? TEXT : BADGE },
          { text: h.unit ? `${h.unit}/s` : `${r}/s`, color: h.unit ? BADGE : TEXT },
          ...(d > 0 ? [
            { text: " · ", color: DIM },
            { text: `${dn}% ${h.unit ? "errors" : "deny"}`, color: d >= 1 ? RED : DIM },
          ] : []),
        ]);
      }
    }
    const R = haloFrame(agent, radius, height, V1);
    CAM_UP.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const pc = camera as THREE.PerspectiveCamera;
    const dist = V1.distanceTo(camera.position) || 1;
    const wpp = pc.isPerspectiveCamera ? (2 * dist * Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2)) / (pc.zoom * vp.height) : 0.01;
    // a service with a ring of tasks / jobs: the label goes above the ring (never across its spokes)
    const top = h?.unit && agent.rings && agent.kidsMax ? agent.ry * (1 + (agent.rings - 1) * 0.9 * agent.cell / Math.max(1e-3, agent.rx, agent.ry)) * fit.spread * (kit.plane === "xz" ? fit.foreshorten : 1) + radius * fit.scale * 0.9 : 0;
    o.position.copy(V1).addScaledVector(CAM_UP, Math.max(R, top) + 5 * wpp);
  });
  return (
    <group ref={g} visible={false}>
      <Label3D ref={l} text="" color="#5eead4" textColor={TEXT} size={HL.size} pxRange={HL.px} anchorY="bottom" plate="none" font="mono" opacity={0} fadeMs={0} glow={1} renderOrder={25} declutter="skill" fit
        onClick={(e) => g.current?.visible && (e.stopPropagation(), selectInstance(agent.id), focusAgent(agent.id))}
        onHover={(over) => setHaloHover(over && g.current?.visible ? agent.id : null)} />
    </group>
  );
}

// ------------------------------------------------------------------ order chip
export const CHIP_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
// rounded ticket in px space (uSize = w, h px): dark fill, coloured border (dashed when paper), strike when rejected
export const CHIP_FRAG = /* glsl */ `
uniform vec2 uSize; uniform vec3 uColor; uniform float uA; uniform float uDash; uniform float uStrike;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * uSize;
  vec2 hs = uSize * 0.5;
  float rad = min(hs.y, 7.0);
  vec2 q = abs(p) - hs + rad;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
  if (d > 0.5) discard;
  float inside = 1.0 - smoothstep(-0.5, 0.5, d);
  float border = 1.0 - smoothstep(0.6, 1.4, abs(d + 1.0));
  // dashes along the perimeter (x on the long edges, y on the short ones)
  float along = abs(p.y) > hs.y - rad ? p.x : p.y + 1000.0;
  float dash = mix(1.0, step(0.5, fract(along / 7.0)), uDash);
  float strike = uStrike * (1.0 - smoothstep(0.6, 1.3, abs(p.y))) * step(abs(p.x), hs.x - 4.0);
  vec3 fill = uColor * 0.16 + vec3(0.02, 0.03, 0.05);
  vec3 col = mix(fill, uColor, max(border * dash, strike));
  float a = inside * (0.86 + 0.14 * max(border * dash, strike)) * uA;
  gl_FragColor = vec4(col, a);
}`;
const CHIP = { size: 0.3, px: [12, 15] as [number, number] };
const BUY = "#4ade80";
const SELL = "#fb7185";
const GREY = "#94a3b8";
const POP_MS = 220;

const isStrike = (o: OrderUse) => o.status === "rejected" || o.status === "cancelled";
const orderTint = (o: OrderUse) => (isStrike(o) ? GREY : o.side === "sell" || o.side === "no" ? SELL : BUY);

/** Mounts the order chip on the agent's first order. */
export function OrderChip({ agent, radius, height }: { agent: KitAgent; radius: number; height: number }) {
  const [on, setOn] = useState(() => agent.inst.orders.length > 0);
  useFrame(() => {
    if (!on && agent.inst.orders.length > 0) setOn(true);
  });
  return on ? <OrderChipOn agent={agent} radius={radius} height={height} /> : null;
}

function OrderChipOn({ agent, radius, height }: { agent: KitAgent; radius: number; height: number }) {
  const g = useRef<THREE.Group>(null);
  const quad = useRef<THREE.Mesh>(null);
  const l = useRef<Label3DHandle>(null);
  const st = useMemo(() => ({ cur: null as OrderUse | null, chars: 0 }), []);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: CHIP_VERT,
        fragmentShader: CHIP_FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        uniforms: { uSize: { value: new THREE.Vector2(80, 22) }, uColor: { value: new THREE.Color(BUY) }, uA: { value: 0 }, uDash: { value: 0 }, uStrike: { value: 0 } },
      }),
    [],
  );
  useEffect(() => () => mat.dispose(), [mat]);
  useFrame(({ camera, size: vp }) => {
    const o = g.current;
    const m = quad.current;
    if (!o || !m) return;
    const now = performance.now();
    const list = agent.inst.orders;
    const last = list[list.length - 1];
    const live = last && now - last.at < ORDER_LIFE_MS ? last : null;
    if (live !== st.cur) {
      st.cur = live;
      if (live) {
        const txt = orderText({ ...live, status: isStrike(live) ? live.status : undefined });
        const tag = live.dry_run ? " paper" : "";
        st.chars = txt.length + tag.length;
        const c = orderTint(live);
        l.current?.setText([{ text: txt, color: isStrike(live) ? GREY : TEXT }, { text: tag, color: DIM }]);
        (mat.uniforms.uColor.value as THREE.Color).set(c);
        mat.uniforms.uDash.value = live.dry_run ? 1 : 0;
        mat.uniforms.uStrike.value = isStrike(live) ? 1 : 0;
      }
    }
    o.visible = !!live;
    if (!live) {
      l.current?.setOpacity(0, true);
      return;
    }
    const t = now - live.at;
    const k0 = presence(agent.inst, now);
    const fade = t < ORDER_LIFE_MS - 400 ? 1 : (ORDER_LIFE_MS - t) / 400;
    const x = Math.min(1, t / POP_MS);
    const pop = reduced ? 1 : 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
    const A = fade * k0 * Math.min(1, t / 60);
    // px size of the text (same formula as Label3D's fit + px clamp) -> chip size in px and world
    const R = haloFrame(agent, radius, height, V1) / HALO_K;
    CAM_UP.set(0, 1, 0).applyQuaternion(camera.quaternion);
    CAM_RIGHT.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const pc = camera as THREE.PerspectiveCamera;
    const dist = V1.distanceTo(camera.position) || 1;
    const wpp = pc.isPerspectiveCamera ? (2 * dist * Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2)) / (pc.zoom * vp.height) : 0.01;
    const px = THREE.MathUtils.clamp((CHIP.size * fit.label) / Math.max(wpp, 1e-6), CHIP.px[0] * labels.pxk, CHIP.px[1] * labels.pxk);
    const wPx = st.chars * px * 0.6 + px * 1.3;
    const hPx = px * 1.75;
    mat.uniforms.uSize.value.set(wPx, hPx);
    mat.uniforms.uA.value = A;
    // pops out of the agent to its upper right, rising a little while it shows
    const rise = (R * 1.15 + 10 * wpp) * pop + R * 0.2 * (t / ORDER_LIFE_MS);
    o.position.copy(V1).addScaledVector(CAM_RIGHT, (R * 1.05 + (wPx * 0.5 + 4) * wpp) * pop).addScaledVector(CAM_UP, rise);
    // only the ticket quad pops (scaling the group would make the px-clamped label compensate and blow up)
    m.quaternion.copy(camera.quaternion);
    const ps = Math.max(0.0001, pop);
    m.scale.set(wPx * wpp * ps, hPx * wpp * ps, 1);
    l.current?.setOpacity(A * Math.min(1, x * 1.5), true);
  });
  return (
    <group ref={g} visible={false}>
      <mesh ref={quad} geometry={CHIP_PLANE} material={mat} renderOrder={27} raycast={noRaycast} frustumCulled={false} />
      <Label3D ref={l} text="" color={BUY} textColor={TEXT} size={CHIP.size} pxRange={CHIP.px} anchorX="center" anchorY="middle" plate="none" font="mono" opacity={0} fadeMs={0} glow={1.05} renderOrder={28} declutter="decision" fit />
    </group>
  );
}
const CHIP_PLANE = new THREE.PlaneGeometry(1, 1);
