/**
 * Kit layout engine: kitTick() runs once per frame (after world tick() + lodTick()) and owns WHERE everything is:
 *   1. membership: which agents/runs are drawn (lod isExpanded / isRunExpanded), MCP servers/backends
 *   2. run-local agent coords (u along the run's side line, v along its axis): top-level agents on role slots
 *      (planner | researcher | writer), subagents in a 3D spherical radial tree round their top-level agent (a cone per
 *      child, one sphere shell per depth, w out of the layout plane), seeded jitter, stable slots
 *   3. run anchors from the theme's preset (presets.ts), each run centred on its anchor
 *   4. cluster balls (grouped mode), core extents, periphery: MCP servers + backends and the side graph
 *   5. easing (~0.6s) of every position; agent `live` = eased home (themes add their own motion on top)
 * No per-frame allocations: objects are created on membership changes only.
 */
import * as THREE from "three";
import { clusterOf, isExpanded, isRunExpanded, LOD_LANES, lod } from "../lod";
import { alt, jit } from "../spread";
import { IDLE_DIM, graphMix, graphShown, isDone, isIdle, mcpWanted, roleScale, svcIdle, world, type AgentType, type Instance } from "../world";
import { fit, fitTick } from "./fit";
import { radial, type LayoutPreset, type Point2, type PresetCtx, type Slot2 } from "./presets";
import { kit, nextUid, planeNormal, planePoint, reduced, type KitAgent, type KitBackend, type KitMcp, type KitRun } from "./state";

export type KitConfig = {
  preset: LayoutPreset;
  /** theme graph natural radius (local units of its GraphResource) */
  graphNatural: number;
  /** world radius of the side graph (before fit) */
  graphRadius: number;
  /** gap between the core and the periphery (world units) */
  peripheryGap: number;
};
export const config: KitConfig = { preset: radial, graphNatural: 1, graphRadius: 2.6, peripheryGap: 3.6 };

const ROLE_SLOT: Record<AgentType, number> = { planner: -1, researcher: 0, writer: 1, graph_scout: 0, records_scout: 0, data_scout: 0 };

/** Run-local u of a top-level role's slot (stations, lane markers): planner < researcher < writer. */
export function kitRoleU(role: AgentType) {
  return ROLE_SLOT[role] * config.preset.local.topGap * fit.spread;
}

// ------------------------------------------------------------------ scratch (reused)
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _x = new THREE.Vector3();
const slot: Slot2 = { a: 0, b: 0, angle: 0 };
const pt: Point2 = { a: 0, b: 0 };
const ctx: PresetCtx & { hw: number; hh: number } = { n: 0, aspect: 1.6, hu: 2, hv: 2, hw: 2, hh: 2 };
const activeLanes: number[] = [];
let lastNow = -1;

const ease = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);
function lerpAngle(a: number, b: number, k: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

// ------------------------------------------------------------------ membership

function mkRun(id: string): KitRun {
  const r = world.runs.get(id);
  return {
    uid: nextUid(),
    id,
    run: r,
    index: 0,
    count: 1,
    color: r?.color ?? "#94a3b8",
    origin: new THREE.Vector3(),
    target: new THREE.Vector3(),
    axis: new THREE.Vector3(0, -1, 0),
    side: new THREE.Vector3(1, 0, 0),
    normal: planeNormal(new THREE.Vector3()),
    angle: -Math.PI / 2,
    targetAngle: -Math.PI / 2,
    cu: 0,
    cv: 0,
    hu: 1,
    hv: 1,
    tcu: 0,
    tcv: 0,
    fresh: true,
    members: 0,
    foot: 0,
    tops: 0,
    svc: 0,
    u0: 0,
    u1: 0,
    v0: 0,
    v1: 0,
  };
}

function lowestFree(pred: (o: KitAgent) => boolean) {
  let k = 0;
  for (let taken = true; taken; ) {
    taken = false;
    for (const o of kit.agents.values())
      if (o.sib === k && pred(o)) {
        taken = true;
        k++;
        break;
      }
  }
  return k;
}

function mkAgent(inst: Instance): KitAgent {
  let run = kit.runs.get(inst.run);
  if (!run) {
    run = mkRun(inst.run);
    kit.runs.set(inst.run, run);
    kit.runsVersion++;
  }
  const parent = inst.parent ? kit.agents.get(inst.parent) : undefined;
  // a top-level agent handed off from a SUBAGENT (e.g. a Hatchet child run's analyst started by a market agent) is
  // drawn as that subagent's child, next to it; handoffs between top-level agents stay top-level
  const depth = inst.subagent ? (parent ? parent.depth + 1 : 1) : parent && parent.depth > 0 ? parent.depth + 1 : 0;
  let sib: number;
  if (depth === 0) sib = lowestFree((o) => o.depth === 0 && o.inst.run === inst.run && o.inst.type === inst.type);
  else sib = lowestFree((o) => o.depth > 0 && o.inst.parent === inst.parent);
  if (parent && depth > 0) parent.kidsMax = Math.max(parent.kidsMax, sib + 1);
  return {
    uid: nextUid(),
    id: inst.id,
    inst,
    run,
    u: 0,
    v: 0,
    w: 0,
    eu: 0,
    ev: 0,
    ew: 0,
    target: new THREE.Vector3(),
    pos: new THREE.Vector3(),
    live: new THREE.Vector3(),
    scale: kitScale(inst, depth) * fit.scale,
    depth,
    sib,
    sibs: 1,
    kidsMax: 0,
    kidsHi: 0,
    kidsLowAt: 0,
    kidFoot: 0,
    foot: 0,
    rx: 0,
    ry: 0,
    rings: 0,
    cell: 0,
    tr: null,
    du: 1,
    dv: 0,
    dw: 0,
    ww: 0,
    rho: 0,
    rhoD: new Float64Array(TREE_D + 1),
    treeR: 0,
    tw: 1,
    kn: 0,
    ringOff: 0,
    ringAt: -1,
    svcIdx: -1,
    fresh: true,
    dim: isDone(inst) ? 1 : 0,
  };
}

/** size of an agent before fit.scale: parents big, subagents (and agents nested under one) small */
const kitScale = (inst: Instance, depth: number) => (depth > 0 ? Math.min(roleScale(inst), 0.6) : roleScale(inst));
/** members of a big top-level ring (a desk's markets) are the main actors on a spread-out screen: a bit bigger */
const RING_BIG = 6;
const RING_SCALE = 1.15;
/** a backend service node (`svc:` top-level): a bit bigger than a run's root agent, it carries a whole process */
const SVC_SCALE = 1.55;
function agentScale(a: KitAgent) {
  if (a.depth === 0 && a.id.startsWith("svc:")) return SVC_SCALE;
  if (a.depth === 1 && a.sibs >= RING_BIG) return RING_SCALE;
  return kitScale(a.inst, a.depth);
}

/** finished agents dim over ~this many seconds */
const DIM_S = 0.6;

/** new agent slots mounted per frame at most (ungrouping / "show all" with hundreds of agents stays smooth) */
const MOUNTS_PER_FRAME = 16;

function syncMembership() {
  // agents. An agent that is already exiting is never expanded out of its cluster (a mass exit that drops the
  // world below the grouping threshold would otherwise mount hundreds of fading agents at once).
  let mounts = 0;
  for (const inst of world.instances.values()) {
    if (kit.agents.has(inst.id) || inst.exitAt || !isExpanded(inst)) continue;
    if (mounts >= MOUNTS_PER_FRAME) break;
    // parents first so a subagent finds its parent's slot (it is picked up next frame otherwise)
    const par = inst.parent ? world.instances.get(inst.parent) : undefined;
    if (par && !par.exitAt && !kit.agents.has(par.id) && isExpanded(par)) continue;
    kit.agents.set(inst.id, mkAgent(inst));
    kit.agentsVersion++;
    mounts++;
  }
  for (const [id, a] of kit.agents)
    if (!world.instances.has(id) || !isExpanded(a.inst)) {
      kit.agents.delete(id);
      kit.agentsVersion++;
    }
  // runs: every run with drawn agents + expanded runs that just started (marker before the first agent)
  for (const r of kit.runs.values()) r.members = 0;
  for (const a of kit.agents.values()) a.run.members++;
  for (const r of world.runs.values()) {
    if (kit.runs.has(r.id) || r.endedAt || !isRunExpanded(r.id)) continue;
    kit.runs.set(r.id, mkRun(r.id));
    kit.runsVersion++;
  }
  for (const [id, r] of kit.runs) {
    const wr = world.runs.get(id);
    if (wr && !r.run) {
      r.run = wr;
      r.color = wr.color;
    }
    if (r.members > 0) continue;
    if (wr && !wr.endedAt && isRunExpanded(id)) continue;
    kit.runs.delete(id);
    kit.runsVersion++;
  }
  // MCP servers + their backends: only while USED (world.mcpWanted). A server idle past MCP_IDLE_MS stops being
  // wanted, fades out in place (kitTick) and is dropped; its next call brings it back (fresh, fading in).
  const now = performance.now();
  for (const srv of world.mcpServers.values()) {
    let m = kit.mcp.get(srv.name);
    const wanted = mcpWanted(srv, now);
    if (m) m.wanted = wanted;
    if (!wanted && !m) continue;
    if (!m) {
      m = { uid: nextUid(), name: srv.name, srv, out: new THREE.Vector3(1, 0, 0), target: new THREE.Vector3(), pos: new THREE.Vector3(), backends: new Map(), fresh: true, wanted: true, mix: 0 };
      kit.mcp.set(srv.name, m);
      kit.mcpVersion++;
    }
    if (m.backends.size !== srv.resources.size) {
      for (const res of srv.resources.values())
        if (!m.backends.has(res.name)) m.backends.set(res.name, { uid: nextUid(), res, k: 0, n: 0, target: new THREE.Vector3(), pos: new THREE.Vector3(), fresh: true, mix: 0 } as KitBackend);
      kit.mcpVersion++;
    }
  }
}

let seenRunsVersion = -1;
function orderRuns() {
  if (seenRunsVersion === kit.runsVersion && kit.runOrder.length === kit.runs.size) return;
  seenRunsVersion = kit.runsVersion;
  // backend services runs first: with two runs the first sits on the right, where the MCP servers / backends column
  // is, so the services group lies between the agent run and the resources its services call
  const svc = (r: KitRun) => (r.run?.workflow === "services" ? 0 : 1);
  kit.runOrder = [...kit.runs.values()].sort((a, b) => svc(a) - svc(b) || (a.run?.startedAt ?? 0) - (b.run?.startedAt ?? 0) || (a.id < b.id ? -1 : 1));
}

// ------------------------------------------------------------------ run-local agent layout

/**
 * Subagents form a 3D SPHERICAL RADIAL TREE round their top-level agent (the root), filling space 360 deg in every
 * direction (w runs out of the layout plane, along run.normal), not a flat disc:
 *   - the root's children sit on a SPHERE SHELL round it, spread evenly over the full sphere by a Fibonacci
 *     (golden-angle) lattice whose pole points out of the plane, turned round that pole so no child sits on the
 *     root's own lines (its name label below, the run line its neighbours sit on);
 *   - each child owns a CONE (solid angle) round its direction from the root, sized by its subtree's leaf count;
 *     its children are spread evenly inside that cone (a golden-angle lattice on the cone's spherical cap) and own
 *     sub-cones (their share of it by leaf count), so a whole subtree stays inside its cone;
 *   - each depth sits on its own sphere shell round the root (radius by depth, grown until the narrowest cone at
 *     that depth still holds a neighbour gap), so straight parent -> child links never cross or overlap.
 * A root's shell is an ellipsoid in the free area's aspect when its run is the only one on screen (the main group
 * fills the screen); otherwise a sphere. A root's footprint covers its outermost shell (last frame), so top-level
 * agents of one run sit their trees apart. A lone subagent of a top-level agent goes down-right (tilted towards the
 * viewer). Lattices are deterministic: siblings keep their slot (sib) and the slot count only grows while the parent
 * is visible (kidsMax), so a new child only nudges its siblings and every position eases.
 */
/** neighbour gap on a top-level shell / a nested one, in subGap units (an agent + its halo + name, with air) */
const CELL_TOP = 2.6;
const CELL_SUB = 1.45;
/** footprint radius of a childless agent (local units, before fit.spread) */
const FOOT = 1.3;
const TAU = Math.PI * 2;
/** deepest tree shell tracked per root (deeper agents share it) */
const TREE_D = 7;
/** radial step between tree shells, in fanLen units (local, before fit.spread) */
const TREE_STEP = 0.85;
/** widest cone a root child gets (half-angle; a lone child / two children: its subtree still fans outward) */
const CONE_MAX = Math.PI / 2;
/** cones are a bit narrower than their solid-angle share: air between neighbouring subtrees */
const CONE_K = 0.85;
/** golden angle: consecutive lattice points turn by it, so any count spreads evenly (Fibonacci lattice) */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** scratch direction (run-local u, v, w; unit) */
const dir = { u: 0, v: 0, w: 0 };

/** Slot i of n on a root's full sphere (Fibonacci lattice, pole = w), turned by `off` round the pole -> dir. */
function sphereSlot(i: number, n: number, off: number) {
  const z = 1 - (2 * (i + 0.5)) / n;
  const rr = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = i * GOLDEN + off;
  dir.u = rr * Math.cos(phi);
  dir.v = rr * Math.sin(phi);
  dir.w = z;
}

/** Slot i of n inside parent p's cone (axis p.du/dv/dw, half-angle `half`): a golden-angle lattice on the cone's
 *  spherical cap (1 child: the axis; 2-3: a small ring), azimuth seeded per parent -> dir. */
function capSlot(p: KitAgent, i: number, n: number, half: number) {
  if (n <= 1) {
    dir.u = p.du;
    dir.v = p.dv;
    dir.w = p.dw;
    return;
  }
  const span = 1 - Math.cos(half);
  const phi0 = (jit(p.id, 41) + 0.5) * TAU;
  const ct = n <= 3 ? 1 - span * 0.3 : 1 - (span * (i + 0.5)) / n;
  const phi = n <= 3 ? phi0 + (i * TAU) / n : phi0 + i * GOLDEN;
  const st = Math.sqrt(Math.max(0, 1 - ct * ct));
  // basis round the axis: e1 = axis x w (or axis x u near the pole), e2 = axis x e1
  let e1u = p.dv, e1v = -p.du, e1w = 0;
  let l = Math.hypot(e1u, e1v);
  if (l < 0.3) (e1u = 0), (e1v = p.dw), (e1w = -p.dv), (l = Math.hypot(e1v, e1w));
  e1u /= l;
  e1v /= l;
  e1w /= l;
  const e2u = p.dv * e1w - p.dw * e1v;
  const e2v = p.dw * e1u - p.du * e1w;
  const e2w = p.du * e1v - p.dv * e1u;
  const c = Math.cos(phi) * st, s = Math.sin(phi) * st;
  dir.u = p.du * ct + e1u * c + e2u * s;
  dir.v = p.dv * ct + e1v * c + e2v * s;
  dir.w = p.dw * ct + e1w * c + e2w * s;
  const m = Math.hypot(dir.u, dir.v, dir.w) || 1;
  dir.u /= m;
  dir.v /= m;
  dir.w /= m;
}

/** half-angle of a cone holding `share` (0..1) of a parent cone of half-angle `half` (equal solid angle split) */
const coneShare = (half: number, share: number) => Math.acos(THREE.MathUtils.clamp(1 - (1 - Math.cos(half)) * share, -1, 1));

/** the periphery columns beside the core are in use (MCP servers / the side graph shown) */
function sidesUsed() {
  if (config.preset.periphery !== "sides") return false;
  if (kit.graphWanted && graphShown()) return true;
  for (const m of kit.mcp.values()) if (m.wanted) return true;
  return false;
}

/** a service's ring shrinks back this long after its tasks / jobs left the outer slots (agent runs never shrink) */
const SVC_SHRINK_MS = 6000;

/** bottom-up: each agent's first shell (rx/ry in the plane, sqrt(rx * ry) out of it) and footprint radius
 *  (unscaled local units) */
function measureRings() {
  const L = config.preset.local;
  const now = performance.now();
  for (const a of kit.agents.values()) (a.kidFoot = 0), (a.kidsHi = 0), (a.tw = 0), (a.kn = 0);
  for (const a of kit.agents.values()) {
    const p = a.depth > 0 && a.inst.parent ? kit.agents.get(a.inst.parent) : undefined;
    if (p) p.kidsHi = Math.max(p.kidsHi, a.sib + 1);
  }
  for (const r of kit.runs.values()) (r.foot = FOOT), (r.tops = 0), (r.svc = 0);
  for (const a of kit.agents.values()) {
    if (a.depth !== 0) continue;
    a.run.tops++;
    a.svcIdx = a.id.startsWith("svc:") ? a.run.svc++ : -1;
    // a long-lived service's tasks / jobs come and go all day: its ring follows what is there (after a while)
    if (a.svcIdx < 0 || a.kidsHi >= a.kidsMax) a.kidsLowAt = 0;
    else if (!a.kidsLowAt) a.kidsLowAt = now;
    else if (now - a.kidsLowAt > SVC_SHRINK_MS) (a.kidsMax = a.kidsHi), (a.kidsLowAt = 0);
  }
  for (let d = 6; d >= 0; d--)
    for (const a of kit.agents.values()) {
      if (a.depth !== d && !(d === 6 && a.depth > 6)) continue;
      a.tw = Math.max(1, a.tw + Math.max(0, a.kidsMax - a.kn)); // leaves below it (children add theirs first)
      const n = a.kidsMax;
      if (!n) {
        a.rx = a.ry = 0;
        a.rings = 0;
        a.foot = FOOT;
      } else {
        const top = a.depth === 0;
        const kid = Math.max(FOOT, a.kidFoot);
        // a root's shell: a neighbour gap per member over the sphere (their subtrees grow outward in their cones, see
        // treeCones); members in front of / behind each other overlap on screen, so a bit more than the bare
        // lattice spacing (sqrt(4 pi / n) rad)
        const cell = Math.max(L.subGap * (top ? CELL_TOP : CELL_SUB), n < RING_BIG ? kid * 2 + 0.6 : 0);
        const r = Math.max(top ? L.fanLen * 1.3 : L.fanLen * 0.85, n > 1 ? (cell * Math.sqrt(n)) / 2.6 : 0);
        if (top && n > 1 && kit.runs.size === 1) {
          // the main group (one run on screen): an ellipse in the free area's shape; a tilted ground plane
          // foreshortens v on screen
          // (a bit wider than the area: labels above / below the members take vertical room; rounder while MCP
          // servers / the side graph take the columns beside the core)
          const asp = THREE.MathUtils.clamp(fit.aspect * (sidesUsed() ? 0.8 : 1.15), 1, 2.4);
          a.rx = r * Math.sqrt(asp);
          a.ry = Math.max(cell * 0.6, r / Math.sqrt(asp)) * (kit.plane === "xz" ? bStretch : 1);
        } else a.rx = a.ry = r;
        a.rings = 1;
        a.cell = cell;
        a.foot = Math.max(a.rx, a.ry) + kid;
      }
      // a subagent's own children live in its root's radial tree (its cone, further out), not round it; a root's
      // footprint covers its outermost tree shell (last frame's, eased positions follow)
      if (a.depth > 0) a.foot = FOOT;
      else if (a.treeR > 0) a.foot = Math.max(a.foot, Math.max(a.rx, a.ry) * a.treeR + FOOT);
      const p = a.inst.parent ? kit.agents.get(a.inst.parent) : undefined;
      if (p && a.depth > 0) (p.tw += a.tw), p.kn++;
      if (p && a.depth > 0) p.kidFoot = Math.max(p.kidFoot, a.foot);
      else if (a.depth === 0) a.run.foot = Math.max(a.run.foot, a.foot);
    }
}

/** run-local u/v angle of "screen down" for a run (its frame rotates on a ring of runs) */
function downAngle(r: KitRun) {
  const ca = Math.cos(r.targetAngle);
  const sa = Math.sin(r.targetAngle);
  let sx = -sa;
  let sy = ca;
  if (sx < -1e-3) (sx = -sx), (sy = -sy);
  return Math.atan2(-sa, -sy);
}
/** directions a root's children keep away from (run-local unit u/v/w + weight) */
const FORBID: number[] = [];
let frameNo = 0;
/**
 * How far a root's sphere lattice turns round its pole (radians, same for every member): the turn whose members
 * stay furthest from the root's own lines: its name label (screen down), the run line its neighbours sit on
 * (top-level agents of a multi-agent run) and its halo label (above, high volume). Searched once per root per frame;
 * ties keep the smaller turn (deterministic).
 */
function sphereOffset(p: KitAgent, cnt: number) {
  if (p.ringAt === frameNo) return p.ringOff;
  p.ringAt = frameNo;
  FORBID.length = 0;
  const d = downAngle(p.run);
  FORBID.push(Math.cos(d), Math.sin(d), 0, 1);
  if (p.run.tops > 1 || p.run.run?.hasSteps) FORBID.push(1, 0, 0, 0.8, -1, 0, 0, 0.8);
  if (p.inst.hv) FORBID.push(-Math.cos(d), -Math.sin(d), 0, 1); // its halo label above the shell
  let best = 0;
  let bestS = -1;
  if (cnt <= 64)
    for (let c = 0; c < 24; c++) {
      const o = (c / 24) * TAU;
      let sc = Infinity;
      for (let k = 0; k < cnt && sc > bestS; k++) {
        sphereSlot(k, cnt, o);
        for (let q = 0; q < FORBID.length; q += 4) {
          const dot = THREE.MathUtils.clamp(dir.u * FORBID[q] + dir.v * FORBID[q + 1] + dir.w * FORBID[q + 2], -1, 1);
          sc = Math.min(sc, Math.acos(dot) / FORBID[q + 3]);
        }
      }
      if (sc > bestS + 1e-3) (bestS = sc), (best = o);
    }
  p.ringOff = best;
  return best;
}

/** out-of-plane radius of a root's first shell (its in-plane ellipse is rx by ry) */
const rzOf = (tr: KitAgent) => Math.sqrt(Math.max(0, tr.rx * tr.ry));

function placeTree(a: KitAgent, tr: KitAgent) {
  const sp = fit.spread;
  a.u = tr.u + a.du * a.rho * tr.rx * sp;
  a.v = tr.v + a.dv * a.rho * tr.ry * sp;
  a.w = tr.w + a.dw * a.rho * rzOf(tr) * sp;
}

function placeLocal(a: KitAgent) {
  const L = config.preset.local;
  const sp = fit.spread;
  const inst = a.inst;
  a.w = 0;
  if (a.depth === 0 && a.svcIdx >= 0 && a.run.svc > 1) {
    // backend services (2+): apart on a ring (2 = left | right), each with its own ring of tasks / jobs, so their
    // halo labels never stack and message comets visibly travel between them
    const n = a.run.svc;
    // (two: a long edge so their message comets visibly travel; beside agent runs the group spreads with them, so it
    // never reads as a tiny cluster next to a big desk ring)
    const chord = Math.max(L.topGap * (n === 2 ? 3 : 2.4), a.run.foot * 2 + L.topGap, (otherRunSpan(a.run) / sp) * 0.62);
    const R = chord / (2 * Math.sin(Math.PI / n));
    // screen angle (x right, y down): 2 = on a slight diagonal (lines from one to the resources at the side never run
    // through the other), the one that drives agent runs / consumes (worker) towards them, the producer (feed) away,
    // towards the resources; 3+ = from the top, clockwise; then into the run's frame (a run on a ring of runs is
    // rotated: screen-down is downAngle there)
    const th = n === 2 ? svcInward(a) + (svcInner(a) ? 0.32 : Math.PI + 0.32) : -Math.PI / 2 + (a.svcIdx * TAU) / n;
    const sx = Math.sqrt(THREE.MathUtils.clamp(fit.aspect, 1, 2));
    const x = Math.cos(th) * R * sx;
    const y = Math.sin(th) * R;
    const phi = downAngle(a.run) - Math.PI / 2;
    a.u = (x * Math.cos(phi) - y * Math.sin(phi)) * sp;
    a.v = (x * Math.sin(phi) + y * Math.cos(phi)) * sp;
    return;
  }
  if (a.depth === 0) {
    // top-level agents of a run on a line (planner | researcher | writer), clear of the biggest one's rings
    const gap = Math.max(L.topGap, a.run.foot + FOOT + 0.8);
    let u = ROLE_SLOT[inst.type] * gap;
    let v = 0;
    if (a.sib) {
      // a second researcher in one run: beside + behind the first, never stacked
      u += (a.sib % 2 ? 1 : -1) * gap * 0.5;
      v -= Math.ceil(a.sib / 2) * Math.max(L.fanLen * 0.55, a.run.foot * 1.8);
    }
    a.u = (u + jit(a.id, 31) * 0.5) * sp;
    a.v = (v + jit(a.id, 32) * 0.4) * sp;
    return;
  }
  const p = inst.parent ? kit.agents.get(inst.parent) : undefined;
  if (!p) return; // parent not drawn (collapsed / gone): keep the last spot
  const n = (a.sibs = Math.max(1, p.kidsMax));
  if (p.depth > 0) {
    // spherical tree, depth >= 2: inside its parent's cone (treeCones), on its depth's shell round the root
    if (p.tr) placeTree(a, p.tr);
    else (a.u = p.u), (a.v = p.v), (a.w = p.w), (a.tr = null); // parent not in a tree yet (picked up next frame)
    return;
  }
  // a root's child: on the root's first shell, the axis of a cone (its share of the sphere) its whole subtree stays in
  if (n === 1 && !p.inst.parent) {
    // a lone subagent of a top-level agent: down-right, tilted towards the viewer (clear of its name below and the
    // run line / label)
    (dir.u = 0.62), (dir.v = 0.62), (dir.w = 0.48);
  } else sphereSlot(a.sib, n, sphereOffset(p, n));
  a.tr = p;
  a.du = dir.u;
  a.dv = dir.v;
  a.dw = dir.w;
  a.ww = 2 * Math.min(CONE_MAX, CONE_K * coneShare(Math.PI, a.tw / Math.max(1, p.tw, n)));
  a.rho = 1;
  p.rhoD[1] = Math.max(p.rhoD[1], 1);
  placeTree(a, p);
}

/**
 * Spherical tree, depth d >= 2 (parents placed): each node's cone = its share of its parent's cone by leaf count
 * (solid angle), its axis a golden-angle lattice slot inside the parent's cone, then the depth's shell radius per
 * root: one step (TREE_STEP) outside the previous shell, and wide enough that the narrowest cone on it still holds a
 * neighbour gap (arc length = radius * opening angle).
 */
function treeCones(d: number) {
  const L = config.preset.local;
  for (const a of kit.agents.values()) {
    if (Math.min(a.depth, TREE_D) !== d) continue;
    const p = a.inst.parent ? kit.agents.get(a.inst.parent) : undefined;
    const tr = p && p.depth > 0 ? p.tr : null;
    a.tr = tr;
    if (!p || !tr) continue;
    const half = p.ww / 2;
    capSlot(p, a.sib, Math.max(1, p.kidsMax), half);
    a.du = dir.u;
    a.dv = dir.v;
    a.dw = dir.w;
    a.ww = 2 * CONE_K * coneShare(half, a.tw / Math.max(1, p.tw));
    const r = Math.max(1e-3, Math.sqrt(tr.rx * tr.ry));
    tr.rhoD[d] = Math.max(tr.rhoD[d], tr.rhoD[d - 1] + (TREE_STEP * L.fanLen) / r, (L.subGap * CELL_SUB) / (r * Math.max(1e-3, a.ww)));
  }
  for (const a of kit.agents.values()) {
    if (Math.min(a.depth, TREE_D) !== d || !a.tr) continue;
    const p = kit.agents.get(a.inst.parent!)!;
    a.rho = Math.max(a.tr.rhoD[d], p.rho + (TREE_STEP * config.preset.local.fanLen) / Math.max(1e-3, Math.sqrt(a.tr.rx * a.tr.ry)));
    a.tr.treeR = Math.max(a.tr.treeR, a.rho);
  }
}

/** widest other (agent) run on screen, stage units (its padded extent) */
function otherRunSpan(r: KitRun) {
  let w = 0;
  for (const o of kit.runs.values()) if (o !== r && o.run?.workflow !== "services" && o.u0 !== Infinity) w = Math.max(w, 2 * Math.max(o.hu, o.hv));
  return w;
}
/** screen angle (x right, y down) from a services run towards the stage centre (the agent runs); left when alone */
function svcInward(a: KitAgent) {
  // (from its slot on the ring of runs, not its target: services beside one agent run sit a bit below the line)
  if (kit.runs.size < 2) return Math.PI;
  const t = a.run.targetAngle;
  return Math.atan2(Math.sin(t), -Math.cos(t));
}
/** of two services, the one on the agent-run side: it drives an agent run or consumes the other's topic */
function svcInner(a: KitAgent) {
  let other: KitAgent | undefined;
  for (const o of kit.agents.values()) if (o !== a && o.run === a.run && o.svcIdx >= 0) other = o;
  if (!other) return a.svcIdx === 1;
  const sc = (id: string) => {
    let v = 0;
    for (const d of world.drives.values()) if (d.svc === id) v += 4;
    for (const t of world.topics.values()) v += t.to === id ? 1 : t.from === id ? -1 : 0;
    return v;
  };
  const sa = sc(a.id), so = sc(other.id);
  return sa !== so ? sa > so : a.svcIdx === 1;
}

function layoutAgents() {
  measureRings();
  // radial trees: fresh shell radii every frame (treeR feeds next frame's footprints)
  for (const a of kit.agents.values()) if (a.depth === 0) a.rhoD.fill(0), (a.treeR = 0);
  // depth order: parents before children (depth is small); tree cones + shell radii per depth before placing it
  for (let d = 0; d <= TREE_D; d++) {
    if (d >= 2) treeCones(d);
    for (const a of kit.agents.values()) if (Math.min(a.depth, TREE_D) === d) placeLocal(a);
    if (d === 1) for (const a of kit.agents.values()) if (a.depth === 0) a.treeR = a.rhoD[1];
  }
  // run footprints (padded) + centroids
  const pad = config.preset.local.pad;
  for (const r of kit.runs.values()) r.u0 = Infinity;
  for (const a of kit.agents.values()) {
    const r = a.run;
    const pd = pad * Math.max(0.7, a.scale);
    if (r.u0 === Infinity) {
      r.u0 = a.u - pd;
      r.u1 = a.u + pd;
      r.v0 = a.v - pd;
      r.v1 = a.v + pd;
    } else {
      r.u0 = Math.min(r.u0, a.u - pd);
      r.u1 = Math.max(r.u1, a.u + pd);
      r.v0 = Math.min(r.v0, a.v - pd);
      r.v1 = Math.max(r.v1, a.v + pd);
    }
  }
  // a service with a ring: room above it for its halo label (HighVolume puts it over the ring), so the run label
  // above the run never sits on it
  for (const a of kit.agents.values())
    if (a.svcIdx >= 0 && a.rings && a.run.u0 !== Infinity) a.run.v0 = Math.min(a.run.v0, a.v - (a.ry * fit.spread + pad * 2.4));
  // Hatchet runs keep room for all three step roles (the run doesn't slide as planner/writer come and go)
  const tg = config.preset.local.topGap * fit.spread;
  for (const r of kit.runs.values()) {
    if (r.run?.hasSteps && r.u0 !== Infinity) {
      r.u0 = Math.min(r.u0, -tg - pad);
      r.u1 = Math.max(r.u1, tg + pad);
    }
  }
  for (const r of kit.runs.values()) {
    if (r.u0 === Infinity) {
      r.hu = r.hv = pad * 1.5;
      r.tcu = r.tcv = 0;
      continue;
    }
    r.tcu = (r.u0 + r.u1) / 2;
    r.tcv = (r.v0 + r.v1) / 2;
    r.hu = (r.u1 - r.u0) / 2;
    r.hv = (r.v1 - r.v0) / 2;
  }
}

// ------------------------------------------------------------------ frames + periphery

function setFrame(angle: number, axis: THREE.Vector3, side: THREE.Vector3) {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  planePoint(ca, sa, axis);
  // side = axis rotated +90deg, flipped so it reads left -> right when possible
  let sx = -sa;
  let sy = ca;
  if (sx < -1e-3) (sx = -sx), (sy = -sy);
  planePoint(sx, sy, side);
}

/** stage target of run-local coords using the run's TARGET frame (for camera framing / extents) */
function targetLocal(r: KitRun, u: number, v: number, w: number, out: THREE.Vector3) {
  setFrame(r.targetAngle, _v, _w);
  return out.copy(r.target).addScaledVector(_w, u - r.tcu).addScaledVector(_v, v - r.tcv).addScaledVector(planeNormal(_x), w);
}

/**
 * Top-level objects (runs, grouped clusters, MCP servers + their backends, the side graph) are placed by the preset
 * in the 2D layout plane, then lifted out of it (along the plane normal) by LIFT x their in-plane distance from the
 * centre, with a golden-angle sign / amount per index: a ring of runs becomes a 3D shell instead of a flat disc.
 * The in-plane (a, b) slot is unchanged, so 3D gaps are never smaller than the preset's 2D gaps (no new overlaps),
 * and the lift only depends on the slot index (stable).
 */
const LIFT = 0.8;
const _n = new THREE.Vector3();
function liftW(i: number, a: number, b: number, salt: number) {
  return Math.hypot(a, b) * LIFT * Math.cos((i + salt) * GOLDEN + 0.9);
}
function lift(out: THREE.Vector3, w: number) {
  return out.addScaledVector(planeNormal(_n), w);
}

const a2 = (p: THREE.Vector3) => p.x;
const b2 = (p: THREE.Vector3) => (kit.plane === "xy" ? p.y : -p.z);

function layoutRuns() {
  const P = config.preset;
  const order = kit.runOrder;
  let hu = 0;
  let hv = 0;
  for (const r of order) {
    hu = Math.max(hu, r.hu);
    hv = Math.max(hv, r.hv);
  }
  ctx.n = order.length;
  // the periphery columns (MCP, side graph) eat horizontal room: the core aims for a narrower shape. Constant on
  // purpose: a graph or server appearing later must not re-arrange the agents. A tilted ground plane ("xz") shows
  // depth foreshortened, so the core aims for a deeper layout (bStretch = 1 / foreshortening, with hysteresis):
  // stacked lanes / rows instead of one flat strip across the screen.
  ctx.aspect = (fit.aspect * (P.periphery === "sides" ? 0.72 : 1)) / (kit.plane === "xz" ? bStretch : 1);
  ctx.hu = hu;
  ctx.hv = hv;
  for (let i = 0; i < order.length; i++) {
    const r = order[i];
    r.index = i;
    r.count = order.length;
    P.run(i, ctx, slot);
    if (order.length === 2 && r.run?.workflow === "services" && Math.abs(slot.a) > 1e-3) {
      // services beside an agent run: a bit below the centre line, so the agents' tethers to the MCP servers (level
      // with the core) pass above the services group instead of through its topic edge and labels
      slot.b -= Math.abs(Math.sin(slot.angle)) * r.hv + Math.abs(Math.cos(slot.angle)) * r.hu + 1.5;
    }
    planePoint(slot.a, slot.b, r.target);
    lift(r.target, liftW(i, slot.a, slot.b, 0));
    r.targetAngle = slot.angle;
  }
}

/**
 * Periphery spacing along b (screen-up) is stretched by 1 / fit.foreshorten so stacked servers/backends keep
 * their on-screen gap on a tilted ground plane; updated with hysteresis so orbiting doesn't keep re-laying out.
 */
let bStretch = 1;

function layoutPeriphery() {
  const P = config.preset;
  const want = Math.min(1.7, 1 / Math.max(0.35, fit.foreshorten));
  if (Math.abs(want - bStretch) / bStretch > 0.1) bStretch = want;
  // core extents over agent + cluster targets (2D, symmetric around the stage centre)
  let hw = 0;
  let hh = 0;
  for (const a of kit.agents.values()) {
    const pd = config.preset.local.pad * Math.max(0.7, a.scale);
    hw = Math.max(hw, Math.abs(a2(a.target)) + pd);
    hh = Math.max(hh, Math.abs(b2(a.target)) + pd);
  }
  for (const r of kit.runs.values())
    if (!r.members) {
      hw = Math.max(hw, Math.abs(a2(r.target)) + r.hu);
      hh = Math.max(hh, Math.abs(b2(r.target)) + r.hv);
    }
  ctx.hw = hw;
  ctx.hh = hh;
  // clusters
  activeLanes.length = 0;
  if (lod.grouped) for (let k = 0; k < LOD_LANES; k++) if (clusterOf(k).active) activeLanes.push(k);
  for (let k = 0; k < activeLanes.length; k++) {
    const lane = activeLanes[k];
    P.cluster(lane, k, activeLanes.length, ctx, pt);
    planePoint(pt.a, pt.b, kit.clusterTarget[lane]);
    lift(kit.clusterTarget[lane], liftW(k, pt.a, pt.b, 3));
    hw = Math.max(hw, Math.abs(pt.a) + 2.4);
    hh = Math.max(hh, Math.abs(pt.b) + 2.4);
  }
  if (P.round) hw = hh = Math.max(hw, hh);
  // hysteresis: the core only resizes on a >8% change (periphery doesn't creep on every spawn)
  const c = kit.core;
  if (Math.abs(hw - c.thw) / Math.max(1, c.thw) > 0.08 || hw < c.thw * 0.75) c.thw = hw;
  if (Math.abs(hh - c.thh) / Math.max(1, c.thh) > 0.08 || hh < c.thh * 0.75) c.thh = hh;
  hw = Math.max(2.5, c.thw);
  hh = Math.max(2.5, c.thh);

  const gap = config.peripheryGap;
  const g = kit.graph;
  const graphOn = kit.graphWanted && graphShown();
  const R = config.graphRadius;
  g.radius = R;
  // ---- MCP servers (+ backends) and the side graph
  const servers = SERVERS;
  servers.length = 0;
  // hidden / fading-out servers keep their last spot and take no room (the rest re-pack around them smoothly)
  for (const m of kit.mcp.values()) if (m.wanted) servers.push(m);
  servers.sort(bySlot);
  if (P.periphery === "rim") {
    const ring = Math.max(hw, hh) + gap;
    if (graphOn) planePoint(-(ring + R), 0, g.target);
    const angles = graphOn ? RIM_WITH_GRAPH : RIM_NO_GRAPH;
    for (let j = 0; j < servers.length; j++) {
      const m = servers[j];
      const extra = Math.floor(j / angles.length);
      const th = angles[j % angles.length] + extra * 0.18;
      const rr = ring + 1 + extra * 2.6;
      planePoint(Math.cos(th), Math.sin(th), m.out);
      planePoint(Math.cos(th) * rr, Math.sin(th) * rr, m.target);
      const nb = m.backends.size;
      let k = 0;
      for (const b of m.backends.values()) {
        b.k = k;
        b.n = nb;
        const rb = rr + 3.2;
        const tb = th + (k - (nb - 1) / 2) * (2.1 / rb);
        planePoint(Math.cos(tb) * rb, Math.sin(tb) * rb, b.target);
        k++;
      }
    }
  } else {
    // columns left / right of the core. With a graph: the graph sits on the left, servers on the right
    // (a long list spills onto the left, above and below the graph). Without: servers alternate sides.
    const wide = fit.aspect >= 0.85;
    if (graphOn) {
      if (wide) planePoint(-(hw + gap + R), 0, g.target);
      else planePoint(0, -(hh + gap + R), g.target);
    }
    LEFT.length = 0;
    RIGHT.length = 0;
    for (let j = 0; j < servers.length; j++) {
      const right = graphOn ? j < Math.max(3, Math.ceil(servers.length * 0.6)) : j % 2 === 0;
      (right ? RIGHT : LEFT).push(servers[j]);
    }
    column(RIGHT, 1, hw + gap, 0);
    column(LEFT, -1, hw + gap, graphOn && wide ? R * 2 + 3.5 : 0);
  }
  // out of the plane (see LIFT): each server with its backends, and the side graph
  for (let j = 0; j < servers.length; j++) {
    const m = servers[j];
    const w = liftW(j, a2(m.target), b2(m.target), 5);
    lift(m.target, w);
    for (const be of m.backends.values()) lift(be.target, w);
  }
  if (graphOn) lift(g.target, liftW(0, a2(g.target), b2(g.target), 8));
  if (graphOn && g.target.lengthSq() > 1e-6) g.out.copy(g.target).normalize();
}
const SERVERS: KitMcp[] = [];
const LEFT: KitMcp[] = [];
const RIGHT: KitMcp[] = [];
const bySlot = (a: KitMcp, b: KitMcp) => a.srv.slot - b.srv.slot;
const D = Math.PI / 180;
const RIM_WITH_GRAPH = [0, 35, -35, 70, -70, 110, -110, 145, -145].map((d) => d * D);
const RIM_NO_GRAPH = [0, 180, 35, -145, -35, 145, 70, -110, -70, 110].map((d) => d * D);

/** Stack servers in a column on side d (+1 right, -1 left), centred; `hole` keeps the middle free (side graph). */
function column(list: KitMcp[], d: number, x0: number, hole: number) {
  if (!list.length) return;
  const fb = bStretch;
  const H = (m: KitMcp) => Math.max(3, m.backends.size * 2.1 + 0.6) * fb;
  const top = hole > 0 ? Math.ceil(list.length / 2) : list.length;
  let b = 0;
  if (hole > 0) {
    b = hole / 2;
    for (let j = 0; j < top; j++) b += H(list[j]);
  } else for (const m of list) b += H(m) / 2;
  for (let j = 0; j < list.length; j++) {
    if (hole > 0 && j === top) b = -hole / 2;
    const m = list[j];
    const h = H(m);
    const cb = b - h / 2;
    planePoint(d, 0, m.out);
    planePoint(d * (x0 + 1), cb, m.target);
    const nb = m.backends.size;
    let k = 0;
    for (const be of m.backends.values()) {
      be.k = k;
      be.n = nb;
      planePoint(d * (x0 + 1 + 3.6), cb + ((nb - 1) / 2 - k) * 2.1 * fb, be.target);
      k++;
    }
    b -= h;
  }
}

// ------------------------------------------------------------------ per frame

/**
 * Once per frame, after world tick() and lodTick() (KitScene's ticker does all three).
 */
export function kitTick(now = performance.now()) {
  const dt = lastNow < 0 ? 0.016 : Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  if (!kit.clusterPos.length)
    for (let k = 0; k < LOD_LANES; k++) {
      kit.clusterPos.push(new THREE.Vector3());
      kit.clusterTarget.push(new THREE.Vector3());
      kit.clusterFresh.push(true);
    }
  syncMembership();
  orderRuns();
  frameNo++;

  // fit: weighted count of what's drawn
  // (exiting agents still count until they have faded out: an exit never zooms in right away)
  let n = 0;
  let alive = 0;
  for (const a of kit.agents.values()) {
    n += a.inst.subagent ? 0.5 : 1;
    if (!a.inst.exitAt) alive++;
  }
  let clusters = 0;
  if (lod.grouped) for (let k = 0; k < LOD_LANES; k++) if (clusterOf(k).active) clusters++;
  let mcp = 0;
  for (const m of kit.mcp.values()) if (m.wanted) mcp++;
  // content signature: any change (spawn, exit, fade-out, grouping, run, resource) restarts FitCamera's batch window
  fitTick(now, n + clusters * 1.5, kit.agents.size + alive * 1e3 + clusters * 1e6 + kit.runs.size * 1e8 + mcp * 1e10 + (kit.graphWanted ? 1e13 : 0));
  for (const a of kit.agents.values()) a.scale = agentScale(a) * fit.scale;

  layoutAgents();
  layoutRuns();
  // agent targets (target frame) for extents + framing
  for (const a of kit.agents.values()) targetLocal(a.run, a.u, a.v, a.w, a.target);
  layoutPeriphery();

  // ---- ease
  const k = ease(dt, 0.2);
  for (const r of kit.runs.values()) {
    if (r.fresh) {
      r.origin.copy(r.target);
      r.angle = r.targetAngle;
      r.cu = r.tcu;
      r.cv = r.tcv;
      r.fresh = false;
    } else {
      r.origin.lerp(r.target, k);
      r.angle = lerpAngle(r.angle, r.targetAngle, k);
      r.cu += (r.tcu - r.cu) * k;
      r.cv += (r.tcv - r.cv) * k;
    }
    setFrame(r.angle, r.axis, r.side);
    planeNormal(r.normal);
  }
  for (const a of kit.agents.values()) {
    if (a.fresh) {
      a.eu = a.u;
      a.ev = a.v;
      a.ew = a.w;
      a.fresh = false;
    } else {
      a.eu += (a.u - a.eu) * k;
      a.ev += (a.v - a.ev) * k;
      a.ew += (a.w - a.ew) * k;
    }
    const r = a.run;
    a.pos.copy(r.origin).addScaledVector(r.side, a.eu - r.cu).addScaledVector(r.axis, a.ev - r.cv).addScaledVector(r.normal, a.ew);
    a.live.copy(a.pos);
    // finished agents dim fully, an idle run's agents part way (server `run idle`), and so does a backend service
    // with no traffic for a while (world.svcIdle); it brightens again on its next request / message
    const dw = isDone(a.inst) ? 1 : isIdle(a.run.run) || (a.depth === 0 && svcIdle(a.inst, now)) ? IDLE_DIM : 0;
    a.dim = reduced ? dw : a.dim + (dw - a.dim) * Math.min(1, dt / DIM_S);
  }
  for (const lane of activeLanes) {
    if (kit.clusterFresh[lane]) kit.clusterPos[lane].copy(kit.clusterTarget[lane]), (kit.clusterFresh[lane] = false);
    else kit.clusterPos[lane].lerp(kit.clusterTarget[lane], k);
  }
  for (let lane = 0; lane < LOD_LANES; lane++) if (!clusterOf(lane).active) kit.clusterFresh[lane] = true;
  const c = kit.core;
  c.hw += (Math.max(2.5, c.thw) - c.hw) * k;
  c.hh += (Math.max(2.5, c.thh) - c.hh) * k;
  c.r = Math.max(c.hw, c.hh);
  const fade = Math.min(1, dt / MCP_FADE_S);
  for (const m of kit.mcp.values()) {
    if (m.fresh) m.pos.copy(m.target), (m.fresh = false);
    else m.pos.lerp(m.target, k);
    m.mix = m.wanted ? Math.min(1, m.mix + fade) : Math.max(0, m.mix - fade);
    for (const b of m.backends.values()) {
      if (b.fresh) b.pos.copy(b.target), (b.fresh = false);
      else b.pos.lerp(b.target, k);
      b.mix = m.wanted ? Math.min(1, b.mix + fade) : Math.min(b.mix, m.mix);
    }
    if (!m.wanted && m.mix <= 0) {
      kit.mcp.delete(m.name);
      kit.mcpVersion++;
    }
  }
  // side graph: fades in where it lives (agents never move for it)
  const g = kit.graph;
  const on = kit.graphWanted && graphShown(now);
  const mix = on ? graphMix(now) : 0;
  g.mix += (mix - g.mix) * (on ? 1 : k);
  if (g.fresh || g.mix < 0.01) g.pos.copy(g.target), (g.fresh = !on);
  else g.pos.lerp(g.target, k);
  g.natural = config.graphNatural;
  g.scale = (g.radius / Math.max(1e-3, g.natural)) * Math.max(0.001, g.mix);
}

/** framing headroom for an agent's labels (css px): a decision label below it, the halo label above */
const LABEL_BELOW_PX = 46;
const LABEL_ABOVE_PX = 18;

/** MCP server / backend fade in / out length (s). */
const MCP_FADE_S = 0.9;

/** Visit every kit-placed thing that must stay in view (camera framing): stage targets + radii. */
export function kitExtents(visit: (p: THREE.Vector3, r: number) => void, agentRadius: number, agentHeight = 0) {
  const up = kit.plane === "xz" && agentHeight > 0;
  for (const a of kit.agents.values()) {
    visit(a.target, agentRadius * a.scale);
    // the camera keeps the largest agent at a sane on-screen size (FitProfile.maxNode); leaving agents don't count
    if (!a.inst.exitAt) fit.nodeR = Math.max(fit.nodeR, agentRadius * a.scale);
    // room for its decision label below and its halo label above (px-sized: world size at the fitted distance)
    const r = agentRadius * a.scale * 1.3;
    // (at the agent's own depth out of the plane: subagent trees are 3D)
    planePoint(a2(a.target), b2(a.target) - r - (LABEL_BELOW_PX * fit.wpp) / fit.foreshorten, _x);
    visit(kit.plane === "xz" ? _x.setY(a.target.y) : _x.setZ(a.target.z), 0);
    planePoint(a2(a.target), b2(a.target) + r + (LABEL_ABOVE_PX * fit.wpp) / fit.foreshorten, _x);
    visit(kit.plane === "xz" ? _x.setY(a.target.y) : _x.setZ(a.target.z), 0);
    // tall agents on a ground plane (towers, trees, machines): their top must stay in view too
    if (up) visit(_x.copy(a.target).setY(a.target.y + agentHeight * a.scale), agentRadius * a.scale * 0.6);
  }
  for (const lane of activeLanes) visit(kit.clusterTarget[lane], 2.4);
  for (const r of kit.runs.values()) {
    if (!r.members) visit(r.target, r.hu);
    // headroom for the run label most themes put just above the run group
    setFrame(r.targetAngle, _v, _w);
    const h = Math.abs(b2(_w)) * r.hu + Math.abs(b2(_v)) * r.hv;
    planePoint(a2(r.target), b2(r.target) + h + 1.4, _x);
    visit(_x, 1.2);
  }
  for (const m of kit.mcp.values()) {
    if (!m.wanted) continue;
    visit(m.target, 1.7);
    for (const b of m.backends.values()) visit(b.target, 1.4);
  }
  const g = kit.graph;
  if (kit.graphWanted && graphShown()) visit(g.target, g.radius + 0.8);
}

/** Lanes with an active cluster ball this frame (grouped mode). */
export const kitActiveLanes = (): readonly number[] => activeLanes;
