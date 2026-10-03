/**
 * MCP servers = octahedral nodes on an outer ring; each server's backends (db, warehouse, spark, api, storage, queue)
 * are their own nodes wired to the server. A pending call = tether agent → server (amber → red with waitSeconds);
 * the server → backend edge lights up and a pulse travels to the backend; the result pulses back to the agent.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { mcpGlow, mcpTitle, waitSeconds, world, type McpCall, type ShapeKind } from "../shared/world";
import { agentLive, serverPos, type BackendSlotProps, type McpServerSlotProps } from "../shared/kit";
import { ARROW_GEO, ArrowPool, SPHERE_GEO, TUBE_GEO, additiveBasic, placeOnCurve, reduced, bezier, bowControl, clamp01, easeInOut, easeOut, glowSpriteMaterial, tubeMaterial } from "./fx";

const AMBER = new THREE.Color("#fbbf24");
const RED = new THREE.Color("#ff2d3d");
const WHITE = new THREE.Color(1, 1, 1);

const OCTA = new THREE.OctahedronGeometry(0.8, 0);
const OCTA_EDGES = new THREE.EdgesGeometry(OCTA);

type Part = { geo: THREE.BufferGeometry; edges?: THREE.BufferGeometry; pos?: [number, number, number]; rot?: [number, number, number] };
function kindParts(kind: ShapeKind): Part[] {
  const withEdges = (geo: THREE.BufferGeometry, pos?: [number, number, number], rot?: [number, number, number]): Part => ({ geo, edges: new THREE.EdgesGeometry(geo, 25), pos, rot });
  switch (kind) {
    case "db":
      return [withEdges(new THREE.CylinderGeometry(0.42, 0.42, 0.7, 28)), withEdges(new THREE.TorusGeometry(0.42, 0.015, 6, 40), [0, 0.12, 0], [Math.PI / 2, 0, 0])];
    case "warehouse":
      return [-0.3, 0, 0.3].map((y) => withEdges(new THREE.BoxGeometry(0.95, 0.2, 0.6), [0, y, 0]));
    case "spark": {
      const parts: Part[] = [{ geo: new THREE.SphereGeometry(0.17, 16, 12) }];
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        parts.push({ geo: new THREE.SphereGeometry(0.1, 12, 10), pos: [Math.cos(a) * 0.45, Math.sin(a) * 0.45, (k % 2 ? 1 : -1) * 0.12] });
      }
      return parts;
    }
    case "api":
      return [withEdges(new THREE.TorusGeometry(0.4, 0.1, 10, 36))];
    case "storage":
      return [withEdges(new THREE.BoxGeometry(0.7, 0.7, 0.7), undefined, [0.4, 0.6, 0])];
    case "queue":
      return [withEdges(new THREE.CapsuleGeometry(0.2, 0.75, 6, 16), undefined, [0, 0, Math.PI / 2])];
  }
}

/** Backend slot: a backend node behind an MCP server, wired to it. */
export function Backend({ mcp, backend }: BackendSlotProps) {
  const srv = mcp.srv;
  const res = backend.res;
  const parts = useMemo(() => kindParts(res.kind), [res.kind]);
  const col = useMemo(() => new THREE.Color(srv.color).lerp(WHITE, 0.35), [srv.color]);
  const m = useMemo(
    () => ({ edge: tubeMaterial(srv.color, 0.035, 1), arrow: additiveBasic(col), fill: additiveBasic(col), line: new THREE.LineBasicMaterial({ color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), halo: glowSpriteMaterial(col) }),
    [srv.color, col],
  );
  const at = useRef<THREE.Group>(null);
  const g = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const arrow = useRef<THREE.Mesh>(null);
  const srvCol = useMemo(() => new THREE.Color(srv.color), [srv.color]);
  const label = useRef<Label3DHandle>(null);
  const lastText = useRef("");
  useFrame(({ clock }) => {
    // kit places server + backend (they ease when the periphery re-lays out)
    const eu = m.edge.uniforms;
    eu.uP0.value.copy(mcp.pos);
    eu.uP2.value.copy(backend.pos);
    eu.uP1.value.copy(mcp.pos).add(backend.pos).multiplyScalar(0.5);
    at.current?.position.copy(backend.pos);
    const now = performance.now();
    const busy = res.inflight > 0;
    const act = mcpGlow(res.activeAt, now, 1.5);
    // idle = dim; the backend being queried lights up hard and pulses
    const beat = busy ? 0.5 + 0.5 * Math.sin(clock.elapsedTime * 5) : 0;
    const k2 = busy ? 1.6 + beat * 0.9 : 0.12 + act * 0.9;
    m.fill.color.copy(col).multiplyScalar(k2 * 0.55);
    m.line.color.copy(col).multiplyScalar(k2 * 1.6);
    m.halo.color.copy(col).multiplyScalar(busy ? 0.45 + beat * 0.25 : 0.02 + act * 0.25);
    halo.current?.scale.setScalar(busy ? 4.2 + beat * 0.8 : 2.4 + act * 1.2);
    if (g.current) g.current.scale.setScalar(busy ? 1.2 + beat * 0.08 : 1 + act * 0.1);
    // label shows the live tool call while busy, "✓ returned" briefly after
    let txt = res.name;
    let call: McpCall | null = null;
    for (const c of world.mcpCalls) if (c.server === srv.name && c.resource === res.name && (!call || c.start > call.start)) call = c;
    if (busy) {
      let tool = "";
      for (const p of world.mcpPending.values()) if (p.server === srv.name && p.resource === res.name) tool = p.tool;
      txt = `${res.name} ▶ ${tool || "query"}()`;
    } else if (call && call.phase === "result" && now - call.start < 1800) txt = `${res.name} ✓ returned`;
    if (label.current) {
      if (txt !== lastText.current) {
        label.current.setText(txt);
        lastText.current = txt;
      }
      label.current.setOpacity(busy ? 1 : 0.55 + act * 0.45);
      label.current.setEmphasis(busy);
    }
    if (g.current) g.current.rotation.y = res.kind === "spark" || res.kind === "api" ? clock.elapsedTime * (busy ? 0.6 : 0.15) : Math.sin(clock.elapsedTime * 0.2) * 0.25;
    // data flow on the server → backend edge (curve runs server t=0 → backend t=1):
    //   request/waiting: thin dim dashes flowing OUT to the backend, arrow at the backend
    //   result: thicker, bright pulse flowing IN to the server, arrow at the server
    const u = m.edge.uniforms;
    u.uTime.value = reduced ? 0 : clock.elapsedTime;
    let latest: McpCall | null = null;
    for (const c of world.mcpCalls) if (c.server === srv.name && c.resource === res.name && (!latest || c.start > latest.start)) latest = c;
    const resultAge = latest && latest.phase === "result" ? (now - latest.start) / latest.dur : 9;
    const returning = resultAge < 1;
    const a = arrow.current;
    if (returning) {
      const t = easeInOut(resultAge);
      u.uRadius.value = 0.06;
      u.uOpacity.value = 0.9 * (1 - resultAge * 0.6);
      u.uFlow.value = 0;
      u.uHead.value = 1 - t;
      u.uTail.value = 0.2;
      u.uHeadColor.value.copy(col).multiplyScalar(3);
      if (a) {
        a.visible = true;
        placeOnCurve(a, u.uP0.value, u.uP1.value, u.uP2.value, 0.12, -1, 0.55);
        m.arrow.color.copy(col).multiplyScalar(2 * (1 - resultAge * 0.7));
      }
    } else if (busy) {
      u.uRadius.value = 0.03;
      u.uOpacity.value = 0.45;
      u.uFlow.value = 1;
      u.uHead.value = -1;
      if (a) {
        a.visible = true;
        placeOnCurve(a, u.uP0.value, u.uP1.value, u.uP2.value, 0.84, 1, 0.42);
        m.arrow.color.copy(srvCol).multiplyScalar(1.1);
      }
    } else {
      u.uRadius.value = 0.03;
      u.uOpacity.value = 0.15 + act * 0.4;
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
              {p.edges && <lineSegments geometry={p.edges} material={m.line} />}
            </group>
          ))}
        </group>
        <Label3D ref={label} position={[0, -0.95, 0]} text={res.name} color={srv.color} size={0.2} opacity={0.55} pxRange={[7.5, 11.5]} />
      </group>
    </>
  );
}

/** MCP server slot: an octahedral sense organ on the outskirts. */
export function Server({ mcp }: McpServerSlotProps) {
  const srv = mcp.srv;
  const col = useMemo(() => new THREE.Color(srv.color), [srv.color]);
  const m = useMemo(
    () => ({ fill: additiveBasic(col), line: new THREE.LineBasicMaterial({ color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), halo: glowSpriteMaterial(col), core: additiveBasic("#fff") }),
    [col],
  );
  const at = useRef<THREE.Group>(null);
  const g = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  useFrame(({ clock }) => {
    at.current?.position.copy(mcp.pos);
    const now = performance.now();
    const busy = srv.inflight > 0;
    const act = mcpGlow(srv.activeAt, now, 1.5);
    const k = (busy ? 0.75 : 0.3) + act * 0.45;
    m.fill.color.copy(col).multiplyScalar(k * 0.45);
    m.line.color.copy(col).multiplyScalar(k * 2.2);
    m.core.color.setScalar(busy ? 0.6 : 0.15);
    m.halo.color.copy(col).multiplyScalar(busy ? 0.28 : 0.08 + act * 0.15);
    halo.current?.scale.setScalar(4 + (busy ? 0.6 : 0));
    if (g.current) g.current.rotation.y = clock.elapsedTime * (busy ? 0.7 : 0.12);
  });
  return (
    <group ref={at}>
      <sprite ref={halo} material={m.halo} />
      <group ref={g}>
        <mesh geometry={OCTA} material={m.fill} />
        <lineSegments geometry={OCTA_EDGES} material={m.line} />
        <mesh geometry={SPHERE_GEO} material={m.core} scale={0.18} />
      </group>
      <Label3D position={[0, 1.35, 0]} text={mcpTitle(srv)} color={srv.color} size={0.28} pxRange={[9, 13]} />
    </group>
  );
}

/** Result pulse server → agent; call pulse agent → server. */
function Packet({ call }: { call: McpCall }) {
  const srv = world.mcpServers.get(call.server);
  const col = useMemo(() => new THREE.Color(srv?.color ?? "#fff"), [srv]);
  const mat = useMemo(() => glowSpriteMaterial(col.clone().multiplyScalar(1.8).addScalar(0.3)), [col]);
  const head = useRef<THREE.Sprite>(null);
  const s = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), h: new THREE.Vector3() }), []);
  useFrame(() => {
    const sp = agentLive(call.instance);
    const sv = serverPos(call.server);
    if (!head.current) return;
    if (!sp || !srv || !sv) {
      head.current.visible = false;
      return;
    }
    s.a.copy(sp);
    s.b.copy(sv);
    bowControl(s.a, s.b, 1.0, s.c);
    // result pulse runs a bit quicker (same timing as the tether's inward pulse)
    const t = clamp01((performance.now() - call.start) / (call.phase === "call" ? call.dur : call.dur * 0.75));
    const k = easeInOut(t);
    bezier(s.a, s.c, s.b, call.phase === "call" ? k : 1 - k, s.h);
    head.current.visible = t < 1;
    head.current.position.copy(s.h);
    head.current.scale.setScalar(1.0);
  });
  return <sprite ref={head} material={mat} visible={false} />;
}

// ------------------------------------------------------------------ tethers: pooled line segments for pending calls

const MAX_T = 24;
const SEG = 40;
const STRANDS = 3;

function Tethers() {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_T * STRANDS * SEG * 2 * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_T * STRANDS * SEG * 2 * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return g;
  }, []);
  const mat = useMemo(() => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), []);
  const arrows = useMemo(() => new ArrowPool(MAX_T), []);
  const tmp = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), p: new THREE.Vector3(), col: new THREE.Color(), k: new THREE.Color() }), []);

  useFrame(({ clock }) => {
    const now = performance.now();
    const time = reduced ? 0 : clock.elapsedTime;
    const P = geo.getAttribute("position") as THREE.BufferAttribute;
    const C = geo.getAttribute("color") as THREE.BufferAttribute;
    let n = 0;
    arrows.begin();
    // curve always runs agent (t=0) → server (t=1)
    const draw = (instance: string, server: string, mode: number, x: number) => {
      // mode 0 = request/waiting (x = wait seconds): thin dim dashes flowing OUT to the server, arrow at the server
      // mode 1 = result (x = age 0..1): thicker, bright pulse flowing IN to the agent, arrow at the agent
      if (n >= MAX_T) return;
      const sp = agentLive(instance);
      const srv = world.mcpServers.get(server);
      const sv = serverPos(server);
      if (!sp || !srv || !sv) return;
      const { a, b, c, p, col, k } = tmp;
      a.copy(sp);
      b.copy(sv);
      bowControl(a, b, 1.0, c);
      col.set(srv.color);
      let base: number;
      if (mode === 0) {
        col.lerp(AMBER, clamp01(x / 1.2));
        if (x > 1.2) col.lerp(RED, clamp01((x - 1.2) / 1.0));
        base = (0.22 + Math.min(0.6, x * 0.25)) * easeOut(x / 0.3);
      } else {
        k.copy(col).lerp(WHITE, 0.35);
        base = 1.3 * (x < 0.75 ? 1 : 1 - (x - 0.75) / 0.25);
      }
      const head = 1 - easeInOut(x / 0.75);
      const spread = mode === 0 ? 0.025 : 0.07;
      for (let s = 0; s < STRANDS; s++) {
        const off = (s - 1) * spread;
        for (let i = 0; i < SEG; i++) {
          for (let e = 0; e < 2; e++) {
            const t = (i + e) / SEG;
            bezier(a, c, b, t, p);
            const vi = ((n * STRANDS + s) * SEG + i) * 2 + e;
            P.setXYZ(vi, p.x + off, p.y - off, p.z + off * 0.5);
            let lum: number;
            if (mode === 0) {
              const dash = Math.pow(Math.max(0, Math.sin(t * 20 - time * 2.2)), 8); // phase moves toward t=1 (server)
              lum = base * (0.3 + dash * 1.5) * (s === 1 ? 1 : 0.25);
            } else {
              lum = base * (0.3 + Math.exp(-(((t - head) / 0.07) ** 2)) * 3.2 * (x < 0.8 ? 1 : 0)) * (s === 1 ? 1 : 0.65);
            }
            const cc = mode === 0 ? col : k;
            C.setXYZ(vi, cc.r * lum, cc.g * lum, cc.b * lum);
          }
        }
      }
      if (mode === 0) arrows.add(a, c, b, 0.92, 1, 0.48, col, 0.4 + base * 1.4);
      else arrows.add(a, c, b, 0.08, -1, 0.66, k, base * 1.6);
      n++;
    };
    for (const p of world.mcpPending.values()) draw(p.instance, p.server, 0, waitSeconds(p, now));
    for (const r of world.mcpCalls) if (r.phase === "result") draw(r.instance, r.server, 1, clamp01((now - r.start) / r.dur));
    geo.setDrawRange(0, n * STRANDS * SEG * 2);
    P.needsUpdate = true;
    C.needsUpdate = true;
    arrows.end();
  });
  return (
    <>
      <lineSegments geometry={geo} material={mat} frustumCulled={false} />
      <primitive object={arrows.mesh} />
    </>
  );
}

/** Theme extras: MCP call/result packets + pending-call tethers (servers/backends are kit slots). */
export function Senses() {
  const [calls, setCalls] = useState<McpCall[]>([]);
  const key = useRef({ n: -1, first: -1, last: -1 });
  useFrame(() => {
    const k = key.current;
    const c = world.mcpCalls;
    const first = c.length ? c[0].id : -1;
    const last = c.length ? c[c.length - 1].id : -1;
    if (c.length !== k.n || first !== k.first || last !== k.last) {
      k.n = c.length;
      k.first = first;
      k.last = last;
      setCalls(c.slice());
    }
  });
  return (
    <>
      {calls.map((c) => (
        <Packet key={c.id} call={c} />
      ))}
      <Tethers />
    </>
  );
}
