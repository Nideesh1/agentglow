"""Abandoned runs (AGENTGLOW_RUN_IDLE_MIN): an open run silent that long and not waiting is closed like a finished
run (docs/SPEC.md "Idle runs")."""
from agentglow.state import Hub

MIN = 60_000
DAY = 24 * 60 * MIN
T0 = 1_790_000_000_000


class Clock:
    def __init__(self) -> None:
        self.t = T0

    def __call__(self) -> int:
        return self.t


def hub(run_idle_ms=30 * MIN) -> tuple[Hub, Clock]:
    h, c = Hub(idle_ms=0, run_idle_ms=run_idle_ms), Clock()
    h.clock = c
    return h, c


def span(sid, name, parent=None, attrs=None, start=0, end=None, run="r1"):
    a = {"agentglow.run.id": run, **(attrs or {})}
    return {"trace_id": "t-" + run, "span_id": sid, "parent_span_id": parent, "name": name, "start_time_ms": T0 + start,
            "end_time_ms": end and T0 + end, "status": "unset", "attributes": a}


def live(h, kind, sp):
    h.ingest_live([{"kind": kind, "span": sp}])


def at(h, c, ms):
    c.t = T0 + ms
    h.tick(c.t)


def ended(h, rid="r1"):
    return [e for e in h.buffer if e["type"] == "run" and e["run_id"] == rid and e["status"] in ("completed", "failed")]


def agent_run(h, run="r1"):
    live(h, "start", span(f"{run}-a", "planner", None, {"agentglow.agent": "planner"}, run=run))
    live(h, "start", span(f"{run}-t", "search", f"{run}-a", {"openinference.span.kind": "TOOL", "tool.name": "search"}, 1000, run=run))


def test_silent_run_is_closed_as_abandoned_after_the_timeout():
    h, c = hub()
    agent_run(h)
    assert h.counts()["open_runs"] == 1
    at(h, c, 30 * MIN - 1)
    assert not ended(h)
    at(h, c, 30 * MIN + 1)  # next 60 s check
    assert not ended(h)
    at(h, c, 31 * MIN)
    (ev,) = ended(h)
    assert ev["status"] == "completed" and ev["reason"] == "abandoned"
    exits = [e for e in h.buffer if e["type"] == "exit"]
    assert [e["id"] for e in exits] == ["r1-a"] and exits[0]["status"] == "done"
    assert h.counts()["open_runs"] == 0 and "r1" not in h.mapper.runs
    assert not [e for e in h.replay() if e.get("run_id") == "r1"]  # gone from a fresh viewer's replay / snapshot
    # a late end of one of its spans is dropped; a new span of that run id opens it again as a new run
    live(h, "end", span("r1-t", "search", "r1-a", {"openinference.span.kind": "TOOL"}, 1000, 32 * MIN))
    assert "r1" not in h.mapper.runs
    live(h, "start", span("r1-b", "planner", None, {"agentglow.agent": "planner"}, 33 * MIN))
    assert [e["status"] for e in h.buffer if e["type"] == "run"][-1] == "started" and "r1" in h.mapper.runs


def test_run_waiting_on_an_open_approval_is_never_closed():
    h, c = hub()
    agent_run(h)
    live(h, "start", span("w", "approve refund", "r1-a", {"agentglow.wait": "approval", "agentglow.wait.kind": "approval"}, 2000))
    for d in range(1, 4):
        at(h, c, d * DAY)
    assert not ended(h) and h.counts()["open_runs"] == 1
    at(h, c, 3 * DAY + 1)
    assert any(e["type"] == "run" and e["status"] == "started" for e in h.replay())


def test_wait_with_a_future_until_holds_then_silence_counts_from_the_deadline():
    h, c = hub()
    agent_run(h)
    until = T0 + 2 * DAY
    live(h, "start", span("w", "vendor reply", "r1-a", {"agentglow.wait": "vendor reply", "agentglow.wait.until": until}, 2000))
    at(h, c, 2 * DAY - MIN)  # deadline still ahead: waiting
    assert not ended(h)
    at(h, c, 2 * DAY + 29 * MIN)  # deadline passed 29 min ago
    assert not ended(h)
    at(h, c, 2 * DAY + 31 * MIN)
    (ev,) = ended(h)
    assert ev["reason"] == "abandoned"


def test_a_new_event_resets_the_timer():
    h, c = hub()
    agent_run(h)
    at(h, c, 20 * MIN)
    c.t = T0 + 25 * MIN
    live(h, "start", span("l", "llm", "r1-a", {"openinference.span.kind": "LLM"}, 25 * MIN))
    at(h, c, 50 * MIN)
    assert not ended(h)
    at(h, c, 56 * MIN)
    assert ended(h)


def test_other_runs_and_services_are_left_alone_and_zero_turns_it_off():
    h, c = hub()
    agent_run(h, "r1")
    at(h, c, 20 * MIN)
    c.t = T0 + 20 * MIN
    agent_run(h, "r2")
    at(h, c, 31 * MIN)
    assert ended(h, "r1") and not ended(h, "r2")
    h0, c0 = hub(run_idle_ms=0)
    agent_run(h0)
    at(h0, c0, 23 * 60 * MIN)  # (the 24 h AGENTGLOW_RUN_MAX_IDLE_MS bound still applies)
    assert not ended(h0)


def test_timeout_from_create_app_and_env(monkeypatch):
    from agentglow.server import create_app

    assert create_app(run_idle_min=1.5).state.hub.run_idle_ms == 90_000
    monkeypatch.setenv("AGENTGLOW_RUN_IDLE_MIN", "2")
    assert create_app().state.hub.run_idle_ms == 2 * MIN
    monkeypatch.delenv("AGENTGLOW_RUN_IDLE_MIN")
    assert Hub().run_idle_ms == 30 * MIN
