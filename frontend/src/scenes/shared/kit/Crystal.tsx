/**
 * The kit's MCP server + backend look, shared by every theme (KitScene's default McpServer / Backend slots):
 *   MCP server / resource group -> a faceted crystal: an icosahedron with a fresnel rim, glinting facet edges and a hot
 *                 core turning the other way inside it. It turns slowly and glows in the server color; while a call is
 *                 in flight it spins up (and, when the theme passes `emit`, throws sparks off its vertices).
 *   backend    -> a satellite: a small lit sphere riding its own tilted orbital ring round the crystal (each ring a
 *                 different radius / inclination, so the system reads as 3D), with a comet tail along the ring. Its
 *                 name stays at the kit's slot beside the crystal, tethered to the satellite by a faint line. A call on
 *                 it flares the satellite and races a spark round its ring.
 * Themes tint it with `mcpStyle` (KitScene prop): palette tint, brightness, halo, lift above the stage, size, sparks.
 * Both carry click targets (Picks.tsx): the crystal via the kit's Fade wrapper, the moving satellite here.
 */
import { useFrame } from "@react-three/fiber";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../Label3D";
import { hash01, mcpGlow, mcpTitle, world, type McpServer } from "../world";
import { ResourcePick } from "./Picks";
import { reduced, type KitBackend, type KitMcp } from "./state";

export type SparkEmit = (p: THREE.Vector3, v: THREE.Vector3, color: THREE.Color) => void;
export type CrystalStyle = {
  /** palette color mixed into every server color (the theme's hue), and how much (0..1) */
  tint?: THREE.ColorRepresentation;
  tintAmt: number;
  /** overall brightness of crystal, core, edges and satellites (bubblechamber / flow want < 1) */
  gain: number;
  /** soft glow sprite strength behind the crystal (0 = none; themes without bloom want it lower) */
  halo: number;
  /** stage units the crystal floats above its kit slot (xz themes: off the ground); per server slot if a function */
  lift: number | ((slot: number) => number);
  /** size multiplier (crystal, rings, satellites) */
  size: number;
  /** sparks off the crystal vertices / busy satellites (fireworks: its spark field); none when absent */
  emit?: SparkEmit;
};
export const DEFAULT_CRYSTAL: CrystalStyle = { tintAmt: 0, gain: 1, halo: 1, lift: 0, size: 1 };
export const CrystalStyleCtx = createContext<CrystalStyle>(DEFAULT_CRYSTAL);

const GEM_R = 0.8;
const WHITE = new THREE.Color(1, 1, 1);
const GOLD = new THREE.Color("#ffc46b");
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _v = new THREE.Vector3();

let _glow: THREE.Texture | null = null;
function glowTexture() {
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
const spriteMat = () => new THREE.SpriteMaterial({ map: glowTexture(), color: "#000", blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });

/** Lit, fresnel-rimmed surface (crystal facets with flat normals, satellites with smooth ones). Writes depth so
 *  orbit rings and satellites passing behind the crystal are hidden by it. */
function gemMat(alpha = 0.82) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uRim: { value: 1 }, uGain: { value: 1 }, uCore: { value: 0 }, uAlpha: { value: alpha } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uRim; uniform float uGain; uniform float uCore; uniform float uAlpha;
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec3 n = normalize(vN);
        float ndv = abs(dot(n, normalize(vV)));
        float f = pow(1.0 - ndv, 2.2);
        float key = max(0.0, dot(n, normalize(vec3(0.45, 0.75, 0.5))));
        float spec = pow(max(0.0, dot(reflect(-normalize(vec3(0.45, 0.75, 0.5)), n), normalize(vV))), 24.0);
        vec3 c = uColor * (0.07 + 0.45 * key * key)
               + mix(uColor, vec3(1.0), 0.18) * f * uRim
               + vec3(1.0, 0.92, 0.78) * (spec * 0.9 + pow(ndv, 3.0) * uCore);
        gl_FragColor = vec4(c * uGain, uAlpha + (1.0 - uAlpha) * f);
      }`,
    transparent: true,
    depthWrite: true,
    toneMapped: false,
  });
}

const GEM_GEO = new THREE.IcosahedronGeometry(GEM_R, 0);
const GEM_EDGES = new THREE.EdgesGeometry(GEM_GEO);
const CORE_GEO = new THREE.OctahedronGeometry(GEM_R * 0.36, 0);
const SAT_GEO = new THREE.SphereGeometry(1, 18, 14);
const GEM_VERTS: THREE.Vector3[] = (() => {
  const pos = GEM_GEO.getAttribute("position");
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    if (!out.some((o) => o.distanceToSquared(v) < 1e-6)) out.push(v);
  }
  return out;
})();

/** Orbit ring as a loop with a per-vertex parameter t (0..1): faint base line + comet tail + a travelling spark. */
const RING_SEG = 128;
const RING_GEO = (() => {
  const v = new Float32Array((RING_SEG + 1) * 3);
  const t = new Float32Array(RING_SEG + 1);
  for (let i = 0; i <= RING_SEG; i++) {
    const a = (i / RING_SEG) * Math.PI * 2;
    v[i * 3] = Math.cos(a);
    v[i * 3 + 1] = 0;
    v[i * 3 + 2] = Math.sin(a);
    t[i] = i / RING_SEG;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(v, 3));
  g.setAttribute("t", new THREE.BufferAttribute(t, 1));
  return g;
})();
function ringMat() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uHead: { value: 0 }, uDir: { value: 1 }, uBase: { value: 0.1 }, uTrail: { value: 0.6 }, uSpark: { value: 0 }, uSparkAmt: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float t; varying float vT;
      void main() { vT = t; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uHead; uniform float uDir; uniform float uBase; uniform float uTrail;
      uniform float uSpark; uniform float uSparkAmt; varying float vT;
      void main() {
        float d = fract((uHead - vT) * uDir);
        float tail = exp(-d * 9.0) * uTrail;
        float ds = abs(fract(vT - uSpark + 0.5) - 0.5);
        float s = exp(-ds * 90.0) * uSparkAmt;
        vec3 c = uColor * (uBase + tail) + vec3(1.0, 0.95, 0.85) * s * 1.6;
        gl_FragColor = vec4(c, 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
}

/** Live satellite positions ("server|resource"), so theme trails can end on the moving satellite. */
const satLive = new Map<string, THREE.Vector3>();
/** Stage position of a backend's orbiting satellite right now (kit crystal look), if drawn. */
export const satellitePos = (server: string, res: string) => satLive.get(`${server}|${res}`);

/** the lift of server `srv` under style `st` */
export const liftOf = (st: CrystalStyle, srv: McpServer) => (typeof st.lift === "function" ? st.lift(srv.slot) : st.lift);

function tinted(srv: McpServer, st: CrystalStyle) {
  const c = new THREE.Color(srv.color);
  if (st.tint !== undefined && st.tintAmt > 0) c.lerp(new THREE.Color(st.tint), st.tintAmt);
  return c;
}

/** Kit McpServer slot: a faceted crystal with a hot core. */
export function McpCrystal({ mcp }: { mcp: KitMcp }) {
  const st = useContext(CrystalStyleCtx);
  const srv = mcp.srv;
  const col = useMemo(() => tinted(srv, st), [srv, st]);
  const seed = useMemo(() => hash01(srv.name, 7), [srv.name]);
  const spinDir = seed < 0.5 ? 1 : -1;
  const m = useMemo(
    () => ({
      gem: gemMat(0.62),
      edges: new THREE.LineBasicMaterial({ color: "#000", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      core: new THREE.MeshBasicMaterial({ color: "#000", toneMapped: false }),
      halo: spriteMat(),
      hub: spriteMat(),
    }),
    [],
  );
  const g = useRef<THREE.Group>(null);
  const spin = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const s = useMemo(() => ({ rot: seed * 6, w: 0.25 }), [seed]);
  useFrame(({ clock }, dt) => {
    const now = performance.now();
    g.current?.position.set(mcp.pos.x, mcp.pos.y + liftOf(st, srv), mcp.pos.z);
    const busy = srv.inflight > 0;
    const act = mcpGlow(srv.activeAt, now, 1.4);
    s.w += ((busy ? 3.2 : 0.22 + act * 1.2) - s.w) * Math.min(1, dt * 2.5);
    if (!reduced) s.rot += s.w * spinDir * Math.min(dt, 0.05);
    const tt = reduced ? 0 : clock.elapsedTime;
    if (spin.current) spin.current.rotation.set(0.42 + Math.sin(tt * 0.21 + seed * 9) * 0.25, s.rot, 0.18, "XYZ");
    if (core.current) core.current.rotation.set(tt * 0.7, -s.rot * 1.7, tt * 0.4);
    const pulse = reduced ? 1 : 0.9 + 0.1 * Math.sin(tt * 2.3 + seed * 5);
    const k = st.gain;
    const u = m.gem.uniforms;
    u.uColor.value.copy(col);
    u.uRim.value = (busy ? 2.4 : 1.15 + act * 0.9) * pulse;
    u.uGain.value = (busy ? 1.25 : 0.85 + act * 0.3) * k;
    u.uCore.value = (busy ? 0.4 : 0.1 + act * 0.2) * k;
    m.edges.color.copy(col).lerp(WHITE, busy ? 0.45 : 0.2).multiplyScalar((busy ? 1.6 : 0.7 + act * 0.6) * k);
    m.core.color.copy(WHITE).lerp(col, 0.3).multiplyScalar((busy ? 2.2 : 1.1 + act * 0.7) * pulse * k);
    m.halo.color.copy(col).multiplyScalar((busy ? 0.34 : 0.08 + act * 0.18) * st.halo * k);
    m.hub.color.copy(WHITE).lerp(col, 0.45).multiplyScalar((busy ? 0.9 : 0.32 + act * 0.35) * st.halo * k);
    if (busy && !reduced && st.emit && spin.current) {
      spin.current.updateMatrixWorld();
      for (let i = 0; i < GEM_VERTS.length; i++) {
        if (Math.random() > 0.3) continue;
        _p.copy(GEM_VERTS[i]).applyMatrix4(spin.current.matrixWorld);
        g.current && _q.copy(_p).sub(g.current.position);
        const sp = 1.8 + Math.random() * 1.4;
        _v.set((-_q.z * spinDir + _q.x * 0.6) * sp, _q.y * sp * 0.8, (_q.x * spinDir + _q.z * 0.6) * sp);
        st.emit(_p, _v, Math.random() < 0.4 ? WHITE : i % 2 ? GOLD : col);
      }
    }
  });
  const R = GEM_R * st.size;
  return (
    <group ref={g}>
      <group scale={st.size}>
        {st.halo > 0 && <sprite material={m.halo} scale={GEM_R * 6.5} renderOrder={-1} />}
        {st.halo > 0 && <sprite material={m.hub} scale={GEM_R * 1.6} renderOrder={-1} />}
        <group ref={spin}>
          <mesh ref={core} geometry={CORE_GEO} material={m.core} renderOrder={0} />
          <mesh geometry={GEM_GEO} material={m.gem} renderOrder={1} />
          <lineSegments geometry={GEM_EDGES} material={m.edges} scale={1.004} renderOrder={2} />
        </group>
      </group>
      <Label3D position={[0, R + 1.15, 0]} text={mcpTitle(srv)} color={srv.color} size={0.28} pxRange={[9, 13]} />
    </group>
  );
}

const _rx = new THREE.Quaternion();
const _ryz = new THREE.Quaternion();
const _eu = new THREE.Euler();
/** Orbit of backend k round its server: radius, inclination, node line, phase, angular speed. */
function orbitOf(server: string, res: string, k: number, size: number) {
  const h = hash01(`${server}|${res}`, 13);
  const h2 = hash01(`${server}|${res}`, 29);
  const r = Math.min(2.6, 1.4 + k * 0.38 + h * 0.08) * size;
  const incl = (0.35 + h * 0.66) * (k % 2 ? -1 : 1);
  _rx.setFromEuler(_eu.set(incl, 0, 0));
  _ryz.setFromEuler(_eu.set(0, h2 * 0.9 - 0.45, k * 1.05 + h2 * 0.6, "ZYX"));
  const quat = _ryz.clone().multiply(_rx);
  const dir = h2 < 0.5 ? 1 : -1;
  const w = (0.55 / Math.pow(r / size, 1.5)) * dir;
  return { r, quat, phase: h * Math.PI * 2, w, dir };
}

/** Kit Backend slot: a lit satellite riding its tilted orbital ring round the crystal; its name stays at the kit slot. */
export function McpSatellite({ mcp, backend }: { mcp: KitMcp; backend: KitBackend }) {
  const st = useContext(CrystalStyleCtx);
  const srv = mcp.srv;
  const res = backend.res;
  const key = `${srv.name}|${res.name}`;
  const base = useMemo(() => tinted(srv, st), [srv, st]);
  const warm = useMemo(() => base.clone().lerp(GOLD, 0.45), [base]);
  const ringCol = useMemo(() => base.clone().lerp(WHITE, 0.08), [base]);
  const orb = useMemo(() => orbitOf(srv.name, res.name, backend.k, st.size), [srv.name, res.name, backend.k, st.size]);
  const m = useMemo(
    () => ({
      body: gemMat(0.95),
      ring: ringMat(),
      halo: spriteMat(),
      dot: spriteMat(),
      tether: new THREE.LineBasicMaterial({ color: "#000", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    }),
    [],
  );
  const tetherGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    return g;
  }, []);
  const ring = useRef<THREE.Group>(null);
  const sat = useRef<THREE.Group>(null);
  const anchor = useRef<THREE.Group>(null);
  const label = useRef<Label3DHandle>(null);
  const halo = useRef<THREE.Sprite>(null);
  const last = useRef("");
  const s = useMemo(() => ({ ang: orb.phase, spark: 0, wasBusy: false }), [orb]);
  const live = useMemo(() => {
    const v = new THREE.Vector3();
    satLive.set(key, v);
    return v;
  }, [key]);
  useEffect(() => () => void (satLive.get(key) === live && satLive.delete(key)), [key, live]);
  useFrame(({ clock }, dt) => {
    const now = performance.now();
    const busy = res.inflight > 0;
    const act = mcpGlow(res.activeAt, now, 1.4);
    const d = Math.min(dt, 0.05);
    const k = st.gain;
    if (!reduced) s.ang += orb.w * (busy ? 2.2 : 1 + act) * d;
    const lift = liftOf(st, srv);
    _q.set(mcp.pos.x, mcp.pos.y + lift, mcp.pos.z);
    const rg = ring.current;
    if (rg) {
      rg.position.copy(_q);
      rg.quaternion.copy(orb.quat);
      rg.scale.setScalar(orb.r);
    }
    _p.set(Math.cos(s.ang), 0, Math.sin(s.ang)).multiplyScalar(orb.r).applyQuaternion(orb.quat).add(_q);
    live.copy(_p);
    sat.current?.position.copy(_p);
    anchor.current?.position.set(backend.pos.x, backend.pos.y + lift, backend.pos.z);
    const head = (((s.ang / (Math.PI * 2)) % 1) + 1) % 1;
    if (busy) s.spark = (s.spark + d * 1.4) % 1;
    else if (s.wasBusy) s.spark = 0;
    s.wasBusy = busy;
    const ru = m.ring.uniforms;
    ru.uColor.value.copy(ringCol).multiplyScalar(k);
    ru.uHead.value = head;
    ru.uDir.value = orb.dir;
    ru.uBase.value = busy ? 0.3 : 0.13 + act * 0.12;
    ru.uTrail.value = busy ? 1.6 : 0.8 + act * 0.6;
    ru.uSpark.value = head - orb.dir * (1 - s.spark) * 0.6;
    ru.uSparkAmt.value = busy ? Math.sin(s.spark * Math.PI) * k : 0;
    const flick = reduced ? 1 : 0.92 + 0.08 * Math.sin(clock.elapsedTime * 6 + backend.k * 3);
    const lit = busy ? 1 : 0.3 + act * 0.6;
    const bu = m.body.uniforms;
    bu.uColor.value.copy(warm);
    bu.uRim.value = (0.8 + lit * 1.4) * flick;
    bu.uGain.value = (0.75 + lit * 0.6) * k;
    bu.uCore.value = (busy ? 0.9 : 0.05 + act * 0.4) * k;
    m.halo.color.copy(warm).multiplyScalar((busy ? 0.55 : 0.07 + act * 0.25) * flick * st.halo * k);
    halo.current?.scale.setScalar((busy ? 1.5 : 0.75 + act * 0.4) * st.size);
    m.dot.color.copy(ringCol).multiplyScalar((busy ? 0.6 : 0.28 + act * 0.2) * k);
    m.tether.color.copy(ringCol).multiplyScalar((busy ? 0.4 : 0.1 + act * 0.12) * k);
    const tp = tetherGeo.getAttribute("position") as THREE.BufferAttribute;
    tp.setXYZ(0, backend.pos.x, backend.pos.y + lift, backend.pos.z);
    tp.setXYZ(1, _p.x, _p.y, _p.z);
    tp.needsUpdate = true;
    tetherGeo.computeBoundingSphere();
    if (busy && !reduced && st.emit && Math.random() < 0.5) {
      _v.set((Math.random() - 0.5) * 0.7, 1.6 + Math.random(), (Math.random() - 0.5) * 0.7);
      st.emit(_p, _v, Math.random() < 0.4 ? WHITE : warm);
    }
    let txt = res.name;
    if (busy) {
      let tool = "";
      for (const p of world.mcpPending.values()) if (p.server === srv.name && p.resource === res.name) tool = p.tool;
      txt = `${res.name} › ${tool || "query"}()`;
    } else if (act > 0.25 && res.calls > 0) txt = `${res.name} ·`;
    if (label.current) {
      if (txt !== last.current) label.current.setText((last.current = txt));
      label.current.setOpacity(busy ? 1 : 0.55 + act * 0.45);
      label.current.setEmphasis(busy);
    }
  });
  const sz = (res.kind === "warehouse" || res.kind === "spark" ? 1.2 : 1) * st.size;
  return (
    <group>
      <group ref={ring}>
        <lineLoop geometry={RING_GEO} material={m.ring} />
      </group>
      <lineSegments geometry={tetherGeo} material={m.tether} />
      <group ref={sat}>
        <sprite ref={halo} material={m.halo} />
        <mesh geometry={SAT_GEO} material={m.body} scale={0.17 * sz} />
        <ResourcePick sel={{ type: "backend", server: srv.name, resource: res.name }} r={0.3 * sz} color={srv.color} mix={() => backend.mix * mcp.mix} />
      </group>
      <group ref={anchor}>
        <sprite material={m.dot} scale={0.32} />
        <Label3D position={[0, -0.35, 0]} text={res.name} color={srv.color} size={0.2} opacity={0.55} pxRange={[7.5, 11.5]} />
      </group>
    </group>
  );
}
