# Troubleshooting

Start with:
```bash
npx agentglow status                                 # Claude Code setup: CLI + server version, port, hooks, login item
curl -s http://localhost:8100/live/health            # any setup: {"ok": true, "version": ..., "ingest_auth": ...}
```

| Symptom | Cause | Fix |
|---|---|---|
| nothing appears (Claude Code) | Claude Code not restarted after setup / plugin install (hooks load at session start) | restart Claude Code once |
| nothing appears (any) | the page was opened after the run ended (a new viewer only replays runs still in progress) | open `/neural` first, then run; `?sim=1` checks the UI alone |
| nothing appears (Python) | `watch()` not called in that process, called after the agents were built, or pointing elsewhere | call `agentglow.watch()` at process start; check `AGENTGLOW_URL`; in docker use the service name (`http://agentglow:8100`), not localhost |
| `server: ... (server 0.3.x)` while the CLI is newer | an older server still holds the port | `npx agentglow@latest setup` restarts it with the CLI's version; else `npx agentglow stop` then `npx agentglow start --background` |
| first start fails with "agentglow==X not found" right after a release | uv's cached PyPI index predates the release | the CLI retries once with the index refreshed (`--refresh-package agentglow`), then falls back to the latest version; npm itself takes ~20-25 min after a tag before `npx agentglow@X` resolves |
| `port 8100 is in use by something that is not AgentGlow` | another program on the port | `npx agentglow setup --port 8200` (status / open / stop then reuse it); demo stack: AgentGlow is on 8101 |
| server not running | first start still downloading Python (30-60 s), or it crashed | `npx agentglow start` in a terminal (foreground, shows logs); logs: `~/Library/Logs/agentglow.log` (macOS login item), `journalctl --user -u agentglow` (Linux), `<cache dir>/server-<port>.log` |
| LLM pulses show `0→0 tok` (Claude Code) | no traces env: the plugin cannot set env vars, or env put in a project `.claude/settings.json` | `npx agentglow@latest setup` (adds only the env next to the plugin); with an ingest key also export `OTEL_EXPORTER_OTLP_HEADERS="x-api-key=$AGENTGLOW_API_KEY"` |
| every Claude Code event shows twice | setup's hooks AND the plugin | `npx agentglow remove` (keep the plugin) or disable the plugin |
| a Claude Code ball stays after its terminal was closed | a killed session sends no SessionEnd | it dims (`idle · 4m`) after 3 min (`AGENTGLOW_IDLE_DIM_MIN`) and closes as abandoned after 10 min (`AGENTGLOW_SESSION_IDLE_MIN`, server env); `×` in the Selected panel hides it at once for you; it comes back as a new ball on its next hook |
| a killed run (kill -9, cancelled Hatchet task, worker restart) stays as `idle · 47m` | its spans never end | it closes as abandoned after 30 min without events (`AGENTGLOW_RUN_IDLE_MIN`, server env or `agentglow serve --run-idle-min`, `0` = off) and fades out; never while it has an open wait / approval (`until` passed: counted from then) |
| a quiet run is dimmed `idle · Nm` | no events for `AGENTGLOW_IDLE_DIM_MIN` (default 3) and no declared wait | normal; it brightens on its next event. Declare long waits (`agentglow.wait` / `approval`) so they never show idle; `AGENTGLOW_IDLE_DIM_MIN=0` turns idle off |
| subagents missing after a server restart | the server did not see their SubagentStart | they are adopted on their next hook event (next tool call); runs already finished are not replayed |
| 401 on ingest | server has `AGENTGLOW_INGEST_KEY` | producers send `x-api-key`: `AGENTGLOW_API_KEY` env / `watch(api_key=)` / `OTEL_EXPORTER_OTLP_HEADERS` |
| 401 in the viewer ("not authorized for this scope") | server has a secret | pass `token` (minted with `agentglow.make_token`) to `<AgentScene/>` |
| a field I need is missing (backend mode) | strict privacy drops non-structural attributes | `watch(..., allow=["my.attr"])`, `allow_message_keys=[...]`, `error_messages=True`, or `privacy="standard"` (privacy.md) |
| agent text (final answer, tool args) missing for agents inside a FastAPI / worker process | strict mode drops agent text in backend mode | `privacy="standard"` for that process |
| health checks / polling flood the scene | probes or polls not in the default ignore list | `watch(app=app, ignore=["GET /status", "/internal/*"])` (defaults already cover `/health*`, `/ready*`, `/livez`, `/ping`, blocking Redis reads) |
| thread-pool work shows as separate roots | context lost across threads | backend mode propagates by default; agent-only mode: `watch(propagate=True)` |
| one request shows as two (mounted sub-app) | the sub-app was watched on its own | pass the outer app: `watch(app=outer)` (mounted apps are covered); `app=[a, b]` for separate apps |
| `--capture-prompts` has no effect | server not on loopback, or started before the flag | the CLI prints the fix: `npx agentglow stop && npx agentglow start --background`; a server on a non-loopback host ignores it |
| Node: "another OpenTelemetry tracer provider is already registered" | the app has its own OTel setup | use `spanProcessor()` from `agentglow/node` in that setup instead of `watch()` |
| Hatchet run ends while a step waits | the wait is not declared | wrap the wait in a span with `agentglow.wait` (python-agents.md) |
| `uvx agentglow serve` from a checkout serves an old UI | the bundled UI is built separately | `(cd frontend && npm ci && npm run build:app)` |
