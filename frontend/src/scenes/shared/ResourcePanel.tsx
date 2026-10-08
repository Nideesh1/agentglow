/**
 * Resource details (Selected panel) for every non-agent icon: MCP servers / resource groups, their resources
 * (databases, caches, queues, HTTP hosts, models, pools) and agent / service -> server links. One generic layout
 * (header, stats, sparkline, top callers, recent calls) plus a kind-specific section. Data: resinfo.ts (counted from
 * `mcp` events) + world.resStats (`resource_stats`) + world.backlogs. Only labels the server already scrubbed:
 * operation verbs, hosts / systems, status codes, latencies; never statements, keys, URLs or bodies.
 */
import { useEffect, useState, type ReactNode } from "react";
import { fmtMs } from "./prims";
import { aggOf, opOf, pct, ratePerS, resInfo, sparkSeries, type Agg, type ResSel, type ToolAgg } from "./resinfo";
import { collectionNoun, collectionNouns, getInstance, mcpTitle, modelGroupPrefix, selectInstance, selectResource, serverLabel, useWorld, world, type Instance, type ResourceKind } from "./world";

const ICON: Record<string, string> = { server: "◆", database: "⛁", link: "─", db: "▦", warehouse: "▥", storage: "▣", spark: "✶", api: "⇄", queue: "≡", model: "◈", llm: "✦", gpu: "▧", worker: "▢", cache: "◎" };
const KIND_TEXT: Record<string, string> = { db: "database", warehouse: "warehouse", storage: "object storage", spark: "compute", api: "HTTP host", queue: "queue / topic", model: "ML model", llm: "LLM", gpu: "GPU pool", worker: "worker pool", cache: "cache" };
const ERR = "#fb7185";
const OK = "#4ade80";
const AMBER = "#fbbf24";

const ms = (v?: number) => (v === undefined ? "-" : fmtMs(v));
const ago = (at: number, now: number) => `${fmtMs(Math.max(0, now - at))} ago`;
const nameOf = (id: string) => getInstance(id)?.name ?? id.replace(/^svc:/, "");
const kfmt = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n * 10) / 10}`);

function useTick(msEvery = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), msEvery);
    return () => clearInterval(t);
  }, [msEvery]);
}

function Spark({ a, now, color }: { a: Agg; now: number; color: string }) {
  const s = sparkSeries(a, now);
  const max = Math.max(1, ...s);
  const w = 240;
  const h = 34;
  const bw = w / s.length;
  return (
    <svg className="rp-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="calls per second, last minute">
      {s.map((v, k) => (v > 0 ? <rect key={k} x={k * bw + 0.5} y={h - (v / max) * (h - 2)} width={Math.max(1, bw - 1)} height={(v / max) * (h - 2)} fill={color} opacity={0.35 + (0.65 * k) / s.length} /> : null))}
    </svg>
  );
}

/** a mix bar + legend from label -> count */
function Mix({ items, colors }: { items: [string, number][]; colors?: Record<string, string> }) {
  const tot = items.reduce((x, [, n]) => x + n, 0) || 1;
  const pal = ["#60a5fa", "#a78bfa", "#34d399", "#f472b6", "#fbbf24", "#22d3ee", "#94a3b8"];
  const col = (l: string, k: number) => colors?.[l] ?? pal[k % pal.length];
  return (
    <>
      <div className="ap-hv-bar">
        {items.map(([l, n], k) => (
          <span key={l} style={{ flexGrow: n / tot, background: col(l, k) }} title={`${l} ${Math.round((n / tot) * 100)}%`} />
        ))}
      </div>
      <p className="rp-legend">
        {items.map(([l, n], k) => (
          <span key={l} style={{ ["--c" as string]: col(l, k) }}>
            {l} <em>{Math.round((n / tot) * 100)}%</em>
          </span>
        ))}
      </p>
    </>
  );
}

function ToolTable({ tools, label }: { tools: [string, ToolAgg][]; label: string }) {
  if (!tools.length) return null;
  return (
    <table className="rp-table">
      <thead>
        <tr>
          <th>{label}</th>
          <th>calls</th>
          <th>p50</th>
          <th>p95</th>
          <th>err</th>
        </tr>
      </thead>
      <tbody>
        {tools.map(([n, t]) => (
          <tr key={n}>
            <td title={n}>{n}</td>
            <td>{kfmt(t.calls)}</td>
            <td>{ms(pct(t.lat, 0.5))}</td>
            <td>{ms(pct(t.lat, 0.95))}</td>
            <td style={t.errors ? { color: ERR } : undefined}>{t.errors}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** tools grouped by operation verb (first word): `SELECT`, `GET`, `infer` */
function byOp(a: Agg): [string, ToolAgg][] {
  const m = new Map<string, ToolAgg>();
  for (const [n, t] of a.tools) {
    const k = opOf(n).toUpperCase();
    const o = m.get(k) ?? { calls: 0, errors: 0, lat: [] };
    o.calls += t.calls;
    o.errors += t.errors;
    o.lat = o.lat.concat(t.lat).slice(-400);
    m.set(k, o);
  }
  return [...m].sort((x, y) => y[1].calls - x[1].calls);
}

const sortTools = (a: Agg) => [...a.tools].sort((x, y) => y[1].calls - x[1].calls).slice(0, 12);

function KindSection({ sel, a, kind }: { sel: ResSel; a: Agg; kind: string }) {
  const now = performance.now();
  if (sel.type === "server") {
    const srv = world.mcpServers.get(sel.server);
    const res = srv ? [...srv.resources.values()].sort((x, y) => y.calls - x.calls) : [];
    if (srv?.kind === "database") {
      // a database node: its collections / tables / indices with query counts, then the operation mix
      const noun = collectionNoun(sel.server);
      const ops = sortTools(a);
      return (
        <>
          {res.length > 0 && (
            <section>
              <h4>{collectionNouns(sel.server).replace(/^./, (c) => c.toUpperCase())}</h4>
              <table className="rp-table">
                <thead>
                  <tr>
                    <th>{noun}</th>
                    <th>queries</th>
                    <th>p50</th>
                  </tr>
                </thead>
                <tbody>
                  {res.map((r) => {
                    const ra = resInfo.backends.get(`${sel.server}|${r.name}`);
                    return (
                      <tr key={r.name} className="rp-click" onClick={() => selectResource({ type: "backend", server: sel.server, resource: r.name })} title={`details of ${noun} ${r.name}`}>
                        <td title={r.name}>{r.name}</td>
                        <td>{kfmt(ra?.calls ?? r.calls)}</td>
                        <td>{ms(ra ? pct(ra.lat, 0.5) : undefined)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}
          <section>
            <h4>Operations</h4>
            <ToolTable tools={ops} label="operation" />
            <p className="rp-note">operation names only: statements are never sent</p>
          </section>
        </>
      );
    }
    return (
      <>
        <section>
          <h4>Tools</h4>
          <ToolTable tools={sortTools(a)} label="tool" />
        </section>
        {res.length > 0 && (
          <section>
            <h4>Resources</h4>
            {res.map((r) => (
              <button key={r.name} className="ap-chip-link" style={{ ["--c" as string]: srv?.color ?? "#94a3b8" }} onClick={() => selectResource({ type: "backend", server: sel.server, resource: r.name })}>
                {ICON[r.sub] ?? "·"} {r.name} <em>{KIND_TEXT[r.sub] ?? r.sub} · {kfmt(r.calls)}</em>
              </button>
            ))}
          </section>
        )}
      </>
    );
  }
  if (sel.type === "link") {
    return (
      <>
        <section>
          <h4>Operations on this link</h4>
          <ToolTable tools={sortTools(a)} label="operation" />
        </section>
        {a.resources.size > 0 && (
          <section>
            <h4>Resources reached</h4>
            {[...a.resources].map(([r, n]) => (
              <button key={r} className="ap-chip-link" style={{ ["--c" as string]: "#94a3b8" }} onClick={() => selectResource({ type: "backend", server: sel.server, resource: r })}>
                {r} <em>{kfmt(n)}</em>
              </button>
            ))}
          </section>
        )}
      </>
    );
  }
  const st = world.resStats.get(`${sel.server}|${sel.resource}`);
  const ops = byOp(a);
  const opMix = ops.map(([k, t]) => [k, t.calls] as [string, number]).filter(([, n]) => n > 0);
  const rows: [string, ReactNode, string?][] = [];
  let body: ReactNode = null;
  if (kind === "db" || kind === "warehouse" || kind === "storage" || kind === "spark") {
    const slow = [...ops].filter(([, t]) => t.lat.length).sort((x, y) => (pct(y[1].lat, 0.95) ?? 0) - (pct(x[1].lat, 0.95) ?? 0)).slice(0, 3);
    body = (
      <>
        {opMix.length > 0 && (
          <section>
            <h4>Operation mix</h4>
            <Mix items={opMix} />
          </section>
        )}
        {slow.length > 0 && (
          <section>
            <h4>Slowest operations</h4>
            <ToolTable tools={slow} label="operation" />
            <p className="rp-note">operation names only: statements are never sent</p>
          </section>
        )}
      </>
    );
  } else if (kind === "cache") {
    const hits = st?.hits ?? a.tools.get("hit")?.calls ?? 0;
    const misses = st?.misses ?? a.tools.get("miss")?.calls ?? 0;
    if (hits + misses > 0) rows.push(["hit ratio", `${Math.round((hits / (hits + misses)) * 100)}%`, hits / (hits + misses) < 0.5 ? AMBER : OK], ["hits / misses", `${hits} / ${misses}`]);
    body = opMix.length > 0 && (
      <section>
        <h4>Command mix</h4>
        <Mix items={opMix} colors={{ HIT: OK, MISS: AMBER }} />
      </section>
    );
  } else if (kind === "queue") {
    let pub = 0, con = 0;
    for (const [k, t] of ops) {
      if (/^(PUBLISH|SEND|PRODUCE|XADD|LPUSH|RPUSH|PUT|ENQUEUE)/.test(k)) pub += t.calls;
      else if (/^(CONSUME|RECEIVE|PROCESS|XREAD|XREADGROUP|BLPOP|BRPOP|GET|POLL|DEQUEUE)/.test(k)) con += t.calls;
    }
    const span = Math.max(1, Math.min(60, (now - a.first) / 1000));
    rows.push(["publish", `${kfmt(pub / span)}/s`], ["consume", `${kfmt(con / span)}/s`]);
    const bl = world.backlogs.get(sel.resource);
    if (bl) {
      rows.push(["depth", `${bl.depth}${bl.pending !== undefined ? ` · ${bl.pending} pending` : ""}`]);
      if (bl.lag !== undefined) rows.push(["lag", ms(bl.lag), bl.lag > 5000 ? AMBER : undefined]);
      if (bl.to) rows.push(["consumer", nameOf(bl.to)]);
    }
    body = opMix.length > 0 && (
      <section>
        <h4>Operations</h4>
        <Mix items={opMix} />
      </section>
    );
  } else if (kind === "api") {
    const codes = [...a.statuses].sort();
    body = (
      <>
        {opMix.length > 0 && (
          <section>
            <h4>Methods</h4>
            <Mix items={opMix} />
          </section>
        )}
        {codes.length > 0 && (
          <section>
            <h4>Status</h4>
            <Mix items={codes} colors={{ "2xx": OK, "3xx": "#60a5fa", "4xx": AMBER, "5xx": ERR }} />
          </section>
        )}
        <p className="rp-note">host only: paths, ids and bodies are never sent</p>
      </>
    );
  } else if (kind === "model" || kind === "llm") {
    // session total (counted from results) first: resource_stats units cover one window only
    const units = a.units || st?.units;
    const unit = a.unit ?? st?.unit ?? "";
    if (units && unit !== "calls") rows.push([kind === "llm" ? "units" : "units scored", `${kfmt(units)} ${unit}`.trim()]);
    if (st?.rtf !== undefined) rows.push(["RTF", `${st.rtf}`]);
    if (a.device) rows.push(["device", a.device]);
    rows.push(["last latency", ms(a.lastMs)]);
  }
  if (st && (st.size !== undefined || st.busy !== undefined)) {
    if (st.size !== undefined) rows.push(["capacity", `${st.size}`]);
    if (st.busy !== undefined) rows.push(["in use", `${st.busy}${st.size ? `/${st.size}` : ""}`, st.size && st.busy >= st.size ? AMBER : undefined]);
    if (st.waiting !== undefined) rows.push(["waiters", `${st.waiting}`, st.waiting ? AMBER : undefined]);
    if (st.wait_p50_ms !== undefined) rows.push(["wait p50", ms(st.wait_p50_ms)]);
    if (st.devices?.length) rows.push(["devices", st.devices.map((d) => `${d.device} ${d.busy}`).join(" · ")]);
  }
  return (
    <>
      {rows.length > 0 && (
        <section>
          <h4>{KIND_TEXT[kind] ?? kind}</h4>
          <dl className="rp-kv">
            {rows.map(([k, v, c]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd style={c ? { color: c } : undefined}>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {body}
    </>
  );
}

/** The Resource details panel for a selected server / backend / link. */
export function ResourceDetail({ sel, onClose }: { sel: ResSel; onClose: () => void }) {
  useWorld();
  useTick(1000);
  const now = performance.now();
  const a = aggOf(sel);
  const srv = world.mcpServers.get(sel.server);
  const color = srv?.color ?? "#94a3b8";
  const isDb = srv?.kind === "database" || world.mcpKinds.get(sel.server) === "database";
  const kind: string = sel.type === "backend" ? (a?.kind ?? srv?.resources.get(sel.resource)?.sub ?? world.mcpRegistry.get(sel.server)?.get(sel.resource) ?? "api") : sel.type;
  const isModel = sel.type === "backend" && (kind === "model" || kind === "llm");
  const title =
    sel.type === "server"
      ? mcpTitle({ name: sel.server, kind: srv?.kind ?? world.mcpKinds.get(sel.server) })
      : sel.type === "backend"
        ? isModel
          ? `${kind === "llm" ? "LLM" : "ML model"} · ${sel.resource}`
          : sel.resource
        : `${nameOf(sel.id)} → ${serverLabel(sel.server)}`;
  // a model: "N predictions" (units scored, in their unit) or "N calls"
  const modelCount = (() => {
    if (!isModel) return "";
    const st = world.resStats.get(`${sel.server}|${sel.type === "backend" ? sel.resource : ""}`);
    const units = a?.units || st?.units;
    const unit = a?.unit ?? st?.unit;
    return units && unit && unit !== "calls" ? `${kfmt(units)} ${unit}` : `${kfmt(a?.calls ?? 0)} calls`;
  })();
  const svcCaller = a && [...a.callers].filter(([id]) => id.startsWith("svc:")).sort((x, y) => y[1] - x[1])[0];
  const sub =
    sel.type === "server"
      ? srv?.kind === "model"
        ? `${modelGroupPrefix(sel.server) === "LLM" ? "LLM" : modelGroupPrefix(sel.server) === "ML" ? "ML model" : "model"} group`
        : isDb
          ? `database · ${srv?.resources.size ?? 0} ${srv?.resources.size === 1 ? collectionNoun(sel.server) : collectionNouns(sel.server)}`
          : srv?.kind === "api" || world.mcpKinds.get(sel.server) === "api"
            ? "external API host"
            : srv?.kind === "storage" || world.mcpKinds.get(sel.server) === "storage"
              ? "object storage host"
              : sel.server === "backend" && !srv?.kind
                ? "backend resources (pools, models, caches)"
                : "MCP server / resource group"
      : isModel
        ? `${modelCount} · in ${sel.server}`
        : sel.type === "backend"
        ? `${isDb ? collectionNoun(sel.server) : (KIND_TEXT[kind] ?? kind)} · in ${isDb ? `database ${serverLabel(sel.server)}` : sel.server}${svcCaller ? ` · used by ${nameOf(svcCaller[0])}` : ""}`
        : "link";
  const callers = a ? [...a.callers].sort((x, y) => y[1] - x[1]).slice(0, 8) : [];
  return (
    <div className="ap-detail rp-detail" style={{ ["--c" as string]: color }}>
      <div className="ap-head">
        <button className="ap-link" onClick={onClose} aria-label="Close resource details">
          ← back
        </button>
      </div>
      <h3>
        <span className="rp-icon">{ICON[isDb && sel.type === "server" ? "database" : kind] ?? "◆"}</span> {title} <small>{sub}</small>
      </h3>
      {!a ? (
        <p className="hs-empty">No calls seen yet in this session.</p>
      ) : (
        <>
          <dl className="ap-stats">
            <div>
              <dt>calls</dt>
              <dd>{kfmt(a.calls)}</dd>
            </div>
            <div>
              <dt>errors</dt>
              <dd style={a.errors ? { color: ERR } : undefined}>{a.errors}</dd>
            </div>
            <div>
              <dt>p50</dt>
              <dd>{ms(pct(a.lat, 0.5))}</dd>
            </div>
            <div>
              <dt>p95</dt>
              <dd>{ms(pct(a.lat, 0.95))}</dd>
            </div>
            <div>
              <dt>rate</dt>
              <dd>{kfmt(ratePerS(a, now))}/s</dd>
            </div>
            <div>
              <dt>last</dt>
              <dd>{ago(a.last, now)}</dd>
            </div>
          </dl>
          <section>
            <h4>Traffic · last minute</h4>
            <Spark a={a} now={now} color={color} />
          </section>
          <KindSection sel={sel} a={a} kind={kind} />
          {sel.type !== "link" && callers.length > 0 && (
            <section>
              <h4>Top callers</h4>
              {callers.map(([id, n]) => (
                <button key={id} className="ap-chip-link" style={{ ["--c" as string]: "#c7d2fe" }} onClick={() => selectResource({ type: "link", id, server: sel.server })} title="details of this link">
                  {nameOf(id)} <em>{kfmt(n)}</em>
                </button>
              ))}
            </section>
          )}
          {sel.type === "link" && (
            <section>
              <button className="ap-chip-link" style={{ ["--c" as string]: "#c7d2fe" }} onClick={() => selectInstance(sel.id)}>
                ↑ {nameOf(sel.id)}
              </button>
              <button className="ap-chip-link" style={{ ["--c" as string]: color }} onClick={() => selectResource({ type: "server", server: sel.server })}>
                → {serverLabel(sel.server)}
              </button>
            </section>
          )}
          {a.recent.length > 0 && (
            <section>
              <h4>Recent calls</h4>
              <ul className="ap-decisions">
                {[...a.recent].reverse().map((r, k) => (
                  <li key={k} className={r.ok ? undefined : "is-deny"} style={{ ["--c" as string]: r.ok ? OK : ERR }}>
                    <b>{r.status ?? (r.ok ? "ok" : "error")}</b>
                    <span>
                      {sel.type === "link" ? "" : `${nameOf(r.who)} · `}
                      {r.tool}
                      {r.resource && sel.type !== "backend" ? ` · ${r.resource}` : ""}
                    </span>
                    <em>
                      {ms(r.ms)} · {ago(r.at, now)}
                    </em>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="rp-note">arguments, results and statements stay scrubbed (privacy)</p>
        </>
      )}
    </div>
  );
}

/** Service agents: the same layout's service section (replicas, routes, status mix, backends used). */
export function ServiceDetail({ i }: { i: Instance }) {
  if (!i.id.startsWith("svc:")) return null;
  const routes = [...(i.svcRoutes ?? new Map<string, number>())].sort((x, y) => y[1] - x[1]).slice(0, 10);
  const codes = [...(i.svcCodes ?? new Map<string, number>())].sort();
  const links = [...resInfo.links].filter(([k]) => k.startsWith(`${i.id}|`)).sort((x, y) => y[1].calls - x[1].calls).slice(0, 10);
  const hv = i.hv;
  return (
    <section className="rp-service">
      <h4>Service</h4>
      <dl className="rp-kv">
        <div>
          <dt>replicas</dt>
          <dd>{hv?.instances ?? 1}</dd>
        </div>
        <div>
          <dt>handled</dt>
          <dd>{kfmt(i.svcN ?? 0)}</dd>
        </div>
        <div>
          <dt>errors</dt>
          <dd style={i.svcErr ? { color: ERR } : undefined}>{i.svcErr ?? 0}</dd>
        </div>
        {hv && (
          <div>
            <dt>p50 / p95</dt>
            <dd>
              {ms(hv.p50)} / {ms(hv.p95)}
            </dd>
          </div>
        )}
      </dl>
      {codes.length > 0 && <Mix items={codes} colors={{ "2xx": OK, "3xx": "#60a5fa", "4xx": AMBER, "5xx": ERR, rejected: AMBER }} />}
      {routes.length > 0 && (
        <table className="rp-table">
          <thead>
            <tr>
              <th>route</th>
              <th>requests</th>
            </tr>
          </thead>
          <tbody>
            {routes.map(([r, n]) => (
              <tr key={r}>
                <td title={r}>{r}</td>
                <td>{kfmt(n)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {links.length > 0 && (
        <>
          <h4>Backends used</h4>
          {links.map(([k, a]) => {
            const server = k.slice(i.id.length + 1);
            return (
              <button key={k} className="ap-chip-link" style={{ ["--c" as string]: world.mcpServers.get(server)?.color ?? "#94a3b8" }} onClick={() => selectResource({ type: "link", id: i.id, server })}>
                {[...a.resources.keys()].slice(0, 3).join(", ") || serverLabel(server)} <em>{kfmt(a.calls)}</em>
              </button>
            );
          })}
        </>
      )}
    </section>
  );
}

export type { ResourceKind };
