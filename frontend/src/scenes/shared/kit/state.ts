/**
 * Scene kit state: one mutable singleton (like `world`), written once per frame by kitTick() and read by the
 * theme's slot components inside their own useFrame. See index.ts for the overview.
 */
import * as THREE from "three";
import type { Instance, McpResource, McpServer, Run } from "../world";

/** Which world plane the 2D layout lives on. "xy": camera looks down -z (neural). "xz": ground plane (orbit, flow). */
export type Plane = "xy" | "xz";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** One drawn agent (expanded instance). Stable object for the agent's lifetime: keep a reference in your slot. */
export type KitAgent = {
  /** unique per object (use as React key: a collapsed-then-expanded agent gets a fresh object) */
  uid: number;
  id: string;
  inst: Instance;
  /** the run this agent belongs to (kit run frame) */
  run: KitRun;
  /** run-local layout coords (before centering): u along run.side, v along run.axis (world units) */
  u: number;
  v: number;
  /** eased u/v (siblings joining re-space smoothly) */
  eu: number;
  ev: number;
  /** stage-space home position the kit wants (re-laid out on membership change) */
  target: THREE.Vector3;
  /** eased home position (~0.6s) */
  pos: THREE.Vector3;
  /**
   * drawn position. The kit copies `pos` into it at the start of every frame; a theme that moves agents around
   * their home (drift, train shuttle, holding pattern) overwrites it in its Agent useFrame. Beams, tethers and
   * edges read `live` (via agentLive()).
   */
  live: THREE.Vector3;
  /** eased size multiplier: roleScale(inst) * fit.scale. Multiply your agent geometry by it. */
  scale: number;
  /** nesting depth (0 = top-level agent of its run, 1 = subagent, 2 = sub-subagent ...) */
  depth: number;
  /** stable index among the living siblings that share this agent's parent, and the sibling count */
  sib: number;
  sibs: number;
  /** most children this agent has had at once while visible (sibling fans never collapse while fading) */
  kidsMax: number;
  /** its subagents' ring (layout.ts, unscaled local units): first ring radii, ring count, neighbour gap; its
   *  footprint radius (itself + every ring below it) and its largest child's footprint */
  rx: number;
  ry: number;
  rings: number;
  cell: number;
  foot: number;
  kidFoot: number;
  /**
   * radial tree (layout.ts, subagents): `tr` = its depth-0 ancestor (the tree root, null for a root / not laid out),
   * its angular wedge round the root (centre `wc`, width `ww`, run-local u/v radians; every descendant stays inside
   * it) and its ring radius `rho` in units of the root's first ring (rx, ry). On a root: `rhoD[d]` = the ring radius
   * of depth d this frame, `treeR` = the outermost one (last frame, sizes its footprint).
   */
  tr: KitAgent | null;
  wc: number;
  ww: number;
  rho: number;
  rhoD: Float64Array;
  treeR: number;
  /** subtree weight (leaf count, an empty child slot = 1) and how many of its children are drawn (measureRings) */
  tw: number;
  kn: number;
  /** where its ring starts (fraction of a step) and the frame that was computed in (layout.ts) */
  ringOff: number;
  ringAt: number;
  /** a service's ring: highest occupied sibling slot + 1 this frame, and since when it is below kidsMax (layout.ts) */
  kidsHi: number;
  kidsLowAt: number;
  /** backend service agent (`svc:` id, top-level): its slot among the run's services (-1 = not a service) */
  svcIdx: number;
  /** set false after the first layout (pos snaps to target instead of easing) */
  fresh: boolean;
  /**
   * 0..1 eased "finished" amount: 1 once the agent exited done/failed (it stays at its spot until its run ends).
   * The kit dims the Agent + Edge slots by it (darker color/emissive, lower opacity, red tint when failed) and
   * Label3D fades agent labels with it; a theme may also read it for its own finished look.
   */
  dim: number;
};

/** One drawn run (expanded run with visible agents, or a just-started run). */
export type KitRun = {
  uid: number;
  id: string;
  /** world run (undefined for agents whose run we never saw start, e.g. a late-joining viewer) */
  run: Run | undefined;
  /** rank among visible runs (oldest first) and the visible run count */
  index: number;
  count: number;
  color: string;
  /** eased stage-space anchor of the run group (the centre of its agents) */
  origin: THREE.Vector3;
  target: THREE.Vector3;
  /** unit stage vectors: `axis` = direction subagents fan out, `side` = line top-level agents sit on */
  axis: THREE.Vector3;
  side: THREE.Vector3;
  /** eased layout angle of the axis in the 2D layout plane (radians, ccw from screen-right) */
  angle: number;
  targetAngle: number;
  /** eased run-local centroid (subtract from agent u/v: runLocal() does it) and half extents (world units) */
  cu: number;
  cv: number;
  hu: number;
  hv: number;
  /** targets for the centroid/extents */
  tcu: number;
  tcv: number;
  fresh: boolean;
  /** visible agents in this run (updated each layout pass) */
  members: number;
  /** largest footprint radius of its top-level agents (layout.ts, unscaled): their spacing on the run line */
  foot: number;
  /** top-level agents drawn in it (layout.ts) */
  tops: number;
  /** backend service agents among them (layout.ts): 2+ sit apart on a ring, not on the role line */
  svc: number;
  /** footprint scratch (internal) */
  u0: number;
  u1: number;
  v0: number;
  v1: number;
};

/** `mix` 0..1: fade presence (the kit shrinks the slot about its position with it). */
export type KitBackend = { uid: number; res: McpResource; k: number; n: number; target: THREE.Vector3; pos: THREE.Vector3; fresh: boolean; mix: number };
export type KitMcp = {
  uid: number;
  name: string;
  srv: McpServer;
  /** +1 / -1: which way is "outward" from the core along screen-x (sides) or the radial direction sign (rim) */
  out: THREE.Vector3;
  target: THREE.Vector3;
  pos: THREE.Vector3;
  backends: Map<string, KitBackend>;
  fresh: boolean;
  /** world.mcpWanted() this frame: used recently (placed + framed); false = fading out (keeps its spot) */
  wanted: boolean;
  /** 0..1 fade presence; the server is removed from kit.mcp once it has faded out */
  mix: number;
};

export type KitGraph = {
  /** eased stage-space centre of the side graph */
  pos: THREE.Vector3;
  target: THREE.Vector3;
  /** world radius the side graph should occupy */
  radius: number;
  /** theme graph's natural radius (local units); scale = radius / natural * mix */
  natural: number;
  /** current group scale (stage = pos + local * scale) */
  scale: number;
  /**
   * unit stage direction from the core toward the graph (outward side): e.g. (-1, 0, 0) when it sits on the left.
   * Put graph captions / node names on the far side with it instead of testing target.x.
   */
  out: THREE.Vector3;
  /** 0..1 presence (fades in at the side when the graph appears mid-session) */
  mix: number;
  fresh: boolean;
};

export const kit = {
  plane: "xy" as Plane,
  agents: new Map<string, KitAgent>(),
  runs: new Map<string, KitRun>(),
  mcp: new Map<string, KitMcp>(),
  /** active cluster lanes (grouped mode): eased stage positions by lane */
  clusterPos: [] as THREE.Vector3[],
  clusterTarget: [] as THREE.Vector3[],
  clusterFresh: [] as boolean[],
  graph: {
    pos: new THREE.Vector3(),
    target: new THREE.Vector3(),
    radius: 2.6,
    natural: 1,
    scale: 0,
    out: new THREE.Vector3(-1, 0, 0),
    mix: 0,
    fresh: true,
  } as KitGraph,
  /** eased half extents of the core (agents + clusters) in the 2D layout plane (world units) */
  core: { hw: 4, hh: 4, r: 4, thw: 4, thh: 4 },
  /** bump when the corresponding list membership changes (slot lists re-render) */
  agentsVersion: 0,
  runsVersion: 0,
  mcpVersion: 0,
  /** the theme's GraphResource wants to draw (session has a graph AND the galaxy has nodes) */
  graphWanted: false,
  /** visible runs, oldest first (rebuilt when runsVersion bumps) */
  runOrder: [] as KitRun[],
};
export type Kit = typeof kit;

// ------------------------------------------------------------------ plane mapping + helpers (no allocations)

/** 2D layout coords (a = screen-right, b = screen-up) to a stage-space point on the kit plane. */
export function planePoint(a: number, b: number, out: THREE.Vector3) {
  return kit.plane === "xy" ? out.set(a, b, 0) : out.set(a, 0, -b);
}
/** Stage point to 2D layout coords (a, b). */
export function planeA(p: THREE.Vector3) {
  return p.x;
}
export function planeB(p: THREE.Vector3) {
  return kit.plane === "xy" ? p.y : -p.z;
}

/** Stage position of run-local coords (u along side, v along axis), using the run's eased frame + centroid. */
export function runLocal(r: KitRun, u: number, v: number, out: THREE.Vector3) {
  return out.copy(r.origin).addScaledVector(r.side, u - r.cu).addScaledVector(r.axis, v - r.cv);
}

/** Drawn position of an agent (undefined when it isn't drawn: collapsed into a cluster, or gone). */
export function agentLive(id: string): THREE.Vector3 | undefined {
  return kit.agents.get(id)?.live;
}
/** Eased stage position of an MCP server / one of its backends. */
export function serverPos(name: string): THREE.Vector3 | undefined {
  return kit.mcp.get(name)?.pos;
}
export function backendPos(server: string, res: string): THREE.Vector3 | undefined {
  return kit.mcp.get(server)?.backends.get(res)?.pos;
}
/** Stage position of a point given in the side graph's local frame (theme graph units). */
export function graphToStage(local: THREE.Vector3, out: THREE.Vector3) {
  const g = kit.graph;
  return out.copy(local).multiplyScalar(g.scale).add(g.pos);
}
/** A stage point expressed in the side graph's local frame (draw beams inside the graph group with it). */
export function stageToGraph(stage: THREE.Vector3, out: THREE.Vector3) {
  const g = kit.graph;
  return out.copy(stage).sub(g.pos).divideScalar(Math.max(1e-4, g.scale));
}

let uidSeq = 0;
/** next unique object id (React keys) */
export const nextUid = () => ++uidSeq;

const r2 = (v: THREE.Vector3) => [Math.round(v.x * 100) / 100, Math.round(v.y * 100) / 100, Math.round(v.z * 100) / 100];
/** Plain-data snapshot of the kit (Maps flattened to arrays): what window.__agentglowKit serializes to. */
export function kitSummary() {
  return {
    plane: kit.plane,
    agents: [...kit.agents.values()].map((a) => ({ id: a.id, run: a.run.id, depth: a.depth, scale: Math.round(a.scale * 100) / 100, pos: r2(a.pos) })),
    runs: kit.runOrder.map((r) => ({ id: r.id, members: r.members, origin: r2(r.origin), hu: r.hu, hv: r.hv })),
    mcp: [...kit.mcp.values()].map((m) => ({ name: m.name, wanted: m.wanted, mix: Math.round(m.mix * 100) / 100, pos: r2(m.pos), backends: [...m.backends.values()].map((b) => ({ res: b.res.name, mix: Math.round(b.mix * 100) / 100, pos: r2(b.pos) })) })),
    clusters: kit.clusterPos.map(r2),
    core: { ...kit.core },
    graph: { wanted: kit.graphWanted, pos: r2(kit.graph.pos), out: r2(kit.graph.out), radius: kit.graph.radius, scale: kit.graph.scale, mix: kit.graph.mix },
  };
}

// debugging / verification hook (read-only use): window.__agentglowKit is the live kit object (Maps); its
// JSON form (JSON.stringify, page.evaluate(() => JSON.stringify(...))) and .summary() are plain data, so a
// serialized read never comes back as empty {} Maps
if (typeof window !== "undefined") {
  Object.defineProperties(kit, { toJSON: { value: kitSummary, enumerable: false }, summary: { value: kitSummary, enumerable: false } });
  (window as unknown as { __agentglowKit?: typeof kit }).__agentglowKit = kit;
}
