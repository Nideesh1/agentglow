"""Generic primitives (docs/SPEC.md "Generic primitives"): small building blocks any system can report.

    import agentglow
    with agentglow.session("support chat", kind="ws") as s:      # a long-lived connection / conversation / stream
        s.turn("user"); s.progress(frames_in=12)
        with agentglow.stage("decode"):                         # stages + progress inside a job / request / session
            agentglow.progress(3, 10)
    agentglow.capacity("slots", used=3, max=4); agentglow.rejected("busy", retry_after=2)
    gpu = agentglow.pool("whisper", size=2, kind="model", devices=["gpu0", "gpu1"])
    async with gpu.lease():
        with agentglow.inference("whisper-small", units=12.5, unit="audio_s"): ...
    agentglow.job(order_id, kind="fulfil", state="queued")      # API side; the worker wraps its work in `with job(...)`
    agentglow.link(charge_id); agentglow.complete(charge_id)     # outbound call ... later webhook
    agentglow.fallback(from_="inline", to="queue", reason="timeout")
    agentglow.gate("refunds", state="locked", attempts_left=2)
    agentglow.backlog("orders", depth=42, lag_ms=1200); agentglow.lifecycle("ready")
    agentglow.metric("audio_min", 1.8, unit="audio_min/min"); agentglow.event("signup", label="trial")
    agentglow.cache("catalog", hit=True)

Producer side: every call is a plain OTel span (manual.py `_Span`, so no SDK provider = no-op). Long-lived ones (session,
stage, lease, inference, job) are spans with their attributes set at start; point ones are finished-at-once spans with
`agentglow.signal` = the signal name. None of them carries content: numbers, ids and short labels only.

Server side: `Prims` is called by the Mapper (signal spans, primitive spans, root primitive spans anchored to their
process's service) and by backend.Services.flat (POST /v1/events), and turns them into the world events listed in the
SPEC (`session`, `stage`, `progress`, `capacity`, `rejected`, `job`, `deferred`, `fallback`, `gate`, `backlog`,
`lifecycle`, `metric`, `event`, `resource_stats`, plus `spawn` / `exit` / `message` / `mcp` where they fit).
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import re
import threading
import time
from collections import deque
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from opentelemetry import context, trace

from .dual import DualUse, is_target, rebuild
from .manual import _agent, _Span, _tracer
from .scrub import decision_text, wait_details, wait_url

if TYPE_CHECKING:
    from .mapper import Mapper, Span

log = logging.getLogger("agentglow")

SIGNAL = "agentglow.signal"
SIGNALS = ("progress", "capacity", "rejected", "job", "link", "complete", "fallback", "gate", "backlog", "lifecycle",
           "metric", "cache", "gauge", "turn")
LIFECYCLE = ("loading", "warming", "ready", "degraded", "draining", "restarting", "fatal")
JOB_STATES = ("queued", "running", "retrying", "done", "failed", "dead")
POOL_KINDS = ("model", "gpu", "worker")
GROUP = "backend"  # the synthetic resource group (backend.py) pools, models and caches join by default
GROUP_ATTR = "agentglow.resource.group"  # a named resource group instead (lease / inference spans)
_group_default: list = [None]  # process-wide default: resource_group() / watch(resource_group=...)
MAX_FIELDS = 8


def _num(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _safe_fields(fields: dict) -> dict:
    """Numbers, bools and short strings only (no content), at most MAX_FIELDS."""
    out: dict = {}
    for k, v in fields.items():
        if v is None or len(out) >= MAX_FIELDS:
            continue
        if isinstance(v, (bool, int, float)):
            out[k] = v
        elif isinstance(v, str):
            out[k] = v[:40]
    return out


# ============================================================================================ producer API
def resource_group(name: str | None) -> None:
    """Process-wide default resource group for pools, models and caches (default: env AGENTGLOW_RESOURCE_GROUP, else
    the shared `backend` group). A group holding only models is shown as "ML · <name>"."""
    _group_default[0] = str(name) if name else None


def _group(group: Any) -> str | None:
    g = group or _group_default[0] or os.environ.get("AGENTGLOW_RESOURCE_GROUP")
    return str(g)[:40] if g else None


def capture() -> Any:
    """The current OTel context (the spawning request): pass it as `session(..., parent=ctx)` / `job(..., parent=ctx)`
    when the work runs later in a detached task or thread."""
    return context.get_current()


def _signal(name: str, fields: dict, parent: _Span | None = None) -> None:
    attrs: dict = {SIGNAL: name}
    for k, v in fields.items():
        if v is not None:
            attrs[f"agentglow.{name}.{k}"] = v
    _Span(f"signal {name}", attrs, parent=parent).start().end()


class _CtxSpan(_Span):
    """A _Span whose parent may also be an OTel Context (`capture()`), or a fresh trace (`parent_link=False`)."""

    def __init__(self, name: str, attrs: dict, parent: Any = None, parent_link: bool = True, start_ns: int | None = None) -> None:
        super().__init__(name, attrs, parent=parent if isinstance(parent, _Span) else None, start_ns=start_ns)
        self._ctx = None if isinstance(parent, _Span) else parent
        self._link = parent_link

    def _context(self):
        if self._ctx is not None:
            return self._ctx
        if not self._link and self._parent is None:
            return trace.set_span_in_context(trace.INVALID_SPAN)  # detached: a new trace (anchored to the service)
        return super()._context()


class Session(_CtxSpan):
    """A long-lived connection / conversation / stream (WebSocket, voice call, audio stream, chat). Shown as a live
    node (a subagent of its owner, e.g. the service whose request opened it) with a timer from its start."""

    def __init__(self, name: str, kind: str = "session", id: str | None = None, parent: Any = None,
                 parent_link: bool = True) -> None:
        super().__init__(f"session {name}", {"agentglow.agent": name, "agentglow.session": name,
                                             "agentglow.session.kind": kind, "agentglow.session.id": id},
                         parent=parent, parent_link=parent_link)
        self.outcome: str | None = None
        self.reason: str | None = None
        self._agent_token = None
        self._ended = False

    def start(self) -> "Session":
        super().start()
        self._agent_token = _agent.set(self)  # manual agents started inside are its subagents
        return self

    def progress(self, **gauges: Any) -> None:
        """Gauges of the session right now, numbers only (audio_s=12.5, turns=4, bytes_in=..., rate_in=...)."""
        g = {k: v for k, v in gauges.items() if _num(v) is not None}
        if g:
            _signal("gauge", g, parent=self)

    def turn(self, role: str = "user", **numbers: Any) -> None:
        """One turn (user / agent / system / tool ...). No content: only numbers (ms=, tokens=, audio_s=)."""
        _signal("turn", {"role": role, **{k: v for k, v in numbers.items() if _num(v) is not None}}, parent=self)

    def end(self, exc: BaseException | None = None, *, outcome: str | None = None, reason: str | None = None) -> None:
        if self._ended:
            return
        self._ended = True
        self.outcome = outcome or self.outcome
        self.reason = reason or self.reason or (type(exc).__name__ if exc is not None else None)
        self.set("agentglow.session.outcome", self.outcome)
        self.set("agentglow.session.reason", self.reason)
        if self._agent_token is not None:
            try:
                _agent.reset(self._agent_token)
            except ValueError:
                pass
            self._agent_token = None
        super().end(exc)


def session(name: Any = None, kind: str = "session", id: Any = None, parent: Any = None, parent_link: bool = True) -> Session:
    """`with agentglow.session("support chat", kind="ws") as s:` (sync or async). `parent`: a `capture()`d context
    (the spawning request) when the session runs in a detached task; `parent_link=False`: no parent at all (the node
    then hangs off the process's service). Decorator: `@agentglow.session(kind="ws", id=lambda conn_id, **_: conn_id)`
    (name = the function's name; `id` may be a callable over the call's arguments)."""
    if is_target(name):  # bare @session
        return session()(name)
    return rebuild(Session(name or "session", kind=kind, id=None if callable(id) else id, parent=parent, parent_link=parent_link),
                   lambda c: Session(name or c.name, kind=kind, id=c.value(id, "id"), parent=parent, parent_link=parent_link))


def stage(name: Any = None) -> _Span:
    """`with agentglow.stage("decode"):` inside a job / request / session; several open at once = parallel stages.
    Decorator: `@agentglow.stage("decode")` / `@agentglow.stage` (name = the function's name)."""
    if is_target(name):  # bare @stage
        return stage()(name)
    return rebuild(_Span(f"stage {name or 'stage'}", {"agentglow.stage": name or "stage"}),
                   lambda c: _Span(f"stage {name or c.name}", {"agentglow.stage": name or c.name}))


def traced(name: Any = None, kind: str = "step") -> _Span:
    """`@agentglow.traced` / `@agentglow.traced("parse", kind="step")` (or `with agentglow.traced("parse"):`): the
    function is one step of whoever called it (the current agent / request / job / session), drawn like a stage. No
    new agent, no arguments or return value recorded."""
    if is_target(name):  # bare @traced
        return traced(None, kind)(name)

    def make(n: str) -> _Span:
        return _Span(f"{kind} {n}", {"agentglow.stage": n, "agentglow.stage.kind": kind})
    return rebuild(make(name or kind), lambda c: make(name or c.name))


def progress(i: float, n: float | None = None, *, eta_s: float | None = None, label: str | None = None) -> None:
    """`progress(3, 10)` or `progress(0.3)`: fraction done of the current job / session / request (ETA estimated by the
    server from the rate when `eta_s` is not given)."""
    frac = (float(i) / float(n)) if n else float(i)
    _signal("progress", {"frac": round(min(1.0, max(0.0, frac)), 4), "i": _num(i) if n else None, "n": _num(n),
                         "eta_ms": int(eta_s * 1000) if eta_s is not None else None, "label": label})


def capacity(name: str, used: float, max: float) -> None:  # noqa: A002 (the documented parameter name)
    """Admission gauge of a service / resource: `capacity("calls", used=3, max=4)`."""
    _signal("capacity", {"name": name, "used": _num(used), "max": _num(max)})


def rejected(reason: str, retry_after: float | None = None, status: int | None = None) -> None:
    """Work turned away on purpose (backpressure / admission: 429, 503 with Retry-After): amber, not an error.
    `retry_after` in seconds."""
    _signal("rejected", {"reason": reason, "retry_after_ms": int(retry_after * 1000) if retry_after is not None else None,
                         "status": status})


class Pool:
    """A pool of `size` interchangeable instances (model replicas, GPUs, workers). `lease()` really limits concurrency
    to `size` (sync `with` and `async with`) and reports wait time vs use time per lease, device labels and busy counts."""

    def __init__(self, name: str, size: int, kind: str = "worker", devices: list | None = None, group: str | None = None) -> None:
        self.name, self.size, self.kind = name, max(1, int(size)), kind if kind in POOL_KINDS else "worker"
        self.group = group
        devs = list(devices or [])
        self.devices = [str(devs[k % len(devs)]) if devs else None for k in range(self.size)]
        self._lock = threading.Lock()
        self._free = list(range(self.size))
        self._waiters: deque = deque()

    @property
    def busy(self) -> int:
        return self.size - len(self._free)

    @property
    def waiting(self) -> int:
        return len(self._waiters)

    def lease(self, fn: Any = None) -> "Lease":
        """`with pool.lease():` / `async with pool.lease():`, or as a decorator `@pool.lease()` / `@pool.lease`:
        each call holds one instance for its duration."""
        return Lease(self)(fn) if fn is not None else Lease(self)

    async def _acquire_async(self) -> int:
        with self._lock:
            if self._free:
                return self._free.pop(0)
            loop = asyncio.get_running_loop()
            w = ("a", loop.create_future(), loop)
            self._waiters.append(w)
        try:
            return await w[1]
        except asyncio.CancelledError:
            with self._lock:
                try:
                    self._waiters.remove(w)
                except ValueError:
                    pass  # already handed an instance: _deliver gives it back
            raise

    def _acquire_sync(self) -> int:
        with self._lock:
            if self._free:
                return self._free.pop(0)
            w = ("s", threading.Event(), [])
            self._waiters.append(w)
        w[1].wait()
        return w[2][0]

    def _release(self, idx: int) -> None:
        with self._lock:
            while self._waiters:
                kind, obj, extra = self._waiters.popleft()
                if kind == "a":
                    if obj.done():
                        continue
                    extra.call_soon_threadsafe(self._deliver, obj, idx)
                    return
                extra.append(idx)
                obj.set()
                return
            self._free.append(idx)

    def _deliver(self, fut: asyncio.Future, idx: int) -> None:
        if fut.done():  # cancelled meanwhile
            self._release(idx)
        else:
            fut.set_result(idx)


class Lease(DualUse):
    """One lease of a pool instance; its span starts when acquired (backdated to the request: wait vs use time).
    Also a decorator (`@pool.lease()`): a fresh lease per call."""

    def __init__(self, pool: Pool) -> None:
        self.pool = pool
        self._remake = lambda c: Lease(pool)
        self.index: int | None = None
        self.device: str | None = None
        self._span: _Span | None = None

    def _open(self, t0: int, waiting: int) -> "Lease":
        p = self.pool
        self.device = p.devices[self.index] if self.index is not None else None
        wait_ms = round((time.time_ns() - t0) / 1e6, 1)
        self._span = _Span(f"lease {p.name}", {"agentglow.pool": p.name, "agentglow.pool.kind": p.kind,
                                               "agentglow.pool.size": p.size, "agentglow.pool.device": self.device,
                                               "agentglow.pool.instance": self.index, "agentglow.pool.wait_ms": wait_ms,
                                               "agentglow.pool.waiting": waiting, GROUP_ATTR: _group(p.group)},
                           start_ns=t0).start()
        return self

    def _close(self, exc: BaseException | None) -> None:
        if self._span is not None:
            self._span.end(exc)
        if self.index is not None:
            self.pool._release(self.index)
            self.index = None

    async def __aenter__(self) -> "Lease":
        t0, waiting = time.time_ns(), self.pool.waiting
        self.index = await self.pool._acquire_async()
        return self._open(t0, waiting)

    async def __aexit__(self, et, exc, tb) -> None:
        self._close(exc)

    def __enter__(self) -> "Lease":
        t0, waiting = time.time_ns(), self.pool.waiting
        self.index = self.pool._acquire_sync()
        return self._open(t0, waiting)

    def __exit__(self, et, exc, tb) -> None:
        self._close(exc)


_pools: dict[str, Pool] = {}
_pools_lock = threading.Lock()


def pool(name: str, size: int, kind: str = "worker", devices: list | None = None, group: str | None = None) -> Pool:
    """The process-wide pool `name` (created on first call; later calls return it). `group`: the resource group it
    joins (default: resource_group() / env AGENTGLOW_RESOURCE_GROUP, else `backend`)."""
    with _pools_lock:
        p = _pools.get(name)
        if p is None:
            p = _pools[name] = Pool(name, size, kind, devices, group)
        return p


class Inference(_Span):
    """A non-LLM model call (speech-to-text, TTS, embeddings, vision): `units` of work in `unit` (speed = units/s,
    RTF = seconds per unit for `*_s` units)."""

    def __init__(self, model: str, device: str | None = None, units: float | None = None, unit: str = "audio_s",
                 group: str | None = None) -> None:
        super().__init__(f"inference {model}", {"agentglow.inference.model": model, "agentglow.inference.device": device,
                                                "agentglow.inference.units": _num(units), "agentglow.inference.unit": unit,
                                                GROUP_ATTR: _group(group)})

    @property
    def units(self) -> float | None:
        return self._attrs.get("agentglow.inference.units")

    @units.setter
    def units(self, v: float) -> None:
        self._attrs["agentglow.inference.units"] = _num(v)
        self.set("agentglow.inference.units", _num(v))


def inference(model: str, device: Any = None, units: Any = None, unit: str = "audio_s", group: str | None = None) -> Inference:
    """`with agentglow.inference("whisper-small", units=12.5, unit="audio_s") as inf:` or as a decorator
    `@agentglow.inference("whisper-small", units=lambda audio, **_: len(audio) / 16000)` (`units` / `device` may be
    callables over the call's arguments). `group`: the resource group the model joins (e.g. "payment-integrity
    scorer"; default: resource_group() / env AGENTGLOW_RESOURCE_GROUP, else `backend`)."""
    return rebuild(Inference(model, device=None if callable(device) else device, units=None if callable(units) else units, unit=unit, group=group),
                   lambda c: Inference(model, device=c.value(device, "device"), units=c.value(units, "units"), unit=unit, group=group))


class Job(_CtxSpan):
    """Work keyed by a business id that crosses processes (API -> queue -> worker -> HTTP -> service): ONE node."""

    def __init__(self, id: Any, kind: str = "job", attempt: int = 1, max_attempts: int | None = None, parent: Any = None) -> None:
        self.id, self.kind, self.attempt, self.max_attempts = str(id), kind, int(attempt or 1), max_attempts
        super().__init__(f"job {kind}", {"agentglow.job.id": self.id, "agentglow.job.kind": kind,
                                         "agentglow.job.state": "running", "agentglow.job.attempt": self.attempt}, parent=parent)
        self._final: str | None = None

    def state(self, state: str) -> None:
        """The state this attempt ends in (`retrying`, `dead`, `failed`, `done`), instead of the default."""
        self._final = state

    def end(self, exc: BaseException | None = None) -> None:
        st = self._final
        if st is None:
            if exc is None:
                st = "done"
            elif self.max_attempts:
                st = "retrying" if self.attempt < self.max_attempts else "dead"
            else:
                st = "failed"
        self.set("agentglow.job.state", st)
        super().end(exc)


def job(id: Any, kind: str = "job", state: str | None = None, attempt: int = 1, max_attempts: int | None = None,
        parent: Any = None) -> Job:
    """`agentglow.job(order_id, kind="fulfil", state="queued")` records a state now (any process);
    `with agentglow.job(order_id, kind="fulfil", attempt=2, max_attempts=3):` wraps one attempt (running; then done,
    or on an exception retrying / dead / failed). Decorator: `@agentglow.job(id=lambda order_id, **_: order_id,
    kind="fulfil")`: each call is one attempt (`id` / `attempt` may be callables over the call's arguments; return
    -> done, exception -> retrying / dead with `max_attempts`, else failed)."""
    lazy = callable(id) or callable(attempt)
    j = Job("job" if callable(id) else id, kind, 1 if callable(attempt) else attempt, max_attempts, parent)
    if state is not None and not lazy:
        _signal("job", {"id": j.id, "kind": kind, "state": state, "attempt": j.attempt})

    def make(c: Any) -> Job:
        jid = c.value(id, "id")
        return Job(c.name if jid is None else jid, kind, c.value(attempt, "attempt", 1) or 1, max_attempts, parent)
    return rebuild(j, make)


def link(external_id: Any, label: str | None = None) -> None:
    """Inside an outbound call whose outcome arrives later (a payment charge, a callback URL): `complete(id)` closes it."""
    _signal("link", {"id": str(external_id), "label": label})


def complete(external_id: Any, status: str = "ok") -> None:
    """In the later inbound webhook / callback: the earlier call linked to `external_id` completed."""
    _signal("complete", {"id": str(external_id), "status": status})


def fallback(from_: str, to: str, reason: str = "fallback", job: Any = None) -> None:
    """A fallback path was taken (inline attempt timed out -> queued job); `job` = the job id it fell back to."""
    _signal("fallback", {"from": from_, "to": to, "reason": reason, "job": str(job) if job is not None else None})


def gate(name: str, state: str = "locked", attempts_left: int | None = None) -> None:
    """A stateful gate of the current agent / session (PIN check, verification, rate gate), persists until changed."""
    _signal("gate", {"name": name, "state": "unlocked" if str(state).lower() in ("unlocked", "open", "false") else "locked",
                     "attempts_left": attempts_left})


def backlog(topic: str, depth: int, pending: int | None = None, lag_ms: float | None = None) -> None:
    """Queue depth of a broker topic / stream (and pending = delivered but not acked, lag = age of the oldest)."""
    _signal("backlog", {"topic": topic, "depth": int(depth), "pending": pending, "lag_ms": _num(lag_ms)})


def lifecycle(state: str) -> None:
    """The process's service state: loading | warming | ready | degraded | draining | restarting | fatal."""
    _signal("lifecycle", {"state": str(state).lower()})


def metric(name: str, value: float, unit: str | None = None) -> None:
    """A metric pulse with a unit (`metric("transcribed", 1.8, unit="audio_min/min")`)."""
    _signal("metric", {"name": name, "value": _num(value), "unit": unit})


def event(kind: str, label: str | None = None, **fields: Any) -> None:
    """A business event (`event("signup", label="trial", seats=3)`): numbers / bools / short strings only."""
    attrs = {"agentglow.event": kind, "agentglow.event.label": label}
    for k, v in _safe_fields(fields).items():
        attrs[f"agentglow.event.{k}"] = v
    _Span(f"event {kind}", attrs).start().end()


def cache(name: str, hit: bool = True, group: str | None = None) -> None:
    """One cache lookup (hit rate on the cache's resource node); `group` as for pool()."""
    _signal("cache", {"name": name, "hit": bool(hit), "group": _group(group)})


# ---------------------------------------------------------------------------------------- waits / human approval
def _until_ms(until: Any, timeout_s: Any) -> Any:
    """Deadline -> epoch ms: `until` as epoch ms / seconds (< 1e11), a datetime (naive = UTC) or an ISO-8601 string
    (passed through, the server parses it); else now + `timeout_s`; else None."""
    if until is None:
        n = _num(timeout_s)
        return int((time.time() + n) * 1000) if n is not None else None
    if isinstance(until, datetime):
        return int((until if until.tzinfo else until.replace(tzinfo=timezone.utc)).timestamp() * 1000)
    if isinstance(until, str):
        return until or None
    n = _num(until)
    return None if n is None else int(n * 1000 if n < 1e11 else n)


def _span_id(v: Any) -> str | None:
    """`because=`: a decision (or any agentglow span object) -> its span id (hex); a string id as given."""
    sp = getattr(v, "span", None)
    if sp is not None:
        ctx = sp.get_span_context()
        return format(ctx.span_id, "016x") if ctx.is_valid else None
    return str(v)[:32] if isinstance(v, (str, int)) and str(v) else None


def wait(reason: Any = "wait", until: Any = None, timeout_s: float | None = None, *, title: Any = None,
         details: Any = None, url: Any = None, because: Any = None, kind: str | None = None) -> _Span:
    """`with agentglow.wait("vendor reply", timeout_s=3600):` (or `async with`, or `@agentglow.wait(...)`): the
    enclosing step / agent shows `waiting` with `reason` and a countdown to `until` (epoch ms / s, datetime, ISO-8601;
    or now + `timeout_s`) while the block runs. `title` (short), `details` (flat {key: str|int|float|bool}, max 12) and
    `url` (http(s), "open in app") are shown in the wait's details drawer; `because` = the decision that triggered the
    wait (the object `decision()` / `decided()` returned, or its span id). `kind="approval"`: see `approval()`.
    Decorator use: `title` / `details` / `url` may be callables over the call's arguments. Resuming is the app's job."""
    if is_target(reason):  # bare @wait
        return wait()(reason)

    def make(c: Any = None) -> _Span:
        def val(v: Any, f: str) -> Any:
            return c.value(v, f) if c is not None else (None if callable(v) else v)
        r = str(reason or "wait")
        attrs = {"agentglow.wait": r, "agentglow.wait.until": _until_ms(until, timeout_s), "agentglow.wait.kind": kind,
                 "agentglow.wait.title": val(title, "title"), "agentglow.wait.url": wait_url(val(url, "url")),
                 "agentglow.wait.because": _span_id(because)}
        if isinstance(attrs["agentglow.wait.title"], str):
            attrs["agentglow.wait.title"] = decision_text(attrs["agentglow.wait.title"], 80) or None
        else:
            attrs["agentglow.wait.title"] = None
        for k, v in wait_details(val(details, "details")).items():
            attrs[f"agentglow.wait.detail.{k}"] = v
        return _Span(f"wait {r}", attrs)
    return rebuild(make(), make)


def approval(reason: Any = "human approval", timeout_s: float | None = None, until: Any = None, *, title: Any = None,
             details: Any = None, url: Any = None, because: Any = None) -> _Span:
    """`async with agentglow.approval("approve refund", timeout_s=900, title="Refund $420", details={...}):` a wait
    on a human: listed under "Needs you" with Approve / Reject and a details drawer (the same wait contract plus
    `agentglow.wait.kind = "approval"`). The buttons POST /live/approve, which forwards to the app's
    AGENTGLOW_APPROVE_WEBHOOK; resuming the work (an event, a flag) is the app's job, this block only shows the wait."""
    if is_target(reason):  # bare @approval
        return approval()(reason)
    return wait(reason or "human approval", until, timeout_s, title=title, details=details, url=url, because=because,
                kind="approval")


# ---------------------------------------------------------------------------------------- FastAPI WebSockets
def _route_path(app: Any, scope: dict) -> str | None:
    try:
        from starlette.routing import Match

        for r in getattr(getattr(app, "router", None), "routes", []):
            m, _ = r.matches(scope)
            if m == Match.FULL:
                return getattr(r, "path", None)
    except Exception:
        pass
    return None


class _WsCounter:
    """Counts WebSocket frames (no content) and how the socket closed; gauges every GAUGE_S seconds."""

    GAUGE_S = 5.0

    def __init__(self, sess: Session) -> None:
        self.sess, self.fin, self.fout, self.code, self.by, self.at = sess, 0, 0, None, None, time.monotonic()

    def saw(self, msg: dict, inbound: bool) -> None:
        t = msg.get("type")
        if t == "websocket.receive":
            self.fin += 1
        elif t == "websocket.send":
            self.fout += 1
        elif t in ("websocket.disconnect", "websocket.close"):
            self.code, self.by = msg.get("code"), "client" if inbound else "server"
        if time.monotonic() - self.at >= self.GAUGE_S:
            self.at = time.monotonic()
            self.sess.progress(frames_in=self.fin, frames_out=self.fout)

    def finish(self, exc: BaseException | None) -> None:
        self.sess.progress(frames_in=self.fin, frames_out=self.fout)
        if exc is not None and type(exc).__name__ == "WebSocketDisconnect":  # the client went away: not an error
            self.code, self.by, exc = getattr(exc, "code", None), "client", None
        if exc is not None:
            reason = "error"
        elif self.by == "client":
            reason = "client_disconnect"
        elif self.by == "server":
            reason = "server_close"
        else:
            reason = "closed"
        self.sess.end(exc, reason=self.sess.reason or reason)


class session_ws:  # noqa: N801 (used like a function: `with agentglow.session_ws(websocket):`)
    """`async with agentglow.session_ws(websocket):` (or `with`) around a FastAPI / Starlette WebSocket handler: a
    session named after the route path (never the raw URL), frames counted, reason from how it closed."""

    def __init__(self, websocket: Any, name: str | None = None, kind: str = "ws") -> None:
        sc = getattr(websocket, "scope", {}) or {}
        route = sc.get("route")
        self.ws = websocket
        self.sess = Session(name or getattr(route, "path", None) or _route_path(sc.get("app"), sc) or "websocket", kind=kind)
        self.counter = _WsCounter(self.sess)

    def __enter__(self) -> Session:
        ws, c = self.ws, self.counter
        rcv, snd = getattr(ws, "_receive", None), getattr(ws, "_send", None)
        if rcv is not None and snd is not None:
            async def receive():
                m = await rcv()
                c.saw(m, True)
                return m

            async def send(m):
                c.saw(m, False)
                await snd(m)

            ws._receive, ws._send = receive, send
        self.sess.start()
        return self.sess

    def __exit__(self, et, exc, tb) -> None:
        self.counter.finish(exc)

    async def __aenter__(self) -> Session:
        return self.__enter__()

    async def __aexit__(self, et, exc, tb) -> None:
        self.__exit__(et, exc, tb)


class _WsSessions:
    """Pure ASGI middleware: every WebSocket connection of the app is a session (name = the route template)."""

    def __init__(self, app: Any, fastapi_app: Any = None) -> None:
        self.app, self.fastapi_app = app, fastapi_app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "websocket" or _tracer() is None:
            return await self.app(scope, receive, send)
        sess = Session(_route_path(self.fastapi_app, scope) or "websocket", kind="ws")
        c = _WsCounter(sess)

        async def rcv():
            m = await receive()
            c.saw(m, True)
            return m

        async def snd(m):
            c.saw(m, False)
            await send(m)

        sess.start()
        err: BaseException | None = None
        try:
            return await self.app(scope, rcv, snd)
        except BaseException as e:
            err = e
            raise
        finally:
            c.finish(err)


def watch_websockets(app: Any) -> None:
    """Make every WebSocket route of a FastAPI / Starlette app a session (called by `watch(app=...)`). Once per app;
    must run before the app starts (it adds an ASGI middleware)."""
    if getattr(app, "_agentglow_ws", False):
        return
    app.add_middleware(_WsSessions, fastapi_app=app)
    app._agentglow_ws = True


# ---------------------------------------------------------------------------------------- Redis Streams backlog
def _redis_client(src: Any):
    import redis

    if isinstance(src, str):
        return redis.Redis.from_url(src)
    kw = getattr(src, "_connection_kwargs", None)
    if isinstance(kw, dict):  # a FastStream RedisBroker
        keep = {k: v for k, v in kw.items() if k in ("host", "port", "db", "username", "password", "ssl")}
        return redis.Redis(**keep)
    return src  # already a (sync) redis client


def _broker_streams(src: Any) -> list[tuple[str, str | None]]:
    out = []
    for s in getattr(src, "subscribers", None) or []:
        ss = getattr(s, "stream_sub", None)
        if ss is not None and getattr(ss, "name", None):
            out.append((str(ss.name), getattr(ss, "group", None)))
    return out


def _id_ms(entry_id: Any) -> int | None:
    try:
        s = entry_id.decode() if isinstance(entry_id, bytes) else str(entry_id)
        return int(s.split("-", 1)[0])
    except Exception:
        return None


def _suppressed():
    try:
        from opentelemetry.instrumentation.utils import suppress_instrumentation

        return suppress_instrumentation()
    except Exception:
        import contextlib

        return contextlib.nullcontext()


def sample_once(r: Any, streams: list[tuple[str, str | None]]) -> list[dict]:
    """One reading per stream: depth (undelivered + pending for a consumer group, else XLEN), pending, lag_ms."""
    rows, now = [], int(time.time() * 1000)
    with _suppressed():  # the sampler's own Redis calls are not traffic
        for name, group in streams:
            try:
                if not group:
                    rows.append({"topic": name, "depth": int(r.xlen(name))})
                    continue
                info = next((g for g in r.xinfo_groups(name) if _s(g.get("name")) == group), None)
                p = r.xpending(name, group) or {}
                pending = int(p.get("pending") or 0)
                undelivered = int((info or {}).get("lag") or 0)
                lag_ms = None
                oldest = _id_ms(p.get("min")) if pending else None
                if oldest is None and undelivered and info is not None:
                    nxt = r.xrange(name, min=f"({_s(info.get('last-delivered-id'))}", count=1)
                    oldest = _id_ms(nxt[0][0]) if nxt else None
                if oldest is not None:
                    lag_ms = max(0, now - oldest)
                rows.append({"topic": name, "depth": undelivered + pending, "pending": pending, "lag_ms": lag_ms})
            except Exception as e:  # a missing stream / group: skip this round
                log.debug("agentglow: backlog sample of %s failed: %s", name, e)
    return rows


def _s(v: Any) -> str:
    return v.decode() if isinstance(v, bytes) else str(v)


_samplers: dict[int, threading.Thread] = {}


def sample_backlog(src: Any, streams: list | None = None, every_s: float = 3.0) -> bool:
    """Opt-in Redis Streams sampler (a daemon thread): every `every_s` seconds XLEN / XPENDING of `streams` (names, or
    (name, group) pairs; default: the FastStream broker's subscribed streams) -> `backlog`. Once per source.
    `watch(broker=broker, backlog=True)` starts it. Returns False when redis-py is missing."""
    if id(src) in _samplers:
        return True
    try:
        r = _redis_client(src)
    except ImportError:
        return False
    fixed = [(s, None) if isinstance(s, str) else (str(s[0]), s[1]) for s in streams] if streams else None

    def run() -> None:
        while True:
            time.sleep(max(0.5, float(every_s)))
            try:
                for row in sample_once(r, fixed or _broker_streams(src)):
                    backlog(row["topic"], row["depth"], row.get("pending"), row.get("lag_ms"))
            except Exception as e:
                log.debug("agentglow: backlog sampler: %s", e)

    t = _samplers[id(src)] = threading.Thread(target=run, name="agentglow-backlog", daemon=True)
    t.start()
    return True


# ============================================================================================ server side
JOB_MAX_NODES = int(os.environ.get("AGENTGLOW_JOB_MAX_NODES", "12"))  # live job nodes (more are tracked, not drawn)
JOB_FAILED_MS = 15_000  # a failed job with no retry for this long exits (failed)
JOB_IDLE_MS = 300_000  # a job with no news for this long exits (done)
LINK_TTL_MS = 3_600_000  # an open link waits this long for its completion
RATE_MS = {"metric": 500, "capacity": 250, "progress": 200, "backlog": 500, "gauge": 1000}
CACHE_PULSE_MS = 250
LABEL_BAD_RE = re.compile(r"[^A-Za-z0-9:_./@ #{}-]+")


def _label(v: Any, n: int = 40) -> str:
    return LABEL_BAD_RE.sub("-", decision_text(v, n)).strip("- ") if v is not None else ""


def _key(v: Any) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(v))[:32]


def _pct(xs: list, q: float) -> int:
    if not xs:
        return 0
    s = sorted(xs)
    return int(round(s[min(len(s) - 1, int(q * (len(s) - 1) + 0.5))]))


@dataclass
class _Job:
    id: str  # node id
    job_id: str
    run: str
    kind: str
    state: str = "queued"
    attempt: int = 1
    at: str | None = None  # service agent id of the last report
    last: int = 0
    spawned: bool = False
    exited: bool = False
    exit_at: int | None = None  # failed: exit at this ts unless a retry comes
    spawn_ev: dict | None = None
    state_ev: dict | None = None


@dataclass
class _Res:
    kind: str
    run: str
    calls: int = 0
    ms: list = field(default_factory=list)
    waits: list = field(default_factory=list)
    units: float = 0.0
    unit: str | None = None
    busy_ms: float = 0.0
    hits: int = 0
    misses: int = 0
    size: int | None = None
    waiting: int | None = None
    open: dict = field(default_factory=dict)  # lease span id -> device
    devices: dict = field(default_factory=dict)  # device -> size
    dirty: bool = False


class Prims:
    def __init__(self, mapper: "Mapper") -> None:
        self.m = mapper
        self.jobs: dict[tuple, _Job] = {}
        self.sessions: dict[str, str] = {}  # flat session key -> node id
        self.links: dict[tuple, tuple] = {}  # (scope, ref) -> (owner, run, ts, label)
        self.res: dict[tuple, _Res] = {}  # (server, resource) -> stats window
        self.group_kinds: dict[str, str] = {}  # named resource group -> "model" (only models so far) / "mcp"
        self.last: dict[tuple, int] = {}  # rate limits
        self.eta: dict[str, tuple] = {}  # owner -> (t0, f0, last frac)
        self.state: dict[tuple, dict] = {}  # (kind, owner, name) -> latest lifecycle / gate / capacity event (replay)
        self.anchors: dict[str, "Span"] = {}
        self.handled: dict[str, None] = {}  # signal span ids (live + OTLP dedupe)
        self.last_tick: int | None = None

    # ------------------------------------------------------------------ helpers
    def _emit(self, out: list, ev: dict) -> dict:
        out.append(ev)
        return ev

    def _limited(self, key: tuple, ts: int, ms: int, force: bool = False) -> bool:
        if not force and ts - self.last.get(key, -ms) < ms:
            return True
        self.last[key] = ts
        while len(self.last) > 20_000:
            self.last.pop(next(iter(self.last)))
        return False

    def _run_of(self, owner: str, fallback: str) -> str:
        ag = self.m.agents.get(owner)
        return ag.run if ag else fallback

    @staticmethod
    def _scope(a: dict) -> Any:
        return a.get("agentglow.scope") or a.get("agentglow.run.scope")

    def anchored(self, a: dict) -> bool:
        """A root (or orphan) span of a primitive: it hangs off its process's service instead of starting a run."""
        return any(k in a for k in ("agentglow.session", "agentglow.job.id", "agentglow.stage", "agentglow.pool",
                                    "agentglow.inference.model")) or (a.get("agentglow.event") not in (None, "order"))

    def anchor(self, d: dict, out: list) -> "Span":
        """A never-ending pseudo span standing for the process's service (an agent under it = a subagent of it)."""
        from .mapper import Span

        a = d.get("attributes") or {}
        ts = d.get("start_time_ms") or d.get("end_time_ms") or 0
        sid = self.m.svc.ensure(self.m.svc.service_name(d), self._scope(a), ts, out)
        s = self.anchors.get(sid)
        if s is None or self.m.spans.get(s.id) is not s:
            s = Span(f"anchor:{sid}", "", None, "service", ts, {}, self.m.agents[sid].run if sid in self.m.agents else self.m.svc.run_id(self._scope(a)))
            s.alias = s.svc = sid
            s.entry = "anchor"
            self.anchors[sid] = self.m.spans[s.id] = s
        return s

    def _svc_of(self, s: "Span | None") -> str | None:
        return s.svc if s is not None else None

    # ------------------------------------------------------------------ signal spans
    def signal(self, d: dict, out: list) -> None:
        """A finished signal span (`agentglow.signal`) or business event span: never a run / LLM / tool of its own."""
        from .mapper import Span

        sid = d["span_id"]
        if sid in self.handled:
            return
        self.handled[sid] = None
        while len(self.handled) > 50_000:
            self.handled.pop(next(iter(self.handled)))
        a = d.get("attributes") or {}
        ts = d.get("end_time_ms") or d.get("start_time_ms") or 0
        parent = self.m.spans.get(d.get("parent_span_id") or "")
        if parent is None:
            parent = self.anchor(d, out)
        tmp = Span(sid, d.get("trace_id") or "", parent.id, d.get("name") or "signal", ts, a, parent.run)
        tmp.svc, tmp.mcp_host = parent.svc, parent.mcp_host
        name = a.get(SIGNAL)
        owner = tmp.svc if name == "lifecycle" and tmp.svc in self.m.agents else self.m._owner(tmp, out)  # per service
        run = self._run_of(owner, parent.run)
        if name:
            pre = f"agentglow.{name}."
            f = {k[len(pre):]: v for k, v in a.items() if k.startswith(pre)}
        else:  # business event span: agentglow.event = kind
            f = {k[len("agentglow.event."):]: v for k, v in a.items() if k.startswith("agentglow.event.")}
            f["kind"], name = a.get("agentglow.event"), "event"
        if name == "rejected":  # the enclosing request is a rejection, not an error
            cur, hops = parent, 0
            while cur is not None and hops < 50:
                if cur.entry and cur.entry != "anchor":
                    cur.attrs["agentglow.rejected"] = f.get("reason") or "rejected"
                    break
                cur, hops = self.m.spans.get(cur.parent or ""), hops + 1
        self.handle(name, f, owner, run, self._scope(a) or self.m.scopes.get(run), tmp.svc, ts, out)

    # ------------------------------------------------------------------ primitive spans
    def _cover(self, s: "Span", out: list) -> None:
        """The request a primitive job / session runs in is drawn by that node: it never also becomes a long-request
        job node (backend.py `req:<span id>`), and one already promoted hands its node over (exit done)."""
        from .backend import LONG_PREFIX

        cur, hops = s, 0
        while cur is not None and hops < 50:
            if cur.entry and cur.entry != "anchor":
                cur.covered = True
                if cur.alias and cur.svc and cur.alias != cur.svc and cur.alias.startswith(LONG_PREFIX):
                    self.m.svc._end_job(cur.alias, self.m.svc.svcs.get(cur.svc), "done", s.start, out)
                    cur.alias = cur.svc
                return
            cur, hops = self.m.spans.get(cur.parent or ""), hops + 1

    def start(self, s: "Span", out: list) -> None:
        a, ts = s.attrs, s.start
        if "agentglow.job.id" in a or "agentglow.session" in a:
            self._cover(s, out)
        if "agentglow.job.id" in a:
            j = self._job(str(a["agentglow.job.id"]), a.get("agentglow.job.kind"), self._scope(a) or self.m.scopes.get(s.run), s.svc, ts, out)
            if j is not None:
                s.alias = j.id  # stages, progress, leases ... inside it belong to the job node
                self._job_state(j, a.get("agentglow.job.state") or "running", a.get("agentglow.job.attempt"), s.svc, ts, out)
        if "agentglow.session" in a and s.agent:
            ev = {"type": "session", "run_id": s.run, "id": s.id, "name": _label(a.get("agentglow.session")),
                  "kind": _label(a.get("agentglow.session.kind") or "session", 16), "phase": "start", "ts": ts}
            if a.get("agentglow.session.id") is not None:
                ev["ref"] = _label(a["agentglow.session.id"], 24)
            out.append(ev)
        if "agentglow.stage" in a:
            owner = self.m._owner(s, out)
            out.append({"type": "stage", "run_id": self._run_of(owner, s.run), "id": owner, "name": _label(a["agentglow.stage"]),
                        "status": "running", "ts": ts})
        if "agentglow.pool" in a:
            self._lease(s, out, "call")
        if "agentglow.inference.model" in a:
            self._infer(s, out, "call")

    def end(self, s: "Span", out: list) -> None:
        a, ts = s.attrs, s.end or s.start
        failed = s.status == "error"
        if "agentglow.job.id" in a:
            j = self.jobs.get((self._scope(a) or self.m.scopes.get(s.run), str(a["agentglow.job.id"])))
            if j is not None:
                self._job_state(j, a.get("agentglow.job.state") or ("failed" if failed else "done"), a.get("agentglow.job.attempt"), s.svc, ts, out)
        if "agentglow.session" in a and s.agent:
            ev = {"type": "session", "run_id": s.run, "id": s.id, "name": _label(a.get("agentglow.session")),
                  "kind": _label(a.get("agentglow.session.kind") or "session", 16), "phase": "end", "ms": max(0, ts - s.start), "ts": ts}
            for k in ("outcome", "reason"):
                v = _label(a.get(f"agentglow.session.{k}"), 40)
                if v:
                    ev[k] = v
            out.append(ev)
        if "agentglow.stage" in a:
            owner = self.m._owner(s, out)
            out.append({"type": "stage", "run_id": self._run_of(owner, s.run), "id": owner, "name": _label(a["agentglow.stage"]),
                        "status": "failed" if failed else "done", "ms": max(0, ts - s.start), "ts": ts})
        if "agentglow.pool" in a:
            self._lease(s, out, "result")
        if "agentglow.inference.model" in a:
            self._infer(s, out, "result")

    def _resource(self, name: str, kind: str, run: str, ts: int, out: list, group: str = GROUP) -> _Res:
        key = (group, name)
        r = self.res.get(key)
        if r is None:
            r = self.res[key] = _Res(kind, run)
        if key not in self.m.svc.known:
            self.m.svc.known.add(key)
            ev = {"type": "mcp_register", "server": group, "resources": [{"name": name, "kind": kind}], "ts": ts}
            if group != GROUP:  # a named group: "model" while it holds only models (shown as ML), else "mcp"
                prev = self.group_kinds.get(group)
                ev["kind"] = self.group_kinds[group] = "model" if kind == "model" and prev in (None, "model") else "mcp"
            out.append(ev)
        r.run = run
        return r

    @staticmethod
    def _group_of(v: Any) -> str:
        return _label(v) or GROUP

    def _mcp(self, owner: str, run: str, tool: str, res: str, kind: str, phase: str, ts: int, out: list, ms: float | None = None,
             group: str = GROUP, **extra) -> None:
        ev = {"type": "mcp", "run_id": run, "id": owner, "server": group, "tool": tool, "phase": phase, "ts": ts,
              "resource": res, "resource_kind": kind}
        if ms is not None:
            ev["latency_ms"] = round(ms, 1)
        ev.update({k: v for k, v in extra.items() if v is not None})
        out.append(ev)

    def _lease(self, s: "Span", out: list, phase: str) -> None:
        a = s.attrs
        name, kind = _label(a.get("agentglow.pool")), str(a.get("agentglow.pool.kind") or "worker")
        kind = kind if kind in POOL_KINDS else "worker"
        if not name:
            return
        owner = self.m._owner(s, out)
        run = self._run_of(owner, s.run)
        ts = s.start if phase == "call" else (s.end or s.start)
        grp = self._group_of(a.get(GROUP_ATTR))
        r = self._resource(name, kind, run, ts, out, grp)
        size = _num(a.get("agentglow.pool.size"))
        r.size = int(size) if size else r.size
        dev = _label(a.get("agentglow.pool.device"), 24) or None
        r.dirty = True
        if phase == "call":
            r.open[s.id] = dev
            if dev and dev not in r.devices:
                r.devices[dev] = 0
            w = _num(a.get("agentglow.pool.wait_ms"))
            if w is not None:
                r.waits.append(w)
            r.waiting = int(_num(a.get("agentglow.pool.waiting")) or 0)
            self._mcp(owner, run, "lease", name, kind, "call", ts, out, device=dev, group=grp)
        else:
            r.open.pop(s.id, None)
            ms = max(0, ts - s.start - (_num(a.get("agentglow.pool.wait_ms")) or 0))
            r.calls += 1
            r.ms.append(ms)
            self._mcp(owner, run, "lease", name, kind, "result", ts, out, ms=ms, device=dev, group=grp, error=True if s.status == "error" else None)

    def _infer(self, s: "Span", out: list, phase: str) -> None:
        a = s.attrs
        name = _label(a.get("agentglow.inference.model"))
        if not name:
            return
        owner = self.m._owner(s, out)
        run = self._run_of(owner, s.run)
        ts = s.start if phase == "call" else (s.end or s.start)
        grp = self._group_of(a.get(GROUP_ATTR))
        r = self._resource(name, "model", run, ts, out, grp)
        dev = _label(a.get("agentglow.inference.device"), 24) or None
        unit = _label(a.get("agentglow.inference.unit"), 16) or None
        if phase == "call":
            self._mcp(owner, run, "infer", name, "model", "call", ts, out, device=dev, group=grp)
            return
        ms = max(0, ts - s.start)
        units = _num(a.get("agentglow.inference.units"))
        r.calls += 1
        r.ms.append(ms)
        r.busy_ms += ms
        if units:
            r.units += units
            r.unit = unit
        r.dirty = True
        self._mcp(owner, run, "infer", name, "model", "result", ts, out, ms=ms, device=dev, units=units, unit=unit if units else None,
                  group=grp, error=True if s.status == "error" else None)

    # ------------------------------------------------------------------ jobs
    def _job(self, job_id: str, kind: Any, scope: Any, svc: str | None, ts: int, out: list) -> _Job | None:
        jid = _label(job_id, 40)
        if not jid:
            return None
        key = (scope, job_id)
        j = self.jobs.get(key)
        if j is None or j.exited:
            run = self.m.svc.run_id(scope)
            if run not in self.m.runs and svc is None:
                self.m.svc.ensure("jobs", scope, ts, out)  # no service at all: the jobs hang off a `jobs` node
                svc = f"svc:{scope}:jobs" if scope else "svc:jobs"
            j = _Job(f"job:{scope}:{jid}" if scope else f"job:{jid}", jid, run, _label(kind or "job", 24) or "job", last=ts)
            self.jobs[key] = j
            while len(self.jobs) > 20_000:
                self.jobs.pop(next(iter(self.jobs)))
            if sum(1 for x in self.jobs.values() if x.spawned and not x.exited) < JOB_MAX_NODES:
                from .mapper import Agent

                parent = svc if svc in self.m.agents else None
                name = f"{j.kind} {jid[:10]}"
                ev = {"type": "spawn", "run_id": run, "id": j.id, "agent": name, "parent_id": parent, "subagent": parent is not None, "ts": ts}
                self.m.agents[j.id] = Agent(name, run)
                j.spawned, j.spawn_ev, j.at = True, ev, svc
                out.append(ev)
                if parent:
                    out.append({"type": "message", "run_id": run, "from_id": parent, "to_id": j.id, "text": j.kind, "ts": ts})
        elif kind and j.kind == "job":
            j.kind = _label(kind, 24) or j.kind
        return j

    def _job_state(self, j: _Job, state: Any, attempt: Any, svc: str | None, ts: int, out: list) -> None:
        st = str(state or "running").lower()
        st = st if st in JOB_STATES else "running"
        att = int(_num(attempt) or j.attempt or 1)
        moved = svc is not None and svc != j.at and svc in self.m.agents
        retry = att > j.attempt
        j.state, j.attempt, j.last = st, max(1, att), ts
        j.exit_at = ts + JOB_FAILED_MS if st == "failed" else None
        if not j.spawned:
            return
        if j.exited:
            return
        if moved or retry:  # the job moved on (API -> worker) or came back for another attempt: a comet to it
            out.append({"type": "message", "run_id": j.run, "from_id": svc if moved else (j.at or j.id), "to_id": j.id,
                        "text": f"retry #{j.attempt}" if retry else st, "ts": ts})
        if svc is not None and svc in self.m.agents:
            j.at = svc
        ev = {"type": "job", "run_id": j.run, "id": j.id, "job_id": j.job_id, "kind": j.kind, "state": st, "attempt": j.attempt, "ts": ts}
        if j.at and j.at in self.m.svc.svcs:
            ev["at"] = self.m.svc.svcs[j.at].name
        j.state_ev = ev
        out.append(ev)
        if st in ("done", "dead"):
            self._job_exit(j, "done" if st == "done" else "failed", ts, out)

    def _job_exit(self, j: _Job, status: str, ts: int, out: list) -> None:
        if j.exited:
            return
        j.exited = True
        ag = self.m.agents.get(j.id)
        if ag:
            ag.done = True
        out.append({"type": "exit", "run_id": j.run, "id": j.id, "status": status, "ts": ts})

    # ------------------------------------------------------------------ signals (spans and flat events)
    def handle(self, name: str, f: dict, owner: str, run: str, scope: Any, svc: str | None, ts: int, out: list) -> None:
        base = {"run_id": run, "id": owner, "ts": ts}
        if name == "progress":
            frac = _num(f.get("frac"))
            if frac is None:
                i, n = _num(f.get("i")), _num(f.get("n"))
                frac = (i / n) if i is not None and n else None
            if frac is None:
                return
            frac = min(1.0, max(0.0, frac))
            t0 = self.eta.get(owner)
            if t0 is None or frac < t0[2] or ts - t0[0] > 3_600_000:
                t0 = (ts, frac, frac)
            self.eta[owner] = (t0[0], t0[1], frac)
            if self._limited(("progress", owner), ts, RATE_MS["progress"], force=frac >= 1.0):
                return
            ev = {"type": "progress", **base, "frac": round(frac, 4)}
            for k in ("i", "n"):
                if _num(f.get(k)) is not None:
                    ev[k] = _num(f.get(k))
            eta = _num(f.get("eta_ms"))
            if eta is None and frac > t0[1] and frac < 1.0:
                eta = (ts - t0[0]) / (frac - t0[1]) * (1.0 - frac)
            if eta is not None:
                ev["eta_ms"] = int(max(0, eta))
            if f.get("label"):
                ev["label"] = _label(f["label"])
            out.append(ev)
        elif name == "capacity":
            used, mx = _num(f.get("used")), _num(f.get("max"))
            cname = _label(f.get("name") or "capacity")
            if used is None or not mx:
                return
            key = ("capacity", owner, cname)
            prev = self.state.get(key)
            edge = prev is not None and (prev["used"] >= prev["max"]) != (used >= mx)
            if self._limited(key, ts, RATE_MS["capacity"], force=edge or used >= mx and not prev):
                return
            self.state[key] = self._emit(out, {"type": "capacity", **base, "name": cname, "used": used, "max": mx})
        elif name == "rejected":
            ev = {"type": "rejected", **base, "reason": _label(f.get("reason") or "rejected", 60)}
            ra, st = _num(f.get("retry_after_ms")), _num(f.get("status"))
            if ra is not None:
                ev["retry_after_ms"] = int(ra)
            if st is not None:
                ev["status"] = int(st)
            out.append(ev)
        elif name == "job":
            j = self._job(str(f.get("id") or f.get("job_id") or ""), f.get("kind"), scope, svc, ts, out)
            if j is not None:
                self._job_state(j, f.get("state") or "queued", f.get("attempt"), svc, ts, out)
        elif name == "link":
            ref = _label(f.get("id") or f.get("ref"), 64)
            if not ref:
                return
            self.links[(scope, ref)] = (owner, run, ts, _label(f.get("label") or "callback"))
            while len(self.links) > 20_000:
                self.links.pop(next(iter(self.links)))
            out.append({"type": "deferred", **base, "ref": ref[-12:], "phase": "open", "label": _label(f.get("label") or "callback")})
        elif name == "complete":
            ref = _label(f.get("id") or f.get("ref"), 64)
            hit = self.links.pop((scope, ref), None)
            if hit is None:
                return
            src, srun, t0, lab = hit
            status = _label(f.get("status") or "ok", 16)
            out.append({"type": "deferred", "run_id": srun, "id": src, "ts": ts, "ref": ref[-12:], "phase": "done", "label": lab,
                        "status": status, "from_id": owner, "wait_ms": max(0, ts - t0)})
            if src != owner:
                out.append({"type": "message", "run_id": srun, "from_id": owner, "to_id": src, "text": f"{lab} {status}", "ts": ts})
        elif name == "fallback":
            ev = {"type": "fallback", **base, "from": _label(f.get("from") or "primary"), "to": _label(f.get("to") or "fallback"),
                  "reason": _label(f.get("reason") or "fallback", 60)}
            if f.get("job") or f.get("job_id"):
                j = self._job(str(f.get("job") or f.get("job_id")), None, scope, svc, ts, out)
                if j is not None and j.spawned:
                    ev["to_id"] = j.id
                    if j.state_ev is None:  # first heard of through the fallback: it is queued
                        self._job_state(j, "queued", 1, svc, ts, out)
            if "to_id" not in ev:
                to = f"svc:{scope}:{_label(f.get('to'), 48)}" if scope else f"svc:{_label(f.get('to'), 48)}"
                if to in self.m.svc.svcs and to != owner:
                    ev["to_id"] = to
            out.append(ev)
        elif name == "gate":
            gname = _label(f.get("name") or "gate")
            st = "unlocked" if str(f.get("state") or "").lower() in ("unlocked", "open") else "locked"
            ev = {"type": "gate", **base, "name": gname, "state": st}
            left = _num(f.get("attempts_left"))
            if left is not None:
                ev["attempts_left"] = int(left)
            self.state[("gate", owner, gname)] = self._emit(out, ev)
        elif name == "backlog":
            topic = _label(f.get("topic") or "queue", 60)
            depth = _num(f.get("depth"))
            if depth is None or self._limited(("backlog", topic, scope), ts, RATE_MS["backlog"]):
                return
            ev = {"type": "backlog", **base, "topic": topic, "depth": int(depth)}
            for k in ("pending", "lag_ms"):
                v = _num(f.get(k))
                if v is not None:
                    ev[k] = int(v)
            edge = next(((k[0], k[1]) for k in reversed(list(self.m.svc.edge_at)) if len(k) == 3 and k[2] == topic), None)
            if edge:
                ev["from_id"], ev["to_id"] = edge
            out.append(ev)
        elif name == "lifecycle":
            st = str(f.get("state") or "").lower()
            if st not in LIFECYCLE:
                return
            self.state[("lifecycle", owner, "")] = self._emit(out, {"type": "lifecycle", **base, "state": st})
        elif name == "metric":
            mname, v = _label(f.get("name") or "metric"), _num(f.get("value"))
            if v is None or self._limited(("metric", owner, mname), ts, RATE_MS["metric"]):
                return
            ev = {"type": "metric", **base, "name": mname, "value": round(v, 4)}
            if f.get("unit"):
                ev["unit"] = _label(f["unit"], 24)
            out.append(ev)
        elif name == "event":
            kind = _label(f.get("kind") or "event", 24)
            ev = {"type": "event", **base, "kind": kind}
            if f.get("label"):
                ev["label"] = _label(f["label"])
            fields = _safe_fields({_key(k): (decision_text(v, 40) if isinstance(v, str) else v) for k, v in f.items()
                                   if k not in ("kind", "label", "service", "event", "scope", "agent", "name")})
            if fields:
                ev["fields"] = fields
            out.append(ev)
        elif name == "cache":
            cname = _label(f.get("name") or "cache")
            hit = f.get("hit")
            hit = hit is True or str(hit).lower() in ("true", "1", "yes", "hit")
            grp = self._group_of(f.get("group"))
            r = self._resource(cname, "cache", run, ts, out, grp)
            if hit:
                r.hits += 1
            else:
                r.misses += 1
            r.dirty = True
            if not self._limited(("cache", owner, cname), ts, CACHE_PULSE_MS):
                tool = "hit" if hit else "miss"
                self._mcp(owner, run, tool, cname, "cache", "call", ts, out, group=grp)
                self._mcp(owner, run, tool, cname, "cache", "result", ts, out, ms=0, group=grp)
        elif name == "gauge":
            g = {_key(k): round(v, 3) for k, v in ((k, _num(v)) for k, v in f.items()) if v is not None}
            if not g or self._limited(("gauge", owner), ts, RATE_MS["gauge"]):
                return
            out.append({"type": "session", **base, "name": "", "kind": "", "phase": "progress", "gauges": dict(list(g.items())[:MAX_FIELDS])})
        elif name == "turn":
            ev = {"type": "session", **base, "name": "", "kind": "", "phase": "turn", "role": _label(f.get("role") or "user", 16)}
            g = {_key(k): round(v, 3) for k, v in ((k, _num(v)) for k, v in f.items() if k != "role") if v is not None}
            if g:
                ev["gauges"] = dict(list(g.items())[:MAX_FIELDS])
            out.append(ev)

    # ------------------------------------------------------------------ flat events (POST /v1/events)
    FLAT = {"session", "stage", "progress", "capacity", "rejected", "job", "link", "complete", "fallback", "gate", "backlog",
            "lifecycle", "metric", "event", "cache", "lease", "inference", "turn", "gauge"}

    def flat(self, e: dict, kind: str, svc: str, run: str, scope: Any, now: int) -> list[dict]:
        """One scrubbed flat event of service agent `svc` (already spawned) -> world events."""
        out: list[dict] = []
        owner = svc
        if e.get("job_id") is not None and kind not in ("job", "fallback"):
            j = self._job(str(e["job_id"]), e.get("kind") if kind == "job" else None, scope, svc, now, out)
            owner = j.id if j is not None and j.spawned and not j.exited else svc
        elif e.get("session_id") is not None:
            owner = self._flat_session(e, kind, svc, run, scope, now, out)
            if kind == "session":
                return out
        ms = max(0.0, _num(e.get("duration_ms")) or 0.0)
        if kind == "stage":
            st = str(e.get("status") or "running").lower()
            ev = {"type": "stage", "run_id": self._run_of(owner, run), "id": owner, "name": _label(e.get("name") or "stage"),
                  "status": st if st in ("running", "done", "failed") else "running", "ts": now}
            if ms:
                ev["ms"] = int(ms)
            out.append(ev)
        elif kind in ("lease", "inference"):
            res = _label(e.get("pool") if kind == "lease" else e.get("model"))
            if not res:
                return out
            rk = str(e.get("kind") or ("worker" if kind == "lease" else "model"))
            rk = rk if kind == "inference" or rk in POOL_KINDS else "worker"
            rk = "model" if kind == "inference" else rk
            grp = self._group_of(e.get("group"))
            r = self._resource(res, rk, run, now, out, grp)
            r.calls += 1
            r.ms.append(ms)
            r.dirty = True
            dev = _label(e.get("device"), 24) or None
            if kind == "lease":
                if _num(e.get("size")):
                    r.size = int(_num(e.get("size")))
                if _num(e.get("wait_ms")) is not None:
                    r.waits.append(_num(e.get("wait_ms")))
                if dev and dev not in r.devices:
                    r.devices[dev] = 0
            else:
                units = _num(e.get("units"))
                r.busy_ms += ms
                if units:
                    r.units += units
                    r.unit = _label(e.get("unit") or "units", 16)
            tool = "lease" if kind == "lease" else "infer"
            self._mcp(owner, run, tool, res, rk, "call", int(now - ms), out, device=dev, group=grp)
            self._mcp(owner, run, tool, res, rk, "result", now, out, ms=ms, device=dev, group=grp)
        else:
            f = dict(e)
            if kind == "job":
                f["id"] = e.get("job_id") or e.get("id")
            elif kind in ("link", "complete"):
                f["id"] = e.get("ref") or e.get("id")
            elif kind == "fallback":
                f["job"] = e.get("job_id")
            self.handle(kind, f, owner, self._run_of(owner, run), scope, svc, now, out)
        return out

    def _flat_session(self, e: dict, kind: str, svc: str, run: str, scope: Any, now: int, out: list) -> str:
        from .mapper import Agent

        sid = _label(e.get("session_id"), 40)
        key = f"{svc}|{sid}"
        node = self.sessions.get(key)
        phase = str(e.get("phase") or "start").lower() if kind == "session" else "progress"
        name = _label(e.get("name") or "session")
        skind = _label(e.get("kind") or "session", 16)
        if node is None:
            node = self.sessions[key] = f"ses:{svc}:{sid}"
            while len(self.sessions) > 5_000:
                self.sessions.pop(next(iter(self.sessions)))
            self.m.agents[node] = Agent(name, run)
            out.append({"type": "spawn", "run_id": run, "id": node, "agent": name, "parent_id": svc, "subagent": True, "ts": now})
            out.append({"type": "session", "run_id": run, "id": node, "name": name, "kind": skind, "phase": "start", "ref": sid[-12:], "ts": now})
        if kind != "session":
            return node
        if phase in ("progress", "turn"):
            f = dict(e.get("gauges") or {}) if isinstance(e.get("gauges"), dict) else {}
            if phase == "turn":
                f["role"] = e.get("role") or "user"
            self.handle("turn" if phase == "turn" else "gauge", f, node, run, scope, svc, now, out)
        elif phase == "end":
            ev = {"type": "session", "run_id": run, "id": node, "name": name, "kind": skind, "phase": "end", "ts": now}
            for k in ("outcome", "reason"):
                if e.get(k):
                    ev[k] = _label(e[k])
            out.append(ev)
            out.append({"type": "exit", "run_id": run, "id": node, "status": "failed" if str(e.get("status")).lower() in ("error", "failed") else "done", "ts": now})
            self.sessions.pop(key, None)
            ag = self.m.agents.get(node)
            if ag:
                ag.done = True
        return node

    # ------------------------------------------------------------------ tick + replay
    def tick(self, now: int) -> list[dict]:
        out: list[dict] = []
        window = 1000 if self.last_tick is None else max(1, min(10_000, now - self.last_tick))
        self.last_tick = now
        for (server, name), r in self.res.items():
            busy = len(r.open)
            if not (r.dirty or busy):
                continue
            ev = {"type": "resource_stats", "run_id": r.run, "server": server, "resource": name, "kind": r.kind,
                  "window_ms": window, "calls": r.calls, "p50_ms": _pct(r.ms, 0.5), "ts": now}
            if r.kind in POOL_KINDS:
                if r.size:
                    ev["size"] = r.size
                ev["busy"] = busy
                if r.waiting is not None:
                    ev["waiting"] = r.waiting
                if r.waits:
                    ev["wait_p50_ms"] = _pct(r.waits, 0.5)
                if r.devices:
                    per = {d: 0 for d in r.devices}
                    for d in r.open.values():
                        if d:
                            per[d] = per.get(d, 0) + 1
                    ev["devices"] = [{"device": d, "busy": b} for d, b in list(per.items())[:8]]
            if r.kind == "cache":
                ev["hits"], ev["misses"] = r.hits, r.misses
            if r.units:
                ev["units"], ev["unit"] = round(r.units, 3), r.unit or "units"
                if (r.unit or "").endswith("_s") and r.units > 0:
                    ev["rtf"] = round(r.busy_ms / 1000 / r.units, 3)
            out.append(ev)
            r.calls, r.ms, r.waits, r.units, r.busy_ms, r.hits, r.misses, r.dirty = 0, [], [], 0.0, 0.0, 0, 0, False
        for j in list(self.jobs.values()):
            if not j.spawned or j.exited:
                continue
            if j.exit_at is not None and now >= j.exit_at:
                self._job_exit(j, "failed", now, out)
            elif now - j.last > JOB_IDLE_MS:
                self._job_exit(j, "done", now, out)
        for k in [k for k, v in self.links.items() if now - v[2] > LINK_TTL_MS]:
            del self.links[k]
        return out

    def snapshot(self) -> list[dict]:
        """For a new viewer once these left the replay buffer: live job nodes (+ state), latest lifecycle / gates."""
        evs: list[dict] = []
        for j in self.jobs.values():
            if j.spawned and not j.exited:
                evs += [e for e in (j.spawn_ev, j.state_ev) if e]
        for (kind, owner, _), ev in self.state.items():
            if kind in ("lifecycle", "gate") and owner in self.m.agents:
                evs.append(ev)
        return evs
