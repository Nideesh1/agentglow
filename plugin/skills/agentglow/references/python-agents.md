# Python agents

## Install and run

```bash
uvx agentglow serve                       # the server + UI on :8100 (or: pip install agentglow && agentglow serve)
uv add "agentglow[langchain]"             # in the agent project
```

| Extra | For |
|---|---|
| `agentglow[langchain]` | LangChain, LangGraph (incl. `langgraph-supervisor`), deepagents (OpenInference LangChain instrumentation) |
| `agentglow[openai-agents]` | OpenAI Agents SDK (OpenInference OpenAI Agents instrumentation) |
| `agentglow[hatchet]` | Hatchet workflows (`hatchet-sdk[otel]`) |
| `agentglow[mcp]` | MCP trace-context propagation between an agent and its MCP servers (+ `watch(mcp=)`) |
| `agentglow[falkordb]` | the server's optional FalkorDB graph sample (`agentglow serve --falkor redis://host:6379/<graph>`) |

```python
import agentglow
agentglow.watch()          # once per process, before agents run
```

`watch(url=None, *, instrument=True, service_name=None, api_key=None, ...)` (backend-mode arguments: see
backend-services.md):
- `url`: default env `AGENTGLOW_URL`, else `http://localhost:8100`.
- `api_key`: default env `AGENTGLOW_API_KEY`, sent as `x-api-key` (server `--ingest-key`).
- Reuses the global OTel SDK `TracerProvider` (Langfuse, LangSmith or OTLP exporters keep working), else creates and
  installs one. Adds a `LiveSpanProcessor` that streams span starts and ends from a background thread (~50 ms
  batches, never blocks, drops when the server is down). Returns the provider. Idempotent.
- `instrument=True`: turns on, when installed and not already on, OpenInference LangChain, OpenInference OpenAI
  Agents (next to the SDK's own trace processors), OpenInference MCP propagation and Hatchet's instrumentor.

## Framework notes

| Framework | What to know |
|---|---|
| deepagents | the agent is named after `create_deep_agent(name=...)`; subagents run under the `task` tool and show as smaller children with the delegation text; skills read from `<skill>/SKILL.md` show as skill rings |
| LangGraph | name agents (`create_agent(..., name=...)`); workers called through a tool become subagents; `langgraph-supervisor` teams need nothing extra (one supervisor, workers as subagents, `transfer_to_*` hidden) |
| OpenAI Agents SDK | handoffs chain agents (`handoff → X`), `agent.as_tool(...)` = subagent, `@function_tool` = tool event; OpenAI dashboard tracing keeps working |
| Hatchet | call `watch()` at worker start-up before the worker / agents are built; each workflow run = one run, steps (parallel ones and retries too) show on it; child runs fold into their parent run; durable waits keep the run open (below) |
| anything else on OTel | any span with `gen_ai.operation.name` (`chat`, `execute_tool`, `invoke_agent`) or OpenInference kinds maps; or use the manual API |

Labels you can add to your own spans (plain OTel attributes): `agentglow.run.topic` (run title), `agentglow.final`
(final answer), `agentglow.agent` (mark a span as an agent, value = name), `agentglow.run.id`, `agentglow.step`,
`agentglow.mcp.server` / `.resource` / `.resource_kind` (`db`, `warehouse`, `spark`, `api`, `storage`, `queue`),
`db.system` + `agentglow.graph.nodes` + `agentglow.db.op` (graph read / write); optional `agentglow.graph.kinds`. Touched nodes outside the served graph sample are added to the viewer's graph and glow.

Announce an MCP server and its backends before the first call:
`agentglow.register_mcp("analytics", {"snowflake": "warehouse", "spark": "spark"})` (returns False if the server is down).

## Durable waits (Hatchet approvals, sleeps)

Wrap the wait inside the step; the step and agent show `waiting on approval` / `sleeping until ...` and the run stays
open:
```python
async with agentglow.approval(timeout_s=1800, title="Negotiate with 4 vendors", details={"vendors": 4}):
    await ctx.aio_wait_for("approval", UserEventCondition(event_key="vendor:approved"))
async with agentglow.wait("vendor reply", timeout_s=48 * 3600):
    await ctx.aio_sleep_for(timedelta(hours=48))
```
(Any language: a span with `agentglow.wait` = the reason and optional `agentglow.wait.until` = epoch ms / s / ISO-8601,
`agentglow.wait.kind = "approval"`, `.title`, `.detail.<key>`, `.url`, `.because`.) Without it, Hatchet's own
`hatchet.durable.wait_for` span is used. The HUD shows Approve / Reject on waiting agents when the server has
`AGENTGLOW_APPROVE_WEBHOOK` set (it forwards `{run_id, approve, agent_id?, step?, note?, workflow?, wait_run_id?}`).

## Manual API (hand-written loops, no framework)

Plain OTel spans; no-ops without an SDK provider. Sync `with` and `async with`. Context rides in contextvars, so
asyncio tasks created inside inherit it.

| Call | What |
|---|---|
| `agentglow.run(topic="run", run_id=None, scope=None, workflow=None)` | a run (always a new trace); `.final(text)` |
| `agentglow.agent(name, final=None, task=None, parent=None)` | an agent; nested in another (or `parent=`) = subagent, `task` = delegation text |
| `a.llm(model="llm", tokens_in=0, tokens_out=0, latency_ms=0)` | one finished LLM turn on agent `a` |
| `agentglow.llm(model="llm", tokens_in=None, tokens_out=None)` | an LLM turn as a block; `.set_tokens(i, o)` |
| `agentglow.tool(name, args=None)` | a tool call; `.result(value)` |
| `agentglow.mcp(server, tool=None, resource=None, kind="api", args=None)` | an MCP / backend call (kind `db`, `warehouse`, `spark`, `api`, `storage`, `queue`) |
| `agentglow.graph(op="read", nodes=None, system="graph", kinds=None)` | a knowledge-graph / DB read or write; `kinds` (parallel to `nodes`) colors nodes the viewer adds outside its graph sample |
| `agentglow.skill(name)` | a skill ring on the current agent while the block runs |
| `agentglow.decision(kind, question, result=None, p=None, options=None, provider="llm", purpose=None, target=None, important=False, scope=None)` | a fast decision block; `.record(result, p=None, options=None, target=None)`. kind `choice` / `score` / `noul`; purpose `route` / `guard` / `check`; `scope="global"` = desk-wide halt |
| `agentglow.decided(kind, question, result, p=None, ..., latency_ms=0)` | one finished decision |
| `agentglow.order(side, qty, price=None, status="would_place", instrument=None, dry_run=True, reason=None)` | a BUY / SELL / YES / NO chip (`dry_run` = paper) |
| `@agentglow.traced_agent("name")`, `@agentglow.traced_tool("name", capture_args=False)` | decorators (sync and async) |
| `agentglow.current_agent()` | the agent (or session) of the current context |

Agent methods: `.say(text)`, `.final(text)` (top-level agent: the run's final text; subagent: its result message),
`.llm()`, `.tool()`, `.mcp()`, `.graph()`, `.skill()`, `.decision()`, `.decided()`, `.order()`, `.agent()`.

```python
async with agentglow.run(topic="Inbound call", run_id=call_id, scope=clinic_id):
    async with agentglow.agent("receptionist") as a:
        a.llm(model="gpt-realtime", tokens_in=812, tokens_out=64)
        with agentglow.tool("lookup_patient") as t:
            with agentglow.mcp("clinic-db", tool="query", resource="Postgres", kind="db"): ...
            t.result("found")
        async with agentglow.agent("scheduler", task="find a slot") as s:
            with agentglow.graph("write", nodes=["Appointment"]): ...
            s.final("Tue 10:30")
        a.final("Booked Tue 10:30")
```
Text passed to `say` / `final` / `task` / `args` is shown after a secrets-only scrub: keep personal data out.
Full example: `examples/custom-loop/main.py` (no LLM key needed).

## Show each user only their runs

```python
with agentglow.scope(user.id):            # or agentglow.set_scope(user.id); tags every span started inside
    graph.invoke({"messages": [...]})
token = agentglow.make_token(os.environ["AGENTGLOW_SECRET"], scope=user.id, ttl_s=3600)   # for <AgentScene token />
```
Server: `agentglow serve --secret $AGENTGLOW_SECRET` (viewers need the token). See events-http.md "Auth".
OTLP-only setups (no `watch()`): add `agentglow.ScopeSpanProcessor()` to the provider before the exporters.
