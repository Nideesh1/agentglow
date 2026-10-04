"""`agentglow serve`: OTel spans in (live JSON + OTLP/HTTP), world events out (SSE), 3D UI served from static/."""
from __future__ import annotations

import asyncio
import contextlib
import gzip
import hmac
import json
import os
import time
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import __version__
from .auth import TokenError, verify_token
from .state import Filter, Hub

STATIC = Path(__file__).parent / "static"
KEEPALIVE_S = 15.0


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------------- OTLP decoding
def sse(ev: dict, eid: str | None = None) -> str:
    """One SSE message; buffered events carry `id: <epoch>-<seq>` so a reconnect sends it back as Last-Event-ID."""
    return (f"id: {eid}\n" if eid else "") + f"data: {json.dumps(ev)}\n\n"


def _any_value(v) -> object:  # protobuf AnyValue → python
    which = v.WhichOneof("value")
    if which == "array_value":
        return [_any_value(x) for x in v.array_value.values]
    if which == "kvlist_value":
        return json.dumps({kv.key: _any_value(kv.value) for kv in v.kvlist_value.values}, default=str)
    if which == "bytes_value":
        return v.bytes_value.hex()
    return getattr(v, which) if which else None


def otlp_proto_spans(body: bytes) -> list[dict]:
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

    req = ExportTraceServiceRequest()
    req.ParseFromString(body)
    out = []
    for rs in req.resource_spans:
        service = next((_any_value(kv.value) for kv in rs.resource.attributes if kv.key == "service.name"), None)
        instance = next((_any_value(kv.value) for kv in rs.resource.attributes if kv.key == "service.instance.id"), None)
        for ss in rs.scope_spans:
            for sp in ss.spans:
                out.append(_extra({
                    "trace_id": sp.trace_id.hex(),
                    "span_id": sp.span_id.hex(),
                    "parent_span_id": sp.parent_span_id.hex() or None,
                    "name": sp.name,
                    "start_time_ms": sp.start_time_unix_nano // 1_000_000,
                    "end_time_ms": sp.end_time_unix_nano // 1_000_000 or None,
                    "status": {1: "ok", 2: "error"}.get(sp.status.code, "unset"),
                    "attributes": {kv.key: _any_value(kv.value) for kv in sp.attributes},
                }, sp.kind, service, [(lk.trace_id.hex(), lk.span_id.hex()) for lk in sp.links], instance))
    return out


SPAN_KINDS = {1: "internal", 2: "server", 3: "client", 4: "producer", 5: "consumer"}


def _extra(span: dict, kind, service, links: list[tuple], instance=None) -> dict:
    """Backend services fields (docs/SPEC.md "Backend services"): kind, resource service.name / service.instance.id,
    links; only when set."""
    if isinstance(kind, str):
        kind = {f"SPAN_KIND_{v.upper()}": k for k, v in SPAN_KINDS.items()}.get(kind, 0)
    if SPAN_KINDS.get(int(kind or 0)):
        span["kind"] = SPAN_KINDS[int(kind)]
    if service:
        span["service"] = str(service)
    if instance:
        span["instance"] = str(instance)
    links = [{"trace_id": t, "span_id": s} for t, s in links if s]
    if links:
        span["links"] = links
    return span


def _json_value(v: dict) -> object:  # OTLP/JSON AnyValue → python
    if not isinstance(v, dict) or not v:
        return None
    k, x = next(iter(v.items()))
    if k == "intValue":
        return int(x)
    if k == "doubleValue":
        return float(x)
    if k == "arrayValue":
        return [_json_value(i) for i in x.get("values", [])]
    if k == "kvlistValue":
        return json.dumps({i["key"]: _json_value(i.get("value", {})) for i in x.get("values", [])}, default=str)
    return x


def _id(x: str | None) -> str | None:
    if not x:
        return None
    if len(x) in (16, 32) and all(c in "0123456789abcdefABCDEF" for c in x):
        return x.lower()
    import base64  # some exporters send ids base64-encoded (protobuf JSON mapping)

    return base64.b64decode(x).hex()


def otlp_json_spans(data: dict) -> list[dict]:
    out = []
    for rs in data.get("resourceSpans", []):
        res = (rs.get("resource") or {}).get("attributes", [])
        service = next((_json_value(a.get("value", {})) for a in res if a.get("key") == "service.name"), None)
        instance = next((_json_value(a.get("value", {})) for a in res if a.get("key") == "service.instance.id"), None)
        for ss in rs.get("scopeSpans", []):
            for sp in ss.get("spans", []):
                code = (sp.get("status") or {}).get("code", 0)
                code = {"STATUS_CODE_OK": 1, "STATUS_CODE_ERROR": 2}.get(code, code)
                out.append(_extra({
                    "trace_id": _id(sp.get("traceId")),
                    "span_id": _id(sp.get("spanId")),
                    "parent_span_id": _id(sp.get("parentSpanId")),
                    "name": sp.get("name", "span"),
                    "start_time_ms": int(sp.get("startTimeUnixNano", 0)) // 1_000_000,
                    "end_time_ms": int(sp.get("endTimeUnixNano", 0)) // 1_000_000 or None,
                    "status": {1: "ok", 2: "error"}.get(int(code or 0), "unset"),
                    "attributes": {a["key"]: _json_value(a.get("value", {})) for a in sp.get("attributes", [])},
                }, sp.get("kind", 0), service, [(_id(lk.get("traceId")), _id(lk.get("spanId"))) for lk in sp.get("links", [])], instance))
    return out


# ---------------------------------------------------------------------- optional FalkorDB graph sample
def falkor_sample(url: str, limit: int = 220) -> dict:
    from falkordb import FalkorDB

    u = urlparse(url if "://" in url else f"redis://{url}")
    graph = (u.path or "/").strip("/") or os.environ.get("AGENTGLOW_FALKOR_GRAPH", "demo")
    g = FalkorDB(host=u.hostname or "localhost", port=u.port or 6379, password=u.password).select_graph(graph)
    q = "MATCH (n) RETURN id(n), coalesce(n.name, n.id, toString(id(n))), coalesce(n.kind, labels(n)[0]) LIMIT $l"
    rows = g.query(q, {"l": limit}).result_set
    ids = {r[0]: str(r[1]) for r in rows}
    nodes = [{"id": str(r[1]), "name": str(r[1]), "kind": str(r[2] or "Node")} for r in rows]
    lq = "MATCH (a)-[]->(b) WHERE id(a) IN $ids AND id(b) IN $ids RETURN id(a), id(b) LIMIT 800"
    links = [{"source": ids[a], "target": ids[b]} for a, b in g.query(lq, {"ids": list(ids)}).result_set]
    return {"nodes": nodes, "links": links}


# ---------------------------------------------------------------------- ingest auth
def parse_ingest_keys(keys: str | list[str] | tuple[str, ...] | None) -> tuple[bytes, ...]:
    """Comma-separated string (or list) of ingest keys -> non-empty keys as bytes. Several keys = rotation."""
    if not keys:
        return ()
    parts = keys.split(",") if isinstance(keys, str) else [p for k in keys for p in str(k).split(",")]
    return tuple(p.strip().encode() for p in parts if p.strip())


def ingest_key_ok(keys: tuple[bytes, ...], request: Request) -> bool:
    """True when no keys are configured, or the request carries one of them in `x-api-key` (preferred) or
    `Authorization: Bearer <key>`. Constant-time compare against every key; never read from the query string."""
    if not keys:
        return True
    sent = request.headers.get("x-api-key") or ""
    if not sent:
        auth = request.headers.get("authorization") or ""
        sent = auth[7:] if auth.lower().startswith("bearer ") else ""
    sent_b = sent.strip().encode()
    ok = False
    for k in keys:  # no early exit: timing does not reveal which key matched
        ok |= hmac.compare_digest(sent_b, k)
    return bool(sent_b) and ok


# ---------------------------------------------------------------------- app
def create_app(*, falkor_url: str | None = None, hub: Hub | None = None, run_webhook: str | None = None,
               run_transport=None, approve_webhook: str | None = None, secret: str | None = None, ingest_key: str | list[str] | None = None,
               capture_prompts: bool = False, run_idle_min: float | None = None) -> FastAPI:
    """`run_webhook` (or AGENTGLOW_RUN_WEBHOOK): URL that POST /live/run forwards `{topic, scope?}` to (your trigger
    endpoint); the UI shows "Run agents" only when it is set. GET /live/run proxies `GET <webhook>` for an optional
    `{workflows: [{id, label, topic}]}` listing (the UI's workflow picker). `run_transport` is an optional httpx transport (tests).
    `approve_webhook` (or AGENTGLOW_APPROVE_WEBHOOK): URL that POST /live/approve forwards a human's approve / reject of
    an open wait to (the HUD's Approve / Reject buttons, shown only when it is set). Same transport as the run webhook.
    `secret` (or AGENTGLOW_SECRET): viewer endpoints require `Authorization: Bearer <token>` (agentglow.make_token)
    and the token alone decides what the viewer sees. Without it (dev), X-AgentGlow-Scope / X-AgentGlow-Run headers
    (and `?run=` on /live/stream) pick the filter.
    `ingest_key` (or AGENTGLOW_INGEST_KEY; comma-separated for rotation): POST /v1/live, /v1/traces, /v1/events,
    /v1/claude-code and /live/topology require `x-api-key: <key>` (or `Authorization: Bearer <key>`), else 401. Unset (dev): open.
    `capture_prompts`: keep Claude Code user prompts (redacted, capped) as `chat` events. Never read from the env here:
    only `agentglow serve` turns it on (AGENTGLOW_CAPTURE_PROMPTS=1 with a loopback --host).
    `run_idle_min` (or AGENTGLOW_RUN_IDLE_MIN, default 30, 0 = off): an open run with no events this long that is not
    waiting (no open wait / approval / sleep, or only ones whose `until` passed) is closed as abandoned."""
    hub = hub or Hub(capture_prompts=capture_prompts,
                     run_idle_ms=None if run_idle_min is None else int(max(0.0, run_idle_min) * 60_000))
    falkor_url = falkor_url or os.environ.get("AGENTGLOW_FALKOR_URL")
    run_webhook = run_webhook or os.environ.get("AGENTGLOW_RUN_WEBHOOK") or None
    approve_webhook = approve_webhook or os.environ.get("AGENTGLOW_APPROVE_WEBHOOK") or None
    secret = secret or os.environ.get("AGENTGLOW_SECRET") or None
    ingest_keys = parse_ingest_keys(ingest_key or os.environ.get("AGENTGLOW_INGEST_KEY"))

    def require_ingest_key(request: Request) -> None:
        if not ingest_key_ok(ingest_keys, request):
            raise HTTPException(401, "missing or invalid ingest key (x-api-key)")

    def viewer(request: Request, *, required: bool = True) -> Filter | None:
        """Filter for a viewer request. Secure mode: from the Bearer token only (401 missing/invalid/expired; 403
        when a scope/run header or ?run= contradicts it; they may only narrow an unrestricted dimension).
        Returns None when `required` is False and no token was sent (health liveness probe)."""
        h_scope = request.headers.get("x-agentglow-scope") or None
        h_run = request.headers.get("x-agentglow-run") or request.query_params.get("run") or None
        if not secret:
            return Filter(h_scope, h_run)
        auth = request.headers.get("authorization") or ""
        if not auth.lower().startswith("bearer "):
            if not required:
                return None
            raise HTTPException(401, "missing bearer token", headers={"WWW-Authenticate": "Bearer"})
        try:
            t = verify_token(secret, auth[7:])
        except TokenError as e:
            raise HTTPException(401, f"invalid token: {e}", headers={"WWW-Authenticate": "Bearer"})
        if (t["scope"] and h_scope and h_scope != t["scope"]) or (t["run"] and h_run and h_run != t["run"]):
            raise HTTPException(403, "requested scope/run is outside the token")
        return Filter(t["scope"] or h_scope, t["run"] or h_run)

    def ingest_scope(request: Request) -> str | None:
        """Ingestion-side scope for spans that carry none: `?scope=` or X-AgentGlow-Scope on the ingest endpoints."""
        return request.query_params.get("scope") or request.headers.get("x-agentglow-scope") or None

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        async def ticker():  # completes idle Hatchet runs (no span marks a whole workflow run's end)
            while True:
                await asyncio.sleep(1)
                hub.tick(now_ms())  # also ends idle Claude Code sessions' dangling spans and abandoned runs (every 60 s)

        task = asyncio.create_task(ticker())
        yield
        task.cancel()

    app = FastAPI(title="agentglow", version=__version__, lifespan=lifespan)
    app.state.hub = hub
    app.state.claude_code = hub.claude_code
    # allow_headers="*" echoes the preflight's requested headers, so Authorization, X-AgentGlow-Scope and
    # X-AgentGlow-Run are allowed (no credentials/cookies are used: the token travels in the Authorization header)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    async def body_of(request: Request) -> bytes:
        body = await request.body()
        return gzip.decompress(body) if request.headers.get("content-encoding") == "gzip" else body

    @app.post("/v1/live")
    async def live(request: Request):
        require_ingest_key(request)
        items = json.loads(await body_of(request) or b"[]")
        return {"ok": True, "n": hub.ingest_live(items if isinstance(items, list) else [items], ingest_scope(request))}

    @app.post("/v1/events")
    async def events(request: Request):
        """Flat events from anything that can POST JSON (no OTel needed): one object or an array of
        `{"service"|"agent", "event": "request"|"message"|"call"|"error"|"llm"|"tool"|..., "name", "status",
        "duration_ms", "to"?, "topic"?, "tokens_in"?, "tokens_out"?}`. Ids and timing are the server's (now).
        Same ingest key, scope (`?scope=` / X-AgentGlow-Scope, or `scope` per event) and scrub as /v1/live."""
        require_ingest_key(request)
        try:
            items = json.loads(await body_of(request) or b"[]")
        except ValueError as e:
            raise HTTPException(400, f"bad JSON: {e}")
        items = items if isinstance(items, list) else [items]
        return {"ok": True, "n": hub.ingest_events(items[:5000], now_ms(), ingest_scope(request))}

    @app.post("/v1/claude-code")
    async def claude_code_hook(request: Request):
        """Claude Code `"type": "http"` hook target (examples/claude-code/). Always 200 with `{}` (= no decision), so a
        bad payload or an unknown event never affects the Claude Code session. A missing/wrong ingest key is a quick
        401 (Claude Code treats non-2xx as a non-blocking error and carries on)."""
        if not ingest_key_ok(ingest_keys, request):
            return JSONResponse({"detail": "missing or invalid ingest key (x-api-key)"}, status_code=401)
        try:
            hub.ingest_hook(json.loads(await body_of(request) or b"{}"), now_ms(), ingest_scope(request))
        except Exception:
            import logging

            logging.getLogger("agentglow").exception("agentglow: bad Claude Code hook payload")
        return JSONResponse({})

    @app.post("/v1/traces")
    async def traces(request: Request):
        require_ingest_key(request)
        body = await body_of(request)
        ctype = request.headers.get("content-type", "")
        try:
            spans = otlp_json_spans(json.loads(body)) if "json" in ctype else otlp_proto_spans(body)
        except Exception as e:
            raise HTTPException(400, f"bad OTLP payload: {e}")
        hub.ingest_ended(spans, now_ms(), ingest_scope(request))
        if "json" in ctype:
            return JSONResponse({"partialSuccess": {}})
        from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceResponse

        return Response(ExportTraceServiceResponse().SerializeToString(), media_type="application/x-protobuf")

    @app.get("/live/stream")
    async def stream(request: Request):
        """SSE over GET. Works with EventSource (dev, no headers needed) and with fetch() + a stream reader (headers)."""
        f = viewer(request)
        sub = hub.subscribe(f)
        q = sub.queue
        # a reconnect: resume after what the viewer already has
        replay = hub.replay(f, hub.resume_after(request.headers.get("last-event-id", "")))

        async def gen():
            try:
                yield "retry: 2000\n\n"
                for ev in replay:
                    yield sse(ev, hub.event_id(ev))
                while not await request.is_disconnected():
                    try:
                        ev = await asyncio.wait_for(q.get(), timeout=KEEPALIVE_S)
                        yield sse(ev, hub.event_id(ev))
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            finally:
                hub.unsubscribe(sub)

        return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.post("/live/topology")
    async def topology(body: dict, request: Request):
        require_ingest_key(request)
        if not body.get("server"):
            raise HTTPException(400, "server is required")
        res = [{"name": str(r["name"]), "kind": str(r.get("kind", "api"))} for r in body.get("resources", []) if r.get("name")]
        return hub.register_mcp(str(body["server"]), res, now_ms())

    @app.get("/live/graph")
    async def graph(request: Request):
        viewer(request)
        if not falkor_url:  # no graph DB configured: an empty graph, not an error (embeds would log a 404)
            return {"nodes": [], "links": []}
        try:
            return await asyncio.to_thread(falkor_sample, falkor_url)
        except Exception as e:
            raise HTTPException(503, f"graph provider error: {e}")

    @app.get("/live/health")
    def health(request: Request):
        base = {"ok": True, "version": __version__, "ui": (STATIC / "index.html").exists(), "run": bool(run_webhook),
                "approve": bool(approve_webhook),
                "auth": bool(secret), "ingest_auth": bool(ingest_keys), "prompts": hub.claude_code.capture_prompts}
        f = viewer(request, required=False)
        if f is None:  # secure mode without a token: liveness only
            return base
        out = {**base, **hub.counts(f)}
        if not f.empty:
            out["scope"], out["run_id"] = f.scope, f.run
        return out

    @app.get("/live/run")
    async def run_workflows(request: Request):
        """Workflows the run webhook offers (the HUD picker): proxies `GET <webhook>` → `{workflows: [{id, label, topic}]}`.
        Empty list when the webhook does not list any (the UI then shows just the button)."""
        viewer(request)
        if not run_webhook:
            raise HTTPException(404, "no run webhook (set AGENTGLOW_RUN_WEBHOOK)")
        import httpx

        try:
            async with httpx.AsyncClient(transport=run_transport, timeout=3) as c:
                r = await c.get(run_webhook)
            items = r.json().get("workflows") if r.status_code < 400 else None
        except (httpx.HTTPError, ValueError, AttributeError):
            items = None
        out = []
        for w in items if isinstance(items, list) else []:
            if isinstance(w, dict) and w.get("id"):
                wid = str(w["id"])[:64]
                out.append({"id": wid, "label": str(w.get("label") or wid)[:64], "topic": str(w.get("topic") or "")[:300]})
        return {"workflows": out[:20]}

    @app.post("/live/run")
    async def run(body: dict, request: Request):
        """Start a run of the user's agents: forwards `{topic, scope?, workflow?}` to AGENTGLOW_RUN_WEBHOOK, returns its JSON
        (e.g. `{run_id}`). Secure mode: the scope comes from the token only; dev: X-AgentGlow-Scope or body `scope`."""
        f = viewer(request)
        if secret:
            scope = f.scope
            if body.get("scope") and body["scope"] != scope:
                raise HTTPException(403, "scope is outside the token")
        else:
            scope = f.scope or (str(body["scope"]) if body.get("scope") else None)
        if not run_webhook:
            raise HTTPException(404, "no run webhook (set AGENTGLOW_RUN_WEBHOOK)")
        topic = str(body.get("topic") or "").strip()
        if not topic:
            raise HTTPException(400, "topic is required")
        workflow = str(body.get("workflow") or "").strip()[:64]  # optional: which of the webhook's workflows to run
        import httpx

        payload = {"topic": topic, **({"scope": scope} if scope else {}), **({"workflow": workflow} if workflow else {})}
        try:
            async with httpx.AsyncClient(transport=run_transport, timeout=30) as c:
                r = await c.post(run_webhook, json=payload)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"run webhook unreachable: {e}")
        if r.status_code >= 400:
            raise HTTPException(502, f"run webhook returned {r.status_code}: {r.text[:200]}")
        try:
            return r.json()
        except ValueError:
            return {"ok": True}

    @app.post("/live/approve")
    async def approve(body: dict, request: Request):
        """A human approves / rejects an open wait: `{run_id, agent_id?, step?, approve: bool, note?}` → forwarded to
        AGENTGLOW_APPROVE_WEBHOOK as `{run_id, approve, agent_id?, agent?, step?, note?, scope?, reason, workflow?,
        wait_run_id?}` (the wait's Hatchet workflow / workflow run, e.g. a child run folded into run_id). Same viewer
        auth as /live/run, and the run must be visible to the viewer (403) and have a matching open wait (409)."""
        f = viewer(request)
        if not approve_webhook:
            raise HTTPException(404, "no approve webhook (set AGENTGLOW_APPROVE_WEBHOOK)")
        run_id = str(body.get("run_id") or "").strip()
        if not run_id or not isinstance(body.get("approve"), bool):
            raise HTTPException(400, "run_id and approve (bool) are required")
        if not f.match({"run_id": run_id}, hub.scope_of):
            raise HTTPException(403, "run is outside the viewer's scope")
        agent_id = str(body.get("agent_id") or "")[:128] or None
        step = str(body.get("step") or "")[:128] or None
        wait = hub.mapper.open_wait(run_id, agent_id, step)
        if wait is None:
            raise HTTPException(409, "nothing is waiting there")
        ag = hub.mapper.agents.get(agent_id or "")
        note = str(body.get("note") or "")[:500]
        scope = hub.scope_of(run_id)
        payload = {"run_id": run_id, "approve": body["approve"], **({"agent_id": agent_id} if agent_id else {}),
                   **({"agent": ag.name} if ag else {}), **({"note": note} if note else {}),
                   **({"scope": scope} if scope else {}), **wait}
        if step and "step" not in payload:
            payload["step"] = step
        import httpx

        try:
            async with httpx.AsyncClient(transport=run_transport, timeout=30) as c:
                r = await c.post(approve_webhook, json=payload)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"approve webhook unreachable: {e}")
        if r.status_code >= 400:
            raise HTTPException(502, f"approve webhook returned {r.status_code}: {r.text[:200]}")
        try:
            return r.json()
        except ValueError:
            return {"ok": True}

    # ---- static UI with SPA fallback (/ and /<theme> → index.html)
    @app.get("/{path:path}", include_in_schema=False)
    def ui(path: str):
        f = (STATIC / path).resolve()
        if path and f.is_file() and STATIC.resolve() in f.parents:
            return FileResponse(f)
        if path.startswith(("assets/", "v1/", "live/")) or "." in path.rsplit("/", 1)[-1]:
            raise HTTPException(404)
        index = STATIC / "index.html"
        if not index.exists():
            return JSONResponse({"agentglow": __version__, "ui": "not bundled", "stream": "/live/stream"})
        return FileResponse(index, headers={"Cache-Control": "no-cache"})

    return app
