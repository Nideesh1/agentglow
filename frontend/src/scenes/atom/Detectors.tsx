/**
 * MCP servers are outer particle detectors: a barrel detector (tracker + calorimeter segments) aimed at the
 * nucleus. Their backends (Postgres, Snowflake, Spark, …) are sensor modules wired to the detector.
 *   call    → a particle beam electron → detector (dashed quanta flowing out, amber → red the longer it waits),
 *             the detector registers a hit, and the detector → sensor link streams toward the queried backend
 *   result  → a bright particle flies back detector → electron (arrow at the agent); sensor → detector flash
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { mcpGlow, mcpTitle, waitSeconds, world, type McpCall, type ShapeKind } from "../shared/world";
import { agentLive, serverPos, type BackendSlotProps, type McpServerSlotProps } from "../shared/kit";
import { AMBER, ARROW_GEO, ArrowPool, CurvePool, RED, TUBE_GEO, WHITE, additive, bezier, bow, clamp01, easeInOut, easeOut, glowSprite, lineMat, reduced, tubeMaterial } from "./fx";

const ORIGIN = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Barrel detector wireframe: tracker + calorimeter rings, radial segments, longitudinal staves (axis = +Z). */
function detectorGeometry() {
  const v: number[] = [];
  const seg = (a: number[], b: number[]) => v.push(...a, ...b);
  const N = 16;
  const ring = (r: number, z: number, n = 48) => {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      seg([Math.cos(a0) * r, Math.sin(a0) * r, z], [Math.cos(a1) * r, Math.sin(a1) * r, z]);
    }
  };
  for (const z of [-0.7, 0.7]) {
    ring(1.0, z);
    ring(0.62, z);
    ring(0.3, z * 1.15);
  }
  ring(1.0, 0);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    seg([c * 1.0, s * 1.0, -0.7], [c * 1.0, s * 1.0, 0.7]); // staves
    for (const z of [-0.7, 0.7]) seg([c * 0.62, s * 0.62, z], [c * 1.0, s * 1.0, z]); // calorimeter cells
    if (i % 2 === 0) seg([c * 0.3, s * 0.3, -0.8], [c * 0.3, s * 0.3, 0.8]); // tracker
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  return g;
}
const DET_GEO = detectorGeometry();
const DET_FILL = new THREE.CylinderGeometry(1.0, 1.0, 1.4, 32, 1, true).rotateX(Math.PI / 2);

type Part = { geo: THREE.BufferGeometry; edges: THREE.BufferGeometry; pos?: [number, number, number]; rot?: [number, number, number] };
const part = (geo: THREE.BufferGeometry, pos?: [number, number, number], rot?: [number, number, number]): Part => ({ geo, edges: new THREE.EdgesGeometry(geo, 25), pos, rot });
const KIND_PARTS: Record<ShapeKind, () => Part[]> = {
  db: () => [part(new THREE.CylinderGeometry(0.4, 0.4, 0.66, 24)), part(new THREE.TorusGeometry(0.4, 0.01, 4, 40), [0, 0.11, 0], [Math.PI / 2, 0, 0])],
  warehouse: () => [-0.28, 0, 0.28].map((y) => part(new THREE.BoxGeometry(0.9, 0.18, 0.55), [0, y, 0])),
  spark: () => [part(new THREE.IcosahedronGeometry(0.42, 0))],
  api: () => [part(new THREE.TorusGeometry(0.38, 0.09, 8, 6))],
  storage: () => [part(new THREE.BoxGeometry(0.66, 0.66, 0.66), undefined, [0.4, 0.6, 0])],
  queue: () => [part(new THREE.CapsuleGeometry(0.18, 0.7, 4, 12), undefined, [0, 0, Math.PI / 2])],
};

/** Backend slot: a sensor module wired to its detector (kit places both; they ease when the periphery re-lays out). */
export function Sensor({ mcp, backend }: BackendSlotProps) {
  const srv = mcp.srv;
  const res = backend.res;
  const at = useRef<THREE.Group>(null);
  const parts = useMemo(() => KIND_PARTS[res.kind]?.() ?? KIND_PARTS.api(), [res.kind]);
  const col = useMemo(() => new THREE.Color(srv.color).lerp(WHITE, 0.3), [srv.color]);
  const m = useMemo(() => {
    const edge = tubeMaterial(srv.color, 0.03);
    return { edge, fill: additive(col), line: lineMat(col), halo: glowSprite(col), arrow: additive(col) };
  }, [srv.color, col]);
  const g = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const arrow = useRef<THREE.Mesh>(null);
  const label = useRef<Label3DHandle>(null);
  const last = useRef("");
  useFrame(({ clock }) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    at.current?.position.copy(backend.pos);
    const eu = m.edge.uniforms;
    eu.uP0.value.copy(mcp.pos);
    eu.uP2.value.copy(backend.pos);
    eu.uP1.value.copy(mcp.pos).add(backend.pos).multiplyScalar(0.5);
    const busy = res.inflight > 0;
    const act = mcpGlow(res.activeAt, now, 1.5);
    const beat = busy && !reduced ? 0.5 + 0.5 * Math.sin(t * 5) : busy ? 0.5 : 0;
    const k2 = busy ? 1.5 + beat * 0.8 : 0.14 + act * 0.9;
    m.fill.color.copy(col).multiplyScalar(k2 * 0.22);
    m.line.color.copy(col).multiplyScalar(k2 * 1.3);
    m.halo.color.copy(col).multiplyScalar(busy ? 0.4 + beat * 0.2 : 0.02 + act * 0.22);
    halo.current?.scale.setScalar(busy ? 3.6 + beat * 0.6 : 2.2 + act);
    if (g.current) {
      g.current.scale.setScalar(busy ? 1.18 + beat * 0.06 : 1 + act * 0.08);
      g.current.rotation.y = reduced ? 0.4 : t * (busy ? 0.7 : 0.12);
    }
    let latest: McpCall | null = null;
    for (const c of world.mcpCalls) if (c.server === srv.name && c.resource === res.name && (!latest || c.start > latest.start)) latest = c;
    let txt = res.name;
    if (busy) {
      let tool = "";
      for (const p of world.mcpPending.values()) if (p.server === srv.name && p.resource === res.name) tool = p.tool;
      txt = `${res.name} ▸ ${tool || "query"}()`;
    } else if (latest && latest.phase === "result" && now - latest.start < 1800) txt = `${res.name} ✓ returned`;
    if (label.current) {
      if (txt !== last.current) label.current.setText(txt), (last.current = txt);
      label.current.setOpacity(busy ? 1 : 0.5 + act * 0.5);
    }
    // detector (t=0) → sensor (t=1) link
    const u = m.edge.uniforms;
    u.uTime.value = reduced ? 0 : t;
    const rAge = latest && latest.phase === "result" ? (now - latest.start) / latest.dur : 9;
    const a = arrow.current;
    if (rAge < 1) {
      u.uRadius.value = 0.055;
      u.uOpacity.value = 0.8 * (1 - rAge * 0.6);
      u.uFlow.value = 0;
      u.uHead.value = 1 - easeInOut(rAge);
      u.uHeadColor.value.copy(col).multiplyScalar(3);
      if (a) {
        a.visible = true;
        placeArrow(a, u.uP0.value, u.uP1.value, u.uP2.value, 0.14, -1, 0.5);
        m.arrow.color.copy(col).multiplyScalar(2 * (1 - rAge * 0.7));
      }
    } else if (busy) {
      u.uRadius.value = 0.03;
      u.uOpacity.value = 0.5;
      u.uFlow.value = 1;
      u.uHead.value = -1;
      if (a) {
        a.visible = true;
        placeArrow(a, u.uP0.value, u.uP1.value, u.uP2.value, 0.82, 1, 0.4);
        m.arrow.color.copy(col).multiplyScalar(1.2);
      }
    } else {
      u.uRadius.value = 0.025;
      u.uOpacity.value = 0.14 + act * 0.4;
      u.uFlow.value = 0;
      u.uHead.value = -1;
      if (a) a.visible = false;
    }
  });
  return (
    <>
      <mesh geometry={TUBE_GEO} material={m.edge} frustumCulled={false} />
      <mesh ref={arrow} geometry={ARROW_GEO} material={m.arrow} visible={false} />
      <group ref={at}>
        <sprite ref={halo} material={m.halo} />
        <group ref={g}>
          {parts.map((p, i) => (
            <group key={i} position={p.pos} rotation={p.rot}>
              <mesh geometry={p.geo} material={m.fill} />
              <lineSegments geometry={p.edges} material={m.line} />
            </group>
          ))}
        </group>
        <Label3D ref={label} position={[0, -0.9, 0]} text={res.name} font="mono" color={srv.color} size={0.2} opacity={0.5} pxRange={[7.5, 11]} />
      </group>
    </>
  );
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
function placeArrow(m: THREE.Object3D, p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, dir: 1 | -1, size: number) {
  bezier(p0, p1, p2, t, _a);
  bezier(p0, p1, p2, clamp01(t + 0.02 * dir), _b);
  m.position.copy(_a);
  _b.sub(_a);
  if (_b.lengthSq() > 1e-8) m.quaternion.setFromUnitVectors(UP, _b.normalize());
  m.scale.set(size * 0.38, size, size * 0.38);
}

/** MCP server slot: a barrel particle detector on the outskirts, aimed at the agents. */
export function Detector({ mcp }: McpServerSlotProps) {
  const srv = mcp.srv;
  const at = useRef<THREE.Group>(null);
  const col = useMemo(() => new THREE.Color(srv.color), [srv.color]);
  const m = useMemo(() => ({ line: lineMat(col), fill: additive(col), core: glowSprite("#fff"), halo: glowSprite(col), hit: glowSprite("#fff") }), [col]);
  const aim = useRef<THREE.Group>(null);
  const spin = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const hit = useRef<THREE.Sprite>(null);
  const lastCalls = useRef(srv.calls);
  const hitAt = useRef(-1e9);
  useFrame(({ clock }) => {
    at.current?.position.copy(mcp.pos);
    const now = performance.now();
    if (srv.calls !== lastCalls.current) (lastCalls.current = srv.calls), (hitAt.current = now);
    aim.current?.lookAt(ORIGIN); // beam axis points at the agents (stage centre)
    const busy = srv.inflight > 0;
    const act = mcpGlow(srv.activeAt, now, 1.4);
    const k = (busy ? 0.8 : 0.32) + act * 0.5;
    m.line.color.copy(col).multiplyScalar(k * 1.4);
    m.fill.color.copy(col).multiplyScalar(k * 0.05);
    m.core.color.setScalar(busy ? 0.7 : 0.18);
    m.halo.color.copy(col).multiplyScalar(busy ? 0.24 : 0.06 + act * 0.12);
    halo.current?.scale.setScalar(5 + (busy ? 0.8 : 0));
    if (spin.current) spin.current.rotation.z = reduced ? 0 : clock.elapsedTime * (busy ? 0.55 : 0.08);
    // a hit: bright flash expanding at the interaction point when a call arrives
    const ha = (now - hitAt.current) / 700;
    if (hit.current) {
      hit.current.visible = ha < 1;
      hit.current.scale.setScalar(1 + ha * 4);
      m.hit.color.copy(col).lerp(WHITE, 0.5).multiplyScalar((1 - ha) * (1 - ha) * 1.2);
    }
  });
  return (
    <>
      <group ref={at}>
        <sprite ref={halo} material={m.halo} />
        <group ref={aim}>
          <group ref={spin}>
            <lineSegments geometry={DET_GEO} material={m.line} />
            <mesh geometry={DET_FILL} material={m.fill} />
          </group>
        </group>
        <sprite material={m.core} scale={0.9} />
        <sprite ref={hit} material={m.hit} visible={false} />
        <Label3D position={[0, 1.65, 0]} text={mcpTitle(srv)} color={srv.color} size={0.28} pxRange={[9, 13]} />
      </group>
    </>
  );
}

// ------------------------------------------------------------------ particle beams electron ↔ detector
const MAX_B = 28;
const SEG = 40;
const MAX_PK = 24;

/** Theme extra: particle beams electron <-> detector + outgoing call particles. */
export function Beams() {
  const pool = useMemo(() => new CurvePool(MAX_B * 2, SEG), []);
  const mat = useMemo(() => lineMat("#fff", true), []);
  const arrows = useMemo(() => new ArrowPool(MAX_B), []);
  const pkMats = useMemo(() => Array.from({ length: MAX_PK }, () => glowSprite("#fff")), []);
  const pk = useRef<(THREE.Sprite | null)[]>([]);
  const tmp = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), p: new THREE.Vector3(), col: new THREE.Color(), k: new THREE.Color() }), []);
  useFrame(({ clock }) => {
    const now = performance.now();
    const time = reduced ? 0 : clock.elapsedTime;
    pool.begin();
    arrows.begin();
    const { a, b, c, p, col, k } = tmp;
    // curve: electron (t=0) → detector (t=1)
    const draw = (instance: string, server: string, mode: 0 | 1, x: number) => {
      const sp = agentLive(instance);
      const srv = world.mcpServers.get(server);
      const sv = serverPos(server);
      if (!sp || !srv || !sv) return;
      a.copy(sp);
      b.copy(sv);
      bow(a, b, 1.2, c);
      col.set(srv.color);
      let base: number;
      if (mode === 0) {
        col.lerp(AMBER, clamp01(x / 1.2));
        if (x > 1.2) col.lerp(RED, clamp01((x - 1.2) / 1.0));
        base = (0.25 + Math.min(0.6, x * 0.25)) * easeOut(x / 0.3);
      } else {
        col.lerp(WHITE, 0.35);
        base = 1.2 * (x < 0.75 ? 1 : 1 - (x - 0.75) / 0.25);
      }
      const head = 1 - easeInOut(x / 0.75);
      for (let strand = 0; strand < 2; strand++) {
        const v0 = pool.next();
        if (v0 < 0) return;
        const off = strand ? 0.045 : 0;
        for (let i = 0; i < SEG; i++)
          for (let e = 0; e < 2; e++) {
            const t = (i + e) / SEG;
            bezier(a, c, b, t, p);
            pool.P.setXYZ(v0 + i * 2 + e, p.x + off, p.y + off, p.z);
            let lum: number;
            if (mode === 0) lum = base * (0.22 + Math.pow(Math.max(0, Math.sin(t * 26 - time * 3.0)), 10) * 1.8) * (strand ? 0.3 : 1);
            else lum = base * (0.18 + Math.exp(-(((t - head) / 0.05) ** 2)) * 3.4 * (x < 0.8 ? 1 : 0)) * (strand ? 0.5 : 1);
            pool.C.setXYZ(v0 + i * 2 + e, col.r * lum, col.g * lum, col.b * lum);
          }
      }
      k.copy(col);
      if (mode === 0) arrows.add(a, c, b, 0.93, 1, 0.45, k, 0.5 + base * 1.3);
      else arrows.add(a, c, b, 0.07, -1, 0.6, k, base * 1.5);
    };
    for (const pd of world.mcpPending.values()) draw(pd.instance, pd.server, 0, waitSeconds(pd, now));
    for (const r of world.mcpCalls) if (r.phase === "result") draw(r.instance, r.server, 1, clamp01((now - r.start) / r.dur));
    pool.end();
    arrows.end();
    // outgoing call particles: electron → detector
    let n = 0;
    for (const call of world.mcpCalls) {
      if (call.phase !== "call" || n >= MAX_PK) continue;
      const sp = agentLive(call.instance);
      const srv = world.mcpServers.get(call.server);
      const sv = serverPos(call.server);
      const s = pk.current[n];
      const t = clamp01((now - call.start) / call.dur);
      if (!sp || !srv || !sv || !s || t >= 1) continue;
      a.copy(sp);
      b.copy(sv);
      bow(a, b, 1.2, c);
      bezier(a, c, b, easeInOut(t), p);
      s.visible = true;
      s.position.copy(p);
      s.scale.setScalar(0.85);
      pkMats[n].color.set(srv.color).lerp(WHITE, 0.4).multiplyScalar(1.5);
      n++;
    }
    for (let z = n; z < MAX_PK; z++) if (pk.current[z]) pk.current[z]!.visible = false;
  });
  return (
    <>
      <lineSegments geometry={pool.geo} material={mat} frustumCulled={false} />
      <primitive object={arrows.mesh} />
      {pkMats.map((m, j) => (
        <sprite key={j} ref={(x) => void (pk.current[j] = x)} material={m} visible={false} />
      ))}
    </>
  );
}

