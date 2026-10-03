"""Dynamic graph nodes: `graph` events may carry node kinds; the hub remembers touched names (LRU) and replays them
to a fresh viewer as one `graph_nodes` event (scope-filtered, never on a resume) so it rebuilds its dynamic nodes."""
from agentglow.state import Filter, GraphTouched, Hub

from test_mapper import by_type, span
from agentglow.mapper import Mapper


def graph_events(attrs):
    m = Mapper()
    evs = m.feed("start", span("a", "invoke_agent helper", attrs={"gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "helper"}))
    evs += m.feed("end", span("q", "q", "a", {"db.system": "falkordb", "agentglow.db.op": "read", **attrs}, 1200, 1300))
    return by_type(evs, "graph")


def test_kinds_from_objects_and_parallel_attr():
    g = graph_events({"agentglow.graph.nodes": '[{"name": "Vendor 7", "kind": "Vendor"}, "Acme"]'})[0]
    assert g["nodes"] == ["Vendor 7", "Acme"] and g["kinds"] == ["Vendor", None]
    g = graph_events({"agentglow.graph.nodes": ["A", "B"], "agentglow.graph.kinds": ["", "Ticket"]})[0]
    assert g["nodes"] == ["A", "B"] and g["kinds"] == [None, "Ticket"]


def test_no_kinds_key_without_kinds():
    g = graph_events({"agentglow.graph.nodes": ["A"]})[0]
    assert "kinds" not in g


def gev(rid, nodes, kinds=None):
    e = {"type": "graph", "run_id": rid, "id": "a", "op": "read", "nodes": nodes, "ts": 0}
    if kinds:
        e["kinds"] = kinds
    return e


def test_replay_has_touched_nodes_even_after_run_ended():
    hub = Hub()
    hub.publish([{"type": "run", "run_id": "r1", "status": "started", "topic": "t", "ts": 0}])
    hub.publish([gev("r1", ["Vendor 7", "Acme"], ["Vendor", None])])
    hub.publish([{"type": "run", "run_id": "r1", "status": "completed", "ts": 1}])
    rep = hub.replay()
    gn = [e for e in rep if e["type"] == "graph_nodes"]
    assert len(gn) == 1
    assert gn[0]["nodes"] == [{"name": "Vendor 7", "kind": "Vendor", "peers": ["Acme"]}, {"name": "Acme", "peers": ["Vendor 7"]}]
    assert not [e for e in rep if e["type"] == "graph"]  # the ended run's events are not replayed
    assert not [e for e in hub.replay(after=1) if e["type"] == "graph_nodes"]  # a resume already has them


def test_replay_touched_nodes_scope_filtered():
    hub = Hub()
    hub.mapper.scopes["r1"] = "team-a"
    hub.publish([gev("r1", ["Secret A"]), gev("r2", ["Other"])])
    a = [e for e in hub.replay(Filter(scope="team-a")) if e["type"] == "graph_nodes"][0]
    assert [n["name"] for n in a["nodes"]] == ["Secret A"]
    assert [n["name"] for n in [e for e in hub.replay() if e["type"] == "graph_nodes"][0]["nodes"]] == ["Secret A", "Other"]
    assert not [e for e in hub.replay(Filter(scope="nobody")) if e["type"] == "graph_nodes"]


def test_lru_cap_keeps_most_recent():
    g = GraphTouched(cap=3)
    for n in ["a", "b", "c"]:
        g.note(gev("r", [n]))
    g.note(gev("r", ["a"]))  # touch: a becomes newest
    g.note(gev("r", ["d"]))  # evicts b (least recently touched)
    assert [e["name"] for e in g.nodes.values()] == ["c", "a", "d"]
