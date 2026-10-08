"""Backend services (docs/SPEC.md "Backend services"): ordinary backend OTel spans mapped onto the agent world.

The Mapper calls this module; nothing here runs for a span that is not a backend span, so agent-only traces map
exactly as before (a service only appears once it has backend spans).

| backend | world |
|---|---|
| a service (OTel resource `service.name`, or `agentglow.service`) | one long-lived agent per service in the run `services` (`services:<scope>` when scoped), spawned on its first request, persistent across requests |
| a request: SERVER span with HTTP/RPC attributes, or a handled message: CONSUMER span with `messaging.system` (not a `create` span) | a `request` event (pulse) on the service agent; aggregated per service into `service_stats` once per tick (`42 req/s · 2% 5xx · p50 18ms`) |
| a request still open after JOB_MS (a long-running handler) | a "job" subagent of the service named after the route / topic (at most MAX_JOBS live per service), owning the calls inside it until it ends (`exit` done / failed, then the usual `request`); `service_stats.inflight` = requests open 1 s or more |
| PRODUCER span (`messaging.destination.name`) -> CONSUMER span of another service (OTel parent or link) | `message` comet producer service -> consumer service, text = the topic / stream |
| an agent span (`agentglow.agent(...)`, GenAI invoke_agent, ...) inside a request | a short-lived subagent of the service (at most MAX_TASKS live per service; more run as the service itself) |
| CLIENT span with `db.system` inside a request | `mcp` call/result on a synthetic database server `db:<system>` (`mcp_register` `kind: "database"`, drawn as a database node), resource = the collection / table / index, else the database name, else the system |
| CLIENT span with HTTP / RPC inside a request | `mcp` call/result on a synthetic external API node `api:<host>` (`mcp_register` `kind: "api"`), resource = the host (`payments:9100`) |
| CLIENT span inside an MCP tool span (`agentglow.mcp.server`) that names no resource | the same, as a backend of THAT MCP server (auto-discovered; a manual `agentglow.mcp.resource` wins) |
| error: span status ERROR, HTTP status >= 500 | `request` with `error: true` (always sent individually within the cap) and counted in `service_stats.errors` |
| PRODUCER span ending with status ERROR (a publish that raised) | `message` with `failed: true` (a comet that fizzles) to the topic's last known consumer, else back to the producer |
| replicas: spans of one service from several processes (`instance` = resource `service.instance.id`) | one service agent; `service_stats.instances` = distinct instances seen in the last INSTANCE_MS (only when > 1) |
| GenAI spans inside a request | the usual `llm` / `tool` / ... events, owned by the service agent (or its subagent) |

Flat events (POST /v1/events, `agentglow.pulse()`) go through `flat()` and produce the same world events.
"""
from __future__ import annotations

import os
import re
from collections import deque
from dataclasses import dataclass, field
from typing import TYPE_CHECKING
from urllib.parse import urlparse

from .scrub import decision_text, redact, scrub_attrs

if TYPE_CHECKING:
    from .mapper import Mapper, Span

RUN = "services"
GROUP = "backend"  # synthetic MCP-style server holding the external HTTP / RPC hosts the services call
API_PREFIX = "api:"  # synthetic external API node per HTTP / RPC host (`api:payments:9100`), `mcp_register` kind "api"
DB_PREFIX = "db:"  # synthetic database server per `db.system` (`db:elasticsearch`), `mcp_register` kind "database"
STORAGE_PREFIX = "storage:"  # synthetic object-storage node per blob store (`storage:minio`), `mcp_register` kind "storage"
HV_RATE = float(os.environ.get("AGENTGLOW_SERVICE_HV_RATE", "5"))  # per service, requests/s sent individually
CAP = int(os.environ.get("AGENTGLOW_SERVICE_CAP", "20"))  # individual request events/s, all services
ERRORS_PER_WINDOW = 3  # busy service: individual error events per tick
CALM_WINDOWS = 3
MAX_ROUTES = 6
MAX_TASKS = int(os.environ.get("AGENTGLOW_SERVICE_MAX_TASKS", "6"))  # live task subagents per service
COMET_MIN_MS = 250  # per (from, to, topic) edge
CALL_MIN_MS = 250  # per (agent, server, resource)
LINK_MS = 10_000  # a consumer waits this long for its producer span (other process, other batch)
PRUNE_MS = 30_000  # ended spans of a service run are forgotten after this long
JOB_MS = int(os.environ.get("AGENTGLOW_JOB_MS", "3000"))  # a request open this long becomes a job node
LONG_PREFIX = "req:"  # long-request job node ids `req:<span id>` (business-id jobs of primitives.py are `job:<id>`)
MAX_JOBS = int(os.environ.get("AGENTGLOW_SERVICE_MAX_JOBS", "8"))  # live job nodes per service (more are only counted)
INFLIGHT_MS = 1000  # `inflight` counts requests open at least this long (not every request that spans a tick)
JOB_STALE_MS = int(os.environ.get("AGENTGLOW_JOB_STALE_MS", str(3600 * 1000)))  # an open request never ended: forgotten
FORGET_MS = int(os.environ.get("AGENTGLOW_SERVICE_IDLE_MS", str(3600 * 1000)))  # idle service -> exit + forget
LABEL_BAD_RE = re.compile(r"[^A-Za-z0-9:_./@-]+")
DB_KIND = {"snowflake": "warehouse", "bigquery": "warehouse", "redshift": "warehouse", "clickhouse": "warehouse",
           "spark": "spark", "s3": "storage", "gcs": "storage", "minio": "storage"}
SKIP_ENTRY = ("hatchet.", "gen_ai.", "openinference.", "agentglow.mcp.", "llm.")
# a consumer's idle blocking reads (FastStream polls a Redis stream every 100 ms): not traffic, dropped at the root
INSTANCE_MS = int(os.environ.get("AGENTGLOW_SERVICE_INSTANCE_MS", "60000"))  # a replica counts while seen this recently
POLL_OPS = {"XREAD", "XREADGROUP", "BLPOP", "BRPOP", "BLMOVE", "BRPOPLPUSH", "BZPOPMIN", "BZPOPMAX", "BLMPOP", "BZMPOP"}


def label(v: object, n: int = 48) -> str:
    """Service / resource name -> safe label: secrets redacted, disallowed runs become `-`, max n chars."""
    if v is None or isinstance(v, bool) or not isinstance(v, (str, int, float)):
        return ""
    return LABEL_BAD_RE.sub("-", redact(str(v).strip())).strip("-")[:n]


def _int(v: object) -> int | None:
    try:
        return int(v) if v is not None and not isinstance(v, bool) and str(v).strip() else None
    except (TypeError, ValueError):
        return None


def _pct(xs: list, q: float) -> int:
    if not xs:
        return 0
    s = sorted(xs)
    return int(round(s[min(len(s) - 1, int(q * (len(s) - 1) + 0.5))]))


def http_code(a: dict) -> int | None:
    return _int(a.get("http.response.status_code") or a.get("http.status_code") or a.get("agentglow.service.status"))


def topic_of(name: str, a: dict) -> str:
    t = a.get("messaging.destination.name") or a.get("messaging.destination_publish.name") or a.get("messaging.destination")
    if not t:  # FastStream / semconv span names: "<destination> <operation>"
        t = re.sub(r"\s+(process|receive|deliver|publish|send|create|settle)$", "", name)
    return decision_text(t, 60)


def entry_kind(d: dict) -> str | None:
    """'http' | 'rpc' | 'message' | 'event' if this span is a service's request / handled message, else None."""
    a = d.get("attributes") or {}
    if a.get("agentglow.service.event"):
        return "event"
    if a.get("agentglow.agent") or any(k.startswith(SKIP_ENTRY) for k in a):
        return None  # agents, LLM/tool spans, Hatchet steps and MCP spans keep their own meaning
    kind = d.get("kind")
    if kind == "server" and (a.get("network.protocol.name") == "websocket" or a.get("url.scheme") in ("ws", "wss")):
        return "ws"  # a WebSocket connection: its session node shows it (primitives.py), never a request
    if kind == "server":
        if a.get("http.request.method") or a.get("http.method") or a.get("http.route"):
            return "http"
        if a.get("rpc.system"):
            return "rpc"
    if kind in ("consumer", "server") and a.get("messaging.system"):
        op = str(a.get("messaging.operation.type") or a.get("messaging.operation") or "")
        if op == "create" or str(d.get("name") or "").endswith(" create"):
            return None  # FastStream's synthetic "create" span (no trace headers on the message)
        return "message"
    return None


def request_name(kind: str, name: str, a: dict) -> str:
    if kind == "http":  # route template only (never the URL: ids / query strings)
        method = a.get("http.request.method") or a.get("http.method") or ""
        route = a.get("http.route")
        return decision_text(f"{method} {route}".strip() if route else name, 60)
    if kind == "message":
        return topic_of(name, a)
    return decision_text(name, 60)


def resource_of(a: dict, kind: str | None) -> tuple[str, str] | None:
    """(resource name, resource kind) of a CLIENT span: a database / cache / external HTTP host, else None."""
    if kind not in ("client", None, ""):
        return None
    system = a.get("db.system") or a.get("db.system.name")
    if system:
        system = label(system, 32)
        db = a.get("db.name") or a.get("db.namespace")
        name = system if not db or str(db).isdigit() or system == "redis" else f"{system}:{label(db, 24)}"
        return name, DB_KIND.get(system, "db")
    if kind != "client":
        return None
    if a.get("http.request.method") or a.get("http.method") or a.get("url.full") or a.get("http.url"):
        host = a.get("server.address") or a.get("net.peer.name")
        port = a.get("server.port") or a.get("net.peer.port")
        if not host:
            u = urlparse(str(a.get("url.full") or a.get("http.url") or ""))
            host, port = u.hostname, port or u.port
        if not host:
            return None
        port = _int(port)
        name = label(f"{host}:{port}" if port and port not in (80, 443) else host, 48)
        return (name, "api") if name else None
    if a.get("rpc.system"):
        name = label(a.get("rpc.service") or a.get("server.address") or a.get("rpc.system"), 48)
        return (name, "api") if name else None
    return None


def db_target(a: dict) -> tuple[str, str, str] | None:
    """(server, resource, resource kind) of a CLIENT span with `db.system`: one database node per system, its collections /
    tables / indices as resources (else the database name, else the system itself), or None for a non-DB span."""
    system = a.get("db.system") or a.get("db.system.name")
    if not system:
        return None
    system = label(system, 32)
    if not system:
        return None
    coll = a.get("db.collection.name") or a.get("db.sql.table") or a.get("db.mongodb.collection")
    db = a.get("db.namespace") or a.get("db.name")
    if coll:
        res = label(coll, 32)
    elif db and not str(db).isdigit() and system != "redis":
        res = label(db, 32)
    else:
        res = system
    return DB_PREFIX + system, res or system, DB_KIND.get(system, "db")


def _register(server: str, name: str, kind: str, ts: int) -> dict:
    ev = {"type": "mcp_register", "server": server, "resources": [{"name": name, "kind": kind}], "ts": ts}
    if server.startswith(DB_PREFIX):
        ev["kind"] = "database"
    elif server.startswith(API_PREFIX):
        ev["kind"] = "api"
    elif server.startswith(STORAGE_PREFIX):
        ev["kind"] = "storage"
    return ev


@dataclass
class _Win:
    n: int = 0
    errors: int = 0
    codes: dict = field(default_factory=dict)
    ms: list = field(default_factory=list)
    routes: dict = field(default_factory=dict)
    aggregated: int = 0


@dataclass
class Svc:
    id: str
    name: str
    run: str
    spawn: dict  # the spawn event (re-sent to a new viewer once it left the replay buffer)
    status: dict | None = None  # its `agent thinking` event (same)
    last_ts: int = 0
    recent: deque = field(default_factory=deque)  # request ts of the trailing 1 s
    hi: int = 0  # latest request ts
    busy: bool = False
    calm_streak: int = 0
    win: _Win = field(default_factory=_Win)
    tasks: set = field(default_factory=set)  # live task subagent ids
    open: dict = field(default_factory=dict)  # span id -> open request Span (in flight)
    jobs: dict = field(default_factory=dict)  # job agent id -> [spawn event, status event] (live job nodes)
    inflight: int = 0  # in-flight count sent in the last service_stats
    instances: dict = field(default_factory=dict)  # replica (service.instance.id) -> last seen ts


class Services:
    def __init__(self, mapper: "Mapper") -> None:
        self.m = mapper
        self.svcs: dict[str, Svc] = {}  # agent id -> service
        self.run_started: dict[str, dict] = {}  # run id -> its `run started` event
        self.producers: dict[str, tuple] = {}  # producer span id -> (service agent id, topic, ts)
        self.waiting: dict[str, tuple] = {}  # producer span id -> (consumer agent id, topic, ts): consumer came first
        self.edge_at: dict[tuple, int] = {}
        self.consumer_of: dict[str, str] = {}  # topic -> last consumer service agent id (target of a failed publish)
        self.call_at: dict[tuple, int] = {}
        self.known: set[tuple] = set()  # (server, resource) registered
        self.ended: deque = deque()  # (end ts, span id) of service-run spans, pruned after PRUNE_MS
        self.deferred: dict[str, None] = {}  # root CLIENT span ids whose start had no attributes yet
        self.bucket, self.bucket_used, self.passed = -1, 0, 0
        self.cands: list[dict] = []
        self.last_flush: int | None = None
        self.drives: dict[tuple, dict | None] = {}  # (service agent id, agent run id) -> its `drives` event once sent

    # ------------------------------------------------------------------ services
    @staticmethod
    def run_id(scope: object) -> str:
        return f"{RUN}:{scope}" if scope else RUN

    def ensure(self, name: str, scope: object, ts: int, out: list, instance: object = None) -> str:
        """The service's agent id (spawned, with its run, on first sight)."""
        from .mapper import Agent, Run

        rid = self.run_id(scope)
        if rid not in self.m.runs:
            run = self.m.runs[rid] = Run(rid, service=True)
            run.last_ts = ts
            if scope and rid not in self.m.scopes:
                self.m.scopes[rid] = str(scope)
                self.m.newly_scoped.append(rid)
            ev = {"type": "run", "run_id": rid, "status": "started", "topic": "services", "workflow": "services", "ts": ts}
            self.run_started[rid] = ev
            out.append(ev)
        aid = f"svc:{scope}:{name}" if scope else f"svc:{name}"
        sv = self.svcs.get(aid)
        if sv is None:
            ev = {"type": "spawn", "run_id": rid, "id": aid, "agent": name, "parent_id": None, "subagent": False, "ts": ts}
            sv = self.svcs[aid] = Svc(aid, name, rid, ev)
            self.m.agents[aid] = Agent(name, rid)
            out.append(ev)
            n = len(out)
            self.m._thinking(aid, rid, out, ts)  # a service is working while it is up (not "spawning")
            sv.status = out[-1] if len(out) > n else None
        sv.last_ts = max(sv.last_ts, ts)
        if instance:
            sv.instances[str(instance)[:80]] = max(ts, sv.instances.get(str(instance)[:80], 0))
            if len(sv.instances) > 256:
                sv.instances.pop(min(sv.instances, key=sv.instances.get))
        self.m.runs[rid].last_ts = max(self.m.runs[rid].last_ts, ts)
        return aid

    def service_name(self, d: dict) -> str:
        a = d.get("attributes") or {}
        return label(a.get("agentglow.service") or d.get("service") or a.get("service.name") or "service") or "service"

    def snapshot(self) -> list[dict]:
        """`run started` + `spawn` + status of every live service (a new viewer gets them after they left the buffer)."""
        live = {sv.run for sv in self.svcs.values()}
        return [ev for rid, ev in self.run_started.items() if rid in live] + [e for sv in self.svcs.values() for e in (sv.spawn, sv.status) if e] + \
            [e for sv in self.svcs.values() for j in sv.jobs.values() for e in j if e] + \
            [e for (aid, rid), e in self.drives.items() if e and aid in self.svcs and rid in self.m.runs]

    def note_run(self, d: dict, run_id: str, scope: object) -> None:
        """A span of an agent run from a process whose service is (or may become) a service node: that service drives the
        run (a `drives` edge service -> the run's agents; sent at the tick once both exist)."""
        if not d.get("service") and not (d.get("attributes") or {}).get("agentglow.service"):
            return
        name = self.service_name(d)
        key = (f"svc:{scope}:{name}" if scope else f"svc:{name}", run_id)
        if key not in self.drives:
            self.drives[key] = None
            self._bound(self.drives, 4096)

    # ------------------------------------------------------------------ spans
    def start_entry(self, s: "Span", kind: str, d: dict, out: list) -> None:
        a = s.attrs
        aid = self.ensure(self.service_name(d), a.get("agentglow.scope") or a.get("agentglow.run.scope"), s.start, out, d.get("instance"))
        s.alias = s.svc = aid
        s.entry = kind
        if s.end is None and kind != "ws":  # a WebSocket is a session (primitives.py), never a long-request job
            self.svcs[aid].open[s.id] = s
        if kind == "message":
            topic = topic_of(s.name, a)
            ids = [s.parent] + [str(lk.get("span_id")) for lk in d.get("links") or [] if isinstance(lk, dict)]
            for pid in [i for i in ids if i]:
                p = self.producers.get(pid)
                if p:
                    self._comet(p[0], aid, p[1] or topic, s.start, out)
                    break
            else:
                if s.parent:
                    self.waiting[s.parent] = (aid, topic, s.start)
                    self._bound(self.waiting)

    @staticmethod
    def root_client(d: dict) -> bool:
        """A CLIENT span with no parent naming a DB / cache / HTTP host (and not an LLM call)."""
        a = d.get("attributes") or {}
        return not any(k.startswith(SKIP_ENTRY) for k in a) and resource_of(a, "client") is not None

    def defer_root(self, d: dict) -> bool:
        """A root CLIENT span starting with no attributes yet (live start): wait for its end to classify it."""
        a = d.get("attributes") or {}
        if d.get("end_time_ms") is not None or any(k.startswith(SKIP_ENTRY + ("agentglow.",)) for k in a if k != "agentglow.scope"):
            return False
        self.deferred[d["span_id"]] = None
        self._bound(self.deferred)
        return True

    def undefer(self, sid: str) -> bool:
        return self.deferred.pop(sid, 0) is None

    def start_root_client(self, s: "Span", d: dict, out: list) -> None:
        a = s.attrs
        op = str(a.get("db.operation.name") or a.get("db.operation") or s.name).split(" ")[0].upper()
        if op in POLL_OPS:
            return
        s.alias = s.svc = self.ensure(self.service_name(d), a.get("agentglow.scope") or a.get("agentglow.run.scope"), s.start, out,
                                      d.get("instance"))
        self.child_start(s, out)

    def end_entry(self, s: "Span", out: list) -> None:
        if s.entry == "ws":
            return
        a, ts = s.attrs, s.end or s.start
        code = http_code(a)
        rejected = bool(a.get("agentglow.rejected"))  # agentglow.rejected(): backpressure, not an error (primitives.py)
        error = not rejected and (s.status == "error" or (code is not None and code >= 500))
        sv = self.svcs.get(s.svc or "")
        if sv is not None:
            sv.open.pop(s.id, None)
        if s.alias and s.alias.startswith(LONG_PREFIX):
            self._end_job(s.alias, sv, "failed" if error else "done", ts, out)
            s.alias = s.svc
        ev = {"type": "request", "run_id": s.run, "id": s.svc, "service": self.svcs[s.svc].name if s.svc in self.svcs else "",
              "name": request_name(s.entry, s.name, a), "kind": s.entry}
        if code is not None:
            ev["status"] = code
        if rejected:
            ev["rejected"] = True
        ev.update(error=error, ms=max(0, ts - s.start), ts=ts)
        out += self.offer(ev)

    def child_start(self, s: "Span", out: list) -> None:
        """A span inside a request (s.svc) or inside an MCP tool span (s.mcp_host): producer / backend client call."""
        a = s.attrs
        if s.svc and s.kind == "producer" and a.get("messaging.system"):
            topic = topic_of(s.name, a)
            if s.end is not None and (s.status == "error" or a.get("agentglow.message.failed")):
                self._fizzle(s.svc, topic, s.end, out)  # the publish raised: the message never left
                return
            self.producers[s.id] = (s.svc, topic, s.start)
            self._bound(self.producers)
            w = self.waiting.pop(s.id, None)
            if w:
                self._comet(s.svc, w[0], topic or w[1], s.start, out)
            return
        if s.llm or s.tool or s.agent or self._under_llm(s):
            return  # an LLM SDK's own HTTP call is the `llm` event already
        res = resource_of(a, s.kind)
        if not res:
            return
        host = self.m.spans.get(s.mcp_host or "")
        if host is not None and host.mcp:  # auto-discovered backend of that MCP server
            server, tool = host.mcp[0], host.mcp[1]
        elif s.svc:
            tool = decision_text(a.get("db.operation.name") or a.get("db.operation") or a.get("http.request.method")
                                 or a.get("http.method") or s.name, 40)
            db = db_target(a)
            if db:  # a database node of its own (not the synthetic `backend` group)
                server, res = db[0], (db[1], db[2])
            else:  # an external API node per host
                server = API_PREFIX + res[0]
        else:
            return
        owner = self.m._owner(s, out)
        key = (owner, server, res[0])
        if s.start - self.call_at.get(key, -CALL_MIN_MS) < CALL_MIN_MS:
            s.backend = ()  # rate-limited: still a backend span (no graph event), no visual
            return
        self.call_at[key] = s.start
        self._bound(self.call_at, 4096)
        if (server, res[0]) not in self.known:
            self.known.add((server, res[0]))
            out.append(_register(server, res[0], res[1], s.start))
        s.backend = (owner, server, tool, res[0], res[1])
        out.append({"type": "mcp", "run_id": s.run, "id": owner, "server": server, "tool": tool, "phase": "call", "ts": s.start,
                    "resource": res[0], "resource_kind": res[1]})

    def child_end(self, s: "Span", out: list) -> None:
        if s.backend:
            owner, server, tool, res, kind = s.backend
            ev = {"type": "mcp", "run_id": s.run, "id": owner, "server": server, "tool": tool, "phase": "result",
                  "latency_ms": max(0, (s.end or s.start) - s.start), "ts": s.end or s.start, "resource": res, "resource_kind": kind}
            code = http_code(s.attrs)
            if code is not None:
                ev["status"] = code  # HTTP client calls: the status code only (never the URL)
            if s.status == "error" or (code is not None and code >= 500):
                ev["error"] = True
            out.append(ev)

    def admit_task(self, svc_id: str, agent_id: str) -> bool:
        """An agent spawning inside a request of `svc_id`: a subagent while the service has < MAX_TASKS live ones."""
        sv = self.svcs.get(svc_id)
        if sv is None:
            return True
        sv.tasks = {t for t in sv.tasks if t in self.m.agents and not self.m.agents[t].done}
        if len(sv.tasks) >= MAX_TASKS:
            return False
        sv.tasks.add(agent_id)
        return True

    def _promote(self, sv: Svc, s: "Span", now: int, out: list) -> None:
        """A request open for JOB_MS: a job subagent of its service, owning the calls inside it from now on."""
        from .mapper import Agent

        jid = f"{LONG_PREFIX}{s.id}"
        ev = {"type": "spawn", "run_id": sv.run, "id": jid, "agent": request_name(s.entry or "", s.name, s.attrs) or "job",
              "parent_id": sv.id, "subagent": True, "job": True, "since": s.start, "ts": now}
        self.m.agents[jid] = Agent(ev["agent"], sv.run)
        out.append(ev)
        n = len(out)
        self.m._thinking(jid, sv.run, out, now)
        sv.jobs[jid] = [ev, out[-1] if len(out) > n else None]
        s.alias = jid

    def _end_job(self, jid: str, sv: Svc | None, status: str, ts: int, out: list) -> None:
        run = sv.run if sv is not None else RUN
        out.append({"type": "exit", "run_id": run, "id": jid, "status": status, "ts": ts})
        if sv is not None:
            sv.jobs.pop(jid, None)
        self.m.agents.pop(jid, None)

    def span_ended(self, s: "Span") -> None:
        self.ended.append((s.end or s.start, s.id))

    def _under_llm(self, s: "Span") -> bool:
        cur, hops = self.m.spans.get(s.parent or ""), 0
        while cur is not None and hops < 50 and not cur.entry:
            if cur.llm:
                return True
            cur, hops = self.m.spans.get(cur.parent or ""), hops + 1
        return False

    def _fizzle(self, frm: str, topic: str, ts: int, out: list) -> None:
        to = self.consumer_of.get(topic)
        to = to if to in self.svcs else frm
        key = (frm, to, topic, "failed")
        if ts - self.edge_at.get(key, -COMET_MIN_MS) < COMET_MIN_MS:
            return
        self.edge_at[key] = ts
        self._bound(self.edge_at, 4096)
        run = self.svcs[frm].run if frm in self.svcs else RUN
        out.append({"type": "message", "run_id": run, "from_id": frm, "to_id": to, "text": topic or "message", "failed": True, "ts": ts})

    def _comet(self, frm: str, to: str, topic: str, ts: int, out: list) -> None:
        if frm == to:
            return
        if topic:
            self.consumer_of[topic] = to
            self._bound(self.consumer_of, 4096)
        key = (frm, to, topic)
        if ts - self.edge_at.get(key, -COMET_MIN_MS) < COMET_MIN_MS:
            return
        self.edge_at[key] = ts
        self._bound(self.edge_at, 4096)
        run = self.svcs[to].run if to in self.svcs else RUN
        out.append({"type": "message", "run_id": run, "from_id": frm, "to_id": to, "text": topic or "message", "ts": ts})

    @staticmethod
    def _bound(d: dict, n: int = 20_000) -> None:
        while len(d) > n:
            d.pop(next(iter(d)))

    # ------------------------------------------------------------------ rate (hv.py ideas, for requests)
    def offer(self, ev: dict) -> list[dict]:
        """Count a request; return it if it goes out individually now (calm service within the global budget)."""
        sv, ts = self.svcs.get(ev["id"]), int(ev["ts"])
        if sv is None:
            return [ev]
        sv.recent.append(ts)
        sv.hi = max(sv.hi, ts)
        while sv.recent and sv.recent[0] <= sv.hi - 1000:
            sv.recent.popleft()
        if len(sv.recent) > HV_RATE:
            sv.busy, sv.calm_streak = True, 0
        w = sv.win
        w.n += 1
        w.errors += ev["error"]
        if ev.get("rejected"):
            w.codes["rejected"] = w.codes.get("rejected", 0) + 1
        elif "status" in ev:
            c = f"{ev['status'] // 100}xx"
            w.codes[c] = w.codes.get(c, 0) + 1
        w.ms.append(ev["ms"])
        w.routes[ev["name"]] = w.routes.get(ev["name"], 0) + 1
        if not sv.busy:
            b = ts // 1000
            if b != self.bucket:
                self.bucket, self.bucket_used = b, 0
            if self.bucket_used < CAP:
                self.bucket_used += 1
                self.passed += 1
                return [ev]
        w.aggregated += 1
        if ev["error"]:
            self.cands.append({**ev, "hv": True})
            del self.cands[:-400]
        return []

    def tick(self, now: int) -> list[dict]:
        out: list[dict] = []
        if not self.svcs and not self.ended:
            return out
        window = 1000 if self.last_flush is None else max(1, min(10_000, now - self.last_flush))
        self.last_flush = now
        for aid, sv in list(self.svcs.items()):
            for s in list(sv.open.values()):
                if now - s.start > JOB_STALE_MS:  # its end never came (process gone): forget it
                    del sv.open[s.id]
                    if s.alias and s.alias.startswith(LONG_PREFIX):
                        self._end_job(s.alias, sv, "done", now, out)
                elif now - s.start >= JOB_MS and s.alias == aid and not s.covered and len(sv.jobs) < MAX_JOBS:
                    self._promote(sv, s, now, out)
            w = sv.win
            inflight = sum(1 for s in sv.open.values() if now - s.start >= INFLIGHT_MS)
            if w.n or inflight or sv.inflight:
                top = sorted(w.routes.items(), key=lambda kv: -kv[1])
                routes = dict(top[:MAX_ROUTES])
                rest = sum(c for _, c in top[MAX_ROUTES:])
                if rest:
                    routes["other"] = routes.get("other", 0) + rest
                out.append({"type": "service_stats", "run_id": sv.run, "id": aid, "service": sv.name, "window_ms": window,
                            "n": w.n, "errors": w.errors, "codes": dict(sorted(w.codes.items())), "p50_ms": _pct(w.ms, 0.5),
                            "p95_ms": _pct(w.ms, 0.95), "routes": routes, "ts": now})
                if inflight or sv.inflight:  # open requests (long handlers); sent until it drops back to 0
                    out[-1]["inflight"] = inflight
                sv.inflight = inflight
                for k in [k for k, t in sv.instances.items() if now - t > INSTANCE_MS]:
                    del sv.instances[k]
                if len(sv.instances) > 1:
                    out[-1]["instances"] = len(sv.instances)
            if sv.busy:
                sv.calm_streak = sv.calm_streak + 1 if w.n * 1000 / window <= HV_RATE else 0
                if sv.calm_streak >= CALM_WINDOWS:
                    sv.busy, sv.calm_streak = False, 0
            sv.win = _Win()
            if now - sv.last_ts > FORGET_MS and not sv.open:  # idle for long: the service leaves (it comes back on its next request)
                out.append({"type": "exit", "run_id": sv.run, "id": aid, "status": "done", "ts": now})
                del self.svcs[aid]
                self.m.agents.pop(aid, None)
        for key in list(self.drives):
            aid, rid = key
            run = self.m.runs.get(rid)
            if run is None or run.service:
                del self.drives[key]  # the run completed: its edge goes with it
            elif self.drives[key] is None and aid in self.svcs:
                self.drives[key] = {"type": "drives", "run_id": self.svcs[aid].run, "id": aid, "target_run": rid, "ts": now}
                out.append(self.drives[key])
        budget = max(0, round(CAP * window / 1000) - self.passed)
        self.passed = 0
        per: dict[str, int] = {}
        for ev in self.cands:
            if budget <= 0:
                break
            if per.get(ev["id"], 0) < ERRORS_PER_WINDOW:
                per[ev["id"]] = per.get(ev["id"], 0) + 1
                budget -= 1
                out.append(ev)
        self.cands = []
        for k in [k for k, v in self.waiting.items() if now - v[2] > LINK_MS]:
            del self.waiting[k]
        while self.ended and now - self.ended[0][0] > PRUNE_MS:  # forget ended spans of long-lived service runs
            _, sid = self.ended.popleft()
            s = self.m.spans.pop(sid, None)
            if s is not None and s.agent:
                self.m.agents.pop(sid, None)
        return out

    # ------------------------------------------------------------------ flat events (POST /v1/events, pulse())
    def flat(self, raw: dict, now: int, scope: str | None = None) -> list[dict]:
        """One flat event -> world events. Unknown `event` values count as a request named after them."""
        out: list[dict] = []
        if not isinstance(raw, dict):
            return out
        e = scrub_attrs(raw)  # same privacy scrub as spans: identity keys dropped, secrets redacted
        name = label(e.get("service") or e.get("agent"))
        if not name:
            return out
        scope = e.get("scope") or scope
        kind = str(e.get("event") or "request").lower()
        aid = self.ensure(name, scope, now, out, e.get("instance"))
        rid = self.run_id(scope)
        if kind in self.m.prims.FLAT:  # generic primitives (primitives.py)
            return out + self.m.prims.flat(e, kind, aid, rid, scope, now)
        ms = max(0, _int(e.get("duration_ms")) or 0)
        title = decision_text(e.get("name") or kind, 60)
        if kind == "message":
            to = label(e.get("to"))
            topic = decision_text(e.get("topic") or e.get("name") or "message", 60)
            if e.get("failed") is True or str(e.get("status")).lower() in ("failed", "error"):
                if to:
                    self.consumer_of.setdefault(topic, self.ensure(to, scope, now, out))
                self._fizzle(aid, topic, now, out)
                return out
            if to:
                tid = self.ensure(to, scope, now, out)
                self._comet(aid, tid, topic, now, out)
                out += self.offer({"type": "request", "run_id": rid, "id": tid, "service": to, "name": topic, "kind": "message",
                                   "error": False, "ms": ms, "ts": now})
            return out
        if kind == "call":
            res = label(e.get("to") or e.get("name"))
            if res:
                rk = str(e.get("kind") or "api")
                rk = rk if rk in ("db", "warehouse", "spark", "api", "storage", "queue") else "api"
                server = API_PREFIX + res if rk == "api" else STORAGE_PREFIX + res if rk == "storage" else GROUP
                if rk in ("db", "warehouse"):  # a database node `db:<to>`, resource = `collection` when given
                    server, res = DB_PREFIX + res, label(e.get("collection"), 32) or res
                if (server, res) not in self.known:
                    self.known.add((server, res))
                    out.append(_register(server, res, rk, now))
                base = {"type": "mcp", "run_id": rid, "id": aid, "server": server, "tool": title, "resource": res, "resource_kind": rk}
                done = {**base, "phase": "result", "latency_ms": ms, "ts": now}
                code = _int(e.get("status"))
                if code is not None:
                    done["status"] = code
                if (code is not None and code >= 500) or str(e.get("status")).lower() in ("error", "failed", "fail"):
                    done["error"] = True
                out += [{**base, "phase": "call", "ts": now - ms}, done]
            return out
        if kind == "llm":
            ev = {"type": "llm", "run_id": rid, "id": aid, "tokens_in": max(0, _int(e.get("tokens_in")) or 0),
                  "tokens_out": max(0, _int(e.get("tokens_out")) or 0), "latency_ms": ms, "ts": now}
            out.append(ev)
            return out
        if kind == "tool":
            out.append({"type": "tool", "run_id": rid, "id": aid, "tool": title, "args_preview": "", "ts": now})
            return out
        status = e.get("status")
        code = _int(status)
        error = kind == "error" or (code is not None and code >= 500) or str(status).lower() in ("error", "failed", "fail")
        ev = {"type": "request", "run_id": rid, "id": aid, "service": name, "name": title, "kind": "event"}
        if code is not None:
            ev["status"] = code
        ev.update(error=error, ms=ms, ts=now)
        out += self.offer(ev)
        return out
