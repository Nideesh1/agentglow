/** Shared glass HUD for every scene: top bar (title, mode, theme, live totals) + right sidebar (Agents | Events | Selected). */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useSceneConfig } from "./config";
import { HUD_LAYOUT_EVENT } from "./kit/fit";
import "./hud.css";
import { clearView, sendApproval, showAllView, startLiveRun, useApproveAvailable, useRunAvailable, useRunWorkflows } from "./useSceneSetup";
import { collapseLanes, setShowAll, useLod } from "./lod";
import { THEMES } from "../../themes";
import { decisionTint } from "./kit/DecisionGlyph";
import { haloHover } from "./kit/HighVolume";
import { fmtMs, gaugeText, jobStateText, metricText } from "./prims";
import { PrimDetail } from "./PrimPanel";
import { ResourceDetail, ServiceDetail } from "./ResourcePanel";
import { STALE_TEXT, useClearedAt, viewClearedAt, dismissRun, dismissedRuns, idleText, isDismissed, isIdle, undismissRuns, decisionText, getInstance, jobText, haltedNow, isStale, kindBadge, providerBadge, whyBadge, haloLatency, haloText, HALO_CATS, HALO_COLORS, hvActive, isDeny, isDone, isLive, orderText, routeSlots, selectInstance, selectResource, stepChips, TYPE_COLOR, useWorld, waitLabel, waitSeconds, world, type Instance, type Run, type WorldEvent } from "./world";

export const SCENES = THEMES; // theme nav = every registered theme

export function shortRun(run: string) {
  return run.replace("run-", "").slice(0, 6);
}

function short(id: string) {
  const inst = world.instances.get(id) ?? world.archive.get(id);
  if (inst) return `${inst.name} · ${shortRun(inst.run)}`;
  const [run, type, k] = id.split(":");
  return `${type ?? id.slice(0, 6)}${k !== undefined ? `#${Number(k) + 1}` : ""} · ${shortRun(run)}`;
}

export function describe(e: WorldEvent): string {
  switch (e.type) {
    case "run":
      if (!("topic" in e)) return `run ${e.status} · ${world.runs.get(e.run_id)?.topic ?? shortRun(e.run_id)}`;
      return `run ${e.status}${e.reason ? ` (${e.reason})` : ""} · ${e.topic}`;
    case "step":
      return e.status === "waiting" ? `step ${e.step} ${waitLabel({ reason: e.reason || "wait", until: e.until ?? 0 })} · ${shortRun(e.run_id)}` : `step ${e.step} ${e.status} · ${shortRun(e.run_id)}`;
    case "spawn":
      return `spawned ${short(e.id)}`;
    case "exit":
      return `${short(e.id)} ${e.status}`;
    case "agent":
      return e.status === "waiting" && e.reason ? `${short(e.id)} ${waitLabel({ reason: e.reason, until: e.until ?? 0 })}` : `${short(e.id)} ${e.status}`;
    case "llm":
      return e.tokens_in || e.tokens_out ? `${short(e.id)} · LLM ${e.tokens_in}→${e.tokens_out} tok` : `${short(e.id)} · thinking…`; // no usage (e.g. Claude Code hooks): no fake 0→0
    case "message":
      return e.failed ? `${short(e.from_id)} ✕ ${e.text}: publish failed` : `${short(e.from_id)} → ${short(e.to_id)}: ${e.text}`;
    case "tool":
      return `${short(e.id)} · ${e.tool}(${e.args_preview})`;
    case "graph":
      return `${short(e.id)} ${e.op === "read" ? "read" : "WROTE"} graph: ${e.nodes.slice(0, 2).join(", ")}`;
    case "graph_nodes":
      return `graph: ${e.nodes.length} touched nodes restored`;
    case "mcp":
      return e.phase === "call" ? `${short(e.id)} → mcp ${e.server}.${e.tool}()${e.resource ? ` → ${e.resource}` : ""}` : `mcp ${e.server}.${e.tool} returned${e.latency_ms ? ` · ${Math.round(e.latency_ms)}ms` : ""}`;
    case "mcp_register":
      return `mcp server ${e.server} online`;
    case "skill":
      return e.status === "start" ? `${short(e.id)} · skill: ${e.name}` : `${short(e.id)} · skill: ${e.name} done`;
    case "decision":
      return `${short(e.id)} · ${decisionText(e)} · ${Math.round(e.ms)}ms${e.why ? ` · ${whyBadge(e.why)}` : ""}${e.scope === "global" ? " · desk-wide" : ""}`;
    case "decision_stats":
      return `${short(e.id)} · ${e.n} decisions in ${Math.round(e.window_ms)}ms`;
    case "order":
      return `${short(e.id)} · ${orderText(e)}${e.reason ? ` · ${e.reason}` : ""}`;
    case "request":
      return `${short(e.id)} · ${e.name}${e.status !== undefined ? ` ${e.status}` : ""}${e.error ? " ERROR" : ""} · ${Math.round(e.ms)}ms`;
    case "service_stats":
      return `${short(e.id)} · ${e.n} requests in ${Math.round(e.window_ms)}ms${e.instances && e.instances > 1 ? ` · ×${e.instances}` : ""}`;
    case "drives":
      return `${short(e.id)} drives ${shortRun(e.target_run)}`;
    case "final":
      return `final answer · ${shortRun(e.run_id)}`;
    case "chat":
      return `${e.role === "user" ? "you" : world.instances.get(e.id)?.name ?? "agent"}: ${e.text}`;
    case "session":
      return e.phase === "start"
        ? `${short(e.id)} · ${e.kind} session started`
        : e.phase === "end"
          ? `${short(e.id)} · session ended${e.outcome ? ` · ${e.outcome}` : ""}${e.reason ? ` (${e.reason})` : ""}`
          : e.phase === "turn"
            ? `${short(e.id)} · turn${e.role ? ` · ${e.role}` : ""}`
            : `${short(e.id)} · ${Object.entries(e.gauges ?? {}).map(([k, v]) => gaugeText(k, v)).join(", ")}`;
    case "stage":
      return `${short(e.id)} · stage ${e.name} ${e.status}${e.ms !== undefined && e.status !== "running" ? ` · ${fmtMs(e.ms)}` : ""}`;
    case "progress":
      return `${short(e.id)} · ${Math.round(e.frac * 100)}%${e.label ? ` ${e.label}` : ""}`;
    case "capacity":
      return `${short(e.id)} · ${e.name} ${e.used}/${e.max}`;
    case "rejected":
      return `${short(e.id)} · rejected: ${e.reason}${e.status ? ` (${e.status})` : ""}${e.retry_after_ms ? ` · retry in ${fmtMs(e.retry_after_ms)}` : ""}`;
    case "job":
      return `job ${e.job_id} ${jobStateText(e.state)}${e.attempt > 1 ? ` #${e.attempt}` : ""}${e.at ? ` · ${e.at}` : ""}`;
    case "deferred":
      return e.phase === "open" ? `${short(e.id)} · awaiting ${e.label || "callback"}` : `${short(e.id)} · callback ${e.status || "ok"}${e.wait_ms ? ` after ${fmtMs(e.wait_ms)}` : ""}`;
    case "fallback":
      return `${short(e.id)} · fallback ${e.from} → ${e.to}${e.reason ? ` (${e.reason})` : ""}`;
    case "gate":
      return `${short(e.id)} · ${e.name} ${e.state}${e.attempts_left !== undefined ? ` · ${e.attempts_left} left` : ""}`;
    case "backlog":
      return `${e.topic} backlog ${e.depth}${e.lag_ms ? ` · lag ${fmtMs(e.lag_ms)}` : ""}`;
    case "lifecycle":
      return `${short(e.id)} · ${e.state}`;
    case "metric":
      return `${short(e.id)} · ${metricText(e.name, e)}`;
    case "event":
      return `${short(e.id)} · ${e.kind}${e.label ? ` ${e.label}` : ""}`;
    case "resource_stats":
      return `${e.resource} · ${e.calls} calls`;
  }
}

/** skill badge accent (3D chip + HUD chips) */
export const SKILL_COLOR = "#f5b83d";

/** a step chip's status ("waiting" while paused in a wait) and tooltip */
function chipState(run: Run, s: string): [string, string] {
  const w = run.steps[s] === "running" ? run.waits[s] : undefined;
  return w ? ["waiting", `${s}: ${waitLabel(w)}`] : [run.steps[s], `${s}: ${run.steps[s]}`];
}

/** order accent: buy / yes green, sell / no red, rejected / cancelled grey */
export const orderColor = (o: { side: string; status: string }) =>
  o.status === "rejected" || o.status === "cancelled" ? "#94a3b8" : o.side === "sell" || o.side === "no" ? "#fb7185" : "#4ade80";

/** 60 s decision-rate sparkline (per-second samples), inline SVG */
function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const W = 60, H = 14;
  const pts = data.map((v, k) => `${((k + 60 - data.length) / 59) * W},${H - 1 - (v / max) * (H - 2)}`).join(" ");
  return (
    <svg className="hud-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/** decision accent: noul yes green / no red, choice + score cyan */
export const decisionColor = (d: { kind: string; result: string; p?: number }) => decisionTint(d);

function colorOf(e: WorldEvent) {
  if (e.type === "skill") return SKILL_COLOR;
  if (e.type === "decision") return decisionColor(e);
  if (e.type === "order") return orderColor(e);
  const id = "id" in e ? e.id : e.type === "message" ? e.from_id : null;
  const inst = id ? world.instances.get(id) : null;
  if (inst) return TYPE_COLOR[inst.type];
  if (e.type === "graph") return "#c7d2fe";
  if (e.type === "mcp") return world.mcpServers.get(e.server)?.color ?? "#94a3b8";
  return e.type === "run" || e.type === "step" ? "#fde68a" : "#c7d2fe";
}

export function Hud(props: { title: string; subtitle: string; selected?: string | null; onClose?: () => void; inset?: ReactNode; children?: ReactNode }) {
  const { hud } = useSceneConfig();
  // selection from 3D clicks must still reach the world even with the HUD hidden
  useEffect(() => {
    if (props.selected) selectInstance(props.selected);
  }, [props.selected]);
  return hud ? <HudPanels {...props} /> : <>{props.children}</>;
}


type Tab = "agents" | "events" | "selected";
const TABS: Tab[] = ["agents", "events", "selected"];
const TAB_LABEL: Record<Tab, string> = { agents: "Agents", events: "Events", selected: "Selected" };
/** below this container width the sidebar starts as the icon rail and the top bar keeps only two stat chips */
const SMALL_PX = 720;
const STORE_KEY = "agentglow.hud.sidebar";

function loadSide(): { collapsed: boolean; tab: Tab } {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
    if (v && TABS.includes(v.tab)) return { collapsed: !!v.collapsed, tab: v.tab === "selected" ? "agents" : v.tab };
  } catch {
    /* storage blocked: defaults */
  }
  return { collapsed: false, tab: "agents" };
}

function saveSide(v: { collapsed: boolean; tab: Tab }) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(v));
  } catch {
    /* storage blocked: not persisted */
  }
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

function HudPanels({ title, subtitle, onClose, inset, children }: { title: string; subtitle: string; selected?: string | null; onClose?: () => void; inset?: ReactNode; children?: ReactNode }) {
  const { embedded, scope, run: runFilter, clearable = true } = useSceneConfig();
  const clearedAt = useClearedAt();
  const canRun = useRunAvailable();
  const canApprove = useApproveAvailable();
  const w = useWorld();
  const drawerId = useDrawer();
  const lastDec = w.ticker.find((e): e is Extract<WorldEvent, { type: "decision" }> => e.type === "decision");
  const halt = haltedNow();
  const [, tick] = useState(0);
  const [info, setInfo] = useState(false); // the theme legend lives behind the (i) toggle
  const [side, setSide] = useState(loadSide);
  const prev = useRef<{ collapsed: boolean; tab: Tab } | null>(null); // where "close" on Selected returns to
  const closeRef = useRef<(() => void) | null>(null);
  // Esc closes the Selected inspector (agent or resource), unless typing in a field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "Escape" || !closeRef.current || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Shift+C: clear this viewer's view (again: show all), unless typing in a field
  useEffect(() => {
    if (!clearable) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== "c" || (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable))) return;
      e.preventDefault();
      toggleClear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearable]);
  const small = useRef(false);
  const topRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const seen = useRef<WorldEvent | null>(null); // newest event when Events was last open (rail badge)
  // the replay / catch-up burst on load counts as seen: the badge only counts events that arrive after it
  const burst = useRef({ t0: performance.now(), head: null as WorldEvent | null, at: performance.now(), done: false });
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);

  // small canvases / embeds start on the icon rail (container width, not the viewport)
  useLayoutEffect(() => {
    const root = sideRef.current?.closest(".scene-root");
    if (root && root.clientWidth < SMALL_PX) {
      small.current = true;
      setSide((s) => ({ ...s, collapsed: true }));
    }
  }, []);

  const update = (next: { collapsed: boolean; tab: Tab }) => {
    setSide(next);
    if (!small.current) saveSide(next); // a tiny embed doesn't overwrite the full-size preference
  };

  // selecting an agent or a resource (3D click or list) opens Selected; remember where we were for "close"
  const selId = w.selected ?? (w.selectedRes ? JSON.stringify(w.selectedRes) : null);
  useEffect(() => {
    if (!selId) return;
    setSide((s) => {
      if (s.tab !== "selected") prev.current = s;
      return { collapsed: false, tab: "selected" };
    });
  }, [selId]);

  // the HUD footprint changed: tell FitCamera to re-measure (it refits only if the free area really moved)
  useEffect(() => {
    const root = sideRef.current?.closest(".scene-root");
    if (!root || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => root.dispatchEvent(new Event(HUD_LAYOUT_EVENT)));
    });
    if (topRef.current) ro.observe(topRef.current);
    if (sideRef.current) ro.observe(sideRef.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const bs = burst.current;
  if (!bs.done) {
    const now = performance.now();
    const head = w.ticker[0] ?? null;
    if (head !== bs.head) {
      bs.head = head;
      bs.at = now;
    }
    // the burst ends once events have been quiet ~1s (or 4s after mount at the latest)
    if ((head && now - bs.at > 1000) || now - bs.t0 > 4000) bs.done = true;
    else seen.current = head;
  }
  if (side.tab === "events" && !side.collapsed) seen.current = w.ticker[0] ?? null;
  const seenAt = seen.current ? w.ticker.indexOf(seen.current) : -1;
  const unseen = side.tab === "events" && !side.collapsed ? 0 : seenAt >= 0 ? seenAt : w.ticker.length;

  const alive = [...w.instances.values()].filter((i) => isLive(i) && !isDismissed(i.run));
  const runs = [...w.runs.values()].filter((r) => r.status === "started" && !isStale(r) && !isDismissed(r.id));
  const hidden = dismissedRuns();
  const graph = w.stats.graphReads + w.stats.graphWrites;
  const close = () => {
    selectInstance(null);
    selectResource(null);
    onClose?.();
    const back = prev.current ?? { collapsed: side.collapsed, tab: "agents" as Tab };
    prev.current = null;
    update(back);
  };
  const open = (tab: Tab) => update({ collapsed: false, tab });
  const here = embedded ? "" : location.pathname.replace(/\/$/, "").slice(1);
  const qs = embedded ? "" : location.search;
  const sel = getInstance(w.selected);
  const selRes = w.selectedRes;
  const badge: Record<Tab, string> = { agents: alive.length ? `${alive.length}` : "", events: unseen ? (unseen >= 60 ? "60+" : `${unseen}`) : "", selected: sel || selRes ? "1" : "" };
  closeRef.current = sel || selRes ? close : null;

  return (
    <>
      <div ref={topRef} className={`hud-topwrap${side.collapsed ? " is-rail" : ""}`}>
        <header className="hud hud-top">
          <div className="hud-bar">
            <div className="hud-title">
              <span className="hud-dot" />
              {title}
            </div>
            {w.mode === "sim" && <span className="hud-badge">sim</span>}
            {w.mode === "live" && !w.unauthorized && <span className="hud-badge hud-badge--live">live</span>}
            {scope && <FilterChip label="scope" value={scope} />}
            {runFilter && <FilterChip label="run" value={runFilter} />}
            {w.unauthorized && (
              <span className="hud-badge hud-badge--denied" role="status" title="The server answered 401: this token / scope is not allowed to watch these agents">
                not authorized for this scope
              </span>
            )}
            <button className={`hud-info${info ? " on" : ""}`} onClick={() => setInfo((v) => !v)} aria-label="What am I looking at?" aria-expanded={info} title="What am I looking at?">
              i
            </button>
            {hidden.length > 0 && (
              <button className="hud-badge hud-hidden" onClick={() => undismissRuns(hidden)} title="Runs you hid with ×: click to show them again">
                {hidden.length} hidden · show
              </button>
            )}
            {clearable && !w.unauthorized && <ClearButton clearedAt={clearedAt} />}
            {w.mode === "live" && canRun && <RunButton />}
            {!embedded && (
              <select className="hud-theme" value={here} aria-label="Theme" onChange={(e) => (location.href = `/${e.target.value}${qs}`)}>
                <option value="">all themes</option>
                {SCENES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            )}
            <div className="hud-stats" aria-label="Live totals">
              <span className="hud-stat" title="active runs">
                <b>{runs.length}</b> runs
              </span>
              <span className="hud-stat" title="agents alive">
                <b>{alive.length}</b> agents
              </span>
              <span className="hud-stat" title="tokens">
                <b>{fmtK(w.stats.tokens)}</b> tok
              </span>
              {graph > 0 && (
                <span className="hud-stat" title={`graph reads ${w.stats.graphReads} · writes ${w.stats.graphWrites}`}>
                  <b>{graph}</b> graph
                </span>
              )}
              {w.stats.rejected > 0 && (
                <span className="hud-stat hud-rejected" title="requests / work turned away by admission control or backpressure (429 / 503), not errors">
                  rejected <b>{fmtK(w.stats.rejected)}</b>
                </span>
              )}
              {halt && (
                <span className="hud-stat hud-halt" title={`desk-wide halt on ${halt.id ? short(halt.id) : "the desk"}: a global guard said no (${[...halt.qs].filter(([, no]) => no).map(([q]) => q).join(", ")}); its agents' own denies only flash their halos`}>
                  <b>HALTED</b> · {halt.reason}
                </span>
              )}
              {w.stats.decisions > 0 && w.rate.perS > 2 && (
                <span
                  className={`hud-stat hud-dec-hv${w.rate.deny > 0.05 && !halt ? " is-deny" : ""}`}
                  title={`decisions per second (last 60 s)\n${w.stats.decisions} decisions in total\n${[...w.decisionProviders].map(([p, v]) => `${providerBadge(p)}: ${v.n}`).join("\n")}`}
                >
                  <b>{Math.round(w.rate.perS)}/s</b> · deny {(w.rate.deny * 100).toFixed(w.rate.deny < 0.1 ? 1 : 0)}% · {Math.round(w.rate.p50)}/{Math.round(w.rate.p95)} ms
                  <Sparkline data={w.rate.spark} />
                </span>
              )}
              {w.stats.decisions > 0 && w.rate.perS <= 2 && (
                <span
                  key={w.stats.decisions} // re-mounts on every decision: the chip pulses once
                  className={`hud-stat hud-dec${lastDec && isDeny(lastDec) ? " is-deny" : ""}`}
                  title={[...w.decisionProviders].map(([p, v]) => `${providerBadge(p)}: ${v.n} · avg ${Math.round(v.ms / v.n)} ms`).join("\n")}
                >
                  <b>{w.stats.decisions}</b> decisions · avg {Math.round(w.stats.decisionMs / w.stats.decisions)} ms
                </span>
              )}
              {w.orders.n > 0 && (
                <span className="hud-stat" title={`orders: ${w.orders.n} · paper ${w.orders.paper} · rejected/cancelled ${w.orders.rejected}`}>
                  orders <b>{w.orders.n}</b>
                  {w.orders.paper > 0 && w.orders.paper === w.orders.n ? " (paper)" : w.orders.paper > 0 ? ` (${w.orders.paper} paper)` : ""}
                </span>
              )}
              {w.stats.requests > 0 && (
                <span className={`hud-stat${w.stats.errors > 0 ? " is-deny" : ""}`} title={`backend requests / handled messages: ${w.stats.requests} · errors ${w.stats.errors}`}>
                  <b>{fmtK(w.stats.requests)}</b> req{w.stats.errors > 0 ? ` · ${fmtK(w.stats.errors)} err` : ""}
                </span>
              )}
              {w.stats.mcpCalls > 0 && (
                <span className="hud-stat" title="MCP calls">
                  <b>{w.stats.mcpCalls}</b> MCP
                </span>
              )}
            </div>
          </div>
          {info && <div className="hud-sub">{subtitle}</div>}
        </header>
        {/* the dock: LOD chip + theme buttons (KitScene `hudInset`), next to the top bar */}
        <div className="hud-dock">
          <LodHint />
          {inset}
        </div>
      </div>

      <aside ref={sideRef} className={`hud hud-side${side.collapsed ? " is-rail" : ""}`} aria-label="Agent sidebar">
        {side.collapsed ? (
          <nav className="hs-rail">
            <button className="hs-collapse" onClick={() => update({ ...side, collapsed: false })} aria-label="Expand sidebar" title="Expand sidebar">
              «
            </button>
            {TABS.map((t) => (
              <button key={t} className={`hs-icon${side.tab === t ? " on" : ""}`} onClick={() => open(t)} aria-label={`${TAB_LABEL[t]}${badge[t] ? ` (${badge[t]})` : ""}`} title={TAB_LABEL[t]}>
                <TabIcon tab={t} />
                {badge[t] && <em>{t === "selected" ? "" : badge[t]}</em>}
              </button>
            ))}
          </nav>
        ) : (
          <div className="hs-head" role="tablist" aria-label="Sidebar">
            {TABS.map((t) => (
              <button key={t} role="tab" aria-selected={side.tab === t} className={side.tab === t ? "on" : ""} onClick={() => open(t)}>
                {TAB_LABEL[t]}
                {badge[t] && t !== "selected" && <em>{badge[t]}</em>}
              </button>
            ))}
            <button className="hs-collapse" onClick={() => update({ ...side, collapsed: true })} aria-label="Collapse sidebar" title="Collapse sidebar">
              »
            </button>
          </div>
        )}
        {/* panels stay mounted (filters + scroll survive tab switches); only the active one is shown */}
        <div className="hs-body" hidden={side.collapsed || side.tab !== "agents"}>
          <AgentList />
        </div>
        <div className="hs-body" hidden={side.collapsed || side.tab !== "events"}>
          <EventLog />
        </div>
        <div className="hs-body" hidden={side.collapsed || side.tab !== "selected"}>
          {selRes ? (
            <ResourceDetail sel={selRes} onClose={close} />
          ) : sel ? (
            <>
              <div className="ap-head">
                <button className="ap-link" onClick={close} aria-label="Close agent inspector">
                  ← back
                </button>
              </div>
              <AgentDetail i={sel} />
            </>
          ) : (
            <p className="hs-empty">Click an agent, an MCP server, a backend or a link in the scene (or the Agents list / Events log) to inspect it.</p>
          )}
        </div>
      </aside>

      {w.mode === "live" && canApprove && <ApprovalTray rail={side.collapsed} />}
      <DeepLinkFocus />
      {drawerId && getInstance(drawerId) && <ApprovalDrawer id={drawerId} rail={side.collapsed} canApprove={w.mode === "live" && canApprove} embedded={embedded} />}
      <HaloTip />
      {children}
    </>
  );
}

function TabIcon({ tab }: { tab: Tab }) {
  const p = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, "aria-hidden": true };
  if (tab === "agents")
    return (
      <svg {...p}>
        <circle cx="5" cy="5" r="2.2" />
        <circle cx="11.5" cy="6.5" r="1.8" />
        <circle cx="6.5" cy="11.5" r="1.8" />
        <path d="M6.8 6.3l3 0.6M5.4 7.2l0.7 2.4" />
      </svg>
    );
  if (tab === "events")
    return (
      <svg {...p}>
        <path d="M5.5 4h8M5.5 8h8M5.5 12h6" />
        <circle cx="2.5" cy="4" r="0.6" fill="currentColor" />
        <circle cx="2.5" cy="8" r="0.6" fill="currentColor" />
        <circle cx="2.5" cy="12" r="0.6" fill="currentColor" />
      </svg>
    );
  return (
    <svg {...p}>
      <circle cx="8" cy="8" r="5" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2" />
    </svg>
  );
}

/** the instance an event is about (clickable in the Events log), if it still exists */
function eventAgent(e: WorldEvent) {
  const id = "id" in e ? e.id : e.type === "message" ? e.from_id : null;
  return id && getInstance(id) ? id : null;
}

function EventLog() {
  const w = useWorld();
  if (!w.ticker.length) return <p className="hs-empty">Waiting for events…</p>;
  return (
    <ul className="hs-events">
      {w.ticker.map((e, i) => {
        const id = eventAgent(e);
        const body = (
          <>
            <i />
            {e.type === "skill" && <b className="hs-skill">{e.status === "start" ? "skill" : "skill done"}</b>}
            {e.type === "decision" && <b className="hs-dec">{isDeny(e) ? "DENY" : kindBadge(e.kind)}</b>}
            <span>{describe(e)}</span>
          </>
        );
        return (
          <li key={`${e.ts}-${e.type}-${i}`} className={e.type === "skill" ? "is-skill" : e.type === "decision" ? (isDeny(e) ? "is-dec is-deny" : "is-dec") : undefined} style={{ ["--c" as string]: colorOf(e) }}>
            {id ? (
              <button onClick={() => selectInstance(id)} title="Inspect agent">
                {body}
              </button>
            ) : (
              <div>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------------ LOD: "grouped: N runs in K clusters · show all"

function LodHint() {
  const l = useLod();
  if (!l.crowded) return null;
  if (l.showAll)
    return (
      <div className="hud hud-lod">
        <i />
        <span>
          showing all <b>{l.alive}</b> agents
        </span>
        <button onClick={() => setShowAll(false)}>group</button>
      </div>
    );
  if (!l.activeClusters) return null;
  return (
    <div className="hud hud-lod">
      <i />
      <span>
        grouped: <b>{l.collapsedRuns}</b> run{l.collapsedRuns === 1 ? "" : "s"} in <b>{l.activeClusters}</b> cluster{l.activeClusters === 1 ? "" : "s"}
      </span>
      {l.expandedLane >= 0 && <button onClick={collapseLanes}>collapse</button>}
      <button onClick={() => setShowAll(true)}>show all</button>
    </div>
  );
}

// ------------------------------------------------------------------ live: optional POST /live/run

/** Demo topics sent to POST /live/run; rotated so each run differs. */
const TOPICS = ["Why is churn rising for Acme Corp?", "Root cause of payment latency incidents", "Which region has the most incidents?", "Is Fraud Shield worth expanding to Globex?"];
let topicIdx = 0;

/** "scope: user-123" / "run: abc123": tells viewers they are looking at a filtered view. */
/** Clear view toggle: clears when showing everything, shows everything again when cleared. */
function toggleClear() {
  if (viewClearedAt()) showAllView();
  else clearView();
}

/** "Clear view" (per viewer; Shift+C), or the "cleared · show all" chip that undoes it. */
function ClearButton({ clearedAt }: { clearedAt: number }) {
  if (clearedAt) {
    const at = new Date(clearedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return (
      <button className="hud-badge hud-hidden hud-cleared" onClick={showAllView} title={`Showing only activity since ${at} (for you only). Click to show everything again (Shift+C)`}>
        cleared · show all
      </button>
    );
  }
  return (
    <button className="hud-clear" onClick={() => clearView()} title="Clear view: hide everything on screen for you only; new activity still draws (Shift+C)" aria-label="Clear view (Shift+C)">
      Clear view
    </button>
  );
}

function FilterChip({ label, value }: { label: string; value: string }) {
  const short = value.length > 18 ? `${value.slice(0, 16)}…` : value;
  return (
    <span className="hud-badge hud-chip" title={`${label}: ${value}`}>
      {label}: <b>{short}</b>
    </span>
  );
}

const WORKFLOW_KEY = "agentglow.hud.workflow";

function loadWorkflow(): string {
  try {
    return localStorage.getItem(WORKFLOW_KEY) ?? "";
  } catch {
    return ""; // storage blocked: no remembered choice
  }
}

function saveWorkflow(id: string) {
  try {
    localStorage.setItem(WORKFLOW_KEY, id);
  } catch {
    /* storage blocked: not persisted */
  }
}

/** "▶ Run agents", plus a workflow picker when the server lists the run webhook's workflows (GET /live/run). */
export function RunButton() {
  const workflows = useRunWorkflows();
  const [picked, setPicked] = useState(loadWorkflow);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const wf = workflows.find((w) => w.id === picked) ?? workflows[0];
  const run = async () => {
    const topic = wf?.topic || TOPICS[topicIdx++ % TOPICS.length];
    setBusy(true);
    try {
      setMsg((await startLiveRun(topic, wf?.id)) ? `started · ${topic}` : "failed to start");
      window.setTimeout(() => setMsg(""), 6000);
    } finally {
      setBusy(false);
    }
  };
  const pick = (id: string) => {
    setPicked(id);
    saveWorkflow(id);
  };
  return (
    <div className="hud-run">
      {workflows.length > 1 && (
        <select value={wf?.id} onChange={(e) => pick(e.target.value)} disabled={busy} aria-label="Workflow to run" title={wf?.topic}>
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </select>
      )}
      <button onClick={run} disabled={busy} title={wf?.topic || undefined}>{busy ? "Starting…" : "▶ Run agents"}</button>
      {msg && <span>{msg}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ live: optional POST /live/approve

/** A live agent waiting on a human: an `approval()` wait (kind "approval"), or a wait whose reason says so ("approval",
 * "human approval yes 12"). */
export function needsHuman(i: Instance): boolean {
  return isLive(i) && i.status === "waiting" && !!i.wait && (i.wait.kind === "approval" || /human|approv/i.test(i.wait.reason));
}

type Verdict = "approving" | "rejecting" | "approved" | "rejected" | "gone" | "error";
/** per wait (agent id + reason + deadline), shared by the tray and the Selected panel; a new wait starts clean */
const verdicts = new Map<string, Verdict>();
const verdictSubs = new Set<() => void>();
const waitKey = (i: Instance) => `${i.id}|${i.wait?.reason}|${i.wait?.until}`;

async function decide(i: Instance, approve: boolean, note?: string) {
  const k = waitKey(i);
  const set = (v: Verdict) => {
    verdicts.set(k, v);
    if (verdicts.size > 500) verdicts.delete(verdicts.keys().next().value as string);
    verdictSubs.forEach((f) => f());
  };
  set(approve ? "approving" : "rejecting");
  // the wait normally clears (the agent resumes) within seconds; if it does not, give the buttons back
  setTimeout(() => {
    const v = verdicts.get(k);
    if (v && v !== "error" && v !== "gone") (verdicts.delete(k), verdictSubs.forEach((f) => f()));
  }, VERDICT_TIMEOUT_MS);
  const r = await sendApproval(i.run, i.id, approve, note);
  if (verdicts.has(k)) set(r === "ok" ? (approve ? "approved" : "rejected") : r);
}
const VERDICT_TIMEOUT_MS = 10_000;
/** after its deadline a gate auto-approves (the worker resumes it); past AUTO_DUE_MS it is overdue */
const AUTO_DUE_MS = 10_000;
function deadlineText(i: Instance, now: number): [string, "due" | "overdue" | ""] {
  const until = i.wait?.until;
  if (!until) return ["", ""];
  if (now < until) return [leftText(until - now), ""];
  return now - until < AUTO_DUE_MS ? ["auto-approve due", "due"] : ["overdue", "overdue"];
}

/** `45s` / `29m 40s` / `2h 05m` */
function leftText(ms: number): string {
  const t = Math.round(ms / 1000);
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
  return `${Math.floor(t / 3600)}h ${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}m`;
}

const VERDICT_TEXT: Record<Verdict, string> = {
  approving: "approving…", rejecting: "rejecting…", approved: "approved · resuming…", rejected: "rejected · resuming…",
  gone: "no longer waiting", error: "failed, try again",
};

/** Approve / Reject for one waiting agent; after a click, its state until the wait clears (from the event stream). */
function ApproveButtons({ i, compact, note, keys }: { i: Instance; compact?: boolean; note?: string; keys?: boolean }) {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((x) => x + 1);
    verdictSubs.add(f);
    return () => void verdictSubs.delete(f);
  }, []);
  const v = verdicts.get(waitKey(i));
  const locked = v !== undefined && v !== "error";
  return (
    <div className={`hud-approve${compact ? " is-compact" : ""}`} data-verdict={v}>
      {!locked && (
        <>
          <button className="ha-yes" onClick={() => decide(i, true, note)} title={`Approve: ${i.wait?.title || i.wait?.reason}${keys ? " (A)" : ""}`}>
            Approve
          </button>
          <button className="ha-no" onClick={() => decide(i, false, note)} title={`Reject: ${i.wait?.title || i.wait?.reason}${keys ? " (R)" : ""}`}>
            Reject
          </button>
        </>
      )}
      {v && <span role="status">{VERDICT_TEXT[v]}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ approval details drawer
/** the agent whose wait the details drawer shows (null = closed); opening it also selects the agent in 3D */
const drawer = { id: null as string | null, subs: new Set<() => void>() };
export function openDrawer(id: string | null) {
  if (id) selectInstance(id);
  if (drawer.id === id) return;
  drawer.id = id;
  drawer.subs.forEach((f) => f());
}
function useDrawer(): string | null {
  return useSyncExternalStore(
    (f) => (drawer.subs.add(f), () => void drawer.subs.delete(f)),
    () => drawer.id,
    () => null,
  );
}

/** link to AgentGlow focused on this run + agent (`?run=<id>&agent=<id>`, other params kept) */
export function deepLink(i: Pick<Instance, "run" | "id">, href = location.href): string {
  const u = new URL(href);
  u.searchParams.set("run", i.run);
  u.searchParams.set("agent", i.id);
  return u.toString();
}

/** `?agent=<id>` (standalone app): select that agent once it shows up; open its drawer while it waits on a human */
function DeepLinkFocus() {
  const { embedded } = useSceneConfig();
  const w = useWorld();
  const want = useRef(embedded || typeof location === "undefined" ? null : new URLSearchParams(location.search).get("agent"));
  useEffect(() => {
    const id = want.current;
    const i = id ? getInstance(id) : undefined;
    if (!id || !i) return;
    want.current = null;
    if (needsHuman(i)) openDrawer(id);
    else selectInstance(id);
  }, [w.ticker[0]]);
  return null;
}

type CtxRow = { k: string; badge: string; text: string; ts: number; color?: string; deny?: boolean };
/** the agent's last few decisions, tool / MCP calls and orders, newest first (from the world state) */
function recentContext(i: Instance, n = 6): CtxRow[] {
  const rows: CtxRow[] = [];
  i.decisions.slice(-5).forEach((d, k) =>
    rows.push({ k: `d${k}`, badge: isDeny(d) ? "DENY" : kindBadge(d.kind), text: `${decisionText(d)} · ${Math.round(d.ms)}ms`, ts: d.ts, color: decisionColor(d), deny: isDeny(d) }),
  );
  i.orders.slice(-3).forEach((o, k) => rows.push({ k: `o${k}`, badge: o.dry_run ? "paper" : o.status, text: `${orderText(o)} ${o.instrument}`, ts: o.ts, color: orderColor(o) }));
  let calls = 0;
  for (const e of i.recent) {
    if (calls >= 5) break;
    if (e.type === "tool") rows.push({ k: `t${calls++}`, badge: "tool", text: e.tool, ts: e.ts });
    else if (e.type === "mcp" && e.phase === "call") rows.push({ k: `m${calls++}`, badge: "MCP", text: `${e.server} · ${e.tool}`, ts: e.ts });
  }
  return rows.sort((a, b) => b.ts - a.ts).slice(0, n);
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
const detailValue = (v: string | number | boolean) => (typeof v === "boolean" ? (v ? "yes" : "no") : String(v));
const RESOLVED_CLOSE_MS = 4000;

/** Side drawer for one waiting agent: what it waits on, why (the triggering decision), the app's details, recent
 * context, the deadline, Approve / Reject with a note, "Open in app" and "Copy link". The scene keeps running. */
function ApprovalDrawer({ id, rail, canApprove, embedded }: { id: string; rail: boolean; canApprove: boolean; embedded: boolean }) {
  const w = useWorld();
  const ref = useRef<HTMLElement>(null);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  const [, bump] = useState(0);
  const last = useRef<Instance["wait"]>(null);
  useEffect(() => {
    const t = setInterval(() => bump((x) => x + 1), 1000);
    const f = () => bump((x) => x + 1);
    verdictSubs.add(f);
    return () => (clearInterval(t), void verdictSubs.delete(f));
  }, []);
  useEffect(() => {
    setNote("");
    setCopied(false);
    ref.current?.focus({ preventScroll: true });
  }, [id]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && openDrawer(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);
  const i = getInstance(id)!;
  const waiting = needsHuman(i);
  if (waiting) last.current = i.wait;
  const wt = waiting ? i.wait! : last.current;
  useEffect(() => {
    if (waiting) return;
    const t = setTimeout(() => drawer.id === id && openDrawer(null), RESOLVED_CLOSE_MS); // resolved: close soon
    return () => clearTimeout(t);
  }, [waiting, id]);
  const run = w.runs.get(i.run);
  const stale = isStale(run);
  const [left, late] = !waiting ? ["", ""] : stale ? [STALE_TEXT, "overdue"] : deadlineText(i, Date.now());
  const v = wt ? verdicts.get(`${i.id}|${wt.reason}|${wt.until}`) : undefined;
  const locked = v !== undefined && v !== "error";
  const ctx = recentContext(i);
  const b = wt?.because;
  const onKey = (e: ReactKeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || e.metaKey || e.ctrlKey || e.altKey || !waiting || !canApprove || stale || locked) return;
    if (e.key === "a" || e.key === "A") (e.preventDefault(), decide(i, true, note));
    else if (e.key === "r" || e.key === "R") (e.preventDefault(), decide(i, false, note));
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(deepLink(i));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", deepLink(i));
    }
  };
  const title = wt?.title || wt?.reason || "waiting";
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      onKeyDown={onKey}
      className={`hud hud-drawer${rail ? " is-rail" : ""}`}
      role="dialog"
      aria-label={`Waiting on you: ${title}`}
      style={{ ["--c" as string]: TYPE_COLOR[i.type] }}
    >
      <header className="hd-head">
        <div>
          <p className="hd-kicker">{waiting ? (wt?.kind === "approval" || /human|approv/i.test(wt?.reason ?? "") ? "needs your approval" : "waiting") : "resolved"}</p>
          <h3>{title}</h3>
        </div>
        <button className="hd-close" onClick={() => openDrawer(null)} aria-label="Close details (Esc)" title="Close (Esc)">
          ×
        </button>
      </header>
      <button className="hd-who" onClick={() => selectInstance(i.id)} title="Select in the scene">
        <i />
        <b>{i.name}</b>
        <span>{run?.topic ?? shortRun(i.run)}</span>
      </button>
      <div className={`hd-deadline${late ? ` is-${late}` : !waiting && (v === "approved" || v === "approving") ? " is-due" : ""}`} role="status">
        {!waiting ? (v ? VERDICT_TEXT[v] : "no longer waiting") : left ? (late ? left : `deadline in ${left}`) : "no deadline"}
      </div>
      <section>
        <h4>Why</h4>
        {b ? (
          <div className={`hd-why${b.result === "no" ? " is-deny" : ""}`}>
            <p>
              <b>{kindBadge(b.kind)}</b> {b.question} → <em>{b.result}</em>
              {b.p !== undefined && <> · p {pct(b.p)}</>}
            </p>
            <dl className="hd-dl">
              {b.threshold !== undefined && (
                <div>
                  <dt>threshold</dt>
                  <dd>{b.threshold <= 1 ? pct(b.threshold) : b.threshold}</dd>
                </div>
              )}
              {b.provider && (
                <div>
                  <dt>decided by</dt>
                  <dd>{providerBadge(b.provider)}</dd>
                </div>
              )}
              {b.ms !== undefined && (
                <div>
                  <dt>latency</dt>
                  <dd>{Math.round(b.ms)} ms</dd>
                </div>
              )}
              {b.purpose && (
                <div>
                  <dt>purpose</dt>
                  <dd>
                    {b.purpose}
                    {b.target ? ` · ${b.target}` : ""}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        ) : (
          <p className="hd-reason">waiting on {wt?.reason ?? "a human"}</p>
        )}
      </section>
      {wt?.details && Object.keys(wt.details).length > 0 && (
        <section>
          <h4>Details</h4>
          <dl className="hd-dl hd-details">
            {Object.entries(wt.details).map(([k, val]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd title={detailValue(val)}>{detailValue(val)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {ctx.length > 0 && (
        <section>
          <h4>Recent</h4>
          <ul className="ap-decisions">
            {ctx.map((r) => (
              <li key={r.k} className={r.deny ? "is-deny" : undefined} style={r.color ? { ["--c" as string]: r.color } : undefined}>
                <b>{r.badge}</b>
                <span>{r.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <footer className="hd-foot">
        {waiting && canApprove && !stale && (
          <>
            {!locked && (
              <textarea
                className="hd-note"
                value={note}
                maxLength={500}
                rows={2}
                placeholder="Note (optional, sent with your decision)"
                onChange={(e) => setNote(e.target.value)}
                aria-label="Note sent with your decision"
              />
            )}
            <ApproveButtons i={i} note={note.trim() || undefined} keys />
            {!locked && <p className="hd-keys">A approve · R reject · Esc close</p>}
          </>
        )}
        <div className="hd-links">
          {wt?.url && (
            <a href={wt.url} target="_blank" rel="noopener noreferrer">
              Open in app ↗
            </a>
          )}
          {!embedded && (
            <button onClick={copy} title="Link to AgentGlow focused on this run and agent">
              {copied ? "Link copied" : "Copy link"}
            </button>
          )}
        </div>
      </footer>
    </aside>
  );
}

/** hover tooltip of a halo label: its latency (p50 / p95, in flight), which the label itself leaves out */
function HaloTip() {
  const id = useSyncExternalStore(
    (f) => (haloHover.subs.add(f), () => void haloHover.subs.delete(f)),
    () => haloHover.id,
    () => null,
  );
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!id) return;
    const move = (e: PointerEvent) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [id]);
  const i = id ? getInstance(id) : undefined;
  if (!i?.hv || !pos.x) return null;
  return (
    <div className="hud-halotip" style={{ left: pos.x + 14, top: pos.y + 14 }} role="tooltip">
      <b>{i.name}</b> {haloText(i.hv)}
      <br />
      {haloLatency(i.hv)}
    </div>
  );
}

const TRAY_MAX = 3;

/** Bottom-left "needs you" tray: agents waiting on a human, soonest deadline first, each with Approve / Reject. */
function ApprovalTray({ rail }: { rail: boolean }) {
  const w = useWorld();
  const [, bump] = useState(0);
  useEffect(() => {
    const t = setInterval(() => bump((x) => x + 1), 1000); // countdowns / overdue without new events
    return () => clearInterval(t);
  }, []);
  const waiting = [...w.instances.values()].filter(needsHuman).sort((a, b) => (a.wait!.until || Infinity) - (b.wait!.until || Infinity));
  if (!waiting.length) return null;
  const now = Date.now();
  return (
    <section className={`hud hud-approvals${rail ? " is-rail" : ""}`} aria-label="Agents waiting on you">
      <h4>
        Needs you <em>{waiting.length}</em>
      </h4>
      <ul>
        {waiting.slice(0, TRAY_MAX).map((i) => {
          const stale = isStale(w.runs.get(i.run));
          const [left, late] = stale ? [STALE_TEXT, "overdue" as const] : deadlineText(i, now);
          return (
            <li key={i.id} style={{ ["--c" as string]: TYPE_COLOR[i.type] }}>
              <button className="ha-who" onClick={() => openDrawer(i.id)} title={`${i.name} · ${shortRun(i.run)}\n${waitLabel(i.wait!)}\nclick for details`}>
                <i />
                <b>{i.name}</b>
                <span>
                  {i.wait!.title || i.wait!.reason}
                  {left && (late ? <em className={`ha-late is-${late}`}> · {left}</em> : ` · ${left}`)}
                </span>
              </button>
              <button className="ha-details" onClick={() => openDrawer(i.id)} aria-label={`Details: ${i.wait!.title || i.wait!.reason}`}>
                Details
              </button>
              {!stale && <ApproveButtons i={i} compact />}
            </li>
          );
        })}
      </ul>
      {waiting.length > TRAY_MAX && <p>+{waiting.length - TRAY_MAX} more waiting (Agents → waiting)</p>}
    </section>
  );
}

// ------------------------------------------------------------------ sidebar: Agents tab + Selected inspector

type StatusFilter = "all" | "alive" | "thinking" | "waiting" | "done";
const STATUS_FILTERS: StatusFilter[] = ["all", "alive", "thinking", "waiting", "done"];

function matchesStatus(i: Instance, f: StatusFilter) {
  if (f === "all") return true;
  if (f === "alive") return isLive(i);
  if (f === "done") return !isLive(i);
  return isLive(i) && i.status === f;
}

/** "working" for an agent that is busy without spending tokens (code gates, a classifier): it is not "thinking" */
function statusText(i: Instance) {
  return i.status === "thinking" && i.tokens === 0 ? "working" : i.status;
}

function age(i: Instance) {
  const s = ((i.doneAt || i.exitAt || performance.now()) - i.bornAt) / 1000;
  return s < 60 ? `${s.toFixed(0)}s` : `${(s / 60).toFixed(1)}m`;
}

/** the skill this agent is using right now ("" = none) */
function activeSkill(i: Instance): string {
  if (!isLive(i) || !i.skill || i.skillEndAt) return "";
  return i.skill;
}

function AgentList() {
  const w = useWorld();
  const [q, setQ] = useState("");
  const [types, setTypes] = useState<Set<string>>(new Set()); // filter by real agent name
  const [status, setStatus] = useState<StatusFilter>("alive");
  const [run, setRun] = useState("");

  const all = useMemo(() => [...w.instances.values(), ...[...w.archive.values()].reverse()], [w.instances.size, w.archive.size, w.ticker]);
  const runOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of all) m.set(i.run, w.runs.get(i.run)?.topic ?? i.run);
    return [...m];
  }, [all]);
  const needle = q.trim().toLowerCase();
  const rows = all
    .filter((i) => !isDismissed(i.run))
    .filter((i) => (types.size ? types.has(i.name) : true))
    .filter((i) => matchesStatus(i, status))
    .filter((i) => (run ? i.run === run : true))
    .filter((i) => {
      if (!needle) return true;
      const topic = w.runs.get(i.run)?.topic ?? "";
      return `${i.id} ${i.name} ${topic} ${[...i.nodes].join(" ")}`.toLowerCase().includes(needle);
    })
    .sort((a, b) => Number(!isLive(a)) - Number(!isLive(b)) || Number(b.status === "thinking") - Number(a.status === "thinking") || b.bornAt - a.bornAt);
  const shown = rows.slice(0, 150);
  // legend = the agents actually present (by name), not fixed demo roles
  const legend = useMemo(() => {
    const m = new Map<string, { color: string; alive: number }>();
    for (const i of all) {
      const e = m.get(i.name) ?? { color: TYPE_COLOR[i.type], alive: 0 };
      if (isLive(i)) e.alive++;
      m.set(i.name, e);
    }
    return [...m].slice(0, 12);
  }, [all]);
  const toggleType = (t: string) =>
    setTypes((prev) => {
      const n = new Set(prev);
      n.has(t) ? n.delete(t) : n.add(t);
      return n;
    });

  return (
    <>
      <div className="ap-searchrow">
        <input className="ap-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agent or run topic…" aria-label="Search agents" />
        <span className="ap-count" title="matching / all agents">
          {rows.length}
          {rows.length !== all.length ? ` / ${all.length}` : ""}
        </span>
      </div>
      <div className="ap-chips">
        {legend.map(([name, a]) => (
          <button key={name} className={types.has(name) ? "on" : ""} aria-pressed={types.has(name)} style={{ ["--c" as string]: a.color }} onClick={() => toggleType(name)}>
            <i />
            {name}
            <em>{a.alive || ""}</em>
          </button>
        ))}
      </div>
      <div className="ap-row-filters">
        <div className="ap-seg">
          {STATUS_FILTERS.map((f) => (
            <button key={f} className={status === f ? "on" : ""} aria-pressed={status === f} onClick={() => setStatus(f)}>
              {f}
            </button>
          ))}
        </div>
        <select value={run} aria-label="Filter by run" onChange={(e) => setRun(e.target.value)}>
          <option value="">all runs</option>
          {runOptions.map(([id, topic]) => (
            <option key={id} value={id}>
              {topic}
            </option>
          ))}
        </select>
      </div>
      <ul className="ap-list">
        {shown.map((i) => (
          <li key={i.id}>
            <button onClick={() => selectInstance(i.id)} style={{ ["--c" as string]: TYPE_COLOR[i.type] }} className={isLive(i) ? "" : "is-done"}>
              <i data-status={isLive(i) ? i.status : "done"} />
              <span className="ap-name">
                <span className="ap-title">
                  {short(i.id)}
                  {activeSkill(i) && (
                    <em className="ap-skill" title={`using skill ${activeSkill(i)}`}>
                      {activeSkill(i)}
                    </em>
                  )}
                </span>
                <small>{w.runs.get(i.run)?.topic ?? "finished run"}</small>
              </span>
              <span className="ap-meta">
                <b>{statusText(i)}</b>
                {(i.tokens / 1000).toFixed(1)}k · {age(i)}
              </span>
            </button>
          </li>
        ))}
        {rows.length > shown.length && <li className="ap-more">+{rows.length - shown.length} more - refine the filter</li>}
        {rows.length === 0 && <li className="ap-more">No agents match.</li>}
      </ul>
    </>
  );
}

/** "approval: waiting on approval" for a run paused in a wait, else "" */
function runWaitText(run: Run): string {
  const s = run.stepOrder.find((x) => chipState(run, x)[0] === "waiting");
  return s ? chipState(run, s)[1] : "";
}

const LINEAGE_MAX = 12;
function AgentDetail({ i }: { i: Instance }) {
  const w = useWorld();
  const canApprove = useApproveAvailable() && w.mode === "live";
  const run = w.runs.get(i.run);
  const chips = run?.hasSteps ? stepChips(run) : null;
  const parent = getInstance(i.parent);
  const children = [...w.instances.values(), ...w.archive.values()].filter((c) => c.parent === i.id);
  // a long-lived service has hundreds of finished tasks / jobs: live ones first, then the newest finished, capped
  const lineage = children.length <= LINEAGE_MAX ? children : [...children.filter((c) => !isDone(c)), ...children.filter(isDone).reverse()].slice(0, LINEAGE_MAX);
  const pending = [...w.mcpPending.values()].filter((p) => p.instance === i.id);
  return (
    <div className="ap-detail" style={{ ["--c" as string]: TYPE_COLOR[i.type] }}>
      <h3>
        <i /> {i.name} <small>{i.subagent ? "subagent" : "agent"} · {shortRun(i.run)}</small>
      </h3>
      <div className="ap-status" data-status={isLive(i) ? i.status : "done"}>
        {isLive(i) ? (i.status === "waiting" && i.wait ? waitLabel(i.wait) : statusText(i)) : `finished (${i.status})`} · alive {age(i)}
      </div>
      {canApprove && needsHuman(i) && (
        <div className="ap-approve-row">
          <ApproveButtons i={i} />
          <button className="ha-details" onClick={() => openDrawer(i.id)}>
            Details
          </button>
        </div>
      )}
      <dl className="ap-stats">
        <div>
          <dt>tokens</dt>
          <dd title="prompt + completion tokens; cached = prompt-cache reads, already counted in the prompt">
            {(i.tokens / 1000).toFixed(1)}k{i.tokensCached > 0 ? ` (${(i.tokensCached / 1000).toFixed(1)}k cached)` : ""}
          </dd>
        </div>
        <div>
          <dt>LLM calls</dt>
          <dd>{i.llmCalls}</dd>
        </div>
        <div>
          <dt>tool calls</dt>
          <dd>{i.toolCalls}</dd>
        </div>
        <div>
          <dt>MCP calls</dt>
          <dd>{i.mcpCalls}</dd>
        </div>
      </dl>
      <section>
        <h4 className="ap-runhead">
          Run
          {run && run.workflow !== "services" && (
            <button className="ap-dismiss" onClick={() => dismissRun(run.id)} aria-label="Hide this run" title="Hide this run for you (comes back on new activity)">
              ×
            </button>
          )}
        </h4>
        <p>{run ? run.topic : i.run}</p>
        {run && isIdle(run) && (
          <p className="ap-idle" title="No events for a while. A run that stays silent and is not waiting (no open wait / approval) is closed as abandoned after 30 min (server AGENTGLOW_RUN_IDLE_MIN) and fades out">
            {idleText(run)}
          </p>
        )}
        {run && isStale(run) && <p className="ap-wait">{STALE_TEXT}</p>}
        {run && runWaitText(run) && <p className="ap-wait">{runWaitText(run)}</p>}
        {run && chips && (
          <div className="ap-steps">
            {chips.shown.map((s) => {
              const [st, title] = chipState(run, s);
              return (
                <span key={s} data-status={st} title={title}>
                  {s}
                </span>
              );
            })}
            {chips.more > 0 && <span title={run.stepOrder.slice(-chips.more).map((s) => chipState(run, s)[1]).join("\n")}>+{chips.more}</span>}
          </div>
        )}
      </section>
      {(parent || children.length > 0) && (
        <section>
          <h4>Lineage</h4>
          {parent && (
            <button className="ap-chip-link" style={{ ["--c" as string]: TYPE_COLOR[parent.type] }} onClick={() => selectInstance(parent.id)}>
              ↑ spawned by {short(parent.id)}
            </button>
          )}
          {lineage.map((c) => (
            <button key={c.id} className="ap-chip-link" style={{ ["--c" as string]: TYPE_COLOR[c.type] }} onClick={() => selectInstance(c.id)}>
              ↓ {short(c.id)} {isDone(c) ? "✓" : ""}
            </button>
          ))}
          {children.length > lineage.length && <p className="ap-more">+{children.length - lineage.length} more finished</p>}
        </section>
      )}
      {children.some((c) => c.job && !c.job.end) && (
        <section>
          <h4>In flight{i.hv?.inflight ? ` · ${i.hv.inflight}` : ""}</h4>
          {children
            .filter((c) => c.job && !c.job.end)
            .map((c) => (
              <button key={c.id} className="ap-chip-link" style={{ ["--c" as string]: "#fbbf24" }} onClick={() => selectInstance(c.id)}>
                {jobText(c)}
              </button>
            ))}
        </section>
      )}
      {i.skills.size > 0 && (
        <section>
          <h4>Skills used</h4>
          <div className="ap-skills">
            {[...i.skills].map(([name, u]) => (
              <span key={name} className={u.active && isLive(i) ? "on" : ""} title={u.active && isLive(i) ? "in use now" : `used ${u.count}x`}>
                {name}
                <em>{u.count}x</em>
              </span>
            ))}
          </div>
        </section>
      )}
      {i.hv && (
        <section>
          <h4>{i.hv.unit ? `Traffic${i.svcN ? ` · ${i.svcN} handled${i.svcErr ? `, ${i.svcErr} errors` : ""}` : ""}` : "Decision rate"} {hvActive(i) ? "" : "(quiet)"}</h4>
          <p className="ap-hv">{haloText(i.hv)} · {haloLatency(i.hv)}</p>
          <div className="ap-hv-bar" title="outcome mix (smoothed)">
            {i.hv.seg.map((f, k) =>
              f > 0.005 ? <span key={k} style={{ flexGrow: f, background: HALO_COLORS[k] }} title={`${segName(k)} ${Math.round(f * 100)}%`} /> : null,
            )}
          </div>
        </section>
      )}
      {i.orders.length > 0 && (
        <section>
          <h4>Orders</h4>
          <ul className="ap-decisions">
            {[...i.orders].reverse().map((o, k) => (
              <li key={k} className={o.status === "rejected" || o.status === "cancelled" ? "is-strike" : undefined} style={{ ["--c" as string]: orderColor(o) }} title={o.reason || o.instrument}>
                <b>{o.dry_run ? "paper" : o.status}</b>
                <span>{orderText(o)}</span>
                <em>{o.instrument}</em>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ServiceDetail i={i} />
      <PrimDetail i={i} />
      {i.decisions.length > 0 && (
        <section>
          <h4>{i.hv ? "Interesting decisions" : "Decisions"}</h4>
          <ul className="ap-decisions">
            {[...i.decisions].reverse().map((d, k) => (
              <li key={k} className={isDeny(d) ? "is-deny" : undefined} style={{ ["--c" as string]: decisionColor(d) }} title={`${kindBadge(d.kind)} · ${providerBadge(d.provider)} · ${d.question}${d.options?.length ? "\n" + d.options.map((o) => `${o.name} ${Math.round(o.p * 100)}%`).join("\n") : ""}`}>
                <b>{d.why ? whyBadge(d.why) : isDeny(d) ? "DENY" : kindBadge(d.kind)}</b>
                <span>{decisionText(d)}</span>
                <em>{Math.round(d.ms)}ms</em>
              </li>
            ))}
          </ul>
        </section>
      )}
      {pending.length > 0 && (
        <section>
          <h4>Waiting on MCP</h4>
          {pending.map((p) => (
            <p key={p.key} className="ap-wait">
              {p.server}.{p.tool}() · {waitSeconds(p).toFixed(1)}s
            </p>
          ))}
        </section>
      )}
      {i.chat.length > 0 && (
        <section>
          <h4>Conversation</h4>
          <ul className="ap-chat">
            {i.chat.map((c, k) => (
              <li key={k} data-role={c.role}>
                <b>{c.role === "user" ? "you" : i.name}:</b> {c.text}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h4>Activity</h4>
        <ul className="ap-events">
          {i.recent.map((e, k) => (
            <li key={k}>{describe(e)}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** halo category label: route slots show the route result name */
function segName(k: number): string {
  const c = HALO_CATS[k];
  if (c.startsWith("r") && c.length === 2) {
    for (const [name, slot] of routeSlots) if (`r${slot}` === c) return name;
  }
  return c === "yes" ? "check yes" : c === "no" ? "check no" : c;
}
