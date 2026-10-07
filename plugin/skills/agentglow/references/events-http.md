# HTTP: flat events, OTLP, auth and endpoints

## Flat events: `POST /v1/events` (no OTel)

One JSON object or an array (max 5000). Ids and timing are the server's (now). Same ingest key, scope and privacy
scrub as spans.

```bash
curl -X POST localhost:8100/v1/events -H 'content-type: application/json' -d '[
  {"service": "checkout", "event": "request", "name": "POST /pay", "status": 200, "duration_ms": 42},
  {"service": "checkout", "event": "message", "to": "mailer", "topic": "receipts"},
  {"service": "checkout", "event": "call", "to": "postgres", "kind": "db", "duration_ms": 3},
  {"service": "checkout", "event": "llm", "tokens_in": 900, "tokens_out": 120},
  {"service": "checkout", "event": "job", "job_id": "o-17", "kind": "order", "state": "retrying", "attempt": 2},
  {"service": "checkout", "event": "session", "session_id": "c-9", "phase": "start", "kind": "voice", "name": "call"},
  {"service": "checkout", "event": "rejected", "reason": "busy", "retry_after_ms": 2000},
  {"service": "checkout", "event": "backlog", "topic": "receipts", "depth": 42, "lag_ms": 1200}]'
```

| Field | |
|---|---|
| `service` (or `agent`) | required: the service / long-lived agent node |
| `event` | `request` (default), `message`, `call`, `error`, `llm`, `tool`, or a primitive: `session`, `stage`, `progress`, `capacity`, `rejected`, `job`, `link`, `complete`, `fallback`, `gate`, `backlog`, `lifecycle`, `metric`, `event`, `cache`, `lease`, `inference`. Anything else = a request named after it |
| `name` | route / operation / tool name (max 60) |
| `status` | HTTP status (>= 500 = error) or `error` / `failed` |
| `duration_ms` | latency |
| `to` | `message`: the consuming service; `call`: the external system (`redis`, `postgres`, `payments-api`) |
| `topic` | `message`: the comet label |
| `kind` | `call`: `db`, `warehouse`, `spark`, `api`, `storage`, `queue` (`db` / `warehouse`: a database node named `to`) |
| `collection` | `call` with `kind` `db` / `warehouse`: the table / index / collection (else `to`) |
| `tokens_in`, `tokens_out` | `llm` |
| `failed` | `message`: `true` = a publish that failed (the comet fizzles) |
| `scope` | the tenant / user this event belongs to |

Primitive fields: `session` (`session_id`, `phase` `start`/`progress`/`turn`/`end`, `kind`, `name`, `gauges` {},
`role`, `outcome`, `reason`), `stage` (`name`, `status` `running`/`done`/`failed`, `duration_ms`), `progress` (`frac`
or `i` + `n`, `eta_ms`, `label`), `capacity` (`name`, `used`, `max`), `rejected` (`reason`, `retry_after_ms`, `status`),
`job` (`job_id`, `kind`, `state`, `attempt`), `link` / `complete` (`ref`, `label` / `status`), `fallback` (`from`,
`to`, `reason`, `job_id`), `gate` (`name`, `state`, `attempts_left`), `backlog` (`topic`, `depth`, `pending`,
`lag_ms`), `lifecycle` (`state`), `metric` (`name`, `value`, `unit`), `event` (`kind`, `label`, other fields),
`cache` (`name`, `hit`), `lease` (`pool`, `kind`, `size`, `device`, `wait_ms`, `duration_ms`), `inference` (`model`,
`device`, `units`, `unit`, `duration_ms`). Any event with `session_id` or `job_id` lands on that session / job node.

Senders:
- Python: `agentglow.pulse(service, name="", *, event="request", url=None, api_key=None, **fields)`, e.g.
  `agentglow.pulse("billing", "invoice.paid", status=200, duration_ms=12)`. Batched from a background thread
  (~100 ms), never blocks or raises, drops when the server is down.
- JS / TS: `import { pulse } from "agentglow/pulse"`; `await pulse(url, eventOrArray, { apiKey, timeoutMs })` resolves
  `true` / `false`.

## OTLP: `POST /v1/traces`

Standard OTLP/HTTP, protobuf or JSON, from any OTel SDK or Collector (ended spans only; for live span starts use
Python `watch()`):
```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:8100/v1/traces
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf            # or http/json
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=$AGENTGLOW_API_KEY"   # only when the server has an ingest key
export OTEL_SERVICE_NAME=billing
```
Spans map by OTel GenAI / OpenInference conventions plus the optional `agentglow.*` attributes (python-agents.md,
backend-services.md, primitives.md). Already exporting to Langfuse / LangSmith / a collector? Add AgentGlow as a second
exporter or Collector pipeline; nothing else changes.

## Auth: ingest keys, viewer tokens, scopes

Open by default (local dev). For a shared or public server turn on both:

| | Server | Producers / viewers |
|---|---|---|
| ingest key (who may send) | `AGENTGLOW_INGEST_KEY=k1,k2` or `agentglow serve --ingest-key K` (comma list = rotation) | `x-api-key: K` (or `Authorization: Bearer K`): `watch(api_key=)` / `AGENTGLOW_API_KEY`, OTLP `OTEL_EXPORTER_OTLP_HEADERS`, `pulse(..., api_key=)`, Claude Code hooks read `$AGENTGLOW_API_KEY`. Missing / wrong = 401 |
| viewer tokens (who sees what) | `AGENTGLOW_SECRET` or `agentglow serve --secret S` | your backend mints `agentglow.make_token(secret, scope=None, run=None, ttl_s=3600)`; the viewer sends `Authorization: Bearer <token>` (`<AgentScene token={...} />`). No scope and no run = admin |
| scopes (each user sees only theirs) | | Python `with agentglow.scope(user_id):` / `set_scope`; any language: span attribute `agentglow.scope`; ingest `?scope=` or `X-AgentGlow-Scope` for payloads that carry none; flat events: `scope` field |

Keys and tokens travel in headers, never in URLs. Token in other languages (Node):
```js
const b64 = (b) => Buffer.from(b).toString("base64url");
const payload = b64(JSON.stringify({ scope: userId, run: null, exp: Math.floor(Date.now() / 1000) + 3600 }));
const token = payload + "." + crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
```
Bound to a non-loopback host without a secret / ingest key, `agentglow serve` logs a warning.

## Server

`agentglow serve [--host 0.0.0.0] [--port 8100] [--falkor URL] [--secret S] [--ingest-key K]` (env `AGENTGLOW_HOST`,
`AGENTGLOW_PORT`, `AGENTGLOW_FALKOR_URL`, `AGENTGLOW_SECRET`, `AGENTGLOW_INGEST_KEY`). In-memory state: run exactly one
per environment (Kubernetes: a Deployment with `replicas: 1` + a Service) and point every producer at it. Docker
image: `backend/Dockerfile`.

| Endpoint | |
|---|---|
| `POST /v1/live` | span start / end batches from Python `watch()` |
| `POST /v1/traces` | OTLP/HTTP (protobuf or JSON) |
| `POST /v1/events` | flat events |
| `POST /v1/claude-code` | Claude Code HTTP hooks |
| `POST /live/topology` | `{server, resources: [{name, kind}]}` = `register_mcp` |
| `GET /live/stream` | SSE world events (what the UI reads) |
| `GET /live/health` | `{ok, version, ui, run, approve, auth, ingest_auth, prompts, ...}` |
| `GET /live/graph` | FalkorDB graph sample when `--falkor` is set, else an empty graph |
| `GET /live/run`, `POST /live/run` `{topic, scope?, workflow?}` | with `AGENTGLOW_RUN_WEBHOOK`: the HUD's workflow picker and "Run agents" button |
| `POST /live/approve` `{run_id, agent_id?, step?, approve, note?}` | with `AGENTGLOW_APPROVE_WEBHOOK`: the HUD's Approve / Reject on waiting agents |
| `/`, `/<theme>` | the UI (`?sim=1`, `?sim=hf`, `?hud=0`, `?source=<url>`, `?run=<id>`) |

The ingest endpoints accept gzip bodies (`content-encoding: gzip`).
