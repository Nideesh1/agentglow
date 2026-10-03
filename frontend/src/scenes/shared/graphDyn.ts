/**
 * Dynamic knowledge-graph nodes (shared by every theme).
 *
 * The side graph draws a SAMPLE of the graph DB (`/live/graph`, the first ~220 FalkorDB nodes; or the simulator's
 * generated sample). In a big graph most nodes an agent touches are not in that sample, so a `graph` event naming
 * them would light nothing. Every touched name that is not in the sample becomes a DYNAMIC node here:
 *   - id `~<lowercased name>`, kind from the event (`kinds[i]`) else "touched"
 *   - linked to the other nodes named in the same event (co-touched) and, as its `anchor`, to the sample node
 *     whose name shares the most words with it (themes bud the new node off that anchor; no anchor = a hashed one)
 *   - positions are derived by each theme from hashes of the id (stable across viewers and refreshes)
 *   - capped at DYN_MAX, least recently touched evicted first (sampled nodes are never evicted)
 * The reducer (world.ts `apply`) feeds touches; useSceneSetup merges the dynamic nodes into the galaxy the themes
 * draw (mergeGalaxy) and re-publishes on change (onGraphDyn). The server replays the touched names on connect
 * (`graph_nodes`), so a refreshed viewer gets them back (restoreGraph).
 */

export type GalaxyNode = {
  id: string;
  name: string;
  kind: string;
  /** a dynamic node (touched by an event, not in the served sample) */
  dyn?: boolean;
  /** dynamic node: id of the sample node it buds off (most similar name), when one shares a word */
  anchor?: string;
};
export type Galaxy = { nodes: GalaxyNode[]; links: { source: string; target: string }[] };

/** max dynamic nodes kept (LRU) */
export const DYN_MAX = 400;
const LINKS_MAX = 12;
const PEERS = 8;

type DynNode = { id: string; name: string; kind: string; kindSet: boolean; anchor?: string; links: Set<string> };

const fnv = (s: string, salt = 0) => {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !/^\d+$/.test(w)));

const sample = {
  nodes: [] as GalaxyNode[],
  /** lowercased name -> sample id */
  byName: new Map<string, string>(),
  /** sample id -> neighbour ids */
  adj: new Map<string, string[]>(),
  words: [] as { id: string; w: Set<string> }[],
};
/** lowercased name -> dynamic node; Map order = LRU (oldest first) */
const dyn = new Map<string, DynNode>();
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version++;
  listeners.forEach((f) => f());
};

/** Subscribe to dynamic-node set changes (added / evicted / relinked). Returns unsubscribe. */
export function onGraphDyn(f: () => void): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}
export const graphDynVersion = () => version;
export const graphDynCount = () => dyn.size;

function anchorFor(name: string): string | undefined {
  const w = words(name);
  if (!w.size) return undefined;
  let best: string | undefined;
  let score = 0;
  for (const s of sample.words) {
    let shared = 0;
    for (const x of w) if (s.w.has(x)) shared++;
    if (!shared) continue;
    const sc = shared / (w.size + s.w.size - shared);
    if (sc > score) (score = sc), (best = s.id);
  }
  return best;
}

/** The served / simulated sample (null or empty: no sample, the event-grown galaxy is drawn instead). */
export function setGraphSample(g: Galaxy | null) {
  sample.nodes = g?.nodes ?? [];
  sample.byName = new Map(sample.nodes.map((n) => [n.name.toLowerCase(), n.id]));
  sample.adj = new Map();
  const ids = new Set(sample.nodes.map((n) => n.id));
  for (const l of g?.links ?? []) {
    if (!ids.has(l.source) || !ids.has(l.target) || l.source === l.target) continue;
    (sample.adj.get(l.source) ?? sample.adj.set(l.source, []).get(l.source)!).push(l.target);
    (sample.adj.get(l.target) ?? sample.adj.set(l.target, []).get(l.target)!).push(l.source);
  }
  sample.words = sample.nodes.map((n) => ({ id: n.id, w: words(n.name) }));
  // names that are in the sample now are not dynamic any more; the rest re-anchor against the new sample
  for (const [k, d] of dyn) {
    if (sample.byName.has(k)) dyn.delete(k);
    else d.anchor = anchorFor(d.name);
  }
  changed();
}

const idOfName = (lower: string): string | undefined => sample.byName.get(lower) ?? dyn.get(lower)?.id;

function upsert(raw: string, kind: string | null | undefined, touch: boolean): { id: string; isNew: boolean } | null {
  const name = String(raw).trim().slice(0, 200);
  if (!name) return null;
  const k = name.toLowerCase();
  const sid = sample.byName.get(k);
  if (sid !== undefined) return { id: sid, isNew: false };
  let d = dyn.get(k);
  let isNew = false;
  if (d) {
    if (touch) {
      dyn.delete(k); // LRU: most recently touched goes last
      dyn.set(k, d);
    }
  } else {
    d = { id: `~${k}`, name, kind: "touched", kindSet: false, anchor: anchorFor(name), links: new Set() };
    dyn.set(k, d);
    isNew = true;
  }
  if (kind && (!d.kindSet || d.kind !== kind)) {
    d.kind = String(kind).slice(0, 40);
    d.kindSet = true;
    isNew = true; // a new color: re-publish
  }
  return { id: d.id, isNew };
}

function link(lowerA: string, idB: string): boolean {
  const d = dyn.get(lowerA);
  if (!d || d.id === idB || d.links.has(idB) || d.links.size >= LINKS_MAX) return false;
  d.links.add(idB);
  return true;
}

function evict(): boolean {
  let any = false;
  while (dyn.size > DYN_MAX) {
    dyn.delete(dyn.keys().next().value as string);
    any = true;
  }
  return any;
}

/**
 * A `graph` event touched these names (kinds: parallel, optional). Names not in the sample become / refresh dynamic
 * nodes linked to their co-touched peers. True when the drawn set changed.
 */
export function touchGraph(names: string[], kinds?: (string | null | undefined)[]): boolean {
  let dirty = false;
  const ids: { k: string; id: string }[] = [];
  names.slice(0, 50).forEach((n, i) => {
    const r = upsert(n, kinds?.[i], true);
    if (!r) return;
    if (r.isNew) dirty = true;
    ids.push({ k: String(n).trim().toLowerCase(), id: r.id });
  });
  const peers = ids.slice(0, PEERS);
  for (const a of peers) for (const b of peers) if (a.id !== b.id && link(a.k, b.id)) dirty = true;
  if (evict()) dirty = true;
  if (dirty) changed();
  return dirty;
}

/** Replayed snapshot (`graph_nodes`, oldest first): rebuild dynamic nodes without flares. */
export function restoreGraph(nodes: { name: string; kind?: string | null; peers?: string[] }[]) {
  for (const n of nodes) {
    const r = upsert(n.name, n.kind, true);
    if (!r) continue;
    const k = String(n.name).trim().toLowerCase();
    for (const p of n.peers ?? []) {
      const pid = idOfName(String(p).trim().toLowerCase());
      if (pid) link(k, pid);
    }
  }
  evict();
  changed();
}

/**
 * Names to light for a `graph` event that names no node: a hashed node of the sample (else of the dynamic nodes)
 * and up to `k - 1` of its neighbours, so the hit is still visible somewhere on the graph.
 */
export function areaNames(seed: string, k = 5): string[] {
  const pool = sample.nodes.length ? sample.nodes : [...dyn.values()];
  if (!pool.length) return [];
  // favour the denser middle of index-ordered layouts: pick among the first half
  const c = pool[fnv(seed, 3) % Math.max(1, Math.ceil(pool.length / 2))];
  const out = [c.name];
  const byId = new Map(pool.map((n) => [n.id, n.name]));
  for (const id of sample.adj.get(c.id) ?? []) {
    if (out.length >= k) break;
    const nm = byId.get(id);
    if (nm && !out.includes(nm)) out.push(nm);
  }
  for (let j = 1; out.length < k && j < pool.length && j <= k * 3; j++) {
    const nm = pool[(fnv(seed, 3 + j) % pool.length)].name;
    if (!out.includes(nm)) out.push(nm);
  }
  return out;
}

/** The sample plus the dynamic nodes (appended, LRU order) and their links (to nodes still present). */
export function mergeGalaxy(base: Galaxy): Galaxy {
  if (!dyn.size) return base;
  const nodes: GalaxyNode[] = [...base.nodes];
  const present = new Set(nodes.map((n) => n.id));
  for (const d of dyn.values()) {
    nodes.push({ id: d.id, name: d.name, kind: d.kind, dyn: true, ...(d.anchor ? { anchor: d.anchor } : {}) });
    present.add(d.id);
  }
  const links = [...base.links];
  for (const d of dyn.values()) {
    for (const t of d.links) if (present.has(t)) links.push({ source: d.id, target: t });
    if (d.anchor && present.has(d.anchor)) links.push({ source: d.id, target: d.anchor });
  }
  return { nodes, links };
}

export function resetGraphDyn() {
  dyn.clear();
  setGraphSample(null);
}

// ------------------------------------------------------------------ theme helpers

/**
 * What a theme draws: the first `maxSample` sampled nodes, then every dynamic node; links among them.
 * `ns` = number of sampled nodes (dynamic nodes are indices ns..n-1).
 */
export function graphView(full: Galaxy, maxSample: number): Galaxy & { ns: number } {
  const sampled: GalaxyNode[] = [];
  const dynamic: GalaxyNode[] = [];
  for (const n of full.nodes) {
    if (n.dyn) dynamic.push(n);
    else if (sampled.length < maxSample) sampled.push(n);
  }
  const nodes = sampled.concat(dynamic);
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, links: full.links.filter((l) => ids.has(l.source) && ids.has(l.target)), ns: sampled.length };
}

/** Deterministic unit direction for an id (uniform on the sphere). */
export function dynDir(id: string, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const u = (fnv(id, 21) % 10007) / 10007;
  const v = (fnv(id, 22) % 10007) / 10007;
  const y = 1 - 2 * u;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const th = v * Math.PI * 2;
  out[0] = Math.cos(th) * r;
  out[1] = y;
  out[2] = Math.sin(th) * r;
  return out;
}

/** Deterministic 0..1 for an id. */
export const dynHash = (id: string, salt = 0) => (fnv(id, 40 + salt) % 10007) / 10007;

/**
 * Place the dynamic nodes (ns..n-1) of a view next to their anchor sample node (or a hashed one), offset by a
 * hashed direction of length `spread * (0.55..1)`. `pos`: xyz per node, sampled ones already laid out.
 */
export function placeDynamic(view: { nodes: GalaxyNode[]; ns: number }, pos: Float32Array, spread: number) {
  const { nodes, ns } = view;
  if (!ns) return;
  const idx = new Map<string, number>();
  for (let i = 0; i < ns; i++) idx.set(nodes[i].id, i);
  const d: [number, number, number] = [0, 0, 0];
  for (let i = ns; i < nodes.length; i++) {
    const nd = nodes[i];
    const a = (nd.anchor !== undefined ? idx.get(nd.anchor) : undefined) ?? fnv(nd.id, 11) % ns;
    dynDir(nd.id, d);
    const r = spread * (0.55 + 0.45 * dynHash(nd.id, 1));
    pos[i * 3] = pos[a * 3] + d[0] * r;
    pos[i * 3 + 1] = pos[a * 3 + 1] + d[1] * r;
    pos[i * 3 + 2] = pos[a * 3 + 2] + d[2] * r;
  }
}
