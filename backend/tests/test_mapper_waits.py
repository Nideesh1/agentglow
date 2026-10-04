"""Long-running Hatchet runs: declared / durable waits hold the run open, a hard bound closes it, idle grace still works."""
import json

from agentglow.mapper import HATCHET_GRACE_MS, PARK_SHOW_MS, RUN_MAX_IDLE_MS, Mapper

MIN = 60_000
T0 = 1_790_000_000_000  # epoch ms


def span(sid, name, parent=None, attrs=None, start=1000, end=None, trace="t1", status="unset"):
    return {"trace_id": trace, "span_id": sid, "parent_span_id": parent, "name": name, "start_time_ms": T0 + start,
            "end_time_ms": end and T0 + end, "status": status, "attributes": attrs or {}}


def step(step_name, srid, run="vc-1"):
    return {"hatchet.workflow_run_id": run, "hatchet.step_name": step_name, "hatchet.step_run_id": srid,
            "hatchet.workflow_name": "vendor_consolidation", "hatchet.payload": json.dumps({"input": {"topic": "Q3 vendors"}})}


def tick(m, t):
    return m.tick(T0 + t)


def runs(evs, status=None):
    return [e for e in evs if e["type"] == "run" and (status is None or e["status"] == status)]


def steps(evs, name=None):
    return [e for e in evs if e["type"] == "step" and (name is None or e["step"] == name)]


def test_declared_wait_keeps_run_open_for_10_minutes_without_splitting():
    m = Mapper()
    evs = m.feed("start", span("s1", "hatchet.start_step_run", None, step("approval", "sr1"), 1000))
    evs += m.feed("start", span("ag", "approver", "s1", {"agentglow.agent": True}, 1010))
    until = T0 + 1100 + 10 * MIN
    evs += m.feed("start", span("w", "await approval", "ag", {"agentglow.wait": "approval", "agentglow.wait.until": until}, 1100))
    wait_ev = steps(evs, "approval")[-1]
    assert wait_ev["status"] == "waiting" and wait_ev["reason"] == "approval" and wait_ev["until"] == until
    agent_ev = [e for e in evs if e["type"] == "agent"][-1]
    assert agent_ev == {"type": "agent", "run_id": "vc-1", "id": "ag", "status": "waiting", "reason": "approval", "until": until, "ts": T0 + 1100}
    for t in range(1, 11):  # silent for 10 minutes: nothing closes
        assert tick(m, 1100 + t * MIN) == []
    t1 = 1100 + 10 * MIN
    evs = m.feed("end", span("w", "await approval", "ag", None, 1100, t1))
    assert steps(evs, "approval")[-1]["status"] == "running"
    assert any(e["type"] == "agent" and e["status"] == "thinking" for e in evs)
    evs += m.feed("end", span("ag", "approver", "s1", None, 1010, t1 + 5000))
    evs += m.feed("end", span("s1", "hatchet.start_step_run", None, step("approval", "sr1"), 1000, t1 + 5000))
    assert steps(evs, "approval")[-1]["status"] == "done"  # ended well after its wait: not parked
    evs += m.feed("start", span("s2", "hatchet.start_step_run", None, step("negotiate", "sr2"), t1 + 8000))
    assert runs(evs) == [] and steps(evs, "negotiate")[0]["status"] == "running"  # same run, no split
    evs += m.feed("end", span("s2", "hatchet.start_step_run", None, step("negotiate", "sr2"), t1 + 8000, t1 + 9000))
    done = tick(m, t1 + 9000 + HATCHET_GRACE_MS)
    assert [e["status"] for e in runs(done)] == ["completed"] and done[-1]["run_id"] == "vc-1"


def test_hatchet_durable_sleep_and_event_waits_from_instrumentor_spans():
    m = Mapper()
    evs = m.feed("start", span("s1", "hatchet.start_step_run", None, step("negotiate", "sr9"), 1000, trace="tr"))
    evs += m.feed("start", span("ag", "negotiator", "s1", {"agentglow.agent": True}, 1001, trace="tr"))
    # HatchetInstrumentor's wait span: parented to the trigger's traceparent, only hatchet.step_run_id to go on
    w = {"instrumentor": "hatchet", "hatchet.signal_key": "sleep:2h-0", "hatchet.num_conditions": 1, "hatchet.step_run_id": "sr9"}
    evs = m.feed("start", span("hw", "hatchet.durable.wait_for", "trigger-span", w, 2000, trace="tr"))
    assert runs(evs) == []  # no phantom run for the wait span
    ev = steps(evs, "negotiate")[-1]
    assert ev["status"] == "waiting" and ev["reason"] == "sleep" and ev["until"] == T0 + 2000 + 2 * 3_600_000
    assert any(e["type"] == "agent" and e["id"] == "ag" and e["status"] == "waiting" and e["reason"] == "sleep" for e in evs)
    assert tick(m, 2000 + 90 * MIN) == []
    evs = m.feed("end", span("hw", "hatchet.durable.wait_for", "trigger-span", w, 2000, 2000 + 2 * 3_600_000, trace="tr"))
    assert steps(evs, "negotiate")[-1]["status"] == "running"
    e = {**w, "hatchet.signal_key": "event:vendor:reply-1"}
    evs = m.feed("start", span("hw2", "hatchet.durable.wait_for", "trigger-span", e, 3 * 3_600_000, trace="tr"))
    assert steps(evs, "negotiate")[-1]["reason"] == "vendor:reply" and "until" not in steps(evs, "negotiate")[-1]


def test_evicted_wait_parks_the_step_and_resume_joins_the_same_run():
    m = Mapper()
    m.feed("start", span("s1", "hatchet.start_step_run", None, step("approval", "sr1"), 1000))
    m.feed("start", span("w", "await approval", "s1", {"agentglow.wait": "approval"}, 1100))
    # Hatchet evicts the durable task after its TTL: wait and step end together (CancelledError -> status unset)
    t = 1100 + 15 * MIN
    evs = m.feed("end", span("w", "await approval", "s1", None, 1100, t))
    evs += m.feed("end", span("s1", "hatchet.start_step_run", None, step("approval", "sr1"), 1000, t))
    assert steps(evs, "approval")[-1]["status"] == "running"  # not shown as waiting yet: a satisfied wait moves on at once
    shown = tick(m, t + PARK_SHOW_MS)
    assert steps(shown, "approval")[-1]["status"] == "waiting" and steps(shown, "approval")[-1]["reason"] == "approval"
    assert tick(m, t + 3 * HATCHET_GRACE_MS) == [] and tick(m, t + 5 * 3_600_000) == []  # held: still waiting on a human
    t2 = t + 6 * 3_600_000  # approved: Hatchet re-runs the task (same step run id)
    evs = m.feed("start", span("s1b", "hatchet.start_step_run", None, step("approval", "sr1"), t2))
    assert runs(evs) == [] and steps(evs, "approval")[-1]["status"] == "running"


def test_hard_upper_bound_never_closes_a_run_waiting_but_closes_one_past_its_deadline():
    m = Mapper()
    m.feed("start", span("s1", "hatchet.start_step_run", None, step("approval", "sr1"), 1000))
    m.feed("start", span("w", "await approval", "s1", {"agentglow.wait": "approval"}, 1100))
    assert tick(m, 1100 + 3 * RUN_MAX_IDLE_MS) == [] and "vc-1" in m.runs  # a human approval may take a weekend
    m = Mapper()
    m.feed("start", span("s1", "hatchet.start_step_run", None, step("approval", "sr1"), 1000))
    m.feed("start", span("w", "await approval", "s1", {"agentglow.wait": "approval", "agentglow.wait.until": T0 + 2000}, 1100))
    assert tick(m, 2000 + RUN_MAX_IDLE_MS - 1) == []  # silence counts from the passed deadline
    done = tick(m, 2000 + RUN_MAX_IDLE_MS)
    assert [e["status"] for e in runs(done)] == ["completed"] and "vc-1" not in m.runs


def test_idle_grace_still_closes_when_nothing_is_open():
    m = Mapper()
    m.feed("start", span("s1", "hatchet.start_step_run", None, step("report", "sr1"), 1000))
    m.feed("end", span("s1", "hatchet.start_step_run", None, step("report", "sr1"), 1000, 2000))
    assert tick(m, 2000 + HATCHET_GRACE_MS - 1) == []
    assert [e["status"] for e in runs(tick(m, 2000 + HATCHET_GRACE_MS))] == ["completed"]


def test_fan_out_children_fold_into_parent_run_and_step_stays_running():
    m = Mapper()
    evs = m.feed("start", span("p", "hatchet.start_step_run", None, step("analyze", "srp"), 1000))
    evs += m.feed("start", span("pa", "coordinator", "p", {"agentglow.agent": True}, 1001))
    child = lambda i: {**step("analyze_category", f"src{i}", run=f"child-{i}"), "hatchet.parent_workflow_run_id": "vc-1"}
    t = 2000

    def start(i):
        return (m.feed("start", span(f"c{i}", "hatchet.start_step_run", None, child(i), t, trace=f"c{i}"))
                + m.feed("start", span(f"a{i}", f"analyst_{i}", f"c{i}", {"agentglow.agent": True}, t + 1, trace=f"c{i}")))

    def end(i):
        return (m.feed("end", span(f"a{i}", f"analyst_{i}", f"c{i}", None, 0, t, trace=f"c{i}"))
                + m.feed("end", span(f"c{i}", "hatchet.start_step_run", None, child(i), 0, t, trace=f"c{i}")))

    for i in range(3):  # 12 category child runs, 3 at a time (Hatchet concurrency); the rest start as slots free up
        evs += start(i)
    for i in range(3, 12):
        t += 500
        evs += end(i - 3) + start(i)
    assert len(runs(evs)) == 1  # one run, no per-child runs
    assert {e["run_id"] for e in evs} == {"vc-1"}
    subs = [e for e in evs if e["type"] == "spawn" and e["id"] != "pa"]
    assert len(subs) == 12 and all(e["parent_id"] == "pa" and e["subagent"] for e in subs)  # coordinator's subagents
    assert all(e["status"] == "running" for e in steps(evs, "analyze_category"))
    for i in range(9, 12):
        t += 500
        evs = end(i)
    assert steps(evs, "analyze_category")[-1]["status"] == "done"


def test_satisfied_wait_then_next_step_never_flashes_waiting():
    m = Mapper()
    m.feed("start", span("s1", "hatchet.start_step_run", None, step("approval", "sr1"), 1000))
    m.feed("start", span("w", "await approval", "s1", {"agentglow.wait": "approval"}, 1100))
    evs = m.feed("end", span("w", "await approval", "s1", None, 1100, 5000))  # approved
    evs += m.feed("end", span("s1", "hatchet.start_step_run", None, step("approval", "sr1"), 1000, 5050))
    evs += m.feed("start", span("s2", "hatchet.start_step_run", None, step("negotiate", "sr2"), 5150))
    evs += tick(m, 5150 + PARK_SHOW_MS)
    assert [e["status"] for e in steps(evs, "approval")][-2:] == ["running", "done"]
