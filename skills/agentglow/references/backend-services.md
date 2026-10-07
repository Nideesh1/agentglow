# Backend services (FastAPI, FastStream, FastMCP, anything on OTel)

Each service becomes one long-lived node with a halo (`42 req/s · 2% errors`, `×3` for replicas; latency on hover and in the Selected panel). Requests
pulse it, background tasks and agents inside a request are its subagents, DB / cache / HTTP calls are resource nodes,
publish -> consume is a comet labelled with the topic (a failed publish fizzles), WebSocket connections are sessions,
and a request still open after 3 s becomes a job node with a running timer. Pure agent traces look exactly as before.

## Install

```bash
uv add "agentglow[fastapi,faststream,redis,mcp]"     # pick what the process uses
```

| Extra | Instruments |
|---|---|
| `fastapi` | FastAPI / Starlette server spans + httpx and requests clients |
| `faststream` | FastStream `TelemetryMiddleware` (`faststream[otel]`): Redis, Kafka, Confluent, RabbitMQ, NATS |
| `redis` / `postgres` / `mongodb` | redis-py, asyncpg, pymongo client spans |
| `mcp` | FastMCP servers (`watch(mcp=)`) and MCP trace-context propagation |

## One line per process

```python
app = FastAPI(title="orders-api")
agentglow.watch(app=app)                                         # service name = the FastAPI title (else "api")

broker = RedisBroker(REDIS_URL)
agentglow.watch(broker=broker, service_name="orders-worker", backlog=True)   # backlog: sample Redis Streams depth / lag

agentglow.watch(app=app, broker=broker, service_name="webhooks")  # both in one process

mcp = FastMCP("market-data")
agentglow.watch(mcp=mcp)                                         # one span per tool call; its DB / HTTP calls = its backends
```

Call it right after creating the app / broker and before it starts serving (`watch(app=)` adds an ASGI middleware for
WebSocket sessions). `app=` takes one app or a list; sub-apps mounted with `app.mount("/api", api)` are covered by the
outer app (one span per request, full route template `GET /api/patients/{pid}`). With any of `app` / `broker` / `mcp`,
installed httpx / requests / redis / asyncpg / pymongo instrumentations are turned on too.

## `watch()` arguments

| Argument | Default | |
|---|---|---|
| `url` | `$AGENTGLOW_URL` or `http://localhost:8100` | the server |
| `service_name` | `OTEL_SERVICE_NAME`, the FastMCP name, the FastAPI title, else `api` / `worker` | the node's name |
| `api_key` | `$AGENTGLOW_API_KEY` | ingest key (`x-api-key`) |
| `app` / `broker` / `mcp` | | backend mode (any of them) |
| `privacy` | `"strict"` | `"standard"` exports spans unchanged (server backstop still runs). See privacy.md |
| `allow` | `()` | extra attribute keys to keep in strict mode (fnmatch, e.g. `["tenant.tier", "app.*"]`) |
| `allow_message_keys` | `()` | message fields to keep (e.g. `["attempt"]`) |
| `error_messages` | `False` | keep exception messages (scrubbed, max 120 chars) |
| `scrub` | `None` | `fn(attrs) -> attrs`, your own last pass on every exported span |
| `pii_patterns` | `agentglow.scrub.PII_PATTERNS` | replace the PII list: `[(re.compile(...), replacement), ...]` (compiled patterns) |
| `ignore` | `None` | route / span name / client-call patterns never exported, with their children: `["GET /v1/models", "/internal/*", "XREAD*"]`. Added to the defaults (health / readiness / liveness routes, blocking Redis reads) |
| `ignore_defaults` | `True` | `False` drops the default ignores |
| `propagate` | on in backend mode | `ThreadPoolExecutor.submit` / `run_in_executor` / `asyncio.to_thread` keep the OTel context, so thread work stays under its request |
| `backlog` | `False` | `True` or seconds: sample the broker's Redis Streams (`XLEN`, `XPENDING`) every 3 s |
| `instrument` | `True` | also the agent-framework instrumentations (python-agents.md) |

## Outcomes without exceptions

```python
try:
    charge()
except PaymentError:
    agentglow.mark_error("payment declined")      # the request shows red although nothing raised
agentglow.mark_outcome("ok")                      # ok / success / done = OK; any other label = ERROR
```
Both set `agentglow.outcome` (+ `.reason`) on the current span and its request / message / job span; they return
False when no span is recording.

## Replicas

Each process reports `service.instance.id` (env `OTEL_RESOURCE_ATTRIBUTES=service.instance.id=...`, else
`<hostname>-<pid>`). All replicas of a `service.name` collapse into one node with `×N`.

## Long requests -> job nodes

A request (HTTP or a consumed message) still open `AGENTGLOW_JOB_MS` (default 3000) after it started becomes a
`req:<span id>` job node ringing its service with a running timer (`orders · 27s`); calls inside it are owned by the
job; the Selected panel and the halo tooltip count `N in flight`. These are server env vars (set on `agentglow serve`):

| Env | Default | |
|---|---|---|
| `AGENTGLOW_JOB_MS` | 3000 | open this long = job node |
| `AGENTGLOW_SERVICE_MAX_JOBS` | 8 | live job nodes per service (more are only counted) |
| `AGENTGLOW_JOB_STALE_MS` | 3600000 | an open request never ended is forgotten |
| `AGENTGLOW_SERVICE_HV_RATE` | 5 | requests/s per service still sent individually; above it only aggregated stats + errors |
| `AGENTGLOW_SERVICE_CAP` | 20 | individual request events/s over all services |
| `AGENTGLOW_SERVICE_MAX_TASKS` | 6 | live task subagents per service |
| `AGENTGLOW_SERVICE_IDLE_MS` | 3600000 | idle service exits (back on its next request) |
| `AGENTGLOW_SERVICE_INSTANCE_MS` | 60000 | a replica counts while seen this recently |
| `AGENTGLOW_JOB_MAX_NODES` | 12 | live `agentglow.job(id)` nodes (primitives) |

A request that holds an `agentglow.job(id)` or a session is drawn by that node instead (never also a `req:` node).

## Other languages / your own OTel setup

Any OTel SDK can send OTLP/HTTP to `http://<server>:8100/v1/traces` (ended spans only). What makes a span a backend
span: resource `service.name` (or attribute `agentglow.service`); a SERVER span with `http.request.method` /
`http.route` (or `rpc.system`) = a request; a CONSUMER span with `messaging.system` = a consumed message; a PRODUCER
span inside a request = a publish; CLIENT spans with `server.address` = resources of the `backend` group; CLIENT spans
with `db.system` = a database node per system ("Database · postgresql") with `db.collection.name` (else `db.namespace`)
as its collections. Node: node.md.
Without OTel: events-http.md.

Working example: `examples/fastapi-faststream/` (FastAPI API, webhooks, FastStream worker on a Redis stream, FastMCP
server, a support agent; every primitive; no LLM key).
