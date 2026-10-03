/**
 * Resource details (docs/SPEC.md "Resource details"): UI-side aggregation of the `mcp` call / result events the server
 * already sends, per MCP server / resource group, per resource (backend / satellite) and per link (agent or service ->
 * server). Feeds the Selected panel (ResourcePanel.tsx) and the kit's click targets (kit/Picks.tsx). No new server
 * events: everything here is counted from `mcp` (+ `resource_stats` / `backlog` read directly from the world).
 * Only labels the server already scrubbed are kept: tool / operation names (verbs), resource names (hosts, systems),
 * status codes, latencies. Never arguments, statements, URLs or bodies.
 */
import type { ResourceKind } from "./world";

export type ToolAgg = { calls: number; errors: number; lat: number[] };
export type CallRec = { who: string; tool: string; resource?: string; ms?: number; ok: boolean; status?: number; at: number };
export type Agg = {
  calls: number;
  errors: number;
  /** recent latencies (ms), newest last, capped */
  lat: number[];
  first: number;
  /** performance.now() of the last call / result */
  last: number;
  lastMs?: number;
  /** calls per second, last SPARK_N seconds (index = second % SPARK_N), and the second it was last rolled to */
  spark: number[];
  sparkSec: number;
  tools: Map<string, ToolAgg>;
  /** caller instance id -> calls */
  callers: Map<string, number>;
  /** status class (2xx / 4xx / 5xx) -> results */
  statuses: Map<string, number>;
  /** resources seen on a server / link: name -> calls */
  resources: Map<string, number>;
  recent: CallRec[];
  units: number;
  unit?: string;
  device?: string;
  kind?: ResourceKind;
};

export const SPARK_N = 60;
const LAT_MAX = 200;
const RECENT_MAX = 25;
const MAX_ENTRIES = 512;

/** What the Selected panel shows: an MCP server / resource group, one of its resources, or an agent -> server link. */
export type ResSel = { type: "server"; server: string } | { type: "backend"; server: string; resource: string } | { type: "link"; id: string; server: string };

export const resInfo = {
  servers: new Map<string, Agg>(),
  /** key `server|resource` */
  backends: new Map<string, Agg>(),
  /** key `instance|server` */
  links: new Map<string, Agg>(),
  /** bumps when a link appears (the kit re-lists its click targets) */
  linkVersion: 0,
};

const newAgg = (now: number): Agg => ({ calls: 0, errors: 0, lat: [], first: now, last: now, spark: new Array(SPARK_N).fill(0), sparkSec: Math.floor(now / 1000), tools: new Map(), callers: new Map(), statuses: new Map(), resources: new Map(), recent: [], units: 0 });

function get(m: Map<string, Agg>, key: string, now: number, onNew?: () => void): Agg {
  let a = m.get(key);
  if (!a) {
    if (m.size >= MAX_ENTRIES) {
      // forget the stalest entry (bounded memory on very long sessions)
      let old: string | undefined, t = Infinity;
      for (const [k, v] of m) if (v.last < t) ((t = v.last), (old = k));
      if (old !== undefined) m.delete(old);
    }
    m.set(key, (a = newAgg(now)));
    onNew?.();
  }
  return a;
}

/** advance the per-second ring to `now` (zeroing skipped seconds) */
export function roll(a: Agg, now: number) {
  const sec = Math.floor(now / 1000);
  const gap = Math.min(SPARK_N, sec - a.sparkSec);
  for (let k = 1; k <= gap; k++) a.spark[(a.sparkSec + k) % SPARK_N] = 0;
  if (sec > a.sparkSec) a.sparkSec = sec;
}

/** the sparkline oldest -> newest (rolled to now) */
export function sparkSeries(a: Agg, now: number): number[] {
  roll(a, now);
  const out: number[] = [];
  for (let k = 1; k <= SPARK_N; k++) out.push(a.spark[(a.sparkSec + k) % SPARK_N]);
  return out;
}

/** calls per second over the last minute */
export const ratePerS = (a: Agg, now: number) => sparkSeries(a, now).reduce((x, y) => x + y, 0) / Math.min(SPARK_N, Math.max(1, (now - a.first) / 1000));

export function pct(xs: number[], q: number): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

const push = <T,>(xs: T[], v: T, max: number) => {
  xs.push(v);
  if (xs.length > max) xs.splice(0, xs.length - max);
};

/** An operation label: the first word of the tool (`SELECT`, `GET`, `infer`), max 24 chars: never a statement. */
export const opOf = (tool: string) => (tool.trim().split(/\s+/)[0] || "call").slice(0, 24);

export type McpEv = { id: string; server: string; tool: string; phase: "call" | "result"; latency_ms?: number; resource?: string; resource_kind?: ResourceKind; units?: number; unit?: string; device?: string; error?: boolean; status?: number };

/** fold one `mcp` event in (called by the world reducer) */
export function noteMcp(ev: McpEv, now: number) {
  const aggs = [get(resInfo.servers, ev.server, now), get(resInfo.links, `${ev.id}|${ev.server}`, now, () => resInfo.linkVersion++)];
  if (ev.resource) {
    const b = get(resInfo.backends, `${ev.server}|${ev.resource}`, now);
    b.kind = ev.resource_kind ?? b.kind;
    aggs.push(b);
  }
  const tool = ev.tool || "call";
  for (const a of aggs) {
    a.last = now;
    if (ev.resource) a.resources.set(ev.resource, (a.resources.get(ev.resource) ?? 0) + (ev.phase === "call" ? 1 : 0));
    let t = a.tools.get(tool);
    if (!t) {
      if (a.tools.size >= 64) continue;
      a.tools.set(tool, (t = { calls: 0, errors: 0, lat: [] }));
    }
    if (ev.phase === "call") {
      a.calls++;
      t.calls++;
      a.callers.set(ev.id, (a.callers.get(ev.id) ?? 0) + 1);
      roll(a, now);
      a.spark[a.sparkSec % SPARK_N]++;
      continue;
    }
    const ok = !ev.error;
    if (!ok) (a.errors++, t.errors++);
    if (ev.latency_ms !== undefined) {
      push(a.lat, ev.latency_ms, LAT_MAX);
      push(t.lat, ev.latency_ms, LAT_MAX);
      a.lastMs = ev.latency_ms;
    }
    if (ev.status !== undefined) {
      const cls = `${Math.floor(ev.status / 100)}xx`;
      a.statuses.set(cls, (a.statuses.get(cls) ?? 0) + 1);
    }
    if (ev.units) ((a.units += ev.units), (a.unit = ev.unit ?? a.unit));
    if (ev.device) a.device = ev.device;
    push(a.recent, { who: ev.id, tool, resource: ev.resource, ms: ev.latency_ms, ok, status: ev.status, at: now }, RECENT_MAX);
  }
}

export function clearResInfo() {
  resInfo.servers.clear();
  resInfo.backends.clear();
  resInfo.links.clear();
  resInfo.linkVersion++;
}

/** the aggregate behind a selection */
export function aggOf(sel: ResSel): Agg | undefined {
  if (sel.type === "server") return resInfo.servers.get(sel.server);
  if (sel.type === "backend") return resInfo.backends.get(`${sel.server}|${sel.resource}`);
  return resInfo.links.get(`${sel.id}|${sel.server}`);
}

export const sameSel = (a: ResSel | null, b: ResSel | null) => JSON.stringify(a) === JSON.stringify(b);
