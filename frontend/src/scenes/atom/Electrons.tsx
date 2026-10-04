/**
 * Agent slot: agents are electrons. Top-level agents sit on their own tilted orbital shell around the run's nucleus
 * (the shell passes through the agent's kit home; a comet-like trail along it shows the orbit); subagents circle
 * their kit home on a tiny mini-atom orbit and are linked to their parent by a directional field line (quanta flow
 * parent -> child + arrowhead).
 *   spawn    -> excited out of the nucleus (top-level) or budded off the parent (subagent)
 *   thinking -> bright, quick shimmer; waiting -> dimmer; MCP pending -> amber precession ring
 *   LLM call -> photon emitted (flash + wave packet), both sized by tokens
 *   exit     -> electron decays: core collapses with a flash, it spirals out along its shell leaving a fading trail
 * The drawn position is written into `agent.live` (beams, tethers and messages read it).
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { FADE_MS, TYPE_COLOR, energy, hash01, lingerMs, presence, world, jobText, cometOn, cometPos } from "../shared/world";
import { showLabel } from "../shared/lod";
import { agentLive, fit, type AgentSlotProps } from "../shared/kit";
import {
  AMBER,
  ARROW_GEO,
  GREY,
  ICE,
  RING_GEO,
  SPHERE_GEO,
  TUBE_GEO,
  TYPE_C,
  WHITE,
  additive,
  bezier,
  bow,
  clamp01,
  easeInOut,
  easeOut,
  glowSprite,
  hubs,
  lineMat,
  reduced,
  tubeMaterial,
} from "./fx";

const TRAIL = 40;
const SHELL_SEG = 160;
const HIT_MAT = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
const UP = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const A = new THREE.Vector3();
const B = new THREE.Vector3();
const D = new THREE.Vector3();
/** unit circle (x, y): drawn through a per-electron basis matrix as its orbital shell */
const SHELL_GEO = (() => {
  const p = new Float32Array((SHELL_SEG + 1) * 3);
  for (let i = 0; i <= SHELL_SEG; i++) {
    const a = (i / SHELL_SEG) * Math.PI * 2;
    p.set([Math.cos(a), Math.sin(a), 0], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
})();

// ------------------------------------------------------------------ photon pool (LLM calls)
type Photon = { on: boolean; start: number; size: number; o: THREE.Vector3; dir: THREE.Vector3; perp: THREE.Vector3; c: THREE.Color };
const MAX_PH = 40;
const photons: Photon[] = Array.from({ length: MAX_PH }, () => ({ on: false, start: 0, size: 1, o: new THREE.Vector3(), dir: new THREE.Vector3(), perp: new THREE.Vector3(), c: new THREE.Color() }));
let phNext = 0;
function emitPhoton(at: THREE.Vector3, from: THREE.Vector3, size: number, color: THREE.Color, seed: number) {
  const p = photons[phNext];
  phNext = (phNext + 1) % MAX_PH;
  p.on = true;
  p.start = performance.now();
  p.size = size;
  p.o.copy(at);
  // emitted outward (away from the run's nucleus), with a seeded angular kick
  p.dir.copy(at).sub(from);
  if (p.dir.lengthSq() < 1e-4) p.dir.set(0, 1, 0);
  p.dir.normalize();
  p.dir.x += Math.sin(seed * 12.9) * 0.6;
  p.dir.y += Math.cos(seed * 7.3) * 0.6;
  p.dir.z += 0.35;
  p.dir.normalize();
  p.perp.set(0, 0, 1).cross(p.dir).normalize();
  if (p.perp.lengthSq() < 0.5) p.perp.set(1, 0, 0);
  p.c.copy(color).lerp(WHITE, 0.35);
}

/** Electron slot. */
export function Electron({ agent, selected, onSelect }: AgentSlotProps) {
  const inst = agent.inst;
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const ring = useRef<THREE.Mesh>(null);
  const sel = useRef<THREE.Mesh>(null);
  const flash = useRef<THREE.Sprite>(null);
  const arrow = useRef<THREE.Mesh>(null);
  const hit = useRef<THREE.Mesh>(null);
  const label = useRef<Label3DHandle>(null);
  const labelG = useRef<THREE.Group>(null);
  const color = TYPE_C[inst.type];
  const sub = !!inst.subagent;
  const m = useMemo(
    () => ({
      core: additive("#fff"),
      shell: additive(color),
      halo: glowSprite(color),
      ring: additive(AMBER),
      sel: additive(ICE),
      flash: glowSprite("#fff"),
      arrow: additive(color),
      field: tubeMaterial(color, sub ? 0.028 : 0.04),
      trail: lineMat("#fff", true),
      orbit: lineMat(color),
    }),
    [color, sub],
  );
  const trail = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return g;
  }, []);
  const trailLine = useMemo(() => Object.assign(new THREE.Line(trail, m.trail), { frustumCulled: false }), [trail, m.trail]);
  const shellLine = useMemo(() => Object.assign(new THREE.Line(SHELL_GEO, m.orbit), { frustumCulled: false, matrixAutoUpdate: false, visible: false }), [m.orbit]);
  const s = useMemo(
    () => ({
      p: new THREE.Vector3(),
      ctrl: new THREE.Vector3(),
      par: new THREE.Vector3(),
      n: new THREE.Vector3(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      from: new THREE.Vector3(),
      fromSet: false,
      c: new THREE.Color(),
      llm: inst.llmCalls,
      ringK: 0,
      linkK: 0,
      labelK: 1,
      seed: hash01(inst.id, 3),
      dir: hash01(inst.id, 4) < 0.5 ? 1 : -1,
      // shell plane: tilt toward the viewer (seeded per agent) -> classic atom-logo ellipses
      tilt: 0.35 + hash01(inst.id, 5) * 0.25,
      lean: 0.45 + hash01(inst.id, 6) * 0.25,
    }),
    [inst],
  );

  /** point on the electron's orbit at angle th (shell for top-level, mini-orbit for subagents) */
  const orbitAt = (th: number, out: THREE.Vector3) => out.copy(s.n).addScaledVector(s.a, Math.cos(th)).addScaledVector(s.b, Math.sin(th));

  useFrame(({ clock, camera }) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    // exit timeline in "normal" seconds (sped up when crowded: lingerMs < FADE_MS)
    const te = inst.exitAt ? (now - inst.exitAt) / 1000 / (lingerMs(inst) / FADE_MS) : -1;
    const decay = te >= 0 ? clamp01(te / 0.8) : 0;
    const dec = te > 0 ? te : 0;

    // ---- orbit frame: n = centre, a = centre -> home, b = tilted perpendicular (both stage space)
    if (!sub) {
      const hub = hubs.get(agent.run.id) ?? agent.run.origin;
      s.n.copy(hub);
      s.a.copy(agent.pos).sub(hub);
      let L = s.a.length();
      if (L < 0.5) s.a.set(0, 0.5, 0), (L = 0.5);
      // in-plane perpendicular, leaning toward the camera (z) so the shell reads as a tilted ellipse
      s.b.set(-s.a.y, s.a.x, 0).normalize().multiplyScalar(L * s.tilt * s.dir).addScaledVector(Z, L * s.lean);
    } else {
      const r = 0.32 * fit.spread;
      s.n.copy(agent.pos);
      s.a.set(r, 0, 0);
      s.b.set(0, r * 0.45, r * 0.6);
    }
    // electron angle: top-level rests at its home (th = 0) with a slight sway; subagents circle their mini-orbit
    const w = sub ? (reduced ? 0 : 0.9) : 0;
    let th = sub ? t * w * s.dir + s.seed * 6.28 : reduced ? 0 : Math.sin(t * 0.6 + s.seed * 9) * 0.06;
    th += s.dir * dec * 0.9; // decay: spirals on along its orbit ...
    const grow = 1 + dec * dec * 0.07; // ... and outward
    orbitAt(th, agent.live);
    if (grow !== 1) agent.live.sub(s.n).multiplyScalar(grow).add(s.n);
    // born: excited out of the nucleus (top-level) or budded off the parent (subagent)
    const bt = easeOut((now - inst.bornAt) / 1100);
    if (bt < 1) {
      const pp = inst.parent ? agentLive(inst.parent) : undefined;
      if (pp) s.from.copy(pp), (s.fromSet = true);
      else if (!s.fromSet) s.from.copy(s.n), (s.fromSet = true);
      agent.live.lerpVectors(s.from, agent.live, sub ? bt : 0.3 + 0.7 * bt);
    }
    const live = agent.live;
    root.current?.position.copy(live);

    const pres = presence(inst, now);
    const thinking = te < 0 && (inst.status === "thinking" || inst.status === "spawning");
    const e = energy(inst, now);
    let pending = false;
    for (const p of world.mcpPending.values()) if (p.instance === inst.id) pending = true;
    const shimmer = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * (thinking ? 6 : 1.6) + s.seed * 30);

    // LLM call -> photon sized by tokens (inst.pulse grows with tokens_in + tokens_out)
    if (inst.llmCalls !== s.llm) {
      s.llm = inst.llmCalls;
      if (te < 0) emitPhoton(live, hubs.get(agent.run.id) ?? agent.run.origin, inst.pulse, color, s.seed + inst.llmCalls * 0.37);
    }

    const big = agent.scale;
    const born = easeOut((now - inst.bornAt) / 700);
    const sc = 0.3 * big * born * (1 - decay * 0.9) * (1 + e * 0.12);
    body.current?.scale.setScalar(Math.max(1e-4, sc));
    s.c.copy(color).multiplyScalar((thinking ? 1.0 + shimmer * 0.4 : 0.55 + shimmer * 0.15) + e * 0.5);
    if (te >= 0) s.c.lerp(GREY, decay);
    m.shell.color.copy(s.c);
    m.core.color.setScalar((thinking ? 0.9 : 0.45) * (1 - decay) + e * 0.4);
    if (halo.current) {
      halo.current.scale.setScalar(Math.max(1e-4, (thinking ? 2.4 : 1.7) * big * born * (1 - decay * 0.7) + e * 0.9 * fit.scale));
      m.halo.color.copy(color).multiplyScalar(((thinking ? 0.32 : 0.16) + e * 0.25) * pres);
    }
    // decay flash at exit
    if (flash.current) {
      const f = te >= 0 && te < 0.9 ? 1 - te / 0.9 : 0;
      flash.current.visible = f > 0;
      flash.current.scale.setScalar(Math.max(1e-4, big * (1.2 + (1 - f) * 3.5)));
      m.flash.color.copy(inst.status === "failed" ? AMBER : WHITE).multiplyScalar(f * f * 0.9);
    }
    // MCP pending: amber precession ring
    s.ringK += ((pending && te < 0 ? 1 : 0) - s.ringK) * 0.1;
    if (ring.current) {
      ring.current.visible = s.ringK > 0.02;
      ring.current.rotation.set(1.2 + Math.sin(t * 0.8) * 0.3, t * 1.4, 0);
      ring.current.scale.setScalar(Math.max(1e-4, 0.62 * big * s.ringK));
      m.ring.color.copy(AMBER).multiplyScalar(1.1 * s.ringK * (0.7 + shimmer * 0.3));
    }
    if (sel.current) {
      sel.current.visible = selected;
      sel.current.quaternion.copy(camera.quaternion);
      sel.current.scale.setScalar(0.8 * big + (reduced ? 0 : Math.sin(t * 3) * 0.04));
    }
    hit.current?.scale.setScalar(Math.max(0.55, 0.62 * big));
    if (sub) labelG.current?.position.set(0.3 * big + 0.15, 0, 0);
    // top-level: label on the far side of the electron from the nucleus (never over the nucleus)
    else labelG.current?.position.set(0, (s.a.y > 0.2 ? 1 : -1) * (0.42 * big + 0.28), 0);
    if (label.current) {
      s.labelK += ((showLabel(inst.id) ? 1 : 0) - s.labelK) * 0.12;
      label.current.setOpacity(clamp01((now - inst.bornAt) / 600) * (1 - clamp01(te / 1.2)) * 0.95 * s.labelK);
    }

    // orbital shell (top-level): faint ellipse through the electron's home around the nucleus
    if (!sub) {
      const L = s.a.length();
      shellLine.visible = L > 0.6 && pres > 0.02;
      if (shellLine.visible) {
        D.crossVectors(s.a, s.b).normalize();
        shellLine.matrix.makeBasis(s.a, s.b, D).setPosition(s.n);
        shellLine.matrixWorldNeedsUpdate = true;
        m.orbit.color.copy(color).multiplyScalar((thinking ? 0.32 : 0.2) * born * (1 - decay) * pres);
      }
    }

    // trail: the orbit just behind the electron (analytic, so it follows the shell / mini-orbit and the decay spiral)
    const P = trail.getAttribute("position") as THREE.BufferAttribute;
    const C = trail.getAttribute("color") as THREE.BufferAttribute;
    const span = sub ? 2.4 : 1.5;
    const trailK = (thinking ? 0.75 : 0.45) * born * (te >= 0 ? (1 - clamp01((te - 0.4) / 2.0)) * 1.6 : 1);
    for (let k = 0; k < TRAIL; k++) {
      const tk = th - s.dir * (k / (TRAIL - 1)) * span;
      orbitAt(tk, s.p);
      if (grow !== 1) s.p.sub(s.n).multiplyScalar(grow).add(s.n);
      if (bt < 1) s.p.lerpVectors(s.from, s.p, sub ? bt : 0.3 + 0.7 * bt);
      P.setXYZ(k, s.p.x, s.p.y, s.p.z);
      const fall = Math.pow(1 - k / (TRAIL - 1), 1.8) * trailK;
      C.setXYZ(k, (te >= 0 ? ICE.r : color.r) * fall, (te >= 0 ? ICE.g : color.g) * fall, (te >= 0 ? ICE.b : color.b) * fall);
    }
    P.needsUpdate = true;
    C.needsUpdate = true;

    // field line parent -> child (only while both are alive; fades if the parent exits)
    const pp = inst.parent ? agentLive(inst.parent) : undefined;
    const parent = inst.parent ? world.instances.get(inst.parent) : undefined;
    const alive = !!pp && !!parent && !parent.exitAt && !inst.exitAt;
    s.linkK += ((alive ? 1 : 0) - s.linkK) * (alive ? 0.06 : 0.05);
    if (pp) s.par.copy(pp);
    const u = m.field.uniforms;
    u.uP0.value.copy(s.par);
    u.uP2.value.copy(live);
    // subagents: straight spokes (the kit radial tree keeps straight links from crossing); others bow
    bow(s.par, live, sub ? 0 : 1.4, s.ctrl);
    u.uP1.value.copy(s.ctrl);
    const gl = easeInOut((now - inst.bornAt) / 900);
    u.uGrow.value = inst.parent && s.linkK > 0.01 ? gl : 0;
    u.uOpacity.value = (thinking ? 0.7 : 0.45) * s.linkK;
    u.uFlow.value = s.linkK;
    u.uTime.value = reduced ? 0 : t;
    u.uHead.value = gl < 1 ? gl : -1;
    if (arrow.current) {
      const vis = inst.parent && s.linkK > 0.05 && gl >= 1;
      arrow.current.visible = !!vis;
      if (vis) {
        bezier(s.par, s.ctrl, live, 0.74, A);
        bezier(s.par, s.ctrl, live, 0.8, B);
        arrow.current.position.copy(A);
        D.subVectors(B, A);
        if (D.lengthSq() > 1e-8) arrow.current.quaternion.setFromUnitVectors(UP, D.normalize());
        const k = (sub ? 0.11 : 0.15) * Math.min(1.3, fit.scale);
        arrow.current.scale.set(k, k * 2.6, k);
        m.arrow.color.copy(color).multiplyScalar(1.5 * s.linkK);
      }
    }
  });

  const k = inst.id.split(":")[2];
  return (
    <>
      <primitive object={shellLine} />
      <mesh geometry={TUBE_GEO} material={m.field} frustumCulled={false} />
      <mesh ref={arrow} geometry={ARROW_GEO} material={m.arrow} visible={false} />
      <primitive object={trailLine} />
      <group ref={root} position={agent.pos}>
        <group ref={body} scale={1e-4}>
          <mesh geometry={SPHERE_GEO} material={m.shell} />
          <mesh geometry={SPHERE_GEO} material={m.core} scale={0.55} />
        </group>
        <mesh
          ref={hit}
          geometry={SPHERE_GEO}
          material={HIT_MAT}
          onClick={(ev) => {
            ev.stopPropagation();
            onSelect(inst.id);
          }}
          onPointerOver={() => (document.body.style.cursor = "pointer")}
          onPointerOut={() => (document.body.style.cursor = "")}
        />
        <sprite ref={halo} material={m.halo} />
        <sprite ref={flash} material={m.flash} visible={false} />
        <mesh ref={ring} geometry={RING_GEO} material={m.ring} visible={false} />
        <mesh ref={sel} geometry={RING_GEO} material={m.sel} visible={false} />
        <group ref={labelG}>
          <Label3D
            ref={label}
            anchorX={sub ? "left" : "center"}
            text={`${inst.name}${k !== undefined ? ` ${Number(k) + 1}` : ""}`}
            live={inst.job ? () => jobText(inst) : null}
            color={TYPE_COLOR[inst.type]}
            size={sub ? 0.22 : 0.28}
            opacity={0}
            fit
            pxRange={sub ? [8, 11.5] : [9, 13]}
          />
        </group>
      </group>
    </>
  );
}

// ------------------------------------------------------------------ photons: flash + travelling wave packet
const PH_SEG = 36;
const PH_LIFE = 1.5;
export function Photons() {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_PH * PH_SEG * 6), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_PH * PH_SEG * 6), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return g;
  }, []);
  const mat = useMemo(() => lineMat("#fff", true), []);
  const flashMats = useMemo(() => photons.map(() => glowSprite("#fff")), []);
  const flashes = useRef<(THREE.Sprite | null)[]>([]);
  const p = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const now = performance.now();
    const P = geo.getAttribute("position") as THREE.BufferAttribute;
    const C = geo.getAttribute("color") as THREE.BufferAttribute;
    let n = 0;
    for (let j = 0; j < MAX_PH; j++) {
      const ph = photons[j];
      const sp = flashes.current[j];
      const age = (now - ph.start) / 1000;
      if (!ph.on || age > PH_LIFE) {
        ph.on = false;
        if (sp) sp.visible = false;
        continue;
      }
      // flash at the emission point: size ∝ tokens
      if (sp) {
        const f = Math.max(0, 1 - age / 0.55);
        sp.visible = f > 0;
        sp.position.copy(ph.o);
        sp.scale.setScalar(Math.max(1e-4, (0.8 + ph.size * 1.5) * (0.6 + (1 - f) * 0.8)));
        flashMats[j].color.copy(ph.c).multiplyScalar(f * f * 1.1);
      }
      // wave packet travelling outward
      const fade = 1 - age / PH_LIFE;
      const head = 0.4 + age * 7.5;
      const len = 1.2 + ph.size * 1.1;
      const amp = 0.1 + ph.size * 0.07;
      const base = n * PH_SEG * 2;
      for (let s = 0; s < PH_SEG; s++)
        for (let e = 0; e < 2; e++) {
          const u = (s + e) / PH_SEG;
          const d = Math.max(0, head - len * (1 - u));
          const env = Math.sin(Math.PI * u);
          const w = Math.sin(u * Math.PI * 2 * (3 + ph.size)) * amp * env;
          p.copy(ph.o).addScaledVector(ph.dir, d).addScaledVector(ph.perp, w);
          P.setXYZ(base + s * 2 + e, p.x, p.y, p.z);
          const k = env * fade * 1.4;
          C.setXYZ(base + s * 2 + e, ph.c.r * k, ph.c.g * k, ph.c.b * k);
        }
      n++;
    }
    geo.setDrawRange(0, n * PH_SEG * 2);
    P.needsUpdate = true;
    C.needsUpdate = true;
  });
  return (
    <>
      <lineSegments geometry={geo} material={mat} frustumCulled={false} />
      {flashMats.map((m, j) => (
        <sprite key={j} ref={(x) => void (flashes.current[j] = x)} material={m} visible={false} />
      ))}
    </>
  );
}

// ------------------------------------------------------------------ messages: a charged quantum along the field line
const MAX_MSG = 24;
export function Messages() {
  const mats = useMemo(() => Array.from({ length: MAX_MSG }, () => glowSprite("#fff")), []);
  const refs = useRef<(THREE.Sprite | null)[]>([]);
  const s = useMemo(() => ({ c: new THREE.Vector3(), h: new THREE.Vector3() }), []);
  useFrame(() => {
    const now = performance.now();
    let n = 0;
    for (const cm of world.comets) {
      if (n >= MAX_MSG) break;
      const a = agentLive(cm.from);
      const b = agentLive(cm.to);
      const sp = refs.current[n];
      if (!a || !b || !sp) continue;
      const t = cometPos(cm, now);
      if (!cometOn(cm, now)) continue;
      bow(a, b, 1.0, s.c);
      bezier(a, s.c, b, easeInOut(t), s.h);
      sp.visible = true;
      sp.position.copy(s.h);
      sp.scale.setScalar(0.9);
      const from = world.instances.get(cm.from);
      mats[n].color.copy(from ? TYPE_C[from.type] : ICE).lerp(WHITE, 0.4).multiplyScalar(1.4 * Math.sin(Math.PI * t) + 0.2);
      n++;
    }
    for (let z = n; z < MAX_MSG; z++) if (refs.current[z]) refs.current[z]!.visible = false;
  });
  return (
    <>
      {mats.map((m, j) => (
        <sprite key={j} ref={(x) => void (refs.current[j] = x)} material={m} visible={false} />
      ))}
    </>
  );
}
