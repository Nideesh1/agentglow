<div align="center">

# AgentGlow

**Watch your AI agents work live, in 3D, from the OpenTelemetry they already emit.**

[![PyPI](https://img.shields.io/pypi/v/agentglow?color=818cf8)](https://pypi.org/project/agentglow/)
[![npm](https://img.shields.io/npm/v/agentglow?color=e879f9)](https://www.npmjs.com/package/agentglow)
[![License: MIT](https://img.shields.io/badge/license-MIT-22d3ee)](LICENSE)

![AgentGlow neural theme](docs/media/hero.webp)

</div>

Agents spawn as glowing shapes, pulse on every LLM call, fan out to subagents, query MCP servers and databases,
and fade when they finish. Since 0.4.0 the backend around them shows up too: services, requests, queues, jobs and
resources, in the same scene. One line of Python (or Node). Works with **LangChain, LangGraph, deepagents, OpenAI
Agents SDK, Hatchet, MCP, FastAPI, FastStream, Next.js / Node**, and **Claude Code** itself.

## What's new in 0.4.0: watch your whole backend

- **Your whole backend:** `watch(app=)` / `watch(broker=)` / `watch(mcp=)` turn FastAPI, FastStream and FastMCP processes
  into long-lived service nodes with a `req/s · 5xx · p50` halo, publish -> consume comets labelled with the topic,
  DB / cache / HTTP calls as resource nodes, replicas as `×N`, failed publishes that fizzle mid-flight, and requests
  still open after 3 s as job nodes with a running timer.
- **Generic primitives:** sessions, stages, progress, capacity, rejections, worker / GPU pools, non-LLM inference,
  business-id jobs across processes, late callbacks, fallbacks, gates, broker backlog, lifecycle, metrics, events and
  caches. One Python call each, an OTel attribute contract for any language, and a `/v1/events` form ([table](#generic-primitives)).
- **Strict privacy by default** in backend mode: only an allow-list of structural attributes leaves your process
  (no bodies, headers, URLs with ids, SQL, payloads, prompts or exception messages), plus a server backstop. See
  [Security & privacy](#security--privacy).
- **Node.js / Next.js:** `import { watch } from "agentglow/node"` traces incoming requests and `fetch` calls and joins
  your Python services' traces.
- **7 themes**, now with **bubble chamber** (particle tracks curling in a magnetic field) and **fireworks**.
- **Trading desk flagship:** a market feed service, a FastStream tick stream, an MCP market-data server with
  auto-discovered backends, a Postgres paper ledger and a deepagents desk with human Approve / Reject, all in one scene.

Earlier releases: 0.3.0 added fast decisions, high-volume halos, durable waits with Approve / Reject and the
incident / vendor / desk demos ([release notes](https://github.com/Nideesh1/agentglow/releases)).

## Get started

Pick your path. Each one ends at **http://localhost:8100/neural** (no agents yet? try `?sim=1`).

### 1. Claude Code (only Node needed)
```bash
npx agentglow setup                  # once: hooks + traces into ~/.claude/settings.json (backed up), opens the 3D view
claude                               # then just use Claude Code as usual
```
The server runs in the background (on macOS/Linux it also starts at login and restarts on crash; on Windows it starts with each `claude` session); watch at http://localhost:8100/neural. Undo with `npx agentglow remove`.
uv and Python are fetched automatically on first run. Just trying it? `npx agentglow claude` runs one session with
AgentGlow attached and installs nothing.
Or install it as a Claude Code plugin (hooks, server auto-start, the skill and `/agentglow:open`), inside Claude Code:
```
/plugin marketplace add Nideesh1/agentglow
/plugin install agentglow@agentglow
```
Use the plugin or `npx agentglow setup`, not both for hooks (setup detects the plugin and adds only the traces env,
which plugins cannot set; without it LLM pulses show 0 tokens). Details: [examples/claude-code](examples/claude-code#claude-code-plugin).
Prefer asking Claude? Say *"show my agents in 3D"*: the plugin includes the [agentglow skill](skills/agentglow), or
install the skill alone ([Using AgentGlow with Claude Code / AI agents](#using-agentglow-with-claude-code--ai-agents)).

### 2. Python agents (LangChain, LangGraph, deepagents, OpenAI Agents SDK, Hatchet)
```bash
uvx agentglow serve                  # or: pip install agentglow && agentglow serve
uv add "agentglow[langchain]"        # in your agent project ([openai-agents] for the OpenAI Agents SDK)
```
```python
import agentglow
agentglow.watch()                    # one line, before your agents run
```
Already sending traces to Langfuse / LangSmith / a collector? Nothing changes: `watch()` adds AgentGlow alongside.
Any OTel exporter can also send OTLP/HTTP straight to `http://localhost:8100/v1/traces`.

### 3. Hand-written agent loop (no framework)
```python
async with agentglow.run(topic="Inbound call", scope=clinic_id):
    async with agentglow.agent("receptionist") as a:
        a.llm(model="gpt-realtime", tokens_in=812, tokens_out=64)
        with agentglow.tool("book_appointment", args={"slot": "Tue 10:30"}): ...
        a.final("Booked Tue 10:30")
```
Nested `agentglow.agent(...)` = subagent; also `agentglow.mcp(...)`, `agentglow.graph(...)`, `@agentglow.traced_agent`,
`@agentglow.traced_tool`. See [examples/custom-loop](examples/custom-loop).

### 4. Your whole backend (FastAPI, FastStream, FastMCP, Node, anything that can POST)
```bash
uv add "agentglow[fastapi,faststream,redis,mcp]"
```
**FastAPI** (each service = one long-lived node; requests = pulses + a req/s halo; mounted sub-apps included):
```python
app = FastAPI(title="orders-api")
agentglow.watch(app=app)
```
**FastStream** (publish -> consume = a comet between services, labelled with the topic):
```python
broker = RedisBroker(REDIS_URL)
agentglow.watch(broker=broker, service_name="orders-worker", backlog=True)  # backlog: sample the stream's depth / lag
```
**FastMCP** (an MCP server; its Redis / Postgres / HTTP calls become its backends):
```python
mcp = FastMCP("market-data")
agentglow.watch(mcp=mcp)
```
**Node / Next.js** (`npm i agentglow` + the OpenTelemetry peers, see [frontend/README.md](frontend/README.md#nodejs-services)):
```ts
import { watch } from "agentglow/node";
watch({ service: "web-bff" });          // Next.js: inside register() in instrumentation.ts, when NEXT_RUNTIME === "nodejs"
```
**No OTel at all:** `pulse()` from Python, or POST flat events from anything:
```python
agentglow.pulse("billing", "invoice.paid", status=200, duration_ms=12)
```
```bash
curl -X POST localhost:8100/v1/events -H 'content-type: application/json' \
  -d '{"service": "checkout", "event": "request", "name": "POST /pay", "status": 200, "duration_ms": 42}'
```
JS / TS: `import { pulse } from "agentglow/pulse"`. LLM calls and agents inside a request show on (or under) their
service; pure agent traces look exactly as before. Examples: [fastapi-faststream](examples/fastapi-faststream),
[node-proxy](examples/node-proxy); details in [docs/SPEC.md "Backend services"](docs/SPEC.md#backend-services-backend-backendpy).

### 5. The full demo stack (Hatchet + deepagents + MCP + FalkorDB)
```bash
cp .env.example .env                 # add one LLM key (OpenAI, Anthropic or Gemini) - that's all the setup
docker compose up                    # then open http://localhost:8101 and press ▶ Run agents
```
Pick a workflow next to the button: **Trading desk** (the flagship: feed service, tick stream, MCP market data, paper
ledger, Approve / Reject), **Incident triage** (a runbook skill, parallel steps across two MCP servers, a review that
fails once and retries, a postmortem), **Vendor consolidation** (long-running, durable waits) or **Churn brief**.
Optional Langfuse side by side: `./scripts/gen-obs-env.sh` then `LANGFUSE_EXPORT=1 docker compose --profile langfuse up -d`.

▶ [Watch the demo in HD](docs/media/hero.mp4)

## Using AgentGlow with Claude Code / AI agents

The [agentglow skill](skills/agentglow/SKILL.md) teaches Claude Code (or any agent that reads skills) to set up and use
AgentGlow: watch Claude Code, instrument Python agents, FastAPI / FastStream / FastMCP and Node services, send events
over HTTP or OTLP, embed `<AgentScene/>`, run the demo stack and troubleshoot. It ships in the plugin, or install it
alone (SKILL.md + its [references](skills/agentglow/references)) with the snippet in
[skills/agentglow/README.md](skills/agentglow/README.md). Then ask e.g. *"instrument this FastAPI + FastStream repo
with AgentGlow"*. Other agents: [llms.txt](llms.txt) indexes the docs. Working on AgentGlow itself? Read
[CLAUDE.md](CLAUDE.md) (also [AGENTS.md](AGENTS.md)).

## Generic primitives

Small building blocks for what a trace alone does not say. Each is a plain OTel span (no SDK provider = no-op), carries
numbers, ids and short labels only, and has a `/v1/events` form ([docs/SPEC.md](docs/SPEC.md#generic-primitives-backend-primitivespy)).

| Primitive | Python | In the scene |
|---|---|---|
| session | `with agentglow.session("support chat", kind="ws") as s:` | a live node with a timer, turns and gauges (WebSocket routes automatic with `watch(app=)`) |
| stage | `with agentglow.stage("decode"):` | `decode` on the owner's status line; parallel stages show together |
| progress | `agentglow.progress(3, 10)` | a progress arc with an ETA |
| capacity | `agentglow.capacity("slots", used=3, max=4)` | `cap 3/4` gauge |
| rejected | `agentglow.rejected("busy", retry_after=2)` | amber flash; the 429 / 503 is backpressure, not an error |
| pool | `async with agentglow.pool("whisper", size=2, kind="gpu").lease():` | a resource node with `2/4 busy · wait 12ms` |
| inference | `with agentglow.inference("whisper-small", units=12.5, unit="audio_s"):` | a model resource with call pulses and RTF; `group="fraud scorer"` (or env `AGENTGLOW_RESOURCE_GROUP`) labels its group "ML · fraud scorer" instead of "MCP · backend" |
| job | `agentglow.job(order_id, state="queued")` / `with agentglow.job(order_id, attempt=2):` | one `job:<id>` node across processes: queued, running, retrying #2, done, dead |
| link / complete | `agentglow.link(charge_id)` ... `agentglow.complete(charge_id)` | `awaiting` on the caller, a green edge when the webhook completes it |
| fallback | `agentglow.fallback(from_="inline", to="queue", reason="timeout")` | a dashed amber edge |
| gate | `agentglow.gate("refunds", state="locked", attempts_left=2)` | a lock badge until unlocked |
| backlog | `agentglow.backlog("orders", depth=42, lag_ms=1200)` | a ribbon between producer and consumer (`orders 42 · lag 1.2s`) |
| lifecycle | `agentglow.lifecycle("ready")` | a tint ring: loading, warming, ready, degraded, draining, restarting, fatal |
| metric | `agentglow.metric("shipped", 12, unit="orders/min")` | a value on the node's panel |
| event | `agentglow.event("signup", label="trial")` | a business event chip |
| cache | `agentglow.cache("catalog", hit=True)` | a cache resource with hit rate |
| outcome | `agentglow.mark_error("vendor timeout")` / `mark_outcome("failed")` | a swallowed failure still shows the request red |

**Decorators.** Every `with` primitive is also a decorator (sync, async, generators, methods), a fresh span per call;
arguments and return values are never recorded, values only come in through explicit callables:

```python
@app.post("/orders/{order_id}/fulfil")                     # framework decorator first, agentglow below it
@agentglow.job(id=lambda order_id, **_: order_id, kind="fulfil")
async def fulfil(order_id: str): ...

@agentglow.stage("pick")                                   # also @agentglow.traced: a step of the caller
async def pick(order): ...

@agentglow.decision("noul", "safe without human?", purpose="guard")
def safe(order) -> tuple[bool, float]: ...                 # the return value is the decision (yes/no, p)

@gpu.lease()                                               # also session, inference(units=callable), agent, tool
def transcribe(audio): ...
```

**Human approval.** `agentglow.approval(...)` shows a wait on a person under "Needs you" with Approve / Reject and a
details drawer (why, your fields, recent decisions and tools, a note, "Open in app", "Copy link"); the buttons call
your `AGENTGLOW_APPROVE_WEBHOOK`, which resumes the work. `agentglow.wait(...)` is the same for any other wait:

```python
async with agentglow.approval(timeout_s=900, title="Refund $420 · order 1182", details={"amount_usd": 420},
                              url="https://admin.example.com/refunds/1182", because=guard_decision):
    await refund_approved.wait()                           # your event / flag: AgentGlow only shows the wait
```

## 7 themes

New in 0.4.0: **bubblechamber** (agents and services as particle tracks curling in a magnetic field) and **fireworks**
(every pulse a burst). Open any theme at `/<name>`, e.g. http://localhost:8100/bubblechamber, and add `?sim=1` or `?sim=hf` for a
built-in simulation.

| | | |
|:-:|:-:|:-:|
| ![neural](docs/media/neural.jpg) **neural** | ![constellation](docs/media/constellation.jpg) **constellation** | ![orbit](docs/media/orbit.jpg) **orbit** |
| ![atom](docs/media/atom.jpg) **atom** | ![flow](docs/media/flow.jpg) **flow** | ![bubblechamber](docs/media/bubblechamber.jpg) **bubblechamber** |
| ![fireworks](docs/media/fireworks.jpg) **fireworks** | | |

## In your React / Next.js app

```bash
npm i agentglow
```
```tsx
import { AgentScene } from "agentglow";

<div style={{ height: 600 }}>                {/* the scene fills its container - give it a height */}
  <AgentScene theme="neural" source="http://localhost:8100" />
</div>
```
| Prop | Default | |
|---|---|---|
| `theme` | `"neural"` | one of the 7 themes: `neural`, `constellation`, `orbit`, `atom`, `flow`, `bubblechamber`, `fireworks` |
| `source` | `""` (same origin) | your `agentglow serve` URL (default port 8100). In a deployed app, use a URL your users' browsers can reach, e.g. `https://agentglow.yourco.com` |
| `hud` | `true` | overlay panels (title, agent list, event log, stats); `hud={false}` = just the 3D scene |
| `sim` | `false` | built-in fake agents, no server needed (also kicks in automatically if `source` is unreachable) |
| `style` | - | inline styles for the container, e.g. `{{ height: "80vh" }}` |
| `className` | - | CSS class for the container |
| `scope` / `run` | - | show only one user's/tenant's runs, or a single run (see [Security](#security--privacy)) |
| `token` | - | viewer token minted by your backend; sent as `Authorization: Bearer` |
| `clearable` | `true` | HUD **Clear view** button + Shift+C: hide everything on screen for this viewer only, then draw only new activity (`cleared · show all` undoes it; survives a refresh) |
| `clearedAt` | - | controlled clear: epoch ms = clear at that moment, `null` = show everything |

```tsx
<AgentScene theme="constellation" sim hud={false} style={{ height: 400 }} />   // demo background, no server
```
Works in Next.js App Router out of the box (the package is `"use client"`). See [examples/react-embed](examples/react-embed).

## Security & privacy

### Multi-user

Everything is open by default for local dev. For a shared or public deployment, turn on what you need:

| | Server | Producers / viewers |
|---|---|---|
| **Ingest key** (who can send spans) | `AGENTGLOW_INGEST_KEY=k1,k2` (comma list = rotation) | `agentglow.watch(api_key=...)` or `AGENTGLOW_API_KEY`; OTLP: `OTEL_EXPORTER_OTLP_HEADERS="x-api-key=..."`; Claude Code reads `$AGENTGLOW_API_KEY` |
| **Viewer tokens** (who sees what) | `agentglow serve --secret $AGENTGLOW_SECRET` | your backend mints `agentglow.make_token(secret, scope=..., run=..., ttl_s=3600)`; the scene sends it as `Authorization: Bearer` |
| **Scopes** (show each user only their agents) | runs tagged with `with agentglow.scope(user.id):` | `<AgentScene scope={user.id} token={token} />`; one run: `run="<id>"` or `/neural?run=<id>` |

```python
import agentglow
agentglow.watch(api_key=os.environ["AGENTGLOW_API_KEY"])
with agentglow.scope(user.id):        # every span inside (incl. asyncio tasks) carries agentglow.scope
    graph.invoke({"messages": [...]})

token = agentglow.make_token(os.environ["AGENTGLOW_SECRET"], scope=user.id, ttl_s=3600)  # no scope/run = admin
```
```tsx
<AgentScene source="https://agentglow.yourco.com" scope={user.id} token={token} />
```
Tokens and keys always travel in headers, never in URLs. Not using Python on the backend? The token is a 3-line HMAC,
see [docs/SPEC.md "Scopes & auth"](docs/SPEC.md#scopes--auth).

### Privacy

**Every ingestion path** drops identity attributes (emails, user / account / org ids) and raw user prompts and redacts
secret-looking values before anything reaches the stream ([docs/SPEC.md](docs/SPEC.md#privacy)). Keep
patient / customer data (names, phone numbers, ids) out of agent names, tool args and final text.

**Backend mode is strict by default.** `agentglow.watch(app=..., broker=..., mcp=...)` and `agentglow/node` keep only
an allow-list of structural attributes before a span leaves your process:

| Kept | Dropped |
|---|---|
| route templates, methods, status codes, peer host:port | request / response bodies and headers (cookies, authorization) |
| DB system / operation / collection | SQL / Mongo statements, connection string credentials |
| message destination / id / size | message payloads |
| model names, token counts | prompts, completions, tool args and results |
| `agentglow.*` labels (primitives: numbers, ids, enums) | URLs and paths with ids, query strings, client IPs, user agents |
| `error.type` | exception messages and stack traces |

Emails, phone numbers and long digit ids left in names are replaced. The server applies the transport part again as a
backstop for every source (OTLP too). Tune it per process:
```python
agentglow.watch(app=app, broker=broker,
                ignore=["GET /v1/models", "/internal/*"],  # never exported, with children; added to health checks + idle Redis polls
                allow_message_keys=["attempt"],             # message fields you want to see
                allow=["tenant.tier"],                      # extra attribute keys (fnmatch)
                scrub=lambda attrs: attrs)                  # your own last-pass hook
```
`privacy="standard"` exports spans unchanged (the server backstop still runs). Full allow-list:
[docs/SPEC.md "Privacy" > "Backend mode"](docs/SPEC.md#backend-mode-watchapp--broker--mcp).

**Your own prompts (opt-in, local only):** `npx agentglow setup --capture-prompts` (or `AGENTGLOW_CAPTURE_PROMPTS=1
agentglow serve --host 127.0.0.1`) keeps your Claude Code prompts, secrets redacted and capped at 2000 chars, so the
agent panel shows each turn as "you: ... / claude: ...". Off by default. It only works when the server listens on
loopback (`127.0.0.1` / `localhost` / `::1`); on any other host the flag is ignored with a startup warning, so a
shared server never receives prompts. `npx agentglow status` shows `prompts: captured (local only)` when it is on.

## What shows up

| Your system | In the scene |
|---|---|
| agents / subagents | shapes that spawn, think, wait and exit - subagents smaller, linked to their parent with directional edges |
| LLM calls | pulses sized by tokens |
| tool & MCP calls | MCP server + its backends (Postgres, Snowflake, Spark…) appear at the side when first called, with data-flow arrows; idle ones fade away |
| DB / graph queries (`db.system`) | a knowledge graph appears at the side once agents read or write it (real nodes from FalkorDB if configured) and fades out with the run |
| handoffs | agents chained with a message along the edge |
| skills (Claude Code, deepagents and OpenAI Agents skills, `agentglow.skill`) | a `skill:name` ring on the agent using it |
| Hatchet workflow runs | runs and their steps, whatever they are named, including parallel steps and retries |
| durable waits (approvals, sleeps) | the run stays open; the step and agent show `waiting on approval` / `sleeping until ...` |
| fast decisions (Jev, Laya, an LLM judge, code guards; `agentglow.decision`) | route fans with per-option %, guard gates (a red `BLOCKED` on a deny), check rings, with provider and latency |
| many decisions per second | per-agent halos (`jev 42/s · 3% deny`, latency on hover); only denies, flips and unsure guards pop individually |
| orders (`agentglow.order`) | BUY / SELL chips, dashed `paper` when dry-run |
| backend services (FastAPI, FastStream, FastMCP, Node, any OTel HTTP / messaging spans, `POST /v1/events`) | one long-lived node per service with a `42 req/s · 2% errors` halo (`×3` for replicas), background tasks as subagents, DB / cache / HTTP calls as resource nodes, errors flash red; the services stay expanded next to your agent runs |
| messages between services | comets along publish -> consume edges labelled with the topic; a failed publish fizzles out half way |
| long requests (open past `AGENTGLOW_JOB_MS`, 3 s) | a job node ringing its service with a running timer (`orders · 27s`), owning the calls inside it; `N in flight` in its panel and halo tooltip |
| business jobs (`agentglow.job(id)`) | one `job:<id>` node that moves from API to worker, with state, attempts, retries and dead letters |
| sessions (WebSockets, calls, chats) | a live node with a timer, turns and gauges, ending with its outcome |
| stages / progress | status line under the node (`pick + pack`, `42% · ETA 8s`) and a progress arc |
| pools / inference | worker and GPU pool resources (`2/3 busy · wait 12ms`), model resources with RTF |
| resource details | click any MCP server, backend (DB, cache, queue, HTTP host, model, pool) or agent -> server link: calls, errors, p50 / p95, rate, top callers, recent calls, sparkline, plus tools / operation mix / hit ratio / status mix / units / capacity per kind (scrubbed labels only); Esc closes |
| broker backlog | a ribbon between producer and consumer (`orders 42 · lag 1.2s`), thicker with depth |
| gates / capacity / rejections | lock badge (`locked · 2 left`), `cap 3/4`, amber flash for a 429 / 503 that is backpressure |
| lifecycle | tint ring: blue loading / warming, amber degraded, grey draining, red fatal; a pulse on restart |
| business events | chips next to the node, like orders |
| quiet runs (no events for 3 min, not waiting) | dimmed, labelled `idle · 4m`; bright again on the next event. After 30 min of silence (`AGENTGLOW_RUN_IDLE_MIN`) a run that is not waiting (its process was killed, its spans never end) is closed as abandoned and fades out; a run on an open wait / approval never is. `×` in the Selected panel hides a run for you; **Clear view** (Shift+C) hides everything on screen for you and keeps drawing only new activity |

**A Claude Code ball stays after its terminal closed?** A killed session sends no SessionEnd: it dims as idle after
3 min (`AGENTGLOW_IDLE_DIM_MIN`) and closes as abandoned after 10 min of silence (`AGENTGLOW_SESSION_IDLE_MIN`; 30 =
the old behavior); its next hook brings it back as a new ball. Hide it sooner with `×` in the Selected panel.

**Agents are always the center.** Graphs, databases and MCP servers are side resources that only show up when used, and the camera
frames everything calmly: one smooth zoom per burst of spawns, never a jittery in-and-out. Stats sit in a slim top bar;
agents, events and the selected agent live in a collapsible right sidebar.

**Hundreds of agents?** Above 12 live agents, AgentGlow auto-groups older runs into glowing clusters
("35 runs · 84 agents") and keeps the newest ~10 in full detail - click a cluster to expand it. Stays at ~60 fps with 500 live agents.

Optional span attributes make it richer: `agentglow.agent`, `agentglow.run.topic`, `agentglow.final`,
`agentglow.graph.nodes`, `agentglow.mcp.server` / `.resource` / `.resource_kind`. See [docs/SPEC.md](docs/SPEC.md).

## Examples

| | |
|---|---|
| [deepagents-hatchet: trading desk](examples/deepagents-hatchet#flagship-trading-desk) | **flagship**: a whole trading backend + its agents in one scene: a FastAPI market `feed` streaming ticks over a Redis stream (FastStream) to a Hatchet worker, a paper trading desk (one durable child run per market, rate-capped Jev gates, deepagents analysts, human Approve / Reject, kill switch), an MCP market-data server with auto-discovered backends (`watch(mcp=)`), a Postgres paper ledger |
| [deepagents-hatchet](examples/deepagents-hatchet) | the full stack: Hatchet + deepagents + MCP + FalkorDB, one `docker compose up`; also incident triage, vendor consolidation (long-running), churn brief |
| [fastapi-faststream](examples/fastapi-faststream) | your backend: a FastAPI orders API, a webhooks service, a FastStream worker on a Redis stream, a FastMCP server and a support agent, exercising every primitive (sessions, jobs with retries and dead letters, pools, backlog, gates, fallbacks); one `watch(...)` line each, no LLM key needed |
| [node-proxy](examples/node-proxy) | a Node backend-for-frontend in front of the FastAPI orders API, one `agentglow/node` line; traces join across Node and Python |
| [quickstart](examples/quickstart) | 40-line deepagents researcher with two subagents, the "just show me" path |
| [langgraph](examples/langgraph) | LangGraph supervisor with worker agents (`langgraph-supervisor` works too) |
| [openai-agents](examples/openai-agents) | OpenAI Agents SDK: handoffs + agent-as-tool |
| [custom-loop](examples/custom-loop) | no framework: a hand-written voice-call loop traced with the manual API (runs without an LLM key) |
| [react-embed](examples/react-embed) | `<AgentScene/>` in a Vite + React app |
| [claude-code](examples/claude-code) | watch **Claude Code** and its subagents in 3D via hooks (+ optional OTel traces for real token counts), no code |

Every Python example takes `AGENT_MODEL` - e.g. `openai:gpt-5.6-luna`, `anthropic:claude-sonnet-5-5`, `google_genai:gemini-3.8-flash`.

## Production

Run **one** `agentglow serve` per environment (Docker image / k8s Deployment with `replicas: 1`) and point every app
pod at it: `agentglow.watch("http://agentglow:8100")`. If it's down, your app is unaffected - spans are just dropped.
Turn on the ingest key and viewer tokens (see [Security & multi-user](#security--privacy)).

## Develop

One [uv](https://docs.astral.sh/uv/) workspace (root `pyproject.toml`, single `uv.lock`; members `backend` + the Python examples).

```bash
uv sync --all-packages                              # everything into ./.venv
(cd frontend && npm ci && npm run build:app)        # bundle the UI into backend/agentglow/static
uv run agentglow serve                              # :8100
uv run --package agentglow pytest backend/tests -q
uv build --package agentglow --out-dir dist         # sdist + wheel
```

| Path | |
|---|---|
| `backend/` | Python package `agentglow`: server, `watch()`, OTel → agent mapping, Claude Code hooks |
| `frontend/` | the 3D scenes; npm package `agentglow` + the app bundled into the Python package |
| `examples/` | real agent stacks instrumented with one line |
| `plugin/`, `skills/` | the Claude Code plugin and the agentglow skill |
| `docs/SPEC.md` | the contract: endpoints, span -> world event mapping, attributes, privacy |

Contributor notes (layout, tests, conventions, release): [CLAUDE.md](CLAUDE.md).

MIT licensed.
