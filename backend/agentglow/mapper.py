"""Span lifecycle → world events (the `WorldEvent` contract in frontend/src/scenes/shared/world.ts).

Feed it span starts and ends (`feed("start"|"end", span)`), or a batch of finished OTLP spans (`feed_ended`).
Agent detection, verified against real deepagents + OpenInference spans (tests/fixtures/deepagents_spans.json):

- OpenInference sets NO attributes at span start (kind, metadata, input all arrive at end). So at start we
  detect structurally: a LangGraph agent graph span is the parent of LangGraph node spans (`model`, `tools`,
  `agent`, `*Middleware.before_agent`, ...); the span's name is the agent's `name=`. At end we confirm/catch up
  via `metadata.lc_agent_name == span name` with no `langgraph_node` (node spans carry their owner's name).
- Nodes are tagged `openinference.span.kind=AGENT` too (e.g. `PatchToolCallsMiddleware.before_agent`), so
  OpenInference AGENT only counts when the span is not a LangGraph node.
- deepagents subagents: agent graph span whose parent is the `task` TOOL span (child of the parent's `tools`
  node) → `subagent: true`. Delegation text = the parent LLM's `task` tool call args (subagent_type, description).
- LLM: kind LLM / gen_ai chat ops, or (at start) child of a `model` node. Tool: kind TOOL / execute_tool, or
  (at start) child of the `tools` node.

OpenAI Agents SDK via openinference-instrumentation-openai-agents (tests/fixtures/openai_agents_spans.json):

- Kinds ARE set at start. The SDK trace itself becomes an AGENT span named after the workflow ("Agent workflow"),
  parent of a CHAIN task span, parent of one AGENT span per agent (name = agent name) → `turn` → `response` (LLM)
  / function (TOOL) / `handoff` (TOOL, renamed `handoff to X` at end). So an AGENT-kind span with no agent above it
  is only a *candidate*: if an agent span starts below it, it's a workflow container (never spawned); if an
  LLM/tool starts below it first, it's an agent. Unresolved at end → agent.
- Handoffs: agent spans are siblings under the container → the run's previous top-level agent becomes the parent
  (`handoff → X` message). The `handoff` tool event is named after the model's `transfer_to_*` call.
- `agent.as_tool`: the nested run's agent span sits under the function TOOL span → `subagent: true`, delegation
  text = that tool call's input. Agent spans carry no output: exit text / run final = the agent's last LLM text.

langgraph-supervisor (tests/fixtures/langgraph_supervisor_spans.json): the compiled team graph R has one node span
per agent. The supervisor is a subgraph node (`supervisor` node → `supervisor` graph → `agent`/`tools`), re-entered
every turn; workers are `<name>` node → `call_agent` → `<name>` graph. Once the supervisor's first `transfer_to_*`
tool starts, R becomes a *team*: the first supervisor graph is THE supervisor instance (exit deferred to R's end),
later same-name supervisor graphs under R are aliases of it, and any agent graph under R is its subagent (delegation
text = the supervisor's text that turn, else the latest user request). Handoff tools emit no `tool` event; the
supervisor is `waiting` while a worker runs. Prebuilt react agents' `agent` node has CHAIN children (RunnableSequence,
call_model, should_continue): only spans whose kind is LLM (or unknown) produce `llm` events.

Long-running Hatchet runs (durable tasks, docs/SPEC.md "Waits"): a run stays open while any of its spans is open, which
includes waits. A wait is a span with `agentglow.wait` = what it waits on ("approval", "vendor reply", or "sleep" for a
timer), optionally `agentglow.wait.until` = deadline / wake-up time (epoch ms, epoch s, or ISO-8601), set at span start;
or HatchetInstrumentor's `hatchet.durable.wait_for` span (`ctx.aio_wait_for` / `aio_sleep_for` / `aio_wait_for_event`,
signal key `sleep:<N><s|m|h>-<i>` or `event:<key>-<i>`; it carries only `hatchet.step_run_id`, so the run comes from the
step span with that id). While a wait is open: `step` status `waiting` (+ `reason`, `until`) and the owning agent (if any)
`agent waiting` (+ `reason`, `until`); when it ends the step is `running` again. Hatchet evicts a durable task that waits
longer than its eviction TTL (default 15 min): the task is cancelled, so the wait and its step end together (status
unset) and the step restarts later with the same step run id. A step that ends with its wait (within PARK_SLACK_MS)
therefore stays `waiting` (parked) until a step starts again; a parked run is held until the wait's deadline + the idle
grace, else until RUN_MAX_IDLE_MS. Only when nothing is open and nothing is parked does the idle grace apply. Any run
with no span activity for RUN_MAX_IDLE_MS (default 24 h) is completed so nothing leaks. Child workflow runs
(`hatchet.parent_workflow_run_id` of a run still open, or a step span whose OTel parent, the traceparent the SDK injects
when a task triggers it, is in another open Hatchet run) fold into their parent run as subagents of the agent that
triggered them; parallel instances of one step name (fan-out) keep the step `running` until the last one ends.

Decisions (docs/SPEC.md "Decisions"): a span with `agentglow.decision` = choice | score | noul (+ `.question`, `.result`,
`.p`, `.options` JSON [{name, p}], `.provider`, `.purpose`, `.target`) is a fast structured decision (Jev / Laya / an
LLM-as-judge) of its owning agent: one `decision` event when it ends (`ms` = its duration, options top 5 by p, labels
via scrub.decision_text). It is never classified as an LLM or tool span itself. At high rates (hv.py) a busy agent's
decisions are aggregated into `decision_stats` once per tick; only interesting ones still go out individually.

Orders (docs/SPEC.md "Orders"): a span with `agentglow.event` = order (+ `agentglow.order.side`, `.qty`, `.price`,
`.status`, `.instrument`, `.dry_run`, `.reason`) → one `order` event of its owning agent when it ends.

MCP backend spans (`agentglow.mcp.*`, from the MCP server's process) can reach the server before the caller's tool span:
one whose parent is not known yet is held until the parent arrives, and dropped after ORPHAN_MS (never a run of its own).

Backend services (docs/SPEC.md "Backend services", backend.py): a request (HTTP SERVER span) or handled message (CONSUMER
span) is a pulse on its service's long-lived agent; DB / cache / HTTP CLIENT spans inside it (or inside an MCP tool span
that names no backend) light up resources. Only those spans are handled there: agent-only traces map as before.
"""
from __future__ import annotations

import json
import os
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .backend import Services, entry_kind
from .hv import DecisionRate
from .primitives import SIGNAL, Prims
from .scrub import SKILL_KEY, decision_text, session_title, skill_name, step_name, wait_details, wait_url

LLM_OPS = {"chat", "text_completion", "generate_content"}
LG_NODES = {"model", "tools", "agent", "call_model", "__start__", "__end__"}
LG_NODE_RE = re.compile(r"Middleware\.|\.(before|after)_(agent|model)$|^__")
LLM_PARENTS = {"model", "agent", "call_model"}
RESOURCE_KINDS = {"db", "warehouse", "spark", "api", "storage", "queue"}
WRITE_RE = re.compile(r"\b(CREATE|MERGE|SET|DELETE|INSERT|UPDATE|REMOVE|DROP)\b", re.I)
TEXT_RE = re.compile(r'"(?:content|text)":\s*"((?:[^"\\]|\\.)+)"')
SKILL_MD_RE = re.compile(r"^(.*/)?(?P<skill>[^/]+)/SKILL\.md$")  # deepagents: read_file of <skill dir>/SKILL.md
FILE_PATH_RE = re.compile(r"""['"]file_path['"]\s*:\s*['"]([^'"]+)['"]""")
MAX_SKILL_SETS = 1024
DECISION_KEY = "agentglow.decision"
DECISION_KINDS = {"choice", "score", "noul"}
MAX_DECISION_OPTIONS = 5
EVENT_KEY = "agentglow.event"
ORDER_KEY = "agentglow.order"
ORDER_STATUSES = {"would_place", "placed", "filled", "rejected", "cancelled"}
SHELL_TOOLS = {"shell", "exec_command", "local_shell", "bash", "run_shell_command"}
# a shell READ of a skill file (no redirect/pipe between the reader and the path); `sed -i` is a write, see _shell_skills
SHELL_SKILL_RE = re.compile(r"\b(?:cat|sed|head|less|more|bat)\b[^\n>|;&]*?([A-Za-z0-9._-]+)/SKILL\.md\b")
HASH_SUFFIX_RE = re.compile(r"-[0-9a-f]{32}$")  # OpenAI hosted skill mounts: /home/oai/skills/<name>-<32 hex>/SKILL.md
log = logging.getLogger("agentglow")
# Hatchet runs have idle gaps between steps (the next step sits in Hatchet's queue), so a quiet gap does NOT mean the
# run is over. Complete quickly once the run has produced its final answer, otherwise only after a long quiet period.
HATCHET_GRACE_MS = int(os.environ.get("AGENTGLOW_HATCHET_IDLE_MS", "60000"))
HATCHET_FINAL_GRACE_MS = 3000
# hard upper bound: a run with no span activity for this long completes even with open spans / waits
RUN_MAX_IDLE_MS = int(os.environ.get("AGENTGLOW_RUN_MAX_IDLE_MS", str(24 * 3600 * 1000)))
BECAUSE_MS = 30_000  # an approval wait starting this soon after its agent's guard decision links it
DECISIONS_KEPT = 2000
PARK_SLACK_MS = 1000  # a step ending this soon after its wait ended was (likely) evicted mid-wait
PARK_SHOW_MS = 3000  # ...shown as waiting only if no step starts meanwhile (a satisfied wait moves on at once)
HATCHET_WAIT_SPAN = "hatchet.durable.wait_for"
SLEEP_KEY_RE = re.compile(r"^sleep:(\d+)([smh])-\d+$")
EVENT_KEY_RE = re.compile(r"^event:(.+)-\d+$")
UNIT_MS = {"s": 1000, "m": 60_000, "h": 3_600_000}
MAX_STEP_RUNS = 20_000
ORPHAN_MS = 10_000  # how long an MCP backend span waits for its (caller's) parent span
MAX_ORPHANS = 5_000
# Prompt-cache usage, one of each spelling (GenAI semconv old/new, OpenInference). Token convention: `tokens_in` = ALL
# prompt tokens including cached ones (what `llm.token_count.prompt` / `gen_ai.usage.input_tokens` carry); these are
# subsets of it, never added on top.
CACHE_READ_KEYS = ("gen_ai.usage.cache_read_input_tokens", "gen_ai.usage.cache_read.input_tokens",
                   "llm.token_count.prompt_details.cache_read")
CACHE_WRITE_KEYS = ("gen_ai.usage.cache_creation_input_tokens", "gen_ai.usage.cache_creation.input_tokens",
                    "llm.token_count.prompt_details.cache_write")


MAX_SCOPED_RUNS = 20_000


def _first_int(a: dict, keys: tuple) -> int:
    for k in keys:
        try:
            if a.get(k):
                return int(a[k])
        except (TypeError, ValueError):
            pass
    return 0


def is_lg_node(name: str) -> bool:
    return name in LG_NODES or bool(LG_NODE_RE.search(name))


def _json(v: Any) -> Any:
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return None
    return v


def _flat(c: Any) -> str:
    if isinstance(c, list):  # content parts (Gemini / Anthropic)
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in c)
    return c if isinstance(c, str) else ""


def text_of(v: Any, n: int = 160) -> str:
    """Best-effort human text from an input/output value (LangChain message dumps, tool results, plain text)."""
    if v is None:
        return ""
    data = _json(v)
    out = ""
    if isinstance(data, dict):
        if isinstance(data.get("update"), dict):  # deepagents Command(update={"messages": [...]})
            data = data["update"]
        msgs = data.get("messages")
        if isinstance(msgs, list):
            for m in reversed(msgs):
                m = m.get("data", m) if isinstance(m, dict) else {}
                out = _flat(m.get("content"))
                if out:
                    break
        elif "data" in data and isinstance(data["data"], dict):
            out = _flat(data["data"].get("content"))
        elif "content" in data:
            out = _flat(data["content"])
        else:
            out = json.dumps(data, default=str)
    elif isinstance(v, str):
        hits = TEXT_RE.findall(v)  # truncated JSON: take the last content/text string
        out = next((h for h in reversed(hits) if h.strip()), "") if hits else v
        if hits:
            try:
                out = json.loads(f'"{out}"')
            except Exception:
                pass
    else:
        out = str(v)
    return " ".join(str(out).split())[:n]


def _deadline(v: Any) -> int | None:
    """`agentglow.wait.until` → epoch ms: a number (ms, or seconds when < 1e11) or an ISO-8601 string."""
    if isinstance(v, bool) or v is None or v == "":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        try:
            dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except ValueError:
            return None
        return int((dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp() * 1000)
    return int(n * 1000 if n < 1e11 else n)


def _num(v: Any) -> float | int | None:
    """Finite number (int kept int) or None."""
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return int(f) if f.is_integer() and abs(f) < 1e15 else round(f, 6)


def _prob(v: Any) -> float | None:
    """Probability → float clamped to 0..1 (None if missing / not a number)."""
    if isinstance(v, bool) or v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return min(1.0, max(0.0, f)) if f == f else None


@dataclass
class Span:
    id: str
    trace: str
    parent: str | None
    name: str
    start: int
    attrs: dict
    run: str
    end: int | None = None
    status: str = "unset"
    agent: str | None = None  # agent name when this span is an agent
    subagent: bool = False
    parent_agent: str | None = None
    llm: bool = False
    tool: bool = False
    tool_name: str = ""
    mcp: tuple | None = None  # (server, tool, resource, kind) once the call was emitted
    step: str | None = None
    candidate: str | None = None  # AGENT-kind span awaiting proof it is an agent, not a workflow container
    container: bool = False  # workflow container (OpenAI Agents trace span): not an agent itself
    preview: str = ""  # tool call args preview (delegation text for an agent-as-tool subagent)
    alias: str | None = None  # later turn of an agent already on screen (langgraph-supervisor): owner = that agent
    team: str | None = None  # langgraph-supervisor team graph: id of its supervisor agent
    persist: bool = False  # supervisor agent: exits when its team graph ends, not when its first turn ends
    skill: str | None = None  # `agentglow.skill` name once its skill start was emitted
    wait: tuple | None = None  # (reason, until ms | None, declared by the app) while this span is a wait
    covered: bool = False  # entry span holding a primitive job / session node: never also a long-request job node
    wait_step: str | None = None  # step span the wait belongs to
    wait_extra: dict | None = None  # kind / title / details / url / because shown with the wait (declared waits)
    kind: str | None = None  # OTel span kind (server, client, producer, consumer, internal) when known
    svc: str | None = None  # service agent id: this span is (inside) a service request (backend.py)
    entry: str | None = None  # the request / handled-message span itself: http | rpc | message | event
    backend: tuple | None = None  # backend client call emitted (owner, server, tool, resource, kind); () = rate-limited
    mcp_host: str | None = None  # nearest MCP tool span naming no backend (its CLIENT spans become its backends)


@dataclass
class Agent:
    name: str
    run: str
    thinking: bool = False
    pending: list = field(default_factory=list)  # [(tool_name, args)] from its last LLM output
    tasks: dict = field(default_factory=dict)  # subagent_type -> description (deepagents task calls)
    last_text: str = ""  # text of its last LLM output (exit message / final when spans carry no output)
    turn_text: str = ""  # text of its latest LLM output, empty if that output was only tool calls
    request: str = ""  # latest user message its LLM saw (langgraph-supervisor delegation text)
    skill_paths: set = field(default_factory=set)  # deepagents SKILL.md paths already counted as a skill use
    done: bool = False  # exited (a top-level agent started meanwhile is a parallel step, not its successor)
    step_span: str | None = None  # step span it runs in (Hatchet waits are shown on it)


@dataclass
class Run:
    id: str
    open: int = 0
    root: str | None = None
    hatchet: bool = False
    failed: bool = False
    failed_steps: set = field(default_factory=set)  # steps whose LAST attempt failed (a retry that succeeds clears it)
    done_at: int | None = None
    last_top: str | None = None
    top_parent: dict = field(default_factory=dict)  # top-level agent id -> the agent that handed off to it
    final: bool = False
    synthetic: str | None = None
    last_text: str = ""  # last top-level agent's output: final fallback at completion
    last_ts: int = 0  # latest span start/end seen (RUN_MAX_IDLE_MS bound)
    step_runs: dict = field(default_factory=dict)  # hatchet.step_run_id -> step span id
    step_open: dict = field(default_factory=dict)  # step name -> open instances (fan-out, parallel children)
    batch_failed: set = field(default_factory=set)  # steps with a failed instance among the open ones
    waits: dict = field(default_factory=dict)  # open wait span id -> Span
    last_wait: tuple | None = None  # (end ts, step span id, reason, until) of the last wait that ended
    parked: dict = field(default_factory=dict)  # step name -> (reason, until): ended with its wait (evicted)
    park_pending: dict = field(default_factory=dict)  # parked step name -> park time, its `waiting` not emitted yet
    service: bool = False  # backend services run: long-lived, never completes when its spans close
    reason: str = ""  # why it ended, when not just "its spans closed" (`agentglow.run.end_reason`, e.g. "abandoned")


def _hatchet_workflow(a: dict) -> str:
    """Hatchet workflow name. SDK v1 sets `hatchet.workflow_name` to the task (step) name, so prefer the
    workflow part of `hatchet.action_name` ("vendor_consolidation:inventory")."""
    action = str(a.get("hatchet.action_name") or "")
    if ":" in action:
        return action.split(":", 1)[0]
    return str(a.get("hatchet.workflow_name") or "")


class Mapper:
    def __init__(self) -> None:
        self.spans: dict[str, Span] = {}
        self.runs: dict[str, Run] = {}
        self.agents: dict[str, Agent] = {}
        self.seen_ended: dict[str, None] = {}  # FIFO set of ended span ids (dedupe live + OTLP)
        self.mcp_known: set[tuple] = set()
        self.scopes: dict[str, str] = {}  # run_id -> scope (first `agentglow.scope` seen wins); insertion-ordered, bounded
        self.newly_scoped: list[str] = []  # runs whose scope became known since the Hub last looked
        self.skill_sets: dict[str, set] = {}  # trace/thread -> known deepagents skills_metadata paths (bounded)
        self.shell_calls: dict[str, None] = {}  # hosted shell_call ids already scanned (FIFO, bounded)
        self.step_runs: dict[str, str] = {}  # hatchet.step_run_id -> run id (Hatchet wait spans carry only that)
        self.orphans: dict[str, dict] = {}  # MCP backend span id -> {"start", "end", "parent", "ts"} until its parent shows
        self.hv = DecisionRate()  # high-volume decisions: per-agent aggregation + global cap (hv.py)
        self.decisions_by_id: dict[str, dict] = {}  # decision span id -> summary (a wait's `because`), FIFO bounded
        self.last_guard: dict[str, tuple] = {}  # agent id -> (ts, summary) of its latest guard / noul decision
        self.svc = Services(self)  # backend services (backend.py)
        self.prims = Prims(self)  # generic primitives (primitives.py)

    def _note_scope(self, s: "Span") -> None:
        if s.run in self.scopes:
            return
        v = s.attrs.get("agentglow.scope") or s.attrs.get("agentglow.run.scope")
        if v is None or v == "":
            return
        self.scopes[s.run] = str(v)
        self.newly_scoped.append(s.run)
        while len(self.scopes) > MAX_SCOPED_RUNS:
            self.scopes.pop(next(iter(self.scopes)))

    # ------------------------------------------------------------------ public
    def feed(self, kind: str, span: dict) -> list[dict]:
        out: list[dict] = []
        try:
            if self._hold_orphan(kind, span):
                return out
            a = span.get("attributes") or {}
            if SIGNAL in a or a.get(EVENT_KEY) not in (None, "order"):  # a primitive signal / business event (primitives.py)
                if kind == "end":
                    self.prims.signal(span, out)
                return out
            if kind == "start":
                if span["span_id"] not in self.spans and span["span_id"] not in self.seen_ended:
                    self._start(span, out)
            elif kind == "end":
                self._end(span, out)
            for oid in [k for k, o in self.orphans.items() if o["parent"] == span["span_id"]]:
                o = self.orphans.pop(oid)
                for k in ("start", "end"):
                    if o[k] is not None:
                        out += self.feed(k, o[k])
        except Exception:  # a weird span must never kill the stream
            log.exception("agentglow: failed to map span %s", span.get("name"))
        return out

    def _hold_orphan(self, kind: str, d: dict) -> bool:
        """MCP backend span whose parent (the caller's tool span, another process) is not here yet: hold it."""
        sid = d["span_id"]
        if sid in self.orphans:
            self.orphans[sid][kind] = d
            return True
        a = d.get("attributes") or {}
        pid = d.get("parent_span_id")
        # (a span inside a held MCP span, e.g. its DB call, waits with it)
        if not ((a.get("agentglow.mcp.server") or pid in self.orphans) and pid and pid not in self.spans and sid not in self.spans
                and sid not in self.seen_ended):
            return False
        self.orphans[sid] = {"start": None, "end": None, "parent": pid, "ts": d.get("end_time_ms") or d.get("start_time_ms") or 0, kind: d}
        while len(self.orphans) > MAX_ORPHANS:
            self.orphans.pop(next(iter(self.orphans)))
        return True

    def feed_ended(self, spans: list[dict]) -> list[dict]:
        """Finished spans (OTLP): replay their starts and ends as a timeline so parents precede children."""
        by_id = {s["span_id"]: s for s in spans}

        def depth(s: dict) -> int:
            d, cur = 0, s
            while cur.get("parent_span_id") in by_id and d < 200:
                cur, d = by_id[cur["parent_span_id"]], d + 1
            return d

        timeline = []
        for s in spans:
            d = depth(s)
            timeline.append((s.get("start_time_ms") or 0, 0, d, "start", s))
            timeline.append((s.get("end_time_ms") or s.get("start_time_ms") or 0, 1, -d, "end", s))
        timeline.sort(key=lambda t: t[:3])
        out: list[dict] = []
        for *_, kind, s in timeline:
            if s["span_id"] in self.seen_ended:
                continue
            out += self.feed(kind, s)
        return out

    def tick(self, now_ms: int) -> list[dict]:
        out: list[dict] = self.hv.flush(now_ms)
        out += self.svc.tick(now_ms)
        out += self.prims.tick(now_ms)
        for k in [k for k, o in self.orphans.items() if now_ms - o["ts"] >= ORPHAN_MS]:  # parent never came: drop
            self.orphans.pop(k)
        for r in list(self.runs.values()):
            if r.service:
                continue
            for step, t in [(k, t) for k, t in r.park_pending.items() if now_ms - t >= PARK_SHOW_MS]:
                del r.park_pending[step]
                reason, until = r.parked[step]
                out.append(self._step_wait_ev(r.id, step, reason, until, now_ms))
            if (r.done_at is not None and now_ms >= r.done_at) or (r.last_ts and now_ms - r.last_ts >= RUN_MAX_IDLE_MS):
                self._complete(r, now_ms, out)
        return out

    def quiet_runs(self) -> set[str]:
        """Open runs that are legitimately quiet (never shown idle): an open wait (declared approval / sleep, Hatchet
        durable wait), a step parked in a wait, or an open primitive session / job span (long-lived by design)."""
        out = {r.id for r in self.runs.values() if r.waits or r.parked}
        for s in self.spans.values():
            if s.end is None and ("agentglow.session" in s.attrs or "agentglow.job.id" in s.attrs):
                out.add(s.run)
        return out

    # ------------------------------------------------------------------ lifecycle
    def _start(self, d: dict, out: list) -> Span:
        a = dict(d.get("attributes") or {})
        parent = self.spans.get(d.get("parent_span_id") or "")
        entry = entry_kind(d)
        if entry:  # a service's request / handled message (backend.py): a pulse on the service agent
            s = Span(d["span_id"], d["trace_id"], d.get("parent_span_id"), d.get("name") or "span", d.get("start_time_ms") or 0, a,
                     self.svc.run_id(a.get("agentglow.scope") or a.get("agentglow.run.scope")), kind=d.get("kind"))
            self.spans[s.id] = s
            self.svc.start_entry(s, entry, d, out)
            return s
        if not d.get("parent_span_id") and d.get("kind") == "client":
            root = self.svc.root_client(d)
            if root or self.svc.defer_root(d):
                # a service's own DB / cache / HTTP call outside any request (a poll, a cron): a resource ping, never a
                # run. Live starts often carry no attributes yet (redis, httpx set them after start): decided at end.
                s = Span(d["span_id"], d["trace_id"], None, d.get("name") or "span", d.get("start_time_ms") or 0, a,
                         self.svc.run_id(a.get("agentglow.scope") or a.get("agentglow.run.scope")), kind="client")
                s.backend = ()
                self.spans[s.id] = s
                if root:
                    self.svc.start_root_client(s, d, out)
                return s
        if parent is None and self.prims.anchored(a):
            # a root (or orphan) session / job / stage / lease / inference span: it hangs off its process's service
            parent = self.prims.anchor(d, out)
            d = {**d, "parent_span_id": parent.id}
        up = a.get("hatchet.parent_workflow_run_id")  # child workflow run: shown inside its (still open) parent run
        wf = a.get("hatchet.workflow_run_id")
        if wf and not (up and str(up) in self.runs) and parent is not None and parent.run != str(wf) and \
                (self.runs.get(parent.run) or Run("")).hatchet:
            # the engine left parent_workflow_run_id empty, but the OTel parent (traceparent injected when a task
            # triggered this run) is in another open Hatchet run: a child run, fold it like one
            up = a["hatchet.parent_workflow_run_id"] = parent.run
        run_id = str((up if up and str(up) in self.runs else None) or a.get("hatchet.workflow_run_id") or a.get("agentglow.run.id")
                     or self.step_runs.get(str(a.get("hatchet.step_run_id") or "")) or (parent.run if parent else d["trace_id"]))
        s = Span(d["span_id"], d["trace_id"], d.get("parent_span_id"), d.get("name") or "span", d.get("start_time_ms") or 0, a, run_id,
                 kind=d.get("kind"))
        if parent is not None:
            s.svc, s.mcp_host = parent.svc, parent.mcp_host
        self.spans[s.id] = s
        self._note_scope(s)
        if len(self.spans) > 200_000:  # memory guard for spans that never end
            for k in list(self.spans)[:50_000]:
                self.spans.pop(k, None)
        ts = s.start

        run = self.runs.get(run_id)
        if run is None:
            run = self.runs[run_id] = Run(run_id, root=s.id)
            out.append({"type": "run", "run_id": run_id, "status": "started", "topic": self._topic(s), "workflow": self._workflow(s), "ts": ts})
        run.open += 1
        run.done_at = None
        run.last_ts = max(run.last_ts, ts)
        if not run.service:
            self.svc.note_run(d, run_id, a.get("agentglow.scope") or a.get("agentglow.run.scope"))
        run.hatchet = run.hatchet or "hatchet.workflow_run_id" in a

        step = step_name(a.get("agentglow.step") or (a.get("hatchet.step_name") if s.name.startswith("hatchet.start_step_run") else None))
        if step:  # any workflow-defined step name passes (no whitelist); scrubbed and capped
            s.step = step
            srid = a.get("hatchet.step_run_id")
            if srid:
                run.step_runs[str(srid)] = s.id
                self.step_runs[str(srid)] = run_id
                while len(self.step_runs) > MAX_STEP_RUNS:
                    self.step_runs.pop(next(iter(self.step_runs)))
            for p in [p for p in run.parked if p != step]:  # the run moved on: a parked step was done after all
                out.append({"type": "step", "run_id": run_id, "step": p, "status": "done", "ts": ts})
            run.parked.clear()
            run.park_pending.clear()
            run.step_open[step] = run.step_open.get(step, 0) + 1
            out.append({"type": "step", "run_id": run_id, "step": s.step, "status": "running", "ts": ts})

        name = self._agent_name(s)
        cand = self._candidate_above(s)
        if cand is not None and not cand.container:
            if name:  # an agent inside an AGENT-kind span → that span is a workflow container
                cand.container, cand.candidate = True, None
            elif self._is_llm(s) or self._is_tool(s):  # an LLM/tool directly in it → it is the agent
                self._spawn(cand, cand.candidate or cand.name, out, cand.start)
        if name and cand is None and a.get("openinference.span.kind") == "AGENT" and not self._ancestor_agent(s)[0]:
            s.candidate = name  # OpenInference kind known at start (OpenAI Agents): wait for its first child
        elif name:
            self._spawn(s, name, out, ts)
        elif parent and is_lg_node(s.name) and not parent.agent and not is_lg_node(parent.name) and not (parent.llm or parent.tool):
            self._spawn(parent, parent.name, out, parent.start)  # parent is a LangGraph agent graph

        if DECISION_KEY in a or a.get(EVENT_KEY) == "order":
            pass  # a decision / order is shown as one `decision` event at its end, never as an LLM turn / tool call
        elif self._is_llm(s) or (not self._not_llm(s) and ((parent and parent.name in LLM_PARENTS) or s.name.startswith("Chat"))):
            s.llm = True
            self._thinking(self._owner(s, out), s.run, out, ts)
        elif self._is_tool(s) or (parent and parent.name == "tools"):
            self._tool_start(s, out, ts)
        self._mcp_call(s, out, ts)
        if s.svc or s.mcp_host:
            self.svc.child_start(s, out)
        self._skill_start(s, out, ts)
        if "agentglow.final" in a:
            self._final(s.run, a["agentglow.final"], out, ts)
        s.wait = self._wait_of(s)
        if s.wait:
            self._wait_start(s, run, out, ts)
        self.prims.start(s, out)
        return s

    def _end(self, d: dict, out: list) -> None:
        sid = d["span_id"]
        if sid in self.seen_ended:
            return
        if self.svc.undefer(sid):  # a root CLIENT span that had no attributes at start: classify it now
            self.spans.pop(sid, None)
        s = self.spans.get(sid) or self._start(d, out)
        self.seen_ended[sid] = None
        if len(self.seen_ended) > 100_000:
            for k in list(self.seen_ended)[:20_000]:
                del self.seen_ended[k]
        s.attrs.update(d.get("attributes") or {})
        self._note_scope(s)
        s.end = d.get("end_time_ms") or s.start
        s.status = d.get("status") or "unset"
        a, ts, run = s.attrs, s.end, self.runs.get(s.run)
        failed = s.status == "error"
        if s.entry:
            s.name = d.get("name") or s.name  # e.g. FastAPI renames "GET" to "GET /orders/{id}" once routed
            self.svc.end_entry(s, out)
            self.svc.span_ended(s)
            return

        # late classification: attributes that only exist at end (OpenInference)
        if not s.agent and not s.container and not s.alias and not s.team:
            name = self._agent_name(s)
            if name:
                self._spawn(s, name, out, s.start)
        if DECISION_KEY in a or a.get(EVENT_KEY) == "order":
            s.llm = s.tool = False
        elif not s.llm and self._is_llm(s):
            s.llm = True
        elif s.llm and self._not_llm(s):  # guessed from its parent (`agent` node) but it's a chain, not a model call
            s.llm = False
        if not s.tool and not s.llm and not s.agent and DECISION_KEY not in a and not s.attrs.get(EVENT_KEY) == "order" and self._is_tool(s):
            self._tool_start(s, out, s.start)
        self._mcp_call(s, out, s.start)
        if "SkillsMiddleware" in s.name:
            self._note_skills_metadata(s)
        self._skill_start(s, out, s.start)
        self.prims.end(s, out)

        if s.llm:
            owner = self._owner(s, out)
            tin = int(a.get("gen_ai.usage.input_tokens") or a.get("llm.token_count.prompt") or a.get("gen_ai.usage.prompt_tokens") or 0)
            tout = int(a.get("gen_ai.usage.output_tokens") or a.get("llm.token_count.completion") or a.get("gen_ai.usage.completion_tokens") or 0)
            if a.get("agentglow.llm.pulse") is not False:  # False: tokens come from elsewhere (Claude Code traces)
                ev = {"type": "llm", "run_id": s.run, "id": owner, "tokens_in": tin, "tokens_out": tout, "latency_ms": max(0, s.end - s.start), "ts": ts}
                cached = _first_int(a, CACHE_READ_KEYS)  # a subset of tokens_in (prompt totals include cached)
                if cached:
                    ev["tokens_cached"] = cached
                written = _first_int(a, CACHE_WRITE_KEYS)
                if written:
                    ev["tokens_cache_write"] = written
                out.append(ev)
            self._remember_tool_calls(owner, a)
            self._hosted_shell_skills(s, owner, out, ts)
            ag = self.agents.get(owner)
            text = self._llm_text(a)
            if ag and text:
                ag.last_text = text
            if ag:
                ag.turn_text, ag.request = text, self._user_text(a) or ag.request
        if s.tool and s.tool_name == "task":
            owner = self._owner(s, out)
            self._thinking(owner, s.run, out, ts, force=True)
        if s.mcp:
            server, tool, res, kind = s.mcp
            ev = {"type": "mcp", "run_id": s.run, "id": self._owner(s, out), "server": server, "tool": tool, "phase": "result", "latency_ms": max(0, s.end - s.start), "ts": ts}
            if res:
                ev.update(resource=res, resource_kind=kind)
            if s.status == "error":
                ev["error"] = True
            out.append(ev)
        if s.skill:
            out.append({"type": "skill", "run_id": s.run, "id": self._owner(s, out), "name": s.skill, "status": "end", "ts": ts})
        if s.backend is None and (s.svc or s.mcp_host) and s.kind in ("client", "producer"):
            self.svc.child_start(s, out)  # attributes set after the span started (redis, httpx): the call shows now
        if s.backend is not None:
            self.svc.child_end(s, out)
        elif a.get("db.system"):
            self._graph(s, out, ts)
        if a.get(DECISION_KEY) and not s.agent:
            self._decision(s, out, ts)
        if a.get(EVENT_KEY) == "order" and not s.agent:
            self._order(s, out, ts)
        if "agentglow.final" in a:
            self._final(s.run, a["agentglow.final"], out, ts)
        if s.team:  # langgraph-supervisor team graph ended → its supervisor exits
            ag = self.agents.get(s.team)
            result = a.get("agentglow.output_text") or text_of(a.get("output.value"), 2000) or (ag.last_text if ag else "")
            out.append({"type": "exit", "run_id": s.run, "id": s.team, "status": "failed" if failed else "done", "ts": ts})
            if run and result:
                run.last_text = result
        if s.agent and not s.persist:
            ag = self.agents.get(s.id)
            if ag:
                ag.done = True
            result = a.get("agentglow.output_text") or text_of(a.get("output.value"), 2000) or (ag.last_text if ag else "")
            if s.parent_agent:
                out.append({"type": "message", "run_id": s.run, "from_id": s.id, "to_id": s.parent_agent, "text": result[:160] or "done", "ts": ts})
            out.append({"type": "exit", "run_id": s.run, "id": s.id, "status": "failed" if failed else "done", "ts": ts})
            if run and run.root == s.id:
                self._final(s.run, result, out, ts)
            elif run and not s.subagent and result:
                run.last_text = result
        if s.wait and run:
            self._wait_end(s, run, out, ts)
        if s.step and not run:
            out.append({"type": "step", "run_id": s.run, "step": s.step, "status": "failed" if failed else "done", "ts": ts})

        if (run and run.service) or (run is None and s.backend is not None):
            self.svc.span_ended(s)
        elif run:
            run.open = max(0, run.open - 1)
            run.last_ts = max(run.last_ts, ts)
            if s.step:
                self._step_end(s, run, failed, out, ts)
            if failed and run.root == s.id:
                run.failed = True
            if run.root == s.id and a.get("agentglow.run.end_reason"):
                run.reason = str(a["agentglow.run.end_reason"])[:40]
            if run.open == 0:
                if not run.hatchet:
                    self._complete(run, ts, out)
                elif run.final:
                    run.done_at = ts + HATCHET_FINAL_GRACE_MS
                elif run.parked:  # evicted mid-wait: hold until the deadline (else the RUN_MAX_IDLE_MS bound)
                    untils = [u for _, u in run.parked.values()]
                    run.done_at = max(ts, *untils) + HATCHET_GRACE_MS if all(untils) else None
                else:
                    run.done_at = ts + HATCHET_GRACE_MS

    def _step_end(self, s: Span, run: Run, failed: bool, out: list, ts: int) -> None:
        """A step instance ended: the step is done/failed once its last open instance ends (fan-out); a step that
        ends together with its wait (Hatchet eviction) stays `waiting` (parked)."""
        n = run.step_open.get(s.step, 1) - 1
        if failed:
            run.batch_failed.add(s.step)
        if n > 0:
            run.step_open[s.step] = n
            return
        run.step_open.pop(s.step, None)
        bad = s.step in run.batch_failed
        run.batch_failed.discard(s.step)
        (run.failed_steps.add if bad else run.failed_steps.discard)(s.step)
        lw = run.last_wait
        if not bad and not run.final and lw and lw[1] == s.id and ts - lw[0] <= PARK_SLACK_MS:
            run.parked[s.step] = (lw[2], lw[3])
            run.park_pending[s.step] = ts  # tick() shows it as waiting after PARK_SHOW_MS unless the run moves on
            return
        out.append({"type": "step", "run_id": s.run, "step": s.step, "status": "failed" if bad else "done", "ts": ts})

    def _complete(self, run: Run, ts: int, out: list) -> None:
        run.failed = run.failed or bool(run.failed_steps)
        for p in run.parked:
            out.append({"type": "step", "run_id": run.id, "step": p, "status": "done", "ts": ts})
        self._final(run.id, run.last_text, out, ts)
        if run.synthetic:
            out.append({"type": "exit", "run_id": run.id, "id": run.synthetic, "status": "failed" if run.failed else "done", "ts": ts})
        root = self.spans.get(run.root or "")
        ev = {"type": "run", "run_id": run.id, "status": "failed" if run.failed else "completed",
              "topic": self._topic(root) if root else run.id, "workflow": self._workflow(root) if root else "", "ts": ts}
        if run.reason:
            ev["reason"] = run.reason
        out.append(ev)
        self.runs.pop(run.id, None)
        for k in [k for k, s in self.spans.items() if s.run == run.id]:
            del self.spans[k]
        for k in [k for k, ag in self.agents.items() if ag.run == run.id]:
            del self.agents[k]

    # ------------------------------------------------------------------ agents
    def _agent_name(self, s: Span) -> str | None:
        a = s.attrs
        v = a.get("agentglow.agent")
        if v:
            return s.name if v is True or str(v).lower() == "true" else str(v)
        if s.svc and s.name == "fastapi.background_task":  # a service's background task: a short-lived subagent
            return str(a.get("code.function.name") or "background_task").rsplit(".", 1)[-1] or "background_task"
        if a.get("gen_ai.operation.name") == "invoke_agent":
            return str(a.get("gen_ai.agent.name") or s.name.removeprefix("invoke_agent ").strip() or "agent")
        meta = _json(a.get("metadata")) or {}
        if is_lg_node(s.name) or (isinstance(meta, dict) and meta.get("langgraph_node")):
            return None
        if a.get("openinference.span.kind") == "AGENT":
            return s.name
        if isinstance(meta, dict) and meta.get("lc_agent_name") == s.name and not (s.llm or s.tool):
            return s.name
        return None

    def _candidate_above(self, s: Span) -> Span | None:
        """Nearest ancestor that is an agent candidate or workflow container, with no agent in between."""
        cur, hops = self.spans.get(s.parent or ""), 0
        while cur is not None and hops < 500 and not cur.agent:
            if cur.candidate or cur.container:
                return cur
            cur, hops = self.spans.get(cur.parent or ""), hops + 1
        return None

    def _ancestor_agent(self, s: Span) -> tuple[str | None, bool]:
        """(nearest ancestor agent span id, whether a tool span sits in between)."""
        via_tool, cur, hops = False, self.spans.get(s.parent or ""), 0
        while cur is not None and hops < 500:
            if cur.agent:
                return cur.id, via_tool
            if cur.alias:
                return cur.alias, via_tool or cur.entry is not None  # an agent in a service request is its subagent
            if cur.team:  # an agent graph inside a langgraph-supervisor team is the supervisor's subagent
                return cur.team, True
            via_tool = via_tool or cur.tool or cur.name == "task"
            cur, hops = self.spans.get(cur.parent or ""), hops + 1
        return None, via_tool

    def _spawn(self, s: Span, name: str, out: list, ts: int) -> None:
        if s.agent or s.alias:
            return
        host = self._team_host(s)
        if host is not None and host.team and (self.agents.get(host.team) or Agent("", "")).name == name:
            s.alias = host.team  # the supervisor's next turn: same agent instance, no new spawn
            return
        parent, via_tool = self._ancestor_agent(s)
        if parent and s.svc and parent in self.svc.svcs and not self.svc.admit_task(parent, s.id):
            s.alias = parent  # the service already runs MAX_TASKS tasks: this one shows as the service itself
            return
        s.agent, s.candidate = name, None
        run = self.runs.get(s.run)
        st = self._step_span(s)
        child = st is not None and st.attrs.get("hatchet.parent_workflow_run_id") == s.run
        if parent and child and not self._is_child(self.spans.get(parent) or s):
            via_tool = True  # found across the child run's boundary (its step hangs off the triggering span)
        if not parent and child:
            # folded child workflow run (fan-out): a subagent of the agent that triggered it (the trigger span's owner,
            # e.g. its step promoted to an agent), else of the parent run's newest live non-child agent
            spawner = self.spans.get(st.parent or "")
            if spawner is not None and spawner.run == s.run and not self._is_child(spawner):
                if spawner.step and not spawner.agent:  # triggered straight from a step span: promote it
                    self._spawn(spawner, str(spawner.attrs.get("agentglow.agent") or spawner.step), out, spawner.start)
                parent = spawner.id if spawner.agent else spawner.alias or self._owner(spawner, out)
            else:
                parent = next((k for k, ag in reversed(self.agents.items()) if ag.run == s.run and not ag.done and not
                               (self.spans.get(ag.step_span or "") or st).attrs.get("hatchet.parent_workflow_run_id")), None)
            via_tool = True
        hint = s.attrs.get("agentglow.subagent")  # manual API: an agent nested directly in an agent
        s.subagent = bool(parent and (via_tool or hint is True or str(hint).lower() == "true"))
        text = ""
        if parent:
            pa = self.agents.get(parent)
            text = (pa.tasks.pop(name, "") if pa else "") or text_of(s.attrs.get("input.value")) or self._tool_preview_above(s) or f"delegate → {name}"
        elif run:
            prev = run.last_top
            if prev and prev != s.id:  # handoff between top-level agents of one run (e.g. workflow steps)
                pa = self.agents.get(prev)
                # Hatchet: a parallel step (prev still working) or a retry (same agent again) shares prev's upstream agent
                sibling = run.hatchet and pa is not None and (not pa.done or pa.name == name)
                parent = run.top_parent.get(prev) if sibling else prev
                if parent:
                    text = f"handoff → {name}"
            run.top_parent[s.id] = parent
            run.last_top = s.id
        s.parent_agent = parent
        self.agents[s.id] = Agent(name, s.run, step_span=st.id if st else None)
        out.append({"type": "spawn", "run_id": s.run, "id": s.id, "agent": name, "parent_id": parent, "subagent": s.subagent, "ts": ts})
        if parent:
            out.append({"type": "message", "run_id": s.run, "from_id": parent, "to_id": s.id, "text": text[:160], "ts": ts})

    def _is_child(self, s: Span) -> bool:
        st = self._step_span(s)
        return st is not None and bool(st.attrs.get("hatchet.parent_workflow_run_id"))

    def _tool_preview_above(self, s: Span) -> str:
        cur, hops = self.spans.get(s.parent or ""), 0
        while cur is not None and hops < 500 and not cur.agent:
            if cur.tool:
                return cur.preview
            cur, hops = self.spans.get(cur.parent or ""), hops + 1
        return ""

    def _owner(self, s: Span, out: list) -> str:
        """Owning agent = nearest ancestor agent span; if none, promote the step/root ancestor to an implicit agent."""
        if s.agent and not (s.llm or s.tool):
            return s.id
        found, _ = self._ancestor_agent(s)
        if found:
            return found
        if s.alias:
            return s.alias
        chain, cur = [], self.spans.get(s.parent or "")
        while cur is not None and len(chain) < 500:
            chain.append(cur)
            cur = self.spans.get(cur.parent or "")
        pick = next((c for c in chain if c.step), chain[-1] if chain else None)
        if pick is not None:
            self._spawn(pick, str(pick.attrs.get("agentglow.agent") or pick.step or pick.name), out, pick.start)
            return pick.id
        run = self.runs.get(s.run)
        if run is None:
            return f"{s.run}:agent"
        if not run.synthetic:
            run.synthetic = f"{s.run}:agent"
            self.agents[run.synthetic] = Agent("agent", s.run)
            out.append({"type": "spawn", "run_id": s.run, "id": run.synthetic, "agent": "agent", "parent_id": None, "subagent": False, "ts": s.start})
        return run.synthetic

    def _team_host(self, s: Span) -> Span | None:
        """langgraph-supervisor shape: agent graph `s` → same-name node span → team graph (not an agent)."""
        node = self.spans.get(s.parent or "")
        host = self.spans.get(node.parent or "") if node is not None and node.name == s.name else None
        return host if host is not None and not host.agent and not host.alias else None

    def _in_team(self, s: Span) -> bool:
        cur, hops = self.spans.get(s.parent or ""), 0
        while cur is not None and hops < 500:
            if cur.team:
                return True
            cur, hops = self.spans.get(cur.parent or ""), hops + 1
        return False

    def _handoff(self, s: Span, owner: str, out: list, ts: int) -> bool:
        """langgraph-supervisor `transfer_to_<worker>` / `transfer_back_to_*`: mark the team, queue the delegation
        text, show the supervisor waiting. True → don't emit a tool event."""
        name = s.tool_name
        if not (name.startswith("transfer_to_") or name.startswith("transfer_back_to_")):
            return False
        sup = self.spans.get(owner)
        if name.startswith("transfer_to_") and sup is not None and sup.agent:
            host = self._team_host(sup)
            if host is not None and not host.team:
                host.team, sup.persist = sup.id, True
        if not self._in_team(s):
            return False
        ag = self.agents.get(owner)
        if name.startswith("transfer_to_") and ag:
            worker = name.removeprefix("transfer_to_")
            ag.tasks[worker] = ag.turn_text or ag.request or f"delegate → {worker}"
            ag.thinking = False
            out.append({"type": "agent", "run_id": s.run, "id": owner, "status": "waiting", "ts": ts})
        return True

    def _thinking(self, owner: str, run: str, out: list, ts: int, force: bool = False) -> None:
        ag = self.agents.get(owner)
        if ag and (force or not ag.thinking):
            ag.thinking = True
            out.append({"type": "agent", "run_id": run, "id": owner, "status": "thinking", "ts": ts})

    # ------------------------------------------------------------------ waits (durable tasks)
    def _wait_of(self, s: Span) -> tuple | None:
        """(reason, until ms | None, declared) if this span is a wait: `agentglow.wait` (+ `agentglow.wait.until`), or
        Hatchet's `hatchet.durable.wait_for` span (reason from its signal key)."""
        a = s.attrs
        v = a.get("agentglow.wait")
        if v is not None and v is not False and v != "":
            return session_title(str(v)) or "wait", _deadline(a.get("agentglow.wait.until")), True
        if s.name != HATCHET_WAIT_SPAN:
            return None
        key = str(a.get("hatchet.signal_key") or "")
        m = SLEEP_KEY_RE.match(key)
        if m:
            return "sleep", s.start + int(m[1]) * UNIT_MS[m[2]], False
        m = EVENT_KEY_RE.match(key)
        return session_title(m[1] if m else key) or "event", None, False

    def _step_span(self, s: Span) -> Span | None:
        """The step span `s` runs in: itself, the nearest step ancestor, else (Hatchet wait span) by step run id."""
        cur, hops = s, 0
        while cur is not None and hops < 500:
            if cur.step:
                return cur
            cur, hops = self.spans.get(cur.parent or ""), hops + 1
        run = self.runs.get(s.run)
        sid = run.step_runs.get(str(s.attrs.get("hatchet.step_run_id") or "")) if run else None
        return self.spans.get(sid or "")

    def _wait_agent(self, s: Span, st: Span | None) -> str | None:
        """Agent shown waiting: the owning agent of a declared wait, else the newest live agent in the wait's step."""
        if s.wait and s.wait[2]:
            found = s.id if s.agent else self._ancestor_agent(s)[0]
            if found:
                return found
        if st is None:
            return None
        return next((k for k, ag in reversed(self.agents.items()) if ag.step_span == st.id and not ag.done), None)

    @staticmethod
    def _step_wait_ev(run_id: str, step: str, reason: str, until: int | None, ts: int, extra: dict | None = None) -> dict:
        ev = {"type": "step", "run_id": run_id, "step": step, "status": "waiting", "reason": reason, "ts": ts}
        if until:
            ev["until"] = until
        if extra:
            ev.update(extra)
        return ev

    @staticmethod
    def _shown_wait(run: Run, st: Span | None) -> Span | None:
        """The open wait a step shows: a declared one over Hatchet's own, newest first."""
        ws = [w for w in run.waits.values() if st is not None and w.wait_step == st.id]
        return max(ws, key=lambda w: (w.wait[2], w.start)) if ws else None

    def _step_wait_state(self, run: Run, st: Span, out: list, ts: int, shown: Span | None = None) -> None:
        """Step shows its open wait, else `running` again while it is open. `shown`: the wait it showed before (no
        repeat when that one still wins, e.g. Hatchet's wait_for opening / closing inside a declared wait)."""
        w = self._shown_wait(run, st)
        if w is not None and w is shown:
            return
        if w is not None:
            out.append(self._step_wait_ev(run.id, st.step, w.wait[0], w.wait[1], ts, w.wait_extra))
        elif st.end is None:
            out.append({"type": "step", "run_id": run.id, "step": st.step, "status": "running", "ts": ts})

    def _wait_start(self, s: Span, run: Run, out: list, ts: int) -> None:
        # Hatchet's own wait span hangs off the trigger's traceparent: for a folded child run that is a step of the
        # PARENT run, so its step run id (when known) names the step it really waits in
        srid = str(s.attrs.get("hatchet.step_run_id") or "")
        st = self.spans.get(run.step_runs.get(srid) or "") if srid and not s.step else None
        st = st or self._step_span(s)
        s.wait_step = st.id if st else None
        owner = self._wait_agent(s, st)
        s.wait_extra = self._wait_extra(s, owner, ts) if s.wait[2] else None
        shown = self._shown_wait(run, st)
        run.waits[s.id] = s
        if st:
            self._step_wait_state(run, st, out, ts, shown)
        ag = self.agents.get(owner or "")
        others = [w for w in run.waits.values() if w is not s and self._wait_agent(w, self.spans.get(w.wait_step or "")) == owner]
        if ag and not any(w.wait[2] or not s.wait[2] for w in others):  # already waiting on a wait that wins
            ag.thinking = False
            ev = {"type": "agent", "run_id": s.run, "id": owner, "status": "waiting", "reason": s.wait[0], "ts": ts}
            if s.wait[1]:
                ev["until"] = s.wait[1]
            if s.wait_extra:
                ev.update(s.wait_extra)
            out.append(ev)

    def _wait_extra(self, s: Span, owner: str | None, ts: int) -> dict | None:
        """A declared wait's drawer fields: `kind` (approval), `title`, `details` {k: scalar}, `url`, and `because` =
        the decision that triggered it (`agentglow.wait.because` = its span id; or, for an approval, the owner's
        guard / noul decision of the last BECAUSE_MS)."""
        a, x = s.attrs, {}
        kind = decision_text(a.get("agentglow.wait.kind"), 16).lower()
        if kind:
            x["kind"] = kind
        title = decision_text(a.get("agentglow.wait.title"), 80)
        if title:
            x["title"] = title
        pre = "agentglow.wait.detail."
        det = wait_details({k[len(pre):]: v for k, v in a.items() if k.startswith(pre)})
        if det:
            x["details"] = det
        url = wait_url(a.get("agentglow.wait.url"))
        if url:
            x["url"] = url
        bid = a.get("agentglow.wait.because")
        because = self.decisions_by_id.get(str(bid)) if bid else None
        if because is None and not bid and kind == "approval" and owner:
            lg = self.last_guard.get(owner)
            if lg and 0 <= ts - lg[0] <= BECAUSE_MS:
                because = lg[1]
        if because:
            x["because"] = because
        return x or None

    def _wait_end(self, s: Span, run: Run, out: list, ts: int) -> None:
        st = self.spans.get(s.wait_step or "")
        shown = self._shown_wait(run, st)
        run.waits.pop(s.id, None)
        if s.wait_step != s.id:  # a wait nested in its step (a step span that is itself the wait never parks)
            run.last_wait = (ts, s.wait_step, s.wait[0], s.wait[1])
        if st:
            self._step_wait_state(run, st, out, ts, shown)
        owner = self._wait_agent(s, st)
        ag = self.agents.get(owner or "")
        if ag and not ag.done and not any(self._wait_agent(w, self.spans.get(w.wait_step or "")) == owner for w in run.waits.values()):
            self._thinking(owner, s.run, out, ts, force=True)

    def open_wait(self, run_id: str, agent_id: str | None = None, step: str | None = None) -> dict | None:
        """The open wait an approval targets (POST /live/approve): newest first, owned by `agent_id` and/or in `step`.
        Returns {reason, step?, workflow?, wait_run_id?} (the Hatchet workflow run / workflow of the waiting step, e.g.
        a child run folded into `run_id`), or None. A parked step (evicted while waiting) matches by `step` too."""
        run = self.runs.get(run_id)
        if run is None:
            return None
        for w in sorted(run.waits.values(), key=lambda w: (w.wait[2], w.start), reverse=True):
            st = self.spans.get(w.wait_step or "")
            if agent_id and self._wait_agent(w, st) != agent_id:
                continue
            if step and (st is None or st.step != step):
                continue
            a = st.attrs if st else w.attrs
            out = {"reason": w.wait[0], "step": st.step if st else None, "workflow": _hatchet_workflow(a) or None,
                   "wait_run_id": str(a.get("hatchet.workflow_run_id") or "") or None,
                   "title": (w.wait_extra or {}).get("title")}
            return {k: v for k, v in out.items() if v}
        if step and not agent_id and step in run.parked:
            return {"reason": run.parked[step][0], "step": step}
        return None

    # ------------------------------------------------------------------ llm / tools
    @staticmethod
    def _is_llm(s: Span) -> bool:
        return s.attrs.get("openinference.span.kind") == "LLM" or s.attrs.get("gen_ai.operation.name") in LLM_OPS

    @staticmethod
    def _not_llm(s: Span) -> bool:
        """Kind is known and is not a model call (e.g. a CHAIN child of a prebuilt react agent's `agent` node)."""
        kind = s.attrs.get("openinference.span.kind")
        return bool(kind) and kind != "LLM" and s.attrs.get("gen_ai.operation.name") not in LLM_OPS

    @staticmethod
    def _user_text(a: dict) -> str:
        """Latest user message an LLM span saw (OpenInference flattened input messages)."""
        best, text = -1, ""
        for k, v in a.items():
            m = re.match(r"llm\.input_messages\.(\d+)\.message\.role$", k)
            if m and v == "user" and int(m[1]) > best:
                c = a.get(f"llm.input_messages.{m[1]}.message.content")
                if isinstance(c, str) and c.strip():
                    best, text = int(m[1]), c
        return " ".join(text.split())

    @staticmethod
    def _is_tool(s: Span) -> bool:
        return s.attrs.get("openinference.span.kind") == "TOOL" or s.attrs.get("gen_ai.operation.name") == "execute_tool"

    @staticmethod
    def _llm_text(a: dict) -> str:
        """Assistant text of an LLM span (OpenInference flattened output messages)."""
        texts = [(k, v) for k, v in a.items() if re.match(r"llm\.output_messages\.\d+\.message\.content$", k) and isinstance(v, str) and v.strip()]
        return texts[-1][1].strip() if texts else ""

    def _remember_tool_calls(self, owner: str, a: dict) -> None:
        ag = self.agents.get(owner)
        if not ag:
            return
        calls: dict[tuple, dict] = {}
        for k, v in a.items():
            m = re.match(r"llm\.output_messages\.(\d+)\.message\.tool_calls\.(\d+)\.tool_call\.function\.(name|arguments)$", k)
            if m:
                calls.setdefault((int(m[1]), int(m[2])), {})[m[3]] = v
        ag.pending = []
        for _, c in sorted(calls.items()):
            args = _json(c.get("arguments")) or {}
            ag.pending.append((c.get("name"), args))
            if c.get("name") == "task" and isinstance(args, dict) and args.get("subagent_type"):
                ag.tasks[str(args["subagent_type"])] = str(args.get("description") or "")

    def _tool_start(self, s: Span, out: list, ts: int) -> None:
        if s.tool:
            return
        s.tool = True
        a = s.attrs
        s.tool_name = str(a.get("gen_ai.tool.name") or a.get("tool.name") or s.name)
        owner = self._owner(s, out)
        ag = self.agents.get(owner)
        args: Any = None
        if ag and (s.tool_name == "handoff" or s.tool_name.startswith("handoff to ")):
            # OpenAI Agents handoff span: name it after the model's transfer_to_* call
            s.tool_name = next((str(n) for n, _ in ag.pending if str(n).startswith("transfer_to_")), s.tool_name)
        if ag:
            for i, (n, ar) in enumerate(ag.pending):
                if n == s.tool_name:
                    args = ag.pending.pop(i)[1]
                    break
        if args is None:
            args = _json(a.get("input.value")) or a.get("input.value") or a.get("gen_ai.tool.call.arguments") or ""
        if s.tool_name == "task" and isinstance(args, dict):
            preview = f"{args.get('subagent_type', 'subagent')}: {args.get('description', '')}"
        elif isinstance(args, dict) and set(args) == {"input"}:  # OpenAI Agents agent.as_tool call
            preview = str(args["input"])
        else:
            preview = args if isinstance(args, str) else json.dumps(args, default=str)
        s.preview = " ".join(preview.split())[:160]
        if self._handoff(s, owner, out, ts):
            return
        out.append({"type": "tool", "run_id": s.run, "id": owner, "tool": s.tool_name, "args_preview": " ".join(preview.split())[:120], "ts": ts})
        if s.tool_name == "task" and ag:
            ag.thinking = False
            out.append({"type": "agent", "run_id": s.run, "id": owner, "status": "waiting", "ts": ts})

    # ------------------------------------------------------------------ mcp / graph / final
    def _mcp_call(self, s: Span, out: list, ts: int) -> None:
        a = s.attrs
        server = a.get("agentglow.mcp.server") or a.get("mcp.server.name")
        if s.mcp or not server:
            return
        server = str(server)
        tool = str(a.get("agentglow.mcp.tool") or a.get("mcp.tool.name") or a.get("gen_ai.tool.name") or a.get("tool.name") or s.name)
        res = a.get("agentglow.mcp.resource")
        kind = str(a.get("agentglow.mcp.resource_kind") or "api")
        kind = kind if kind in RESOURCE_KINDS else "api"
        s.mcp = (server, tool, str(res) if res else None, kind)
        s.mcp_host = None if res else s.id  # no backend named: its CLIENT spans become its backends (backend.py)
        key = (server, s.mcp[2])
        if key not in self.mcp_known:
            self.mcp_known.add(key)
            out.append({"type": "mcp_register", "server": server, "resources": [{"name": s.mcp[2], "kind": kind}] if res else [], "ts": ts})
        ev = {"type": "mcp", "run_id": s.run, "id": self._owner(s, out), "server": server, "tool": tool, "phase": "call", "ts": ts}
        if res:
            ev.update(resource=s.mcp[2], resource_kind=kind)
        out.append(ev)

    def _skill_start(self, s: Span, out: list, ts: int) -> None:
        """Span with `agentglow.skill` (Claude Code Skill tool, manual `agentglow.skill()`): skill start on the agent
        that owns it; the matching end is emitted when the span ends. Only the sanitized name is carried."""
        if s.skill:
            return
        name = skill_name(s.attrs.get(SKILL_KEY)) if SKILL_KEY in s.attrs else self._framework_skill(s, out)
        if name:
            s.skill = name
            out.append({"type": "skill", "run_id": s.run, "id": self._owner(s, out), "name": name, "status": "start", "ts": ts})

    @staticmethod
    def _skill_key(s: Span) -> str:
        meta = _json(s.attrs.get("metadata"))
        tid = meta.get("thread_id") if isinstance(meta, dict) else None
        return f"thread:{tid}" if tid else f"trace:{s.trace}"

    def _note_skills_metadata(self, s: Span) -> None:
        """deepagents `SkillsMiddleware.before_agent` output: `{skills_metadata: [{name, path, ...}]}` (first turn only
        with a checkpointer) → cache the known SKILL.md paths for this thread / trace."""
        data = _json(s.attrs.get("output.value"))
        if isinstance(data, dict) and isinstance(data.get("update"), dict):
            data = data["update"]
        items = data.get("skills_metadata") if isinstance(data, dict) else None
        if not isinstance(items, list):
            return
        paths = {str(i["path"]) for i in items if isinstance(i, dict) and i.get("path")}
        key = self._skill_key(s)
        self.skill_sets[key] = self.skill_sets.get(key, set()) | paths
        while len(self.skill_sets) > MAX_SKILL_SETS:
            self.skill_sets.pop(next(iter(self.skill_sets)))

    def _framework_skill(self, s: Span, out: list) -> str:
        """Skill use inferred from a framework tool call (only ever the name, never args):
        - deepagents: `read_file` of `<dir>/<skill>/SKILL.md` (offset 0), in the cached skills_metadata set if known;
          once per (agent, path), so paged re-reads don't count. write_file/edit_file/ls/glob/grep never count.
        - OpenAI Agents SDK: a `load_skill` function tool with input `skill_name`."""
        if not s.tool:
            return ""
        tool = str(s.attrs.get("tool.name") or s.attrs.get("gen_ai.tool.name") or s.tool_name)
        raw = s.attrs.get("input.value")
        args = _json(raw)
        if tool == "load_skill":
            v = args.get("skill_name") if isinstance(args, dict) else None
            name = skill_name(v if v is not None else (raw if isinstance(raw, str) and args is None else None))
            return name if name and self._first_use(s, out, "skill:" + name) else ""
        if tool in SHELL_TOOLS:  # exact: Claude Code `Bash` is not one (it has the Skill tool)
            names = [n for n in self._shell_skills(args if args is not None else raw) if self._first_use(s, out, "skill:" + n)]
            return names[0] if names else ""
        if tool != "read_file":
            return ""
        if isinstance(args, dict):
            path = args.get("file_path") or args.get("path")
            try:
                if int(args.get("offset") or 0) > 0:
                    return ""
            except (TypeError, ValueError):
                pass
        else:
            m = FILE_PATH_RE.search(raw) if isinstance(raw, str) else None
            path = m[1] if m else None
        m = SKILL_MD_RE.match(str(path or ""))
        if not m:
            return ""
        known = self.skill_sets.get(self._skill_key(s))
        if known and path not in known:
            return ""
        name = skill_name(m["skill"])
        return name if name and self._first_use(s, out, path) and self._first_use(s, out, "skill:" + name) else ""

    def _first_use(self, s: Span, out: list, key: str, owner: str | None = None) -> bool:
        """Dedupe inferred skill uses per (agent, key): True the first time only."""
        ag = self.agents.get(owner or self._owner(s, out))
        if ag is None:
            return True
        if key in ag.skill_paths:
            return False
        ag.skill_paths.add(key)
        return True

    @staticmethod
    def _shell_skills(v: Any) -> list[str]:
        """Skill names read by shell commands (`cat .../<skill>/SKILL.md`), from a command string, a list of them or a
        tool input dict (`commands`, `cmd`, ...). ls / grep / writes (redirects, `sed -i`) do not count."""
        cmds: list[str] = []

        def walk(x: Any) -> None:
            if isinstance(x, str):
                cmds.append(x)
            elif isinstance(x, list):
                for i in x:
                    walk(i)
            elif isinstance(x, dict):
                for i in x.values():
                    walk(i)
        walk(v)
        names: list[str] = []
        for c in cmds:
            for m in SHELL_SKILL_RE.finditer(c):
                if m[0].startswith("sed") and re.search(r"\s-[a-zA-Z]*i", m[0]):
                    continue
                n = skill_name(HASH_SUFFIX_RE.sub("", m[1]))
                if n and n not in names:
                    names.append(n)
        return names

    def _hosted_shell_skills(self, s: Span, owner: str, out: list, ts: int) -> None:
        """OpenAI hosted shell: no tool span, the model's `output.value` lists `shell_call` items. Only output.value is
        scanned (input.value echoes earlier calls); each call_id once, each (agent, skill) once."""
        data = _json(s.attrs.get("output.value"))
        items = data.get("output") if isinstance(data, dict) else None
        if not isinstance(items, list):
            return
        for it in items:
            if not isinstance(it, dict) or it.get("type") != "shell_call":
                continue
            cid = str(it.get("call_id") or it.get("id") or "")
            if cid:
                if cid in self.shell_calls:
                    continue
                self.shell_calls[cid] = None
                while len(self.shell_calls) > 4096:
                    self.shell_calls.pop(next(iter(self.shell_calls)))
            action = it.get("action") if isinstance(it.get("action"), dict) else {}
            for n in self._shell_skills(action.get("commands")):
                if self._first_use(s, out, "skill:" + n, owner):
                    out.append({"type": "skill", "run_id": s.run, "id": owner, "name": n, "status": "start", "ts": ts})
                    out.append({"type": "skill", "run_id": s.run, "id": owner, "name": n, "status": "end", "ts": ts})

    def _decision(self, s: Span, out: list, ts: int) -> None:
        a = s.attrs
        kind = str(a.get(DECISION_KEY)).strip().lower()
        opts = self._decision_options(a.get(DECISION_KEY + ".options"))
        result = decision_text(a.get(DECISION_KEY + ".result"), 40) or (opts[0]["name"] if opts else "")
        p = _prob(a.get(DECISION_KEY + ".p"))
        if p is None:
            p = next((o["p"] for o in opts if o["name"] == result), None)
        ev = {"type": "decision", "run_id": s.run, "id": self._owner(s, out), "kind": kind if kind in DECISION_KINDS else "choice",
              "question": decision_text(a.get(DECISION_KEY + ".question"), 80) or kind, "result": result}
        if p is not None:
            ev["p"] = round(p, 3)
        if opts:
            ev["options"] = opts
        ev["provider"] = decision_text(a.get(DECISION_KEY + ".provider"), 40) or "llm"
        for k in ("purpose", "target", "scope"):
            v = decision_text(a.get(f"{DECISION_KEY}.{k}"), 40)
            if v:
                ev[k] = v
        th = _num(a.get(DECISION_KEY + ".threshold"))
        if th is not None:
            ev["threshold"] = th
        ev.update(ms=max(0, (s.end or s.start) - s.start), ts=ts)
        self._remember_decision(s.id, ev)
        important = a.get(DECISION_KEY + ".important")
        out += self.hv.offer(ev, important is True or str(important).lower() in ("true", "1"))

    def _remember_decision(self, sid: str, ev: dict) -> None:
        """Keep a short summary per decision span (a later wait's `because`) and each agent's latest guard."""
        keep = ("kind", "question", "result", "p", "provider", "purpose", "target", "threshold", "ms", "ts")
        summary = {"id": sid, **{k: ev[k] for k in keep if k in ev}}
        self.decisions_by_id[sid] = summary
        if len(self.decisions_by_id) > DECISIONS_KEPT:
            self.decisions_by_id.pop(next(iter(self.decisions_by_id)))
        if ev.get("purpose") == "guard" or ev.get("kind") == "noul":
            self.last_guard.pop(ev["id"], None)
            self.last_guard[ev["id"]] = (ev["ts"], summary)
            if len(self.last_guard) > DECISIONS_KEPT:
                self.last_guard.pop(next(iter(self.last_guard)))

    def _order(self, s: Span, out: list, ts: int) -> None:
        a, k = s.attrs, ORDER_KEY + "."
        side = decision_text(a.get(k + "side"), 8).lower() or "buy"
        status = decision_text(a.get(k + "status"), 16).lower()
        ev = {"type": "order", "run_id": s.run, "id": self._owner(s, out), "side": side,
              "qty": _num(a.get(k + "qty")) or 0, "price": _num(a.get(k + "price")),
              "status": status if status in ORDER_STATUSES else "would_place",
              "instrument": decision_text(a.get(k + "instrument"), 40),
              "dry_run": a.get(k + "dry_run") is True or str(a.get(k + "dry_run")).lower() in ("true", "1")}
        if ev["price"] is None:
            del ev["price"]
        reason = decision_text(a.get(k + "reason"), 80)
        if reason:
            ev["reason"] = reason
        ev["ts"] = ts
        out.append(ev)

    @staticmethod
    def _decision_options(v: Any) -> list[dict]:
        """`agentglow.decision.options` (JSON string, list of {name, p}, or {name: p}) → top MAX_DECISION_OPTIONS by p."""
        data = _json(v)
        if isinstance(data, dict):
            data = [{"name": k, "p": x} for k, x in data.items()]
        rows = []
        for it in data if isinstance(data, list) else []:
            if isinstance(it, str):
                it = _json(it)
            if not isinstance(it, dict):
                continue
            name, p = decision_text(it.get("name"), 40), _prob(it.get("p"))
            if name and p is not None:
                rows.append({"name": name, "p": round(p, 3)})
        rows.sort(key=lambda r: -r["p"])
        return rows[:MAX_DECISION_OPTIONS]

    def _graph(self, s: Span, out: list, ts: int) -> None:
        a = s.attrs
        op = str(a.get("agentglow.db.op") or "").lower()
        if op not in ("read", "write"):
            q = str(a.get("db.query.text") or a.get("db.statement") or a.get("db.operation.name") or a.get("db.operation") or "")
            op = "write" if WRITE_RE.search(q) else "read"
        raw = a.get("agentglow.graph.nodes")
        nodes = _json(raw) if isinstance(raw, str) else raw
        if nodes is None and isinstance(raw, str):
            nodes = [x.strip() for x in raw.split(",") if x.strip()]
        nodes = [str(n) for n in (nodes or [])][:50]
        if not nodes and op == "read":
            return  # empty read: nothing to light up
        out.append({"type": "graph", "run_id": s.run, "id": self._owner(s, out), "op": op, "nodes": nodes, "ts": ts})

    def _final(self, run_id: str, text: Any, out: list, ts: int) -> None:
        run = self.runs.get(run_id)
        text = str(text or "").strip()
        if not text or (run and run.final):
            return
        if run:
            run.final = True
        out.append({"type": "final", "run_id": run_id, "text": text[:2000], "ts": ts})

    # ------------------------------------------------------------------ run labels
    def _topic(self, s: Span) -> str:
        a = s.attrs
        if a.get("agentglow.run.topic"):
            return str(a["agentglow.run.topic"])
        payload = _json(a.get("hatchet.payload"))
        if isinstance(payload, dict) and isinstance(payload.get("input"), dict):
            for v in payload["input"].values():
                if isinstance(v, str) and v.strip():
                    return v[:200]
        return str(_hatchet_workflow(a) or s.name)

    def _workflow(self, s: Span) -> str:
        a = s.attrs
        name = _hatchet_workflow(a) or a.get("agentglow.run.workflow")
        if name:
            return str(name)
        # a Hatchet step span's own name is the step ("plan"), not the workflow
        return "hatchet" if a.get("hatchet.step_name") or s.name.startswith("hatchet.") else s.name
