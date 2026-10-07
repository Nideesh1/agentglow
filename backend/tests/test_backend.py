"""Backend services (docs/SPEC.md "Backend services"): synthetic OTel spans for each mapping row, flat events
(POST /v1/events), replay of long-lived services, and watch(app=/broker=/mcp=) + pulse()."""
import itertools

from fastapi.testclient import TestClient

from agentglow import backend
from agentglow.mapper import Mapper
from agentglow.server import create_app, otlp_json_spans
from agentglow.state import Hub

T = 1_790_000_000_000
_ids = itertools.count(1)


def sid() -> str:
    return f"{next(_ids):016x}"


def span(name, *, service="orders-api", kind="internal", parent=None, trace="t" * 32, t0=T, t1=None, status="ok", links=None, **attrs):
    d = {"trace_id": trace, "span_id": sid(), "parent_span_id": parent, "name": name, "start_time_ms": t0,
         "end_time_ms": t1 if t1 is not None else t0 + 10, "status": status, "attributes": attrs, "kind": kind, "service": service}
    if links:
        d["links"] = links
    return d


def run(m: Mapper, *spans) -> list[dict]:
    """Start every span in order, then end them in reverse (children before parents)."""
    out = []
    for s in spans:
        out += m.feed("start", {**s, "end_time_ms": None, "status": "unset"})
    for s in reversed(spans):
        out += m.feed("end", s)
    return out


def http(path="/orders/{order_id}", code=200, **kw):
    return span(f"GET {path}", kind="server", **{"http.method": "GET", "http.route": path, "http.status_code": code}, **kw)


def types(evs, t):
    return [e for e in evs if e["type"] == t]


# ---------------------------------------------------------------------- services + requests
def test_http_request_spawns_long_lived_service_agent():
    m = Mapper()
    evs = run(m, http())
    assert types(evs, "run") == [{"type": "run", "run_id": "services", "status": "started", "topic": "services", "workflow": "services", "ts": T}]
    (sp,) = types(evs, "spawn")
    assert sp["id"] == "svc:orders-api" and sp["agent"] == "orders-api" and sp["parent_id"] is None and not sp["subagent"]
    (rq,) = types(evs, "request")
    assert rq == {"type": "request", "run_id": "services", "id": "svc:orders-api", "service": "orders-api", "name": "GET /orders/{order_id}",
                  "kind": "http", "status": 200, "error": False, "ms": 10, "ts": T + 10}
    # a second request: same agent, no new spawn, the run never completes when its spans close
    evs = run(m, http(t0=T + 50))
    assert not types(evs, "spawn") and not types(evs, "run") and not types(evs, "exit") and len(types(evs, "request")) == 1
    assert m.runs["services"].service


def test_new_semconv_and_scope():
    m = Mapper()
    s = span("POST /orders", kind="server", **{"http.request.method": "POST", "http.route": "/orders", "http.response.status_code": 201,
                                               "agentglow.scope": "team-a"})
    evs = run(m, s)
    assert types(evs, "spawn")[0]["id"] == "svc:team-a:orders-api" and types(evs, "run")[0]["run_id"] == "services:team-a"
    assert m.scopes["services:team-a"] == "team-a"
    assert types(evs, "request")[0]["name"] == "POST /orders" and types(evs, "request")[0]["status"] == 201


def test_errors_flag_and_count():
    m = Mapper()
    evs = run(m, http(code=503)) + run(m, span("orders process", service="worker", kind="consumer", status="error", t0=T + 100,
                                                **{"messaging.system": "redis"}))
    reqs = types(evs, "request")
    assert [(r["id"], r["error"]) for r in reqs] == [("svc:orders-api", True), ("svc:worker", True)]
    stats = {e["id"]: e for e in m.tick(T + 1000) if e["type"] == "service_stats"}
    assert stats["svc:orders-api"]["errors"] == 1 and stats["svc:orders-api"]["codes"] == {"5xx": 1}
    assert stats["svc:worker"]["errors"] == 1 and stats["svc:worker"]["codes"] == {}


def test_high_rate_aggregates_into_service_stats():
    m = Mapper()
    evs = []
    for i in range(50):  # 50 req in one second, every 10th a 500
        evs += run(m, http(code=500 if i % 10 == 0 else 200, t0=T + i * 20, t1=T + i * 20 + 5 + i % 7))
    individual = types(evs, "request")
    assert len(individual) <= backend.HV_RATE + 1  # calm until the rate passes HV_RATE/s, then aggregated
    tick = m.tick(T + 1000)
    (st,) = types(tick, "service_stats")
    assert st["n"] == 50 and st["errors"] == 5 and st["codes"] == {"2xx": 45, "5xx": 5}
    assert st["routes"] == {"GET /orders/{order_id}": 50} and 5 <= st["p50_ms"] <= 11 and st["window_ms"] == 1000
    hv_errors = [e for e in types(tick, "request") if e.get("hv")]
    assert hv_errors and all(e["error"] for e in hv_errors) and len(hv_errors) <= backend.ERRORS_PER_WINDOW


def test_message_comet_producer_to_consumer_both_orders():
    for consumer_first in (False, True):
        m = Mapper()
        req = http(path="/orders")
        create = span("orders create", kind="producer", parent=req["span_id"], **{"messaging.system": "redis", "messaging.destination.name": "orders"})
        publish = span("orders publish", kind="producer", parent=create["span_id"], **{"messaging.system": "redis", "messaging.destination.name": "orders"})
        proc = span("orders process", service="orders-worker", kind="consumer", parent=create["span_id"], trace="u" * 32, t0=T + 5,
                    **{"messaging.system": "redis", "messaging.destination_publish.name": "orders"})
        evs = run(m, proc) + run(m, req, create, publish) if consumer_first else run(m, req, create, publish) + run(m, proc)
        (msg,) = types(evs, "message")
        assert msg["from_id"] == "svc:orders-api" and msg["to_id"] == "svc:orders-worker" and msg["text"] == "orders"
        assert {r["id"] for r in types(evs, "request")} == {"svc:orders-api", "svc:orders-worker"}
        assert next(r for r in types(evs, "request") if r["id"] == "svc:orders-worker")["kind"] == "message"


def test_message_link_and_create_span_is_not_a_request():
    m = Mapper()
    req = http(path="/orders")
    prod = span("mkt:tick publish", kind="producer", parent=req["span_id"], **{"messaging.system": "kafka", "messaging.destination.name": "mkt:tick"})
    create = span("mkt:tick create", service="desk", kind="consumer", trace="v" * 32, **{"messaging.system": "kafka"})
    proc = span("mkt:tick process", service="desk", kind="consumer", parent=create["span_id"], trace="v" * 32,
                links=[{"trace_id": "t" * 32, "span_id": prod["span_id"]}], **{"messaging.system": "kafka"})
    evs = run(m, req, prod) + run(m, create, proc)
    assert [(e["from_id"], e["to_id"], e["text"]) for e in types(evs, "message")] == [("svc:orders-api", "svc:desk", "mkt:tick")]
    assert len([r for r in types(evs, "request") if r["id"] == "svc:desk"]) == 1  # the create span is not a request


def test_comets_rate_limited_per_edge():
    m = Mapper()
    evs = []
    for i in range(20):  # 20 messages in 200 ms on one edge
        req = http(path="/orders", t0=T + i * 10)
        p = span("orders publish", kind="producer", parent=req["span_id"], t0=T + i * 10, **{"messaging.system": "redis", "messaging.destination.name": "orders"})
        c = span("orders process", service="worker", kind="consumer", parent=p["span_id"], t0=T + i * 10 + 1, **{"messaging.system": "redis"})
        evs += run(m, req, p) + run(m, c)
    assert len(types(evs, "message")) == 1


# ---------------------------------------------------------------------- subagents, resources, GenAI
def test_agent_in_request_is_subagent_of_service_capped():
    m = Mapper()
    evs = []
    reqs = [http(path="/orders", t0=T + i) for i in range(backend.MAX_TASKS + 2)]
    tasks = [span("send_receipt", parent=r["span_id"], t0=T + 1 + i, **{"agentglow.agent": "send_receipt"}) for i, r in enumerate(reqs)]
    for r, t in zip(reqs, tasks):  # all tasks live at once
        evs += m.feed("start", {**r, "end_time_ms": None}) + m.feed("start", {**t, "end_time_ms": None})
    spawns = [e for e in types(evs, "spawn") if e["agent"] == "send_receipt"]
    assert len(spawns) == backend.MAX_TASKS
    assert all(e["parent_id"] == "svc:orders-api" and e["subagent"] for e in spawns)
    assert any(e["from_id"] == "svc:orders-api" and e["to_id"] == spawns[0]["id"] for e in types(evs, "message"))
    for t in tasks:
        evs += m.feed("end", t)
    assert len(types(evs, "exit")) == backend.MAX_TASKS  # the service itself never exits here


def test_client_spans_light_up_backend_resources():
    m = Mapper()
    req = http(path="/orders")
    r1 = span("XADD", kind="client", parent=req["span_id"], **{"db.system": "redis", "db.statement": "XADD orders * data ?"})
    r2 = span("SET", kind="client", parent=req["span_id"], t0=T + 1, **{"db.system": "redis", "db.statement": "SET k v"})  # rate-limited
    pay = span("POST", kind="client", parent=req["span_id"], **{"http.method": "POST", "url.full": "http://payments.local:9100/charge?card=1"})
    pg = span("INSERT orders", kind="client", parent=req["span_id"], **{"db.system": "postgresql", "db.name": "shop", "db.statement": "INSERT INTO orders"})
    evs = run(m, req, r1, r2, pay, pg)
    regs = {(e["server"], e["resources"][0]["name"], e["resources"][0]["kind"], e.get("kind")) for e in types(evs, "mcp_register")}
    # databases are database nodes of their own (`db:<system>`, kind "database"); HTTP hosts stay in `backend`
    assert regs == {("db:redis", "redis", "db", "database"), ("backend", "payments.local:9100", "api", None),
                    ("db:postgresql", "shop", "db", "database")}
    calls = [(e["server"], e["resource"], e["phase"]) for e in types(evs, "mcp")]
    assert sorted(calls) == sorted([(s, r, p) for s, r in (("db:redis", "redis"), ("backend", "payments.local:9100"), ("db:postgresql", "shop"))
                                    for p in ("call", "result")])
    assert all(e["id"] == "svc:orders-api" for e in types(evs, "mcp"))
    assert not types(evs, "graph")  # a DB write inside a service is a resource, not a knowledge-graph write


def test_database_node_per_system_with_collections():
    """One database node per db.system; collections / tables / indices are its resources, each query a call on it."""
    m = Mapper()
    req = http(path="/search")
    es = lambda idx, t0: span(f"elasticsearch {idx}", kind="client", parent=req["span_id"], t0=t0, **{  # noqa: E731
        "db.system": "elasticsearch", "db.namespace": idx, "db.collection.name": idx, "db.operation.name": "search"})
    pg = span("SELECT", kind="client", parent=req["span_id"], **{"db.system.name": "postgresql", "db.namespace": "shop", "db.sql.table": "orders",
                                                                 "db.operation": "SELECT"})
    evs = run(m, req, es("rides", T), es("zones", T + 1), es("rides", T + 400), pg)
    regs = types(evs, "mcp_register")
    assert {(e["server"], e["resources"][0]["name"]) for e in regs} == {("db:elasticsearch", "rides"), ("db:elasticsearch", "zones"),
                                                                        ("db:postgresql", "orders")}
    assert all(e["kind"] == "database" for e in regs)
    calls = [(e["server"], e["resource"], e["tool"]) for e in types(evs, "mcp") if e["phase"] == "call"]
    assert calls.count(("db:elasticsearch", "rides", "search")) == 2 and ("db:elasticsearch", "zones", "search") in calls
    assert ("db:postgresql", "orders", "SELECT") in calls
    assert not any(e["server"] == "backend" for e in types(evs, "mcp"))


def test_database_under_mcp_stays_on_mcp_server():
    """A DB call inside a real MCP tool span is still that MCP server's backend (no database node)."""
    m = Mapper()
    root = span("agent", kind="internal", **{"agentglow.agent": "a"})
    tool = span("lookup", parent=root["span_id"], **{"agentglow.mcp.server": "shop", "agentglow.mcp.tool": "lookup"})
    db = span("search", service="shop", kind="client", parent=tool["span_id"], **{"db.system": "elasticsearch", "db.collection.name": "rides"})
    evs = run(m, root, tool, db)
    assert {e["server"] for e in types(evs, "mcp")} == {"shop"}
    assert not any(e.get("kind") == "database" for e in types(evs, "mcp_register"))


def test_flat_db_call_is_a_database_node():
    hub = Hub()
    hub.ingest_events([{"service": "api", "event": "call", "to": "postgres", "kind": "db", "collection": "orders", "name": "SELECT"},
                       {"service": "api", "event": "call", "to": "stripe", "name": "POST"}], T)
    evs = list(hub.topology.values()) + list(hub.buffer)
    reg = {e["server"]: e for e in types(evs, "mcp_register")}
    assert reg["db:postgres"]["kind"] == "database" and reg["db:postgres"]["resources"] == [{"name": "orders", "kind": "db"}]
    assert "kind" not in reg["backend"]
    assert {(e["server"], e["resource"]) for e in types(evs, "mcp")} == {("db:postgres", "orders"), ("backend", "stripe")}


def test_hub_topology_keeps_database_kind():
    hub = Hub()
    req = http(path="/q")
    db = span("q", kind="client", parent=req["span_id"], **{"db.system": "elasticsearch", "db.collection.name": "rides"})
    hub.ingest_ended([db, req])
    topo = [e for e in hub.replay() if e["type"] == "mcp_register"]
    assert [(e["server"], e.get("kind"), e["resources"]) for e in topo] == [("db:elasticsearch", "database", [{"name": "rides", "kind": "db"}])]


def test_genai_inside_request_owned_by_service():
    m = Mapper()
    proc = span("orders process", service="worker", kind="consumer", **{"messaging.system": "redis"})
    llm = span("chat gpt-4.1-mini", service="worker", kind="client", parent=proc["span_id"],
               **{"gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 50, "gen_ai.usage.output_tokens": 7})
    sdk_http = span("POST", service="worker", kind="client", parent=llm["span_id"], **{"http.method": "POST", "url.full": "https://api.openai.com/v1/responses"})
    evs = run(m, proc, llm, sdk_http)
    (ev,) = types(evs, "llm")
    assert ev["id"] == "svc:worker" and ev["run_id"] == "services" and ev["tokens_in"] == 50
    assert not types(evs, "mcp")  # the LLM SDK's own HTTP call is not a backend resource


def test_mcp_tool_span_auto_discovers_backends():
    m = Mapper()
    root = span("researcher", service="agent", **{"agentglow.agent": "researcher"})
    tool = span("lookup", service="agent", kind="client", parent=root["span_id"], **{"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "lookup"})
    srv = span("mcp shop.lookup", service="shop", kind="server", parent=tool["span_id"],
               **{"agentglow.mcp.server": "shop", "agentglow.mcp.tool": "lookup", "mcp.method.name": "tools/call"})
    redis = span("GET", service="shop", kind="client", parent=srv["span_id"], **{"db.system": "redis", "db.statement": "GET k"})
    pay = span("GET", service="shop", kind="client", parent=srv["span_id"], **{"http.request.method": "GET", "server.address": "payments", "server.port": 9100})
    evs = run(m, root, tool, srv, redis, pay)
    assert not types(evs, "request") and not [e for e in types(evs, "spawn") if e["id"].startswith("svc:")]
    regs = [(e["server"], e["resources"]) for e in types(evs, "mcp_register")]
    assert regs == [("shop", []), ("shop", [{"name": "redis", "kind": "db"}]), ("shop", [{"name": "payments:9100", "kind": "api"}])]
    res = [(e["server"], e["tool"], e["resource"], e["phase"], e["id"]) for e in types(evs, "mcp") if "resource" in e]
    assert sorted(res) == sorted([("shop", "lookup", r, p, root["span_id"]) for r in ("redis", "payments:9100") for p in ("call", "result")])


def test_manual_mcp_resource_wins():
    m = Mapper()
    root = span("researcher", service="agent", **{"agentglow.agent": "researcher"})
    srv = span("mcp analytics", service="analytics", kind="server", parent=root["span_id"], **{
        "agentglow.mcp.server": "analytics", "agentglow.mcp.tool": "q", "agentglow.mcp.resource": "Snowflake", "agentglow.mcp.resource_kind": "warehouse"})
    pg = span("SELECT", service="analytics", kind="client", parent=srv["span_id"], **{"db.system": "postgresql", "db.statement": "SELECT 1"})
    evs = run(m, root, srv, pg)
    assert {e.get("resource") for e in types(evs, "mcp")} == {"Snowflake"}


def test_agent_only_spans_unaffected_by_kind_and_service():
    """GenAI / Hatchet / MCP spans never become service requests, whatever their kind."""
    assert backend.entry_kind({"kind": "server", "attributes": {"http.method": "GET", "gen_ai.operation.name": "chat"}}) is None
    assert backend.entry_kind({"kind": "consumer", "attributes": {"messaging.system": "x", "hatchet.step_run_id": "1"}}) is None
    assert backend.entry_kind({"kind": "server", "attributes": {"agentglow.mcp.server": "a", "http.method": "POST"}}) is None
    assert backend.entry_kind({"kind": "internal", "attributes": {"http.method": "GET"}}) is None
    assert backend.entry_kind({"kind": "server", "attributes": {"http.method": "GET"}}) == "http"
    assert backend.entry_kind({"kind": "server", "attributes": {"rpc.system": "grpc"}}) == "rpc"


def test_otlp_json_carries_kind_service_links():
    req = {"resourceSpans": [{"resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "orders-api"}}]},
                              "scopeSpans": [{"spans": [{"traceId": "a" * 32, "spanId": "b" * 16, "name": "GET /x", "kind": 2,
                                                         "startTimeUnixNano": "1000000", "endTimeUnixNano": "2000000",
                                                         "links": [{"traceId": "c" * 32, "spanId": "d" * 16}],
                                                         "attributes": [{"key": "http.method", "value": {"stringValue": "GET"}}]}]}]}]}
    (s,) = otlp_json_spans(req)
    assert s["kind"] == "server" and s["service"] == "orders-api" and s["links"] == [{"trace_id": "c" * 32, "span_id": "d" * 16}]
    c = TestClient(create_app())
    assert c.post("/v1/traces", json=req).status_code == 200
    assert [e["type"] for e in c.app.state.hub.buffer] == ["run", "spawn", "agent", "request"]


def test_service_drives_agent_runs_of_its_process():
    """An agent run whose spans come from a service's process (same service.name): a `drives` edge service -> run, sent
    at the tick once both exist, replayed to new viewers while the run is open, gone when it completes."""
    hub = Hub()
    m = hub.mapper
    proc = span("mkt:tick process", service="worker", kind="consumer", **{"messaging.system": "redis"})
    agent = span("desk", service="worker", trace="d" * 32, t0=T + 5, **{"agentglow.agent": "desk", "agentglow.run.id": "desk-run"})
    other = span("solo", service="cli", trace="e" * 32, t0=T + 5, **{"agentglow.agent": "solo", "agentglow.run.id": "solo-run"})
    evs = run(m, proc) + m.feed("start", {**agent, "end_time_ms": None, "status": "unset"}) + \
        m.feed("start", {**other, "end_time_ms": None, "status": "unset"})
    assert not types(evs, "drives")  # sent at the tick, never inline
    (dr,) = types(m.tick(T + 1000), "drives")
    assert dr == {"type": "drives", "run_id": "services", "id": "svc:worker", "target_run": "desk-run", "ts": T + 1000}
    assert not types(m.tick(T + 2000), "drives")  # once
    hub.publish([dr])
    hub.buffer.clear()
    assert [e for e in hub.replay() if e["type"] == "drives"] == [dr]
    m.feed("end", agent)
    m.tick(T + 60_000)
    assert "desk-run" not in m.runs and not [e for e in hub.replay() if e["type"] == "drives"]


# ---------------------------------------------------------------------- hub: replay, flat events
def test_replay_resends_service_spawn_after_buffer_eviction():
    hub = Hub(buffer=10)
    m = hub.mapper
    for i in range(30):
        hub.publish(run(m, http(t0=T + i * 300)))
    assert not [e for e in hub.buffer if e["type"] == "spawn"]
    rep = hub.replay()
    assert [e["type"] for e in rep[:3]] == ["run", "spawn", "agent"] and rep[1]["id"] == "svc:orders-api" and rep[2]["status"] == "thinking"
    assert hub.replay(after=hub.seq) == []  # a viewer that is up to date gets nothing again


def test_flat_events_endpoint():
    c = TestClient(create_app(ingest_key="k1"))
    body = [
        {"service": "billing", "event": "request", "name": "POST /invoice", "status": 201, "duration_ms": 12},
        {"service": "billing", "event": "error", "name": "charge sk-ant-abcdefghijklmnop", "user.email": "a@b.c"},
        {"service": "billing", "event": "message", "to": "mailer", "topic": "invoice.paid"},
        {"service": "billing", "event": "call", "to": "stripe", "kind": "api", "duration_ms": 80},
        {"agent": "bot", "event": "llm", "tokens_in": 900, "tokens_out": 120},
        {"agent": "bot", "event": "tool", "name": "search"},
        {"event": "request"},  # no service: ignored
    ]
    assert c.post("/v1/events", json=body).status_code == 401
    r = c.post("/v1/events", json=body, headers={"x-api-key": "k1"})
    assert r.status_code == 200 and r.json()["n"] == 7
    evs = list(c.app.state.hub.buffer)
    spawns = {e["agent"] for e in types(evs, "spawn")}
    assert spawns == {"billing", "mailer", "bot"}
    reqs = types(evs, "request")
    assert reqs[0]["name"] == "POST /invoice" and reqs[0]["status"] == 201 and not reqs[0]["error"]
    assert reqs[1]["error"] and "sk-ant" not in reqs[1]["name"] and "[redacted]" in reqs[1]["name"]
    assert "a@b.c" not in str(evs)
    assert [(e["from_id"], e["to_id"], e["text"]) for e in types(evs, "message")] == [("svc:billing", "svc:mailer", "invoice.paid")]
    assert [(e["resource"], e["phase"]) for e in types(evs, "mcp")] == [("stripe", "call"), ("stripe", "result")]
    assert types(evs, "llm")[0]["id"] == "svc:bot" and types(evs, "llm")[0]["tokens_out"] == 120
    assert types(evs, "tool")[0]["tool"] == "search"
    # single object + scope from the query string
    r = c.post("/v1/events?scope=team-b", json={"service": "billing", "name": "GET /"}, headers={"x-api-key": "k1"})
    assert r.json()["n"] == 1 and c.app.state.hub.buffer[-1]["run_id"] == "services:team-b"


# ---------------------------------------------------------------------- python API
def test_watch_app_broker_mcp_and_pulse(monkeypatch):
    import asyncio

    from fastapi import FastAPI
    from faststream.redis import RedisBroker
    from mcp.server.fastmcp import FastMCP
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    import sys

    import agentglow

    w = sys.modules["agentglow.watch"]
    from agentglow.otel import span_to_dict

    provider = TracerProvider()
    exp = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exp))
    monkeypatch.setattr(w.trace, "get_tracer_provider", lambda: provider)

    from fastapi import BackgroundTasks

    app = FastAPI(title="orders-api")

    def send_receipt(oid: int) -> None:
        pass

    @app.get("/orders/{oid}")
    def get_order(oid: int, bg: BackgroundTasks):
        bg.add_task(send_receipt, oid)
        return {"id": oid}

    broker = RedisBroker("redis://localhost:1")
    mcp = FastMCP("shop")

    @mcp.tool()
    async def lookup(k: str) -> str:
        return k

    w.watch("http://127.0.0.1:9", app=app, broker=broker, mcp=mcp, service_name="orders-api", instrument=False)
    w.watch("http://127.0.0.1:9", app=app, broker=broker, mcp=mcp, instrument=False)  # idempotent
    assert TestClient(app).get("/orders/7").status_code == 200
    assert asyncio.run(mcp._tool_manager.call_tool("lookup", {"k": "x"})) == "x"
    spans = {s.name: s for s in exp.get_finished_spans()}
    server = span_to_dict(spans["GET /orders/{oid}"], "orders-api")
    assert server["kind"] == "server" and server["service"] == "orders-api" and backend.entry_kind(server) == "http"
    assert len([s for s in spans if "http send" in s or "http receive" in s]) == 0
    # FastAPI's background task span -> a subagent of the service
    m = Mapper()
    evs = []
    for sp in sorted(exp.get_finished_spans(), key=lambda x: x.start_time):
        evs += m.feed("start", {**span_to_dict(sp, "orders-api"), "end_time_ms": None})
    for sp in exp.get_finished_spans():
        evs += m.feed("end", span_to_dict(sp, "orders-api"))
    sub = [e for e in types(evs, "spawn") if e["subagent"]]
    assert [(e["agent"], e["parent_id"]) for e in sub] == [("send_receipt", "svc:orders-api")]
    assert types(evs, "request")[0]["name"] == "GET /orders/{oid}"
    tool = span_to_dict(spans["mcp shop.lookup"])
    assert tool["attributes"]["agentglow.mcp.server"] == "shop" and tool["attributes"]["agentglow.mcp.tool"] == "lookup"
    assert sum(type(m).__name__ == "RedisTelemetryMiddleware" for m in broker.middlewares) == 1

    sent = []
    monkeypatch.setattr(w._Pulser, "_run", lambda self: None)
    agentglow.pulse("billing", "POST /x", status=200, duration_ms=3, url="http://127.0.0.1:9")
    p = w._pulsers["http://127.0.0.1:9"]
    monkeypatch.setattr(w.urllib.request, "urlopen", lambda req, timeout: sent.append(req) or type("R", (), {"close": lambda s: None})())
    p.flush()
    import json

    assert sent[0].full_url.endswith("/v1/events")
    assert json.loads(sent[0].data) == [{"service": "billing", "event": "request", "name": "POST /x", "status": 200, "duration_ms": 3}]


def test_root_client_spans_ping_resources_polls_dropped():
    m = Mapper()
    poll = span("XREAD", service="orders-worker", kind="client", **{"db.system": "redis", "db.statement": "XREAD BLOCK 100 STREAMS orders $"})
    evs = run(m, poll)
    assert evs == []
    assert not types(evs, "run")
    cron = span("SET", service="orders-worker", kind="client", t0=T + 500, **{"db.system": "redis", "db.statement": "SET heartbeat 1"})
    evs = run(m, cron)
    assert [e["type"] for e in evs] == ["run", "spawn", "agent", "mcp_register", "mcp", "mcp"]
    assert all(e["id"] == "svc:orders-worker" for e in types(evs, "mcp")) and not types(evs, "graph")
    m.tick(T + 60_000)
    assert not m.spans  # ended service spans are forgotten


def test_mcp_span_children_wait_with_their_held_parent():
    m = Mapper()
    root = span("researcher", service="agent", **{"agentglow.agent": "researcher"})
    tool = span("lookup", service="agent", parent=root["span_id"], **{"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "lookup"})
    srv = span("mcp shop.lookup", service="shop", kind="server", parent=tool["span_id"], **{"agentglow.mcp.server": "shop"})
    db = span("HGETALL", service="shop", kind="client", parent=srv["span_id"], **{"db.system": "redis", "db.statement": "HGETALL k"})
    evs = run(m, srv, db)  # the MCP server process reports first
    assert evs == []
    evs = m.feed("start", {**root, "end_time_ms": None}) + m.feed("start", {**tool, "end_time_ms": None})
    assert {e.get("resource") for e in types(evs, "mcp")} == {None, "redis"} and len(types(evs, "run")) == 1


def test_live_client_spans_with_attributes_only_at_end():
    """redis / httpx instrumentations set their attributes after the span started: classified at the end."""
    m = Mapper()
    req = http(path="/orders")
    hset = span("HSET", kind="client", parent=req["span_id"], **{"db.system": "redis", "db.statement": "HSET ? ? ?"})
    poll = span("XREAD", service="orders-worker", kind="client", **{"db.system": "redis", "db.statement": "XREAD ? ? ? ? ?"})
    chat = span("chat", service="bot", kind="client", **{"gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 5})
    evs = []
    for sp in (req, hset, poll, chat):
        evs += m.feed("start", {**sp, "end_time_ms": None, "status": "unset", "attributes": {} if sp is not req else sp["attributes"]})
    for sp in (chat, poll, hset, req):
        evs += m.feed("end", sp)
    assert [(e["resource"], e["phase"]) for e in types(evs, "mcp")] == [("redis", "call"), ("redis", "result")]
    runs = types(evs, "run")
    assert {r["run_id"] for r in runs} == {"services", chat["trace_id"]}  # the poll made no run; the LLM call still does
    assert types(evs, "llm")[0]["tokens_in"] == 5


# ---------------------------------------------------------------------- long-running requests -> job nodes
def _consume(topic="mkt:tick", service="orders-worker", **kw):
    return span(f"{topic} process", kind="consumer", service=service, **{"messaging.system": "redis", "messaging.destination.name": topic}, **kw)


def test_long_request_becomes_job_owning_its_calls():
    m = Mapper()
    req = _consume(t1=T + 20_000)
    evs = m.feed("start", {**req, "end_time_ms": None, "status": "unset"})
    assert not types(m.tick(T + backend.JOB_MS - 1), "spawn")  # not yet: still a plain open request
    tick = m.tick(T + backend.JOB_MS)
    (sp,) = types(tick, "spawn")
    jid = f"req:{req['span_id']}"
    assert sp == {"type": "spawn", "run_id": "services", "id": jid, "agent": "mkt:tick", "parent_id": "svc:orders-worker",
                  "subagent": True, "job": True, "since": T, "ts": T + backend.JOB_MS}
    assert {"type": "agent", "run_id": "services", "id": jid, "status": "thinking", "ts": T + backend.JOB_MS} in tick
    (st,) = types(tick, "service_stats")
    assert st["inflight"] == 1 and st["n"] == 0
    # calls inside the job are owned by it while it runs
    db = span("GET", kind="client", parent=req["span_id"], t0=T + 5000, t1=T + 5005, **{"db.system": "redis"})
    llm = span("chat", kind="client", parent=req["span_id"], t0=T + 6000, t1=T + 7000, **{"gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 5})
    evs = run(m, db, llm)
    assert {e["id"] for e in types(evs, "mcp")} == {jid}
    assert types(evs, "llm")[0]["id"] == jid
    # the end: exit done, then the usual request on the service
    evs = m.feed("end", req)
    assert types(evs, "exit") == [{"type": "exit", "run_id": "services", "id": jid, "status": "done", "ts": T + 20_000}]
    (rq,) = types(evs, "request")
    assert rq["id"] == "svc:orders-worker" and rq["ms"] == 20_000
    assert types(m.tick(T + 21_000), "service_stats")[0]["inflight"] == 0  # cleared once
    assert "inflight" not in (types(m.tick(T + 22_000), "service_stats") or [{}])[0]


def test_failed_job_and_short_requests_unchanged():
    m = Mapper()
    req = http(path="/reports", code=500, t1=T + 9000)
    m.feed("start", {**req, "end_time_ms": None, "status": "unset"})
    assert types(m.tick(T + 4000), "spawn")[0]["agent"] == "GET /reports"
    assert types(m.feed("end", req), "exit")[0]["status"] == "failed"
    # a request ending before JOB_MS: no node, exactly as before
    m2 = Mapper()
    evs = run(m2, http(t0=T, t1=T + 2500))
    evs += m2.tick(T + 3000) + m2.tick(T + 9000)
    assert [e["agent"] for e in types(evs, "spawn")] == ["orders-api"] and not types(evs, "exit")
    assert all("inflight" not in e for e in types(evs, "service_stats"))


def test_job_nodes_capped_per_service_and_replayed():
    m = Mapper()
    reqs = [_consume(t0=T + i) for i in range(backend.MAX_JOBS + 3)]
    for r in reqs:
        m.feed("start", {**r, "end_time_ms": None, "status": "unset"})
    tick = m.tick(T + 60_000)
    assert len(types(tick, "spawn")) == backend.MAX_JOBS
    assert types(tick, "service_stats")[0]["inflight"] == backend.MAX_JOBS + 3
    snap = m.svc.snapshot()
    assert sum(1 for e in snap if e["type"] == "spawn" and e.get("job")) == backend.MAX_JOBS
    # one ends: the next waiting long request gets a node
    m.feed("end", {**reqs[0], "end_time_ms": T + 61_000})
    assert len(types(m.tick(T + 62_000), "spawn")) == 1


# ---------------------------------------------------------------------- long-request jobs vs primitive job(id) / sessions
def test_request_holding_a_primitive_job_is_not_also_a_long_request_job():
    m = Mapper()
    req = _consume(t1=T + 20_000)
    m.feed("start", {**req, "end_time_ms": None, "status": "unset"})
    j = span("job order", service="orders-worker", parent=req["span_id"], t0=T + 5, t1=T + 19_000,
             **{"agentglow.job.id": "o-1", "agentglow.job.kind": "order", "agentglow.job.state": "running"})
    evs = m.feed("start", {**j, "end_time_ms": None, "status": "unset"})
    evs += m.tick(T + backend.JOB_MS) + m.tick(T + 2 * backend.JOB_MS)
    ids = [e["id"] for e in types(evs, "spawn")]
    assert "job:o-1" in ids and not [i for i in ids if i.startswith(backend.LONG_PREFIX)]
    evs = m.feed("end", j) + m.feed("end", req)
    assert not [e for e in types(evs, "exit") if e["id"].startswith(backend.LONG_PREFIX)]


def test_primitive_job_after_promotion_takes_over_the_long_request_node():
    m = Mapper()
    req = _consume(t1=T + 30_000)
    m.feed("start", {**req, "end_time_ms": None, "status": "unset"})
    (sp,) = types(m.tick(T + backend.JOB_MS), "spawn")
    assert sp["id"] == f"req:{req['span_id']}"
    j = span("job order", service="orders-worker", parent=req["span_id"], t0=T + 25_000, t1=T + 29_000,
             **{"agentglow.job.id": "o-2", "agentglow.job.kind": "order"})
    evs = m.feed("start", {**j, "end_time_ms": None, "status": "unset"})
    assert {"type": "exit", "run_id": "services", "id": sp["id"], "status": "done", "ts": T + 25_000} in evs
    assert "job:o-2" in [e["id"] for e in types(evs, "spawn")]
    evs = m.feed("end", j) + m.feed("end", req) + m.tick(T + 40_000)
    assert not [e for e in types(evs, "exit") if e["id"] == sp["id"]]  # no second exit
    assert not types(evs, "spawn") or all(not e["id"].startswith(backend.LONG_PREFIX) for e in types(evs, "spawn"))


def test_websocket_entry_never_becomes_a_long_request_job():
    m = Mapper()
    ws = span("/chat", kind="server", t1=T + 60_000, **{"network.protocol.name": "websocket", "http.route": "/chat"})
    m.feed("start", {**ws, "end_time_ms": None, "status": "unset"})
    evs = m.tick(T + backend.JOB_MS) + m.tick(T + 10_000)
    assert not [e for e in types(evs, "spawn") if e["id"].startswith(backend.LONG_PREFIX)]
    assert not m.svc.svcs["svc:orders-api"].open
