/**
 * MCP light trails (KitScene child). The MCP servers themselves are the kit's crystals with orbiting satellites
 * (shared/kit/Crystal.tsx, sparks via the show's spark field: index.tsx `mcpStyle.emit`).
 * A pending MCP call is a light trail from the agent's shell to the crystal (server color -> amber -> red the longer
 * it waits, with a comet head shedding sparks), then on to the satellite; the result is a bright comet flying back.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { waitSeconds, world, type McpCall } from "../shared/world";
import { agentLive, backendPos, satellitePos, serverPos } from "../shared/kit";
import { AMBER, CurvePool, HeadPool, KIND_GLITTER, KIND_SPARK, RED, WHITE, bezier, bow, clamp01, easeInOut, easeOut, pyro, reduced } from "./fx";

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
        const mp = satellitePos(p.server, p.resource) ?? backendPos(p.server, p.resource);
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
