"""Generic primitives (docs/SPEC.md "Generic primitives"): producer API -> spans -> mapper -> world events."""
import asyncio
import time

import pytest
from fastapi.testclient import TestClient
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider

import agentglow
from agentglow import manual, primitives
from agentglow.mapper import Mapper
from agentglow.otel import span_to_dict
from agentglow.scope import apply_scope
from agentglow.server import create_app
from agentglow.state import Hub


class Capture(SpanProcessor):
    """What LiveSpanProcessor would POST (starts + ends in order); `service` = the reporting process's service."""

    def __init__(self):
        self.items, self.service = [], "api"

    def on_start(self, span, parent_context=None):
        apply_scope(span, parent_context)
        self.items.append(("start", span_to_dict(span, self.service)))

    def on_end(self, span):
        self.items.append(("end", span_to_dict(span, self.service)))


@pytest.fixture
def cap():
    c, p = Capture(), TracerProvider(resource=Resource.create({"service.name": "api"}))
    p.add_span_processor(c)
    manual.use_provider(p)
    c.tracer = p.get_tracer("test")
    yield c
    manual.use_provider(None)


def feed(cap, m=None):
    m = m or Mapper()
    return [e for k, s in cap.items for e in m.feed(k, s)], m


def of(evs, t, **kw):
    return [e for e in evs if e["type"] == t and all(e.get(k) == v for k, v in kw.items())]


def request(cap, route="/orders", method="POST", code=200, kind=trace.SpanKind.SERVER):
    span = cap.tracer.start_as_current_span(f"{method} {route}", kind=kind, attributes={
        "http.request.method": method, "http.route": route, "http.response.status_code": code})
    return span


def consume(cap, topic="orders"):
    return cap.tracer.start_as_current_span(f"{topic} process", kind=trace.SpanKind.CONSUMER, attributes={
        "messaging.system": "redis", "messaging.destination.name": topic, "messaging.operation.type": "process"})


# ---------------------------------------------------------------------------------------------- session
def test_session_under_request_is_a_live_subagent_with_turns_gauges_and_outcome(cap):
    with request(cap, "/ws/chat", "GET"):
        with agentglow.session("support chat", kind="ws", id="conv-77") as s:
            s.turn("user", ms=120)
            s.turn("agent", tokens=40)
            s.progress(frames_in=3, rate_in=1.5, junk="text")
            with agentglow.stage("reply"):
                pass
            s.end(outcome="resolved", reason="client_disconnect")
    evs, _ = feed(cap)
    sp = of(evs, "spawn", agent="support chat")[0]
    assert sp["parent_id"] == "svc:api" and sp["subagent"] is True
    ses = of(evs, "session")
    assert [e["phase"] for e in ses] == ["start", "turn", "turn", "progress", "end"]
    assert ses[0]["kind"] == "ws" and ses[0]["ref"] == "conv-77" and ses[0]["id"] == sp["id"]
    assert ses[1]["role"] == "user" and ses[1]["gauges"] == {"ms": 120}
    assert ses[3]["gauges"] == {"frames_in": 3, "rate_in": 1.5}  # numbers only
    assert ses[4]["outcome"] == "resolved" and ses[4]["reason"] == "client_disconnect" and ses[4]["ms"] >= 0
    assert of(evs, "stage", id=sp["id"])[0]["status"] == "running"
    assert of(evs, "exit", id=sp["id"])[0]["status"] == "done"
    assert not of(evs, "run", topic="support chat")  # never a run of its own


def test_detached_session_hangs_off_the_service(cap):
    ctx = agentglow.capture()  # nothing current: no parent
    with agentglow.session("call", kind="voice", parent_link=False):
        agentglow.lifecycle("ready")
    with agentglow.session("call 2", kind="voice", parent=ctx):
        pass
    evs, _ = feed(cap)
    assert [e["parent_id"] for e in of(evs, "spawn") if e["agent"].startswith("call")] == ["svc:api", "svc:api"]
    assert [r["run_id"] for r in of(evs, "run")] == ["services"]
    assert of(evs, "lifecycle")[0]["id"] == "svc:api"  # a root signal belongs to the service


def test_session_ws_middleware_counts_frames_and_close_reason(cap):
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect

    app = FastAPI()
    primitives.watch_websockets(app)
    primitives.watch_websockets(app)  # idempotent

    @app.websocket("/ws/{room}")
    async def chat(ws: WebSocket, room: str):
        await ws.accept()
        try:
            while True:
                msg = await ws.receive_text()
                await ws.send_text(msg.upper())
        except WebSocketDisconnect:
            pass

    with TestClient(app) as c, c.websocket_connect("/ws/r-123") as ws:
        ws.send_text("hi")
        assert ws.receive_text() == "HI"
    time.sleep(0.05)
    evs, _ = feed(cap)
    ses = of(evs, "session")
    assert ses[0]["name"] == "/ws/{room}" and ses[0]["kind"] == "ws"  # route template, never the raw path
    assert ses[-1]["phase"] == "end" and ses[-1]["reason"] == "client_disconnect"
    assert ses[-2]["gauges"]["frames_in"] >= 1 and ses[-2]["gauges"]["frames_out"] == 1
    assert "r-123" not in str(evs)


# ---------------------------------------------------------------------------------------------- jobs, stages, progress
def test_job_follows_one_node_across_processes_with_retries_stages_and_progress(cap):
    m = Mapper()
    with request(cap):
        agentglow.job("o-1", kind="fulfil", state="queued")
    cap.service = "worker"
    for attempt in (1, 2):
        with consume(cap):
            try:
                with agentglow.job("o-1", kind="fulfil", attempt=attempt, max_attempts=3):
                    if attempt == 1:
                        raise RuntimeError("flaky")
                    with agentglow.stage("pick"), agentglow.stage("pack"):  # parallel stages
                        for i in range(1, 5):
                            agentglow.progress(i, 4)
                            time.sleep(0.21)
            except RuntimeError:
                pass
    evs, _ = feed(cap, m)
    jobs = of(evs, "spawn", id="job:o-1")
    assert len(jobs) == 1 and jobs[0]["parent_id"] == "svc:api" and jobs[0]["agent"] == "fulfil o-1"
    states = [(e["state"], e["attempt"], e.get("at")) for e in of(evs, "job")]
    assert states == [("queued", 1, "api"), ("running", 1, "worker"), ("retrying", 1, "worker"), ("running", 2, "worker"),
                      ("done", 2, "worker")]
    texts = [e["text"] for e in of(evs, "message", to_id="job:o-1")]
    assert texts == ["fulfil", "running", "retry #2"]  # spawn delegation, moved api -> worker, the retry
    assert of(evs, "message", to_id="job:o-1")[1]["from_id"] == "svc:worker"
    st = of(evs, "stage", id="job:o-1")
    assert [(e["name"], e["status"]) for e in st] == [("pick", "running"), ("pack", "running"), ("pack", "done"), ("pick", "done")]
    pr = of(evs, "progress", id="job:o-1")
    assert pr[0]["frac"] == 0.25 and pr[-1]["frac"] == 1.0 and any("eta_ms" in e for e in pr[1:-1])
    assert of(evs, "exit", id="job:o-1")[0]["status"] == "done"
    assert m.prims.snapshot() == []  # exited jobs are not replayed


def test_dead_letter_and_failed_job_exit(cap):
    m = Mapper()
    try:
        with agentglow.job("o-2", kind="fulfil", attempt=3, max_attempts=3):
            raise ValueError("boom")
    except ValueError:
        pass
    agentglow.job("o-3", state="failed")
    evs, _ = feed(cap, m)
    assert [e["state"] for e in of(evs, "job", job_id="o-2")] == ["running", "dead"]
    assert of(evs, "exit", id="job:o-2")[0]["status"] == "failed"
    assert not of(evs, "exit", id="job:o-3")  # failed: waits for a retry
    assert {e["id"] for e in m.prims.snapshot() if e["type"] == "spawn"} == {"job:o-3"}
    later = m.tick(int(time.time() * 1000) + 61_000)
    assert of(later, "exit", id="job:o-3")[0]["status"] == "failed"


# ---------------------------------------------------------------------------------------------- admission
def test_capacity_and_rejected_request_is_amber_not_error(cap):
    with request(cap, code=503):
        agentglow.capacity("slots", used=4, max=4)
        agentglow.rejected("busy", retry_after=2, status=503)
    with request(cap, code=500):
        pass
    evs, m = feed(cap)
    assert of(evs, "capacity")[0] == {**of(evs, "capacity")[0], "name": "slots", "used": 4, "max": 4, "id": "svc:api"}
    rj = of(evs, "rejected")[0]
    assert rj["reason"] == "busy" and rj["retry_after_ms"] == 2000 and rj["status"] == 503
    reqs = of(evs, "request")
    assert reqs[0]["rejected"] is True and reqs[0]["error"] is False and reqs[1]["error"] is True
    stats = of(m.tick(int(time.time() * 1000) + 1000), "service_stats")[0]
    assert stats["errors"] == 1 and stats["codes"] == {"5xx": 1, "rejected": 1}


def test_capacity_rate_limited_but_edges_pass(cap):
    for used in (1, 2, 3, 4, 3):
        agentglow.capacity("slots", used=used, max=4)
    evs, _ = feed(cap)
    assert [e["used"] for e in of(evs, "capacity")] == [1, 4, 3]  # first, hits max, leaves max


# ---------------------------------------------------------------------------------------------- pools + inference
def test_pool_lease_really_limits_and_reports_wait_vs_use(cap):
    gpu = agentglow.pool("whisper", size=1, kind="model", devices=["gpu0"])
    assert agentglow.pool("whisper", size=9) is gpu

    async def one(k):
        async with gpu.lease() as inst:
            assert inst.device == "gpu0" and gpu.busy == 1
            with agentglow.inference("whisper-small", device=inst.device, unit="audio_s") as inf:
                await asyncio.sleep(0.05)
                inf.units = 2.0

    async def main():
        await asyncio.gather(one(0), one(1))

    asyncio.run(main())
    assert gpu.busy == 0 and gpu.waiting == 0
    evs, m = feed(cap)
    reg = {r["name"]: r["kind"] for e in of(evs, "mcp_register") for r in e["resources"]}
    assert reg == {"whisper": "model", "whisper-small": "model"}
    leases = of(evs, "mcp", tool="lease")
    assert [e["phase"] for e in leases] == ["call", "result", "call", "result"] and leases[0]["device"] == "gpu0"
    infer = of(evs, "mcp", tool="infer", phase="result")
    assert infer[0]["units"] == 2.0 and infer[0]["unit"] == "audio_s"
    stats = {e["resource"]: e for e in of(m.tick(int(time.time() * 1000)), "resource_stats")}
    w = stats["whisper"]
    assert w["size"] == 1 and w["busy"] == 0 and w["calls"] == 2 and w["wait_p50_ms"] >= 0 and w["devices"] == [{"device": "gpu0", "busy": 0}]
    waits = sorted(s["attributes"]["agentglow.pool.wait_ms"] for k, s in cap.items if k == "start" and s["name"] == "lease whisper")
    assert waits[0] < 20 and waits[1] >= 40  # the second lease waited for the first
    assert 0 < stats["whisper-small"]["rtf"] < 0.2 and stats["whisper-small"]["units"] == 4.0


def test_sync_lease_with_threads():
    import threading

    p = primitives.Pool("w", 2)
    seen, lock = [], threading.Lock()

    def work():
        with p.lease() as inst:
            with lock:
                seen.append(p.busy)
            time.sleep(0.02)
            assert inst.index in (0, 1)

    ts = [threading.Thread(target=work) for _ in range(6)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert max(seen) <= 2 and p.busy == 0


# ---------------------------------------------------------------------------------------------- callbacks, fallback, gate ...
def test_link_complete_fallback_gate_lifecycle_metric_event_cache(cap):
    with request(cap, "/checkout"):
        with cap.tracer.start_as_current_span("POST", kind=trace.SpanKind.CLIENT, attributes={"http.request.method": "POST", "server.address": "pay"}):
            agentglow.link("ch_123456789", label="payment")
        agentglow.fallback(from_="inline", to="queue", reason="timeout", job="o-9")
        agentglow.gate("refunds", state="locked", attempts_left=2)
        agentglow.event("signup", label="trial", seats=3, note={"x": 1}, plan="pro")
        for hit in (True, True, False):
            agentglow.cache("catalog", hit=hit)
        agentglow.metric("audio", 1.5, unit="audio_min/min")
        agentglow.metric("audio", 1.6, unit="audio_min/min")  # rate limited
    cap.service = "webhooks"
    with request(cap, "/webhooks/payment"):
        agentglow.complete("ch_123456789", status="succeeded")
        agentglow.complete("unknown")  # nothing linked: ignored
    agentglow.lifecycle("warming")
    agentglow.lifecycle("bogus")
    evs, m = feed(cap)
    op, done = of(evs, "deferred")
    assert op["phase"] == "open" and op["label"] == "payment" and op["id"] == "svc:api" and op["ref"] == "ch_123456789"
    assert done["phase"] == "done" and done["status"] == "succeeded" and done["from_id"] == "svc:webhooks" and done["id"] == "svc:api"
    assert of(evs, "message", from_id="svc:webhooks", to_id="svc:api")[0]["text"] == "payment succeeded"
    fb = of(evs, "fallback")[0]
    assert fb["to_id"] == "job:o-9" and fb["reason"] == "timeout" and fb["from"] == "inline"
    assert of(evs, "gate")[0] == {**of(evs, "gate")[0], "name": "refunds", "state": "locked", "attempts_left": 2}
    ev = of(evs, "event")[0]
    assert ev["kind"] == "signup" and ev["label"] == "trial" and ev["fields"] == {"seats": 3, "plan": "pro"}
    assert len(of(evs, "metric")) == 1 and of(evs, "metric")[0]["unit"] == "audio_min/min"
    assert [e["tool"] for e in of(evs, "mcp", resource="catalog", phase="call")] == ["hit"]  # pulses rate limited
    stats = {e["resource"]: e for e in of(m.tick(int(time.time() * 1000)), "resource_stats")}
    assert stats["catalog"]["hits"] == 2 and stats["catalog"]["misses"] == 1 and stats["catalog"]["kind"] == "cache"
    assert [e["state"] for e in of(evs, "lifecycle")] == ["warming"]
    snap = m.prims.snapshot()
    assert {e["type"] for e in snap} == {"gate", "lifecycle", "spawn", "job"}
    assert not [e for e in evs if e["type"] == "run" and e["run_id"] != "services"]


def test_order_event_unchanged(cap):
    with agentglow.agent("bot"):
        agentglow.order("buy", 3, 0.42)
    evs, _ = feed(cap)
    assert of(evs, "order")[0]["side"] == "buy" and not of(evs, "event")


# ---------------------------------------------------------------------------------------------- flat events + hub
def test_flat_primitives_and_backlog_edge():
    c = TestClient(create_app())
    body = [
        {"service": "api", "event": "message", "to": "worker", "topic": "orders"},
        {"service": "worker", "event": "backlog", "topic": "orders", "depth": 42, "pending": 3, "lag_ms": 1200},
        {"service": "api", "event": "job", "job_id": "o-5", "kind": "fulfil", "state": "queued"},
        {"service": "worker", "event": "job", "job_id": "o-5", "state": "running", "attempt": 2},
        {"service": "worker", "event": "stage", "job_id": "o-5", "name": "decode", "status": "running"},
        {"service": "worker", "event": "progress", "job_id": "o-5", "i": 1, "n": 4},
        {"service": "voice", "event": "session", "session_id": "c-1", "phase": "start", "kind": "voice", "name": "call"},
        {"service": "voice", "event": "session", "session_id": "c-1", "phase": "turn", "role": "user"},
        {"service": "voice", "event": "session", "session_id": "c-1", "phase": "progress", "gauges": {"audio_s": 12.5}},
        {"service": "voice", "event": "gate", "session_id": "c-1", "name": "pin", "state": "unlocked"},
        {"service": "voice", "event": "session", "session_id": "c-1", "phase": "end", "outcome": "booked"},
        {"service": "voice", "event": "inference", "model": "whisper", "units": 10, "unit": "audio_s", "duration_ms": 900},
        {"service": "voice", "event": "lease", "pool": "gpus", "kind": "gpu", "size": 2, "wait_ms": 5, "duration_ms": 40, "device": "gpu1"},
        {"service": "api", "event": "event", "kind": "refund", "label": "sk-ant-abcdefghijklmnopqrstu", "amount": 12.5},
        {"service": "api", "event": "rejected", "reason": "rate limit", "retry_after_ms": 1000},
        {"service": "api", "event": "lifecycle", "state": "ready"},
        {"service": "api", "event": "cache", "name": "sessions", "hit": False},
        {"service": "api", "event": "metric", "name": "rps", "value": 12, "unit": "req/s"},
    ]
    assert c.post("/v1/events", json=body).json()["n"] == len(body)
    hub = c.app.state.hub
    evs = list(hub.buffer)
    bl = of(evs, "backlog")[0]
    assert (bl["from_id"], bl["to_id"], bl["depth"], bl["lag_ms"]) == ("svc:api", "svc:worker", 42, 1200)
    assert [e["state"] for e in of(evs, "job")] == ["queued", "running"]
    assert of(evs, "stage")[0]["id"] == "job:o-5" and of(evs, "progress")[0]["frac"] == 0.25
    ses = of(evs, "session")
    assert [e["phase"] for e in ses] == ["start", "turn", "progress", "end"] and ses[-1]["outcome"] == "booked"
    assert ses[0]["id"] == "ses:svc:voice:c-1" and of(evs, "gate")[0]["id"] == "ses:svc:voice:c-1"
    assert of(evs, "exit", id="ses:svc:voice:c-1")
    assert of(evs, "mcp", resource="whisper", phase="result")[0]["latency_ms"] == 900
    assert of(evs, "mcp", resource="gpus")[0]["resource_kind"] == "gpu"
    ev = of(evs, "event")[0]
    assert ev["kind"] == "refund" and "sk-ant" not in str(ev) and ev["fields"] == {"amount": 12.5}
    assert of(evs, "rejected")[0]["retry_after_ms"] == 1000 and of(evs, "lifecycle")[0]["state"] == "ready"
    assert [e["name"] for e in of(evs, "request")] == ["orders"]  # only the message; primitives are not requests
    hub.tick(int(time.time() * 1000))
    stats = {e["resource"]: e for e in of(list(hub.buffer), "resource_stats")}
    assert stats["whisper"]["rtf"] == 0.09 and stats["gpus"]["devices"] == [{"device": "gpu1", "busy": 0}]


def test_replay_resends_job_node_and_state_after_buffer_eviction():
    hub = Hub(buffer=5)
    hub.ingest_events([{"service": "api", "event": "job", "job_id": "o-7", "state": "queued"},
                       {"service": "api", "event": "gate", "name": "kyc", "state": "locked"}], int(time.time() * 1000))
    hub.ingest_events([{"service": "api", "name": f"GET /{i}"} for i in range(10)], int(time.time() * 1000))
    types = [e["type"] for e in hub.replay()]
    assert "job" in types and "gate" in types and types.count("spawn") >= 2


# ---------------------------------------------------------------------------------------------- backlog sampler
class FakeRedis:
    def __init__(self):
        now = int(time.time() * 1000)
        self.now = now

    def xlen(self, name):
        return 7

    def xinfo_groups(self, name):
        return [{"name": b"workers", "lag": 4, "last-delivered-id": b"%d-0" % (self.now - 500)}]

    def xpending(self, name, group):
        return {"pending": 2, "min": b"%d-0" % (self.now - 2000), "max": None}

    def xrange(self, name, min, count):
        return [(b"%d-1" % (self.now - 400), {})]


def test_sample_once_reads_depth_pending_and_lag():
    r = FakeRedis()
    rows = primitives.sample_once(r, [("orders", "workers"), ("audit", None)])
    assert rows[0]["topic"] == "orders" and rows[0]["depth"] == 6 and rows[0]["pending"] == 2 and 1900 <= rows[0]["lag_ms"] <= 3000
    assert rows[1] == {"topic": "audit", "depth": 7}


def test_broker_streams_from_faststream():
    from faststream.redis import RedisBroker, StreamSub

    b = RedisBroker("redis://localhost:1/0")

    @b.subscriber(stream=StreamSub("orders", group="workers", consumer="c1"))
    async def h(x):  # pragma: no cover
        pass

    assert primitives._broker_streams(b) == [("orders", "workers")]


def test_noop_without_provider():
    manual.use_provider(None)
    with agentglow.session("x") as s:
        s.turn("user")
        agentglow.progress(0.5)
    with agentglow.pool("noop", 1).lease():
        agentglow.cache("c")


def test_native_websocket_server_span_is_an_entry_without_a_request():
    """FastAPI's native WS span carries no route / method at start: still the service's entry, never a request."""
    m, t = Mapper(), int(time.time() * 1000)
    ws = {"trace_id": "a" * 32, "span_id": "w1", "parent_span_id": None, "name": "WS", "start_time_ms": t, "end_time_ms": None,
          "status": "unset", "kind": "server", "service": "chat-api", "attributes": {"network.protocol.name": "websocket", "url.scheme": "ws"}}
    ses = {"trace_id": "a" * 32, "span_id": "s1", "parent_span_id": "w1", "name": "session /ws", "start_time_ms": t + 1, "end_time_ms": None,
           "status": "unset", "kind": "internal", "service": "chat-api",
           "attributes": {"agentglow.agent": "/ws", "agentglow.session": "/ws", "agentglow.session.kind": "ws"}}
    evs = m.feed("start", ws) + m.feed("start", ses)
    evs += m.feed("end", {**ses, "end_time_ms": t + 5000}) + m.feed("end", {**ws, "end_time_ms": t + 5001, "name": "WS /ws"})
    assert of(evs, "spawn", agent="/ws")[0]["parent_id"] == "svc:chat-api"
    assert not of(evs, "request") and [r["run_id"] for r in of(evs, "run")] == ["services"]


# ---------------------------------------------------------------------------------------------- named resource groups
def test_default_group_is_backend_without_kind(cap, monkeypatch):
    monkeypatch.delenv("AGENTGLOW_RESOURCE_GROUP", raising=False)
    with request(cap):
        with agentglow.inference("lightgbm-payment-integrity", units=1, unit="claims"):
            pass
    evs, _ = feed(cap)
    reg = of(evs, "mcp_register")[0]
    assert reg["server"] == "backend" and "kind" not in reg
    assert {e["server"] for e in of(evs, "mcp")} == {"backend"}


def test_inference_group_param_names_the_group_and_marks_it_model(cap, monkeypatch):
    monkeypatch.delenv("AGENTGLOW_RESOURCE_GROUP", raising=False)
    with request(cap):
        with agentglow.inference("lightgbm-payment-integrity", units=3, unit="claims", group="payment-integrity scorer"):
            pass
    sp = [s for k, s in cap.items if k == "end" and s["name"].startswith("inference")][0]
    assert sp["attributes"]["agentglow.resource.group"] == "payment-integrity scorer"
    evs, m = feed(cap)
    reg = of(evs, "mcp_register")[0]
    assert (reg["server"], reg["kind"], reg["resources"]) == ("payment-integrity scorer", "model",
                                                             [{"name": "lightgbm-payment-integrity", "kind": "model"}])
    calls = of(evs, "mcp", resource="lightgbm-payment-integrity")
    assert calls and {e["server"] for e in calls} == {"payment-integrity scorer"}
    st = of(m.prims.tick(10**13), "resource_stats")[0]
    assert st["server"] == "payment-integrity scorer" and st["units"] == 3


def test_env_and_watch_default_group_and_mixed_kind(cap, monkeypatch):
    monkeypatch.setenv("AGENTGLOW_RESOURCE_GROUP", "scoring")
    try:
        with request(cap):
            with agentglow.inference("m1"):
                pass
            agentglow.cache("features", hit=True)
            primitives.resource_group("other")
            with agentglow.inference("m2"):
                pass
    finally:
        primitives.resource_group(None)
    evs, _ = feed(cap)
    regs = of(evs, "mcp_register")
    assert [(r["server"], r.get("kind")) for r in regs] == [("scoring", "model"), ("scoring", "mcp"), ("other", "model")]


def test_flat_group_field_and_topology_kind():
    c = TestClient(create_app())
    body = [{"service": "risk", "event": "inference", "model": "lgbm", "duration_ms": 12, "group": "payment-integrity scorer"},
            {"service": "risk", "event": "cache", "name": "feat", "hit": True}]
    assert c.post("/v1/events", json=body).json()["n"] == 2
    hub = c.app.state.hub
    assert hub.topology["payment-integrity scorer"]["kind"] == "model"
    assert "kind" not in hub.topology["backend"]
    assert {e["server"] for e in of(list(hub.buffer), "mcp", resource="lgbm")} == {"payment-integrity scorer"}


# ---------------------------------------------------------------------------------------------- resource call outcome
def test_backend_http_call_result_carries_status_and_error(cap):
    with request(cap):
        with cap.tracer.start_as_current_span("GET", kind=trace.SpanKind.CLIENT, attributes={
                "http.request.method": "GET", "server.address": "payments", "server.port": 9100,
                "url.full": "http://payments:9100/charges/123", "http.response.status_code": 503}):
            pass
    evs, _ = feed(cap)
    res = of(evs, "mcp", phase="result")[0]
    assert res["server"] == "backend" and res["resource"] == "payments:9100"
    assert res["status"] == 503 and res["error"] is True and "123" not in str(res)


def test_flat_call_status_and_inference_error(cap):
    c = TestClient(create_app())
    body = [{"service": "api", "event": "call", "to": "vendor", "kind": "api", "name": "POST", "status": 502, "duration_ms": 30},
            {"service": "api", "event": "call", "to": "pg", "kind": "db", "name": "SELECT", "duration_ms": 4}]
    assert c.post("/v1/events", json=body).json()["n"] == 2
    evs = list(c.app.state.hub.buffer)
    v = of(evs, "mcp", resource="vendor", phase="result")[0]
    assert v["status"] == 502 and v["error"] is True
    assert "error" not in of(evs, "mcp", resource="pg", phase="result")[0]
    with request(cap):
        with pytest.raises(RuntimeError):
            with agentglow.inference("scorer"):
                raise RuntimeError("boom")
    evs, _ = feed(cap)
    assert of(evs, "mcp", resource="scorer", phase="result")[0]["error"] is True


def test_job_under_nests_under_agent_and_falls_back_when_unknown(cap):
    m = Mapper()
    with request(cap):
        with agentglow.agent("researcher") as a:
            agentglow.job("o-9", kind="fulfil", state="queued", under=a)
            sid = format(a.span.get_span_context().span_id, "016x")
        agentglow.job("o-10", kind="fulfil", state="queued", under="nope")
    evs, _ = feed(cap, m)
    sp = of(evs, "spawn", id="job:o-9")[0]
    assert sp["parent_id"] == sid and sp["job"] is True and sp["since"] == sp["ts"]  # since: live elapsed label, not NaN
    assert of(evs, "spawn", id="job:o-10")[0]["parent_id"] == "svc:api"
