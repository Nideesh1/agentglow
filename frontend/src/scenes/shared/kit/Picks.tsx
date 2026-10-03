/**
 * Click targets for everything that is not an agent, drawn once in the kit so every theme gets them: an invisible pick
 * sphere on each MCP server / resource group and on each of its backends (satellites), and an invisible tube along
 * each recently used agent / service -> server link. Hover = pointer cursor + a highlight ring / line; click = the
 * Resource details panel (world.selectResource, ResourcePanel.tsx); the selected one stays highlighted.
 */
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { resInfo, sameSel, type ResSel } from "../resinfo";
import { selectResource, world } from "../world";
import { useKitList } from "./KitScene";
import { agentLive, kit } from "./state";

/** the hovered target (one at a time) */
let hovered: ResSel | null = null;
let hoverKey = "";

function setHover(sel: ResSel | null) {
  hovered = sel;
  hoverKey = sel ? JSON.stringify(sel) : "";
  if (typeof document !== "undefined") document.body.style.cursor = sel ? "pointer" : "";
}

/** `?debugpicks`: window.__agentglowPicks = screen positions of the click targets (browser tests / screenshots) */
const DEBUG = typeof location !== "undefined" && new URLSearchParams(location.search).has("debugpicks");
const targets = new Map<string, THREE.Object3D>();
const _p = new THREE.Vector3();

const isOn = (key: string) => hoverKey === key || JSON.stringify(world.selectedRes) === key;

const PICK_MAT = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
const SPHERE = new THREE.SphereGeometry(1, 12, 8);
const RING = new THREE.RingGeometry(1.05, 1.22, 48);
const TUBE = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);

/** a server's pick sphere yields to a satellite (backend) pick under the same pointer: satellites orbit inside it */
const yields = (sel: ResSel, e: ThreeEvent<PointerEvent | MouseEvent>) => sel.type !== "backend" && e.intersections.some((i) => i.object.userData.agBackend && i.object.parent?.parent?.visible !== false);

function handlers(sel: ResSel, live: () => boolean) {
  return {
    userData: sel.type === "backend" ? { agBackend: true } : {},
    onClick: (e: ThreeEvent<MouseEvent>) => {
      if (!live() || yields(sel, e)) return;
      e.stopPropagation();
      selectResource(sel);
    },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      if (!live() || yields(sel, e)) return;
      e.stopPropagation();
      setHover(sel);
    },
    onPointerOut: () => {
      if (hovered && sameSel(hovered, sel)) setHover(null);
    },
  };
}

/**
 * Inside a faded resource slot (local origin = the item's position, scaled by its fade): the pick sphere and the
 * camera-facing highlight ring of radius `r`.
 */
export function ResourcePick({ sel, r, color, mix }: { sel: ResSel; r: number; color: string; mix: () => number }) {
  const ring = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const key = JSON.stringify(sel);
  useFrame(({ camera }) => {
    const m = ring.current;
    if (!m || !mat.current) return;
    const on = isOn(key);
    m.visible = on;
    if (!on) return;
    m.quaternion.copy(camera.quaternion);
    mat.current.opacity = sameSel(world.selectedRes, sel) ? 0.9 : 0.55;
  });
  return (
    <>
      <mesh ref={(o) => void (DEBUG && (o ? targets.set(key, o) : targets.delete(key)))} geometry={SPHERE} material={PICK_MAT} scale={r} {...handlers(sel, () => mix() > 0.3)} />
      <mesh ref={ring} geometry={RING} scale={r} visible={false} renderOrder={10}>
        <meshBasicMaterial ref={mat} color={color} transparent depthWrite={false} depthTest={false} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
    </>
  );
}

/** a link stays clickable this long after its last call */
const LINK_MS = 30_000;
const linksV = () => resInfo.linkVersion * 100_000 + Math.floor(performance.now() / 2000);
const linkList = () => {
  const now = performance.now();
  const out: { id: string; server: string }[] = [];
  for (const [k, a] of resInfo.links) {
    if (now - a.last > LINK_MS) continue;
    const cut = k.lastIndexOf("|");
    out.push({ id: k.slice(0, cut), server: k.slice(cut + 1) });
  }
  return out.slice(-64);
};

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function LinkPick({ id, server, radius }: { id: string; server: string; radius: number }) {
  const g = useRef<THREE.Group>(null);
  const line = useRef<THREE.Mesh>(null);
  const sel: ResSel = { type: "link", id, server };
  const key = JSON.stringify(sel);
  const ok = useRef(false);
  useFrame(() => {
    const o = g.current;
    if (!o) return;
    const a = agentLive(id);
    const m = kit.mcp.get(server);
    const ag = kit.agents.get(id);
    ok.current = !!(a && m && m.mix > 0.3 && ag && ag.live && ag.scale > 0.05);
    if (!ok.current) {
      o.visible = false;
      return;
    }
    // trimmed at both ends so the agent and the server keep their own clicks
    _d.subVectors(m!.pos, a!);
    const len = _d.length();
    const trimA = radius * Math.max(0.3, ag!.scale) * 1.1;
    const trimB = 1.0;
    const l = len - trimA - trimB;
    if (l < 0.6) {
      o.visible = false;
      return;
    }
    _d.divideScalar(len);
    _a.copy(a!).addScaledVector(_d, trimA);
    _b.copy(_a).addScaledVector(_d, l);
    o.visible = true;
    o.position.addVectors(_a, _b).multiplyScalar(0.5);
    o.quaternion.setFromUnitVectors(UP, _d);
    o.scale.set(1, l, 1);
    if (line.current) line.current.visible = isOn(key);
  });
  return (
    <group ref={g} visible={false}>
      <mesh ref={(o) => void (DEBUG && (o ? targets.set(key, o) : targets.delete(key)))} geometry={TUBE} material={PICK_MAT} scale={[0.22, 1, 0.22]} {...handlers(sel, () => ok.current)} />
      <mesh ref={line} geometry={TUBE} scale={[0.045, 1, 0.045]} visible={false} renderOrder={10}>
        <meshBasicMaterial color="#e2e8f0" transparent opacity={0.8} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Click targets on agent / service -> server links (all themes). */
export function LinkPicks({ radius }: { radius: number }) {
  const list = useKitList(linksV, linkList);
  useFrame(({ camera, size }) => {
    if (!DEBUG) return;
    const out: { key: string; x: number; y: number }[] = [];
    for (const [key, o] of targets) {
      o.getWorldPosition(_p).project(camera);
      if (o.parent?.visible === false || Math.abs(_p.z) > 1) continue;
      out.push({ key, x: Math.round(((_p.x + 1) / 2) * size.width), y: Math.round(((1 - _p.y) / 2) * size.height) });
    }
    (window as unknown as { __agentglowPicks: unknown }).__agentglowPicks = out;
  });
  return (
    <>
      {list.map((l) => (
        <LinkPick key={`${l.id}|${l.server}`} id={l.id} server={l.server} radius={radius} />
      ))}
    </>
  );
}
