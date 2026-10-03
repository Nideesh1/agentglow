// Dynamic knowledge-graph nodes (src/scenes/shared/graphDyn.ts, plain TS: Node strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DYN_MAX, areaNames, graphView, mergeGalaxy, placeDynamic, resetGraphDyn, restoreGraph, setGraphSample, touchGraph } from "../../src/scenes/shared/graphDyn.ts";

const sample = {
  nodes: [
    { id: "s1", name: "Acme Corp", kind: "Customer" },
    { id: "s2", name: "Incident #4821", kind: "Incident" },
    { id: "s3", name: "EMEA", kind: "Region" },
  ],
  links: [{ source: "s1", target: "s3" }],
};

test("names outside the sample become dynamic nodes linked to co-touched peers and a similar sample node", () => {
  resetGraphDyn();
  setGraphSample(sample);
  assert.equal(touchGraph(["Acme Corp"]), false); // sampled: nothing to add
  assert.equal(touchGraph(["Incident #5001", "Vendor 7", "Acme Corp"], [null, "Vendor"]), true);
  const g = mergeGalaxy(sample);
  const inc = g.nodes.find((n) => n.name === "Incident #5001");
  const ven = g.nodes.find((n) => n.name === "Vendor 7");
  assert.deepEqual([inc.dyn, inc.kind, inc.anchor], [true, "touched", "s2"]);
  assert.deepEqual([ven.kind, ven.anchor], ["Vendor", undefined]);
  const has = (a, b) => g.links.some((l) => l.source === a && l.target === b);
  assert.ok(has(inc.id, ven.id) && has(inc.id, "s1") && has(inc.id, "s2"));
  assert.equal(g.nodes.length, 5);
});

test("LRU cap evicts the least recently touched dynamic nodes, never sampled ones", () => {
  resetGraphDyn();
  setGraphSample(sample);
  for (let i = 0; i < DYN_MAX; i++) touchGraph([`x${i}`]);
  touchGraph(["x0"]); // refresh: x1 is now the oldest
  touchGraph(["new one"]);
  const names = new Set(mergeGalaxy(sample).nodes.map((n) => n.name));
  assert.ok(names.has("x0") && names.has("new one") && !names.has("x1") && names.has("Acme Corp"));
  assert.equal(mergeGalaxy(sample).nodes.length, sample.nodes.length + DYN_MAX);
});

test("restore (replay) rebuilds dynamic nodes; a sample arriving later absorbs names it contains", () => {
  resetGraphDyn();
  restoreGraph([{ name: "EMEA" }, { name: "Vendor 9", kind: "Vendor", peers: ["EMEA"] }]);
  setGraphSample(sample);
  const g = mergeGalaxy(sample);
  assert.deepEqual(g.nodes.filter((n) => n.dyn).map((n) => n.name), ["Vendor 9"]);
});

test("view keeps dynamic nodes past the sample cap and places them deterministically", () => {
  resetGraphDyn();
  setGraphSample(sample);
  touchGraph(["Vendor 7"]);
  const v = graphView(mergeGalaxy(sample), 2);
  assert.equal(v.ns, 2);
  assert.deepEqual(v.nodes.map((n) => n.name), ["Acme Corp", "Incident #4821", "Vendor 7"]);
  const p1 = new Float32Array([0, 0, 0, 5, 5, 5, 0, 0, 0]);
  const p2 = new Float32Array([0, 0, 0, 5, 5, 5, 9, 9, 9]);
  placeDynamic(v, p1, 1);
  placeDynamic(v, p2, 1);
  assert.deepEqual([...p1.slice(6)], [...p2.slice(6)]);
});

test("an event naming no node lights a hashed area (stable for the same seed)", () => {
  resetGraphDyn();
  assert.deepEqual(areaNames("x"), []);
  setGraphSample(sample);
  const a = areaNames("agent:1", 3);
  assert.equal(a.length, 3);
  assert.deepEqual(areaNames("agent:1", 3), a);
});
