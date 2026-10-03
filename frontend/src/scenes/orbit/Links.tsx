/**
 * Everything that connects things: one pooled LineSegments for graph beams, spawn tethers (fan-out spokes)
 * and MCP tethers (scrolling dashes); message comets and MCP laser packets with trails; MCP satellites.
 */
import { Trail } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { mcpGlow, mcpTitle, TYPE_COLOR, waitSeconds, world, type Comet, type McpCall, cometOn, cometPos } from "../shared/world";
import { agentLive, serverPos, type BackendSlotProps, type McpServerSlotProps } from "../shared/kit";
import { isScout, nodeWorld, reduced } from "./layout";
import { isExpanded, lod } from "../shared/lod";

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _c = new THREE.Color();
const _d = new THREE.Color();
const AMBER = new THREE.Color("#f59e0b");
const RED = new THREE.Color("#ef4444");

// ------------------------------------------------------------------ pooled line segments
const MAX_SEG = 900;
const DASHES = 22;

export function Beams() {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_SEG * 6), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_SEG * 6), 3));
    return g;
  }, []);
  useFrame(({ clock }) => {
    const p = geo.getAttribute("position") as THREE.BufferAttribute;
    const col = geo.getAttribute("color") as THREE.BufferAttribute;
    const now = performance.now();
    const t = clock.elapsedTime;
    let k = 0;
    const seg = (a: THREE.Vector3, b: THREE.Vector3, ca: THREE.Color, cb: THREE.Color) => {
      if (k >= MAX_SEG) return;
      p.setXYZ(k * 2, a.x, a.y, a.z);
      p.setXYZ(k * 2 + 1, b.x, b.y, b.z);
      col.setXYZ(k * 2, ca.r, ca.g, ca.b);
      col.setXYZ(k * 2 + 1, cb.r, cb.g, cb.b);
      k++;
    };
    // 1) FalkorDB beams: instance → node (read = agent color, write = white-hot)
    for (const f of world.flares) {
      const age = (now - f.start) / 1900;
      if (age >= 1 || !isExpanded(f.instance)) continue;
      const from = agentLive(f.instance);
      if (!from || !nodeWorld(f.node, _w)) continue;
      const inst = world.instances.get(f.instance);
      const fade = 1 - age;
      if (f.op === "write") {
        _c.setRGB(3, 3, 3.4).multiplyScalar(fade);
        _d.setRGB(5, 5, 5).multiplyScalar(fade);
      } else {
        _c.set(inst ? TYPE_COLOR[inst.type] : "#c7d2fe").multiplyScalar(1.6 * fade);
        _d.copy(_c).multiplyScalar(1.6);
      }
      seg(from, _w, _c, _d);
    }
    // 2) spawn tethers: parent → child during birth; scouts keep a faint spoke to their researcher (fan-out)
    for (const i of world.instances.values()) {
      if (!i.parent || !isExpanded(i)) continue;
      const parent = world.instances.get(i.parent);
      if (!parent) continue;
      const age = (now - i.bornAt) / 1000;
      const birth = age < 1.4 ? 1 - age / 1.4 : 0;
      const spoke = isScout(i.type) && !i.exitAt ? 0.35 : 0;
      const s = Math.max(birth * 3, spoke);
      if (s <= 0.01) continue;
      const a = agentLive(i.parent);
      const b = agentLive(i.id);
      if (!a || !b) continue;
      _c.set(TYPE_COLOR[parent.type]).multiplyScalar(s);
      _d.set(TYPE_COLOR[i.type]).multiplyScalar(s * 1.4);
      seg(a, b, _c, _d);
    }
    // 3) MCP tethers: dashes scrolling toward the server while pending; color server → amber → red with wait
    for (const pd of world.mcpPending.values()) {
      if (!isExpanded(pd.instance)) continue;
      const a = agentLive(pd.instance);
      const srv = world.mcpServers.get(pd.server);
      const sv = serverPos(pd.server);
      if (!a || !srv || !sv) continue;
      _w.copy(sv);
      _w.y += satAlt(srv.slot);
      const ws = waitSeconds(pd, now);
      const heat = Math.min(1, ws / 2.2);
      const base = _d.set(srv.color);
      if (heat < 0.5) base.lerp(AMBER, heat * 2);
      else base.copy(AMBER).lerp(RED, (heat - 0.5) * 2);
      const intensity = 0.8 + Math.min(2.5, ws * 0.9);
      const phase = t * (reduced ? 0.3 : 1.4);
      for (let s = 0; s < DASHES; s++) {
        const u0 = s / DASHES;
        const u1 = (s + 0.55) / DASHES;
        const m = (((u0 - phase) % 1) + 1) % 1; // scrolling toward server
        const bright = 0.25 + Math.pow(1 - m, 6) * 2.2 + (((u0 * 3 - phase * 3) % 1) + 1) % 1 * 0.15;
        _c.copy(base).multiplyScalar(bright * intensity);
        _v.copy(a).lerp(_w, u0);
        const ux = _v.x, uy = _v.y, uz = _v.z;
        _v.copy(a).lerp(_w, u1);
        if (k >= MAX_SEG) break;
        p.setXYZ(k * 2, ux, uy, uz);
        p.setXYZ(k * 2 + 1, _v.x, _v.y, _v.z);
        col.setXYZ(k * 2, _c.r, _c.g, _c.b);
        col.setXYZ(k * 2 + 1, _c.r, _c.g, _c.b);
        k++;
      }
    }
    // 4) resolved: bright flash runs BACK along the tether to the agent, then it dissolves
    for (const r of world.mcpResolved) {
      const age = (now - r.resolvedAt) / 700;
      if (age >= 1 || !isExpanded(r.instance)) continue;
      const a = agentLive(r.instance);
      const srv = world.mcpServers.get(r.server);
      const sv = serverPos(r.server);
      if (!a || !srv || !sv) continue;
      _w.copy(sv);
      _w.y += satAlt(srv.slot);
      const head = 1 - age; // 1 = at server, 0 = at agent
      for (let s = 0; s < DASHES; s++) {
        const u0 = s / DASHES;
        const u1 = (s + 1) / DASHES;
        const dist = Math.abs(u0 - head);
        const bright = (1 - age) * (0.15 + Math.exp(-dist * 18) * 5);
        _c.set(srv.color).lerp(_d.setRGB(1, 1, 1), 0.6).multiplyScalar(bright);
        _v.copy(a).lerp(_w, u0);
        const ux = _v.x, uy = _v.y, uz = _v.z;
        _v.copy(a).lerp(_w, u1);
        if (k >= MAX_SEG) break;
        p.setXYZ(k * 2, ux, uy, uz);
        p.setXYZ(k * 2 + 1, _v.x, _v.y, _v.z);
        col.setXYZ(k * 2, _c.r, _c.g, _c.b);
        col.setXYZ(k * 2 + 1, _c.r, _c.g, _c.b);
        k++;
      }
    }
    geo.setDrawRange(0, k * 2);
    p.needsUpdate = true;
    col.needsUpdate = true;
  });
  return (
    <lineSegments geometry={geo} frustumCulled={false}>
      <lineBasicMaterial vertexColors transparent opacity={0.95} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
}

// ------------------------------------------------------------------ message comets between instances
function arcPoint(from: THREE.Vector3, to: THREE.Vector3, t: number, lift: number, out: THREE.Vector3) {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2 + lift;
  const mz = (from.z + to.z) / 2;
  const a = 1 - t;
  return out.set(a * a * from.x + 2 * a * t * mx + t * t * to.x, a * a * from.y + 2 * a * t * my + t * t * to.y, a * a * from.z + 2 * a * t * mz + t * t * to.z);
}

function CometMesh({ comet }: { comet: Comet }) {
  const ref = useRef<THREE.Mesh>(null);
  const from = world.instances.get(comet.from);
  const color = from ? TYPE_COLOR[from.type] : "#ffffff";
  const hot = useMemo(() => new THREE.Color(color).multiplyScalar(4), [color]);
  useFrame(() => {
    const now = performance.now();
    const t = cometPos(comet, now);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const a = agentLive(comet.from);
    const b = agentLive(comet.to);
    if (!ref.current || !a || !b) return;
    _w.copy(a);
    arcPoint(_w, b, e, 1.2 + a.distanceTo(b) * 0.15, ref.current.position);
    ref.current.scale.setScalar(cometOn(comet, now) ? 1 : 0.001);
  });
  return (
    <Trail width={2.2} length={7} color={color} attenuation={(w) => w * w} decay={1.2}>
      <mesh ref={ref} scale={0.001}>
        <sphereGeometry args={[0.13, 14, 14]} />
        <meshBasicMaterial color={hot} toneMapped={false} />
      </mesh>
    </Trail>
  );
}

export function Comets() {
  const [list, setList] = useState<Comet[]>([]);
  const key = useRef(-1);
  useFrame(() => {
    let k = world.comets.length * 7919 + lod.version * 104729;
    for (const c of world.comets) k += c.id;
    if (k !== key.current) {
      key.current = k;
      // collapsed agents aren't drawn: only fly comets between drawn orbs
      setList(lod.grouped ? world.comets.filter((c) => isExpanded(c.from) && isExpanded(c.to)) : world.comets.slice());
    }
  });
  return (
    <>
      {list.map((c) => (
        <CometMesh key={c.id} comet={c} />
      ))}
    </>
  );
}

// ------------------------------------------------------------------ MCP laser packets
const UP = new THREE.Vector3(0, 1, 0);
function Packet({ call }: { call: McpCall }) {
  const ref = useRef<THREE.Mesh>(null);
  const color = world.mcpServers.get(call.server)?.color ?? "#e5e7eb";
  const hot = useMemo(() => new THREE.Color(color).lerp(new THREE.Color("#ffffff"), 0.35).multiplyScalar(6), [color]);
  useFrame(() => {
    const now = performance.now();
    const t = Math.min(1, (now - call.start) / call.dur);
    const e = t * t * (3 - 2 * t);
    const a = agentLive(call.instance);
    const sv = serverPos(call.server);
    if (!ref.current || !a || !sv) return;
    _w.copy(sv);
    _w.y += satAlt(world.mcpServers.get(call.server)?.slot ?? 0);
    const from = call.phase === "call" ? a : _w;
    const to = call.phase === "call" ? _w : a;
    ref.current.position.copy(from).lerp(to, e);
    _v.copy(to).sub(from).normalize();
    ref.current.quaternion.setFromUnitVectors(UP, _v);
    ref.current.scale.set(t >= 1 ? 0.001 : 1, t >= 1 ? 0.001 : 1, t >= 1 ? 0.001 : 1);
  });
  return (
    <Trail width={1.4} length={10} color={color} attenuation={(w) => w * w * w} decay={1.5}>
      <mesh ref={ref} scale={0.001}>
        <capsuleGeometry args={[0.05, 0.7, 4, 8]} />
        <meshBasicMaterial color={hot} toneMapped={false} />
      </mesh>
    </Trail>
  );
}

export function McpPackets() {
  const [list, setList] = useState<McpCall[]>([]);
  const key = useRef(-1);
  useFrame(() => {
    let k = world.mcpCalls.length * 7919 + lod.version * 104729;
    for (const c of world.mcpCalls) k += c.id;
    if (k !== key.current) {
      key.current = k;
      setList(lod.grouped ? world.mcpCalls.filter((c) => isExpanded(c.instance)) : world.mcpCalls.slice());
    }
  });
  return (
    <>
      {list.map((c) => (
        <Packet key={c.id} call={c} />
      ))}
    </>
  );
}

// ------------------------------------------------------------------ MCP satellites (space stations) + backend probes
const SAT_BODY = new THREE.CylinderGeometry(0.22, 0.22, 0.75, 12);
const SAT_RING = new THREE.TorusGeometry(0.5, 0.04, 8, 40);
const SAT_STRUT = new THREE.BoxGeometry(0.3, 0.03, 0.03);
const SAT_PANEL = new THREE.BoxGeometry(0.75, 0.02, 0.42);
const SAT_BEACON = new THREE.SphereGeometry(0.55, 20, 20);
/** satellites float a little above the orbital plane (alternating), like a far outer orbit */
export const satAlt = (slot: number) => (slot % 2 ? 0.9 : 1.6);

/** MCP server slot: a space station on the outskirts (kit position, lifted off the plane). */
export function Satellite({ mcp }: McpServerSlotProps) {
  const srv = mcp.srv;
  const color = srv.color;
  const g = useRef<THREE.Group>(null);
  const panels = useRef<THREE.Group>(null);
  const beacon = useRef<THREE.Mesh>(null);
  const base = useMemo(() => new THREE.Color(color), [color]);
  const m = useMemo(
    () => ({
      body: new THREE.MeshBasicMaterial({ toneMapped: false }),
      ring: new THREE.MeshBasicMaterial({ toneMapped: false }),
      strut: new THREE.MeshBasicMaterial({ color: "#94a3b8" }),
      panel: new THREE.MeshBasicMaterial({ color: new THREE.Color(color).lerp(new THREE.Color("#1e3a8a"), 0.6).multiplyScalar(0.9), toneMapped: false }),
      beacon: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    }),
    [color],
  );
  const ringM = useRef<THREE.Mesh>(null);
  useFrame(({ clock }, dt) => {
    if (!g.current) return;
    const now = performance.now();
    const t = clock.elapsedTime;
    g.current.position.copy(mcp.pos);
    g.current.position.y += satAlt(srv.slot);
    const act = mcpGlow(srv.activeAt, now, 1.8);
    const busy = srv.inflight > 0;
    const sp = reduced ? 0.25 : 1;
    if (panels.current) panels.current.rotation.x += dt * (busy ? 2.4 : 0.35) * sp;
    m.body.color.copy(base).multiplyScalar(0.9 + (busy ? 1.6 + Math.sin(t * 6) * 0.6 : 0) + act * 3);
    if (ringM.current) ringM.current.rotation.z += dt * (busy ? 1.5 : 0.25) * sp;
    m.ring.color.copy(base).multiplyScalar(0.7 + act * 3 + (busy ? 1 : 0));
    if (beacon.current) beacon.current.scale.setScalar(1 + act * 1.2 + (busy ? 0.4 + Math.sin(t * 6) * 0.25 : 0));
    m.beacon.opacity = 0.05 + act * 0.1 + (busy ? 0.07 : 0);
  });
  return (
    <group ref={g}>
      <mesh geometry={SAT_BODY} material={m.body} />
      <mesh ref={ringM} geometry={SAT_RING} material={m.ring} rotation={[Math.PI / 2, 0, 0]} />
      <group ref={panels}>
        {[-1, 1].map((d) => (
          <group key={d}>
            <mesh geometry={SAT_STRUT} material={m.strut} position={[d * 0.55, 0, 0]} />
            <mesh geometry={SAT_PANEL} material={m.panel} position={[d * 1.05, 0, 0]} />
          </group>
        ))}
      </group>
      <mesh ref={beacon} geometry={SAT_BEACON} material={m.beacon} />
      <Label3D position={[0, -1.1, 0]} text={mcpTitle(srv)} color={color} size={0.3} pxRange={[9, 13]} />
    </group>
  );
}

const PROBE = new THREE.OctahedronGeometry(0.3, 0);
const PROBE_EDGES = new THREE.EdgesGeometry(PROBE);
const _sv = new THREE.Vector3();
const _bv = new THREE.Vector3();

/** Backend slot: a small relay probe parked beyond its station, tethered to it; lights up while it is queried. */
export function Probe({ mcp, backend }: BackendSlotProps) {
  const srv = mcp.srv;
  const res = backend.res;
  const col = useMemo(() => new THREE.Color(srv.color).lerp(new THREE.Color("#ffffff"), 0.3), [srv.color]);
  const g = useRef<THREE.Group>(null);
  const spin = useRef<THREE.Group>(null);
  const label = useRef<Label3DHandle>(null);
  const last = useRef("");
  const m = useMemo(
    () => ({
      fill: new THREE.MeshBasicMaterial({ color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      edge: new THREE.LineBasicMaterial({ color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      tether: new THREE.LineBasicMaterial({ color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    }),
    [col],
  );
  const line = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    return Object.assign(new THREE.Line(geo, m.tether), { frustumCulled: false });
  }, [m.tether]);
  useFrame(({ clock }) => {
    const now = performance.now();
    const busy = res.inflight > 0;
    const act = mcpGlow(res.activeAt, now, 1.5);
    const beat = busy && !reduced ? 0.5 + 0.5 * Math.sin(clock.elapsedTime * 5) : 0;
    _bv.copy(backend.pos);
    _bv.y += satAlt(srv.slot) * 0.6;
    g.current?.position.copy(_bv);
    if (spin.current) spin.current.rotation.y = reduced ? 0.4 : clock.elapsedTime * (busy ? 1.2 : 0.25);
    const k = busy ? 1.4 + beat * 0.8 : 0.18 + act * 0.9;
    m.fill.color.copy(col).multiplyScalar(k * 0.35);
    m.edge.color.copy(col).multiplyScalar(k * 1.4);
    m.tether.color.copy(col).multiplyScalar(busy ? 0.7 + beat * 0.4 : 0.12 + act * 0.5);
    _sv.copy(mcp.pos);
    _sv.y += satAlt(srv.slot);
    const P = line.geometry.getAttribute("position") as THREE.BufferAttribute;
    P.setXYZ(0, _sv.x, _sv.y, _sv.z);
    P.setXYZ(1, _bv.x, _bv.y, _bv.z);
    P.needsUpdate = true;
    let txt = res.name;
    if (busy) {
      let tool = "";
      for (const p of world.mcpPending.values()) if (p.server === srv.name && p.resource === res.name) tool = p.tool;
      txt = `${res.name} ▸ ${tool || "query"}()`;
    }
    if (label.current) {
      if (txt !== last.current) label.current.setText((last.current = txt));
      label.current.setOpacity(busy ? 1 : 0.5 + act * 0.5);
    }
  });
  return (
    <>
      <primitive object={line} />
      <group ref={g}>
        <group ref={spin}>
          <mesh geometry={PROBE} material={m.fill} />
          <lineSegments geometry={PROBE_EDGES} material={m.edge} />
        </group>
        <Label3D ref={label} position={[0, -0.7, 0]} text={res.name} color={srv.color} size={0.2} opacity={0.5} pxRange={[7.5, 11]} />
      </group>
    </>
  );
}
