# AgentGlow - v1 spec (contract for backend, frontend, examples)

Live 3D views of agent systems, driven only by **OpenTelemetry**. Span lifecycle = agent lifecycle.

```
your agents ──agentglow.watch()──► agentglow serve (:8100) ──SSE world events──► 3D UI
  (OTel spans: start + end)              (FastAPI, Python)                   (bundled page, or <AgentScene/> via npm)
```

## User experience (the whole point - keep it this simple)
```bash
uvx agentglow serve                  # or: uv add agentglow && uv run agentglow serve  → http://localhost:8100  (gallery at /, scenes at /neural, /orbit, …)
```
```python
import agentglow
agentglow.watch()                    # before agents run; url defaults to http://localhost:8100
```
Optional React embed: `npm i agentglow` → `<AgentScene theme="neural" source="http://localhost:8100" />`.

## Repo layout
| Path | What | Published as |
|---|---|---|
| `backend/` | Python package `agentglow`: server + `watch()` + CLI. Built UI copied into `backend/agentglow/static/` | PyPI `agentglow` |
| `frontend/` | React + react-three-fiber: 7 themes + HUD. Two builds: **app** (→ backend static) and **library** (`<AgentScene/>`) | npm `agentglow` |
| `frontend/cli/` | `agentglow` CLI: Claude Code setup, server start through uv | npm `agentglow` (bin) |
| `examples/deepagents-hatchet/` | Hatchet + deepagents + MCP + FalkorDB, instrumented only via `agentglow.watch()` | - |
| `examples/*` | other stacks: fastapi-faststream, node-proxy, quickstart, langgraph, openai-agents, custom-loop, react-embed, claude-code | - |
| `plugin/`, `skills/agentglow/` | Claude Code plugin (hooks, server start, `/agentglow:open`) and the agentglow skill | git (plugin marketplace) |
| `docker-compose.yml` | agentglow (host port 8101) + example stack (Hatchet, FalkorDB; Langfuse under profile `langfuse`) | - |

## Backend (`backend/`, package `agentglow`)
- `agentglow serve [--host 0.0.0.0] [--port 8100] [--falkor URL] [--secret S] [--ingest-key K]` (env `AGENTGLOW_HOST`,
  `AGENTGLOW_PORT`, `AGENTGLOW_FALKOR_URL`, `AGENTGLOW_SECRET`, `AGENTGLOW_INGEST_KEY`) - standalone FastAPI app. Run ONE per environment
  (k8s: Deployment replicas 1 + Service). In-memory state, no Redis.
- Endpoints:
  - `POST /v1/live` - JSON batch `[{"kind":"start"|"end","span":{...}}]` from `watch()` (real-time starts).
  - `POST /v1/traces` - standard OTLP/HTTP (protobuf + JSON), ended spans from any OTel SDK/collector.
  - `POST /v1/events` - flat events (one object or an array), no OTel needed (see "Backend services" > "Flat events").
  - `POST /v1/claude-code` - Claude Code `"type": "http"` hook payloads (examples/claude-code/) → synthetic live spans.
  - `GET /live/stream` - SSE world events. On connect: replay MCP topology + events of runs still in progress. Keepalive 15s.
    Filtered per viewer by scope/run (see "Scopes & auth").
    Replay: the server keeps the last `AGENTGLOW_BUFFER` events (default 5000) plus a bounded snapshot of every open
    run's state-carrying events: its `run started` (+ latest `renamed`, `idle`, `final`, step states), per live agent its
    `spawn` and the latest of each state still open (`agent` status / waiting, a `skill` started and not ended, a
    running `stage`, `session` start + latest phase, `job`, locked `gate`, `lifecycle`, `progress`, `capacity`,
    `metric`, open `deferred`), plus live backend services and job nodes. An agent's entries are dropped on its
    `exit`, a run's on `run completed` / `failed` (an ended run's leftover buffered events are not replayed either).
    A long run (a Claude Code session open for hours, a long Hatchet run) outlives the buffer: the snapshot entries
    that already left it go first, in publish order (run start, then spawns parent before child, then states), then
    the buffered events; each event at most once. Bounds: 1000 open runs (`AGENTGLOW_SNAPSHOT_RUNS`), 2000 live
    agents in all (`AGENTGLOW_SNAPSHOT_AGENTS`), 32 state entries per agent, 64 steps per run; beyond them the
    oldest is forgotten. Pulses (llm, tool, mcp, messages, requests) and token totals are not snapshotted: a fresh
    viewer sees the current agents, then counts from now.
  - `POST /live/topology` - `{server, resources:[{name, kind}]}` → `mcp_register` (also `agentglow.register_mcp(...)`).
  - `GET /live/graph` - optional graph sample `{nodes:[{id,name,kind}],links:[{source,target}]}`; FalkorDB provider when `AGENTGLOW_FALKOR_URL`/`--falkor` set (graph name = the URL path, else `AGENTGLOW_FALKOR_GRAPH`, default `demo`), else an empty graph `{nodes: [], links: []}` → UI uses its built-in sample.
  - `GET /live/run` / `POST /live/run`, `POST /live/approve` - optional run / approve webhooks (see "Scopes & auth").
  - `GET /live/health`; static UI at `/`, `/<theme>`, assets.
  - Ingest bodies may be gzip (`content-encoding: gzip`).
- Span JSON (normalized): `{trace_id, span_id, parent_span_id, name, start_time_ms, end_time_ms|null, status: ok|error|unset, attributes:{}}`,
  plus, when known, `kind` (`internal|server|client|producer|consumer`), `service` (resource `service.name`) and `links`
  (`[{trace_id, span_id}]`): watch() and both OTLP decoders fill them; the mapper uses them only for "Backend services".
- `agentglow.watch(url=None, *, instrument=True, service_name=None, api_key=None, app=None, broker=None, mcp=None,
  privacy=None, ignore=None, ignore_defaults=None, allow=(), allow_message_keys=(), error_messages=False, scrub=None,
  pii_patterns=None, propagate=None, backlog=False)` (url: `AGENTGLOW_URL`, else `http://localhost:8100`; returns the
  TracerProvider):
  uses the existing global TracerProvider if it's an SDK provider (keeps Langfuse etc.), else creates one;
  adds `LiveSpanProcessor(url)` (on_start + on_end → background-thread batched POST to `/v1/live`, ~50 ms,
  never blocks, drops on failure); if `instrument`, enables OpenInference LangChain instrumentation (covers
  LangChain/LangGraph/deepagents), OpenInference OpenAI Agents instrumentation (extra `[openai-agents]`, added next
  to the SDK's own trace processors) and Hatchet instrumentation when those packages are installed and not
  already instrumented, and OpenInference MCP trace-context propagation when `openinference-instrumentation-mcp` is
  installed. Idempotent. Also exports `agentglow.otel.LiveSpanProcessor`, `agentglow.register_mcp`.
  `watch(app=, broker=, mcp=, service_name=)` and the privacy / noise arguments: see "Backend services".

## Scopes & auth
Show each user only their own agents. A run's **scope** is a string (user id, tenant, team) set by the app; viewers
are filtered by scope and/or run id.

**Tagging (producer side).** A run's scope = the first `agentglow.scope` (alias `agentglow.run.scope`) attribute seen
on any span of the run; later values are ignored. Ways to set it:
- Python: `with agentglow.scope("user-123"): ...` puts the scope in OTel baggage; every span started inside (nested
  spans, asyncio tasks created inside, LangChain/OpenAI Agents/Hatchet instrumentation) gets `agentglow.scope`.
  `agentglow.set_scope("user-123")` does the same without a with-block (current context/task only). Applied by
  `LiveSpanProcessor` (so `watch()` users need nothing else); add `agentglow.ScopeSpanProcessor()` before other
  exporters to tag OTLP-only setups. A child started from an explicit parent context inherits its parent's scope.
- Any language: set the span attribute `agentglow.scope`.
- Ingest endpoints (`/v1/live`, `/v1/traces`, `/v1/claude-code`): `?scope=<s>` or an `X-AgentGlow-Scope` header
  scopes spans that carry none (Claude Code hooks: `"url": "http://host:8100/v1/claude-code?scope=user-123"`).
- Scope values go through the privacy scrub like any attribute: kept, unless they look like a secret.

**Server.** The Hub keeps a bounded run → scope map; each world event gets a `scope` field once its run's scope is
known (frontends may ignore it). Each SSE subscriber carries a filter `(scope?, run?)`:
- no filter: everything (unscoped runs included), unchanged behavior;
- `scope=s`: only events of runs whose scope is `s` (runs with no scope never match), plus `mcp_register`;
- `run=r`: only run `r` (plus `mcp_register`); both: both must match.
Replay on connect uses the same filter. Events of a run emitted before its first scoped span are not sent to scoped
viewers; when the scope becomes known they are delivered to the matching scoped viewers only (from the bounded event
buffer, in order, once), so a scoped run never leaks to other scopes. Ingestion is open unless an ingest key is set
(below).

**Choosing the filter (viewer side).**
- Dev (no secret): headers `X-AgentGlow-Scope` and `X-AgentGlow-Run`; `/live/stream` also accepts `?run=<id>`
  (shareable link, not sensitive). `?scope=` and `?token=` are not accepted on viewer endpoints.
- Secure (`AGENTGLOW_SECRET` env or `agentglow serve --secret S`): `/live/stream`, `/live/graph`, `/live/run`, `/live/approve` require
  `Authorization: Bearer <token>` (401 if missing, invalid or expired; never accepted in a query param). The filter
  comes only from the token. A scope/run header or `?run=` that contradicts the token is 403; it may only narrow a
  dimension the token leaves open (an admin token plus `X-AgentGlow-Scope` = view as that scope).
  `/live/health` without a token returns liveness only (`ok, version, ui, run, approve, auth, ingest_auth, prompts`); with a token, counts for
  that filter (`buffered`, `open_runs` (agent runs; the long-lived backend `services` run is not counted), plus
  `scope`/`run_id`); a bad token is 401.
- `/live/stream` is plain `text/event-stream` over GET: works with `fetch()` + a stream reader (headers), and with
  `EventSource` in dev. CORS allows the `Authorization`, `X-AgentGlow-Scope` and `X-AgentGlow-Run` headers.
  Every buffered event carries `seq` (per server instance, increasing) and is sent with `id: <epoch>-<seq>`; a
  reconnect with `Last-Event-ID` (the app client and `EventSource` send it) replays only newer events, so llm tokens and
  calls of in-progress runs are not applied twice. An id from another epoch (server restarted) gets the full replay.
  A resume whose last id already left the buffer also gets the snapshot entries newer than that id (what it missed
  that still matters, e.g. a spawn) and the recent endings it missed (`exit`, run completed / failed; last 2000), so it
  drops agents and runs that ended meanwhile.
- `POST /live/run` `{topic, scope?, workflow?}` (optional `AGENTGLOW_RUN_WEBHOOK`; 404 without it) forwards
  `{"topic", "scope"?, "workflow"?}` to the webhook (`scope` omitted when unknown, `workflow` max 64 chars) and returns
  its JSON. `GET /live/run` proxies `GET <webhook>` → `{workflows: [{id, label, topic}]}` (max 20; empty when the
  webhook lists none): the HUD's workflow picker next to "Run agents".
  Secure: scope from the token (a different body `scope` is 403). Dev: `X-AgentGlow-Scope` header, else body `scope`.
- `POST /live/approve` `{run_id, agent_id?, step?, approve: bool, note?}` (optional `AGENTGLOW_APPROVE_WEBHOOK`; 404
  without it; health `approve: true` makes the HUD show Approve / Reject on agents waiting on a human / approval):
  the run must pass the viewer's filter (403) and have an open wait owned by `agent_id` / in `step` (409 otherwise,
  e.g. it already resolved). Forwards `{run_id, approve, agent_id?, agent?, step?, note?, scope?, reason, title?,
  workflow?, wait_run_id?}` (`note`: the human's optional note, max 500 chars; `title`: the wait's title): `workflow` / `wait_run_id` are the Hatchet workflow and workflow run of the waiting step (a child
  run folded into `run_id` keeps its own id here), so the webhook can push the event that wait listens for. The wait
  clearing shows up through the normal event stream.
- Without a secret, `agentglow serve` logs a warning when bound to a non-localhost address.

**Ingest key** (who may post spans; independent of the viewer secret).
- Server: `AGENTGLOW_INGEST_KEY` env or `agentglow serve --ingest-key K`. Comma-separated keys are all valid (rotation:
  add the new key, move producers over, drop the old one). Unset = open ingest (dev, unchanged).
- When set, `POST /v1/live`, `/v1/traces` (OTLP JSON and protobuf), `/v1/events`, `/v1/claude-code` and `/live/topology` require
  `x-api-key: <key>`; `Authorization: Bearer <key>` is also accepted for exporters that only send that. Compared in
  constant time (`hmac.compare_digest`) against every key; never accepted as a query param. Missing or wrong = 401
  (`/v1/claude-code` answers at once; Claude Code treats non-2xx as a non-blocking error and carries on).
- Producers: `agentglow.watch(url, api_key=K)` / `LiveSpanProcessor(url, api_key=K)` / `register_mcp(..., api_key=K)`,
  or env `AGENTGLOW_API_KEY` for all three; sent as `x-api-key` on every POST, never logged. OTel SDKs/Collectors:
  `OTEL_EXPORTER_OTLP_HEADERS="x-api-key=K"`. Claude Code hooks: `"headers": {"x-api-key": "$AGENTGLOW_API_KEY"}`
  plus `"allowedEnvVars": ["AGENTGLOW_API_KEY"]` (examples/claude-code).
- `/live/health` reports `ingest_auth: true|false`. Bound to a non-localhost address without an ingest key,
  `agentglow serve` logs a warning.

**Token format** (mint it in your backend, any language; `agentglow.make_token(secret, scope=None, run=None,
ttl_s=3600)` in Python):
```
token   = payload + "." + sig
payload = base64url(UTF-8 JSON {"scope": <string|null>, "run": <string|null>, "exp": <unix seconds int>})
sig     = base64url(HMAC-SHA256(key = secret as UTF-8, message = payload string as ASCII))
```
base64url is RFC 4648 section 5 with `=` padding stripped. The signature covers the encoded payload exactly as sent, so
JSON key order and spacing do not matter. `scope` null and `run` null = admin token (sees everything). Node:
```js
const b64 = (b) => Buffer.from(b).toString("base64url");
const payload = b64(JSON.stringify({ scope: userId, run: null, exp: Math.floor(Date.now() / 1000) + 3600 }));
const token = payload + "." + crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
```

## Span → world event mapping (backend `mapper.py`)
Owning agent of any span = nearest ancestor agent span. Run id = Hatchet workflow run id found on the span or
any ancestor (HatchetInstrumentor attrs), else `agentglow.run.id`, else the trace id.

| Recognized as | Rule (first match) | Emits |
|---|---|---|
| Run | first span seen for a run id | `run started` (topic: `agentglow.run.topic` or workflow/root span name); `run completed/failed` when the root span ends |
| Step | Hatchet task/step span (or `agentglow.step`) | `step running` on start, `step done/failed` on end |
| Agent | `agentglow.agent` attr; or `gen_ai.operation.name=invoke_agent`; or OpenInference kind `AGENT`; or a LangGraph agent graph span (determine the reliable signal for deepagents from REAL captured spans - e.g. the compiled graph's span name = agent `name=`, and deepagents subagents invoked under the `task` tool) | `spawn` on start (parent = owning agent; `subagent: true` when it runs under a tool span such as `task`, or carries `agentglow.subagent=true`) + delegation `message`; `exit` on end (+ result `message`) |
| OpenAI Agents SDK | OpenInference `AGENT` span with no agent above it is a candidate: an agent span below it → workflow container (the SDK trace, never spawned); an LLM/tool below it → agent. Agent spans are siblings under the container | handoff = next top-level agent gets the previous one as parent (`handoff → X`); `handoff` tool span named after the model's `transfer_to_*` call; `agent.as_tool` agent under the function span → `subagent: true`, delegation text = tool input; exit text / run `final` = agent's last LLM text |
| langgraph-supervisor | team graph whose supervisor node (`<sup>` node → `<sup>` graph) calls a `transfer_to_*` tool | ONE supervisor agent for the run (later turns alias it; exits when the team graph ends); workers (`<name>` → `call_agent` → `<name>` graph) → `subagent: true` under it, delegation text = supervisor's turn text else latest user request; supervisor `waiting` while a worker runs; `transfer_*` tools emit no `tool` event |
| LLM | OpenInference kind `LLM` or `gen_ai.operation.name ∈ {chat, text_completion, generate_content}` | `agent thinking` on start; `llm` on end - a span guessed from its parent node but ending with a non-LLM kind (react agent's RunnableSequence/call_model/should_continue) is dropped (tokens from `gen_ai.usage.input_tokens/output_tokens` or `llm.token_count.prompt/completion`; cache reads from `gen_ai.usage.cache_read_input_tokens`, `gen_ai.usage.cache_read.input_tokens` or `llm.token_count.prompt_details.cache_read`, cache writes from the matching `cache_creation` / `cache_write` keys) |
| Tool | OpenInference kind `TOOL` or `gen_ai.operation.name=execute_tool` | `tool` |
| MCP | span with `mcp.server.name` or `agentglow.mcp.server` (+ `agentglow.mcp.resource`, `agentglow.mcp.resource_kind` ∈ db,warehouse,spark,api,storage,queue) | `mcp call` (start, pending) / `mcp result` (end); auto `mcp_register` of server+resource. An MCP span whose parent span is not known yet (the MCP server's process reported before the caller's tool span) is held until the parent arrives (with the spans inside it), dropped after 10 s; it never starts a run. An MCP span naming no resource gets its backends auto-discovered: every DB / cache / HTTP CLIENT span inside it (see "Backend services") = `mcp_register` of that server + resource and an `mcp` call/result with `resource`, on the caller's agent; a manual `agentglow.mcp.resource` wins (nothing is discovered under it). `agentglow.watch(mcp=fastmcp_server)` opens such a span (`mcp <server>.<tool>`, SERVER kind) around every FastMCP tool call |
| Graph/DB | `db.system` set | `graph` read/write (`agentglow.db.op` or inferred from query text); node names from `agentglow.graph.nodes` (list or JSON string) |
| Final | `agentglow.final` attr on any span | `final` text |
| Skill | hint attribute `agentglow.skill` = skill name on any span (usually a tool span); set by the Claude Code hooks adapter for the `Skill` tool (`tool_input.skill`, e.g. `hello`, `plugin:skill`), by the traces-only path from the `claude_code.tool` span's `skill_name` (needs `OTEL_LOG_TOOL_DETAILS=1`), and by the manual `skill()` | `skill` `status: "start"` when the span starts (or at end if the attribute only arrives then), `"end"` when it ends, on the owning agent; the normal `tool` event is still emitted (Claude Code `Skill` args preview = the skill name only) |
| Framework skills (inferred) | deepagents: TOOL `read_file` whose `input.value` `file_path` matches `^(.*/)?<skill>/SKILL\.md$` (skill = parent dir); confirmed against `skills_metadata[].path` from a `SkillsMiddleware.before_agent` span's `output.value` when known (cached per `thread_id`, else trace: it is emitted only on a thread's first turn); `offset > 0` re-reads, `write_file`/`edit_file`/`ls`/`glob`/`grep` never count. OpenAI Agents SDK: TOOL `load_skill` (`input.value.skill_name`); TOOL `shell`/`exec_command`/`local_shell`/`bash`/`run_shell_command` whose command strings READ a skill file (`cat`/`sed`/`head`/`less`/`more`/`bat` ... `<skill>/SKILL.md`, no redirect, not `sed -i`; a trailing `-<32 hex>` mount suffix is stripped); hosted shell: an LLM span's `output.value` `output[]` items `type: shell_call` (`action.commands`, once per `call_id`; `input.value` is never scanned) | same `skill` start/end on the owning agent (tool span start/end; hosted shell: both at the LLM span's end); one use per (agent, skill) (deepagents also per path) |
| Decision | `agentglow.decision` ∈ `choice`, `score`, `noul` on any span (see "Decisions") | `decision` on span end, on the owning agent; the span itself is never an LLM / tool |
| Claude Code hooks | `POST /v1/claude-code` (`claude_code.py`) | one prompt = one run (topic `Claude Code · <cwd basename>`); main agent `claude`; `Agent` tool → `task` + subagent named after its type; tools; 0-token thinking pulses. A session with no hook / trace for `AGENTGLOW_SESSION_IDLE_MIN` minutes (default 10; 30 = the pre-0.4 behavior) was abandoned (terminal closed, no SessionEnd): it closes like SessionEnd and its run completes with `reason: "abandoned"`; the next hook of that session id (any event) opens a new run (`<session>:<n+1>`) at once |
| Claude Code traces | `claude_code.*` spans on `/v1/traces` (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`) | `interaction` = run + `claude`; each `agent_id` = subagent (`subagent: true`, parent `claude`, linked via its `Agent` tool's `tool.execution` span; named from `query_source_safe` `agent.<kind>.<type>`, else `subagent <id>`); `llm_request` = `llm` with `tokens_in` = input + cache_creation + cache_read (all prompt tokens), `tokens_out`, `tokens_cached` = cache_read, `tokens_cache_write` = cache_creation; `tool` = tool event (`tool.blocked_on_user`/`tool.execution` skipped). Merged with hooks when `session.id` is a hooks session: no new agents/tools, token `llm` events go to the hooks agents (by `agent_id`; a re-delivered `llm_request` span id is ignored), hook pulses muted, exits wait up to 15 s for the agent's trace spans |
Unknown spans are kept only for tree/ownership. Ids: agent instance id = span id (stable string).

### Waits and long-running runs (durable tasks)
A run stays open while any of its spans is open, however long it is silent; only when nothing is open (and no step is
parked, below) does the Hatchet idle grace (`AGENTGLOW_HATCHET_IDLE_MS`, default 60 s; 3 s once the run has a
`final`) apply. Hard bound: a run with no span start/end for `AGENTGLOW_RUN_MAX_IDLE_MS` (default 24 h) completes.

**App wait contract.** Open a span around the wait, inside the step (a child of the step span), with these attributes
set at span start; the wait lasts while the span is open:

| Attribute | Value |
|---|---|
| `agentglow.wait` | required: what it waits on, a short label, e.g. `"approval"`, `"vendor reply"`; `"sleep"` for a timer. Secrets redacted, max 60 chars |
| `agentglow.wait.until` | optional: deadline / wake-up time: epoch ms (int), epoch seconds (< 1e11), or ISO-8601 string (`2026-10-01T15:00:00Z`) |
| `agentglow.wait.kind` | optional `approval`: a human approval (listed under "Needs you" with Approve / Reject; without it a reason containing `human` / `approv` counts too) |
| `agentglow.wait.title` | optional short title for the drawer and the "Needs you" row, e.g. `BUY 26 YES @ 45c · wind-bos` (secrets redacted, max 80 chars) |
| `agentglow.wait.detail.<key>` | optional app fields shown in the drawer: str / int / float / bool, at most 12 keys (`[A-Za-z0-9_.-]`, max 32 chars), strings secrets-redacted, emails / phones replaced, max 80 chars; kept in strict privacy mode because the app sets them on purpose |
| `agentglow.wait.url` | optional "Open in app" link: http(s) only, userinfo stripped, secrets redacted, path and query kept as given (do not put PHI / PII in it), max 512 chars |
| `agentglow.wait.because` | optional span id (hex) of the decision that triggered the wait |

Python helpers (context managers and decorators, sync and async; backend `primitives.py`):
`agentglow.wait(reason, until=None, timeout_s=None, *, title=None, details=None, url=None, because=None)` and
`agentglow.approval(reason="human approval", timeout_s=None, until=None, *, title=None, details=None, url=None,
because=None)` (= `wait(..., kind="approval")`). `until`: epoch ms / s, a datetime (naive = UTC) or ISO-8601; else now +
`timeout_s`. `because`: the decision object `decided()` / `decision()` returned, or its span id. Used as a decorator,
`title` / `details` / `url` may be callables over the call's arguments. They only SHOW the wait: resuming the work is
the app's job (the Approve / Reject webhook below pushes the app's own event / flag).
```python
async with agentglow.approval(timeout_s=900, title="Refund $420 to order 1182", details={"amount_usd": 420, "items": 3},
                              url="https://admin.example.com/refunds/1182", because=guard_decision):
    await ctx.aio_wait_for("approval", UserEventCondition(event_key="refund:approved"))
```
The same with a raw span (any language):
```python
with tracer.start_as_current_span("await approval", attributes={"agentglow.wait": "approval",
                                                                 "agentglow.wait.until": deadline_ms}):
    await ctx.aio_wait_for("approval", UserEventCondition(event_key="vendor:approved"))
with tracer.start_as_current_span("cool-off", attributes={"agentglow.wait": "sleep", "agentglow.wait.until": wake_ms}):
    await ctx.aio_sleep_for(timedelta(hours=48))
```
Without it, HatchetInstrumentor's own `hatchet.durable.wait_for` span (every `ctx.aio_wait_for` / `aio_sleep_for` /
`aio_wait_for_event`) is used: it carries only `hatchet.signal_key` (`sleep:<N><s|m|h>-<i>` → reason `sleep`, until =
start + N; `event:<key>-<i>` → reason `<key>`), `hatchet.num_conditions` and `hatchet.step_run_id` (its parent is the
trigger's traceparent, so the run comes from the step span with that step run id). The app span wins when both are open.

**Events.** Wait start: `step` `{"status": "waiting", "reason", "until"?}` on its step, and `agent`
`{"status": "waiting", "reason", "until"?}` on the owning agent (declared wait: nearest ancestor agent; else the newest
live agent in that step), if any. Wait end: `step running` again (while the step is open), `agent thinking`. A declared
wait adds, on both events, `kind`?, `title`?, `details`? `{key: scalar}`, `url`? and `because`? = `{id, kind, question,
result, p?, provider, purpose?, target?, threshold?, ms, ts}` (the decision named by `agentglow.wait.because`; for an
approval without it, the owning agent's latest guard / noul decision of the last 30 s). New viewers get them with the
replay.

**Human approval (HUD).** With `approve: true` in `/live/health`, every live agent waiting on a human is listed under
"Needs you" (title or reason, countdown). A row (or its Details button, or Details in the Selected panel) opens a side
drawer while the scene keeps running and the agent is selected in 3D: title, agent + run, why (the `because` decision:
kind, question, result, p, threshold, provider, latency; else the reason), the details table, the agent's recent
decisions / tool and MCP calls / orders, the deadline (`deadline in 4m 10s`, then `auto-approve due` / `overdue`),
Approve / Reject with an optional note (POST `/live/approve` `note`), "Open in app" (new tab, when `url`) and "Copy
link" (`?run=<run id>&agent=<agent id>`: opens AgentGlow on that run with the agent selected and, while it still waits
on a human, its drawer open). Keys: Esc closes, A / R approve / reject while the drawer has focus.

**Eviction.** Hatchet evicts a durable task waiting longer than its eviction policy TTL (default 15 min): the task is
cancelled (wait and step spans end together, status unset) and re-run with the same step run id when the wait is
satisfied. A step that ends within 1 s of a wait nested in it therefore stays `waiting` (parked) instead of `done`; the
run is held until the wait's `until` + idle grace (no `until`: the 24 h bound) or until a step starts again (other parked
steps then get `step done`). A workflow whose LAST step returns right after an un-dated wait should set `agentglow.final`.

**Fan-out.** A child workflow run folds into its parent run when its step span has `hatchet.parent_workflow_run_id` of a
run still open, or (the engine often leaves that empty, e.g. `aio_run_many` from a task) when the step span's OTel parent,
the traceparent HatchetInstrumentor injects at trigger time, belongs to another open Hatchet run. Its agents become
subagents of the agent that owns the triggering span (a step with no agent of its own is promoted to an agent named after
the step, which stays alive until the step ends), else of the parent run's newest live agent outside child steps. Parallel
instances of one step name keep the step `running` until the last ends (failed if any instance failed). Queued
(concurrency-limited) tasks emit nothing until they start.

## Backend services (backend `backend.py`)
Ordinary backend OTel spans (FastAPI, FastStream, any HTTP / messaging / DB instrumentation) map onto the same world.
Gated: only the spans below are handled here, so a pure agent trace maps exactly as before (regression test:
`tests/test_backend_regression.py` against the v0.3.0 events of every fixture), and a service only appears once it has
backend spans.

| Backend | Rule | World |
|---|---|---|
| service | resource `service.name` (span JSON `service`), overridden by attribute `agentglow.service` | one long-lived agent `svc:<name>` (`svc:<scope>:<name>` when scoped) in the run `services` (`services:<scope>`), spawned (+ `agent thinking`) on its first backend span; persistent across requests, never completes with its spans; idle for `AGENTGLOW_SERVICE_IDLE_MS` (1 h) = `exit` (back on the next request). A new viewer gets the service run + spawns even after they left the replay buffer |
| request | SERVER span with `http.request.method` / `http.method` / `http.route` or `rpc.system` (a WebSocket SERVER span, `network.protocol.name` websocket / `url.scheme` ws, is an entry too but never a `request`: its session node shows it); CONSUMER (or SERVER) span with `messaging.system`, not a `create` span; never a span with `hatchet.*`, `gen_ai.*`, `openinference.*`, `llm.*`, `agentglow.mcp.*` or `agentglow.agent` | `request` on the service agent when it ends: `name` = `METHOD route` (route template only, never the URL / query) or the topic, `status` = HTTP status, `error` = span status ERROR or status >= 500 |
| job | a request still open `AGENTGLOW_JOB_MS` (3000) after it started (a long FastStream handler, a slow endpoint; seen at the server tick, so only for live spans) | a "job" subagent of the service: `spawn` `{"id": "req:<span id>", "agent": <request name, e.g. "mkt:tick", "POST /orders">, "parent_id": <service>, "subagent": true, "job": true, "since": <request start ms>}` + `agent thinking`; the calls inside the request (DB / HTTP / LLM / MCP / tasks) are owned by the job from then on; at its end `exit` done (failed on error / 5xx), then the usual `request`. At most `AGENTGLOW_SERVICE_MAX_JOBS` (8) live per service (more are only counted in `inflight`); a request open `AGENTGLOW_JOB_STALE_MS` (1 h; e.g. its process was killed) is forgotten (`exit` done). Live jobs are re-sent to a new viewer like the service spawns. Requests ending sooner stay a pulse (no node). A request that holds a primitive `job(id)` / `session(...)` (ids `job:<id>`, see "Generic primitives"; WebSocket entries too) is drawn by that node instead: it never also becomes a `req:` node (one already promoted exits done) |
| rate | per service, hv.py ideas: calm (<= `AGENTGLOW_SERVICE_HV_RATE`, 5 requests in the trailing 1 s) = individual `request` events within a global budget (`AGENTGLOW_SERVICE_CAP`, 20/s); busy = aggregated, only errors still go out individually at the tick (`"hv": true`, max 3 per service per tick, within the budget) | `service_stats` per service per tick (~1 s) with any requests (calm or busy): `{"type": "service_stats", "run_id", "id", "service", "window_ms", "n", "errors", "codes": {"2xx": n, "4xx": n, "5xx": n}, "p50_ms", "p95_ms", "routes": {<name>: n} (top 6 + "other"), "ts", "inflight"?}`; `inflight` = requests open now for 1 s or more (sent while > 0 and once more at 0; a window with only open requests still sends stats, `n: 0`) |
| message | PRODUCER span with `messaging.system` inside a request of service A; a request (CONSUMER span) of service B whose OTel parent or a link is that producer span (FastStream: the consumer's parent is the producer's `create` span); either side may arrive first (10 s) | `message` comet A -> B, `text` = `messaging.destination.name` / `messaging.destination_publish.name` / the span name's destination; max one per edge per 250 ms |
| task | an agent span inside a request (`agentglow.agent(...)`, GenAI `invoke_agent`, ...) or FastAPI's native `fastapi.background_task` span (name = the task function) | a subagent of the service (`subagent: true`, delegation `message`, `exit`); at most `AGENTGLOW_SERVICE_MAX_TASKS` (6) live per service, more run as the service itself |
| resource | CLIENT span (kind client, or no kind) with `db.system` / `db.system.name` (name = the system, `system:db.name` when set; kind `db`, `warehouse` for snowflake / bigquery / redshift / clickhouse, `storage` for s3 / gcs / minio) or an HTTP client (`server.address` / `net.peer.name` / the `url.full` host, `:port` unless 80 / 443; kind `api`) inside a request, or a root CLIENT span of a service (a poll, a cron); not under an LLM span (the SDK's own HTTP call); blocking stream / list reads at the root (`XREAD`, `BLPOP`, ...) are idle polls and dropped. Attributes set after start (redis, httpx) are read at the end | `mcp_register` of the synthetic server `backend` + resource, `mcp` call / result (`server: "backend"`, `tool` = the operation) on the owning agent; max one per (agent, resource) per 250 ms; never a `graph` event |
| errors | request `error` | `request` with `error: true`; counted in `service_stats.errors` |
| outcome | `agentglow.mark_outcome(...)` / `mark_error(...)` set status ERROR (+ `agentglow.outcome`, `agentglow.outcome.reason`) on the current span and its request / message / job span, even when nothing raised | the request is red (`error: true`) |
| failed publish | PRODUCER span with `messaging.system` inside a request that ends with status ERROR, or `agentglow.message.failed` (a publish that raised, even if the app caught it) | `message` with `"failed": true` from the service to the topic's last known consumer (else to itself): a comet that fizzles; max one per edge per 250 ms. Flat events: `{"event": "message", "failed": true}` |
| drives | any span of an agent run (not the services run) whose span JSON `service` (or `agentglow.service`) names a service on screen: the agent run runs in that service's process (a Hatchet worker that also consumes `mkt:tick`) | `{"type": "drives", "run_id": <services run>, "id": <service agent>, "target_run": <agent run id>, "ts"}` once per (service, run), sent at the server tick once both exist; re-sent to a new viewer while the run is open. Frontend: a faint dashed `drives` edge from the service to the run's root agent (worker -> desk) |
| replicas | span JSON `instance` = resource `service.instance.id` (OTLP resource attribute, or `watch()`: hostname-pid) | one service agent for all processes of a `service.name`; `service_stats.instances` = distinct instances seen in the last `AGENTGLOW_SERVICE_INSTANCE_MS` (60 s), only when > 1; the halo label shows `×2 · 42 req/s ...` |
| GenAI inside a request | any span the agent rules recognize | the usual `llm` / `tool` / `mcp` / ... events, owned by the service agent or its task subagent |

**Python.** `agentglow.watch(app=fastapi_app)`: FastAPI's native OTel telemetry when the app has it (FastAPI >= 0.13x;
server span + `fastapi.background_task`), else `opentelemetry-instrumentation-fastapi` (no ASGI send / receive spans).
`watch(broker=faststream_broker)`: FastStream's `TelemetryMiddleware` for the broker type (`faststream[otel]`; Redis,
Kafka, Confluent, RabbitMQ, NATS), once per broker. `watch(mcp=fastmcp_server)`: one SERVER span per tool call
(MCP section above). With any of them, httpx / requests / redis / asyncpg / pymongo clients are instrumented when their
OTel instrumentations are installed. Extras: `agentglow[fastapi]`, `[faststream]`, `[redis]`, `[postgres]`, `[mongodb]`,
`[mcp]`. `service_name` (else OTEL_SERVICE_NAME, the FastMCP name, the FastAPI title, `api` / `worker`) names the
process's service, also when an existing provider's resource has none. Example: `examples/fastapi-faststream/`.

**Plumbing (backend mode: `watch(app=` / `broker=` / `mcp=`).** All in-process (`backend/agentglow/plumbing.py`, a
policy the LiveSpanProcessor applies to every start / end it exports; other exporters on the same provider are not
touched):
- Privacy: `privacy="strict"` (default) / `"standard"`, `allow=`, `allow_message_keys=`, `error_messages=`, `scrub=`,
  `pii_patterns=` (see "Privacy" > "Backend mode").
- Noise: `ignore=[...]` fnmatch patterns matched against the span name, `http.route`, the URL path (server or client),
  `METHOD route|path` and the DB operation: `"GET /v1/models"`, `"/internal/*"`, `"XREAD*"`. A matching span and every
  local span under it are never exported. Added to the defaults: health / readiness / liveness routes (`/health*`,
  `/healthz`, `/ready*`, `/readyz`, `/livez`, `/liveness`, `/ping`, and `*/healthz` ...) and blocking Redis reads
  (`XREAD`, `XREADGROUP`, `BLPOP`, ...); `ignore_defaults=False` drops the defaults.
- Context propagation (`propagate=True` by default in backend mode, process-wide, once):
  `concurrent.futures.ThreadPoolExecutor.submit` runs the callable in a copy of the caller's context, so
  `loop.run_in_executor`, `asyncio.to_thread` and pool work stays under the request span; `asyncio.create_task`
  already copies the context (detached tasks stay linked to the request that started them).
- Mounted sub-apps: `app=` takes one app or a list. Apps mounted inside a given app (`app.mount("/api", api)`, any
  depth, FastAPI or Starlette) are served by the outer app's instrumentation: one server span per request (a nested
  server span of the same request is folded into the outer one, its children re-parented), and `http.route` / the
  span name are the full template resolved through the mounts (`GET /api/patients/{pid}`, not `/api` or `/s/{path}`).
- Replicas: the processor stamps `instance` (resource `service.instance.id`, else `OTEL_RESOURCE_ATTRIBUTES`, else
  `<hostname>-<pid>`) on every span; a provider created by `watch()` sets it as a resource attribute.
- Outcomes: `agentglow.mark_outcome("failed" | "ok" | <label>, reason=None)`, `agentglow.mark_error(reason=None)`;
  ok / success / done set status OK, anything else ERROR. Return False when no span is recording.
- Failed publishes: `watch(broker=)` wraps `broker.publish`; when it raises and FastStream's own publish span did not
  record the error, a PRODUCER span `<destination> publish` with status ERROR and `agentglow.message.failed` is made.

**Node.js.** `watch(opts)` from the npm package's `agentglow/node` entry (`frontend/src/node.ts`, server-only, no
React / three.js; OpenTelemetry packages are optional peer dependencies): a `NodeTracerProvider` (resource
`service.name` = `service`, `service.instance.id` = a random UUID) registered globally with the W3C `traceparent` /
baggage propagator, `@opentelemetry/instrumentation-http` (incoming requests = SERVER spans; off under Next.js,
`NEXT_RUNTIME` set, which makes its own `BaseServer.handleRequest` SERVER spans) and `instrumentation-undici` (global
`fetch` = CLIENT spans + `traceparent`, so a Python service watched with `watch(app=...)` continues the trace), batched
to `<url>/v1/traces` as OTLP/HTTP JSON (`x-api-key` = `ingestKey`). Idempotent per url; `spanProcessor()` gives the same
scrubbing exporter for apps with their own provider. Privacy, applied to every span before export: `"strict"` (default)
keeps only method, route, status, peer `server.address` / `server.port` (taken from the URL's host when missing),
`url.scheme`, protocol, `error.type`, rpc / messaging / db system, destination and operation names, `next.route`,
selected `gen_ai.*` names and token counts, and `agentglow.*`; `"standard"` keeps other attributes too. Both drop
headers, bodies, cookies, query strings, raw URLs / targets / paths, identity and client-address keys, statements and
`exception.*`; span events (strict) and status messages are dropped. A server span's `http.route` = the route
template, else the id-normalized path (`/orders/:id`; Next.js `/route` suffix dropped), and its name =
`METHOD route`; URLs in other span names keep their origin (userinfo stripped) with an id-normalized path. The optional
`scrub(attrs, {name, kind})` hook runs next; last, a regex backstop on every string (secrets, emails, phone numbers,
long ids, query strings, userinfo). Example: `examples/node-proxy/`.

### Flat events
`POST /v1/events`: one JSON object or an array (max 5000), for anything without OTel. Same ingest key, scope (`?scope=`,
`X-AgentGlow-Scope`, or a `scope` field per event) and privacy scrub as `/v1/live`; ids and timing are the server's
(`ts` = now). `agentglow.pulse(service, name, *, event="request", **fields)` (Python, batched in a background thread,
never blocks) and `pulse(url, event)` from the npm package's `agentglow/pulse` entry (fetch, never throws) send them.

| Field | |
|---|---|
| `service` (or `agent`) | required: the service / long-lived agent |
| `event` | `request` (default) \| `message` \| `call` \| `error` \| `llm` \| `tool` \| a primitive (see "Generic primitives": `session`, `stage`, `progress`, `capacity`, `rejected`, `job`, `link`, `complete`, `fallback`, `gate`, `backlog`, `lifecycle`, `metric`, `event`, `cache`, `lease`, `inference`); anything else = a request named after it |
| `name` | route / operation / tool name (scrubbed, max 60) |
| `status` | HTTP status (>= 500 = error) or `error` / `failed` |
| `duration_ms` | latency |
| `to` | `message`: the consuming service; `call`: the external system |
| `topic` | `message`: the topic / stream (comet label) |
| `kind` | `call`: `db` \| `warehouse` \| `spark` \| `api` \| `storage` \| `queue` |
| `tokens_in`, `tokens_out` | `llm` |

`request` / `error` = a `request` (rate rules above); `message` = comet `service` -> `to` + a `message` request on `to`;
`call` = `mcp` call + result on `backend` / `to`; `llm` = `llm` on the service agent; `tool` = `tool`.

## Manual API (backend `manual.py`)
For hand-written agent loops (no framework). Plain OpenTelemetry spans (`opentelemetry-api`) on the global provider
(the one `watch()` uses), all attributes set at start so `LiveSpanProcessor` shows long-lived agents immediately; no
SDK provider = no-op. Context in contextvars (asyncio tasks created inside inherit it). Sync `with` and `async with`.

| Call | Span | Attributes |
|---|---|---|
| `run(topic, run_id=None, scope=None, workflow=None)` | new root span (new trace), name = workflow or `run` | `agentglow.run.topic`, `agentglow.run.id`, `agentglow.run.workflow`, `agentglow.scope` (+ scope baggage for every span inside); `.final(t)` sets `agentglow.final` |
| `agent(name, final=None, task=None, parent=None)` | child of the current span (or `parent`) | `agentglow.agent=name`; nested in another manual agent: `agentglow.subagent=true` (spawn `subagent: true`, delegation `message` = `task` via `input.value`); `.say(t)` sets `output.value` (exit/result text); `.final(t)` also sets `agentglow.final` on a top-level agent |
| `llm(model, tokens_in, tokens_out)` / `Agent.llm(..., latency_ms=0)` | `chat <model>` | `gen_ai.operation.name=chat`, `gen_ai.request.model`, `gen_ai.usage.input_tokens/output_tokens` (`.set_tokens`) |
| `tool(name, args=None)` | `<name>` | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `input.value` = args JSON; `.result(v)` → `output.value` |
| `mcp(server, tool, resource=None, kind="api", args=None)` | tool span | + `agentglow.mcp.server/tool/resource/resource_kind` |
| `graph(op, nodes, system="graph")` | `db <op>` | `db.system`, `agentglow.db.op`, `agentglow.graph.nodes` |
| `skill(name)` / `Agent.skill(name)` | tool span `<name>` | as `tool` + `agentglow.skill=name` (skill badge on the current agent while the block runs) |
| `decision(kind, question, result=None, p=None, options=None, provider="llm", purpose=None, target=None)` / `Agent.decision(...)` | `decision <kind>` | the "Decisions" attributes; `.record(result, p, options, target)` sets the outcome before the block ends; a bool `result` → `yes`/`no`; `options` = `{name: p}` or `[(name, p)]` |
| `decided(kind, question, result, p, ..., latency_ms=0, important=False, scope=None, threshold=None)` / `Agent.decided(...)` | `decision <kind>` (backdated) | one finished decision in one call, returned (pass it as a wait's `because=`); `important=True` sets `agentglow.decision.important`, `scope="global"` sets `agentglow.decision.scope`, `threshold` sets `agentglow.decision.threshold` (all also on `decision(...)`) |
| `order(side, qty, price=None, status="would_place", instrument=None, dry_run=True, reason=None)` / `Agent.order(...)` | `order <side>` (finished at once) | the "Orders" attributes |
| `@traced_agent(name)`, `@traced_tool(name, capture_args=False)` | per call | as `agent` / `tool`; args recorded only with `capture_args=True`. Every call above is also a decorator: see "Decorators" |
| `current_agent()` | - | the manual agent (or primitive session) of the current context, or None |

A span that raises ends with status error (run → failed). Text in `say`/`final`/`task`/`args` passes the Privacy
scrub (secrets only): callers must keep PHI/PII out of it. Example: `examples/custom-loop/`.

## Decorators (backend `dual.py`)
Every context manager above and in "Generic primitives" is also a decorator, with the same call signature (all
existing `with` / `async with` uses are unchanged). A decorated function gets a FRESH span per call (one decorator
object can run many times, concurrently); sync functions, coroutine functions, sync / async generators (the span covers
the whole iteration; its context is active only while the generator body runs, never in the caller between yields),
methods, `staticmethod` / `classmethod` (put the agentglow decorator above them). `functools.wraps` keeps the name and
signature, so FastAPI / FastStream still see the original parameters: put agentglow decorators BELOW the framework's
(`@app.post(...)` / `@broker.subscriber(...)` first, then `@agentglow.job(...)`).

| Decorator | Each call is | Notes |
|---|---|---|
| `@stage(name=None)` / `@stage` | a `stage <name>` span | name defaults to the function name |
| `@traced(name=None, kind="step")` / `@traced` | a `<kind> <name>` span with `agentglow.stage`=name, `agentglow.stage.kind`=kind | a step of the caller's agent / request / job / session (drawn like a stage, no new agent); also `with traced("x"):` |
| `@session(name=None, kind="session", id=None, ...)` / `@session` | a session | `id` may be a callable |
| `@job(id, kind="job", attempt=1, max_attempts=None)` | one attempt | `id` / `attempt` may be callables; return -> `done`, exception -> `retrying` / `dead` with `max_attempts`, else `failed` |
| `@inference(model, device=None, units=None, unit="audio_s")` | an inference span | `units` / `device` may be callables |
| `@pool.lease()` / `@pool.lease` | one lease | really limits concurrency to the pool size |
| `@decision(kind, question, ..., purpose=, target=, provider=)` | a decision | the return value is the outcome: bool -> `yes`/`no`; `(result, p)`; `{"result", "p", "options"}`; None -> no result; else `str(value)` cut to 80 chars; the value is returned unchanged |
| `@agent(name=None)` / `@agent`, `@tool(name=None)` / `@tool` | an agent / tool span | `@traced_agent` / `@traced_tool` remain (aliases; `traced_tool(capture_args=True)` still records arguments) |
| `@wait(reason, ...)`, `@approval(...)` | a declared wait ("Waits and long-running runs") | `title` / `details` / `url` may be callables |
| `@run(topic)`, `@llm(model)`, `@mcp(server, tool)`, `@graph(op)`, `@skill(name)` | as the context manager | |

Privacy: arguments and return values are NEVER recorded (except a decision's return value, which is its purpose).
Values only enter through explicit callables, called with the call's bound arguments as keyword arguments (defaults
applied, `**kwargs` merged): `@job(id=lambda order_id, **_: order_id)`, `@inference("whisper", units=lambda audio,
**_: len(audio) / 16000)`. A callable that raises is logged once per function and field (exception type only) and its
field skipped (a job id falls back to the function name); instrumentation never breaks the call. An exception marks the
span failed and propagates unchanged.

## Decisions
Fast structured decisions ("System One" models: TypeSafe Jev, its open alternative Laya, or an LLM-as-judge fallback)
made by an agent: model routing, tool-call guardrails, quality checks. One decision = one span (latency = its
duration) with these attributes (all set at start or by end; the event is emitted when the span ends):

| Attribute | Value |
|---|---|
| `agentglow.decision` | `choice` (pick one of N options) \| `score` (ordinal level) \| `noul` (yes/no); any other value is shown as `choice` |
| `agentglow.decision.question` | short name or text of the question, e.g. `route`, `tool allowed?` (scrubbed, max 80 chars) |
| `agentglow.decision.result` | the chosen option / the level / `yes` \| `no` (noul; booleans are accepted) |
| `agentglow.decision.p` | probability of `result`, 0..1 (noul `no` at p_true 0.03 → `p` 0.97) |
| `agentglow.decision.options` | optional JSON string: a list of `{"name", "p"}`: the distribution; up to 5 kept, sorted by `p` desc |
| `agentglow.decision.provider` | `jev` \| `laya` \| `llm` \| any short label (default `llm`) |
| `agentglow.decision.purpose` | optional `route` \| `guard` \| `check` (or any short label) |
| `agentglow.decision.target` | optional: the tool being gated, the model routed to, ... |
| `agentglow.decision.scope` | optional `global`: a desk-wide guard (kill switch, daily loss cap, stale feed) that halts everything below the deciding agent, not just its own action |
| `agentglow.decision.threshold` | optional number: the cut-off the result was judged against (e.g. `0.8` for "safe without a human"); shown with the decision and in an approval's "why" |

World event: `{"type": "decision", "run_id", "id": <owning agent instance id>, "kind", "question", "result", "p",
"options"?, "provider", "purpose"?, "target"?, "scope"?, "threshold"?, "ms", "ts"}` (`ms` = span duration, `p` rounded to 3 places (if missing: the result's option p, else omitted),
`options` only when given). A decision span is not an agent, LLM or tool itself: an LLM-as-judge call nested inside it
still pulses as an LLM turn of the same agent. Scrub: `question` secrets redacted, whitespace collapsed, max 80 chars;
`result`, `provider`, `purpose`, `target` and option names the same, max 40 chars; `p` clamped to 0..1.
Python: `agentglow.decision(...)` / `agentglow.decided(...)` (Manual API). Frontend: a fast (~150 ms snap, gone by
~1.6 s) overlay on the agent in every theme: choice = a fan of option rays (winner bright, thickness ~ p); noul = a
gate that flicks green or slams red (a `guard` `no` is a red X: `guard: deny <target> 97%`); score = a gauge arc. The
HUD counts decisions (`N decisions · avg X ms`, per provider in the tooltip) and the agent panel lists recent ones.
Display names (HUD, labels; the events keep the raw values): kind `noul` = YES/NO, `choice` = PICK, `score` = SCORE;
provider `code` = rule; `why` important = key, flip = changed mind, low_p = unsure, deny = DENY.
A guard deny's red X + shockwave is capped on screen (~35 px X, ~55 px shockwave) and plays one at a time: a deny while
another one shows gets a small red X badge on its agent instead (no label) and flashes the agent's halo red.

**Desk-wide guards (`scope: "global"`).** A guard with `scope` `global` (e.g. a trading desk's kill switch) is shown
ONCE, as a halted state on the topmost agent that reports global guards (the desk): it turns red with a ring and a
`HALTED · <reason>` banner (`N agents paused`), and the HUD shows a `HALTED · <reason>` chip. The reason is the
question minus a trailing `off` / `ok` / `?` (an `important` deny's question wins: `kill switch off` -> `kill switch`).
Agents below it that report the same guard (`feed fresh: no` per market) get no glyph: their halo flashes red. The halt
ends when every global guard the owner said no to says yes again (or the owner / its run ends). Global decisions
still count in the stats and are listed in the agent panel.

### High volume (backend `hv.py`)
Long-lived agents can decide tens of times per second (e.g. 40 market agents gating every 1 s tick). Per-decision events
would flood the stream and the glyphs become noise, so the mapper adapts per agent:

- `agentglow.decision.important` (bool, optional): always worth showing (see below).
- **Calm** agent (<= 2 decisions in the trailing 1 s of span time, `AGENTGLOW_DECISION_HV_RATE`): every decision is an
  individual `decision` event, emitted at once, while the global budget allows.
- **Busy** agent (more than that): its decisions are aggregated into one `decision_stats` event per server tick (~1 s);
  only *interesting* ones are still sent individually, ranked important > guard deny > route flip (a `route` result
  that differs from that agent's previous result for the same question) > low-confidence guard (0.4 <= p <= 0.6; an unsure `check`
  is routine at volume and stays in the stats). They carry `"hv": true`
  and `"why": "important"|"deny"|"flip"|"low_p"` and are emitted at the tick. An agent is calm again after 3 ticks in a
  row below the rate.
- **Global cap**: at most 20 individual decision events per second over all agents (`AGENTGLOW_DECISION_CAP`). Calm
  pass-through spends the budget of its 1 s of span time first (one over it is aggregated into its agent's
  `decision_stats`); the busy agents' interesting decisions share what is left of the tick's budget, best first,
  round-robin across agents; the rest are dropped (still counted in the stats).
- Nothing is lost silently: every decision is an individual event or counted in a `decision_stats` (`n` counts all of
  that agent's decisions in the window, including ones also sent individually). No decisions in a window: no event.
- Deny = result in `no|deny|denied|false|block|blocked|reject|rejected`; check yes = `yes|true|pass|ok|allow`, no = the
  deny words. Purpose missing: `choice` counts as `route`, others as `check`.

`decision_stats` = `{"type": "decision_stats", "run_id", "id": <agent instance id>, "window_ms": <tick window, ~1000>,
"n", "by_purpose": {"route": {"n", "results": {<result>: count}}, "guard": {"n", "allow", "deny"}, "check": {"n",
"yes", "no"}}, "p50_ms", "p95_ms", "providers": {<provider>: count}, "ts"}` (purposes with no decisions omitted; route
results top 6, the rest summed as `other`; providers top 6).
Frontend: a per-agent decision halo (ring whose thickness/brightness ~ rate, arc split by outcome: allow green, deny
red, route results in accent colours, check yes/no) + label `name 42/s · 3% deny` (rate + deny share, the share only
when > 0; p50 / p95 in the Selected panel and the label's hover tooltip), smoothed (EMA), fading
when the agent goes quiet; individual `hv` decisions use the bold glyphs with short holds (~0.8 s), one per agent at a
time, and at most 3 such glyphs on screen at once (most important, then newest, wins; the others only flash the
agent's halo; an equally important one replaces a glyph only after ~0.65 s on screen). The halo text shows for the selected agent and the 3 busiest; the others show the ring only. Many
subagents of one parent (> 8) wrap into staggered fan rows. HUD over 2 decisions/s: `N/s · deny X% · p50/p95` with a 60 s sparkline.

## Orders
An agent's order action (a trading bot's paper or real order, any buy/sell/yes/no ticket): a span with
`agentglow.event` = `order` and:

| Attribute | Value |
|---|---|
| `agentglow.order.side` | `buy` \| `sell` \| `yes` \| `no` (lower-cased, max 8 chars; default `buy`) |
| `agentglow.order.qty` | number (default 0) |
| `agentglow.order.price` | optional number (e.g. 0.42 = 42c) |
| `agentglow.order.status` | `would_place` (default) \| `placed` \| `filled` \| `rejected` \| `cancelled` |
| `agentglow.order.instrument` | short label (scrubbed, max 40) |
| `agentglow.order.dry_run` | bool: paper trading |
| `agentglow.order.reason` | optional short label (scrubbed, max 80) |

World event (when the span ends; owned by the nearest agent): `{"type": "order", "run_id", "id", "side", "qty",
"price"?, "status", "instrument", "dry_run", "reason"?, "ts"}`. Not an LLM turn or tool call. Python:
`agentglow.order(...)` / `Agent.order(...)`. Frontend: a small chip popping from the agent for ~1.5 s (green BUY/YES,
red SELL/NO, `YES 3 @ 42c`, dashed outline + `paper` when `dry_run`, grey strike-through when rejected/cancelled); the
HUD shows `orders N (paper)` and the agent panel the agent's recent orders.

## Generic primitives (backend `primitives.py`)
Small building blocks any system can report: long-lived sessions, stages and progress, admission / backpressure,
resource pools and non-LLM inference, jobs that cross processes, late callbacks, fallbacks, stateful gates, broker
backlog, service lifecycle, metrics, business events and caches. Each has a Python call (exported from `agentglow`), an
OTel attribute contract (any language), a `/v1/events` flat form and world events. None of them carries content: fields
are numbers, ids and short enums; every string passes the Privacy scrub (secrets redacted) and is capped (labels 40,
reasons 60 chars). Like the Manual API they are plain OTel spans on the global provider (no SDK provider = no-op).

**Owner.** A primitive belongs to the nearest agent of its span: a session, a job node, a task subagent, the service of
the request it runs in, or an agent. A signal span with no parent (process start-up, a sampler thread) belongs to the
process's service (`service.name` / `agentglow.service`). Flat events: `service` (required), or the node named by
`session_id` / `job_id`.

**Two span shapes.** Long-lived ones are spans with attributes set at start (live view). Point ones are finished-at-once
spans with `agentglow.signal` = the signal name and `agentglow.<signal>.<field>` attributes (a signal span is never a
run, LLM turn, tool call or request of its own).

| Primitive | Python | Span attributes | Flat (`/v1/events`, `event` = ...) | World |
|---|---|---|---|---|
| session | `with agentglow.session(name, kind="voice", id=None, parent=None, parent_link=True) as s:` ; `s.progress(**gauges)`, `s.turn(role, **numbers)`, `s.end(outcome=, reason=)` | span `session <name>`: `agentglow.session`=name, `agentglow.agent`=name, `.session.kind`, `.session.id`; at end `.session.outcome`, `.session.reason`; gauges: signal `gauge` (`agentglow.gauge.<k>` numbers, max one per second), turns: signal `turn` (`agentglow.turn.role`, `agentglow.turn.<k>` numbers) | `session` with `session_id`, `phase` start\|progress\|turn\|end, `kind`, `name`, `gauges` {}, `role`, `outcome`, `reason` | `spawn` (a subagent of its owner, e.g. the service whose request opened it) + `session` events; `exit` at end |
| stage | `with agentglow.stage("decode"):` (parallel = several open at once) | span `stage <name>`: `agentglow.stage`=name | `stage` with `name`, `status` running\|done\|failed, `duration_ms` | `stage` running / done / failed on the owner |
| progress | `agentglow.progress(i, n)` or `progress(0.4, eta_s=None, label=None)` | signal `progress`: `.progress.frac`, `.i`, `.n`, `.eta_ms`, `.label` | `progress` with `frac` or `i`+`n`, `eta_ms`, `label` | `progress` (`frac` 0..1, `eta_ms` given or estimated from the rate since the first progress) |
| capacity | `agentglow.capacity(name, used, max)` | signal `capacity`: `.capacity.name`, `.used`, `.max` | `capacity` with `name`, `used`, `max` | `capacity` gauge (max one per owner+name per 250 ms unless it hits max / leaves it) |
| rejected | `agentglow.rejected(reason, retry_after=None, status=None)` | signal `rejected`: `.rejected.reason`, `.retry_after_ms`, `.status`; also sets `agentglow.rejected`=reason on the current span | `rejected` with `reason`, `retry_after_ms`, `status` | `rejected` (amber, NOT an error); the enclosing request's `request` gets `rejected: true`, `error: false` even for a 503 |
| pool | `p = agentglow.pool(name, size, kind="model"\|"gpu"\|"worker", devices=None, group=None)`; `async with p.lease() as inst:` / `with p.lease():` (`inst.device`, `inst.index`; it really limits concurrency to `size`) | span `lease <pool>`, started when acquired, backdated to the request: `agentglow.pool`=name, `.pool.kind`, `.size`, `.device`, `.instance`, `.wait_ms`, `.waiting`, `agentglow.resource.group` | `lease` with `pool`, `kind`, `size`, `device`, `wait_ms`, `duration_ms`, `group` | resource `<pool>` (kind = pool kind) under its resource group (default `backend`, see below): `mcp` call / result (`tool` `lease`), `resource_stats` |
| inference | `with agentglow.inference(model, device=None, units=None, unit="audio_s", group=None) as inf:` (`inf.units = 12.5` before the end) | span `inference <model>`: `agentglow.inference.model`, `.device`, `.units`, `.unit`, `agentglow.resource.group` | `inference` with `model`, `device`, `units`, `unit`, `duration_ms`, `group` | resource `<model>` (kind `model`): `mcp` call / result (`tool` `infer`, + `units`, `unit`), `resource_stats` with speed |
| job | `agentglow.job(id, kind="job", state="queued")` (a point state) or `with agentglow.job(id, kind=..., attempt=n, max_attempts=None) as j:` (running; end: done, an exception: `retrying` while `attempt < max_attempts`, `dead` at the last attempt, else `failed`; `j.state("retrying")` overrides) | span `job <kind>` or signal `job`: `agentglow.job.id`, `.job.kind`, `.job.state`, `.job.attempt` | `job` with `job_id`, `kind`, `state`, `attempt` | ONE node per job id (scope + id) in the services run (at most `AGENTGLOW_JOB_MAX_NODES`, 12, live nodes; more are tracked, not drawn): `spawn` (subagent of the service that first reports it, `job:<id>`) + `job` events from every process; a different service reporting it = comet from that service to the job; `done` = exit done, `dead` = exit failed, `failed` exits after 15 s without a retry, any job after 5 min without news; spans inside the job span (stages, progress, leases) belong to it |
| link / complete | `agentglow.link(external_id, label=None)` inside the outbound call; later `agentglow.complete(external_id, status="ok")` in the webhook | signals `link` (`.link.id`, `.link.label`) / `complete` (`.complete.id`, `.complete.status`) | `link` / `complete` with `ref`, `label` / `status` | `deferred` `open` on the caller; on complete `deferred` `done` (`from_id` = completer, `wait_ms`) + a `message` comet completer -> caller (`callback <status>`); open links are forgotten after 1 h |
| fallback | `agentglow.fallback(from_="inline", to="queue", reason="timeout", job=None)` | signal `fallback`: `.fallback.from`, `.to`, `.reason`, `.job` | `fallback` with `from`, `to`, `reason`, `job_id` | `fallback` (`to_id` = the job node when `job` is given, else a service named `to`, if known): dashed edge |
| gate | `agentglow.gate(name, state="locked", attempts_left=None)` | signal `gate`: `.gate.name`, `.state`, `.attempts_left` | `gate` with `name`, `state`, `attempts_left` | `gate` on the owner (state persists: lock badge while locked) |
| backlog | `agentglow.backlog(topic, depth, pending=None, lag_ms=None)`; sampler: `agentglow.sample_backlog(broker_or_redis, streams=None, every_s=3)` or `watch(broker=..., backlog=True)` | signal `backlog`: `.backlog.topic`, `.depth`, `.pending`, `.lag_ms` | `backlog` with `topic`, `depth`, `pending`, `lag_ms` | `backlog` (`from_id` / `to_id` = the producer / consumer services of that topic once a message comet showed them); max one per topic per 500 ms |
| lifecycle | `agentglow.lifecycle(state)`: loading \| warming \| ready \| degraded \| draining \| restarting \| fatal | signal `lifecycle`: `.lifecycle.state` | `lifecycle` with `state` | `lifecycle` on the service of the span (never a session / job inside it; latest state replayed to new viewers) |
| metric | `agentglow.metric(name, value, unit=None)` | signal `metric`: `.metric.name`, `.value`, `.unit` | `metric` with `name`, `value`, `unit` | `metric` (max one per owner+name per 500 ms) |
| event | `agentglow.event(kind, label=None, **fields)` (numbers / bools / short strings; `order(...)` keeps its own shape) | span `event <kind>`: `agentglow.event`=kind, `.event.label`, `.event.<field>` | `event` with `kind`, `label`, other fields | `event` (`fields` max 8) |
| cache | `agentglow.cache(name, hit=True, group=None)` | signal `cache`: `.cache.name`, `.hit`, `.group` | `cache` with `name`, `hit`, `group` | resource `<name>` (kind `cache`): `mcp` pulse (max one per owner+cache per 250 ms), hit rate in `resource_stats` |

Work started later in a detached task or thread keeps its spawning request as the owner when that context is passed
explicitly: `ctx = agentglow.capture()` in the request, then `session(..., parent=ctx)` / `job(..., parent=ctx)`.

World event shapes (`ts` = epoch ms; `id` = owner instance id):
```
session        {run_id, id, name, kind, phase: start|progress|turn|end, ref?, gauges?: {k: num}, role?, outcome?, reason?, ms?}
stage          {run_id, id, name, status: running|done|failed, ms?}
progress       {run_id, id, frac, i?, n?, eta_ms?, label?}
capacity       {run_id, id, name, used, max}
rejected       {run_id, id, reason, retry_after_ms?, status?}
job            {run_id, id: "job:<id>", job_id, kind, state: queued|running|retrying|done|failed|dead, attempt, at?: <service>}
deferred       {run_id, id, ref, phase: open|done, label?, status?, from_id?, wait_ms?}
fallback       {run_id, id, from, to, reason, to_id?}
gate           {run_id, id, name, state: locked|unlocked, attempts_left?}
backlog        {run_id, id, topic, depth, pending?, lag_ms?, from_id?, to_id?}
lifecycle      {run_id, id, state}
metric         {run_id, id, name, value, unit?}
event          {run_id, id, kind, label?, fields?: {k: num|bool|str}}
resource_stats {run_id, server: "backend" | <group>, resource, kind, window_ms, calls, p50_ms, size?, busy?, waiting?, wait_p50_ms?,
                devices?: [{device, busy, size}], hits?, misses?, units?, unit?, rtf?}   (one per active resource per tick)
```
New resource kinds: `model`, `gpu`, `worker`, `cache` (themes draw them with the closest existing shape).

**Resource groups.** Pools, models and caches join the synthetic group `backend` (drawn as "MCP · backend") unless a
group is named: the `group=` argument of `pool()` / `inference()` / `cache()`, else the process default
`agentglow.resource_group(name)` / `agentglow.watch(..., resource_group=name)` / env `AGENTGLOW_RESOURCE_GROUP`. It
travels as `agentglow.resource.group` (lease / inference spans), `agentglow.cache.group` (cache signal) or flat field
`group` (max 40 chars); the server uses it as the `server` of the `mcp_register`, `mcp` and `resource_stats` events.
A named group's `mcp_register` (and its `/live/topology` entry) carries `kind`: `"model"` while it holds only models,
`"mcp"` once anything else joins; the UI labels a `model` group "ML · <name>" (e.g. `inference("lightgbm-payment-integrity",
group="payment-integrity scorer")` -> "ML · payment-integrity scorer"), anything else "MCP · <name>". The default
`backend` group never carries `kind` (output unchanged).

**FastAPI WebSockets.** `with agentglow.session_ws(websocket, name=None, kind="ws"):` around a WebSocket handler (name =
the route path) is a session: `client_disconnect` / `server_close` reason from the close code, frames counted as
`frames_in` / `frames_out` gauges (no content). With `watch(app=...)` every WebSocket route of the app is wrapped
automatically (`agentglow.primitives.watch_websockets(app)`).

**Redis Streams backlog sampler.** `agentglow.sample_backlog(broker, streams=None, every_s=3.0)`: a daemon thread runs
`XLEN` and, for each consumer group, `XPENDING` (pending count, lag from the oldest pending id) on the given streams (default:
the FastStream broker's subscribed streams) and reports `backlog`; its own Redis calls are not traced. Opt in with
`watch(broker=broker, backlog=True)` (or a float = the interval).

**Frontend.** All themes (kit overlays, `kit/Prims.tsx`): one compact status line under the node (job state `retrying
#2`, session timer `voice 1:23 · 4 turns`, stages `decode` / `asr + tts` for parallel ones, `42% · ETA 8s`, `locked ·
2 left`, `cap 3/4`, lifecycle state, `awaiting <label>`), max ~3 segments; a progress arc around the node; lifecycle
tint ring (blue loading / warming, amber degraded, grey draining, red fatal; an expanding pulse on restart); an amber
flash ring on `rejected`; dashed edges for `fallback` (amber) and a completed `deferred` (green); a backlog line between
the producer and consumer services (`orders 42 · lag 1.2s`, thicker with depth); business `event` chips (like orders);
resource stats under backend nodes (`2/4 busy · wait 12ms`, `hit 82%`, `RTF 0.21`). Selected panel: Session (kind,
elapsed, turns, gauges, outcome), Stages & progress, Job (state history), Gates / capacity / lifecycle / metrics,
Events. HUD: `rejected N` (amber).

## Privacy
One scrub (`backend/agentglow/scrub.py`) runs at the Hub ingestion boundary for every path (`/v1/live`, `/v1/traces`
JSON + protobuf, `/v1/events`, `/v1/claude-code`; the hooks adapter also scrubs each payload before building spans):
- Dropped identity keys: `user.email`, `user.id`, `user.account_id`, `user.account_uuid`, `organization.id`,
  `enduser.*`, any key containing `email`.
- Dropped raw user prompts: `user_prompt*` (Claude Code traces), `gen_ai.prompt*`, `llm_request.context` unless it is
  a short label, hook `prompt` / `user_message` (a `<task-notification>` keeps only its `<summary>`). Claude Code run
  topics are never the prompt: `<session title> · <id4> · <HH:MM>` (hooks; the title is the user's /rename name, else
  Claude Code's auto title, read from the session transcript's `custom-title` / `ai-title` records), else
  `Claude Code · <cwd basename> · <id4> · <HH:MM>` (hooks) / `Claude Code · <id4> · <HH:MM>` (traces only). A session
  title is a user- or AI-chosen name (the auto title summarizes the conversation): secrets redacted, whitespace and
  control chars collapsed, max 60 chars.
- Redacted to `[redacted]` in every remaining string (span names, attributes, hook fields, incl. the agent-level
  text the UI shows: `input.value`, `output.value`, tool args, final text): `sk-ant-…`, `sk-…`, `npm_…`, `AIza…`,
  `ghp_…`/`github_pat_…`, `xox?-…`, `AKIA…`, `Bearer …`.
- Skill names (`agentglow.skill`): only the name is kept, reduced to `[A-Za-z0-9:_.-]` (other runs become `-`,
  leading `/` dropped), max 64 chars; a skill's args / prompt text are never put in the `skill` event.
- Kept (scrubbed): agent-level content (delegation text, tool args, results, final answer). Tool args can contain
  file paths.
- Opt-in prompt capture (off by default): `AGENTGLOW_CAPTURE_PROMPTS=1` on the server (`npx agentglow setup
  --capture-prompts` sets it for the login item / auto-start). Honoured only when `agentglow serve` binds a loopback
  host (`127.0.0.1`, `localhost`, `::1`); on any other `--host` it is ignored with a one-line startup warning, so a
  shared server never gets prompts. When on, the Claude Code hook prompt (UserPromptSubmit, not a
  `<task-notification>`) is kept with secrets redacted, max 2000 chars, and emitted as a `chat` event (role `user`)
  on the session's main agent; each main Stop's reply follows as role `agent`. OTel `user_prompt*` /
  `gen_ai.prompt*` stay dropped either way; other agents have no prompt capture. `create_app()` never reads the env:
  only `agentglow serve` turns it on. `/live/health` reports `"prompts": true|false`.

### Backend mode (`watch(app=` / `broker=` / `mcp=`)
Allow-list first, enforced twice:

**In-process, `privacy="strict"` (default in backend mode; `"standard"` = spans as they are).** Before a span leaves
the process only these attributes are kept (`scrub.strict_attrs`): HTTP method, `http.route`, status code, scheme,
protocol, body sizes, `server.address` / `server.port` (credentials stripped); `error.type`, `exception.type`; RPC system
/ service / method / status; `db.system`, `db.name` / `db.namespace`, `db.operation(.name)`, collection / table, Redis
db index, `db.connection_string` reduced to `scheme://host:port/db`; `messaging.system`, operation, destination (name,
template, kind, partition), consumer group, message id, conversation id, body / payload size, batch count, client id;
GenAI / OpenInference model, provider, operation, tool / agent names, token counts, `openinference.span.kind`;
`hatchet.*` ids and names (no payload / input / output / metadata / error); `agentglow.*` labels (not
`agentglow.output_text` / `agentglow.final`); `service.*`, `deployment.*`, `code.function*`, `thread.*`; LangGraph
`metadata` reduced to its structural keys (`langgraph_node`, `lc_agent_name`, `langgraph_step`, `thread_id`, ...).
Everything else is dropped, notably: HTTP request / response bodies and headers (`authorization`, `cookie`,
`x-api-key`, `*signature*`, `x-*-email`, ...), `url.full` / `http.url` / `url.path` / `url.query` / `http.target`,
`messaging.message.body` / payloads, `db.statement` / `db.query.text` (the operation and read / write are derived first),
websocket message payloads, GenAI prompts, completions, messages, tool args and results (`input.value`,
`output.value`, `gen_ai.*.messages`, `gen_ai.tool.call.*`), `exception.message`, stack traces, client IPs, user
agents, and any custom attribute. Derived before dropping: `server.address` / `port` from a full URL; for a server
request without a route template, `http.route` = the path with id-like segments (numbers, UUIDs, hex / token ids,
emails, phones) replaced by `{id}` and the query dropped (`/users/42?x=1` -> `/users/{id}`). Span names get the same
path normalization. Every kept string value and the span name then pass a regex backstop: emails -> `[email]`, E.164
phone numbers -> `[phone]`, digit runs of 9+ -> `{id}` (not in `*.id` / `*_id` / offset / port keys), secrets ->
`[redacted]`; the list is `scrub.PII_PATTERNS`, replace it with `watch(pii_patterns=[(regex, replacement), ...])`.
Options: `allow=["app.*"]` keeps extra keys (fnmatch); `allow_message_keys=["attempt"]` keeps `messaging.*.<key>`
attributes and top-level keys of a JSON message body (as `messaging.message.<key>`, scalar values only);
`error_messages=True` keeps `exception.message` (scrubbed, max 120 chars); `scrub=fn(attrs) -> attrs` runs last on
every exported span (an exception in it keeps the built-in result). Strict mode also drops agent text of agents
running inside the service (final answers, tool args): use `privacy="standard"` when you need them.

**Server backstop (`scrub.backstop_span`, every span from every source: live, OTLP JSON / protobuf).** Dropped:
`url.full`, `http.url`, `url.path`, `url.query`, `url.fragment`, `http.target`, `db.statement`, `db.query.text`,
`db.query.parameter.*`, `exception.stacktrace`, `http.request.header.*`, `http.response.header.*`, RPC metadata,
HTTP / messaging bodies and payloads, `websocket.*`, user agents, client addresses, and any HTTP / DB / messaging key
naming a signature, authorization, cookie or API key. Derived first (same as strict): server address, route template,
DB operation. URL credentials are stripped from every URL value (`redis://user:pass@host` -> `redis://host`) and
`exception.message` is capped at 120 chars (PII replaced). A span with HTTP / URL / DB / messaging / RPC / network
attributes gets its name path-normalized and PII-replaced; its values too unless it is an LLM / agent span
(`gen_ai.*`, `llm.*`, `openinference.*`, `input.value` / `output.value`: agent text follows the rules above). Agent-only
spans carry none of these keys and are unchanged (regression goldens).

## World events (backend → frontend)
Source of truth: `WorldEvent` in `frontend/src/scenes/shared/world.ts`:
`run, step, spawn(subagent?), exit, agent, llm, message, tool, graph, mcp_register, mcp, final, skill, chat, decision,
decision_stats, order, request, service_stats, drives, session, stage, progress, capacity, rejected, job, deferred, fallback, gate,
backlog, lifecycle, metric, event, resource_stats` (the last 14: see "Generic primitives"). `ts` = epoch ms.
`request` = `{"type": "request", "run_id", "id": <service agent id>, "service", "name", "kind": "http"|"rpc"|"message"|"event",
"status"?, "error", "rejected"?, "ms", "ts", "hv"?}` (`rejected: true` = turned away on purpose, `agentglow.rejected()`: never an
error, counted as `codes.rejected` in `service_stats`, not as `5xx`) and `service_stats` (`"instances"?` when > 1): see "Backend services".
`message` may carry `"failed": true` (a publish that raised: the comet is short and flagged `failed` in the world so
themes can fizzle it; the HUD logs `api ✕ orders: publish failed`). Frontend: a request pulses its service,
an error flashes the service halo red; `service_stats` drives the same halo as `decision_stats` (arc: ok green, 5xx /
errors red, 4xx amber) with the label `api · 42 req/s · 2% errors` (`msg/s` for a consumer; the error share only when
> 0; latency and open requests in the Selected panel and the label's hover tooltip), always shown on a service (it is never one of the
top-3 decision halo labels). A service with no requests / messages for 30 s (or none since it appeared) is quiet: dimmed
like an idle run's agents and labelled `api · idle`; its next request / message brightens it and brings the rate back. `message` comets between two services draw a persistent edge labelled with the topic
(`mkt:tick`, fading 15 s after its last message) with at most one bright comet per ~0.4 s, and a service node is a bit
bigger than a run's root agent; the HUD counts `N req · M err`. A job (`spawn` with `job: true`) rings its service like
any subagent, its name label shows the elapsed time from `since` (`mkt:tick · 2m14s`), its halo flashes green when it
ends done / red when it fails, and the Selected panel of a service lists its in-flight jobs.
`chat` (opt-in prompt capture only, see Privacy) = `{"type": "chat", "run_id", "id": <main agent instance id>,
"role": "user"|"agent", "text", "ts"}`: the user's prompt, then Claude's reply for that turn (the agent panel shows
them as a "you: / claude:" conversation).
`skill` = `{"type": "skill", "run_id", "id": <agent instance id>, "name": <skill name>, "status": "start"|"end", "ts"}`:
an agent (main or subagent) started / finished using a skill.
`decision` / `decision_stats` = see "Decisions"; `order` = see "Orders".
`llm` token convention (every source): `tokens_in` = ALL prompt tokens, cached ones included (uncached input + cache
writes + cache reads); `tokens_out` = completion tokens. `llm` may carry `tokens_cached` (the cache-read subset of
`tokens_in`) and `tokens_cache_write` (the cache-write subset) when known; they are never added on top of `tokens_in`.
`run` may carry status `renamed` (same `run_id`, new `topic`, e.g. a Claude Code session /rename): relabel only.
`run` status `idle` = `{"type": "run", "run_id", "status": "idle", "since": <epoch ms of its last event>, "ts"}`: an open
agent run published no event for `AGENTGLOW_IDLE_DIM_MIN` minutes (server env, float, default 3, `0` = off; server-side
so every viewer agrees). Never for the backend services run, nor while the run is quiet on purpose: an open wait
(`agentglow.wait` / approval / sleep, Hatchet durable wait), a parked step, or an open `session` / `job` primitive span.
`run` status `active` (`{"type": "run", "run_id", "status": "active", "ts"}`) goes out right before the next event of an
idle run. Both are relabel / dim only (the run stays open); replay keeps an open run's latest `idle`. Viewers dim an idle
run's agents and show `idle · 4m` on its label. `completed` / `failed` may carry `reason` (`abandoned`: a Claude Code
session closed for silence, below).
`step` may carry status `waiting` with `reason` (wait label) and optional `until` (epoch ms); `agent` status `waiting` may
carry the same `reason` / `until` (see "Waits and long-running runs").
`mcp` result events may carry `"error": true` (the MCP / backend client / lease / inference span ended with error status, an
HTTP client got a 5xx, or a flat `call` had an error status) and `"status": <int>` (HTTP client calls and flat `call` with
a numeric `status`: the code only, never the URL). Both are omitted otherwise, so agent-only output is unchanged.

### Resource details
MCP servers / resource groups are drawn by the shared kit in every theme (`kit/Crystal.tsx`): a faceted crystal labelled
"MCP · <name>" / "ML · <name>" with each resource as a satellite on its own tilted orbit (name at its kit slot, tethered),
tinted per theme (`KitScene` `mcpStyle`). Every non-agent icon is clickable in all themes (shared kit `kit/Picks.tsx`): an MCP server / resource group, each of
its resources (satellites: databases, caches, queues, HTTP hosts, models, pools) and each agent / service -> server
link used in the last 30 s. Hover = pointer cursor + highlight ring / line; click = the Selected panel shows "Resource
details"; Esc, "back" or a click on empty space closes it. No new server events: the UI aggregates the `mcp` call /
result events it already receives (`resinfo.ts`, per server, per `server|resource`, per `agent|server`, since the page
loaded or the replay began) and reads `resource_stats` / `backlog`:
- generic: kind icon, name, owner service (top service caller), calls, errors, p50 / p95 latency, rate (calls/s over the
  last minute), last seen, a 60 s traffic sparkline, top callers (each opens its link), the 25 most recent calls (caller,
  tool / operation, duration, ok / status / error, time ago);
- MCP server / group: tools table (calls, p50, p95, errors) and its resources; link: operations on that link, resources
  reached, last call;
- database / warehouse / storage: operation mix by verb (first word of the operation: `SELECT`, `INSERT`, `MATCH`) and
  the slowest operations by p95; cache: hit ratio (`resource_stats` hits / misses, else `hit` / `miss` calls) and command
  mix; queue / topic: publish vs consume rate, depth / lag / consumer from `backlog`; HTTP host: method and status-class
  mix (host only); model: units scored, RTF, device, last latency; pool: capacity, in use, waiters, wait p50, devices;
- service agents: their Selected panel adds a Service section (replicas, handled, errors, p50 / p95, status mix, routes
  from `service_stats`, backends used); jobs keep their job section (state history, stages, progress + ETA, spawned by).
Only labels the server already sent through the privacy pipeline appear: operation names, hosts / systems, status codes,
latencies; never statements, keys, URLs with ids, arguments, results or bodies. Backend service calls are rate-limited to
one per (agent, resource) per 250 ms on the server, so counts there are a lower bound.
`?debugpicks` (app URL) publishes the click targets' screen positions as `window.__agentglowPicks` (browser tests).

## Frontend (`frontend/`, npm `agentglow`)
- App build: gallery at `/`, `/<theme>`; data source = same origin `/live/stream` (`?source=<url>` override, `?sim=1` simulator, `?sim=hf` high-frequency simulator (30 market agents, ~100 decisions/s, paper orders), `?hud=0` hide HUD, `?run=<id>` one run). Output copied to `backend/agentglow/static/`.
- Library build: `export { AgentScene, THEMES, THEME_INFO }` + types `AgentSceneProps`, `Theme`, `WorldEvent` - `<AgentScene theme="neural" source="http://…:8100" hud={true} sim={false|true|"hf"} scope run token style className />`; react/react-dom are peerDependencies; ships types. Extra entries: `agentglow/node` (Node.js `watch()`, `spanProcessor()`; see "Backend services") and `agentglow/pulse` (flat events), both without React / three.js; `agentglow/style.css`.
