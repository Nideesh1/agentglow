/**
 * Screen-space label decluttering. Every <Label3D> registers here automatically; inside a <KitScene> a pass
 * runs ~10x per second:
 *   frame N    labelTick() raises `due`; each visible label projects its plate into css px (full rect and
 *              main-line-only rect) during its own useFrame.
 *   frame N+1  labelTick() sorts the visible labels by priority and greedily places them: a label that overlaps
 *              an already placed one first drops its secondary line, then hides (fades out). Hidden labels keep
 *              projecting, so they come back as soon as there is room.
 * Priority: decision labels (short-lived, placed first so neighbours yield; the newest wins among them) > selected agent > busiest top-level agents > skill chips > run labels > MCP servers > resource captions (the graph's
 * name) > cluster badges > backends / graph node names > theme extras > subagent names. The kind comes from the slot a label is rendered in
 * (<KitScene> wraps each slot in a LabelScope); a label can override it with its `declutter` prop.
 * No per-frame allocations: entries are created once per label, the pass reuses scratch arrays.
 */
import { createContext } from "react";
import { energy, world } from "../world";
import type { KitAgent } from "./state";

export type LabelKind = "decision" | "agent" | "skill" | "run" | "mcp" | "resource" | "cluster" | "backend" | "graph" | "extra" | "sub";

const KIND_PRIO: Record<LabelKind, number> = { decision: 20000, agent: 600, skill: 450, run: 400, mcp: 300, resource: 290, cluster: 250, backend: 150, graph: 140, extra: 120, sub: 100 };

/** Which slot a label is rendered in (set by <KitScene>); `agent` lets the pass rank agent labels by activity. */
/** `dim`: scene-search dim of the slot (search.ts), 0..1 this frame; agent labels use the agent's own */
export type LabelScopeValue = { kind: LabelKind; agent?: KitAgent; dim?: () => number };
export const LabelScope = createContext<LabelScopeValue>({ kind: "extra" });

export type LabelEntry = {
  kind: LabelKind;
  agent: KitAgent | undefined;
  /** world font size (tie-break: bigger labels win among equals) */
  size: number;
  /** written by the label when `labels.due`: visible on screen this pass / cut by the canvas edge */
  live: boolean;
  clip: boolean;
  /** full plate rect (css px, centre + size) and the main-line-only rect (w1 = 0: no secondary line) */
  x: number;
  y: number;
  w: number;
  h: number;
  x1: number;
  y1: number;
  w1: number;
  h1: number;
  /** world anchor + full plate rect relative to the anchor's projection (css px, y down) for camera framing,
   *  and when it was last projected while visible (performance.now) */
  ax: number;
  ay: number;
  az: number;
  ox0: number;
  ox1: number;
  oy0: number;
  oy1: number;
  seen: number;
  /** drawn this frame with a visible alpha (debug / verification) */
  drawn: boolean;
  /** written by the pass: target visibility and whether to drop the secondary line */
  show: number;
  subOff: boolean;
  /** last pass result (hysteresis) */
  placed: boolean;
  score: number;
  /** performance.now() when the label last appeared (decision labels: the newest wins) */
  born: number;
};

export const labels = {
  entries: [] as LabelEntry[],
  /** a KitScene is mounted (outside one, nothing is ever hidden) */
  active: 0,
  /** labels project their rects this frame */
  due: false,
  /** px-range multiplier: labels shrink a bit on small canvases */
  pxk: 1,
  last: -1e9,
  /** last pass stats (debug / verification) */
  stats: { shown: 0, hidden: 0, dropped: 0, off: 0 },
  /** measured on-screen size of the largest cluster badge (css px; 0 = none seen yet): presets space clusters by it */
  badge: { w: 0, h: 0 },
};

export function newLabelEntry(kind: LabelKind, agent: KitAgent | undefined, size: number): LabelEntry {
  return { kind, agent, size, live: false, clip: false, x: 0, y: 0, w: 0, h: 0, x1: 0, y1: 0, w1: 0, h1: 0, ax: 0, ay: 0, az: 0, ox0: 0, ox1: 0, oy0: 0, oy1: 0, seen: -1e9, drawn: false, show: labels.active ? 0 : 1, subOff: false, placed: false, score: 0, born: 0 };
}
export function registerLabel(e: LabelEntry) {
  labels.entries.push(e);
}
export function unregisterLabel(e: LabelEntry) {
  const a = labels.entries;
  const i = a.indexOf(e);
  if (i < 0) return;
  a[i] = a[a.length - 1];
  a.pop();
}

const PASS_MS = 100;
/** minor kinds that hide when the canvas edge cuts them (the framed / important ones stay) */
const CLIP_HIDES: Record<LabelKind, boolean> = { decision: false, agent: false, skill: true, run: false, mcp: false, resource: false, cluster: false, backend: true, graph: true, extra: true, sub: true };
const PAD = 3;
const order: LabelEntry[] = [];
let rects = new Float64Array(256 * 4);
const byScore = (a: LabelEntry, b: LabelEntry) => b.score - a.score;

function scoreOf(e: LabelEntry, now: number) {
  // decision labels (short-lived) go first so neighbours yield to them; among them the newest wins
  if (e.kind === "decision") return KIND_PRIO.decision + Math.min(5000, Math.max(0, 5000 - (now - e.born) / 10));
  let s = KIND_PRIO[e.kind];
  const a = e.agent;
  if (a && (e.kind === "agent" || e.kind === "sub")) {
    const inst = a.inst;
    if (world.selected === a.id) return 10000;
    const busy = Math.min(1, energy(inst, now)) * 60 + (inst.status === "thinking" ? 30 : 0);
    s = a.depth > 0 ? KIND_PRIO.sub + busy * 0.5 : KIND_PRIO.agent + busy;
    if (inst.exitAt || inst.doneAt) s -= a.depth > 0 ? 60 : 350; // finished / fading agents yield to working ones
  } else if (a && e.kind === "skill") {
    // an agent's skill chip: transient and important, so above run labels; its own (selected) agent's name wins
    if (world.selected === a.id) return 9990;
    s += Math.min(1, energy(a.inst, now)) * 30 + (a.depth > 0 ? 0 : 20);
    if (a.inst.exitAt || a.inst.doneAt) s -= 300;
  }
  return s + e.size * 10 + (e.placed ? 8 : 0);
}

function free(x: number, y: number, w: number, h: number, n: number) {
  const x0 = x - w / 2 - PAD, x1 = x + w / 2 + PAD, y0 = y - h / 2 - PAD, y1 = y + h / 2 + PAD;
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    if (x0 < rects[k + 2] && x1 > rects[k] && y0 < rects[k + 3] && y1 > rects[k + 1]) return false;
  }
  return true;
}
function put(x: number, y: number, w: number, h: number, n: number) {
  if ((n + 1) * 4 > rects.length) {
    const r = new Float64Array(rects.length * 2);
    r.set(rects);
    rects = r;
  }
  const k = n * 4;
  rects[k] = x - w / 2;
  rects[k + 1] = y - h / 2;
  rects[k + 2] = x + w / 2;
  rects[k + 3] = y + h / 2;
}

function pass(now: number) {
  order.length = 0;
  for (const e of labels.entries) {
    if (e.live) (e.score = scoreOf(e, now)), order.push(e);
    else e.placed = false;
  }
  order.sort(byScore);
  let n = 0;
  let hidden = 0;
  let dropped = 0;
  for (const e of order) {
    if (e.clip && CLIP_HIDES[e.kind]) {
      // a minor label cut by the canvas edge reads as clutter: hide it
      e.show = 0;
      e.placed = false;
      hidden++;
    } else if (free(e.x, e.y, e.w, e.h, n)) {
      put(e.x, e.y, e.w, e.h, n++);
      e.show = 1;
      e.subOff = false;
      e.placed = true;
    } else if (e.w1 > 0 && free(e.x1, e.y1, e.w1, e.h1, n)) {
      put(e.x1, e.y1, e.w1, e.h1, n++);
      e.show = 1;
      e.subOff = true;
      e.placed = true;
      dropped++;
    } else {
      e.show = 0;
      e.placed = false;
      hidden++;
    }
  }
  // largest cluster badge on screen (eased so a changing count doesn't jiggle the spacing)
  let bw = 0;
  let bh = 0;
  for (const e of order) if (e.kind === "cluster") (bw = Math.max(bw, e.w)), (bh = Math.max(bh, e.h));
  const B = labels.badge;
  if (bw > 0) {
    if (!B.w || Math.abs(bw - B.w) / B.w > 0.12) B.w = bw;
    if (!B.h || Math.abs(bh - B.h) / B.h > 0.12) B.h = bh;
  }
  const st = labels.stats;
  st.shown = n;
  st.hidden = hidden;
  st.dropped = dropped;
  st.off = labels.entries.length - order.length;
  order.length = 0;
}

/** Once per frame from KitScene's ticker (before any label's useFrame). */
export function labelTick(now: number, w: number, h: number) {
  labels.pxk = Math.min(1, Math.max(0.78, Math.sqrt(Math.min(w / 1280, h / 760))));
  if (labels.due) {
    labels.due = false;
    pass(now);
    for (const e of labels.entries) e.live = false;
  } else if (now - labels.last >= PASS_MS) {
    labels.last = now;
    labels.due = true;
  }
}

/** label kinds the camera framing keeps on screen (agent names hug their agents; graph-node names come and go) */
const FRAMED: Record<LabelKind, boolean> = { decision: false, agent: false, skill: false, sub: false, run: true, mcp: true, resource: true, backend: true, cluster: true, graph: false, extra: false };

/**
 * Visit the world anchors of recently visible framed labels with their plate rect around the anchor in css px
 * (FitCamera converts px to view angles: a px-clamped label keeps its screen size at any camera distance).
 */
export function visitLabelRects(now: number, visit: (e: LabelEntry) => void) {
  // only labels the declutter pass lets through: a hidden label needs no room
  for (const e of labels.entries) if (FRAMED[e.kind] && now - e.seen < 600 && (e.show > 0 || !labels.active)) visit(e);
}

/** Overlapping pairs among the labels drawn right now (verification; allocates, call rarely). */
function overlaps() {
  const vis = labels.entries.filter((e) => e.drawn && performance.now() - e.seen < 300);
  let k = 0;
  for (let i = 0; i < vis.length; i++)
    for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i], b = vis[j];
      const aw = a.subOff ? a.w1 : a.w, ah = a.subOff ? a.h1 : a.h, ax = a.subOff ? a.x1 : a.x, ay = a.subOff ? a.y1 : a.y;
      const bw = b.subOff ? b.w1 : b.w, bh = b.subOff ? b.h1 : b.h, bx = b.subOff ? b.x1 : b.x, by = b.subOff ? b.y1 : b.y;
      if (Math.abs(ax - bx) * 2 < aw + bw && Math.abs(ay - by) * 2 < ah + bh) k++;
    }
  return k;
}

// debugging / verification hook (read-only): window.__agentglowLabels.snapshot()
if (typeof window !== "undefined")
  (window as unknown as { __agentglowLabels?: unknown }).__agentglowLabels = {
    labels,
    snapshot: () => ({ ...labels.stats, total: labels.entries.length, overlaps: overlaps() }),
  };
