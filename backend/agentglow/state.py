"""In-memory hub: span mapper + recent world events + MCP topology + SSE subscribers. One per server process."""
from __future__ import annotations

import asyncio
import os
import time
from collections import deque
from dataclasses import dataclass, field

from .claude_code import ClaudeCodeAdapter, env_ms
from .mapper import Mapper
from .scrub import scrub_span


@dataclass(frozen=True)
class Filter:
    """What one viewer may see. Empty = everything. scope: runs tagged with that scope only (unscoped runs never
    match). run: that run only. MCP topology registrations always pass."""
    scope: str | None = None
    run: str | None = None

    @property
    def empty(self) -> bool:
        return not self.scope and not self.run

    def match(self, ev: dict, scope_of) -> bool:
        if self.empty or ev.get("type") == "mcp_register":
            return True
        rid = ev.get("run_id")
        if rid is None or (self.run and rid != self.run):
            return False
        return not self.scope or scope_of(rid) == self.scope


@dataclass(eq=False)
class Sub:
    filter: Filter
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=10_000))


IDLE_DIM_MIN = 3.0  # default AGENTGLOW_IDLE_DIM_MIN: an open agent run with no events this long is shown idle


class Hub:
    def __init__(self, buffer: int | None = None, capture_prompts: bool = False, idle_ms: int | None = None) -> None:
        self.mapper = Mapper()
        self.claude_code = ClaudeCodeAdapter(capture_prompts=capture_prompts)
        # replay buffer (events); AGENTGLOW_BUFFER overrides the default (small values exercise the snapshot path)
        self.buffer: deque[dict] = deque(maxlen=buffer or int(os.environ.get("AGENTGLOW_BUFFER") or 5000))
        self.live = LiveState()  # open runs' state-carrying events, replayed once they left the buffer
        self.topology: dict[str, dict] = {}  # server -> merged mcp_register event
        self.subs: set[Sub] = set()
        # SSE event id = "<epoch>-<seq>": a reconnecting viewer's Last-Event-ID resumes after what it already applied
        # instead of re-adding replayed events (tokens, calls); another epoch (server restarted) = full replay
        self.epoch = format(time.time_ns(), "x")
        self.seq = 0
        # idle runs: an open agent run silent for idle_ms (0 = off) gets `run` status "idle" (+ `since`, its last event,
        # epoch ms), and "active" again right before its next event. Server-side, so every viewer agrees.
        self.idle_ms = idle_ms if idle_ms is not None else env_ms("AGENTGLOW_IDLE_DIM_MIN", IDLE_DIM_MIN)
        self.activity: dict[str, int] = {}  # run id -> wall clock ms of its latest published event
        self.idle: set[str] = set()
        self.clock = lambda: int(time.time() * 1000)  # activity clock (tests replace it)

    # ---- ingest (every path scrubs spans here: identity keys, raw prompts and secrets never reach events)
    def ingest_live(self, items: list[dict], scope: str | None = None) -> int:
        """`scope`: ingestion-side scope (e.g. `?scope=` on the endpoint) for spans that carry none."""
        n = 0
        for it in items:
            if isinstance(it, dict) and isinstance(it.get("span"), dict):
                self.publish(self.mapper.feed(it.get("kind", "end"), scrub_span(_with_scope(it["span"], scope))))
                n += 1
        return n

    def _ingest_cc(self, items: list[dict], scope: str | None = None) -> int:
        """Claude Code adapter output: live span items, plus ready `llm` events (trace tokens on hooks agents)."""
        evs: list[dict] = []  # one publish: a session's closing events go out together (no "active" before its end)
        for it in items:
            if "kind" in it:
                if isinstance(it.get("span"), dict):
                    evs += self.mapper.feed(it.get("kind", "end"), scrub_span(_with_scope(it["span"], scope)))
            else:
                evs.append(it)
        self.publish(evs)
        return len(items)

    def ingest_ended(self, spans: list[dict], now_ms: int | None = None, scope: str | None = None) -> int:
        spans = [scrub_span(_with_scope(s, scope)) for s in spans]
        cc = [s for s in spans if str(s.get("name") or "").startswith("claude_code.")]
        if cc:  # Claude Code OTel traces: merged with its hooks, or translated into live spans
            self._ingest_cc(self.claude_code.traces(cc, now_ms or int(time.time() * 1000)), scope)
        self.publish(self.mapper.feed_ended([s for s in spans if not str(s.get("name") or "").startswith("claude_code.")]))
        return len(spans)

    def ingest_hook(self, payload: dict, now_ms: int, scope: str | None = None) -> int:
        """Claude Code hook payload (scrubbed by the adapter before it builds spans). `scope` (hook URL `?scope=`)
        becomes the scope of the runs it builds."""
        return self._ingest_cc(self.claude_code.handle(payload, now_ms), scope)

    def ingest_events(self, items: list, now_ms: int, scope: str | None = None) -> int:
        """Flat events (POST /v1/events, agentglow.pulse()): docs/SPEC.md "Backend services" > "Flat events".
        Scrubbed like spans (backend.Services.flat runs scrub_attrs on each event)."""
        n = 0
        for it in items:
            if isinstance(it, dict):
                self.publish(self.mapper.svc.flat(it, now_ms, scope))
                n += 1
        return n

    def tick(self, now_ms: int) -> None:
        self.publish(self.mapper.tick(now_ms))
        self._ingest_cc(self.claude_code.tick(now_ms))
        self.publish(self._idle_tick(now_ms))

    # ---- idle runs
    def _idle_tick(self, now: int) -> list[dict]:
        """`run` status "idle" for open agent runs silent for idle_ms. Never the services run, nor a run that is quiet
        on purpose (Mapper.quiet_runs: an open wait / approval / sleep, a parked step, an open session / job)."""
        runs = self.mapper.runs
        for rid in [r for r in self.activity if r not in runs]:  # ended (or never a mapper run): forget it
            self.activity.pop(rid, None)
            self.idle.discard(rid)
        if not self.idle_ms:
            return []
        due = [rid for rid, t in self.activity.items()
               if rid not in self.idle and now - t >= self.idle_ms and not runs[rid].service]
        if not due:
            return []
        quiet = self.mapper.quiet_runs()
        out = []
        for rid in due:
            if rid not in quiet:
                self.idle.add(rid)
                out.append({"type": "run", "run_id": rid, "status": "idle", "since": self.activity[rid], "ts": now})
        return out

    def _note_activity(self, events: list[dict]) -> list[dict]:
        """Marks each event's run active now; an idle run gets `run` status "active" right before its event."""
        out: list[dict] = []
        now = self.clock()
        ending = {e.get("run_id") for e in events if e.get("type") == "run" and e.get("status") in ("completed", "failed")}
        for ev in events:
            rid = ev.get("run_id")
            if rid is not None and ev.get("type") != "mcp_register":
                st = ev.get("status") if ev.get("type") == "run" else None
                if st in ("completed", "failed"):
                    self.activity.pop(rid, None)
                    self.idle.discard(rid)
                elif st not in ("idle", "active"):
                    if rid in self.idle:
                        self.idle.discard(rid)
                        if rid not in ending:  # its closing events (a timeout close) are not a comeback
                            out.append({"type": "run", "run_id": rid, "status": "active", "ts": now})
                    self.activity[rid] = now
            out.append(ev)
        return out

    def register_mcp(self, server: str, resources: list[dict], ts: int) -> dict:
        ev = {"type": "mcp_register", "server": server, "resources": resources, "ts": ts}
        self.publish([ev])
        return ev

    # ---- fan-out (each subscriber carries its Filter)
    def scope_of(self, run_id: str | None) -> str | None:
        return self.mapper.scopes.get(run_id) if run_id else None

    def publish(self, events: list[dict]) -> None:
        self._flush_newly_scoped()
        for ev in self._note_activity(events):
            if ev.get("type") == "mcp_register":
                ev = self._merge_topology(ev)
            else:
                sc = self.scope_of(ev.get("run_id"))
                if sc:
                    ev["scope"] = sc
                self.seq += 1
                ev["seq"] = self.seq
                self.buffer.append(ev)
                self.live.note(ev)
            for sub in list(self.subs):
                if sub.filter.match(ev, self.scope_of):
                    self._put(sub, ev)

    def _flush_newly_scoped(self) -> None:
        """A run's scope became known after some of its events went out (its first scoped span came late). Those
        early events reached only unfiltered and run-filtered viewers; now hand them to the matching scoped viewers
        (from the bounded buffer, so nothing extra is kept). Unscoped runs never reach scoped viewers."""
        runs, self.mapper.newly_scoped = self.mapper.newly_scoped, []
        for rid in runs:
            sc = self.scope_of(rid)
            early = [e for e in self.buffer if e.get("run_id") == rid and "scope" not in e]
            for e in early:
                e["scope"] = sc
            if not early:
                continue
            for sub in list(self.subs):
                if sub.filter.scope and sub.filter.match(early[0], self.scope_of):
                    for e in early:
                        self._put(sub, e)

    @staticmethod
    def _put(sub: Sub, ev: dict) -> None:
        try:
            sub.queue.put_nowait(ev)
        except asyncio.QueueFull:
            pass  # slow viewer: drop

    def _merge_topology(self, ev: dict) -> dict:
        cur = self.topology.get(ev["server"])
        if cur:
            names = {r["name"] for r in cur["resources"]}
            cur["resources"] += [r for r in ev.get("resources", []) if r.get("name") not in names]
            cur["ts"] = ev.get("ts", cur["ts"])
            if ev.get("kind"):
                cur["kind"] = ev["kind"]
        else:
            self.topology[ev["server"]] = {**ev, "resources": list(ev.get("resources", []))}
        return ev

    def replay(self, f: Filter = Filter(), after: int = 0) -> list[dict]:
        """What a new viewer needs: MCP topology + events of runs still in progress (finished runs would just flash),
        restricted to what its filter allows. `after`: a reconnecting viewer's last seq (this epoch), only newer events.

        Long runs outlive the bounded buffer: the state-carrying events of open runs that already left it (`run
        started`, spawns, statuses, open skills / waits / gates / sessions / jobs: LiveState, plus live backend
        services and job nodes) come first, in publish order, then the buffered events. Each event goes out at most
        once (snapshot entries are only those older than the oldest buffered event) and only if newer than `after`."""
        done = {e["run_id"] for e in self.buffer if e.get("type") == "run" and e.get("status") in ("completed", "failed")}
        done |= self.live.ended.keys()
        first = self.buffer[0].get("seq", 0) if self.buffer else self.seq + 1
        snap: dict[int, dict] = {}
        if after < first - 1:  # something this viewer has not seen already left the buffer
            for e in self.live.snapshot() + self.mapper.svc.snapshot() + self.mapper.prims.snapshot():
                s = e.get("seq", 0)
                if after < s < first and e.get("run_id") not in done and f.match(e, self.scope_of):
                    snap[s] = e
            if after:  # a resume across a gap: what ended meanwhile (exits of open runs, run ends; no-ops if unknown)
                for e in self.live.endings:
                    s = e.get("seq", 0)
                    if after < s < first and (e.get("type") == "run" or e.get("run_id") not in done) and f.match(e, self.scope_of):
                        snap[s] = e
        return list(self.topology.values()) + [snap[s] for s in sorted(snap)] + \
            [e for e in self.buffer if e.get("seq", 0) > after and e.get("run_id") not in done and f.match(e, self.scope_of)]

    def resume_after(self, last_event_id: str) -> int:
        """Last-Event-ID -> seq to replay after (0 = everything: none sent, or from another server instance / restart)."""
        epoch, _, seq = (last_event_id or "").partition("-")
        return int(seq) if epoch == self.epoch and seq.isdigit() else 0

    def event_id(self, ev: dict) -> str | None:
        return f"{self.epoch}-{ev['seq']}" if "seq" in ev else None

    def counts(self, f: Filter = Filter()) -> dict:
        # open_runs: agent runs only; the long-lived backend services run (never completes) is not "open work"
        runs = [rid for rid, r in self.mapper.runs.items() if not r.service]
        if f.empty:
            return {"subscribers": len(self.subs), "buffered": len(self.buffer), "open_runs": len(runs)}
        return {"buffered": sum(1 for e in self.buffer if e.get("type") != "mcp_register" and f.match(e, self.scope_of)),
                "open_runs": sum(1 for r in runs if f.match({"run_id": r}, self.scope_of))}

    def subscribe(self, f: Filter = Filter()) -> Sub:
        sub = Sub(f)
        self.subs.add(sub)
        return sub

    def unsubscribe(self, sub: Sub) -> None:
        self.subs.discard(sub)


def _with_scope(span: dict, scope: str | None) -> dict:
    if not scope:
        return span
    a = span.get("attributes") or {}
    if a.get("agentglow.scope") or a.get("agentglow.run.scope"):
        return span
    return {**span, "attributes": {**a, "agentglow.scope": scope}}


# ---------------------------------------------------------------------- replay snapshot of open agent runs
MAX_RUNS = int(os.environ.get("AGENTGLOW_SNAPSHOT_RUNS", "1000"))  # open runs tracked (oldest forgotten beyond)
MAX_AGENTS = int(os.environ.get("AGENTGLOW_SNAPSHOT_AGENTS", "2000"))  # live agents tracked, all runs
MAX_AGENT_STATE = 32  # state-carrying events kept per agent
MAX_STEPS = 64  # step events kept per run
ENDED_KEPT = 2000  # recently ended run ids (their leftover buffered events are not replayed)


def _state_key(ev: dict) -> tuple | None:
    """Key of an agent's state-carrying event (the latest per key is what a fresh viewer needs), None = transient
    (pulses, comets, counters). Mirrors what frontend world.ts / prims.ts keep on an instance."""
    t = ev.get("type")
    if t in ("agent", "progress", "job", "lifecycle"):
        return (t,)
    if t in ("skill", "stage", "capacity", "gate", "metric"):
        return (t, ev.get("name"))
    if t == "session":
        return (t, "start" if ev.get("phase") == "start" else "last")
    if t == "deferred":
        return (t, ev.get("ref"))
    return None


def _closes(ev: dict) -> bool:
    """A state event that ends its state: nothing to show a fresh viewer, its key is dropped."""
    t = ev.get("type")
    return ((t == "skill" and ev.get("status") != "start") or (t == "deferred" and ev.get("phase") == "done")
            or (t == "stage" and ev.get("status") != "running") or (t == "gate" and ev.get("state") == "unlocked"))


@dataclass
class _Agent:
    run: str
    spawn: dict
    state: dict = field(default_factory=dict)  # _state_key -> latest event


@dataclass
class _Run:
    started: dict | None = None
    renamed: dict | None = None
    idle: dict | None = None  # latest `run idle` while it lasts
    final: dict | None = None
    steps: dict = field(default_factory=dict)  # step -> latest step event
    agents: set = field(default_factory=set)


class LiveState:
    """Compacted log of the open runs, kept from published events: per open run its `run started` (+ latest `renamed`,
    `final`, step states), per live agent its `spawn` + the latest of each state-carrying event still open (status,
    running skills / stages, session, job, gates, lifecycle, progress, metrics, open deferred callbacks). Dropped on
    `exit` / run completed / failed. Bounded (MAX_RUNS, MAX_AGENTS, per-agent / per-run caps). Hub.replay() sends
    the entries that already left the bounded buffer so a fresh viewer of an hours-long run still sees the run and
    its agents (docs/SPEC.md "Replay")."""

    def __init__(self) -> None:
        self.runs: dict[str, _Run] = {}
        self.agents: dict[str, _Agent] = {}
        self.ended: dict[str, None] = {}  # recently ended run ids (insertion ordered, bounded)
        # recent `exit` / run completed / failed events: a viewer resuming across a gap learns what ended meanwhile
        self.endings: deque[dict] = deque(maxlen=ENDED_KEPT)

    def note(self, ev: dict) -> None:
        t, rid = ev.get("type"), ev.get("run_id")
        if rid is None:
            return
        if t == "run":
            st = ev.get("status")
            if st == "started":
                self._drop_run(rid)  # a run id reused: start over
                self.ended.pop(rid, None)
                self._run(rid).started = ev
            elif st == "renamed":
                self._run(rid).renamed = ev
            elif st == "idle":
                self._run(rid).idle = ev
            elif st == "active":
                if rid in self.runs:
                    self.runs[rid].idle = None
            elif st in ("completed", "failed"):
                self._drop_run(rid)
                self.endings.append(ev)
                self.ended[rid] = None
                while len(self.ended) > ENDED_KEPT:
                    self.ended.pop(next(iter(self.ended)))
            return
        if rid in self.ended:
            return
        if t == "step":
            steps = self._run(rid).steps
            steps.pop(ev.get("step"), None)  # re-insert: newest last
            steps[ev.get("step")] = ev
            while len(steps) > MAX_STEPS:
                steps.pop(next(iter(steps)))
        elif t == "final":
            self._run(rid).final = ev
        elif t == "spawn":
            aid = ev.get("id")
            self._drop_agent(aid)  # a re-spawn resets the instance (world.ts), so does its state here
            self.agents[aid] = _Agent(rid, ev)
            self._run(rid).agents.add(aid)
            while len(self.agents) > MAX_AGENTS:
                self._drop_agent(next(iter(self.agents)))
        elif t == "exit":
            self._drop_agent(ev.get("id"))
            self.endings.append(ev)
        else:
            a = self.agents.get(ev.get("id"))
            k = _state_key(ev)
            if a is None or k is None:
                return
            a.state.pop(k, None)
            if not _closes(ev):
                a.state[k] = ev
                while len(a.state) > MAX_AGENT_STATE:
                    a.state.pop(next(iter(a.state)))

    def _run(self, rid: str) -> _Run:
        r = self.runs.get(rid)
        if r is None:
            r = self.runs[rid] = _Run()
            while len(self.runs) > MAX_RUNS:
                self._drop_run(next(iter(self.runs)))
        return r

    def _drop_run(self, rid: str) -> None:
        r = self.runs.pop(rid, None)
        for aid in r.agents if r else ():
            self.agents.pop(aid, None)

    def _drop_agent(self, aid: str | None) -> None:
        a = self.agents.pop(aid, None)
        if a and a.run in self.runs:
            self.runs[a.run].agents.discard(aid)

    def snapshot(self) -> list[dict]:
        """Every kept entry, in publish (seq) order: the run starts before its agents, a parent's spawn before its
        child's, a spawn before its state. Replaying them in that order rebuilds the current world."""
        evs = [e for r in self.runs.values() for e in (r.started, r.renamed, r.final, r.idle) if e]
        evs += [e for r in self.runs.values() for e in r.steps.values()]
        evs += [e for a in self.agents.values() for e in (a.spawn, *a.state.values())]
        return evs
