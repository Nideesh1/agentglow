/**
 * Scene search: the right panel's "Search agent or run topic…" box drives the 3D scene in every theme (shared kit).
 *
 *   matches   agents (id, name, run topic, graph nodes it touched; services included), runs (topic), MCP servers /
 *             resource groups and their resources (satellites), graph nodes (by name, from the session's sample)
 *   highlight the kit dims everything that does not match (kit/dim.ts via <KitScene>, labels via Label3D), eased by
 *             `search.mix`; matching graph nodes are lit with the themes' own graph flare (a persistent, repeated
 *             flare, `search: true`); runs holding a match are expanded out of their LOD cluster (lod.ts)
 *   focus     Enter / a click on a result / arrow keys: the camera flies there (kit/fit.ts fly) and the Selected /
 *             Resource details panel opens (graph nodes: the camera flies to the side graph); Esc clears the
 *             search and flies the camera back
 *
 * One mutable singleton like `world`; the kit's ticker calls searchTick() every frame (cheap: re-matching runs at
 * most every RECOMPUTE_MS while a query is set). The HUD re-renders through useSearch().
 */
import { useSyncExternalStore } from "react";
import * as THREE from "three";
import { flyHome, flyTo } from "./kit/fit";
import { backendPos, kit, reduced, serverPos } from "./kit/state";
import { collectionNoun, isDismissed, modelGroupPrefix, selectInstance, selectResource, serverLabel, world } from "./world";

export type HitKind = "agent" | "run" | "server" | "backend" | "graph";
export type Hit = { kind: HitKind; id: string; label: string; sub: string; server?: string; resource?: string };

const RECOMPUTE_MS = 400;
const MAX_HITS = 80;
/** graph nodes lit with a search flare at once (the rest still count as matches) */
const MAX_FLARES = 8;
const FLARE_EVERY_MS = 1500;
/** runs with a match kept expanded out of their cluster (lod.ts) */
const MAX_FOCUS_RUNS = 8;
const MIX_S = 0.25;

export const search = {
  q: "",
  needle: "",
  /** matched agent instance ids */
  agents: new Set<string>(),
  /** runs drawn bright: topic matched or one of their agents matched */
  runs: new Set<string>(),
  /** runs expanded out of their LOD cluster for the search (lod.ts reads it) */
  focusRuns: new Set<string>(),
  /** MCP servers drawn bright (name matched, or one of their resources) and those whose own name matched */
  servers: new Set<string>(),
  serverNames: new Set<string>(),
  /** `server|resource` of matched resources */
  backends: new Set<string>(),
  /** matched graph node names */
  graph: new Set<string>(),
  hits: [] as Hit[],
  cursor: -1,
  /** eased 0..1: how much the non-matching things are dimmed right now */
  mix: 0,
  version: 0,
};

// debugging / verification hook (read-only): window.__agentglowSearch
if (typeof window !== "undefined") (window as unknown as { __agentglowSearch?: typeof search }).__agentglowSearch = search;

let galaxyNames: string[] = [];
/** KitScene hands the session's graph sample (node names) to the search. */
export function setSearchGalaxy(names: string[]) {
  galaxyNames = names;
  dirty = true;
}

let dirty = false;
let lastRecompute = -1e9;
let lastFlare = -1e9;
let lastFrame = 0;
let sig = "";
let flareSeq = 1e9;
const subs = new Set<() => void>();
const notify = () => {
  search.version++;
  subs.forEach((f) => f());
};

/** React hook for the HUD: re-renders when the query, the matches or the cursor change. */
export function useSearch() {
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => search.version,
  );
  return search;
}

/** true while a query matches something (the scene is dimmed around the matches) */
export const searching = () => !!search.needle && search.hits.length > 0;

export function setSearch(q: string) {
  if (q === search.q) return;
  const was = search.needle;
  search.q = q;
  search.needle = q.trim().toLowerCase();
  search.cursor = -1;
  if (was && !search.needle) flyHome();
  recompute();
  lastRecompute = performance.now();
  notify();
}

/** Esc: clear the query and the highlight, fly the camera back. */
export function clearSearch() {
  flyHome();
  setSearch("");
}

function recompute() {
  const n = search.needle;
  const { agents, runs, focusRuns, servers, serverNames, backends, graph } = search;
  agents.clear();
  runs.clear();
  focusRuns.clear();
  servers.clear();
  serverNames.clear();
  backends.clear();
  graph.clear();
  const hits: Hit[] = [];
  if (n) {
    const live = [...world.instances.values()].filter((i) => !isDismissed(i.run) && !i.exitAt);
    live.sort((a, b) => Number(!!a.doneAt) - Number(!!b.doneAt) || Number(!!a.parent) - Number(!!b.parent) || b.bornAt - a.bornAt);
    for (const i of live) {
      const topic = world.runs.get(i.run)?.topic ?? "";
      if (!`${i.id} ${i.name} ${topic} ${[...i.nodes].join(" ")}`.toLowerCase().includes(n)) continue;
      agents.add(i.id);
      runs.add(i.run);
      if (hits.length < MAX_HITS) hits.push({ kind: "agent", id: i.id, label: i.name, sub: topic || i.run });
    }
    for (const r of world.runs.values()) {
      if (r.status !== "started" || isDismissed(r.id) || !`${r.topic} ${r.id}`.toLowerCase().includes(n)) continue;
      runs.add(r.id);
      if (hits.length < MAX_HITS) hits.push({ kind: "run", id: r.id, label: r.topic || r.id, sub: "run" });
    }
    for (const s of world.mcpServers.values()) {
      const own = s.name.toLowerCase().includes(n) || (s.kind === "database" && "database".includes(n));
      if (own) {
        serverNames.add(s.name);
        servers.add(s.name);
        if (hits.length < MAX_HITS) hits.push({ kind: "server", id: s.name, label: serverLabel(s.name), sub: s.kind === "model" ? `${modelGroupPrefix(s.name)} group` : s.kind === "database" ? "database" : s.kind === "api" ? "external API" : s.name === "backend" ? "backend" : "MCP server", server: s.name });
      }
      for (const res of s.resources.values()) {
        if (!res.name.toLowerCase().includes(n)) continue;
        backends.add(`${s.name}|${res.name}`);
        servers.add(s.name);
        if (hits.length < MAX_HITS) hits.push({ kind: "backend", id: `${s.name}|${res.name}`, label: res.name, sub: `${s.kind === "database" ? collectionNoun(s.name) : res.sub} · ${serverLabel(s.name)}`, server: s.name, resource: res.name });
      }
    }
    for (const name of galaxyNames) {
      if (!name.toLowerCase().includes(n)) continue;
      graph.add(name);
      if (hits.length < MAX_HITS) hits.push({ kind: "graph", id: name, label: name, sub: "graph node" });
    }
    for (const r of runs) {
      if (focusRuns.size >= MAX_FOCUS_RUNS) break;
      focusRuns.add(r);
    }
  }
  search.hits = hits;
  const next = hits.map((h) => `${h.kind}:${h.id}`).join("\n");
  if (next !== sig) {
    sig = next;
    if (search.cursor >= hits.length) search.cursor = hits.length - 1;
    return true;
  }
  return false;
}

/** Once per frame from the kit ticker: re-match (throttled), ease the dim, keep matching graph nodes lit. */
export function searchTick(now: number) {
  const dt = Math.min(0.1, Math.max(0, (now - (lastFrame || now)) / 1000));
  lastFrame = now;
  if (search.needle && (dirty || now - lastRecompute > RECOMPUTE_MS)) {
    dirty = false;
    lastRecompute = now;
    if (recompute()) notify();
  }
  const goal = searching() ? 1 : 0;
  if (search.mix !== goal) {
    const step = reduced ? 1 : dt / MIX_S;
    search.mix = goal > search.mix ? Math.min(goal, search.mix + step) : Math.max(goal, search.mix - step);
  }
  if (search.graph.size && search.mix > 0.5 && now - lastFlare > FLARE_EVERY_MS) {
    lastFlare = now;
    let k = 0;
    for (const name of search.graph) {
      if (k++ >= MAX_FLARES) break;
      world.flares.push({ id: ++flareSeq, run: "", instance: "", node: name, op: "read", start: now, search: true });
    }
  }
}

// ------------------------------------------------------------------ dim amounts for the kit (0 = bright)
export const agentSearchDim = (id: string) => (search.mix && !search.agents.has(id) ? search.mix : 0);
export const runSearchDim = (id: string) => (search.mix && !search.runs.has(id) ? search.mix : 0);
export const serverSearchDim = (name: string) => (search.mix && !search.servers.has(name) ? search.mix : 0);
export const backendSearchDim = (server: string, res: string) =>
  search.mix && !search.serverNames.has(server) && !search.backends.has(`${server}|${res}`) ? search.mix : 0;
export const graphSearchDim = () => (search.mix && !search.graph.size ? search.mix : 0);
export const clusterSearchDim = () => search.mix;
/** shared overlays that span many agents (decision halos, service links, theme beams): dimmed a bit less */
export const overlaySearchDim = () => search.mix * 0.75;

// ------------------------------------------------------------------ focus (Enter, click, arrow keys)
const _p = new THREE.Vector3();
function firstAgentOf(run: string): string | null {
  let best: string | null = null;
  for (const i of world.instances.values()) if (i.run === run && !i.exitAt && !i.parent) return i.id;
  for (const i of world.instances.values()) if (i.run === run && !i.exitAt) best ??= i.id;
  return best;
}

/** Fly the camera to a hit and open its details (Selected / Resource details). */
export function focusHit(h: Hit) {
  const i = search.hits.findIndex((x) => x.kind === h.kind && x.id === h.id);
  if (i >= 0) search.cursor = i;
  if (h.kind === "agent") {
    selectInstance(h.id);
    flyTo(() => kit.agents.get(h.id)?.live, () => (kit.agents.get(h.id)?.scale ?? 1) * 1.1);
  } else if (h.kind === "run") {
    const a = firstAgentOf(h.id);
    if (a) selectInstance(a);
    flyTo(
      () => kit.runs.get(h.id)?.origin,
      () => {
        const r = kit.runs.get(h.id);
        return r ? Math.max(1.5, Math.hypot(r.hu, r.hv)) : 2;
      },
    );
  } else if (h.kind === "server" && h.server) {
    const s = h.server;
    selectResource({ type: "server", server: s });
    flyTo(() => serverPos(s), () => 1.6);
  } else if (h.kind === "backend" && h.server && h.resource) {
    const s = h.server, r = h.resource;
    selectResource({ type: "backend", server: s, resource: r });
    flyTo(() => backendPos(s, r) ?? serverPos(s), () => 1.2);
  } else if (h.kind === "graph") {
    flyTo(() => (kit.graphWanted ? _p.copy(kit.graph.pos) : undefined), () => Math.max(1.5, kit.graph.radius));
  }
  notify();
}

/** Arrow keys: the next / previous match (wraps), focused like a click. */
export function cycleSearch(d: 1 | -1) {
  const n = search.hits.length;
  if (!n) return;
  const c = search.cursor < 0 ? (d > 0 ? 0 : n - 1) : (search.cursor + d + n) % n;
  focusHit(search.hits[c]);
}

/** Enter: the hit under the cursor, else the first one. */
export function enterSearch() {
  const h = search.hits[Math.max(0, search.cursor)];
  if (h) focusHit(h);
}
