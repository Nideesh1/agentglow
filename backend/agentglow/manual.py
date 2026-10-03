"""Manual tracing API for hand-written agent loops (no framework). See docs/SPEC.md "Manual API".

    import agentglow
    agentglow.watch()
    async with agentglow.run(topic="Inbound call", scope=clinic_id):
        async with agentglow.agent("receptionist") as a:
            a.llm(model="gpt-realtime", tokens_in=812, tokens_out=64)
            async with agentglow.tool("book_appointment", args={"slot": "10:30"}):
                ...
            a.final("Booked for 10:30")

Everything is a plain OpenTelemetry span carrying the hint attributes the mapper already understands
(`agentglow.agent`, `gen_ai.operation.name`, `agentglow.mcp.*`, `db.system`, `agentglow.final`, ...), so it works with
`watch()` (live starts: a long-lived agent shows up the moment it starts) and with any OTLP exporter (ended spans).
Context rides in contextvars, so asyncio tasks created inside a block inherit it. Without an SDK TracerProvider
(no `watch()`, no OTel setup) every call is a cheap no-op. Text passed to `say`/`final`/`args`/`task` is shown in the
UI after the secret scrub: do not put PHI/PII in it.
"""
from __future__ import annotations

import contextvars
import inspect
import json
import time
from typing import Any, Callable

from opentelemetry import baggage, context, trace
from opentelemetry.trace import Status, StatusCode

from .dual import DualUse, decorate, is_target, rebuild
from .scope import KEY as SCOPE_KEY

_TRACER_NAME = "agentglow.manual"
_provider: Any = None  # tests / advanced: a private TracerProvider instead of the global one
_agent: contextvars.ContextVar["Agent | None"] = contextvars.ContextVar("agentglow_agent", default=None)


def use_provider(provider: Any) -> None:
    """Record manual spans on this TracerProvider instead of the global one (None = global)."""
    global _provider
    _provider = provider


def _tracer():
    p = _provider or trace.get_tracer_provider()
    if isinstance(p, (trace.ProxyTracerProvider, trace.NoOpTracerProvider)):
        return None  # nothing configured: no-op
    return p.get_tracer(_TRACER_NAME)


def _preview(v: Any) -> str:
    if v is None or isinstance(v, str):
        return v or ""
    try:
        return json.dumps(v, default=str)
    except Exception:
        return str(v)


class _Span(DualUse):
    """Context-managed span (sync `with` and `async with`; also a decorator when built by a factory, dual.py).
    Attributes are all set at start (live view)."""

    _name = "span"

    def __init__(self, name: str, attrs: dict, parent: "_Span | None" = None, start_ns: int | None = None) -> None:
        self.name = name
        self._attrs = {k: v for k, v in attrs.items() if v is not None}
        self._parent = parent
        self._start_ns = start_ns
        self.span: trace.Span = trace.INVALID_SPAN
        self._token = None

    # ---- lifecycle
    def _context(self):
        if self._parent is not None and self._parent.span.get_span_context().is_valid:
            return trace.set_span_in_context(self._parent.span)  # keeps current baggage (scope)
        return None

    def start(self) -> "_Span":
        tracer = _tracer()
        if tracer is not None:
            self.span = tracer.start_span(self.name, context=self._context(), attributes=self._attrs, start_time=self._start_ns)
            self._token = context.attach(trace.set_span_in_context(self.span))
        return self

    def end(self, exc: BaseException | None = None) -> None:
        if exc is not None and self.span.is_recording():
            self.span.set_status(Status(StatusCode.ERROR, type(exc).__name__))
        if self._token is not None:
            try:
                context.detach(self._token)
            except Exception:
                pass
            self._token = None
        self.span.end()

    def set(self, key: str, value: Any) -> None:
        if value is not None and self.span.is_recording():
            self.span.set_attribute(key, value)

    def __enter__(self):
        return self.start()

    def __exit__(self, et, exc, tb) -> None:
        self.end(exc)

    async def __aenter__(self):
        return self.start()

    async def __aexit__(self, et, exc, tb) -> None:
        self.end(exc)


class Run(_Span):
    """One run (a call, a request, a job): the root of a world-view run."""

    def __init__(self, topic: str, run_id: str | None = None, scope: str | None = None, workflow: str | None = None) -> None:
        super().__init__(workflow or "run", {"agentglow.run.topic": topic, "agentglow.run.id": run_id,
                                             "agentglow.run.workflow": workflow, SCOPE_KEY: scope})
        self.scope = scope
        self._scope_token = None

    def start(self) -> "Run":
        tracer = _tracer()
        if tracer is None:
            return self
        ctx = context.get_current()
        if self.scope:
            ctx = baggage.set_baggage(SCOPE_KEY, str(self.scope), ctx)
        self._scope_token = context.attach(ctx)  # scope rides in baggage → every span inside gets it
        # a run is always a new trace (not a child of e.g. the HTTP request span around it)
        self.span = tracer.start_span(self.name, context=trace.set_span_in_context(trace.INVALID_SPAN, ctx), attributes=self._attrs)
        self._token = context.attach(trace.set_span_in_context(self.span))
        return self

    def end(self, exc: BaseException | None = None) -> None:
        super().end(exc)
        if self._scope_token is not None:
            try:
                context.detach(self._scope_token)
            except Exception:
                pass
            self._scope_token = None

    def final(self, text: str) -> None:
        """The run's final outcome text (shown when the run ends)."""
        self.set("agentglow.final", text)


class Agent(_Span):
    """An agent. Nested inside another agent (same task, a task created inside, or `parent=`) it is a subagent."""

    def __init__(self, name: str, final: bool | None = None, task: str | None = None, parent: "Agent | None" = None) -> None:
        self._parent_agent = parent if parent is not None else _agent.get()
        super().__init__(name, {"agentglow.agent": name, "input.value": task,
                                "agentglow.subagent": True if self._parent_agent is not None else None}, parent=parent)
        self._final_flag = final
        self._agent_token = None

    def start(self) -> "Agent":
        super().start()
        self._agent_token = _agent.set(self)
        return self

    def end(self, exc: BaseException | None = None) -> None:
        if self._agent_token is not None:
            try:
                _agent.reset(self._agent_token)
            except ValueError:  # ended from another context
                pass
            self._agent_token = None
        super().end(exc)

    # ---- what the agent did
    def say(self, text: str) -> None:
        """What the agent said last: its result message to its parent (subagent) / the run's final fallback."""
        self.set("output.value", text)

    def final(self, text: str) -> None:
        """The agent's outcome. A top-level agent's outcome is the run's `final` text; a subagent's is its result
        message to its parent (pass `final=True/False` to `agent()` to override)."""
        self.say(text)
        top = self._parent_agent is None if self._final_flag is None else self._final_flag
        if top:
            self.set("agentglow.final", text)

    def llm(self, model: str = "llm", tokens_in: int = 0, tokens_out: int = 0, latency_ms: float = 0) -> None:
        """Record one finished LLM turn on this agent (a pulse sized by tokens)."""
        start = None
        if latency_ms:  # backdate the turn, but never before the agent started (keeps ended-span replay ordered)
            start = max(time.time_ns() - int(latency_ms * 1e6), getattr(self.span, "start_time", None) or 0)
        s = LLM(model, tokens_in, tokens_out, parent=self, start_ns=start).start()
        s.end()

    def tool(self, name: str, args: Any = None) -> "Tool":
        return Tool(name, args, parent=self)

    def mcp(self, server: str, tool: str | None = None, resource: str | None = None, kind: str = "api", args: Any = None) -> "Tool":
        return mcp(server, tool, resource, kind, args, parent=self)

    def graph(self, op: str = "read", nodes: list | None = None, system: str = "graph", kinds: list | None = None) -> _Span:
        return graph(op, nodes, system, parent=self, kinds=kinds)

    def skill(self, name: str) -> "Tool":
        return skill(name, parent=self)

    def decision(self, kind: str, question: str, **kw: Any) -> "Decision":
        return decision(kind, question, parent=self, **kw)

    def decided(self, kind: str, question: str, result: Any, p: float | None = None, **kw: Any) -> "Decision":
        return decided(kind, question, result, p, parent=self, **kw)

    def order(self, side: str, qty: float, price: float | None = None, **kw: Any) -> None:
        order(side, qty, price, parent=self, **kw)

    def agent(self, name: str, final: bool | None = None, task: str | None = None) -> "Agent":
        return Agent(name, final=final, task=task, parent=self)


class LLM(_Span):
    def __init__(self, model: str = "llm", tokens_in: int | None = None, tokens_out: int | None = None,
                 parent: _Span | None = None, start_ns: int | None = None) -> None:
        super().__init__(f"chat {model}", {"gen_ai.operation.name": "chat", "gen_ai.request.model": model,
                                           "gen_ai.usage.input_tokens": tokens_in, "gen_ai.usage.output_tokens": tokens_out},
                         parent=parent, start_ns=start_ns)

    def set_tokens(self, tokens_in: int = 0, tokens_out: int = 0) -> None:
        self.set("gen_ai.usage.input_tokens", int(tokens_in))
        self.set("gen_ai.usage.output_tokens", int(tokens_out))


class Tool(_Span):
    def __init__(self, name: str, args: Any = None, parent: _Span | None = None, extra: dict | None = None) -> None:
        a = {"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name, "input.value": _preview(args) or None}
        super().__init__(name, {**a, **(extra or {})}, parent=parent)

    def result(self, value: Any) -> None:
        self.set("output.value", _preview(value))


DECISION_KINDS = ("choice", "score", "noul")


def _float(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float("inf") else None
MAX_OPTIONS = 5


def _options(options: Any) -> str | None:
    """{name: p} / [(name, p)] / [{"name", "p"}] → JSON list of up to MAX_OPTIONS {name, p}, sorted by p desc."""
    if not options:
        return None
    items = options.items() if isinstance(options, dict) else options
    rows = []
    for it in items:
        name, p = (it.get("name"), it.get("p")) if isinstance(it, dict) else it
        try:
            rows.append({"name": str(name), "p": round(min(1.0, max(0.0, float(p))), 4)})
        except (TypeError, ValueError):
            continue
    rows.sort(key=lambda r: -r["p"])
    return json.dumps(rows[:MAX_OPTIONS]) if rows else None


class Decision(_Span):
    """A fast structured decision (Jev / Laya Choice, Score, Noul, or an LLM-as-judge fallback). Span name
    `decision <kind>`; latency = span duration. Set the outcome with `.record(...)` before the block ends."""

    def __init__(self, kind: str, question: str, result: Any = None, p: float | None = None, options: Any = None,
                 provider: str = "llm", purpose: str | None = None, target: str | None = None,
                 parent: _Span | None = None, start_ns: int | None = None, important: bool = False,
                 scope: str | None = None, threshold: float | None = None) -> None:
        kind = str(kind).lower()
        super().__init__(f"decision {kind}", {"agentglow.decision": kind, "agentglow.decision.question": question,
                                              "agentglow.decision.provider": provider,
                                              "agentglow.decision.purpose": purpose,
                                              "agentglow.decision.target": target,
                                              "agentglow.decision.important": True if important else None,
                                              "agentglow.decision.scope": scope,
                                              "agentglow.decision.threshold": _float(threshold)},
                         parent=parent, start_ns=start_ns)
        self.kind = kind
        self._attrs.update(self._outcome(result, p, options))

    def _outcome(self, result: Any, p: float | None, options: Any) -> dict:
        out = {}
        if result is not None:
            out["agentglow.decision.result"] = ("yes" if result else "no") if isinstance(result, bool) else str(result)
        if p is not None:
            out["agentglow.decision.p"] = min(1.0, max(0.0, float(p)))
        opts = _options(options)
        if opts:
            out["agentglow.decision.options"] = opts
        return out

    def record(self, result: Any, p: float | None = None, options: Any = None, target: str | None = None) -> None:
        """The outcome: `result` = chosen option / score level / True|False|"yes"|"no" (noul); `p` = probability of
        that result (0..1); `options` = {name: p} (choice / score distribution, top 5 kept)."""
        for k, v in {**self._outcome(result, p, options), "agentglow.decision.target": target}.items():
            self.set(k, v)

    def _returned(self, value: Any) -> None:
        """Decorator use (`@agentglow.decision(...)`): the function's return value is the decision. bool -> yes/no;
        (result, p) -> both; {"result", "p", "options"} -> those; None -> nothing; anything else -> str(value)."""
        if value is None:
            return
        result, p, options = value, None, None
        if isinstance(value, tuple) and len(value) == 2:
            result, p = value
        elif isinstance(value, dict) and any(k in value for k in ("result", "p", "options")):
            result, p, options = value.get("result"), value.get("p"), value.get("options")
        if result is not None and not isinstance(result, bool):
            result = str(result)[:MAX_RESULT]
        self.record(result, p, options)


MAX_RESULT = 80  # a decorated decision's str(return value) is cut to this many characters


# ---------------------------------------------------------------------- public helpers
def run(topic: str = "run", run_id: str | None = None, scope: str | None = None, workflow: str | None = None) -> Run:
    """`with agentglow.run(topic="Inbound call"):` (or `async with`) - one run in the world view."""
    return rebuild(Run(topic, run_id=run_id, scope=scope, workflow=workflow),
                   lambda c: Run(topic, run_id=run_id, scope=scope, workflow=workflow))


def agent(name: Any = None, final: bool | None = None, task: str | None = None, parent: Agent | None = None) -> Agent:
    """`with agentglow.agent("receptionist") as a:` - an agent; inside another agent it is a subagent (`task` = the
    delegation text shown on the link). Also a decorator: `@agentglow.agent("receptionist")` / `@agentglow.agent`
    (name = the function's name): each call is one agent span."""
    if is_target(name):  # bare @agent
        return agent()(name)
    return rebuild(Agent(name or "agent", final=final, task=task, parent=parent),
                   lambda c: Agent(name or c.name, final=final, task=task, parent=parent))


def llm(model: str = "llm", tokens_in: int | None = None, tokens_out: int | None = None, parent: _Span | None = None) -> LLM:
    """`with agentglow.llm(model="gpt-realtime") as l: ...; l.set_tokens(812, 64)` - one LLM turn."""
    return rebuild(LLM(model, tokens_in, tokens_out, parent=parent), lambda c: LLM(model, tokens_in, tokens_out, parent=parent))


def tool(name: Any = None, args: Any = None, parent: _Span | None = None) -> Tool:
    """`with agentglow.tool("book_appointment", args={...}) as t:` - a tool call on the current agent. Also a
    decorator: `@agentglow.tool("book")` / `@agentglow.tool` (name = the function's name; arguments NOT recorded)."""
    if is_target(name):  # bare @tool
        return tool()(name)
    return rebuild(Tool(name or "tool", args, parent=parent), lambda c: Tool(name or c.name, args, parent=parent))


def mcp(server: str, tool: str | None = None, resource: str | None = None, kind: str = "api", args: Any = None,
        parent: _Span | None = None) -> Tool:
    """`with agentglow.mcp("clinic-db", tool="query", resource="Postgres", kind="db"):` - an MCP / backend call
    (kind: db, warehouse, spark, api, storage, queue)."""
    name = tool or "call"
    extra = {"agentglow.mcp.server": server, "agentglow.mcp.tool": name, "agentglow.mcp.resource": resource,
             "agentglow.mcp.resource_kind": kind}
    return rebuild(Tool(name, args, parent=parent, extra=extra), lambda c: Tool(name, args, parent=parent, extra=extra))


def graph(op: str = "read", nodes: list | None = None, system: str = "graph", parent: _Span | None = None,
          kinds: list | None = None) -> _Span:
    """`with agentglow.graph("write", nodes=["Patient", "Appointment"]):` - a knowledge-graph / DB read or write.
    `kinds`: optional node kinds parallel to `nodes` (colors nodes the viewer adds outside its graph sample)."""
    attrs = {"db.system": system, "agentglow.db.op": op, "agentglow.graph.nodes": [str(n) for n in (nodes or [])] or None,
             "agentglow.graph.kinds": [str(k or "") for k in kinds] if kinds else None}
    return rebuild(_Span(f"db {op}", attrs, parent=parent), lambda c: _Span(f"db {op}", attrs, parent=parent))


def skill(name: str, parent: _Span | None = None) -> Tool:
    """`with agentglow.skill("summarize"):` - the current agent uses a skill (a tool span with `agentglow.skill`:
    a skill badge on the agent while the block runs). Only the name is recorded."""
    return rebuild(Tool(name, None, parent=parent, extra={"agentglow.skill": name}),
                   lambda c: Tool(name, None, parent=parent, extra={"agentglow.skill": name}))


def decision(kind: str, question: str, result: Any = None, p: float | None = None, options: Any = None,
             provider: str = "llm", purpose: str | None = None, target: str | None = None,
             parent: _Span | None = None, important: bool = False, scope: str | None = None,
             threshold: float | None = None) -> Decision:
    """`with agentglow.decision("choice", "route", provider="jev", purpose="route") as d: ...; d.record("haiku", 0.92,
    {"haiku": 0.92, "sonnet": 0.07})` - a fast structured decision by the current agent (kind: choice | score | noul;
    purpose: route | guard | check; target: e.g. the tool being gated). Latency = the block's duration.
    `question` is a short name (scrubbed, max 80 chars): do not put PHI/PII in it. `important=True`: always shown
    individually, even when the agent decides so often that its decisions are aggregated (high-volume mode).
    `scope="global"`: a desk-wide guard (e.g. a kill switch): a `no` halts everything below this agent, shown once.
    Also a decorator: `@agentglow.decision("noul", "safe?", purpose="guard")` records the function's return value as
    the outcome (bool -> yes/no; (result, p); {"result", "p", "options"}; else str(value)) and returns it unchanged."""
    def make(c: Any = None) -> Decision:
        return Decision(kind, question, result, p, options, provider, purpose, target, parent=parent,
                        important=important, scope=scope, threshold=threshold)
    return rebuild(make(), make)


def decided(kind: str, question: str, result: Any, p: float | None = None, options: Any = None, provider: str = "llm",
            purpose: str | None = None, target: str | None = None, latency_ms: float = 0,
            parent: _Span | None = None, important: bool = False, scope: str | None = None,
            threshold: float | None = None) -> Decision:
    """Record one finished decision (backdated by `latency_ms`), e.g. after `jev.noul(...)` returned. `threshold`: the
    cut-off the result was judged against (shown with the decision, e.g. why a wait was needed). Returns the ended
    decision (pass it as `wait(..., because=d)` / `approval(..., because=d)`)."""
    start = None
    if latency_ms:  # backdate, but never before the enclosing span started (keeps ended-span replay ordered)
        around = parent.span if parent is not None else trace.get_current_span()
        start = max(time.time_ns() - int(latency_ms * 1e6), getattr(around, "start_time", None) or 0)
    d = Decision(kind, question, result, p, options, provider, purpose, target, parent=parent, start_ns=start,
                 important=important, scope=scope, threshold=threshold)
    d.start().end()
    return d


ORDER_STATUSES = ("would_place", "placed", "filled", "rejected", "cancelled")


def order(side: str, qty: float, price: float | None = None, status: str = "would_place", instrument: str | None = None,
          dry_run: bool = True, reason: str | None = None, parent: _Span | None = None) -> None:
    """Record one order action of the current agent (a finished `order <side>` span with `agentglow.event=order`):
    side buy | sell | yes | no; status would_place | placed | filled | rejected | cancelled; `dry_run=True` (default)
    = paper. `instrument` / `reason` are short labels (scrubbed): do not put PHI/PII in them."""
    side = str(side).lower()
    _Span(f"order {side}", {"agentglow.event": "order", "agentglow.order.side": side, "agentglow.order.qty": qty,
                            "agentglow.order.price": price, "agentglow.order.status": status,
                            "agentglow.order.instrument": instrument, "agentglow.order.dry_run": bool(dry_run),
                            "agentglow.order.reason": reason}, parent=parent).start().end()


def current_agent() -> Agent | None:
    return _agent.get()


def traced_agent(name: str | Callable | None = None, final: bool | None = None):
    """`@agentglow.traced_agent("receptionist")` on a sync or async function: each call is an agent span. Same as
    `@agentglow.agent(...)` (kept as an alias)."""
    return agent(name, final=final)


def traced_tool(name: str | Callable | None = None, capture_args: bool = False):
    """`@agentglow.traced_tool("lookup_patient")` on a sync or async function: each call is a tool span. Arguments
    are recorded only with `capture_args=True` (they may hold PHI/PII). Without it, same as `@agentglow.tool(...)`."""
    if not capture_args:
        return tool(name)

    def make(c: Any) -> Tool:
        try:
            bound = inspect.signature(c.fn).bind_partial(*c.args, **c.kwargs)
            args = {n: v for n, v in bound.arguments.items() if n not in ("self", "cls")}
        except TypeError:
            args = {"args": list(c.args), **c.kwargs}
        return Tool(name or c.name, args)
    return lambda fn: decorate(fn, make)
