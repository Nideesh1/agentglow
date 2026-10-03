/**
 * Simulator part for the generic primitives (`?sim=1`): a small services run next to the agent runs. Services `api`
 * and `worker` (lifecycle warming -> ready), a voice session with turns + gauges, jobs with stages / progress / a retry
 * and a dead-letter now and then, a model pool + cache resource with stats, a named model group (ML label), a gate, a fallback, a deferred callback,
 * rejected requests, a metric and a backlog between the two services. Generic names only.
 */
import type { WorldEvent } from "./world";

export function runPrimSim(emit: (ev: WorldEvent | WorldEvent[]) => void): () => void {
  const run = "services";
  const ts = () => Date.now();
  const timers: number[] = [];
  const at = (ms: number, f: () => void) => timers.push(window.setTimeout(f, ms));
  const API = "svc:api", WORKER = "svc:worker";
  emit([
    { type: "run", run_id: run, status: "started", topic: "services", workflow: "services", ts: ts() },
    { type: "spawn", run_id: run, id: API, agent: "api", parent_id: null, subagent: false, ts: ts() },
    { type: "spawn", run_id: run, id: WORKER, agent: "worker", parent_id: null, subagent: false, ts: ts() },
    { type: "agent", run_id: run, id: API, status: "thinking", ts: ts() },
    { type: "agent", run_id: run, id: WORKER, status: "thinking", ts: ts() },
    { type: "lifecycle", run_id: run, id: WORKER, state: "warming", ts: ts() },
    { type: "lifecycle", run_id: run, id: API, state: "ready", ts: ts() },
    { type: "mcp_register", server: "backend", resources: [{ name: "asr-model", kind: "model" }, { name: "cache", kind: "cache" }], ts: ts() },
    // a named resource group of only models (`group=` / AGENTGLOW_RESOURCE_GROUP): labelled "ML · fraud scorer"
    { type: "mcp_register", server: "fraud scorer", kind: "model", resources: [{ name: "risk-model", kind: "model" }], ts: ts() },
    {
      type: "mcp_register",
      server: "backend",
      resources: [{ name: "postgresql", kind: "db" }, { name: "redis", kind: "cache" }, { name: "orders", kind: "queue" }, { name: "payments:9100", kind: "api" }],
      ts: ts(),
    },
  ]);
  // service backends (Resource details: operation mix, hit ratio, publish / consume, method + status mix)
  const call = (id: string, resource: string, kind: "db" | "cache" | "queue" | "api", tool: string, ms: number, extra: { status?: number; error?: boolean } = {}) => {
    emit({ type: "mcp", run_id: run, id, server: "backend", tool, phase: "call", resource, resource_kind: kind, ts: ts() });
    at(ms, () => emit({ type: "mcp", run_id: run, id, server: "backend", tool, phase: "result", latency_ms: ms, resource, resource_kind: kind, ts: ts(), ...extra }));
  };
  at(4000, () => emit({ type: "lifecycle", run_id: run, id: WORKER, state: "ready", ts: ts() }));

  // a voice session on the api: turns + gauges, ends after ~40 s
  let sid = 0;
  const session = () => {
    const id = `ses-${++sid}`;
    emit([
      { type: "spawn", run_id: run, id, agent: "support call", parent_id: API, subagent: true, ts: ts() },
      { type: "session", run_id: run, id, name: "support call", kind: "voice", phase: "start", ts: ts() },
      { type: "agent", run_id: run, id, status: "thinking", ts: ts() },
      { type: "gate", run_id: run, id, name: "identity", state: "locked", attempts_left: 3, ts: ts() },
    ]);
    let turns = 0;
    for (let k = 1; k <= 8; k++)
      at(k * 4500, () => {
        turns++;
        emit([
          { type: "session", run_id: run, id, name: "support call", kind: "voice", phase: "turn", role: turns % 2 ? "caller" : "agent", ts: ts() },
          { type: "session", run_id: run, id, name: "support call", kind: "voice", phase: "progress", gauges: { audio_s: k * 4.5, turns }, ts: ts() },
        ]);
        if (k === 3) emit({ type: "gate", run_id: run, id, name: "identity", state: "locked", attempts_left: 2, ts: ts() });
        if (k === 4) emit({ type: "gate", run_id: run, id, name: "identity", state: "unlocked", ts: ts() });
      });
    at(40_000, () => emit([{ type: "session", run_id: run, id, name: "support call", kind: "voice", phase: "end", outcome: "resolved", reason: "client_disconnect", ts: ts() }, { type: "exit", run_id: run, id, status: "done", ts: ts() }]));
  };
  session();
  const sesT = window.setInterval(session, 46_000);

  // jobs: queued on the api, run on the worker with stages + progress; every 3rd retries, every 7th dead-letters
  let jn = 0;
  const job = () => {
    const n = ++jn;
    const jid = `j-${100 + n}`;
    const id = `job:${jid}`;
    const st = (state: "queued" | "running" | "retrying" | "done" | "failed" | "dead", attempt: number, where: string): WorldEvent => ({ type: "job", run_id: run, id, job_id: jid, kind: "export", state, attempt, at: where, ts: ts() });
    emit([{ type: "spawn", run_id: run, id, agent: `export ${jid}`, parent_id: API, subagent: true, ts: ts() }, st("queued", 1, "api")]);
    if (n % 4 === 2) emit({ type: "fallback", run_id: run, id: API, from: "inline", to: "queue", reason: "timeout", to_id: id, ts: ts() });
    const attempt = (a: number, t0: number) => {
      at(t0, () => emit([{ type: "message", run_id: run, from_id: WORKER, to_id: id, text: a > 1 ? `retry ${a}` : "running", ts: ts() }, st("running", a, "worker"), { type: "stage", run_id: run, id, name: "fetch", status: "running", ts: ts() }]));
      at(t0 + 1500, () => emit([{ type: "stage", run_id: run, id, name: "fetch", status: "done", ms: 1500, ts: ts() }, { type: "stage", run_id: run, id, name: "decode", status: "running", ts: ts() }, { type: "stage", run_id: run, id, name: "index", status: "running", ts: ts() }]));
      for (let k = 1; k <= 5; k++) at(t0 + 1500 + k * 700, () => emit({ type: "progress", run_id: run, id, frac: k / 6, i: k, n: 6, eta_ms: (6 - k) * 700, ts: ts() }));
      const fail = (n % 3 === 0 && a === 1) || (n % 7 === 0 && a < 3);
      at(t0 + 5500, () => {
        if (fail) emit([{ type: "stage", run_id: run, id, name: "decode", status: "failed", ts: ts() }, { type: "stage", run_id: run, id, name: "index", status: "done", ts: ts() }, st(a >= 2 && n % 7 === 0 ? "dead" : "retrying", a, "worker")]);
        else emit([{ type: "stage", run_id: run, id, name: "decode", status: "done", ms: 4000, ts: ts() }, { type: "stage", run_id: run, id, name: "index", status: "done", ms: 4000, ts: ts() }, { type: "progress", run_id: run, id, frac: 1, i: 6, n: 6, ts: ts() }, st("done", a, "worker")]);
      });
      if (fail && !(a >= 2 && n % 7 === 0)) attempt(a + 1, t0 + 7000);
      else at(t0 + 6500, () => emit({ type: "exit", run_id: run, id, status: fail ? "failed" : "done", ts: ts() }));
    };
    attempt(1, 1200);
  };
  job();
  const jobT = window.setInterval(job, 9000);

  // steady background: pool + cache stats, inference calls, backlog, metric, capacity, rejects, callbacks, events
  let k = 0;
  const bgT = window.setInterval(() => {
    k++;
    const busy = 1 + (k % 4);
    emit([
      { type: "mcp", run_id: run, id: WORKER, server: "backend", tool: "infer", phase: "call", resource: "asr-model", resource_kind: "model", ts: ts() },
      { type: "resource_stats", run_id: run, server: "backend", resource: "asr-model", kind: "model", window_ms: 1000, calls: 3, p50_ms: 210, size: 4, busy, waiting: busy === 4 ? 2 : 0, wait_p50_ms: 12 + k % 30, units: 9, unit: "audio_s", rtf: 0.18 + (k % 5) / 50, ts: ts() },
      { type: "backlog", run_id: run, id: API, topic: "jobs", depth: 5 + ((k * 7) % 40), pending: 2, lag_ms: 400 + (k % 9) * 150, from_id: API, to_id: WORKER, ts: ts() },
      { type: "metric", run_id: run, id: WORKER, name: "throughput", value: 1.5 + (k % 7) / 5, unit: "audio_min/min", ts: ts() },
      { type: "capacity", run_id: run, id: API, name: "slots", used: Math.min(8, 4 + (k % 6)), max: 8, ts: ts() },
    ]);
    at(220, () => emit({ type: "mcp", run_id: run, id: WORKER, server: "backend", tool: "infer", phase: "result", latency_ms: 220, resource: "asr-model", resource_kind: "model", units: 3, unit: "audio_s", ts: ts() }));
    if (k % 2 === 0) {
      emit([
        { type: "mcp", run_id: run, id: API, server: "backend", tool: "hit", phase: "call", resource: "cache", resource_kind: "cache", ts: ts() },
        { type: "resource_stats", run_id: run, server: "backend", resource: "cache", kind: "cache", window_ms: 2000, calls: 10, p50_ms: 1, hits: 8 + (k % 3), misses: 2, ts: ts() },
      ]);
      at(40, () => emit({ type: "mcp", run_id: run, id: API, server: "backend", tool: "hit", phase: "result", latency_ms: 1, resource: "cache", resource_kind: "cache", ts: ts() }));
    }
    if (k % 3 === 1) {
      emit({ type: "mcp", run_id: run, id: API, server: "fraud scorer", tool: "infer", phase: "call", resource: "risk-model", resource_kind: "model", ts: ts() });
      at(35, () => emit({ type: "mcp", run_id: run, id: API, server: "fraud scorer", tool: "infer", phase: "result", latency_ms: 35, resource: "risk-model", resource_kind: "model", units: 1, unit: "claims", ts: ts() }));
    }
    const r = (k * 37) % 100;
    call(API, "postgresql", "db", r < 60 ? "SELECT" : r < 85 ? "INSERT" : "UPDATE", r < 60 ? 4 + (k % 5) : 9 + (k % 13), r === 99 ? { error: true } : {});
    call(API, "redis", "cache", k % 3 ? "GET" : "SET", 1);
    if (k % 2) call(API, "orders", "queue", "publish", 2);
    else call(WORKER, "orders", "queue", "process", 3);
    if (k % 3 === 2) call(WORKER, "payments:9100", "api", "POST", 120 + (k % 7) * 20, k % 11 === 5 ? { status: 502, error: true } : { status: 200 });
    if (k % 6 === 0) emit([{ type: "rejected", run_id: run, id: API, reason: "at capacity", retry_after_ms: 2000, status: 503, ts: ts() }, { type: "request", run_id: run, id: API, service: "api", name: "POST /jobs", kind: "http", status: 503, error: false, rejected: true, ms: 2, ts: ts() }]);
    if (k % 8 === 1) {
      const ref = `ch_${1000 + k}`;
      emit({ type: "deferred", run_id: run, id: API, ref, phase: "open", label: "payment", ts: ts() });
      at(3200, () => emit({ type: "deferred", run_id: run, id: API, ref, phase: "done", label: "payment", status: "ok", from_id: WORKER, wait_ms: 3200, ts: ts() }));
    }
    if (k % 5 === 3) emit({ type: "event", run_id: run, id: API, kind: "signup", label: "plan pro", fields: { seats: 3 }, ts: ts() });
  }, 1000);

  return () => {
    timers.forEach(clearTimeout);
    clearInterval(sesT);
    clearInterval(jobT);
    clearInterval(bgT);
  };
}
