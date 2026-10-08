/**
 * Shared "world" for every 3D scene (/neural, /constellation, /orbit, /atom, /flow).
 *
 * Models a Hatchet + deepagents + FalkorDB system as LIVING agent instances:
 *   - runs:      Hatchet workflow runs (several concurrent), each with the steps it reports (e.g. plan → research → write),
 *                in first-seen order; parallel steps can run at once and a retried step goes failed → running → done
 *   - instances: agent instances spawned during a run (planner, researcher, N scouts fanned out, writer);
 *                each is born (spawn), works (thinking/waiting), and exits (done/failed) - then fades out
 *   - comets:    messages between instances (handoffs, delegations, results)
 *   - flares:    FalkorDB nodes read/written by an instance
 *   - mcpServers / mcpCalls: external MCP servers ("satellites") and request/response packets to them
 *   - mcpPending: calls awaiting a response → draw a pulsing TETHER beam agent ↔ server (brighter/redder the longer it waits);
 *     mcpResolved: just-answered calls (~700ms) → "snap back" flash along the tether, then it dissolves
 *
 * Scenes read `world` every frame inside useFrame (mutable, no re-render) and use `useWorld()` for HUD/DOM.
 */
import { useSyncExternalStore } from "react";
import { clearResInfo, noteMcp, sameSel, type ResSel } from "./resinfo";
import { areaNames, resetGraphDyn, restoreGraph, touchGraph } from "./graphDyn";
import { applyPrim, noteRejected, PRIM_NO_LOG, PRIM_QUIET, PRIM_TYPES, tickPrims, type Backlog, type PrimEdge, type PrimState, type PrimWorldEvent, type ResStat } from "./prims";
export type { PrimState, PrimWorldEvent } from "./prims";

export type AgentType = "planner" | "researcher" | "graph_scout" | "records_scout" | "data_scout" | "writer";
/** Any workflow-defined step name (the backend scrubs and caps it). */
export type StepName = string;
export type StepStatus = "queued" | "running" | "done" | "failed";
export type InstanceStatus = "spawning" | "thinking" | "waiting" | "done" | "failed";

// ------------------------------------------------------------------ event contract (v2)
export type WorldEvent =
  | { type: "run"; run_id: string; status: "started" | "renamed" | "completed" | "failed"; topic: string; workflow: string; ts: number; reason?: string }
  // idle: an open run silent for AGENTGLOW_IDLE_DIM_MIN (not waiting on purpose); `since` = its last event (epoch ms).
  // active: it produced an event again (sent right before that event)
  | { type: "run"; run_id: string; status: "idle" | "active"; since?: number; ts: number }
  // "waiting": the step is paused in a wait (approval, durable sleep, ...); `reason` = what it waits on, `until` = epoch ms
  // declared waits also carry the drawer fields (WaitExtra: kind "approval", title, details, url, because)
  | ({ type: "step"; run_id: string; step: StepName; status: "running" | "waiting" | "done" | "failed"; reason?: string; until?: number; ts: number } & WaitExtra)
  // `job`: a long-running request of the service `parent_id` (docs/SPEC.md "Backend services"), open since `since` (epoch ms)
  | { type: "spawn"; run_id: string; id: string; agent: string; parent_id: string | null; subagent?: boolean; job?: boolean; since?: number; ts: number }
  | { type: "exit"; run_id: string; id: string; status: "done" | "failed"; ts: number }
  | ({ type: "agent"; run_id: string; id: string; status: "thinking" | "waiting"; reason?: string; until?: number; ts: number } & WaitExtra)
  // tokens_in = ALL prompt tokens (cached included); tokens_cached / tokens_cache_write are subsets of it, never added
  | { type: "llm"; run_id: string; id: string; tokens_in: number; tokens_out: number; tokens_cached?: number; tokens_cache_write?: number; latency_ms: number; ts: number }
  // `failed`: a publish that raised (backend services): the comet fizzles out instead of arriving
  | { type: "message"; run_id: string; from_id: string; to_id: string; text: string; ts: number; failed?: boolean }
  | { type: "tool"; run_id: string; id: string; tool: string; args_preview: string; ts: number }
  | { type: "graph"; run_id: string; id: string; op: "read" | "write"; nodes: string[]; kinds?: (string | null)[]; ts: number }
  // replay only (first connect): graph nodes touched earlier (oldest first), so a refreshed viewer keeps the dynamic nodes
  | { type: "graph_nodes"; nodes: { name: string; kind?: string | null; peers?: string[] }[]; run_id?: string; ts?: number }
  | { type: "final"; run_id: string; text: string; ts: number }
  // opt-in (server env AGENTGLOW_CAPTURE_PROMPTS=1, local servers only): one side of a turn on the agent instance
  // `id`, the user's prompt ("user") or the agent's reply ("agent"); secret-redacted and capped by the backend
  | { type: "chat"; run_id: string; id: string; role: "user" | "agent"; text: string; ts: number }
  // an agent instance started / finished using a SKILL (e.g. "pptx"); the same call also arrives as a `tool` event
  | { type: "skill"; run_id: string; id: string; name: string; status: "start" | "end"; ts: number }
  // a fast structured decision (Jev / Laya / LLM-as-judge) by agent instance `id`: choice (one of N options), score
  // (ordinal level) or noul (yes / no); p = probability of `result`, options = top 5 {name, p}, ms = latency
  // `hv`: sent while the agent is in high-volume mode (its decisions are aggregated in `decision_stats`); `why` = what
  // made it interesting (important | deny | flip | low_p)
  | { type: "decision"; run_id: string; id: string; kind: DecisionKind; question: string; result: string; p?: number; options?: { name: string; p: number }[]; provider: string; purpose?: string; target?: string; scope?: string; threshold?: number; ms: number; ts: number; hv?: boolean; why?: string }
  // high-volume mode: one per agent per ~1 s window (docs/SPEC.md "Decisions" > "High volume")
  | { type: "decision_stats"; run_id: string; id: string; window_ms: number; n: number; by_purpose: DecisionStatsByPurpose; p50_ms: number; p95_ms: number; providers: Record<string, number>; ts: number }
  // backend services (docs/SPEC.md "Backend services"): a request / handled message on the service agent `id`;
  // `hv` = an error sent individually while the service's requests are aggregated in `service_stats`
  // `rejected`: admission / backpressure (429 / 503 with `agentglow.rejected`): amber, not an error
  | { type: "request"; run_id: string; id: string; service: string; name: string; kind: "http" | "rpc" | "message" | "event"; status?: number; error: boolean; rejected?: boolean; ms: number; ts: number; hv?: boolean }
  // one per service per ~1 s window: requests, errors, status classes ("2xx": n), latency, top routes
  | { type: "service_stats"; run_id: string; id: string; service: string; window_ms: number; n: number; errors: number; codes: Record<string, number>; p50_ms: number; p95_ms: number; routes: Record<string, number>; ts: number; instances?: number; inflight?: number }
  // backend services: the service `id` drives the agent run `target_run` (its spans come from that service's process)
  | { type: "drives"; run_id: string; id: string; target_run: string; ts: number }
  // an order action (paper when dry_run) by agent instance `id`
  | { type: "order"; run_id: string; id: string; side: string; qty: number; price?: number; status: OrderStatus; instrument: string; dry_run: boolean; reason?: string; ts: number }
  // MCP tool call from an agent instance to an external MCP server ("call" when sent, "result" when it returns)
  // topology: an MCP server and the backends behind it (sent at worker startup and to every new viewer)
  | { type: "mcp_register"; run_id?: string; server: string; resources: { name: string; kind: ResourceKind }[]; ts: number; kind?: ServerKind }
  | { type: "mcp"; run_id: string; id: string; server: string; tool: string; phase: "call" | "result"; latency_ms?: number; ts: number; resource?: string; resource_kind?: ResourceKind; units?: number; unit?: string; device?: string; error?: boolean; status?: number }
  // generic primitives (docs/SPEC.md "Generic primitives", prims.ts)
  | PrimWorldEvent;

export type DecisionKind = "choice" | "score" | "noul";
/** The decision that triggered a wait (docs/SPEC.md "Human approval"): a summary of its `decision` event. */
export type WaitBecause = { id?: string; kind: string; question: string; result: string; p?: number; provider?: string; purpose?: string; target?: string; threshold?: number; ms?: number; ts?: number };
/** A declared wait's drawer fields (`agentglow.wait.*`): `kind` "approval" = a human approval ("Needs you"). */
export type WaitExtra = { kind?: string; title?: string; details?: Record<string, string | number | boolean>; url?: string; because?: WaitBecause };
export type DecisionStatsByPurpose = {
  route?: { n: number; results: Record<string, number> };
  guard?: { n: number; allow: number; deny: number };
  check?: { n: number; yes: number; no: number };
};
export type OrderStatus = "would_place" | "placed" | "filled" | "rejected" | "cancelled";
/** One order on one agent; `at` = performance.now() when it arrived (its chip plays from there). */
export type OrderUse = Omit<Extract<WorldEvent, { type: "order" }>, "type" | "run_id" | "id"> & { at: number };
export const ORDER_LIFE_MS = 1500;
const ORDERS_KEPT = 8;

/**
 * High-volume decisions, per agent (from `decision_stats`): smoothed (EMA) so the halo and its label never flicker.
 * `seg` = smoothed share of each outcome category, in HALO_CATS order.
 */
export type HvStats = { at: number; bump: number; bumpDeny: boolean; rate: number; deny: number; p50: number; p95: number; seg: number[]; provider: string; n: number; windows: number; unit?: "req" | "msg"; instances?: number; inflight?: number };
/** outcome categories of a decision halo arc: allow, deny, check yes, check no, route result slots 0..3, other */
export const HALO_CATS = ["allow", "deny", "yes", "no", "r0", "r1", "r2", "r3", "other"] as const;
export const HALO_COLORS = ["#4ade80", "#fb3b5c", "#5eead4", "#fbbf24", "#60a5fa", "#c084fc", "#f472b6", "#facc15", "#94a3b8"];
/** route result name -> accent slot 0..3 (first four names seen in this session; later ones are "other") */
export const routeSlots = new Map<string, number>();
const routeSlot = (name: string) => {
  let k = routeSlots.get(name);
  if (k === undefined && routeSlots.size < 4) routeSlots.set(name, (k = routeSlots.size));
  return k === undefined ? 8 : 4 + k;
};
const HV_ALPHA = 0.35;
/** a halo fades out once its agent sent no stats for this long (ms), over HV_FADE_MS */
export const HV_QUIET_MS = 2500;
export const HV_FADE_MS = 1500;
/** 0..1 visibility of an agent's decision halo */
export function haloMix(h: HvStats | null, now = performance.now()): number {
  if (!h) return 0;
  const t = now - h.at;
  const inn = Math.min(1, (now - h.at + 1000 * h.windows) / 600);
  if (t < HV_QUIET_MS) return inn;
  return Math.max(0, 1 - (t - HV_QUIET_MS) / HV_FADE_MS) * inn;
}
/** a backend service with no traffic for this long (ms) reads as idle: dimmed, label `feed · idle` */
export const SVC_IDLE_MS = 10000;
/** a top-level backend service agent (`svc:` id) */
export const isSvc = (i: Instance) => !i.parent && i.id.startsWith("svc:");
/** a backend service with no requests / messages in the last SVC_IDLE_MS (or none since it appeared) */
export const svcIdle = (i: Instance, now = performance.now()) => isSvc(i) && now - (i.svcAt ?? i.bornAt) > SVC_IDLE_MS;
/** performance.now() at which an event happened: replayed (old) events are aged by their epoch `ts`, so stale
 *  stats and traffic on a page refresh read as old instead of "just now" */
const evAt = (ev: { ts?: number }, now: number) => (ev.ts ? now - Math.max(0, Math.min(Date.now() - ev.ts, 3_600_000)) : now);
/** record traffic on a service agent (no-op for other agents) */
const svcTraffic = (i: Instance | undefined, now: number) => {
  if (i && isSvc(i)) i.svcAt = now;
};
/** the agent is in high-volume mode now (recent decision_stats) */
export const hvActive = (i: Instance, now = performance.now()) => !!i.hv && now - i.hv.at < HV_QUIET_MS + HV_FADE_MS;
/** The halo label: rate + error / deny share (only when > 0): `jev 42/s · 3% deny`; a service: `42 req/s · 2% errors`
 * (`msg/s` for a consumer). Latency lives in the Selected panel and the label's hover tooltip (`haloLatency`). */
export function haloText(h: HvStats): string {
  const r = h.rate >= 10 ? Math.round(h.rate) : Math.round(h.rate * 10) / 10;
  const share = haloShare(h);
  return `${h.unit ? `${r} ${h.unit}/s` : `${h.provider} ${r}/s`}${share ? ` · ${share}` : ""}`;
}
/** `3% deny` / `2% errors` / "" when none */
export function haloShare(h: HvStats): string {
  const d = h.deny * 100;
  if (!(d > 0)) return "";
  return `${d < 1 ? "<1" : Math.round(d)}% ${h.unit ? "errors" : "deny"}`;
}
/** `p50 38ms · p95 120ms` (+ `· 3 in flight` for a service) */
export function haloLatency(h: HvStats): string {
  return `p50 ${Math.round(h.p50)}ms · p95 ${Math.round(h.p95)}ms${h.inflight ? ` · ${h.inflight} in flight` : ""}`;
}
/** `2m14s` / `38s` / `1h05m` */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
/** a job's name label: `mkt:tick · 2m14s` (frozen at its end) */
export const jobText = (i: Instance) => (i.job ? `${i.name} · ${elapsedText((i.job.end || Date.now()) - i.job.since)}` : i.name);
/** a job's end flash 0..1 (green done / red failed), ~1.2 s */
export const flashMix = (i: Instance, now = performance.now()) => (i.flash ? Math.max(0, 1 - (now - i.flash.at) / 1200) : 0);
/** One decision on one agent; `at` (performance.now()) = when its glyph starts (staggered so a burst reads one by one). */
export type DecisionUse = Omit<Extract<WorldEvent, { type: "decision" }>, "type" | "run_id" | "id"> & {
  at: number;
  /** high volume: not shown as a glyph (over the on-screen cap; it only flashed the halo) */
  hidden?: boolean;
  /** high volume: pre-empted by a more important glyph at this time (fades out fast) */
  cut?: number;
};
/** Decision glyph timing (ms): snap in fast (much faster than LLM pulses / skill rings on purpose), then hold long
 *  enough to read on a video; a guard deny holds longer. */
export const DECISION_SNAP_MS = 150;
export const DECISION_HOLD_MS = 1800;
export const DECISION_LIFE_MS = 2400;
export const DENY_HOLD_MS = 2500;
export const DENY_LIFE_MS = 3100;
/** min gap between two glyph starts on one agent (a burst of decisions plays as a quick sequence) */
export const DECISION_STAGGER_MS = 220;
/** high-volume mode (`hv` decisions): short holds so glyphs don't pile up */
export const HV_HOLD_MS = 800;
export const HV_LIFE_MS = 1150;
/** decisions kept per agent (Selected panel) */
const DECISIONS_KEPT = 12;
/** how long a decision's glyph lives (ms) */
export const decisionLife = (d: { kind: string; result: string; purpose?: string; hv?: boolean }) => (d.hv ? HV_LIFE_MS + (isDeny(d) ? 300 : 0) : isDeny(d) ? DENY_LIFE_MS : DECISION_LIFE_MS);
/** 0..1 visibility of a decision glyph: snaps in (DECISION_SNAP_MS), holds, fades out by decisionLife(d). */
export function decisionMix(d: DecisionUse, now = performance.now()): number {
  const t = now - d.at;
  const deny = isDeny(d);
  const hold = d.hv ? HV_HOLD_MS + (deny ? 300 : 0) : deny ? DENY_HOLD_MS : DECISION_HOLD_MS;
  const life = decisionLife(d);
  if (t <= 0 || t >= life || d.hidden) return 0;
  const cut = d.cut ? Math.max(0, 1 - (now - d.cut) / 160) : 1;
  if (cut < 1) return cut * (t < DECISION_SNAP_MS ? t / DECISION_SNAP_MS : 1);
  if (t < DECISION_SNAP_MS) return t / DECISION_SNAP_MS;
  if (t < hold) return 1;
  const o = 1 - (t - hold) / (life - hold);
  return o * o * (3 - 2 * o);
}
/** a guardrail that said no (shown as a red X / shut gate) */
export const isDeny = (d: { kind: string; result: string; purpose?: string }) => d.kind === "noul" && d.purpose === "guard" && d.result === "no";
export const pct = (p?: number) => (p === undefined ? "" : ` ${Math.round(p * 100)}%`);
/** short text for a decision: `jev · route → haiku 92%`, `guard: deny rollback_deploy 97%` */
export function decisionText(d: { kind: string; question: string; result: string; p?: number; provider: string; purpose?: string; target?: string }): string {
  if (d.kind === "noul" && d.purpose === "guard") return `guard: ${d.result === "no" ? "deny" : "allow"} ${d.target || d.question}${pct(d.p)}`;
  return `${providerBadge(d.provider)} · ${d.purpose || d.question} → ${d.result}${pct(d.p)}`;
}

/** friendly decision-kind badge (display only; events and docs keep the raw kind) */
export const kindBadge = (kind: string) => (kind === "noul" ? "YES/NO" : kind === "score" ? "SCORE" : "PICK");
/** friendly high-volume reason tag (`why`) */
export const whyBadge = (why: string) => ({ important: "key", flip: "changed mind", low_p: "unsure", deny: "DENY" })[why] ?? why;
/** provider badge: code guards read as a rule */
export const providerBadge = (p: string) => (p === "code" ? "rule" : p);

/** `YES 3 @ 42c`, `SELL 10 @ 101.5` (prices below 1 read as cents) */
export function orderText(o: { side: string; qty: number; price?: number; status?: string }): string {
  const p = o.price === undefined ? "" : o.price > 0 && o.price < 1 ? ` @ ${Math.round(o.price * 100)}c` : ` @ ${o.price}`;
  return `${o.side.toUpperCase()} ${o.qty}${p}${o.status && o.status !== "would_place" ? ` ${o.status}` : ""}`;
}

/** What sits behind an MCP server (the server is a node; its backends are nodes too). */
/** `model` = a classic ML model (scorer, classifier, ASR...), `llm` = a language model (inference(kind="llm")) */
export type ResourceKind = "db" | "warehouse" | "spark" | "api" | "storage" | "queue" | "model" | "llm" | "gpu" | "worker" | "cache";
/** the six shapes every theme draws: newer kinds map onto the closest one (model / gpu -> spark, worker -> storage, cache -> db) */
export type ShapeKind = "db" | "warehouse" | "spark" | "api" | "storage" | "queue";
export const shapeKind = (k: string | undefined): ShapeKind =>
  k === "model" || k === "llm" || k === "gpu" ? "spark" : k === "worker" ? "storage" : k === "cache" ? "db" : k === "db" || k === "warehouse" || k === "spark" || k === "storage" || k === "queue" ? k : "api";

export const AGENT_TYPES: { type: AgentType; label: string; color: string }[] = [
  { type: "planner", label: "Planner", color: "#a78bfa" },
  { type: "researcher", label: "Researcher", color: "#fbbf24" },
  { type: "graph_scout", label: "Graph Scout", color: "#22d3ee" },
  { type: "records_scout", label: "Records Scout", color: "#f472b6" },
  { type: "data_scout", label: "Data Scout", color: "#fb7185" },
  { type: "writer", label: "Writer", color: "#4ade80" },
];
export const TYPE_COLOR = Object.fromEntries(AGENT_TYPES.map((a) => [a.type, a.color])) as Record<AgentType, string>;
export const TYPE_LABEL = Object.fromEntries(AGENT_TYPES.map((a) => [a.type, a.label])) as Record<AgentType, string>;
/**
 * Scenes draw a run's steps in 3 fixed slots (the planner / researcher / writer positions): slot 0 = the 1st step seen,
 * slot 1 = the 2nd, slot 2 = everything after. A 3-step workflow (plan / research / write) maps 1:1.
 */
export const STEP_SLOTS = [0, 1, 2];
/** Step chips / label segments shown per run before collapsing the rest into "+N". */
export const MAX_STEP_CHIPS = 6;
export const RUN_COLORS = ["#818cf8", "#f472b6", "#34d399", "#fb923c", "#38bdf8", "#e879f9"];
export const KIND_COLOR: Record<string, string> = {
  Customer: "#f59e0b",
  Account: "#38bdf8",
  Incident: "#22c55e",
  Ticket: "#a78bfa",
  Product: "#f472b6",
  Region: "#ef4444",
  Metric: "#facc15",
  Team: "#2dd4bf",
  Business: "#f59e0b",
  Address: "#38bdf8",
  Resolution: "#22c55e",
  Meeting: "#a78bfa",
  Hearing: "#f472b6",
  Agency: "#ef4444",
  Topic: "#facc15",
  Committee: "#2dd4bf",
  // a node touched by an event but not in the served sample (no kind given): see graphDyn.ts
  touched: "#e879f9",
  Vendor: "#fb923c",
  Contract: "#60a5fa",
  Device: "#4ade80",
};

// ------------------------------------------------------------------ state
export type Instance = {
  id: string;
  run: string;
  type: AgentType; // visual role (layout + color) mapped from the real agent name
  /** real agent name from the trace (e.g. "researcher", "web_scout", "report_writer") */
  name: string;
  parent: string | null;
  status: InstanceStatus;
  /** spawned by a parent agent via the deepagents `task` tool (vs a top-level workflow-step agent) */
  subagent: boolean;
  bornAt: number; // performance.now()
  /** performance.now() when the agent finished (exit done/failed); 0 while working. A finished agent stays drawn DIMMED
   * at its spot until its RUN ends (so a run reads as a chain planner -> researcher -> writer); see isDone / isLive. */
  doneAt: number;
  /** performance.now() when the shape starts fading out (its run ended, or it finished outside a known run); 0 before */
  exitAt: number;
  pulse: number; // last LLM pulse strength 0..2.5
  pulseAt: number;
  tokens: number;
  tokensCached: number; // prompt-cache reads, already inside `tokens`
  index: number; // stable slot within its run (0..)
  recent: WorldEvent[];
  // per-agent counters for the inspector panel
  llmCalls: number;
  toolCalls: number;
  mcpCalls: number;
  nodes: Set<string>; // FalkorDB nodes this agent read/wrote
  /** skills this agent used: name -> active now, times started, performance.now() of the last start/end */
  skills: Map<string, SkillUse>;
  /** newest started skill ("" = none yet) and when the last active one ended (0 while one is active) */
  skill: string;
  skillEndAt: number;
  /** recent decisions (newest last, capped); glyphs play from `at` */
  decisions: DecisionUse[];
  /** high-volume decision stats (null until its first `decision_stats`) */
  hv: HvStats | null;
  /** recent orders (newest last, capped) */
  orders: OrderUse[];
  /** the MCP server this agent called last (a guard deny flashes the agent's line to it) */
  lastMcp?: string;
  /** opt-in prompt capture: this agent's turns, oldest first (user prompt, then its reply), capped */
  chat: { role: "user" | "agent"; text: string }[];
  /** what it is waiting on (status "waiting" with a reason), else null */
  wait: Wait | null;
  /** backend service agent: requests / errors handled (from `service_stats`) */
  svcN?: number;
  svcErr?: number;
  /** backend service agent: requests per route and per status class since first seen (Resource details layout) */
  svcRoutes?: Map<string, number>;
  svcCodes?: Map<string, number>;
  /** backend service agent: performance.now() of its last traffic (requests / messages in or out); see svcIdle */
  svcAt?: number;
  /** a long-running request of a service shown as its subagent: started / ended (epoch ms, end 0 while open) */
  job?: { since: number; end: number };
  /** a job just ended: its halo flashes green (ok) / red (performance.now()) */
  flash?: { at: number; ok: boolean };
  /** generic primitives (prims.ts): created on the instance's first primitive event */
  prim?: PrimState;
};
/** A declared wait: what it waits on ("approval", "sleep", an event key) and its deadline / wake-up (epoch ms, 0 = none). */
export type Wait = { reason: string; until: number } & WaitExtra;
/** reason / until + the drawer fields of a waiting `step` / `agent` event */
export function waitOf(ev: { reason?: string; until?: number } & WaitExtra): Wait {
  const w: Wait = { reason: ev.reason || "wait", until: ev.until ?? 0 };
  if (ev.kind) w.kind = ev.kind;
  if (ev.title) w.title = ev.title;
  if (ev.details) w.details = ev.details;
  if (ev.url) w.url = ev.url;
  if (ev.because) w.because = ev.because;
  return w;
}
/** one skill on one agent; startAt / endAt (performance.now()) drive its sigil ring (endAt 0 while active) */
export type SkillUse = { active: boolean; count: number; last: number; startAt: number; endAt: number };
/** Skill sigil timing (ms): fade in, minimum time shown after a start (Claude Code skills are instantaneous tool
 *  calls, start and end arrive ms apart), fade out after the (effective) end. */
export const SKILL_IN_MS = 450;
export const SKILL_MIN_MS = 4000;
export const SKILL_OUT_MS = 1100;
/** a skill that never reports an end (crashed tool, lost event) is treated as ended after this long */
export const SKILL_MAX_MS = 60_000;
/** when a skill's sigil starts fading out: its end, but never before SKILL_MIN_MS after its start (0 = active) */
export function skillOffAt(u: SkillUse): number {
  return u.endAt ? Math.max(u.endAt, u.startAt + SKILL_MIN_MS) : 0;
}
/** 0..1 visibility of one skill's sigil: eases in after a start, holds while active (>= SKILL_MIN_MS), then fades. */
export function skillUseMix(u: SkillUse, now = performance.now()): number {
  const t = Math.min(1, Math.max(0, (now - u.startAt) / SKILL_IN_MS));
  const off = skillOffAt(u);
  const o = off ? Math.min(1, Math.max(0, 1 - (now - off) / SKILL_OUT_MS)) : 1;
  return t * (2 - t) * o * o * (3 - 2 * o);
}
let mixNow = 0;
let mixMax = 0;
const mixVisit = (u: SkillUse) => void (mixMax = Math.max(mixMax, skillUseMix(u, mixNow)));
/** 0..1: the strongest skill sigil on this agent (0 = none shown) */
export function skillMix(i: Instance, now = performance.now()): number {
  if (!i.skill) return 0;
  mixNow = now;
  mixMax = 0;
  i.skills.forEach(mixVisit);
  return mixMax;
}
export type Run = {
  id: string;
  topic: string;
  workflow: string;
  color: string;
  slot: number; // 0..N stable lane/position for scenes
  status: "started" | "completed" | "failed";
  /** status of every step seen so far; a step is only known once its first event arrives. A waiting step stays
   * "running" here (running but paused) and is listed in `waits`. */
  steps: Record<StepName, StepStatus>;
  /** steps paused in a wait (durable approval / sleep): step -> what it waits on */
  waits: Record<StepName, Wait>;
  /** step names in first-seen order */
  stepOrder: StepName[];
  /** true once a step event arrives (e.g. Hatchet); plain agent runs have no steps */
  hasSteps: boolean;
  startedAt: number;
  endedAt: number;
  handoffAt: number;
  /** handoff between step SLOTS (see STEP_SLOTS), never within one */
  handoffFrom: number;
  handoffTo: number;
  /** the step that finished most recently (handoff source) */
  lastDone: StepName;
  final: string;
  /** performance.now() of the run's latest event (stale detection) */
  lastEventAt: number;
  /** server-declared idle since (epoch ms of its last event), 0 = active (isIdle / idleText) */
  idleSince: number;
};
/** Which of the 3 scene slots a step is drawn in (see STEP_SLOTS). */
export function stepSlot(r: Run, step: StepName): number {
  return Math.min(Math.max(r.stepOrder.indexOf(step), 0), STEP_SLOTS.length - 1);
}
function slotNames(r: Run, k: number): StepName[] {
  return k < STEP_SLOTS.length - 1 ? r.stepOrder.slice(k, k + 1) : r.stepOrder.slice(k);
}
/** A slot's status: running if any of its steps runs, failed if any (last attempt) failed, done once all are done. */
export function slotStatus(r: Run, k: number): StepStatus {
  const st = slotNames(r, k).map((s) => r.steps[s]);
  if (!st.length) return "queued";
  return st.includes("running") ? "running" : st.includes("failed") ? "failed" : st.every((x) => x === "done") ? "done" : "queued";
}
/** A slot's caption: its step, or the running (else latest) one plus "+N" when the last slot holds several; "" if none yet. */
export function slotLabel(r: Run, k: number): string {
  const names = slotNames(r, k);
  if (names.length < 2) return names[0] ?? "";
  const cur = names.find((s) => r.steps[s] === "running") ?? names[names.length - 1];
  return `${cur} +${names.length - 1}`;
}
/** Steps for chips / label lines: the first MAX_STEP_CHIPS in order, plus how many more are hidden. */
/** The run's first waiting step (in step order), or null. */
export function runWait(r: Run): (Wait & { step: StepName }) | null {
  for (const s of r.stepOrder) if (r.waits[s] && r.steps[s] === "running") return { step: s, ...r.waits[s] };
  return null;
}
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** "sleeping until 14:05" / "waiting on approval" / "waiting on approval (until Oct 3, 09:00)" */
/** A live run is stale when nothing arrived from it for STALE_QUIET_MS while a wait of it is past its deadline by
 * STALE_GRACE_MS (e.g. its worker restarted mid-run: nobody will resolve the wait or end the run). */
export const STALE_QUIET_MS = 20_000;
export const STALE_GRACE_MS = 15_000;
/** Idle run (server `run` status "idle"): its agents are dimmed (IDLE_DIM) and its label says "idle · 4m". */
export const IDLE_DIM = 0.55;
export const isIdle = (r: Run | undefined): boolean => !!r && r.status === "started" && r.idleSince > 0;
export function idleText(r: Run, wall = Date.now()): string {
  const s = Math.max(0, (wall - r.idleSince) / 1000);
  return `idle · ${s < 60 ? `${Math.floor(s)}s` : `${Math.floor(s / 60)}m`}`;
}

// ------------------------------------------------------------------ per-viewer dismissed runs
/** Runs this viewer hid ("×"): run id -> Date.now() at dismissal, kept in localStorage. The world keeps applying
 * their events (state stays right), lod.ts just never draws them; any new activity after the dismissal shows the run
 * again (replayed older events do not). */
const DISMISS_KEY = "agentglow.dismissedRuns";
const DISMISS_MAX = 200;
const dismissed: Map<string, number> = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "{}");
    if (v && typeof v === "object") return new Map(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number"));
  } catch {
    /* no storage (private window, blocked, SSR): nothing remembered */
  }
  return new Map<string, number>();
})();
function saveDismissed() {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify(Object.fromEntries(dismissed)));
  } catch {
    /* not remembered across reloads, still hidden now */
  }
}
export const isDismissed = (runId: string | undefined): boolean => !!runId && dismissed.has(runId);
/** Hide a run (and its agents) for this viewer. */
export function dismissRun(runId: string) {
  dismissed.delete(runId);
  dismissed.set(runId, Date.now());
  while (dismissed.size > DISMISS_MAX) dismissed.delete(dismissed.keys().next().value!);
  saveDismissed();
  const sel = world.selected ? world.instances.get(world.selected) : undefined;
  if (sel?.run === runId) world.selected = null;
  notify();
}
/** Show the given runs again (all dismissed ones when omitted). */
export function undismissRuns(ids?: string[]) {
  for (const id of ids ?? [...dismissed.keys()]) dismissed.delete(id);
  saveDismissed();
  notify();
}
/** Dismissed runs that are still in the world (the HUD's "N hidden" chip). */
export const dismissedRuns = (): string[] => [...world.runs.keys()].filter((id) => dismissed.has(id));
function undismissOnActivity(ev: WorldEvent) {
  const id = (ev as { run_id?: string }).run_id;
  const at = id ? dismissed.get(id) : undefined;
  if (at === undefined) return;
  // not activity: the run's own idle / end / relabel notices
  if (ev.type === "run" && ev.status !== "started" && ev.status !== "active") return;
  if (typeof ev.ts === "number" && ev.ts > at) {
    dismissed.delete(id!);
    saveDismissed();
  }
}

export function isStale(r: Run | undefined, now = performance.now(), wall = Date.now()): boolean {
  if (!r || r.status !== "started" || now - r.lastEventAt < STALE_QUIET_MS) return false;
  const overdue = (w: Wait | null | undefined) => !!w && !!w.until && wall - w.until > STALE_GRACE_MS;
  if (Object.values(r.waits).some(overdue)) return true;
  for (const i of world.instances.values()) if (i.run === r.id && !i.exitAt && overdue(i.wait)) return true;
  return false;
}
export const STALE_TEXT = "stale: no worker activity";
export function waitLabel(w: Wait, now = Date.now()): string {
  const when = !w.until ? "" : Math.abs(w.until - now) < 20 * 3600_000 ? hhmm(w.until) : `${new Date(w.until).toLocaleDateString([], { month: "short", day: "numeric" })}, ${hhmm(w.until)}`;
  if (w.reason === "sleep") return when ? `sleeping until ${when}` : "sleeping";
  return `waiting on ${w.reason}${when ? ` (until ${when})` : ""}`;
}
export function stepChips(r: Run, max = MAX_STEP_CHIPS): { shown: StepName[]; more: number } {
  const n = r.stepOrder.length;
  const cut = n > max ? max - 1 : n; // the "+N" chip takes the last place
  return { shown: r.stepOrder.slice(0, cut), more: n - cut };
}
export type Comet = { id: number; run: string; from: string; to: string; start: number; dur: number; text: string; failed?: boolean };
/** a failed comet (a publish that raised) sputters out half way: it stalls here and is gone at FIZZLE_END of its life */
export const FIZZLE_STALL = 0.55;
export const FIZZLE_END = 0.8;
/** path parameter (0..1, before a theme's easing) of a comet: a failed one decelerates to the midpoint and stops */
export function cometPos(c: Comet, now = performance.now()): number {
  const u = Math.max(0, (now - c.start) / c.dur);
  return c.failed ? 0.5 * Math.min(1, u / FIZZLE_STALL) : Math.min(1, u);
}
/** the comet head is still drawn (a failed one never arrives: no arrival flash) */
export const cometOn = (c: Comet, now = performance.now()) => (now - c.start) / c.dur < (c.failed ? FIZZLE_END : 1);
/** External MCP servers agents call (persistent "satellites"; registered on first use). */
/** `kind` = the shape themes draw (shapeKind), `sub` = the reported kind (model, gpu, worker, cache, ...) */
export type McpResource = { name: string; kind: ShapeKind; sub: ResourceKind; activeAt: number; inflight: number; calls: number };
export type McpServer = {
  name: string; color: string; slot: number; activeAt: number; calls: number; inflight: number; resources: Map<string, McpResource>;
  /** mcp_register `kind`: "model" = a resource group of only models (labelled "ML"), "database" = a database node
   *  (`db:<system>`, labelled "Database", its resources are collections / tables / indices); absent = MCP */
  kind?: ServerKind;
};
/** The kind of an MCP-style server node (mcp_register `kind`). */
export type ServerKind = "model" | "mcp" | "database" | "api" | "storage";
/** Database nodes are synthetic servers `db:<system>` (backend.py); every label shows the system only. */
export const DB_PREFIX = "db:";
export const DB_COLOR = "#38bdf8";
/** External API nodes are synthetic servers `api:<host>` (backend.py, kind "api"). */
export const API_PREFIX = "api:";
export const API_COLOR = "#a3e635";
/** Object-storage nodes: synthetic servers `storage:<host>` (backend.py auto-detect), or any manually-named
 * `agentglow.mcp(server, kind="storage")` server (primitives.py) -- blob stores like S3 / MinIO / GCS. */
export const STORAGE_PREFIX = "storage:";
export const STORAGE_COLOR = "#f59e0b";
/** the synthetic group pools / models / caches join by default (labelled "Backend", not MCP) */
export const BACKEND_GROUP = "backend";
/** A real MCP server (not a database, model hub, external API or the synthetic backend group). */
export const isRealMcp = (srv: Pick<McpServer, "kind" | "name">) => (srv.kind === undefined || srv.kind === "mcp") && srv.name !== BACKEND_GROUP;
/**
 * Visual weight of a side node: databases, model hubs and external API globes are drawn at about a service sun's size
 * (2.2x the MCP crystal), growing mildly with call volume (capped at +0.6); everything else 1.
 */
export const serverScale = (srv: Pick<McpServer, "kind" | "calls">) =>
  srv.kind === "database" || srv.kind === "model" || srv.kind === "api" || srv.kind === "storage"
    ? 2.2 + Math.min(0.6, Math.log10(1 + srv.calls) * 0.25)
    : 1;
/** the session has drawn at least one real MCP server */
export const hasRealMcp = () => {
  for (const s of world.mcpServers.values()) if (isRealMcp(s)) return true;
  return false;
};
export const isDatabase = (srv: Pick<McpServer, "kind"> | undefined) => srv?.kind === "database";
/** Display name of a server: `db:elasticsearch` -> `elasticsearch`, anything else unchanged. */
export const serverLabel = (name: string) =>
  name.startsWith(DB_PREFIX) && world.mcpKinds.get(name) === "database"
    ? name.slice(DB_PREFIX.length)
    : name.startsWith(API_PREFIX) && world.mcpKinds.get(name) === "api"
      ? name.slice(API_PREFIX.length)
      : name.startsWith(STORAGE_PREFIX) && world.mcpKinds.get(name) === "storage"
        ? name.slice(STORAGE_PREFIX.length)
        : name;
/** What one resource of a database node is called: an index (search engines), a table (SQL), a collection. */
export function collectionNoun(server: string): string {
  const sys = serverLabel(server).toLowerCase();
  if (/elastic|opensearch|solr|meili|typesense/.test(sys)) return "index";
  if (/postgres|mysql|mariadb|sqlite|mssql|oracle|db2|cockroach|snowflake|bigquery|redshift|clickhouse|duckdb|trino|presto/.test(sys)) return "table";
  if (/redis|valkey|memcache/.test(sys)) return "keyspace";
  if (/falkor|neo4j|graph|memgraph/.test(sys)) return "graph";
  return "collection";
}
const plural = (n: string) => (n === "index" ? "indices" : `${n}s`);
/** "indices", "tables", "collections" */
export const collectionNouns = (server: string) => plural(collectionNoun(server));
/** One MCP request/response: a packet flying instance → server ("call") or server → instance ("result"). */
export type McpCall = { id: number; run: string; instance: string; server: string; tool: string; resource?: string; phase: "call" | "result"; start: number; dur: number };
/** An MCP call that has been sent but not answered yet: draw a live tether instance ↔ server while it waits. */
export type McpPending = { key: string; run: string; instance: string; server: string; tool: string; resource?: string; since: number };
export const MCP_COLORS: Record<string, string> = {
  warehouse: "#f97316",
  search: "#22d3ee",
  github: "#e5e7eb",
  slack: "#e879f9",
  "google-drive": "#facc15",
  analytics: "#06b6d4",
};

/** A graph node lit by a read / write. `area`: lit for an event that named no node (no name label). `search`: a
 * scene-search match kept lit (search.ts; no instance, no beam). */
export type Flare = { id: number; run: string; instance: string; node: string; op: "read" | "write"; start: number; area?: boolean; search?: boolean };

/** Finished (exit done/failed) - drawn dimmed until its run ends, then faded out with the whole run. */
/** The label prefix of an MCP-style server: "ML" for a resource group holding only models, else "MCP". */
export const mcpPrefix = (srv: Pick<McpServer, "kind"> & { name?: string }) =>
  srv.kind === "model" ? modelGroupPrefix(srv.name)
    : srv.kind === "database" ? "Database"
    : srv.kind === "api" ? "API"
    : srv.kind === "storage" ? "Storage"
    : srv.name === BACKEND_GROUP ? "Backend"
    : "MCP";
/** A model group's label prefix from what it holds: "LLM" (only language models), "ML" (only classic ML models, or
 *  nothing known yet: the label older streams got), "Models" (both). */
export function modelGroupPrefix(name: string | undefined): string {
  const kinds = new Set<string>();
  if (name !== undefined) {
    for (const k of world.mcpRegistry.get(name)?.values() ?? []) kinds.add(k);
    for (const r of world.mcpServers.get(name)?.resources.values() ?? []) kinds.add(r.sub);
  }
  return kinds.has("llm") ? (kinds.has("model") ? "Models" : "LLM") : "ML";
}
/** "MCP · github", "Backend", "API · api.mistral.ai", "ML · payment-integrity scorer", "LLM · mistral", "Database · elasticsearch": the one server label
 *  every theme draws. */
export const mcpTitle = (srv: Pick<McpServer, "kind" | "name">) =>
  srv.kind === undefined && srv.name === BACKEND_GROUP
    ? "Backend"
    : `${mcpPrefix(srv)} · ${srv.kind === "database" ? srv.name.replace(DB_PREFIX, "") : srv.kind === "api" ? srv.name.replace(API_PREFIX, "") : srv.kind === "storage" ? srv.name.replace(STORAGE_PREFIX, "") : srv.name}`;

export const isDone = (i: Instance) => i.doneAt > 0;
/** Working: not finished and not fading out (HUD "alive", LOD budget, cluster counts). */
export const isLive = (i: Instance) => !i.doneAt && !i.exitAt;
/** A started run whose agents are all finished and that got no completion for this long fades out anyway (ms). */
export const ORPHAN_RUN_MS = 120_000;
/** A finished subagent (has a parent) fades after this long even if its run is still active (e.g. a long-lived
 * session whose root agent never finishes) - otherwise it would stay dimmed forever waiting for a run end
 * that, for that kind of run, never comes. Root/main agents are unaffected: they still fade with their run. */
export const SUBAGENT_DONE_MS = 3000;

/** How long finished instances/runs stay visible while fading out (ms). */
export const FADE_MS = 2500;
export const RUN_LINGER_MS = 6000;
/** Exit-fade length hook: lod.ts shortens it when the scene is crowded. Use `lingerMs(i)` instead of FADE_MS. */
export const linger = { fadeMs: (_i: Instance): number => FADE_MS };
/** How long this exited instance stays visible while fading out (ms). */
export const lingerMs = (i: Instance) => linger.fadeMs(i);

export const world = {
  runs: new Map<string, Run>(),
  instances: new Map<string, Instance>(),
  comets: [] as Comet[],
  flares: [] as Flare[],
  /**
   * MCP servers agents have CALLED (an `mcp` event). Registration alone (`mcp_register`) does not add one here:
   * it only fills mcpRegistry (names / backend kinds) so a newly used server looks right immediately.
   * Visibility over time: mcpWanted(srv) (shown while used, hidden after MCP_IDLE_MS idle).
   */
  mcpServers: new Map<string, McpServer>(),
  /** registered (not necessarily used) MCP servers: server -> backend name -> kind */
  mcpRegistry: new Map<string, Map<string, ResourceKind>>(),
  /** resource group kinds from mcp_register (`kind`), so a server drawn later gets its ML / MCP label */
  mcpKinds: new Map<string, ServerKind>(),
  mcpCalls: [] as McpCall[],
  /** in-flight MCP calls keyed `${instance}|${server}|${tool}`; resolvedAt kept briefly for a "snap back" effect */
  mcpPending: new Map<string, McpPending>(),
  mcpResolved: [] as (McpPending & { resolvedAt: number })[],
  /** MCP tool name -> the server it was last called on (a guard deny on that tool flashes the line to it) */
  mcpTools: new Map<string, string>(),
  ticker: [] as WorldEvent[],
  stats: { runs: 0, spawned: 0, llmCalls: 0, tokens: 0, toolCalls: 0, graphReads: 0, graphWrites: 0, mcpCalls: 0, decisions: 0, decisionMs: 0, requests: 0, errors: 0, rejected: 0 },
  /** decisions per provider (jev / laya / llm ...): count + summed latency (HUD chip tooltip) */
  decisionProviders: new Map<string, { n: number; ms: number }>(),
  /** session-wide decision rate (HUD): last full second's rate, deny share, p50/p95, 60 s sparkline (per second) */
  rate: { perS: 0, deny: 0, p50: 0, p95: 0, spark: [] as number[], rollAt: 0, acc: { n: 0, deny: 0, msN: 0, p50: 0, p95: 0 } },
  /** orders seen: total, paper (dry_run), rejected/cancelled */
  orders: { n: 0, paper: 0, rejected: 0 },
  lastFinal: "" as string,
  simulated: false,
  mode: "connecting" as "connecting" | "sim" | "live",
  /** label for the graph/memory structure: names the DB only when the server provides a real graph */
  graphLabel: "knowledge graph",
  /**
   * True once this session USES a knowledge graph: a `graph` read/write event arrived, or sim mode (the
   * simulator emits graph events). A served /live/graph sample alone does not flip it (it only supplies the
   * real nodes to draw once the graph is used). Sticky for the session. When false, scenes draw
   * no graph centerpiece and let the agents take the center. Use `graphMix()` in useFrame for a smooth 0..1.
   */
  hasGraph: false,
  /** performance.now() when hasGraph flipped true (drives the fade-in / layout ease) */
  hasGraphAt: 0,
  /** runs that touched the graph; the side graph shows while one of them is live (see graphShown) */
  graphRuns: new Set<string>(),
  /** performance.now() of the last graph event */
  graphAt: 0,
  focus: null as string | null, // instance id most recently active
  focusAt: 0,
  /** last `task` / `Agent` tool call (performance.now()): a subagent is about to spawn (FitCamera batches it) */
  spawnHintAt: 0,
  /** exited instances kept for the agent panel after their shape fades (newest last, capped) */
  archive: new Map<string, Instance>(),
  /** instance selected in the agent panel or by clicking a shape */
  selected: null as string | null,
  /** a resource selected instead (MCP server / group, backend, agent -> server link): the Resource details panel */
  selectedRes: null as ResSel | null,
  /** the server answered 401 for this scope/run/token (the HUD shows a notice; no simulator fallback) */
  unauthorized: false,
  /** desk-wide halts (global-scope guard denies, see Halt), keyed by the owning agent */
  halts: new Map<string, Halt>(),
  /** transient dashed edges: fallbacks and completed deferred callbacks (prims.ts) */
  primEdges: [] as PrimEdge[],
  /** broker backlog per topic (prims.ts) */
  backlogs: new Map<string, Backlog>(),
  /** resource stats (pools, caches, models) keyed `server|resource` */
  resStats: new Map<string, ResStat>(),
  /** message topics between two services (`mkt:tick` feed -> worker), keyed `from|to|topic`: a persistent edge */
  topics: new Map<string, SvcTopic>(),
  /** service -> agent run it drives (`drives`), keyed `svc|run` */
  drives: new Map<string, { svc: string; run: string }>(),
};

/** A topic between two services: first / last message (performance.now()), messages seen, the last one failed. */
export type SvcTopic = { from: string; to: string; topic: string; first: number; at: number; n: number; failed: boolean };
/** a topic edge stays drawn this long after its last message */
export const TOPIC_STALE_MS = 15_000;
const TOPICS_MAX = 64;

/**
 * A desk-wide halt: a guard decision with `scope: "global"` (docs/SPEC.md "Decisions") said no, e.g. a kill switch.
 * Owned by the topmost agent that reports global guards (a desk), drawn ONCE on it (red, `HALTED · <reason>`) instead
 * of a red X on every agent below it; their own global denies only flash their halos. Ends when every global guard
 * the owner said no to says yes again, or the owner / its run ends.
 */
export type Halt = { id: string; run: string; reason: string; since: number; end: number; qs: Map<string, boolean> };
/** agents that sent a global-scope decision (halt owners are the topmost of them) */
const globalBy = new Set<string>();
/** the halt owner for a global decision of `id`: its topmost ancestor that reports global guards itself */
function haltOwner(id: string): string {
  let own = id;
  let cur = world.instances.get(id);
  for (let k = 0; cur?.parent && k < 32; k++) {
    if (globalBy.has(cur.parent)) own = cur.parent;
    cur = world.instances.get(cur.parent);
  }
  return own;
}
/** a halt reason from a guard question: `kill switch off` -> `kill switch` */
const reasonOf = (q: string) => q.replace(/\s*(\?|\bok\b|\boff\b|\bon\b)\s*$/i, "").trim() || q;
function globalDecision(ev: Extract<WorldEvent, { type: "decision" }>, now: number): boolean {
  globalBy.add(ev.id);
  const own = haltOwner(ev.id);
  if (own !== ev.id) return false; // under a halt owner: the owner shows the state
  if (ev.kind !== "noul" || ev.purpose !== "guard") return true;
  let h = world.halts.get(own);
  const deny = ev.result === "no";
  if (!h || h.end) {
    if (!deny) return true;
    h = { id: own, run: ev.run_id, reason: "", since: now, end: 0, qs: new Map() };
    world.halts.set(own, h);
  }
  h.qs.set(ev.question, deny);
  if (deny && (!h.reason || ev.why === "important")) h.reason = reasonOf(ev.question);
  if (![...h.qs.values()].some(Boolean)) h.end = now;
  return true;
}
/** the halt shown on agent `id` right now (also while it fades out after the end), if any */
export function haltOn(id: string, now = performance.now()): Halt | undefined {
  const h = world.halts.get(id);
  if (!h) return undefined;
  const i = world.instances.get(id);
  if (!h.end && (!i || i.exitAt)) h.end = now;
  if (h.end && now - h.end > HALT_FADE_MS) {
    world.halts.delete(id);
    return undefined;
  }
  return h;
}
export const HALT_FADE_MS = 900;
/** some agent is halted now (HUD chip) */
export function haltedNow(now = performance.now()): Halt | undefined {
  for (const h of world.halts.values()) if (haltOn(h.id, now) && !h.end) return h;
  return undefined;
}
const ARCHIVE_MAX = 500;

let seq = 0;
let version = 0;
const subs = new Set<() => void>();
const notify = () => {
  version++;
  subs.forEach((f) => f());
};
/** Subscribe a React component to world changes (HUD / DOM). Scenes should read `world` in useFrame instead. */
export function useWorld() {
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => version,
  );
  return world;
}

/** Stable pseudo-random 0..1 from a string (same id → same value, different ids → different values). */
export const hash01 = (id: string, salt = 0) => {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10007) / 10007;
};

function freeSlot(): number {
  const used = new Set([...world.runs.values()].map((r) => r.slot));
  const free = [0, 1, 2, 3, 4, 5].filter((s) => !used.has(s)); // random free lane so runs don't always land in the same place
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  let s = 6;
  while (used.has(s)) s++;
  return s;
}

const SEG_SCRATCH = new Array<number>(HALO_CATS.length).fill(0);
/** high volume: most individual decision glyphs on screen at once (all agents) */
export const HV_GLYPHS_MAX = 3;
/** an equally important newer glyph may replace one only after it showed this long (no flicker in a deny storm) */
const HV_MIN_SHOW_MS = 650;
const hvShown: DecisionUse[] = [];
const hvScore = (d: DecisionUse) => (d.why === "important" ? 4 : isDeny(d) ? 3 : d.why === "flip" ? 2 : 1);
/** admit a high-volume glyph: free place, else pre-empt the least important (then oldest) one if this one is at
 *  least as important (newest wins a tie); false = not shown (the caller flashes the agent's halo instead) */
function admitHv(d: DecisionUse, now: number): boolean {
  for (let k = hvShown.length - 1; k >= 0; k--) {
    const x = hvShown[k];
    if (x.cut || now - x.at >= decisionLife(x)) hvShown.splice(k, 1);
  }
  if (hvShown.length >= HV_GLYPHS_MAX) {
    // victim: the least important, then oldest glyph that may go (shown long enough, or less important than d)
    let v = -1;
    for (let k = 0; k < hvShown.length; k++) {
      const a = hvShown[k];
      if (hvScore(a) > hvScore(d) || (hvScore(a) === hvScore(d) && now - a.at < HV_MIN_SHOW_MS)) continue;
      const b = v >= 0 ? hvShown[v] : null;
      if (!b || hvScore(a) < hvScore(b) || (hvScore(a) === hvScore(b) && a.at < b.at)) v = k;
    }
    if (v < 0) {
      d.hidden = true;
      return false;
    }
    hvShown[v].cut = now;
    hvShown.splice(v, 1);
  }
  hvShown.push(d);
  return true;
}
/*
 * Clear view (per viewer, docs/SPEC.md "Clear view"): hide everything drawn so far and draw only events with
 * `ts >= clearedAt` from then on. Nothing is deleted on the server and other viewers are unaffected.
 * Events older than the clear are dropped by apply(), except metadata that draws nothing (mcp_register,
 * graph_nodes). A run or agent started before the clear that is still working re-appears on its next event:
 * `shadowRuns` / `shadowSpawns` remember what was open at the clear (and what a replay after a refresh opened
 * before it), and the first newer event that names one re-creates it as if it started then (partial is fine).
 */
let clearedAt = 0;
const clearSubs = new Set<() => void>();
const shadowRuns = new Map<string, Extract<WorldEvent, { type: "run" }>>();
const shadowSpawns = new Map<string, Extract<WorldEvent, { type: "spawn" }>>();
/** sim mode only: raw events seen this session (capped), replayed by showAllView() (live mode re-reads the server) */
const simLog: WorldEvent[] = [];
const SIM_LOG_MAX = 50_000;

/** epoch ms of this viewer's clear (0 = not cleared) */
export const viewClearedAt = () => clearedAt;
/** React hook: the clear timestamp (0 = showing everything) */
export function useClearedAt(): number {
  return useSyncExternalStore(
    (f) => (clearSubs.add(f), () => clearSubs.delete(f)),
    () => clearedAt,
    () => 0,
  );
}
function setClearedAtValue(t: number) {
  if (clearedAt === t) return;
  clearedAt = t;
  clearSubs.forEach((f) => f());
}

/** remember an older-than-clear event that opens / closes a run or an agent (for re-appearing later) */
function shadowNote(ev: WorldEvent) {
  if (ev.type === "run") {
    if (ev.status === "started") shadowRuns.set(ev.run_id, ev);
    else if (ev.status === "completed" || ev.status === "failed") shadowRuns.delete(ev.run_id);
  } else if (ev.type === "spawn") shadowSpawns.set(ev.id, ev);
  else if (ev.type === "exit") shadowSpawns.delete(ev.id);
}

/** a newer event names a run / agent hidden by the clear: re-create it first (parents before children) */
function revive(ev: WorldEvent, ts: number) {
  if (!shadowRuns.size && !shadowSpawns.size) return;
  const runId = "run_id" in ev ? (ev.run_id as string | undefined) : undefined;
  if (ev.type === "run" || ev.type === "exit") {
    // an end needs no re-creation: forget it
    if (ev.type === "run" && runId && ev.status !== "started" && ev.status !== "renamed" && ev.status !== "idle" && ev.status !== "active") shadowRuns.delete(runId);
    if (ev.type === "exit") shadowSpawns.delete(ev.id);
    return;
  }
  const reviveRun = (id: string | undefined) => {
    const r = id ? shadowRuns.get(id) : undefined;
    if (!r || world.runs.has(r.run_id)) return;
    shadowRuns.delete(r.run_id);
    applyNow({ ...r, ts });
  };
  const reviveAgent = (id: unknown, depth = 0) => {
    if (typeof id !== "string" || world.instances.has(id) || depth > 16) return;
    const s = shadowSpawns.get(id);
    if (!s) return;
    shadowSpawns.delete(id);
    reviveRun(s.run_id);
    if (s.parent_id) reviveAgent(s.parent_id, depth + 1);
    applyNow({ ...s, ts, ...(s.job ? { since: s.since ?? s.ts } : {}) });
  };
  reviveRun(runId);
  const e = ev as { id?: unknown; from_id?: unknown; to_id?: unknown; parent_id?: unknown };
  if (ev.type === "spawn") reviveAgent(e.parent_id);
  else reviveAgent(e.id);
  if (ev.type === "message") (reviveAgent(e.from_id), reviveAgent(e.to_id));
}

/** Apply one world event (stream, replay or simulator). Honours this viewer's clear (see clearView). */
export function apply(ev: WorldEvent) {
  if (world.mode === "sim") {
    simLog.push(ev);
    if (simLog.length > SIM_LOG_MAX) simLog.splice(0, simLog.length - SIM_LOG_MAX);
  }
  if (clearedAt) {
    const ts = typeof ev.ts === "number" ? ev.ts : 0;
    if (ts && ts < clearedAt && ev.type !== "mcp_register" && ev.type !== "graph_nodes") {
      shadowNote(ev);
      return;
    }
    revive(ev, ts || Date.now());
  }
  applyNow(ev);
}

/** Empty the drawn world but keep the connection state (mode, graph backdrop, MCP registry). */
function emptyWorld() {
  const keep = { mode: world.mode, simulated: world.simulated, unauthorized: world.unauthorized, graphLabel: world.graphLabel, hasGraph: world.hasGraph, hasGraphAt: world.hasGraphAt };
  const registry = new Map(world.mcpRegistry);
  const kinds = new Map(world.mcpKinds);
  resetWorld();
  Object.assign(world, keep);
  for (const [k, v] of registry) world.mcpRegistry.set(k, v);
  for (const [k, v] of kinds) world.mcpKinds.set(k, v);
  notify();
}

/**
 * Clear this viewer's view at `at` (epoch ms, default now): everything drawn so far is hidden (runs, agents,
 * services, MCP servers, graph glow, events, counters) and only events with `ts >= at` draw from then on. Runs and
 * agents still open at the clear re-appear on their next event. Connection-level code persists the timestamp.
 */
export function clearWorldAt(at = Date.now()) {
  shadowRuns.clear();
  shadowSpawns.clear();
  for (const r of world.runs.values()) {
    if (r.status !== "started") continue;
    shadowRuns.set(r.id, { type: "run", run_id: r.id, status: "started", topic: r.topic, workflow: r.workflow, ts: at });
  }
  for (const i of world.instances.values()) {
    if (i.doneAt || i.exitAt) continue;
    shadowSpawns.set(i.id, { type: "spawn", run_id: i.run, id: i.id, agent: i.name, parent_id: i.parent, subagent: i.subagent, ...(i.job ? { job: true, since: i.job.since } : {}), ts: at });
  }
  setClearedAtValue(at);
  emptyWorld();
}

/**
 * Set the clear timestamp without touching what is drawn: for a world that is about to be (re)filled from a replay
 * (page load with a persisted clear). 0 = no clear.
 */
export function setViewClearedAt(at: number) {
  shadowRuns.clear();
  shadowSpawns.clear();
  setClearedAtValue(at > 0 ? at : 0);
}

/** Undo the clear: empty the world and, in sim mode, replay this session's events (live mode re-reads the server). */
export function unclearWorld(replaySim: boolean) {
  setViewClearedAt(0);
  emptyWorld();
  if (replaySim) {
    const log = simLog.splice(0);
    for (const ev of log) apply(ev);
  }
}

/** forget the sim log (a fresh connection) */
export function resetSimLog() {
  simLog.length = 0;
}

/** high-frequency event types: no immediate React notify (the HUD catches up within HUD_NOTIFY_MS) */
const QUIET = new Set(["decision", "decision_stats", "order", "request", "service_stats", "drives", ...PRIM_QUIET]);
const HUD_NOTIFY_MS = 250;
let dirty = false;
let notifiedAt = 0;

function applyNow(ev: WorldEvent) {
  const now = performance.now();
  const evRun = "run_id" in ev ? world.runs.get(ev.run_id as string) : undefined;
  if (evRun) evRun.lastEventAt = now;
  if ("run_id" in ev && dismissed.size) undismissOnActivity(ev);
  // stats windows are not log lines (the halo shows them); everything else goes to the event log
  if (ev.type !== "mcp_register" && ev.type !== "graph_nodes" && ev.type !== "decision_stats" && ev.type !== "service_stats" && ev.type !== "drives" && !PRIM_NO_LOG.has(ev.type) && !(ev.type === "session" && ev.phase === "progress")) {
    world.ticker.unshift(ev);
    if (world.ticker.length > 60) world.ticker.length = 60;
  }
  if (PRIM_TYPES.has(ev.type)) applyPrim(world, ev as PrimWorldEvent, now);
  switch (ev.type) {
    case "run": {
      if (ev.status === "renamed") {
        const r = world.runs.get(ev.run_id);
        if (r) r.topic = ev.topic; // e.g. a Claude Code session /rename: label only, run state untouched
      } else if (ev.status === "idle" || ev.status === "active") {
        if (evRun) evRun.idleSince = ev.status === "idle" ? ev.since || ev.ts || Date.now() : 0;
      } else if (ev.status === "started") {
        const slot = freeSlot();
        world.runs.set(ev.run_id, {
          id: ev.run_id,
          topic: ev.topic,
          workflow: ev.workflow,
          color: RUN_COLORS[slot % RUN_COLORS.length],
          slot,
          status: "started",
          steps: {},
          waits: {},
          stepOrder: [],
          hasSteps: false,
          startedAt: now,
          endedAt: 0,
          handoffAt: 0,
          handoffFrom: 0,
          handoffTo: 0,
          lastDone: "",
          final: "",
          lastEventAt: now,
          idleSince: 0,
        });
        world.stats.runs++;
      } else {
        const r = world.runs.get(ev.run_id);
        if (r) {
          r.status = ev.status;
          r.endedAt = now;
        }
        for (const [k, d] of world.drives) if (d.run === ev.run_id) world.drives.delete(k);
        // the run ended: its finished (dimmed) agents and any stragglers fade out together
        for (const i of world.instances.values()) if (i.run === ev.run_id && !i.exitAt) i.exitAt = now;
      }
      break;
    }
    case "step": {
      const r = world.runs.get(ev.run_id);
      if (!r) break;
      r.hasSteps = true;
      if (!(ev.step in r.steps)) r.stepOrder.push(ev.step);
      const was = r.steps[ev.step];
      const status = ev.status === "waiting" ? "running" : ev.status; // waiting = running but paused
      r.steps[ev.step] = status; // a retry just overwrites: failed → running → done
      if (ev.status === "waiting") r.waits[ev.step] = waitOf(ev);
      else delete r.waits[ev.step];
      if (status === "done") r.lastDone = ev.step;
      if (status === "running" && was !== "running") {
        // hand off from the step that finished last, else from one still running; skipped within a slot
        // (parallel siblings, retries in place)
        const prev = r.lastDone || r.stepOrder.find((s) => s !== ev.step && r.steps[s] === "running");
        const from = prev ? stepSlot(r, prev) : -1;
        const to = stepSlot(r, ev.step);
        if (from >= 0 && from !== to) {
          r.handoffAt = now;
          r.handoffFrom = from;
          r.handoffTo = to;
        }
      }
      break;
    }
    case "spawn": {
      const subagent = ev.subagent ?? ev.agent.endsWith("_scout");
      const index = [...world.instances.values()].filter((i) => i.run === ev.run_id).length;
      world.instances.set(ev.id, {
        id: ev.id,
        run: ev.run_id,
        type: roleOf(ev.agent, subagent),
        name: ev.agent,
        parent: ev.parent_id,
        status: "spawning",
        subagent,
        bornAt: now,
        doneAt: 0,
        exitAt: 0,
        pulse: 0.8,
        pulseAt: now,
        tokens: 0,
        tokensCached: 0,
        index,
        recent: [],
        llmCalls: 0,
        toolCalls: 0,
        mcpCalls: 0,
        nodes: new Set(),
        skills: new Map(),
        skill: "",
        skillEndAt: 0,
        decisions: [],
        hv: null,
        orders: [],
        chat: [],
        wait: null,
        ...(ev.job ? { job: { since: ev.since ?? ev.ts, end: 0 } } : {}),
      });
      world.stats.spawned++;
      world.focus = ev.id;
      world.focusAt = now;
      break;
    }
    case "exit": {
      const i = world.instances.get(ev.id);
      if (i) {
        i.status = ev.status;
        i.wait = null;
        i.doneAt = now;
        if (i.job) {
          i.job.end = ev.ts;
          i.flash = { at: now, ok: ev.status === "done" };
        }
        // stays dimmed until its run ends; no known (or an already ended) run, or a subagent replayed (e.g. on
        // page refresh) already genuinely old in real wall-clock time: fade right away instead of waiting again.
        // ev.ts and Date.now() are both real epoch ms (backend's now_ms() = time.time()*1000) - safe to compare
        // directly, unlike performance.now() (page-relative, not epoch-based) which must never mix with ev.ts.
        const r = world.runs.get(i.run);
        const staleReplay = !!i.parent && Date.now() - ev.ts > SUBAGENT_DONE_MS;
        if (!r || r.endedAt || staleReplay) i.exitAt = now;
      }
      for (const [k, p] of world.mcpPending) if (p.instance === ev.id) world.mcpPending.delete(k);
      if (i && i.skill && !i.skillEndAt) {
        // finished without a skill "end": close its skills so their sigils fade with it
        for (const u of i.skills.values()) if (u.active) (u.active = false), (u.endAt = now);
        i.skillEndAt = now;
      }
      break;
    }
    case "agent": {
      const i = world.instances.get(ev.id);
      if (i) {
        i.status = ev.status;
        i.wait = ev.status === "waiting" && ev.reason ? waitOf(ev) : null;
      }
      if (ev.status === "thinking") {
        world.focus = ev.id;
        world.focusAt = now;
      }
      break;
    }
    case "llm": {
      const i = world.instances.get(ev.id);
      if (i) {
        i.pulse = Math.min(2.5, 0.6 + (ev.tokens_in + ev.tokens_out) / 1500);
        i.pulseAt = now;
        i.tokens += ev.tokens_in + ev.tokens_out;
        i.tokensCached += ev.tokens_cached ?? 0;
        i.llmCalls++;
      }
      world.stats.llmCalls++;
      world.stats.tokens += ev.tokens_in + ev.tokens_out;
      break;
    }
    case "message":
      svcTraffic(world.instances.get(ev.from_id), evAt(ev, now));
      if (ev.to_id) svcTraffic(world.instances.get(ev.to_id), evAt(ev, now));
      if (ev.from_id !== ev.to_id && ev.from_id.startsWith("svc:") && ev.to_id?.startsWith("svc:")) {
        const key = `${ev.from_id}|${ev.to_id}|${ev.text}`;
        const t = world.topics.get(key);
        if (t) (t.at = now), t.n++, (t.failed = !!ev.failed);
        else {
          if (world.topics.size >= TOPICS_MAX) world.topics.delete(world.topics.keys().next().value!);
          world.topics.set(key, { from: ev.from_id, to: ev.to_id, topic: ev.text, first: now, at: now, n: 1, failed: !!ev.failed });
        }
      }
      // a failed publish: a short comet flagged `failed` (it sputters out half way, Fizzle.tsx)
      world.comets.push({ id: ++seq, run: ev.run_id, from: ev.from_id, to: ev.to_id || ev.from_id, start: now, dur: ev.failed ? 700 : 1300, text: ev.text, ...(ev.failed ? { failed: true } : {}) });
      world.focus = ev.to_id;
      world.focusAt = now;
      break;
    case "tool": {
      world.stats.toolCalls++;
      if (/^(task|agent)$/i.test(ev.tool)) world.spawnHintAt = now;
      const i = world.instances.get(ev.id);
      if (i) {
        i.pulse = Math.max(i.pulse, 0.5);
        i.pulseAt = now;
        i.toolCalls++;
      }
      break;
    }
    case "skill": {
      const i = world.instances.get(ev.id);
      if (!i) break;
      let u = i.skills.get(ev.name);
      if (!u) i.skills.set(ev.name, (u = { active: false, count: 0, last: now, startAt: 0, endAt: 0 }));
      u.last = now;
      if (ev.status === "start") {
        // a start while its sigil is still up keeps it up (no second fade-in), else it eases in
        const shown = u.count > 0 && (!u.endAt || now < skillOffAt(u) + SKILL_OUT_MS);
        u.startAt = shown ? now - Math.min(SKILL_IN_MS, now - u.startAt) : now;
        u.endAt = 0;
        u.active = true;
        u.count++;
        i.skill = ev.name;
        i.skillEndAt = 0;
      } else if (u.active) {
        u.active = false;
        u.endAt = now;
        // another skill still running: `skill` switches to the newest one, else all ended now
        let other = "";
        for (const [n, v] of i.skills) if (v.active && (!other || v.startAt > i.skills.get(other)!.startAt)) other = n;
        if (other) i.skill = other;
        else i.skillEndAt = now;
      }
      break;
    }
    case "decision": {
      const i = world.instances.get(ev.id);
      const hv = !!ev.hv || (!!i && hvActive(i, now));
      if (!hv) {
        // counted here only outside high-volume mode (there `decision_stats` counts every decision)
        world.stats.decisions++;
        world.stats.decisionMs += ev.ms;
        const pv = world.decisionProviders.get(ev.provider) ?? { n: 0, ms: 0 };
        pv.n++;
        pv.ms += ev.ms;
        world.decisionProviders.set(ev.provider, pv);
        const a = world.rate.acc;
        a.n++;
        if (isDeny(ev)) a.deny++;
        a.msN++;
        a.p50 += ev.ms;
        a.p95 += ev.ms;
      }
      if (!i) break;
      if (i.status === "spawning") i.status = "thinking"; // a code agent (no LLM) deciding is working, not spawning
      // desk-wide guards (scope "global"): the owner shows ONE halted state (Halt), no glyph; below it a global deny
      // only flashes the halo. Both stay in the agent's decision list.
      let hide = false;
      if (ev.scope === "global") {
        const owner = globalDecision(ev, now);
        if (!owner && isDeny(ev) && i.hv) (i.hv.bump = now), (i.hv.bumpDeny = true);
        hide = owner || isDeny(ev);
      }
      const last = i.decisions[i.decisions.length - 1];
      const { type: _t, run_id: _r, id: _i, ...d } = ev;
      // high volume: no stagger (one glyph per agent at a time) and at most HV_GLYPHS_MAX on screen
      const use: DecisionUse = { ...d, hv, at: hv || hide || !last ? now : Math.max(now, last.at + DECISION_STAGGER_MS) };
      if (hide) use.hidden = true;
      else if (hv && !admitHv(use, now) && i.hv) {
        i.hv.bump = now;
        i.hv.bumpDeny = isDeny(use);
      }
      i.decisions.push(use);
      if (i.decisions.length > DECISIONS_KEPT) i.decisions.shift();
      break;
    }
    case "decision_stats": {
      world.stats.decisions += ev.n;
      world.stats.decisionMs += ev.p50_ms * ev.n;
      for (const [p, c] of Object.entries(ev.providers)) {
        const pv = world.decisionProviders.get(p) ?? { n: 0, ms: 0 };
        pv.n += c;
        pv.ms += ev.p50_ms * c;
        world.decisionProviders.set(p, pv);
      }
      const b = ev.by_purpose;
      const a = world.rate.acc;
      a.n += ev.n;
      a.deny += b.guard?.deny ?? 0;
      a.msN += ev.n;
      a.p50 += ev.p50_ms * ev.n;
      a.p95 += ev.p95_ms * ev.n;
      const i = world.instances.get(ev.id);
      if (!i || ev.n <= 0) break;
      if (i.status === "spawning") i.status = "thinking"; // a code agent (no LLM) deciding is working, not spawning
      // outcome shares this window, in HALO_CATS order
      const seg = SEG_SCRATCH.fill(0);
      if (b.guard) (seg[0] += b.guard.allow), (seg[1] += b.guard.deny);
      if (b.check) (seg[2] += b.check.yes), (seg[3] += b.check.no), (seg[8] += Math.max(0, b.check.n - b.check.yes - b.check.no));
      if (b.route) for (const [name, c] of Object.entries(b.route.results)) seg[name === "other" ? 8 : routeSlot(name)] += c;
      const tot = seg.reduce((x, y) => x + y, 0) || 1;
      const rate = (ev.n * 1000) / Math.max(1, ev.window_ms);
      const deny = (b.guard?.deny ?? 0) / ev.n;
      let top = "", topN = -1;
      for (const [p, c] of Object.entries(ev.providers)) if (c > topN) (top = p), (topN = c);
      const h = i.hv;
      if (!h || now - h.at > HV_QUIET_MS + HV_FADE_MS) {
        i.hv = { at: evAt(ev, now), bump: h?.bump ?? 0, bumpDeny: h?.bumpDeny ?? false, rate, deny, p50: ev.p50_ms, p95: ev.p95_ms, seg: seg.map((x) => x / tot), provider: top || "llm", n: ev.n, windows: h ? h.windows : 0 };
      } else {
        const k = HV_ALPHA;
        h.at = evAt(ev, now);
        h.rate += (rate - h.rate) * k;
        h.deny += (deny - h.deny) * k;
        h.p50 += (ev.p50_ms - h.p50) * k;
        h.p95 += (ev.p95_ms - h.p95) * k;
        for (let j = 0; j < seg.length; j++) h.seg[j] += (seg[j] / tot - h.seg[j]) * k;
        h.provider = top || h.provider;
        h.n = ev.n;
        h.windows++;
      }
      break;
    }
    case "request": {
      // an individual request pulses the service, an error flashes its halo red (counted by `service_stats`)
      const i = world.instances.get(ev.id);
      if (ev.rejected) noteRejected(world, i, ev.status ? `${ev.status}` : "busy", now);
      if (!i) break;
      svcTraffic(i, evAt(ev, now));
      i.pulse = Math.max(i.pulse * Math.exp(-((now - i.pulseAt) / 1000) * 2.2), ev.error ? 1.2 : 0.7);
      i.pulseAt = now;
      if (ev.error && !ev.rejected) {
        if (!i.hv) i.hv = { at: now, bump: 0, bumpDeny: false, rate: 0, deny: 0, p50: ev.ms, p95: ev.ms, seg: SEG_SCRATCH.map(() => 0), provider: "", n: 0, windows: 0, unit: ev.kind === "http" ? "req" : "msg" };
        i.hv.bump = now;
        i.hv.bumpDeny = true;
      }
      break;
    }
    case "service_stats": {
      // every request is counted here (the backend sends a window for each second with requests)
      world.stats.requests += ev.n;
      world.stats.errors += ev.errors;
      const i = world.instances.get(ev.id);
      if (!i) break;
      if (ev.n > 0 || ev.inflight) svcTraffic(i, evAt(ev, now));
      if (ev.inflight !== undefined && i.hv) i.hv.inflight = ev.inflight;
      if (ev.n <= 0) {
        // only long requests in flight: keep the halo (and its `N in flight` label) up
        if (!ev.inflight) break;
        if (i.hv) i.hv.at = now;
        else i.hv = { at: evAt(ev, now), bump: 0, bumpDeny: false, rate: 0, deny: 0, p50: 0, p95: 0, seg: SEG_SCRATCH.map((_, k) => (k === 8 ? 1 : 0)), provider: "msg", n: 0, windows: 0, unit: "msg", inflight: ev.inflight };
        break;
      }
      const c = ev.codes;
      const http = Object.keys(c).length > 0;
      const ok = http ? (c["1xx"] ?? 0) + (c["2xx"] ?? 0) + (c["3xx"] ?? 0) : ev.n - ev.errors;
      const seg = SEG_SCRATCH.fill(0);
      // halo arc: ok green, 5xx / errors red, 4xx amber, anything else grey
      seg[0] = ok;
      seg[1] = http ? c["5xx"] ?? 0 : ev.errors;
      seg[3] = (c["4xx"] ?? 0) + (c["rejected"] ?? 0); // rejected (admission / backpressure): amber, never in 5xx
      seg[8] = Math.max(0, ev.n - seg[0] - seg[1] - seg[3]);
      const tot = seg.reduce((x, y) => x + y, 0) || 1;
      const rate = (ev.n * 1000) / Math.max(1, ev.window_ms);
      const deny = ev.errors / ev.n;
      const unit = http ? "req" : "msg";
      const h = i.hv;
      if (!h || now - h.at > HV_QUIET_MS + HV_FADE_MS || !h.unit) {
        i.hv = { at: evAt(ev, now), bump: h?.bump ?? 0, bumpDeny: h?.bumpDeny ?? false, rate, deny, p50: ev.p50_ms, p95: ev.p95_ms, seg: seg.map((x) => x / tot), provider: unit, n: ev.n, windows: h ? h.windows : 0, unit, inflight: ev.inflight ?? h?.inflight };
      } else {
        const k = HV_ALPHA;
        h.at = evAt(ev, now);
        h.rate += (rate - h.rate) * k;
        h.deny += (deny - h.deny) * k;
        h.p50 += (ev.p50_ms - h.p50) * k;
        h.p95 += (ev.p95_ms - h.p95) * k;
        for (let j = 0; j < seg.length; j++) h.seg[j] += (seg[j] / tot - h.seg[j]) * k;
        h.n = ev.n;
        h.unit = unit;
        h.windows++;
      }
      i.hv!.instances = ev.instances ?? 1; // replicas of this service (`×2` on the halo label)
      i.svcN = (i.svcN ?? 0) + ev.n;
      i.svcErr = (i.svcErr ?? 0) + ev.errors;
      i.svcRoutes ??= new Map();
      for (const [r, n] of Object.entries(ev.routes ?? {})) if (i.svcRoutes.has(r) || i.svcRoutes.size < 64) i.svcRoutes.set(r, (i.svcRoutes.get(r) ?? 0) + n);
      i.svcCodes ??= new Map();
      for (const [c, n] of Object.entries(ev.codes ?? {})) i.svcCodes.set(c, (i.svcCodes.get(c) ?? 0) + n);
      break;
    }
    case "order": {
      world.orders.n++;
      if (ev.dry_run) world.orders.paper++;
      if (ev.status === "rejected" || ev.status === "cancelled") world.orders.rejected++;
      const i = world.instances.get(ev.id);
      if (!i) break;
      const { type: _t, run_id: _r, id: _i, ...o } = ev;
      i.orders.push({ ...o, at: now });
      if (i.orders.length > ORDERS_KEPT) i.orders.shift();
      break;
    }
    case "graph":
      // coming back after it faded with its run: fade in again instead of popping
      if (world.hasGraph && !graphShown(now)) world.hasGraphAt = now;
      setHasGraph(true, false);
      world.graphAt = now;
      if (ev.run_id) world.graphRuns.add(ev.run_id);
      world.instances.get(ev.id)?.nodes && ev.nodes.forEach((n) => world.instances.get(ev.id)!.nodes.add(n));
      // names outside the drawn sample become dynamic graph nodes (graphDyn.ts) so every touched node can glow
      touchGraph(ev.nodes, ev.kinds);
      for (const n of ev.nodes.slice(0, 20)) world.flares.push({ id: ++seq, run: ev.run_id, instance: ev.id, node: n, op: ev.op, start: now });
      // no node named: light a hashed area of the graph briefly so every hit is visible
      if (!ev.nodes.length) for (const n of areaNames(`${ev.id}:${seq}`)) world.flares.push({ id: ++seq, run: ev.run_id, instance: ev.id, node: n, op: ev.op, start: now, area: true });
      if (ev.op === "read") world.stats.graphReads += ev.nodes.length;
      else world.stats.graphWrites += ev.nodes.length;
      break;
    case "graph_nodes":
      if (Array.isArray(ev.nodes)) restoreGraph(ev.nodes);
      break;
    case "mcp_register": {
      // topology only: remember names/kinds; the server is drawn once an agent actually calls it
      let reg = world.mcpRegistry.get(ev.server);
      if (!reg) world.mcpRegistry.set(ev.server, (reg = new Map()));
      for (const r of ev.resources) if (!reg.has(r.name)) reg.set(r.name, r.kind);
      if (ev.kind) {
        world.mcpKinds.set(ev.server, ev.kind);
        const drawn = world.mcpServers.get(ev.server);
        if (drawn) {
          drawn.kind = ev.kind;
          if (ev.kind === "database" && !MCP_COLORS[ev.server]) drawn.color = DB_COLOR;
          if (ev.kind === "api" && !MCP_COLORS[ev.server]) drawn.color = API_COLOR;
          if (ev.kind === "storage" && !MCP_COLORS[ev.server]) drawn.color = STORAGE_COLOR;
        }
      }
      break;
    }
    case "mcp": {
      let srv = world.mcpServers.get(ev.server);
      if (!srv) {
        const kind = world.mcpKinds.get(ev.server);
        srv = { name: ev.server, color: MCP_COLORS[ev.server] ?? (kind === "database" ? DB_COLOR : kind === "api" ? API_COLOR : kind === "storage" ? STORAGE_COLOR : "#94a3b8"), slot: world.mcpServers.size, activeAt: now, calls: 0, inflight: 0, resources: new Map(), kind };
        world.mcpServers.set(ev.server, srv);
      }
      srv.activeAt = now;
      let res: McpResource | undefined;
      if (ev.resource) {
        res = srv.resources.get(ev.resource);
        if (!res) {
          const sub = ev.resource_kind ?? world.mcpRegistry.get(ev.server)?.get(ev.resource) ?? "api";
          res = { name: ev.resource, kind: shapeKind(sub), sub, activeAt: now, inflight: 0, calls: 0 };
          srv.resources.set(ev.resource, res);
        }
        res.activeAt = now;
        if (ev.phase === "call") {
          res.inflight++;
          res.calls++;
        } else res.inflight = Math.max(0, res.inflight - 1);
      }
      if (ev.phase === "call") {
        const inst = world.instances.get(ev.id);
        if (inst) (inst.mcpCalls++, (inst.lastMcp = ev.server));
        world.mcpTools.set(ev.tool, ev.server);
        srv.calls++;
        srv.inflight++;
        world.stats.mcpCalls++;
      } else srv.inflight = Math.max(0, srv.inflight - 1);
      noteMcp(ev, now);
      world.mcpCalls.push({ id: ++seq, run: ev.run_id, instance: ev.id, server: ev.server, tool: ev.tool, resource: ev.resource, phase: ev.phase, start: now, dur: 900 });
      const key = `${ev.id}|${ev.server}|${ev.tool}`;
      if (ev.phase === "call") world.mcpPending.set(key, { key, run: ev.run_id, instance: ev.id, server: ev.server, tool: ev.tool, resource: ev.resource, since: now });
      else {
        const p = world.mcpPending.get(key);
        if (p) world.mcpResolved.push({ ...p, resolvedAt: now });
        world.mcpPending.delete(key);
      }
      break;
    }
    case "chat": {
      const i = world.instances.get(ev.id);
      if (i) i.chat = [...i.chat, { role: ev.role, text: ev.text }].slice(-20);
      break;
    }
    case "drives":
      world.drives.set(`${ev.id}|${ev.target_run}`, { svc: ev.id, run: ev.target_run });
      break;
    case "final": {
      const r = world.runs.get(ev.run_id);
      if (r) r.final = ev.text;
      world.lastFinal = ev.text;
      break;
    }
  }
  const id = ev.type === "decision_stats" || ev.type === "service_stats" || PRIM_NO_LOG.has(ev.type) || (ev.type === "session" && ev.phase === "progress") ? null : "id" in ev ? ev.id : ev.type === "message" ? ev.from_id : null;
  if (id) {
    const i = world.instances.get(id);
    if (i) {
      i.recent.unshift(ev);
      if (i.recent.length > 40) i.recent.length = 40;
    }
  }
  if (QUIET.has(ev.type) && now - notifiedAt < HUD_NOTIFY_MS) dirty = true;
  else {
    notifiedAt = now;
    dirty = false;
    notify();
  }
}

/** roll the session decision rate once per second (HUD chip + 60 s sparkline) */
function rollRate(now: number) {
  const r = world.rate;
  if (!r.rollAt) r.rollAt = now;
  const dt = now - r.rollAt;
  if (dt < 1000) return false;
  const a = r.acc;
  r.perS = (a.n * 1000) / dt;
  r.deny = a.n ? a.deny / a.n : 0;
  if (a.msN) (r.p50 = a.p50 / a.msN), (r.p95 = a.p95 / a.msN);
  r.spark.push(r.perS);
  if (r.spark.length > 60) r.spark.shift();
  a.n = a.deny = a.msN = a.p50 = a.p95 = 0;
  r.rollAt = now;
  return true;
}

/** Remove faded instances, finished runs, old comets/flares. Call once per frame (cheap). */
const runsWithInstances = new Set<string>();
const runsWorking = new Set<string>();
const runLastDone = new Map<string, number>();
/** end skills that have been "active" for longer than SKILL_MAX_MS without an end event, so rings never get stuck */
function expireSkills(i: Instance, now: number) {
  let open = false;
  for (const u of i.skills.values()) {
    if (!u.active) continue;
    if (now - u.startAt > SKILL_MAX_MS) (u.active = false), (u.endAt = now);
    else open = true;
  }
  if (!open) i.skillEndAt = now;
}

const staleRuns = new Set<string>();
let idleKey = "";
let staleCheckAt = 0;

export function tick(now = performance.now()) {
  let changed = rollRate(now);
  if (now - staleCheckAt > 1000) {
    // stale runs (isStale) appear without any event: notify the HUD / labels when one flips
    staleCheckAt = now;
    let idle = "";
    for (const r of world.runs.values()) {
      const st = isStale(r, now);
      if (st !== staleRuns.has(r.id)) (st ? staleRuns.add(r.id) : staleRuns.delete(r.id)), (changed = true);
      if (isIdle(r)) idle += `${r.id} ${idleText(r)}\n`;
    }
    // "idle · 4m" labels count up without events
    if (idle !== idleKey) (idleKey = idle), (changed = true);
  }
  if (dirty && now - notifiedAt >= HUD_NOTIFY_MS) changed = true;
  runsWithInstances.clear();
  runsWorking.clear();
  runLastDone.clear();
  for (const [id, i] of world.instances) {
    runsWithInstances.add(i.run);
    if (i.skill && !i.skillEndAt) expireSkills(i, now);
    if (!i.exitAt) {
      if (!i.doneAt) runsWorking.add(i.run);
      else {
        if (i.doneAt > (runLastDone.get(i.run) ?? 0)) runLastDone.set(i.run, i.doneAt);
        if (i.parent && now - i.doneAt > SUBAGENT_DONE_MS) i.exitAt = now;
      }
    }
    if (i.exitAt && now - i.exitAt > linger.fadeMs(i)) {
      world.instances.delete(id);
      world.archive.set(id, i);
      if (world.archive.size > ARCHIVE_MAX) world.archive.delete(world.archive.keys().next().value!);
      changed = true;
    }
  }
  // a run that never reports completion: once every agent has been finished for ORPHAN_RUN_MS, fade them out
  for (const [run, t] of runLastDone)
    if (!runsWorking.has(run) && now - t > ORPHAN_RUN_MS && !isWaiting(world.runs.get(run)))
      for (const i of world.instances.values()) if (i.run === run && !i.exitAt) i.exitAt = now;
  for (const [id, r] of world.runs) {
    if (r.endedAt && now - r.endedAt > RUN_LINGER_MS && !runsWithInstances.has(id)) {
      world.runs.delete(id);
      changed = true;
    }
  }
  tickPrims(world, now);
  const nc = world.comets.length;
  world.comets = world.comets.filter((c) => now - c.start < c.dur + 250);
  world.mcpResolved = world.mcpResolved.filter((r) => now - r.resolvedAt < 700);
  const nm = world.mcpCalls.length;
  world.mcpCalls = world.mcpCalls.filter((c) => now - c.start < c.dur + 250);
  const nf = world.flares.length;
  world.flares = world.flares.filter((f) => now - f.start < 2600);
  if (changed || nc !== world.comets.length || nf !== world.flares.length || nm !== world.mcpCalls.length) {
    notifiedAt = now;
    dirty = false;
    notify();
  }
}

/** a run paused in a wait (approval / durable sleep) is not orphaned: its finished agents stay until it resumes */
const isWaiting = (r: Run | undefined) => !!r && r.status === "started" && runWait(r) !== null;

/** 0..1 visibility for an instance: grows in on spawn, fades out after exit. */
export function presence(i: Instance, now = performance.now()) {
  const born = Math.min(1, (now - i.bornAt) / 600);
  const grow = 1 - Math.pow(1 - born, 3);
  if (!i.exitAt) return grow;
  return grow * Math.max(0, 1 - (now - i.exitAt) / linger.fadeMs(i));
}

/** Current pulse energy (decays after each LLM/tool event). */
export function energy(i: Instance, now = performance.now()) {
  return i.pulse * Math.exp(-((now - i.pulseAt) / 1000) * 2.2);
}

/** Seconds an MCP call has been waiting (for tether intensity / color: amber → red past ~2s). */
export function waitSeconds(p: McpPending, now = performance.now()) {
  return (now - p.since) / 1000;
}

const KNOWN = new Set(["planner", "researcher", "graph_scout", "records_scout", "data_scout", "writer"]);
/** Map any real agent name onto a visual role the scenes know (layout + color). */
export function roleOf(name: string, subagent: boolean): AgentType {
  if (KNOWN.has(name)) return name as AgentType;
  const n = name.toLowerCase();
  if (/plan|orchestr|router|supervis|manager|coordinat/.test(n)) return "planner";
  if (/writ|report|summar|answer|final|compose|draft/.test(n)) return "writer";
  if (subagent) return /graph|kg|memory|retriev|search|web/.test(n) ? "graph_scout" : /record|doc|file/.test(n) ? "records_scout" : "data_scout";
  return "researcher";
}

/** Visual size multiplier by role: parent agents read bigger, their subagents smaller. */
export function roleScale(i: Instance): number {
  return i.subagent ? 0.6 : 1.35;
}

/** Look up a live or archived (exited) instance. */
export function getInstance(id: string | null | undefined): Instance | undefined {
  if (!id) return undefined;
  return world.instances.get(id) ?? world.archive.get(id);
}

/** Select an agent (panel list click or 3D click); null clears. */
export function selectInstance(id: string | null) {
  if (world.selected === id && !(id && world.selectedRes)) return;
  world.selected = id;
  if (id) world.selectedRes = null;
  notify();
}

/** Select a resource (server / backend / link) for the Resource details panel; null closes it. */
export function selectResource(sel: ResSel | null) {
  if (sameSel(world.selectedRes, sel)) return;
  world.selectedRes = sel;
  if (sel) world.selected = null;
  notify();
}

export function setSimulated(v: boolean) {
  world.simulated = v;
  notify();
}

/** Name the graph structure (e.g. when the server serves a real FalkorDB sample). */
export function setGraphLabel(label: string) {
  if (world.graphLabel === label) return;
  world.graphLabel = label;
  notify();
}

/** The server refused this scope/run/token (401). */
export function setUnauthorized(v: boolean) {
  if (world.unauthorized === v) return;
  world.unauthorized = v;
  notify();
}

/** Forget every run, agent and stat (a new connection with a different scope/run filter starts clean). */
export function resetWorld() {
  world.runs.clear();
  world.instances.clear();
  world.comets.length = 0;
  world.flares.length = 0;
  world.mcpServers.clear();
  world.mcpRegistry.clear();
  world.mcpKinds.clear();
  clearResInfo();
  world.mcpCalls.length = 0;
  world.mcpPending.clear();
  world.mcpTools.clear();
  world.mcpResolved.length = 0;
  world.ticker.length = 0;
  for (const k of Object.keys(world.stats) as (keyof typeof world.stats)[]) world.stats[k] = 0;
  world.decisionProviders.clear();
  world.rate = { perS: 0, deny: 0, p50: 0, p95: 0, spark: [], rollAt: 0, acc: { n: 0, deny: 0, msN: 0, p50: 0, p95: 0 } };
  world.orders = { n: 0, paper: 0, rejected: 0 };
  routeSlots.clear();
  hvShown.length = 0;
  world.lastFinal = "";
  world.simulated = false;
  world.mode = "connecting";
  world.focus = null;
  world.focusAt = 0;
  world.spawnHintAt = 0;
  world.archive.clear();
  world.selected = null;
  world.selectedRes = null;
  world.unauthorized = false;
  world.hasGraph = false;
  world.hasGraphAt = 0;
  world.graphRuns.clear();
  world.graphAt = 0;
  resetGraphDyn();
  world.halts.clear();
  globalBy.clear();
  world.primEdges.length = 0;
  world.backlogs.clear();
  world.resStats.clear();
  world.topics.clear();
  world.drives.clear();
  notify();
}

export function setMode(m: "sim" | "live") {
  world.mode = m;
  world.simulated = m === "sim";
  if (m === "sim") setHasGraph(true, false);
  notify();
}

/** Mark that this session has a knowledge graph (sticky: once true it stays true). */
export function setHasGraph(v: boolean, doNotify = true) {
  if (!v || world.hasGraph) return;
  world.hasGraph = true;
  // sim starts with a graph: no fade, it is simply there from the first frame
  world.hasGraphAt = world.mode === "sim" ? -1e9 : performance.now();
  if (doNotify) notify();
}

/** An MCP server / backend stays fully lit this long after its last call or result, then its glow decays. */
export const MCP_GLOW_HOLD_MS = 2500;
/**
 * 0..1 "recently active" glow of an MCP server or backend (its `activeAt`): 1 for MCP_GLOW_HOLD_MS after the last
 * call/result, then exp(-rate * seconds). Shared by every theme so MCP activity stays visible alongside the graph
 * reads that usually follow it.
 */
export function mcpGlow(activeAt: number, now: number, rate = 1.5): number {
  const s = (now - activeAt - MCP_GLOW_HOLD_MS) / 1000;
  return s <= 0 ? 1 : Math.exp(-s * rate);
}

/** An MCP server with no calls for this long (and none in flight) fades out; the next call fades it back in. */
export const MCP_IDLE_MS = 90_000;
/** Should this MCP server (and its used backends) be drawn now? Shared "only show resources while used" rule. */
export function mcpWanted(srv: McpServer, now = performance.now()): boolean {
  return srv.calls > 0 && (srv.inflight > 0 || now - srv.activeAt < MCP_IDLE_MS);
}

/**
 * Is the side graph shown now? Like MCP servers it is a resource shown while used: from the first graph event
 * until every run that touched it has ended (+ RUN_LINGER_MS), so it fades out with its run. Sim keeps it.
 */
export function graphShown(now = performance.now()): boolean {
  if (!world.hasGraph) return false;
  if (world.mode === "sim" || now - world.graphAt < RUN_LINGER_MS) return true;
  for (const id of world.graphRuns) {
    const r = world.runs.get(id);
    if (r && (!r.endedAt || now - r.endedAt < RUN_LINGER_MS)) return true;
    if (!r || r.endedAt) world.graphRuns.delete(id);
  }
  return false;
}

/** How long the side graph fades in after hasGraph flips true (ms). */
export const GRAPH_FADE_MS = 1800;

/**
 * 0..1 graph presence for useFrame: 0 = no graph (agents take the center), 1 = graph fully shown.
 * Eases (smoothstep) over GRAPH_FADE_MS after hasGraph flips (the kit fades the side graph in with it).
 */
export function graphMix(now = performance.now()): number {
  if (!world.hasGraph) return 0;
  const t = Math.min(1, Math.max(0, (now - world.hasGraphAt) / GRAPH_FADE_MS));
  return t * t * (3 - 2 * t);
}

/** React hook: does this session have a knowledge graph? (re-renders when it flips true) */
export function useHasGraph(): boolean {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => world.hasGraph,
    () => false,
  );
}
