/**
 * Detector elements at the edge of the chamber (scene-kit McpServer / Backend slots, placed by the kit):
 * MCP servers are two-layer strip detector PLATES facing the chamber; their backends (Postgres, Snowflake, Spark…)
 * are hexagonal SENSOR CELLS wired to the plate (kit <ResourceWire>).
 *   call    -> a field line from the agent to the plate with dashes flowing out (server colour -> amber -> red the
 *              longer it waits); the strip the call lands on lights up
 *   result  -> a fast particle flies back plate -> agent leaving a bubble track
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { hash01, mcpGlow, mcpTitle, waitSeconds, world, type McpCall } from "../shared/world";
import { ResourceWire, agentLive, serverPos, type BackendSlotProps, type McpServerSlotProps } from "../shared/kit";
import { AMBER, LinePool, RED, Trail, WHITE, additive, bezier, bubbles, clamp01, curl, easeInOut, easeOut, lineMat, nowS, reduced } from "./fx";

const PW = 0.34; // plate thickness (along the outward direction)
const PH = 2.1; // plate length (across)
const STRIPS = 12;

/** two strip layers: outlines + strip separators (plate-local: x = outward, y = across) */
const PLATE_GEO = (() => {
  const v: number[] = [];
  const seg = (x0: number, y0: number, x1: number, y1: number) => v.push(x0, y0, 0, x1, y1, 0);
  for (const off of [-0.28, 0.28]) {
    const x0 = off - PW / 2;
    const x1 = off + PW / 2;
    seg(x0, -PH / 2, x1, -PH / 2);
    seg(x1, -PH / 2, x1, PH / 2);
    seg(x1, PH / 2, x0, PH / 2);
    seg(x0, PH / 2, x0, -PH / 2);
    for (let i = 1; i < STRIPS; i++) {
      const y = -PH / 2 + (i / STRIPS) * PH;
      seg(x0, y, x1, y);
    }
  }
  return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
})();
const PLATE_FILL = new THREE.PlaneGeometry(PW, PH);
const STRIP_GEO = new THREE.PlaneGeometry(PW * 0.92, (PH / STRIPS) * 0.8);
const HEX_GEO = (() => {
  const v: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const a1 = ((i + 1) / 6) * Math.PI * 2 + Math.PI / 6;
    v.push(Math.cos(a0), Math.sin(a0), 0, Math.cos(a1), Math.sin(a1), 0);
    v.push(Math.cos(a0) * 0.62, Math.sin(a0) * 0.62, 0, Math.cos(a1) * 0.62, Math.sin(a1) * 0.62, 0);
  }
  return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
})();
const HEX_FILL = new THREE.CircleGeometry(1, 6, Math.PI / 6);

export function Plate({ mcp }: McpServerSlotProps) {
  const srv = mcp.srv;
  const col = useMemo(() => new THREE.Color(srv.color).lerp(WHITE, 0.25), [srv.color]);
  const m = useMemo(() => ({ line: lineMat(col), fill: additive(col), strip: additive(col) }), [col]);
  const g = useRef<THREE.Group>(null);
  const rot = useRef<THREE.Group>(null);
  const strip = useRef<THREE.Mesh>(null);
  const lab = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const now = performance.now();
    const ang = Math.atan2(mcp.out.y, mcp.out.x);
    g.current?.position.copy(mcp.pos);
    if (rot.current) rot.current.rotation.z = ang;
    const busy = srv.inflight > 0;
    const act = mcpGlow(srv.activeAt, now, 1.4);
    const beat = busy && !reduced ? 0.5 + 0.5 * Math.sin(clock.elapsedTime * 6) : busy ? 0.5 : 0;
    m.line.color.copy(col).multiplyScalar(0.32 + act * 0.5 + (busy ? 0.35 + beat * 0.25 : 0));
    m.fill.color.copy(col).multiplyScalar(0.035 + act * 0.06 + (busy ? 0.05 : 0));
    // the strip the latest call landed on
    let tool = "";
    for (const p of world.mcpPending.values()) if (p.server === srv.name) tool = p.tool;
    if (!tool) for (const c of world.mcpCalls) if (c.server === srv.name) tool = c.tool;
    if (strip.current) {
      const k = busy ? 0.55 + beat * 0.5 : act * 0.6;
      strip.current.visible = k > 0.02 && tool !== "";
      if (tool) strip.current.position.set(0.28, -PH / 2 + (Math.floor(hash01(tool, 3) * STRIPS) + 0.5) * (PH / STRIPS), 0.01);
      m.strip.color.copy(col).lerp(WHITE, 0.3).multiplyScalar(k);
    }
    lab.current?.position.set(0, Math.abs(Math.cos(ang)) * (PH / 2) + 0.5, 0);
  });
  return (
    <group ref={g}>
      <group ref={rot}>
        <lineSegments geometry={PLATE_GEO} material={m.line} />
        <mesh geometry={PLATE_FILL} material={m.fill} position={[-0.28, 0, 0]} />
        <mesh geometry={PLATE_FILL} material={m.fill} position={[0.28, 0, 0]} />
        <mesh ref={strip} geometry={STRIP_GEO} material={m.strip} visible={false} />
      </group>
      <group ref={lab}>
        <Label3D text={mcpTitle(srv)} color={srv.color} size={0.28} anchorY="bottom" pxRange={[9, 13]} />
      </group>
    </group>
  );
}

/** Backend slot: a hexagonal sensor cell wired to its plate. */
export function Cell({ mcp, backend }: BackendSlotProps) {
  const srv = mcp.srv;
  const res = backend.res;
  const col = useMemo(() => new THREE.Color(srv.color).lerp(WHITE, 0.3), [srv.color]);
  const m = useMemo(() => ({ line: lineMat(col), fill: additive(col) }), [col]);
  const g = useRef<THREE.Group>(null);
  const cell = useRef<THREE.Group>(null);
  const label = useRef<Label3DHandle>(null);
  const last = useRef("");
  const R = res.kind === "warehouse" || res.kind === "spark" ? 0.4 : 0.33;
  useFrame(({ clock }) => {
    const now = performance.now();
    g.current?.position.copy(backend.pos);
    const busy = res.inflight > 0;
    const act = mcpGlow(res.activeAt, now, 1.4);
    const beat = busy && !reduced ? 0.5 + 0.5 * Math.sin(clock.elapsedTime * 5) : busy ? 0.5 : 0;
    m.line.color.copy(col).multiplyScalar(0.35 + act * 0.6 + (busy ? 0.5 + beat * 0.4 : 0));
    m.fill.color.copy(col).multiplyScalar(0.04 + act * 0.12 + (busy ? 0.12 + beat * 0.1 : 0));
    if (cell.current) cell.current.rotation.z = reduced ? 0 : clock.elapsedTime * (busy ? 0.6 : 0.05);
    let txt = res.name;
    if (busy) {
      let tool = "";
      for (const p of world.mcpPending.values()) if (p.server === srv.name && p.resource === res.name) tool = p.tool;
      txt = `${res.name} ▸ ${tool || "query"}()`;
    } else if (act > 0.25 && res.calls > 0) txt = `${res.name} ✓`;
    if (label.current) {
      if (txt !== last.current) label.current.setText((last.current = txt));
      label.current.setOpacity(busy ? 1 : 0.55 + act * 0.45);
      label.current.setEmphasis(busy);
    }
  });
  return (
    <>
      <ResourceWire mcp={mcp} backend={backend} gain={0.7} />
      <group ref={g}>
        <group ref={cell} scale={R}>
          <lineSegments geometry={HEX_GEO} material={m.line} />
          <mesh geometry={HEX_FILL} material={m.fill} />
        </group>
        <Label3D ref={label} position={[0, -R - 0.32, 0]} text={res.name} color={srv.color} size={0.2} opacity={0.55} pxRange={[7.5, 11.5]} />
      </group>
    </>
  );
}

// ------------------------------------------------------------------ agent <-> plate tracks (pooled)
const MAX_T = 48;
const _c = new THREE.Vector3();
const _h = new THREE.Vector3();
const _col = new THREE.Color();

export function McpTracks() {
  const lines = useMemo(() => new LinePool(MAX_T, 36), []);
  const trails = useMemo(() => new Map<number, Trail>(), []);
  useFrame(({ clock }) => {
    const now = performance.now();
    const t = nowS();
    const time = reduced ? 0 : clock.elapsedTime;
    lines.begin();
    // pending: a field line agent -> plate, dashes flowing out, warming amber -> red with the wait
    for (const p of world.mcpPending.values()) {
      const a = agentLive(p.instance);
      const b = serverPos(p.server);
      const srv = world.mcpServers.get(p.server);
      if (!a || !b || !srv) continue;
      curl(a, b, 0.12, _c);
      const w = waitSeconds(p, now);
      _col.set(srv.color).lerp(AMBER, clamp01(w / 1.2));
      if (w > 1.2) _col.lerp(RED, clamp01((w - 1.2) / 1.0));
      const len = a.distanceTo(b);
      const t1 = 0.04 + 0.92 * easeOut(w / 0.45);
      lines.add(a, _c, b, _col, (0.3 + Math.min(0.3, w * 0.12)) * easeOut(w / 0.3), 0.04, t1, Math.max(4, Math.round(len / 0.5)), time * 1.4, w < 0.45 ? t1 : -1, 1.0);
    }
    // results: a fast particle back plate -> agent, leaving a bubble track
    for (const id of trails.keys()) {
      let alive = false;
      for (const c of world.mcpCalls) if (c.id === id) alive = true;
      if (!alive) trails.delete(id);
    }
    for (const r of world.mcpCalls as McpCall[]) {
      if (r.phase !== "result") continue;
      const u = clamp01((now - r.start) / r.dur);
      if (u >= 1) continue;
      const a = agentLive(r.instance);
      const b = serverPos(r.server);
      const srv = world.mcpServers.get(r.server);
      if (!a || !b || !srv) continue;
      let tr = trails.get(r.id);
      if (!tr) trails.set(r.id, (tr = new Trail()));
      curl(a, b, 0.12, _c);
      const k = easeInOut(u);
      bezier(a, _c, b, 1 - k, _h);
      _col.set(srv.color).lerp(WHITE, 0.45);
      const fade = 1 - Math.max(0, (k - 0.85) / 0.15);
      lines.add(a, _c, b, _col, 0.1 * fade, 0.04, 0.96, 0, 0, 1 - k, 1.3 * fade);
      tr.step(_h, 0.065, 0.08, _col, 0.95 * fade, 2.6, t, 6);
      bubbles().emit(_h.x, _h.y, _h.z, 0.5, _col, 1.3 * fade, 0.12, t, 1);
    }
    lines.end();
  });
  return <primitive object={lines.obj} />;
}
