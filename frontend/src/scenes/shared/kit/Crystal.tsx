/**
 * The kit's MCP server + backend look, shared by every theme (KitScene's default McpServer / Backend slots):
 *   MCP server / resource group -> a faceted crystal: an icosahedron with a fresnel rim, glinting facet edges and a hot
 *                 core turning the other way inside it. It turns slowly and glows in the server color; while a call is
 *                 in flight it spins up (and, when the theme passes `emit`, throws sparks off its vertices).
 *   backend    -> a satellite: an emissive sphere colored by its resource KIND (SAT_KIND_COLOR: db blue, warehouse
 *                 violet, spark orange, model pink, cache red, queue teal, ...; the theme tint only nudges it) with a
 *                 fresnel rim, a ring + kind glyph on its face and a soft halo, riding its own tilted orbital ring round
 *                 the crystal (each ring a different radius / inclination, so the system reads as 3D). Its name label
 *                 rides right beside it (kind + calls/s badge underneath while recently used). A call flares it (scale
 *                 pulse + glow) and shoots a bolt crystal -> satellite; a result shoots one back.
 *   model group -> (mcp_register kind "model") a gyroscope hub: a glowing sphere in two crossed spinning rings, colored
 *                 by what it holds; its models are satellites, an LLM (indigo, speech-bubble glyph, tag `llm`) clearly
 *                 apart from a classic ML model (pink, node glyph, tag `ml model`).
 *   external API -> (mcp_register kind "api", `api:<host>`) a wireframe globe labelled "API · <host>", a ring pings
 *                 out on each call (no satellite: the node is the host).
 *   database   -> (mcp_register kind "database", `db:<system>` servers) a glowing stack of three discs, the classic DB
 *                 cylinder, labelled "Database · <system>"; each query sends a bright ring up the stack and flashes the
 *                 disc rims, while queries are in flight the rims stay lit. Its collections / tables / indices are the
 *                 satellites, on near-flat orbits round the stack (rings), tagged `index` / `table` / `collection`.
 * Themes tint it with `mcpStyle` (KitScene prop): palette tint, brightness, halo, lift above the stage, size, sparks.
 * Both carry click targets (Picks.tsx): the crystal via the kit's Fade wrapper, the moving satellite here.
 */
import { useFrame } from "@react-three/fiber";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../Label3D";
import { resInfo, sparkSeries } from "../resinfo";
import { collectionNoun, hash01, mcpGlow, mcpTitle, modelGroupPrefix, serverScale, world, type McpServer, type ResourceKind } from "../world";
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
const _rq = new THREE.Vector3();

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
const satRad = new Map<string, number>();
const satSideMap = new Map<string, 1 | -1>();
/** Which side of the satellite its name label hangs on (screen right 1, left -1). */
export const satelliteSide = (server: string, res: string) => satSideMap.get(`${server}|${res}`) ?? 1;
/** World radius of that satellite (labels / badges placed beside it), if drawn. */
export const satelliteRadius = (server: string, res: string) => satRad.get(`${server}|${res}`);

/** the lift of server `srv` under style `st` */
export const liftOf = (st: CrystalStyle, srv: McpServer) => (typeof st.lift === "function" ? st.lift(srv.slot) : st.lift);

function tinted(srv: McpServer, st: CrystalStyle) {
  const c = new THREE.Color(srv.color);
  if (st.tint !== undefined && st.tintAmt > 0) c.lerp(new THREE.Color(st.tint), st.tintAmt);
  return c;
}

/** Kit McpServer slot: a faceted crystal with a hot core; a database node (kind "database") is a disc stack instead. */
export function McpCrystal({ mcp }: { mcp: KitMcp }) {
  const k = mcp.srv.kind;
  return k === "database" ? <DbStack mcp={mcp} /> : k === "model" ? <ModelHub mcp={mcp} /> : k === "api" ? <ApiGlobe mcp={mcp} /> : <GemCrystal mcp={mcp} />;
}

// ------------------------------------------------------------------ external API node: a wireframe globe
const GLOBE_R = 0.62;
const GLOBE_GEO = new THREE.SphereGeometry(GLOBE_R, 32, 24);
/** meridians (rotated about y) and parallels (scaled + shifted circles) of the globe */
const GLOBE_LINES: { rot: number; y: number; r: number }[] = [
  ...[0, 1, 2, 3].map((i) => ({ rot: (i / 4) * Math.PI, y: NaN, r: GLOBE_R })),
  ...[-0.55, 0, 0.55].map((f) => ({ rot: 0, y: f * GLOBE_R, r: GLOBE_R * Math.sqrt(1 - f * f) })),
];

/**
 * Kit external API node (mcp_register kind "api", `api:<host>`): a glowing wireframe globe turning slowly, labelled
 * "API · <host>". A call flashes the grid and sends a ring out from the equator; in-flight calls keep it lit.
 */
function ApiGlobe({ mcp }: { mcp: KitMcp }) {
  const st = useContext(CrystalStyleCtx);
  const srv = mcp.srv;
  const col = useMemo(() => tinted(srv, st), [srv, st]);
  const seed = useMemo(() => hash01(srv.name, 7), [srv.name]);
  const m = useMemo(
    () => ({
      body: gemMat(0.35),
      grid: new THREE.LineBasicMaterial({ color: "#000", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      ping: new THREE.LineBasicMaterial({ color: "#000", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      halo: spriteMat(),
    }),
    [],
  );
  const g = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const lab = useRef<THREE.Group>(null);
  const spin = useRef<THREE.Group>(null);
  const ping = useRef<THREE.LineLoop>(null);
  const s = useMemo(() => ({ a: seed * 6, calls: srv.calls, at: -1e9, flash: 0 }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame(({ clock }, dt) => {
    const now = performance.now();
    g.current?.position.set(mcp.pos.x, mcp.pos.y + liftOf(st, srv), mcp.pos.z);
    const busy = srv.inflight > 0;
    const act = mcpGlow(srv.activeAt, now, 1.4);
    const d = Math.min(dt, 0.05);
    if (srv.calls !== s.calls) (s.calls = srv.calls), (s.at = now), (s.flash = 1);
    s.flash = Math.max(0, s.flash - d * 1.6);
    if (!reduced) s.a += (busy ? 1.4 : 0.25 + act * 0.6) * d;
    const tt = reduced ? 0 : clock.elapsedTime;
    spin.current?.rotation.set(0.38 + Math.sin(tt * 0.2 + seed * 4) * 0.06, s.a, 0.12, "XYZ");
    const k = st.gain;
    const u = m.body.uniforms;
    u.uColor.value.copy(col);
    u.uRim.value = (busy ? 2 : 1 + act * 0.7) + s.flash;
    u.uGain.value = (busy ? 1.1 : 0.7 + act * 0.3 + s.flash * 0.3) * k;
    u.uCore.value = (busy ? 0.2 : 0.05 + act * 0.1) * k;
    m.grid.color.copy(col).lerp(WHITE, busy ? 0.4 : 0.15).multiplyScalar((busy ? 1.5 : 0.6 + act * 0.6 + s.flash * 1.1) * k);
    const pu = (now - s.at) / 700;
    const pl = ping.current;
    if (pl) {
      pl.visible = pu >= 0 && pu < 1 && !reduced;
      pl.scale.setScalar(GLOBE_R * (1.05 + pu * 2.2));
      m.ping.color.copy(WHITE).lerp(col, 0.3).multiplyScalar(3.4 * (1 - pu) * k);
    }
    const sc = serverScale(srv) * st.size;
    if (body.current) body.current.scale.setScalar(sc);
    if (lab.current) lab.current.position.y = GLOBE_R * sc + 0.5;
    m.halo.color.copy(col).multiplyScalar((busy ? 0.3 : 0.07 + act * 0.16 + s.flash * 0.15) * st.halo * k);
  });
  return (
    <group ref={g}>
      <group ref={body} scale={st.size * serverScale(srv)}>
        {st.halo > 0 && <sprite material={m.halo} scale={GEM_R * 4} renderOrder={-1} />}
        <group ref={spin}>
          <mesh geometry={GLOBE_GEO} material={m.body} renderOrder={1} />
          {GLOBE_LINES.map((l, i) =>
            Number.isNaN(l.y) ? (
              <lineLoop key={i} geometry={CIRCLE_GEO} material={m.grid} rotation={new THREE.Euler(Math.PI / 2, l.rot, 0, "YXZ")} scale={l.r * 1.01} renderOrder={2} />
            ) : (
              <lineLoop key={i} geometry={CIRCLE_GEO} material={m.grid} position-y={l.y} scale={l.r * 1.01} renderOrder={2} />
            ),
          )}
        </group>
        <lineLoop ref={ping} geometry={CIRCLE_GEO} material={m.ping} visible={false} renderOrder={3} />
      </group>
      <group ref={lab}>
        <Label3D text={mcpTitle(srv)} color={srv.color} size={0.3} anchorY="bottom" pxRange={[10, 14]} />
      </group>
    </group>
  );
}

// ------------------------------------------------------------------ model group: a gyroscope hub
const HUB_CORE_GEO = new THREE.SphereGeometry(0.42, 32, 24);
const HUB_RING_GEO = new THREE.TorusGeometry(0.78, 0.045, 10, 72);

/**
 * Kit model-group node (mcp_register kind "model"): a glowing sphere inside two crossed rings spinning like a
 * gyroscope, in the color of what it holds (LLM indigo, ML model pink, both: a mix). Labelled "LLM · <group>",
 * "ML · <group>" or "Models · <group>". A call spins the rings up and flares the core.
 */
function ModelHub({ mcp }: { mcp: KitMcp }) {
  const st = useContext(CrystalStyleCtx);
  const srv = mcp.srv;
  const seed = useMemo(() => hash01(srv.name, 7), [srv.name]);
  const m = useMemo(
    () => ({
      core: gemMat(0.9),
      rings: [0, 1].map(() => new THREE.MeshBasicMaterial({ color: "#000", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })),
      halo: spriteMat(),
      hub: spriteMat(),
      ping: new THREE.LineBasicMaterial({ color: "#000", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    }),
    [],
  );
  const g = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const lab = useRef<THREE.Group>(null);
  const ping = useRef<THREE.LineLoop>(null);
  const r0 = useRef<THREE.Group>(null);
  const r1 = useRef<THREE.Group>(null);
  const label = useRef<Label3DHandle>(null);
  const s = useMemo(() => ({ a: seed * 6, w: 0.3, calls: srv.calls, flare: 0, pre: "", at: 0, pingAt: -1e9, col: new THREE.Color(SAT_KIND_COLOR.model) }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame(({ clock }, dt) => {
    const now = performance.now();
    g.current?.position.set(mcp.pos.x, mcp.pos.y + liftOf(st, srv), mcp.pos.z);
    if (now - s.at > 500) {
      s.at = now;
      const pre = modelGroupPrefix(srv.name);
      if (pre !== s.pre) {
        s.pre = pre;
        const c = pre === "LLM" ? SAT_KIND_COLOR.llm : pre === "ML" ? SAT_KIND_COLOR.model : "#b98cf0";
        s.col.set(c);
        if (st.tint !== undefined && st.tintAmt > 0) s.col.lerp(new THREE.Color(st.tint), st.tintAmt * 0.35);
        label.current?.setText(mcpTitle(srv));
      }
    }
    const busy = srv.inflight > 0;
    const act = mcpGlow(srv.activeAt, now, 1.4);
    const d = Math.min(dt, 0.05);
    if (srv.calls !== s.calls) (s.calls = srv.calls), (s.flare = 1), (s.pingAt = now);
    const pu = (now - s.pingAt) / 800;
    const pg = ping.current;
    if (pg) {
      pg.visible = pu >= 0 && pu < 1 && !reduced;
      pg.scale.setScalar(0.85 + pu * 1.6);
      m.ping.color.copy(WHITE).lerp(s.col, 0.3).multiplyScalar(3.4 * (1 - pu) * st.gain);
    }
    const sc = serverScale(srv) * st.size;
    if (body.current) body.current.scale.setScalar(sc);
    if (lab.current) lab.current.position.y = 1.0 * sc + 0.5;
    s.flare = Math.max(0, s.flare - d * 1.6);
    s.w += ((busy ? 3 : 0.35 + act * 1.2 + s.flare * 2) - s.w) * Math.min(1, d * 2.5);
    if (!reduced) s.a += s.w * d;
    const tt = reduced ? 0 : clock.elapsedTime;
    r0.current?.rotation.set(Math.PI / 2 + 0.35, s.a, 0, "YXZ");
    r1.current?.rotation.set(0.35 + Math.sin(tt * 0.3 + seed) * 0.1, -s.a * 0.8, Math.PI / 2.6, "XYZ");
    const k = st.gain;
    const pulse = reduced ? 1 : 0.92 + 0.08 * Math.sin(tt * 2.4 + seed * 5);
    const cu = m.core.uniforms;
    cu.uColor.value.copy(s.col);
    cu.uRim.value = (busy ? 2.2 : 1.1 + act * 0.8) * pulse + s.flare;
    cu.uGain.value = (busy ? 1.3 : 0.9 + act * 0.3 + s.flare * 0.4) * k;
    cu.uCore.value = (busy ? 0.5 : 0.15 + act * 0.2) * k + s.flare * 0.5;
    for (const r of m.rings) r.color.copy(s.col).lerp(WHITE, busy ? 0.4 : 0.15).multiplyScalar((busy ? 1.5 : 0.6 + act * 0.6 + s.flare * 0.8) * k);
    m.halo.color.copy(s.col).multiplyScalar((busy ? 0.3 : 0.07 + act * 0.15 + s.flare * 0.3) * st.halo * k);
    m.hub.color.copy(WHITE).lerp(s.col, 0.4).multiplyScalar((busy ? 0.9 : 0.3 + act * 0.35 + s.flare * 0.4) * st.halo * k);
    if (busy && !reduced && st.emit && g.current && Math.random() < 0.3) {
      const a = Math.random() * Math.PI * 2;
      _p.set(Math.cos(a) * 0.78 * st.size, 0, Math.sin(a) * 0.78 * st.size).add(g.current.position);
      _v.set(-Math.sin(a) * 2, 1 + Math.random(), Math.cos(a) * 2);
      st.emit(_p, _v, Math.random() < 0.4 ? WHITE : s.col);
    }
  });
  return (
    <group ref={g}>
      <group ref={body} scale={st.size * serverScale(srv)}>
        {st.halo > 0 && <sprite material={m.halo} scale={GEM_R * 4.5} renderOrder={-1} />}
        {st.halo > 0 && <sprite material={m.hub} scale={GEM_R * 1.6} renderOrder={-1} />}
        <lineLoop ref={ping} geometry={CIRCLE_GEO} material={m.ping} visible={false} rotation-x={0.35} renderOrder={3} />
        <mesh geometry={HUB_CORE_GEO} material={m.core} renderOrder={1} />
        <group ref={r0}>
          <mesh geometry={HUB_RING_GEO} material={m.rings[0]} renderOrder={2} />
        </group>
        <group ref={r1}>
          <mesh geometry={HUB_RING_GEO} material={m.rings[1]} scale={1.12} renderOrder={2} />
        </group>
      </group>
      <group ref={lab}>
        <Label3D ref={label} text={mcpTitle(srv)} color={srv.color} size={0.3} anchorY="bottom" pxRange={[10, 14]} />
      </group>
    </group>
  );
}

// ------------------------------------------------------------------ database node: a stack of glowing discs
const DB_R = 0.7;
const DB_H = 0.3;
const DB_GAP = 0.1;
const DB_DISCS = [-1, 0, 1].map((k) => k * (DB_H + DB_GAP));
const DB_TOP = DB_DISCS[2] + DB_H / 2;
const DB_GEO = new THREE.CylinderGeometry(DB_R, DB_R, DB_H, 48, 1, false);
const CIRCLE_GEO = (() => {
  const n = 64;
  const v = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    v[i * 3] = Math.cos(a);
    v[i * 3 + 2] = Math.sin(a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(v, 3));
  return g;
})();
/** a query's ring travels the stack bottom -> top in this long */
const DB_PULSE_MS = 650;

/** Kit database node: three stacked discs (fresnel-lit, rims glowing), a query pulse ring rising through them. */
function DbStack({ mcp }: { mcp: KitMcp }) {
  const st = useContext(CrystalStyleCtx);
  const srv = mcp.srv;
  const col = useMemo(() => tinted(srv, st), [srv, st]);
  const seed = useMemo(() => hash01(srv.name, 7), [srv.name]);
  const m = useMemo(
    () => ({
      discs: DB_DISCS.map(() => gemMat(0.7)),
      rims: DB_DISCS.map(() => new THREE.LineBasicMaterial({ color: "#000", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })),
      pulse: new THREE.LineBasicMaterial({ color: "#000", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      halo: spriteMat(),
      hub: spriteMat(),
    }),
    [],
  );
  const g = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const lab = useRef<THREE.Group>(null);
  const tilt = useRef<THREE.Group>(null);
  const pulse = useRef<THREE.LineLoop>(null);
  const s = useMemo(() => ({ calls: srv.calls, at: -1e9, flash: 0 }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame(({ clock }, dt) => {
    const now = performance.now();
    g.current?.position.set(mcp.pos.x, mcp.pos.y + liftOf(st, srv), mcp.pos.z);
    const busy = srv.inflight > 0;
    const act = mcpGlow(srv.activeAt, now, 1.4);
    if (srv.calls !== s.calls) {
      s.calls = srv.calls;
      s.at = now;
      s.flash = 1;
    }
    s.flash = Math.max(0, s.flash - Math.min(dt, 0.05) * 1.8);
    const tt = reduced ? 0 : clock.elapsedTime;
    // a slow sway, so the stack reads as 3D (top ellipses open and close a little)
    if (tilt.current) tilt.current.rotation.set(0.32 + Math.sin(tt * 0.23 + seed * 7) * 0.08, 0, Math.sin(tt * 0.17 + seed * 3) * 0.06);
    const k = st.gain;
    const breathe = reduced ? 1 : 0.92 + 0.08 * Math.sin(tt * 2.1 + seed * 5);
    // the pulse: 0..1 up the stack after the last query; each disc flares as it passes
    const u = (now - s.at) / DB_PULSE_MS;
    const py = -DB_TOP + Math.min(1, Math.max(0, u)) * DB_TOP * 2;
    const pOn = u >= 0 && u < 1 && !reduced;
    for (let i = 0; i < DB_DISCS.length; i++) {
      const near = pOn ? Math.exp(-Math.pow((py - DB_DISCS[i]) / (DB_H * 0.9), 2)) : 0;
      const gu = m.discs[i].uniforms;
      gu.uColor.value.copy(col);
      gu.uRim.value = (busy ? 2.1 : 1.05 + act * 0.8) * breathe + near * 1.6;
      gu.uGain.value = (busy ? 1.2 : 0.82 + act * 0.3 + near * 0.4) * k;
      gu.uCore.value = (busy ? 0.25 : 0.06 + act * 0.12) * k + near * 0.3;
      m.rims[i].color.copy(col).lerp(WHITE, busy || near > 0.3 ? 0.5 : 0.2).multiplyScalar((busy ? 1.6 : 0.65 + act * 0.6 + near * 1.4 + s.flash * 0.3) * k);
    }
    const pl = pulse.current;
    if (pl) {
      pl.visible = pOn;
      pl.position.y = py;
      pl.scale.setScalar(DB_R * (1.15 + 0.45 * Math.sin(Math.min(1, u) * Math.PI)));
      m.pulse.color.copy(WHITE).lerp(col, 0.25).multiplyScalar(3.6 * (1 - Math.max(0, u) * 0.4) * k);
    }
    const sc = serverScale(srv) * st.size;
    if (body.current) body.current.scale.setScalar(sc);
    if (lab.current) lab.current.position.y = (DB_TOP + DB_GAP) * sc + 0.5;
    m.halo.color.copy(col).multiplyScalar((busy ? 0.3 : 0.07 + act * 0.15 + s.flash * 0.3) * st.halo * k);
    m.hub.color.copy(WHITE).lerp(col, 0.45).multiplyScalar((busy ? 0.8 : 0.26 + act * 0.3 + s.flash * 0.6) * st.halo * k);
    if (busy && !reduced && st.emit && g.current && Math.random() < 0.35) {
      const a = Math.random() * Math.PI * 2;
      _p.set(Math.cos(a) * DB_R * st.size, DB_TOP * st.size, Math.sin(a) * DB_R * st.size).add(g.current.position);
      _v.set(Math.cos(a) * 0.8, 1.6 + Math.random(), Math.sin(a) * 0.8);
      st.emit(_p, _v, Math.random() < 0.4 ? WHITE : col);
    }
  });
  return (
    <group ref={g}>
      <group ref={body} scale={st.size * serverScale(srv)}>
        {st.halo > 0 && <sprite material={m.halo} scale={GEM_R * 4.5} renderOrder={-1} />}
        {st.halo > 0 && <sprite material={m.hub} scale={GEM_R * 1.8} renderOrder={-1} />}
        <group ref={tilt}>
          {DB_DISCS.map((y, i) => (
            <group key={i} position-y={y}>
              <mesh geometry={DB_GEO} material={m.discs[i]} renderOrder={1} />
              <lineLoop geometry={CIRCLE_GEO} material={m.rims[i]} position-y={DB_H / 2} scale={DB_R * 1.004} renderOrder={2} />
              <lineLoop geometry={CIRCLE_GEO} material={m.rims[i]} position-y={-DB_H / 2} scale={DB_R * 1.004} renderOrder={2} />
            </group>
          ))}
          <lineLoop ref={pulse} geometry={CIRCLE_GEO} material={m.pulse} visible={false} renderOrder={3} />
        </group>
      </group>
      <group ref={lab}>
        <Label3D text={mcpTitle(srv)} color={srv.color} size={0.3} anchorY="bottom" pxRange={[10, 14]} />
      </group>
    </group>
  );
}

function GemCrystal({ mcp }: { mcp: KitMcp }) {
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
function orbitOf(server: string, res: string, k: number, size: number, flat = false) {
  const h = hash01(`${server}|${res}`, 13);
  const h2 = hash01(`${server}|${res}`, 29);
  const r = Math.min(2.9, 1.55 + k * 0.42 + h * 0.08) * size;
  // database collections ride near-flat rings round the disc stack (a slight tilt keeps them readable in 3D)
  const incl = flat ? (0.1 + h * 0.16) * (k % 2 ? -1 : 1) : (0.35 + h * 0.66) * (k % 2 ? -1 : 1);
  _rx.setFromEuler(_eu.set(incl, 0, 0));
  if (flat) _ryz.setFromEuler(_eu.set(0.3, h2 * Math.PI * 2, 0, "XYZ"));
  else _ryz.setFromEuler(_eu.set(0, h2 * 0.9 - 0.45, k * 1.05 + h2 * 0.6, "ZYX"));
  const quat = _ryz.clone().multiply(_rx);
  const dir = h2 < 0.5 ? 1 : -1;
  const w = (0.55 / Math.pow(r / size, 1.5)) * dir;
  return { r, quat, phase: h * Math.PI * 2, w, dir };
}

/**
 * Satellite color per reported resource kind, the same in every theme (a theme's `tint` only nudges it), so a kind
 * reads at a glance: databases / graphs blue, warehouses violet, spark orange, storage amber, models pink, GPUs green,
 * caches red, queues teal, workers gold, HTTP / API hosts lime.
 */
export const SAT_KIND_COLOR: Record<ResourceKind, string> = {
  db: "#38bdf8",
  warehouse: "#a78bfa",
  spark: "#fb923c",
  storage: "#fcd34d",
  model: "#f472b6",
  llm: "#818cf8",
  gpu: "#4ade80",
  cache: "#f87171",
  queue: "#2dd4bf",
  worker: "#fbbf24",
  api: "#a3e635",
};
/** short kind tag under a satellite's name */
const KIND_TAG: Record<ResourceKind, string> = { db: "db", warehouse: "warehouse", spark: "spark", storage: "storage", model: "ml model", llm: "llm", gpu: "gpu", cache: "cache", queue: "queue", worker: "worker", api: "api" };
const kindOf = (k: string): ResourceKind => (k in SAT_KIND_COLOR ? (k as ResourceKind) : "api");

/** Kind glyph textures (a thin ring round the satellite + a small white icon on its face), drawn once per kind. */
const _glyph = new Map<ResourceKind, THREE.Texture>();
function glyphTexture(kind: ResourceKind) {
  let t = _glyph.get(kind);
  if (t) return t;
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const m = S / 2;
  g.strokeStyle = "rgba(255,255,255,0.9)";
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.lineCap = g.lineJoin = "round";
  // outer ring (just outside the sphere's silhouette)
  g.lineWidth = 3;
  g.beginPath();
  g.arc(m, m, 59, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 5.5;
  const R = 21;
  g.beginPath();
  switch (kind) {
    case "db": // cylinder
      g.ellipse(m, m - R * 0.7, R, R * 0.38, 0, 0, Math.PI * 2);
      g.moveTo(m - R, m - R * 0.7);
      g.lineTo(m - R, m + R * 0.7);
      g.ellipse(m, m + R * 0.7, R, R * 0.38, 0, Math.PI, 0, true);
      g.lineTo(m + R, m - R * 0.7);
      break;
    case "cache": // bolt
      g.moveTo(m + R * 0.25, m - R * 1.1);
      g.lineTo(m - R * 0.55, m + R * 0.1);
      g.lineTo(m + R * 0.1, m + R * 0.1);
      g.lineTo(m - R * 0.25, m + R * 1.1);
      g.lineTo(m + R * 0.6, m - R * 0.15);
      g.lineTo(m - R * 0.05, m - R * 0.15);
      g.closePath();
      break;
    case "warehouse": // 3x3 grid
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) g.rect(m + i * R * 0.75 - R * 0.28, m + j * R * 0.75 - R * 0.28, R * 0.56, R * 0.56);
      break;
    case "spark": // 8-ray star
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const r0 = i % 2 ? R * 0.3 : R * 0.2;
        const r1 = i % 2 ? R * 0.8 : R * 1.15;
        g.moveTo(m + Math.cos(a) * r0, m + Math.sin(a) * r0);
        g.lineTo(m + Math.cos(a) * r1, m + Math.sin(a) * r1);
      }
      break;
    case "model": { // three connected nodes
      const pts = [[0, -1], [-0.95, 0.75], [0.95, 0.75]].map(([x, y]) => [m + x * R, m + y * R]);
      g.moveTo(pts[0][0], pts[0][1]);
      g.lineTo(pts[1][0], pts[1][1]);
      g.lineTo(pts[2][0], pts[2][1]);
      g.closePath();
      g.stroke();
      g.beginPath();
      for (const [x, y] of pts) (g.moveTo(x + 6, y), g.arc(x, y, 6, 0, Math.PI * 2));
      g.fill();
      break;
    }
    case "llm": // speech bubble with three dots
      g.moveTo(m - R, m - R * 0.7);
      g.lineTo(m + R, m - R * 0.7);
      g.lineTo(m + R, m + R * 0.45);
      g.lineTo(m - R * 0.1, m + R * 0.45);
      g.lineTo(m - R * 0.6, m + R * 1.05);
      g.lineTo(m - R * 0.5, m + R * 0.45);
      g.lineTo(m - R, m + R * 0.45);
      g.closePath();
      g.stroke();
      g.beginPath();
      for (let i = -1; i <= 1; i++) (g.moveTo(m + i * R * 0.5 + 4, m - R * 0.12), g.arc(m + i * R * 0.5, m - R * 0.12, 4, 0, Math.PI * 2));
      g.fill();
      break;
    case "gpu": // chip with pins
      g.rect(m - R * 0.65, m - R * 0.65, R * 1.3, R * 1.3);
      for (let i = -1; i <= 1; i++) {
        g.moveTo(m + i * R * 0.4, m - R * 0.65);
        g.lineTo(m + i * R * 0.4, m - R * 1.05);
        g.moveTo(m + i * R * 0.4, m + R * 0.65);
        g.lineTo(m + i * R * 0.4, m + R * 1.05);
      }
      break;
    case "storage": // box
      g.rect(m - R, m - R * 0.55, R * 2, R * 1.4);
      g.moveTo(m - R * 1.1, m - R * 0.55);
      g.lineTo(m - R * 0.6, m - R * 1.05);
      g.lineTo(m + R * 0.6, m - R * 1.05);
      g.lineTo(m + R * 1.1, m - R * 0.55);
      g.moveTo(m - R * 0.35, m - R * 0.05);
      g.lineTo(m + R * 0.35, m - R * 0.05);
      break;
    case "queue": // stacked bars
      for (let i = -1; i <= 1; i++) {
        g.moveTo(m - R + (i + 1) * 4, m + i * R * 0.7);
        g.lineTo(m + R - (1 - i) * 4, m + i * R * 0.7);
      }
      break;
    case "worker": // gear
      g.arc(m, m, R * 0.5, 0, Math.PI * 2);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        g.moveTo(m + Math.cos(a) * R * 0.75, m + Math.sin(a) * R * 0.75);
        g.lineTo(m + Math.cos(a) * R * 1.1, m + Math.sin(a) * R * 1.1);
      }
      break;
    default: // api: < >
      g.moveTo(m - R * 0.25, m - R * 0.8);
      g.lineTo(m - R * 1.0, m);
      g.lineTo(m - R * 0.25, m + R * 0.8);
      g.moveTo(m + R * 0.25, m - R * 0.8);
      g.lineTo(m + R * 1.0, m);
      g.lineTo(m + R * 0.25, m + R * 0.8);
  }
  g.stroke();
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  _glyph.set(kind, t);
  return t;
}

/** Emissive satellite body: a self-lit sphere in its kind color with a fresnel rim and a hot center when flaring. */
function satMat() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uRim: { value: new THREE.Color() }, uGain: { value: 1 }, uHot: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform vec3 uRim; uniform float uGain; uniform float uHot;
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec3 n = normalize(vN);
        float ndv = max(0.0, dot(n, normalize(vV)));
        float f = pow(1.0 - ndv, 2.4);
        vec3 L = normalize(vec3(0.45, 0.75, 0.5));
        float key = max(0.0, dot(n, L));
        float spec = pow(max(0.0, dot(reflect(-L, n), normalize(vV))), 28.0);
        vec3 c = uColor * (0.42 + 0.55 * key) + uRim * f * 1.6 + vec3(1.0, 0.96, 0.9) * (spec * 0.7 + pow(ndv, 4.0) * uHot);
        gl_FragColor = vec4(c * uGain, 1.0);
      }`,
    toneMapped: false,
  });
}

const BOLT_MS = 380;
const BADGE_HOLD_MS = 15000;
const fmtRate = (r: number) => (r >= 10 ? `${Math.round(r)}/s` : r >= 0.1 ? `${Math.round(r * 10) / 10}/s` : `${Math.max(1, Math.round(r * 60))}/min`);
/** calls per second on `server|resource` over the last 10 s (Resource details' aggregate) */
function recentRate(key: string, now: number) {
  const a = resInfo.backends.get(key);
  if (!a || now - a.last > BADGE_HOLD_MS) return 0;
  const s = sparkSeries(a, now);
  let n = 0;
  for (let i = s.length - 10; i < s.length; i++) n += s[i];
  return n / 10;
}

/**
 * Kit Backend slot: an emissive satellite in its kind color (ring + kind glyph) riding its tilted orbital ring round
 * the crystal, its name label riding beside it. A call flares it (scale pulse + glow) and shoots a bolt from the
 * crystal to it; a result shoots one back. Recently used satellites carry a calls/s badge.
 */
export function McpSatellite({ mcp, backend }: { mcp: KitMcp; backend: KitBackend }) {
  const st = useContext(CrystalStyleCtx);
  const srv = mcp.srv;
  const res = backend.res;
  const key = `${srv.name}|${res.name}`;
  const kind = kindOf(res.sub);
  const base = useMemo(() => tinted(srv, st), [srv, st]);
  const kcol = useMemo(() => {
    const c = new THREE.Color(SAT_KIND_COLOR[kind]);
    if (st.tint !== undefined && st.tintAmt > 0) c.lerp(new THREE.Color(st.tint), st.tintAmt * 0.35);
    return c;
  }, [kind, st]);
  const rimCol = useMemo(() => kcol.clone().lerp(WHITE, 0.45), [kcol]);
  const ringCol = useMemo(() => kcol.clone().lerp(base, 0.35), [kcol, base]);
  const isDb = srv.kind === "database";
  const tagTxt = isDb ? collectionNoun(srv.name) : KIND_TAG[kind];
  // big nodes (database, model hub): orbits and bodies grow with the node, so they clear it
  const big = serverScale(srv);
  const orbSize = st.size * (big > 1 ? big * 0.72 : 1);
  const orb = useMemo(() => orbitOf(srv.name, res.name, backend.k, orbSize, isDb), [srv.name, res.name, backend.k, orbSize, isDb]);
  // the label sits on the side of the satellite facing away from the node (flips with hysteresis)
  const [side, setSide] = useState<1 | -1>(1);
  useEffect(() => {
    satSideMap.set(`${srv.name}|${res.name}`, side);
  }, [srv.name, res.name, side]);
  const m = useMemo(
    () => ({
      body: satMat(),
      ring: ringMat(),
      halo: spriteMat(),
      bolt: spriteMat(),
      glyph: new THREE.SpriteMaterial({ map: glyphTexture(kind), color: "#fff", transparent: true, depthWrite: false, toneMapped: false }),
      trail: new THREE.LineBasicMaterial({ color: "#000", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    }),
    [kind],
  );
  const trailGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    return g;
  }, []);
  const ring = useRef<THREE.Group>(null);
  const sat = useRef<THREE.Group>(null);
  const body = useRef<THREE.Mesh>(null);
  const glyph = useRef<THREE.Sprite>(null);
  const halo = useRef<THREE.Sprite>(null);
  const bolt = useRef<THREE.Sprite>(null);
  const trail = useRef<THREE.LineSegments>(null);
  const label = useRef<Label3DHandle>(null);
  const tag = useRef<THREE.Group>(null);
  const last = useRef("");
  const s = useMemo(() => ({ ang: orb.phase, spark: 0, wasBusy: false, flare: 0, calls: res.calls, seen: res.activeAt, boltAt: -1e9, boltIn: true, rate: 0, rateAt: 0, occ: 0 }), [orb]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = useMemo(() => {
    const v = new THREE.Vector3();
    satLive.set(key, v);
    return v;
  }, [key]);
  useEffect(() => () => void (satLive.get(key) === live && satLive.delete(key)), [key, live]);
  const R = 0.36 * (res.sub === "warehouse" || res.sub === "spark" ? 1.12 : 1) * st.size * (big > 1 ? 1.6 : 1);
  useEffect(() => {
    satRad.set(key, R);
    return () => void satRad.delete(key);
  }, [key, R]);
  useFrame(({ clock, camera }, dt) => {
    const now = performance.now();
    const busy = res.inflight > 0;
    const act = mcpGlow(res.activeAt, now, 1.4);
    const d = Math.min(dt, 0.05);
    const k = st.gain;
    // activity edges: a new call flares + bolt out; a result (activeAt moved, no new call) a softer flare + bolt back
    if (res.calls !== s.calls) {
      s.calls = res.calls;
      s.seen = res.activeAt;
      s.flare = 1;
      s.boltAt = now;
      s.boltIn = false;
    } else if (res.activeAt !== s.seen) {
      s.seen = res.activeAt;
      s.flare = Math.max(s.flare, 0.6);
      s.boltAt = now;
      s.boltIn = true;
    }
    s.flare = Math.max(0, s.flare - d * 1.6);
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
    const head = (((s.ang / (Math.PI * 2)) % 1) + 1) % 1;
    if (busy) s.spark = (s.spark + d * 1.4) % 1;
    else if (s.wasBusy) s.spark = 0;
    s.wasBusy = busy;
    const ru = m.ring.uniforms;
    ru.uColor.value.copy(ringCol).multiplyScalar(k);
    ru.uHead.value = head;
    ru.uDir.value = orb.dir;
    ru.uBase.value = busy ? 0.38 : 0.2 + act * 0.14;
    ru.uTrail.value = busy ? 1.6 : 0.85 + act * 0.6;
    ru.uSpark.value = head - orb.dir * (1 - s.spark) * 0.6;
    ru.uSparkAmt.value = busy ? Math.sin(s.spark * Math.PI) * k : 0;
    const flick = reduced ? 1 : 0.94 + 0.06 * Math.sin(clock.elapsedTime * 6 + backend.k * 3);
    // idle satellites stay clearly lit (0.7), recent ones brighter, busy / flaring ones blaze
    const lit = Math.max(busy ? 1 : 0.62 + act * 0.38, s.flare);
    const bu = m.body.uniforms;
    bu.uColor.value.copy(kcol);
    bu.uRim.value.copy(rimCol).multiplyScalar(0.6 + lit * 0.55);
    // stays saturated under heavy bloom (kind color must survive a flare): the flare reads as scale + halo + hot core
    bu.uGain.value = (0.72 + lit * 0.33 + s.flare * 0.35) * flick * k;
    bu.uHot.value = (busy ? 0.3 : act * 0.12) + s.flare * 0.55;
    const pulse = 1 + s.flare * 0.55 + (busy && !reduced ? 0.06 * Math.sin(clock.elapsedTime * 9) : 0);
    body.current?.scale.setScalar(R * pulse);
    m.halo.color.copy(kcol).multiplyScalar((0.14 + lit * 0.18 + (busy ? 0.16 : 0) + s.flare * 0.5) * flick * st.halo * k);
    halo.current?.scale.setScalar(R * (5 + s.flare * 4 + (busy ? 1.5 : 0)));
    // kind glyph: on the camera-facing side of the sphere, so the crystal still hides it
    const gl = glyph.current;
    if (gl) {
      _v.copy(camera.position).sub(_p).normalize().multiplyScalar(R * pulse * 1.02);
      gl.position.copy(_v);
      gl.scale.setScalar(R * pulse * 2.3);
      m.glyph.color.copy(WHITE).lerp(kcol, 0.15).multiplyScalar(0.9 + lit * 0.4 * k);
    }
    // the name label hangs beside the sphere on its outer side (screen space), away from the node
    _v.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const dx = _rq.copy(_p).sub(_q).dot(_v);
    if (dx * side < -R * 0.6) setSide(side > 0 ? -1 : 1);
    _v.multiplyScalar(R * pulse * 1.3 * side);
    tag.current?.position.copy(_v);
    // the bolt: crystal -> satellite on a call, satellite -> crystal on a result
    const bt = (now - s.boltAt) / BOLT_MS;
    const bv = bolt.current;
    const tr = trail.current;
    if (bv && tr) {
      const on = bt >= 0 && bt < 1 && !reduced;
      bv.visible = tr.visible = on;
      if (on) {
        const e = 1 - Math.pow(1 - bt, 2);
        const a = s.boltIn ? 1 - e : e;
        const b0 = s.boltIn ? Math.min(1, a + 0.35) : Math.max(0, a - 0.35);
        _v.copy(_q).lerp(_p, a);
        bv.position.copy(_v);
        bv.scale.setScalar(R * (2.4 + (1 - bt) * 1.6));
        m.bolt.color.copy(WHITE).lerp(kcol, 0.35).multiplyScalar(1.4 * (1 - bt * 0.6) * k);
        const tp = trailGeo.getAttribute("position") as THREE.BufferAttribute;
        tp.setXYZ(0, _v.x, _v.y, _v.z);
        _v.copy(_q).lerp(_p, b0);
        tp.setXYZ(1, _v.x, _v.y, _v.z);
        tp.needsUpdate = true;
        trailGeo.computeBoundingSphere();
        m.trail.color.copy(kcol).lerp(WHITE, 0.3).multiplyScalar(1.2 * (1 - bt) * k);
      }
    }
    if (busy && !reduced && st.emit && Math.random() < 0.5) {
      _v.set((Math.random() - 0.5) * 0.7, 1.6 + Math.random(), (Math.random() - 0.5) * 0.7);
      st.emit(_p, _v, Math.random() < 0.4 ? WHITE : kcol);
    }
    // label: `name` + `kind · 2.4/s` (recently used); busy: `name › tool()`
    if (now - s.rateAt > 500) (s.rateAt = now), (s.rate = recentRate(key, now));
    let txt = res.name;
    if (busy) {
      let tool = "";
      for (const p of world.mcpPending.values()) if (p.server === srv.name && p.resource === res.name) tool = p.tool;
      txt = `${res.name} › ${tool || "query"}()`;
    }
    const sub = s.rate > 0 ? `${tagTxt} · ${fmtRate(s.rate)}` : tagTxt;
    const lk = `${txt}\n${sub}`;
    // behind the crystal: dim the (on-top) label so it does not read as floating in front
    _v.copy(_p).sub(camera.position);
    _rq.copy(_q).sub(camera.position);
    const dS = _v.length(), dC = _rq.length();
    const sep = _v.multiplyScalar(dC / Math.max(1e-3, dS)).distanceTo(_rq);
    const occ = dS > dC && sep < GEM_R * st.size * big * 1.05 ? 1 : 0;
    s.occ += (occ - s.occ) * Math.min(1, d * 8);
    if (label.current) {
      if (lk !== last.current) {
        last.current = lk;
        label.current.setText(txt, s.rate > 0 ? [{ text: `${tagTxt} · `, color: "#94a3b8" }, { text: fmtRate(s.rate), color: rimCol }] : sub);
      }
      label.current.setOpacity((busy || s.flare > 0.3 ? 1 : 0.8 + act * 0.2) * (1 - s.occ * 0.75));
      label.current.setEmphasis(busy || s.flare > 0.3);
    }
  });
  return (
    <group>
      <group ref={ring}>
        <lineLoop geometry={RING_GEO} material={m.ring} />
      </group>
      <lineSegments ref={trail} geometry={trailGeo} material={m.trail} visible={false} renderOrder={3} />
      <sprite ref={bolt} material={m.bolt} visible={false} renderOrder={3} />
      <group ref={sat}>
        {st.halo > 0 && <sprite ref={halo} material={m.halo} renderOrder={-1} />}
        <mesh ref={body} geometry={SAT_GEO} material={m.body} scale={R} renderOrder={1} />
        <sprite ref={glyph} material={m.glyph} renderOrder={2} />
        <ResourcePick sel={{ type: "backend", server: srv.name, resource: res.name }} r={R * 1.5} color={srv.color} mix={() => backend.mix * mcp.mix} />
        <group ref={tag}>
          <Label3D ref={label} text={res.name} secondary={tagTxt} color={SAT_KIND_COLOR[kind]} size={0.22} anchorX={side > 0 ? "left" : "right"} anchorY="middle" textAlign={side > 0 ? "left" : "right"} opacity={0.85} pxRange={[9, 12.5]} />
        </group>
      </group>
    </group>
  );
}
