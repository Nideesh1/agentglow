/**
 * Level of detail for crowded scenes: automatic grouping of runs into per-lane clusters.
 *
 * Small worlds (≤ ~10 alive agents) are untouched: every agent renders with its label at full size.
 * Once the world gets crowded (hysteresis: group at > GROUP_ON alive agents, ungroup at < GROUP_OFF) we keep
 * a few "focus" runs fully expanded and fold every other run of the same LANE (run.slot % LOD_LANES) into
 * one cluster per lane:
 *   - focus runs = the selected agent's run and runs holding a scene-search match (search.ts), runs of a lane the
 *     user clicked (expandLane), then the most
 *     recently started runs, until ~BUDGET expanded agents. Expanded runs stay expanded for ≥ DWELL_MS so
 *     the view doesn't churn while new runs keep arriving.
 *   - labels only for the ~LABEL_K busiest expanded agents + the selected one (`showLabel`)
 *   - finished agents stay dimmed until their run ends and weigh DONE_WEIGHT in the budget; they fade shorter
 *     while crowded (world `linger` hook)
 *
 * Everything is computed ONCE per frame in `lodTick(now)` (the scene kit's ticker calls it right after `tick()`),
 * membership at most every ~250ms; helpers below are O(1) lookups and allocate nothing. The scene kit
 * (kit/layout.ts) turns membership into drawn agents/runs and places one cluster ball per active lane; the HUD
 * shows the "grouped: N runs in K clusters · show all" chip (Hud.tsx).
 */
import { useSyncExternalStore } from "react";
import { search } from "./search";
import { RUN_COLORS, energy, hash01, isDismissed, isLive, linger, world, type AgentType, type Instance, FADE_MS } from "./world";

/** Number of visual lanes runs are grouped by (most themes lay runs out by slot % 6). */
export const LOD_LANES = 6;
/** Group when alive agents exceed GROUP_ON; ungroup when they drop below GROUP_OFF. */
export const GROUP_ON = 12;
export const GROUP_OFF = 9;
/** Expanded-agent budget while grouped (a clicked lane gets a bit more room). */
export const BUDGET = 10;
export const LANE_BUDGET = 12;
/** Labels shown for the busiest K expanded agents (+ the selected one). */
export const LABEL_K = 6;
const DWELL_MS = 8000;
const RECOMPUTE_MS = 250;
/** Exit fade while crowded: expanded agents fade quicker, collapsed ones vanish almost at once. */
const CROWD_FADE_MS = 1500;
const COLLAPSED_FADE_MS = 300;

const AGENT_TYPES: AgentType[] = ["planner", "researcher", "graph_scout", "records_scout", "data_scout", "writer"];

export type LodCluster = {
  lane: number;
  /** true while this lane has collapsed runs (render a ClusterBall only when active) */
  active: boolean;
  runs: number;
  agents: number;
  thinking: number;
  tokens: number;
  /** smoothed recent activity 0..1 (LLM/tool pulses of the collapsed agents) */
  energy: number;
  /** lane color (RUN_COLORS[lane]) */
  color: string;
  /** alive agents by role, for coloring the swarm */
  types: Record<AgentType, number>;
  /** bumps when agents/runs/thinking/types change (cheap change detection for DOM + swarm colors) */
  version: number;
  /** collapsed run ids (newest first); valid until the next membership recompute */
  runIds: string[];
};

const mkCluster = (lane: number): LodCluster => ({
  lane,
  active: false,
  runs: 0,
  agents: 0,
  thinking: 0,
  tokens: 0,
  energy: 0,
  color: RUN_COLORS[lane % RUN_COLORS.length],
  types: { planner: 0, researcher: 0, graph_scout: 0, records_scout: 0, data_scout: 0, writer: 0 },
  version: 0,
  runIds: [],
});

/** Shared LOD state (read-only for scenes; mutate via the functions below). */
export const lod = {
  /** grouping in effect (crowded and not "show all") */
  grouped: false,
  /** crowded per hysteresis, regardless of "show all" (HUD offers "group" again) */
  crowded: false,
  /** user asked to see everything */
  showAll: false,
  /** lane the user expanded by clicking its cluster (-1 = none) */
  expandedLane: -1,
  /** bumps whenever which instances/runs are expanded or labeled changes (re-filter your lists) */
  version: 0,
  alive: 0,
  expandedAgents: 0,
  expandedRuns: 0,
  collapsedRuns: 0,
  activeClusters: 0,
  clusters: Array.from({ length: LOD_LANES }, (_, k) => mkCluster(k)) as LodCluster[],
};

// ------------------------------------------------------------------ internal state (reused, no per-frame allocs)
const expRuns = new Set<string>();
const expSince = new Map<string, number>();
const labelSet = new Set<string>();
const runCount = new Map<string, number>(); // instances present per run, weighted (finished = DONE_WEIGHT)
/** a finished (dimmed, waiting for its run to end) agent counts this much toward the expanded-agent budget */
const DONE_WEIGHT = 0.25;
const runAlive = new Map<string, number>();
const runOrder: string[] = [];
const prio = new Map<string, number>();
const started = new Map<string, number>();
const scored: Instance[] = [];
const laneTaken = new Uint16Array(LOD_LANES);
const score = new Map<string, number>();
let lastRecompute = -1e9;
let lastFrame = -1;
let dirty = true;
let lastSelected: string | null = null;
let lastSearch = 0;
let lastSize = -1;

const subs = new Set<() => void>();
let uiVersion = 0;
const notify = () => {
  uiVersion++;
  subs.forEach((f) => f());
};

/** Lane index (0..LOD_LANES-1) of a run slot. */
export const laneOfSlot = (slot: number) => ((slot % LOD_LANES) + LOD_LANES) % LOD_LANES;
/** Lane of a run id (its slot; runs we never saw start - e.g. a late-joining viewer - hash to a lane). */
export function laneOfRun(runId: string) {
  const r = world.runs.get(runId);
  return r ? laneOfSlot(r.slot) : Math.floor(hash01(runId, 77) * LOD_LANES) % LOD_LANES;
}
/** Lane of an instance (see laneOfRun). */
export const laneOfInstance = (i: Instance) => laneOfRun(i.run);

// ------------------------------------------------------------------ queries (O(1), safe to call per frame)

/** Should this instance be drawn individually? (always true when not grouped) */
export function isExpanded(i: Instance | string): boolean {
  const inst = typeof i === "string" ? world.instances.get(i) : i;
  if (inst && isDismissed(inst.run)) return false; // hidden by this viewer ("×"): drawn neither alone nor clustered
  if (!lod.grouped) return true;
  if (!inst) return false;
  return expRuns.has(inst.run);
}
/** Should this run's own visuals (label, aura, lane line…) be drawn? */
export function isRunExpanded(runId: string): boolean {
  if (isDismissed(runId)) return false;
  return !lod.grouped || expRuns.has(runId);
}
/** Show this agent's label? (all when not grouped; else top-K busiest expanded + selected) */
export function showLabel(instId: string): boolean {
  if (!lod.grouped) return true;
  return instId === world.selected || labelSet.has(instId);
}
/** The cluster for a lane (always exists; check `.active`). */
export const clusterOf = (lane: number) => lod.clusters[laneOfSlot(lane)];

// ------------------------------------------------------------------ actions (HUD / ClusterBall)

/** Expand a lane's runs (others collapse to fit the budget). */
export function expandLane(lane: number) {
  lod.expandedLane = laneOfSlot(lane);
  lod.showAll = false;
  // a clicked lane wins over earlier sticky choices
  expSince.clear();
  dirty = true;
  notify();
}
/** Back to automatic focus (collapses a clicked lane). */
export function collapseLanes() {
  lod.expandedLane = -1;
  expSince.clear();
  dirty = true;
  notify();
}
/** Show every agent individually (true) or return to automatic grouping (false). */
export function setShowAll(v: boolean) {
  lod.showAll = v;
  if (v) lod.expandedLane = -1;
  dirty = true;
  notify();
}

/** React hook for DOM (HUD, cluster lists): re-renders when grouping state changes. */
export function useLod() {
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => uiVersion,
  );
  return lod;
}

// ------------------------------------------------------------------ per-frame update

const byPrio = (a: string, b: string) => (prio.get(a)! - prio.get(b)!) || (started.get(b)! - started.get(a)!);

function recompute(now: number) {
  // ---- per-run instance counts + alive total
  runCount.clear();
  runAlive.clear();
  let alive = 0;
  for (const i of world.instances.values()) {
    if (isDismissed(i.run)) continue;
    // budget weight: finished (dimmed) agents still belong to their run's view but cost little room
    runCount.set(i.run, (runCount.get(i.run) ?? 0) + (i.doneAt && !i.exitAt ? DONE_WEIGHT : 1));
    if (isLive(i)) {
      alive++;
      runAlive.set(i.run, (runAlive.get(i.run) ?? 0) + 1);
    }
  }
  lod.alive = alive;
  const wasCrowded = lod.crowded;
  if (!lod.crowded && alive > GROUP_ON) lod.crowded = true;
  else if (lod.crowded && alive < GROUP_OFF) lod.crowded = false;
  if (!lod.crowded && wasCrowded) {
    lod.showAll = false;
    lod.expandedLane = -1;
  }
  const grouped = lod.crowded && !lod.showAll;
  let changed = grouped !== lod.grouped;
  lod.grouped = grouped;

  if (!grouped) {
    if (expRuns.size || labelSet.size) changed = true;
    expRuns.clear();
    expSince.clear();
    labelSet.clear();
    lod.expandedAgents = alive;
    lod.expandedRuns = world.runs.size;
    lod.collapsedRuns = 0;
    lod.activeClusters = 0;
    for (const c of lod.clusters) if (c.active) (c.active = false), (c.runIds.length = 0), c.version++;
    if (changed) lod.version++;
    if (changed || wasCrowded !== lod.crowded) notify();
    return;
  }

  // ---- choose focus runs
  const selInst = world.selected ? world.instances.get(world.selected) : undefined;
  const selRun = selInst?.run ?? null;
  runOrder.length = 0;
  prio.clear();
  started.clear();
  for (const [id, n] of runCount) {
    if (n <= 0) continue;
    const r = world.runs.get(id);
    const lane = laneOfRun(id);
    const sticky = expRuns.has(id) && now - (expSince.get(id) ?? 0) < DWELL_MS;
    // a run holding a scene-search match is expanded like the selected one (search.ts)
    const p = id === selRun || search.focusRuns.has(id) ? 0 : lod.expandedLane === lane ? 1 : sticky ? 2 : (runAlive.get(id) ?? 0) > 0 ? 3 : 4;
    prio.set(id, p);
    started.set(id, r?.startedAt ?? 0);
    runOrder.push(id);
  }
  runOrder.sort(byPrio);
  const budget = lod.expandedLane >= 0 ? LANE_BUDGET : BUDGET;
  let used = 0;
  let nExp = 0;
  // membership diff without allocating: mark kept runs in `prio` as -1.
  // pass 1: selected + clicked lane, then at most one auto-picked run per lane (spread focus across lanes);
  // pass 2: fill what's left of the budget.
  laneTaken.fill(0);
  // the backend services run (long-lived, a few service agents + their tasks / jobs) always stays expanded and
  // costs no budget: the agent runs next to it are grouped as if it weren't there
  for (const id of runOrder)
    if (world.runs.get(id)?.workflow === "services") {
      prio.set(id, -1);
      nExp++;
      laneTaken[laneOfRun(id)]++;
    }
  for (let pass = 0; pass < 2; pass++)
    for (const id of runOrder) {
      const p = prio.get(id)!;
      if (p === -1) continue;
      const lane = laneOfRun(id);
      if (pass === 0 && p >= 2 && laneTaken[lane]) continue;
      const n = runCount.get(id)!;
      if (p === 0 || used === 0 || used + n <= budget) {
        used += n;
        nExp++;
        laneTaken[lane]++;
        prio.set(id, -1);
      }
    }
  for (const id of expRuns)
    if (prio.get(id) !== -1) {
      expRuns.delete(id);
      expSince.delete(id);
      changed = true;
    }
  for (const id of runOrder)
    if (prio.get(id) === -1 && !expRuns.has(id)) {
      expRuns.add(id);
      expSince.set(id, now);
      changed = true;
    }
  lod.expandedRuns = nExp;

  // ---- collapsed runs per lane
  let collapsed = 0;
  for (const c of lod.clusters) c.runIds.length = 0;
  for (const id of runOrder) {
    if (expRuns.has(id)) continue;
    lod.clusters[laneOfRun(id)].runIds.push(id);
    collapsed++;
  }
  lod.collapsedRuns = collapsed;

  // ---- labels: busiest expanded agents (current holders get a small bonus → no flicker)
  scored.length = 0;
  score.clear();
  for (const i of world.instances.values()) {
    if (!isLive(i) || !expRuns.has(i.run)) continue;
    const s = energy(i, now) + (i.status === "thinking" ? 0.6 : 0) + (labelSet.has(i.id) ? 0.4 : 0) + (now - i.bornAt < 3000 ? 1 : 0) + (i.subagent ? 0 : 0.2);
    score.set(i.id, s);
    scored.push(i);
  }
  scored.sort((a, b) => score.get(b.id)! - score.get(a.id)!);
  const k = Math.min(LABEL_K, scored.length);
  let labelsChanged = labelSet.size !== k;
  if (!labelsChanged) for (let j = 0; j < k; j++) if (!labelSet.has(scored[j].id)) labelsChanged = true;
  if (labelsChanged) {
    labelSet.clear();
    for (let j = 0; j < k; j++) labelSet.add(scored[j].id);
    changed = true;
  }
  scored.length = 0;

  if (changed) {
    lod.version++;
    notify();
  }
}

/** Per-frame cluster stats (agents, thinking, tokens, energy) - one pass over instances, no allocations. */
function stats() {
  const now = performance.now();
  const cl = lod.clusters;
  const prev = PREV;
  for (let k = 0; k < LOD_LANES; k++) {
    const c = cl[k];
    prev[k * 3] = c.agents;
    prev[k * 3 + 1] = c.thinking;
    prev[k * 3 + 2] = c.runs;
    c.agents = c.thinking = c.tokens = 0;
    for (const t of AGENT_TYPES) c.types[t] = 0;
    E[k] = 0;
  }
  let expAgents = 0;
  for (const i of world.instances.values()) {
    if (isDismissed(i.run)) continue;
    if (expRuns.has(i.run)) {
      if (isLive(i)) expAgents++;
      continue;
    }
    if (!isLive(i)) continue;
    const c = cl[laneOfInstance(i)];
    c.agents++;
    c.tokens += i.tokens;
    c.types[i.type]++;
    if (i.status === "thinking") c.thinking++;
    E[c.lane] += energy(i, now);
  }
  lod.expandedAgents = expAgents;
  let active = 0;
  for (let k = 0; k < LOD_LANES; k++) {
    const c = cl[k];
    c.runs = c.runIds.length;
    const act = c.runs > 0;
    if (act) active++;
    const target = c.agents ? Math.min(1, (E[k] / c.agents) * 0.9 + (c.thinking / c.agents) * 0.35) : 0;
    c.energy += (target - c.energy) * 0.08;
    if (act !== c.active || prev[k * 3] !== c.agents || prev[k * 3 + 1] !== c.thinking || prev[k * 3 + 2] !== c.runs) c.version++;
    c.active = act;
  }
  if (active !== lod.activeClusters) {
    lod.activeClusters = active;
    notify();
  }
}
const PREV = new Float64Array(LOD_LANES * 3);
const E = new Float64Array(LOD_LANES);

/**
 * Update LOD once per frame (idempotent within a frame). Call right after world `tick()` in the scene Ticker.
 * Membership is recomputed at most every 250ms, or immediately on selection / user action / world size change.
 */
export function lodTick(now = performance.now()) {
  if (now === lastFrame) return;
  lastFrame = now;
  if (world.selected !== lastSelected) {
    lastSelected = world.selected;
    dirty = true;
  }
  if (search.version !== lastSearch) {
    lastSearch = search.version;
    dirty = true;
  }
  const size = world.instances.size;
  // cheap world-size check catches spawns/removals between throttled recomputes (only near the threshold matters)
  if (size !== lastSize && (!lod.grouped || size < GROUP_ON + 4)) dirty = true;
  lastSize = size;
  if (dirty || now - lastRecompute > RECOMPUTE_MS) {
    dirty = false;
    lastRecompute = now;
    recompute(now);
  }
  if (lod.grouped) stats();
}

// exited agents linger shorter when crowded (world.tick / presence() read this hook)
linger.fadeMs = (i: Instance) => (!lod.crowded ? FADE_MS : expRuns.has(i.run) || !lod.grouped ? CROWD_FADE_MS : COLLAPSED_FADE_MS);
