/**
 * Multi-run simulator: emits the v2 world event contract for several CONCURRENT Hatchet runs of the
 * `research_brief` workflow. Each run: planner spawns (plan) → researcher spawns and FANS OUT 2–4 scout
 * subagents (research) that read FalkorDB → scouts exit → writer spawns, writes back to the graph (write).
 * New runs keep starting (≤ MAX_CONCURRENT alive) so agents are continuously born, working and dying.
 * Fast structured decisions (Jev / Laya / an LLM judge): a model-router choice on each spawn, tool guardrails (now
 * and then a deny), a quality score on the writer's draft.
 */
import { runPrimSim } from "./simPrims";
import { apply, setSimulated, type AgentType, type StepName, type WorldEvent } from "./world";

const MAX_CONCURRENT = 3;

const TOPICS = [
  "Why is churn rising for Acme Corp?",
  "Root cause of payment latency incidents",
  "Which region has the most incidents?",
  "Is Fraud Shield worth expanding to Globex?",
  "Summarize Q3 support escalations",
  "Which customers are at risk of downgrading?",
  "Why did checkout conversion drop last week?",
  "Compare onboarding time across regions",
];

const NODES = [
  ["Acme Corp", "Enterprise Plan", "Churn Q3"],
  ["Payments API", "Incident #4821", "p99 Latency"],
  ["EMEA", "Incident #4790", "On-call Team"],
  ["Fraud Shield", "Globex", "Chargeback Rate"],
  ["Support Escalations", "Ticket #9917", "Initech"],
  ["Umbrella Co", "Seat Downgrade", "Renewal 2026"],
  ["Checkout Funnel", "Conversion Rate", "Release 4.12"],
  ["APAC", "Onboarding Time", "Customer Success"],
];

/** Entities outside the drawn sample: they appear as dynamic graph nodes (graphDyn.ts) when touched. Some carry a
 * kind (colored by it), some none ("touched"); a few reuse sample words so they bud off a similar sample node. */
const NOVEL: [string, string | null][] = [["Vendor", "Vendor"], ["Contract", "Contract"], ["Invoice", null], ["Device", "Device"], ["Shipment", null], ["Incident", "Incident"], ["Customer", "Customer"]];
function novel(): [string, string | null] {
  const [w, kind] = NOVEL[Math.floor(Math.random() * NOVEL.length)];
  return [`${w} ${w === "Incident" ? "#" : ""}${5000 + Math.floor(Math.random() * 600)}`, kind];
}

/** Backends behind each MCP server (rendered as nodes wired to the server). */
const MCP_BACKENDS: Record<string, [string, "db" | "warehouse" | "spark" | "api" | "storage" | "queue"][]> = {
  analytics: [["Metrics API", "api"], ["Postgres", "db"]],
  warehouse: [["Snowflake", "warehouse"], ["Spark cluster", "spark"]],
  github: [["GitHub API", "api"]],
  "google-drive": [["Drive storage", "storage"]],
  slack: [["Slack API", "api"], ["Kafka events", "queue"]],
};

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

const MODELS = ["haiku", "sonnet", "opus", "gpt-4.1-mini"];
/** a decision provider + latency: mostly Jev (ms), sometimes Laya, rarely the slow LLM-judge fallback */
function provider(): [string, number] {
  const r = Math.random();
  return r < 0.65 ? ["jev", 4 + Math.round(Math.random() * 18)] : r < 0.88 ? ["laya", 9 + Math.round(Math.random() * 30)] : ["llm", 380 + Math.round(Math.random() * 700)];
}
/** a decision event body: router choice over the models (winner first, p's summing to ~1) */
function route(): Omit<Extract<WorldEvent, { type: "decision" }>, "run_id" | "id" | "ts"> {
  const [prov, ms] = provider();
  const order = [...MODELS].sort(() => Math.random() - 0.5);
  const top = 0.55 + Math.random() * 0.42;
  let rest = 1 - top;
  const options = order.map((name, k) => {
    if (k === 0) return { name, p: top };
    const p = k === order.length - 1 ? rest : rest * (0.45 + Math.random() * 0.3);
    rest -= p;
    return { name, p: Math.round(p * 1000) / 1000 };
  });
  return { type: "decision", kind: "choice", question: "route", result: options[0].name, p: Math.round(top * 1000) / 1000, options, provider: prov, purpose: "route", target: options[0].name, ms };
}
/** a guardrail yes/no on a tool call (deny = result "no" with high p) */
function guard(tool: string, deny: boolean): Omit<Extract<WorldEvent, { type: "decision" }>, "run_id" | "id" | "ts"> {
  const [prov, ms] = provider();
  const p = Math.round((0.86 + Math.random() * 0.13) * 1000) / 1000;
  return { type: "decision", kind: "noul", question: "tool allowed?", result: deny ? "no" : "yes", p, provider: prov, purpose: "guard", target: tool, ms };
}
const rid = () => Math.random().toString(36).slice(2, 7);

type Sched = (delay: number, ev: (now: number) => WorldEvent | WorldEvent[]) => void;

function scheduleRun(at: Sched) {
  const run = `run-${rid()}`;
  const topic = pick(TOPICS);
  const ts = () => Date.now();
  let t = 0;
  const later = (d: number, ev: (now: number) => WorldEvent | WorldEvent[]) => {
    t += d;
    at(t, ev);
  };
  const spawn = (id: string, agent: AgentType, parent: string | null) => later(250, () => ({ type: "spawn", run_id: run, id, agent, parent_id: parent, ts: ts() }));
  const think = (id: string) => later(150, () => ({ type: "agent", run_id: run, id, status: "thinking", ts: ts() }));
  const wait = (id: string, d = 120) => later(d, () => ({ type: "agent", run_id: run, id, status: "waiting", ts: ts() }));
  const llm = (id: string, d: number) => later(d, () => ({ type: "llm", run_id: run, id, tokens_in: 1200 + Math.round(Math.random() * 3000), tokens_out: 150 + Math.round(Math.random() * 700), latency_ms: 700 + Math.random() * 1800, ts: ts() }));
  const exit = (id: string, d = 250) => later(d, () => ({ type: "exit", run_id: run, id, status: "done", ts: ts() }));
  const msg = (from: string, to: string, text: string, d = 120) => later(d, () => ({ type: "message", run_id: run, from_id: from, to_id: to, text, ts: ts() }));
  // a skill: the Skill tool call + skill start, then (after `d` ms of other work) skill end
  const skillOn = (id: string, name: string, d = 120) =>
    later(d, () => [
      { type: "tool", run_id: run, id, tool: "Skill", args_preview: name, ts: ts() },
      { type: "skill", run_id: run, id, name, status: "start", ts: ts() },
    ]);
  const skillOff = (id: string, name: string, d = 120) => later(d, () => ({ type: "skill", run_id: run, id, name, status: "end", ts: ts() }));
  const decide = (id: string, body: () => Omit<Extract<WorldEvent, { type: "decision" }>, "run_id" | "id" | "ts">, d = 60) =>
    later(d, () => ({ ...body(), run_id: run, id, ts: ts() }));
  const step = (s: StepName, status: "running" | "done", d = 120) => later(d, () => ({ type: "step", run_id: run, step: s, status, ts: ts() }));

  later(0, () => ({ type: "run", run_id: run, status: "started", topic, workflow: "research_brief", ts: ts() }));

  // ---- plan
  step("plan", "running", 300);
  const planner = `${run}:planner`;
  spawn(planner, "planner", null);
  decide(planner, route);
  think(planner);
  llm(planner, 1500);
  llm(planner, 900);
  step("plan", "done", 300);
  const researcher = `${run}:researcher`;
  // ---- research (fan-out)
  step("research", "running", 200);
  spawn(researcher, "researcher", planner);
  msg(planner, researcher, `3 questions on "${topic}"`, 150);
  exit(planner, 200);
  decide(researcher, route);
  think(researcher);
  const resSkill = Math.random() < 0.6 ? pick(["deep-research", "search-first"]) : "";
  if (resSkill) skillOn(researcher, resSkill, 200);
  llm(researcher, 1200);
  if (resSkill) skillOff(researcher, resSkill, 400);
  const nScouts = 2 + Math.floor(Math.random() * 3);
  const scouts: string[] = [];
  for (let k = 0; k < nScouts; k++) {
    const type: AgentType = k % 2 === 0 ? "graph_scout" : "records_scout";
    const id = `${run}:${type}:${k}`;
    scouts.push(id);
    if (k === 0) decide(researcher, () => guard("task", false), 120);
    later(200, () => ({ type: "tool", run_id: run, id: researcher, tool: "task", args_preview: `${type}: angle ${k + 1} of "${topic}"`, ts: ts() }));
    spawn(id, type, researcher);
    msg(researcher, id, `Investigate angle ${k + 1}`, 80);
  }
  wait(researcher, 200);
  // scouts work in parallel: interleave their events
  const base = t;
  scouts.forEach((id, k) => {
    let s = base + 200 + k * 220;
    const put = (d: number, ev: (now: number) => WorldEvent | WorldEvent[]) => {
      s += d;
      at(s, ev);
    };
    const nodes = pick(NODES);
    const graphish = id.includes("graph_scout");
    put(0, () => ({ type: "agent", run_id: run, id, status: "thinking", ts: ts() }));
    put(60, () => ({ ...route(), run_id: run, id, ts: ts() }));
    const sk = Math.random() < 0.45 ? (graphish ? pick(["graph-query", "dataviz"]) : pick(["xlsx", "pdf"])) : "";
    if (sk) {
      put(250, () => ({ type: "tool", run_id: run, id, tool: "Skill", args_preview: sk, ts: ts() }));
      put(0, () => ({ type: "skill", run_id: run, id, name: sk, status: "start", ts: ts() }));
    }
    put(500 + Math.random() * 500, () => ({ type: "tool", run_id: run, id, tool: graphish ? "graph_neighbors" : "search_records", args_preview: `"${nodes[0]}"`, ts: ts() }));
    put(600, () => ({ type: "graph", run_id: run, id, op: "read", nodes, ts: ts() }));
    put(700 + Math.random() * 900, () => ({ type: "llm", run_id: run, id, tokens_in: 1500 + Math.round(Math.random() * 2000), tokens_out: 200 + Math.round(Math.random() * 400), latency_ms: 900 + Math.random() * 1200, ts: ts() }));
    // MCP tool call to an external server: request out, response back after latency
    const [server, tool] = graphish ? pick([["analytics", "query_metrics"], ["github", "search_code"]]) : pick([["warehouse", "run_sql"], ["analytics", "list_incidents"], ["google-drive", "read_doc"]]);
    const lat = 600 + Math.random() * 1400;
    const [resource, resource_kind] = pick(MCP_BACKENDS[server]);
    // guardrail on the MCP call; now and then a scout then tries something destructive on that server and is denied
    put(200, () => ({ ...guard(tool, false), run_id: run, id, ts: ts() }));
    put(400, () => ({ type: "mcp", run_id: run, id, server, tool, phase: "call", resource, resource_kind, ts: ts() }));
    put(lat, () => ({ type: "mcp", run_id: run, id, server, tool, phase: "result", latency_ms: lat, resource, resource_kind, ts: ts() }));
    if (Math.random() < 0.35) put(300, () => ({ ...guard(pick(["rollback_deploy", "delete_records", "drop_table"]), true), run_id: run, id, ts: ts() }));
    if (Math.random() < 0.7) put(500, () => ({ type: "graph", run_id: run, id, op: "read", nodes: pick(NODES), ts: ts() }));
    // big graphs: most touched entities are not in the drawn sample (they appear as dynamic nodes, then glow)
    if (Math.random() < 0.65)
      put(350, () => {
        const [a, ka] = novel();
        const [b, kb] = novel();
        return { type: "graph", run_id: run, id, op: Math.random() < 0.3 ? "write" : "read", nodes: [a, b, pick(NODES)[0]], kinds: [ka, kb, null], ts: ts() };
      });
    // a hit that names no node: a hashed area of the graph glows briefly
    if (Math.random() < 0.15) put(250, () => ({ type: "graph", run_id: run, id, op: "write", nodes: [], ts: ts() }));
    if (sk) put(300, () => ({ type: "skill", run_id: run, id, name: sk, status: "end", ts: ts() }));
    put(800 + Math.random() * 1200, () => ({ type: "message", run_id: run, from_id: id, to_id: researcher, text: `Found ${2 + Math.floor(Math.random() * 6)} linked records`, ts: ts() }));
    put(200, () => ({ type: "exit", run_id: run, id, status: "done", ts: ts() }));
    t = Math.max(t, s);
  });
  think(researcher);
  llm(researcher, 1300);
  step("research", "done", 300);
  // ---- write
  // is the merged finding grounded in the evidence? (a yes/no check; sometimes unsure, rarely no)
  decide(researcher, () => {
    const [prov, ms] = provider();
    const p = Math.round((0.45 + Math.random() * 0.5) * 1000) / 1000;
    return { type: "decision", kind: "noul", question: "grounded?", result: Math.random() < 0.15 ? "no" : "yes", p, provider: prov, purpose: "check", ms };
  }, 200);
  const writer = `${run}:writer`;
  step("write", "running", 200);
  spawn(writer, "writer", researcher);
  msg(researcher, writer, "Findings merged - draft the brief", 120);
  exit(researcher, 200);
  decide(writer, route);
  think(writer);
  // the writer loads 2-3 skills at once (overlapping), e.g. a document format + dataviz + a style skill
  const wSkills = [pick(["pptx", "docx", "pdf"]), "dataviz", "haiku"].slice(0, 2 + Math.floor(Math.random() * 2));
  wSkills.forEach((sk, k) => skillOn(writer, sk, k ? 500 : 150));
  llm(writer, 1800);
  // quality check on the draft: a 1..5 score, then "ready to send?"
  decide(
    writer,
    () => {
      const [prov, ms] = provider();
      const lvl = pick(["3", "4", "4", "5"]);
      const p = Math.round((0.5 + Math.random() * 0.4) * 1000) / 1000;
      const options = ["5", "4", "3", "2", "1"].map((name) => ({ name, p: name === lvl ? p : Math.round(((1 - p) / 4) * 1000) / 1000 })).sort((a, b) => b.p - a.p);
      return { type: "decision", kind: "score", question: "draft quality", result: lvl, p, options, provider: prov, purpose: "check", ms };
    },
    200,
  );
  decide(writer, () => ({ type: "decision", kind: "noul", question: "ready to send?", result: "yes", p: 0.93, provider: "jev", purpose: "check", ms: 7 }), 120);
  decide(writer, () => guard("post_message", false), 120);
  later(400, () => ({ type: "graph", run_id: run, id: writer, op: "write", nodes: [`Brief: ${topic}`, ...pick(NODES).slice(0, 2)], ts: ts() }));
  later(300, () => ({ type: "mcp", run_id: run, id: writer, server: "slack", tool: "post_message", phase: "call", resource: "Slack API", resource_kind: "api", ts: ts() }));
  later(700, () => ({ type: "mcp", run_id: run, id: writer, server: "slack", tool: "post_message", phase: "result", latency_ms: 700, resource: "Slack API", resource_kind: "api", ts: ts() }));
  wSkills.forEach((sk, k) => skillOff(writer, sk, k ? 900 : 300));
  step("write", "done", 400);
  later(150, () => ({ type: "final", run_id: run, text: `Brief on "${topic}": linked accounts, incidents and metrics summarized with sources.`, ts: ts() }));
  exit(writer, 100);
  later(200, () => ({ type: "run", run_id: run, status: "completed", topic, workflow: "research_brief", ts: ts() }));
  return t;
}

/** Start the endless simulator. Returns a stop fn. */
export function runWorldSimulator(): () => void {
  setSimulated(true);
  let stopped = false;
  const timers: number[] = [];
  let alive = 0;
  const startOne = () => {
    if (stopped) return;
    alive++;
    const sched: Sched = (delay, make) => {
      timers.push(
        window.setTimeout(() => {
          if (stopped) return;
          const out = make(performance.now());
          (Array.isArray(out) ? out : [out]).forEach(apply);
        }, delay),
      );
    };
    const dur = scheduleRun(sched);
    timers.push(window.setTimeout(() => (alive--, refill()), dur + 300));
  };
  const refill = () => {
    if (stopped) return;
    while (alive < MAX_CONCURRENT) {
      const delay = 1500 + Math.random() * 3500;
      alive++; // reserve
      timers.push(window.setTimeout(() => (alive--, startOne()), delay));
    }
  };
  startOne();
  timers.push(window.setTimeout(refill, 2500));
  // generic primitives (sessions, jobs, pools, backlog, ...) on a small services run
  const stopPrims = runPrimSim((ev) => !stopped && (Array.isArray(ev) ? ev : [ev]).forEach(apply));
  return () => {
    stopPrims();
    stopped = true;
    timers.forEach(clearTimeout);
    setSimulated(false);
  };
}
