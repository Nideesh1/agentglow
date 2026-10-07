# Generic primitives

Small building blocks for what a trace alone does not say. Each is one Python call exported from `agentglow`, a plain
OTel span (no SDK provider = no-op), and has a `/v1/events` flat form (events-http.md). They carry numbers, ids and
short labels only (labels capped at 40 chars, secrets redacted): never put content or personal data in them.

A primitive belongs to the nearest node of its context: a session, a job, an agent, or the service of the request it
runs in. With no parent span (start-up code, a sampler thread) it belongs to the process's service. So call them
inside the request / handler / job / session they describe, in a process that ran `agentglow.watch(...)`.

## Cheat sheet

| Primitive | Python | Use it when | In the scene |
|---|---|---|---|
| session | `with agentglow.session("support chat", kind="ws") as s:` | a long-lived connection / call / stream / chat | a live node with a timer, turns and gauges, ending with its outcome |
| stage | `with agentglow.stage("decode"):` | named phases of a job / request / session | `decode` on the owner's status line; several open = parallel (`pick + pack`) |
| progress | `agentglow.progress(3, 10)` / `progress(0.3, eta_s=None, label=None)` | you know how far along it is | a progress arc with an ETA |
| capacity | `agentglow.capacity("slots", used=3, max=4)` | admission limits, concurrency slots | `cap 3/4` gauge |
| rejected | `agentglow.rejected("busy", retry_after=2, status=503)` | work turned away on purpose (429 / 503) | amber flash; the request is not counted as an error |
| pool / lease | `p = agentglow.pool("whisper", size=2, kind="gpu", devices=["gpu0", "gpu1"])`; `async with p.lease() as inst:` | model replicas, GPUs, worker slots | a resource node `2/2 busy · wait 12ms`; `lease()` really limits concurrency to `size` |
| inference | `with agentglow.inference("whisper-small", device=None, units=12.5, unit="audio_s", group=None, kind=None) as inf:` | model calls: classic ML (STT, TTS, embeddings, vision, scorers) or an LLM you call yourself; `kind="llm"` / `"ml"` (default: inferred from the name, gpt / claude / mistral / llama / gemini / qwen ... = llm) | a model resource with call pulses and RTF / speed; LLMs and ML models look different |
| job | `agentglow.job(order_id, kind="order", state="queued")` / `with agentglow.job(order_id, kind="order", attempt=2, max_attempts=3) as j:` | work keyed by a business id that crosses processes | ONE `job:<id>` node: queued, running, retrying #2, done, dead |
| link / complete | `agentglow.link(charge_id, label="payment")` ... later `agentglow.complete(charge_id, status="ok")` | an outbound call whose result arrives by webhook / callback | `awaiting payment` on the caller, then a green dashed callback edge |
| fallback | `agentglow.fallback(from_="inline", to="queue", reason="timeout", job=None)` | a degraded / alternative path was taken | a dashed amber edge (to the job node when `job=` is given, else to service `to`) |
| gate | `agentglow.gate("refunds", state="locked", attempts_left=2)` | PIN checks, verification, a rate gate (stateful until changed) | a lock badge `locked · 2 left` |
| backlog | `agentglow.backlog("orders", depth=42, pending=None, lag_ms=1200)` | queue depth / consumer lag | a ribbon between producer and consumer `orders 42 · lag 1.2s` |
| lifecycle | `agentglow.lifecycle("ready")` | process state: `loading`, `warming`, `ready`, `degraded`, `draining`, `restarting`, `fatal` | a tint ring on the service |
| metric | `agentglow.metric("shipped", 12, unit="orders/min")` | a business / system number | a value in the node's panel |
| event | `agentglow.event("signup", label="trial", seats=3)` | a business event worth seeing | a chip next to the node (fields: numbers / bools / short strings, max 8) |
| cache | `agentglow.cache("catalog", hit=True)` | cache lookups | a cache resource with hit rate |
| outcome | `agentglow.mark_error("vendor timeout")` / `agentglow.mark_outcome("failed", reason=None)` | a failure you caught and handled | the request still shows red |
| wait | `async with agentglow.wait("vendor reply", timeout_s=3600):` | the work is parked on something external (an event, a timer, a reply) | the step / agent shows `waiting on vendor reply` with a countdown; the run stays open |
| approval | `async with agentglow.approval(timeout_s=900, title="Refund $420", details={...}, url=..., because=d):` | a human must approve before the work goes on | "Needs you" row with Approve / Reject and a details drawer (why, details, recent context, note, Open in app, Copy link) |

Resource groups: pools, models and caches hang off one shared group labelled "Backend". Name it with
`group="payment-integrity scorer"` on `pool()` / `inference()` / `cache()`, or per process with
`agentglow.watch(..., resource_group="...")` / `agentglow.resource_group("...")` / env `AGENTGLOW_RESOURCE_GROUP`. A group
holding only models is drawn as a model hub labelled "ML · <name>" (classic ML), "LLM · <name>" (only LLMs) or
"Models · <name>" (both); mixed groups "MCP · <name>". Services' `db.system` calls get their own database node
("Database · elasticsearch") with the collections as satellites.

Click any MCP server, resource (satellite) or agent -> server link in the scene for its Resource details panel: calls,
errors, p50 / p95, rate, top callers, recent calls, a traffic sparkline, plus per kind: tools (MCP), operation mix (DB),
hit ratio (cache), publish / consume (queue), method + status mix (HTTP host), units (model), capacity / waiters (pool).

Pool kinds: `model`, `gpu`, `worker` (default). `agentglow.pool(name, ...)` returns the same process-wide pool on
later calls. Lease objects have `.index` and `.device`. Sync `with p.lease():` works too.

## Decorators

Every `with` primitive above (and `agent`, `tool`, `decision`, `run`, `llm`, `mcp`, `skill`, `graph`) is also a
decorator with the same signature: sync / async functions, sync / async generators, methods. A fresh span per call.
Arguments and return values are never recorded; values only flow in through explicit callables that receive the call's
arguments as keywords (a failing callable is logged once and skipped, never breaks the call). Exceptions mark the span
failed and re-raise.

```python
@agentglow.job(id=lambda order_id, **_: order_id, kind="fulfil", max_attempts=3,
               attempt=lambda attempt=1, **_: attempt)       # return -> done, raise -> retrying / dead / failed
async def fulfil(order_id: str, attempt: int = 1): ...

@agentglow.stage("pick")            # or @agentglow.stage (name = function name)
@agentglow.traced                   # a step of the caller (agent / request / job), drawn like a stage, no new agent
@agentglow.session(kind="ws", id=lambda conn_id, **_: conn_id)
@agentglow.inference("whisper-small", units=lambda audio, **_: len(audio) / 16000, unit="audio_s")
@gpu.lease()                        # gpu = agentglow.pool("whisper", size=2, kind="gpu")
@agentglow.agent("planner") / @agentglow.tool("lookup")   # @traced_agent / @traced_tool still work

@agentglow.decision("noul", "safe without human?", purpose="guard", provider="jev")
def safe(order) -> tuple[bool, float]: ...   # return: bool -> yes/no; (result, p); {"result","p","options"}; else str()
```

`@agentglow.wait(...)` / `@agentglow.approval(...)` work the same (`title=` / `details=` / `url=` may be callables).

FastAPI / FastStream: put agentglow decorators BELOW the framework decorator (`@app.post(...)` or
`@broker.subscriber(...)` on top), so the framework registers the instrumented function; the signature is preserved.

## Details

**session.** `agentglow.session(name, kind="session", id=None, parent=None, parent_link=True)`; `s.turn(role="user",
**numbers)` (`ms=`, `tokens=`, `audio_s=`), `s.progress(**gauges)` (numbers only, e.g. `audio_s=12.5, turns=4`),
`s.end(outcome="resolved", reason=None)` (or just leave the block). Manual agents started inside a session are its
subagents. A session in a detached task: capture the spawning request's context first:
```python
ctx = agentglow.capture()                 # inside the request
async def later():
    with agentglow.session("call", kind="voice", parent=ctx): ...
```
`parent_link=False` = no parent at all (the node hangs off the service).

**WebSockets.** With `watch(app=app)` every FastAPI / Starlette WebSocket route is a session automatically (named
after the route template, frames counted as `frames_in` / `frames_out`, close reason `client_disconnect` /
`server_close`). Without `watch(app=)`: `async with agentglow.session_ws(websocket, name=None, kind="ws") as s:` in the
handler. Inside, `agentglow.current_agent()` returns the session (for `s.turn()`, `s.progress()`).

**job.** `job(id, ...)` with `state=` records that state now from any process (API: `queued`); `with job(id, ...)`
wraps one attempt (`running`, then `done`, or on an exception `retrying` while `attempt < max_attempts`, `dead` at the
last attempt, else `failed`; `j.state("retrying")` overrides). States: `queued`, `running`, `retrying`, `done`,
`failed`, `dead`. Stages, progress and leases inside the job block belong to the job node. A different service
reporting the same id draws a comet from that service to the job.

**backlog sampler.** `watch(broker=broker, backlog=True)` (or seconds) starts a daemon thread that runs `XLEN` /
`XPENDING` on the broker's subscribed Redis streams. Directly: `agentglow.sample_backlog(broker_or_redis_or_url,
streams=None, every_s=3.0)` (`streams`: names or `(name, group)` pairs). Returns False when redis-py is missing.

**wait / approval.** `wait(reason, until=None, timeout_s=None, *, title=None, details=None, url=None, because=None)`;
`approval(reason="human approval", timeout_s=None, until=None, *, title=, details=, url=, because=)` is a wait with
`kind="approval"` (listed under "Needs you"). `until`: epoch ms / s, datetime or ISO-8601 (else now + `timeout_s`).
`details`: flat `{key: str|int|float|bool}`, max 12, kept in strict privacy mode (you pass them on purpose: no PII).
`url`: http(s) "Open in app" link (path kept as given). `because`: the object `decided(...)` / `decision(...)`
returned (an approval without it links its agent's guard decision of the last 30 s). Both only SHOW the wait: resuming
is the app's job (recipes.md "Human in the loop").

**rate limits.** The server keeps the scene calm: metric and backlog at most one per 500 ms per owner and name,
capacity one per 250 ms (unless it hits or leaves max), progress one per 200 ms, session gauges one per second.

## OTel contract (any language)

Long-lived primitives are spans with attributes set at start: `session <name>` (`agentglow.session`,
`agentglow.agent`, `agentglow.session.kind`, `.session.id`; at end `.session.outcome`, `.session.reason`),
`stage <name>` (`agentglow.stage`), `lease <pool>` (`agentglow.pool`, `.pool.kind`, `.pool.size`, `.pool.device`,
`.pool.wait_ms`), `inference <model>` (`agentglow.inference.model`, `.device`, `.units`, `.unit`, `.kind`), `job <kind>`
(`agentglow.job.id`, `.job.kind`, `.job.state`, `.job.attempt`). Point primitives are finished-at-once spans with
`agentglow.signal` = the name (`progress`, `capacity`, `rejected`, `job`, `link`, `complete`, `fallback`, `gate`,
`backlog`, `lifecycle`, `metric`, `cache`, `gauge`, `turn`) and `agentglow.<signal>.<field>` attributes, e.g.
`agentglow.signal=capacity`, `agentglow.capacity.name`, `agentglow.capacity.used`, `agentglow.capacity.max`. Business
events: span `event <kind>` with `agentglow.event`, `agentglow.event.label`, `agentglow.event.<field>`. Full table:
docs/SPEC.md "Generic primitives".
