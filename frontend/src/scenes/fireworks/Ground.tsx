/**
 * Set pieces (scene-kit McpServer / Backend slots, placed by the kit at the sides of the show):
 *   MCP server -> a faceted crystal hanging free in the sky: an icosahedron with a fresnel rim, glinting facet edges
 *                 and a hot core turning the other way inside it. It turns slowly and glows in the server color;
 *                 while a call is in flight it spins up and throws sparks off its vertices like a Catherine wheel.
 *   backend    -> a satellite: a small lit sphere riding its own tilted orbital ring round the crystal (each ring
 *                 a different radius / inclination, so the system reads as 3D and parallaxes as the camera orbits),
 *                 with a comet tail along the ring behind it. Its name (and the kit's stat line) stays at the kit's
 *                 slot beside the crystal, tethered to the satellite by a faint line. A call aimed at it flares the
 *                 satellite, races a spark round its ring and plays a little fountain of sparks with the tool name.
 * Trails: a pending MCP call is a light trail from the agent's shell to the crystal (server color -> amber -> red
 * the longer it waits, with a comet head shedding sparks), then on to the satellite; the result is a bright comet
 * flying back.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { hash01, mcpGlow, mcpTitle, waitSeconds, world, type McpCall } from "../shared/world";
import { agentLive, backendPos, serverPos, type BackendSlotProps, type McpServerSlotProps } from "../shared/kit";
import { AMBER, BUDGET, CurvePool, GOLD, HeadPool, KIND_GLITTER, KIND_SPARK, RED, WHITE, bezier, bow, clamp01, easeInOut, easeOut, glowTexture, pyro, reduced, spriteMat } from "./fx";

const GEM_R = 0.8;
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

// ------------------------------------------------------------------ shared materials / geometry

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

/** Orbit ring as a loop with a per-vertex parameter t (0..1): faint base line + comet tail behind the satellite +
 *  a travelling spark. */
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
    uniforms: {
      uColor: { value: new THREE.Color() },
      uHead: { value: 0 },
      uDir: { value: 1 },
      uBase: { value: 0.1 },
      uTrail: { value: 0.6 },
      uSpark: { value: 0 },
      uSparkAmt: { value: 0 },
    },
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

/** Live satellite positions ("server|resource"), so the MCP trails end on the moving satellite. */
const satLive = new Map<string, THREE.Vector3>();

// ------------------------------------------------------------------ MCP server: the crystal

/** McpServer slot: a faceted crystal with a hot core, hanging free in the sky. */
export function Wheel({ mcp }: McpServerSlotProps) {
  const srv = mcp.srv;
  const col = useMemo(() => new THREE.Color(srv.color), [srv.color]);
  const seed = useMemo(() => hash01(srv.name, 7), [srv.name]);
  const spinDir = seed < 0.5 ? 1 : -1;
  const m = useMemo(
    () => ({
      gem: gemMat(0.62),
      edges: new THREE.LineBasicMaterial({ color: "#000", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      core: new THREE.MeshBasicMaterial({ color: "#000", toneMapped: false }),
      halo: spriteMat(glowTexture(), "#000"),
      hub: spriteMat(glowTexture(), "#000"),
    }),
    [],
  );
  const g = useRef<THREE.Group>(null);
  const spin = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const s = useMemo(() => ({ rot: seed * 6, w: 0.25 }), [seed]);
  useFrame(({ clock }, dt) => {
    const now = performance.now();
    g.current?.position.copy(mcp.pos);
    const busy = srv.inflight > 0;
    const act = mcpGlow(srv.activeAt, now, 1.4);
    // spin: eases up to a whirl while busy
    s.w += ((busy ? 3.2 : 0.22 + act * 1.2) - s.w) * Math.min(1, dt * 2.5);
    if (!reduced) s.rot += s.w * spinDir * Math.min(dt, 0.05);
    const tt = reduced ? 0 : clock.elapsedTime;
    if (spin.current) spin.current.rotation.set(0.42 + Math.sin(tt * 0.21 + seed * 9) * 0.25, s.rot, 0.18, "XYZ");
    if (core.current) core.current.rotation.set(tt * 0.7, -s.rot * 1.7, tt * 0.4);
    const pulse = reduced ? 1 : 0.9 + 0.1 * Math.sin(tt * 2.3 + seed * 5);
    const u = m.gem.uniforms;
    u.uColor.value.copy(col);
    u.uRim.value = (busy ? 2.4 : 1.15 + act * 0.9) * pulse;
    u.uGain.value = busy ? 1.25 : 0.85 + act * 0.3;
    u.uCore.value = busy ? 0.4 : 0.1 + act * 0.2;
    m.edges.color.copy(col).lerp(WHITE, busy ? 0.45 : 0.2).multiplyScalar(busy ? 1.6 : 0.7 + act * 0.6);
    m.core.color.copy(WHITE).lerp(col, 0.3).multiplyScalar((busy ? 2.2 : 1.1 + act * 0.7) * pulse);
    m.halo.color.copy(col).multiplyScalar(busy ? 0.34 : 0.08 + act * 0.18);
    m.hub.color.copy(WHITE).lerp(col, 0.45).multiplyScalar(busy ? 0.9 : 0.32 + act * 0.35);
    // sparks thrown off the vertices, tangentially to the spin (a Catherine wheel in 3D)
    if (busy && !reduced && spin.current) {
      const pz = pyro();
      spin.current.updateMatrixWorld();
      for (let i = 0; i < GEM_VERTS.length; i++) {
        if (Math.random() > 0.3 * BUDGET) continue;
        _p.copy(GEM_VERTS[i]).applyMatrix4(spin.current.matrixWorld);
        _q.copy(_p).sub(mcp.pos);
        // tangent of a spin about the local y axis, flung outward a little
        const sp = 1.8 + Math.random() * 1.4;
        const tx = -_q.z * spinDir;
        const tz = _q.x * spinDir;
        pz.emit(_p.x, _p.y, _p.z, (tx + _q.x * 0.6) * sp, _q.y * sp * 0.8, (tz + _q.z * 0.6) * sp, 2.4, 2.2, 0.4 + Math.random() * 0.35, 0.06, Math.random() < 0.4 ? WHITE : i % 2 ? GOLD : col, 1, Math.random() < 0.3 ? KIND_GLITTER : KIND_SPARK);
      }
    }
  });
  return (
    <group ref={g}>
      <sprite material={m.halo} scale={GEM_R * 6.5} renderOrder={-1} />
      <sprite material={m.hub} scale={GEM_R * 1.6} renderOrder={-1} />
      <group ref={spin}>
        <mesh ref={core} geometry={CORE_GEO} material={m.core} renderOrder={0} />
        <mesh geometry={GEM_GEO} material={m.gem} renderOrder={1} />
        <lineSegments geometry={GEM_EDGES} material={m.edges} scale={1.004} renderOrder={2} />
      </group>
      <Label3D position={[0, GEM_R + 1.15, 0]} text={mcpTitle(srv)} color={srv.color} size={0.28} pxRange={[9, 13]} />
    </group>
  );
}

// ------------------------------------------------------------------ backend: a satellite on a tilted ring

const _rx = new THREE.Quaternion();
const _ryz = new THREE.Quaternion();
const _eu = new THREE.Euler();
/** Orbit of backend k of n round its server: radius, inclination, node line, phase, angular speed. */
function orbitOf(server: string, res: string, k: number) {
  const h = hash01(`${server}|${res}`, 13);
  const h2 = hash01(`${server}|${res}`, 29);
  const r = Math.min(2.6, 1.4 + k * 0.38 + h * 0.08);
  // the base ring lies in the xz plane (edge-on to the default camera); tilt it 20..58 degrees about x so it opens
  // into an ellipse, yaw it a little and roll it round the view axis so the rings of one server fan out
  const incl = (0.35 + h * 0.66) * (k % 2 ? -1 : 1);
  _rx.setFromEuler(_eu.set(incl, 0, 0));
  _ryz.setFromEuler(_eu.set(0, h2 * 0.9 - 0.45, k * 1.05 + h2 * 0.6, "ZYX"));
  const quat = _ryz.clone().multiply(_rx);
  const dir = h2 < 0.5 ? 1 : -1;
  const w = (0.55 / Math.pow(r, 1.5)) * dir;
  return { r, quat, phase: h * Math.PI * 2, w, dir };
}

/** Backend slot: a lit satellite riding its tilted orbital ring round the crystal; its name stays at the kit slot. */
export function Lantern({ mcp, backend }: BackendSlotProps) {
  const srv = mcp.srv;
  const res = backend.res;
  const key = `${srv.name}|${res.name}`;
  const warm = useMemo(() => new THREE.Color(srv.color).lerp(GOLD, 0.45), [srv.color]);
  const ringCol = useMemo(() => new THREE.Color(srv.color).lerp(WHITE, 0.08), [srv.color]);
  const orb = useMemo(() => orbitOf(srv.name, res.name, backend.k), [srv.name, res.name, backend.k]);
  const m = useMemo(
    () => ({
      body: gemMat(0.95),
      ring: ringMat(),
      halo: spriteMat(glowTexture(), "#000"),
      dot: spriteMat(glowTexture(), "#000"),
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
  const st = useMemo(() => ({ ang: orb.phase, spark: 0, wasBusy: false }), [orb]);
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
    if (!reduced) st.ang += orb.w * (busy ? 2.2 : 1 + act) * d;
    // ring centred on the crystal
    const rg = ring.current;
    if (rg) {
      rg.position.copy(mcp.pos);
      rg.quaternion.copy(orb.quat);
      rg.scale.setScalar(orb.r);
    }
    _p.set(Math.cos(st.ang), 0, Math.sin(st.ang)).multiplyScalar(orb.r).applyQuaternion(orb.quat).add(mcp.pos);
    live.copy(_p);
    sat.current?.position.copy(_p);
    anchor.current?.position.copy(backend.pos);
    const head = (((st.ang / (Math.PI * 2)) % 1) + 1) % 1;
    // a spark races round the ring onto the satellite while a call is on it (and once more as it lands)
    if (busy) st.spark = (st.spark + d * 1.4) % 1;
    else if (st.wasBusy) st.spark = 0;
    st.wasBusy = busy;
    const ru = m.ring.uniforms;
    ru.uColor.value.copy(ringCol);
    ru.uHead.value = head;
    ru.uDir.value = orb.dir;
    ru.uBase.value = busy ? 0.3 : 0.13 + act * 0.12;
    ru.uTrail.value = busy ? 1.6 : 0.8 + act * 0.6;
    ru.uSpark.value = head - orb.dir * (1 - st.spark) * 0.6;
    ru.uSparkAmt.value = busy ? Math.sin(st.spark * Math.PI) : 0;
    const flick = reduced ? 1 : 0.92 + 0.08 * Math.sin(clock.elapsedTime * 6 + backend.k * 3);
    const lit = busy ? 1 : 0.3 + act * 0.6;
    const bu = m.body.uniforms;
    bu.uColor.value.copy(warm);
    bu.uRim.value = (0.8 + lit * 1.4) * flick;
    bu.uGain.value = 0.75 + lit * 0.6;
    bu.uCore.value = busy ? 0.9 : 0.05 + act * 0.4;
    m.halo.color.copy(warm).multiplyScalar((busy ? 0.55 : 0.07 + act * 0.25) * flick);
    halo.current?.scale.setScalar(busy ? 1.5 : 0.75 + act * 0.4);
    m.dot.color.copy(ringCol).multiplyScalar(busy ? 0.6 : 0.28 + act * 0.2);
    m.tether.color.copy(ringCol).multiplyScalar(busy ? 0.4 : 0.1 + act * 0.12);
    const tp = tetherGeo.getAttribute("position") as THREE.BufferAttribute;
    tp.setXYZ(0, backend.pos.x, backend.pos.y, backend.pos.z);
    tp.setXYZ(1, _p.x, _p.y, _p.z);
    tp.needsUpdate = true;
    tetherGeo.computeBoundingSphere();
    if (busy && !reduced && Math.random() < 0.5 * BUDGET) {
      pyro().emit(_p.x + (Math.random() - 0.5) * 0.06, _p.y + 0.12, _p.z, (Math.random() - 0.5) * 0.7, 1.6 + Math.random() * 1.0, (Math.random() - 0.5) * 0.7, 1.8, 3.2, 0.5 + Math.random() * 0.3, 0.05, Math.random() < 0.4 ? WHITE : warm, 1, KIND_SPARK);
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
  const sz = res.kind === "warehouse" || res.kind === "spark" ? 1.2 : 1;
  return (
    <group>
      <group ref={ring}>
        <lineLoop geometry={RING_GEO} material={m.ring} />
      </group>
      <lineSegments geometry={tetherGeo} material={m.tether} />
      <group ref={sat}>
        <sprite ref={halo} material={m.halo} />
        <mesh geometry={SAT_GEO} material={m.body} scale={0.17 * sz} />
      </group>
      <group ref={anchor}>
        <sprite material={m.dot} scale={0.32} />
        <Label3D position={[0, -0.35, 0]} text={res.name} color={srv.color} size={0.2} opacity={0.55} pxRange={[7.5, 11.5]} />
      </group>
    </group>
  );
}

// ------------------------------------------------------------------ MCP light trails (pooled)
const MAX_T = 48;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _h = new THREE.Vector3();
const _col = new THREE.Color();

/** Pending MCP calls: a light trail shell -> crystal (-> satellite); results fly back as a comet. KitScene child. */
export function Trails() {
  const { size, gl, camera } = useThree();
  const pool = useMemo(() => new CurvePool(MAX_T, 32), []);
  const heads = useMemo(() => new HeadPool(MAX_T), []);
  useFrame(({ clock }) => {
    const now = performance.now();
    const time = reduced ? 0 : clock.elapsedTime;
    heads.setScale(size.height, gl.getPixelRatio(), (camera as THREE.PerspectiveCamera).fov);
    pool.begin();
    heads.begin();
    const P = pyro();
    for (const p of world.mcpPending.values()) {
      const sp = agentLive(p.instance);
      const sv = serverPos(p.server);
      const srv = world.mcpServers.get(p.server);
      if (!sp || !srv || !sv) continue;
      _a.copy(sp);
      _b.copy(sv);
      bow(_a, _b, 0.8, 1.2, _c);
      const w = waitSeconds(p, now);
      _col.set(srv.color).lerp(AMBER, clamp01(w / 1.2));
      if (w > 1.2) _col.lerp(RED, clamp01((w - 1.2) / 1.0));
      const base = (0.16 + Math.min(0.3, w * 0.12)) * easeOut(w / 0.3);
      const t1 = 0.05 + 0.9 * easeOut(w / 0.5);
      pool.add(_a, _c, _b, _col, base, 0.05, t1, 0.7, time, w < 0.5 ? t1 : -1, 1.2);
      if (w < 0.5) {
        bezier(_a, _c, _b, t1, _h);
        heads.add(_h, 0.5, WHITE, 1.4);
        if (!reduced) P.emit(_h.x, _h.y, _h.z, (Math.random() - 0.5) * 0.4, -0.4, 0, 2.5, 1.4, 0.45, 0.06, _col, 1, KIND_GLITTER);
      }
      if (p.resource) {
        const mp = satLive.get(`${p.server}|${p.resource}`) ?? backendPos(p.server, p.resource);
        if (mp) {
          bow(_b, mp, 0.25, 0.2, _c);
          pool.add(_b, _c, mp, _col, base * 0.9, 0.15, 0.85, 0.7, time, -1, 0);
        }
      }
    }
    for (const r of world.mcpCalls as McpCall[]) {
      if (r.phase !== "result") continue;
      const u = clamp01((now - r.start) / r.dur);
      if (u >= 1) continue;
      const sp = agentLive(r.instance);
      const sv = serverPos(r.server);
      const srv = world.mcpServers.get(r.server);
      if (!sp || !srv || !sv) continue;
      _b.copy(sv);
      _col.set(srv.color).lerp(WHITE, 0.45);
      _a.copy(sp);
      bow(_a, _b, 0.8, 1.2, _c);
      const k = easeInOut(u);
      const fade = 1 - Math.max(0, (k - 0.85) / 0.15);
      pool.add(_a, _c, _b, _col, 0, Math.max(0.03, 1 - k - 0.02), Math.min(0.97, 1 - k + 0.2), 0, time, 1 - k, 1.5 * fade);
      bezier(_a, _c, _b, 1 - k, _h);
      heads.add(_h, 0.65, _col, 1.6 * fade);
      if (!reduced && Math.random() < 0.8) P.emit(_h.x, _h.y, _h.z, (Math.random() - 0.5) * 0.4, -0.3, 0, 2.5, 1.2, 0.5, 0.06, _col, 1, KIND_SPARK);
    }
    pool.end();
    heads.end();
  });
  return (
    <>
      <primitive object={pool.obj} />
      <primitive object={heads.obj} />
    </>
  );
}
