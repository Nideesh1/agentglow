# AgentGlow: notes for agents working ON this repo

AgentGlow turns OpenTelemetry spans (plus Claude Code hooks and flat HTTP events) into live 3D scenes of agents and
backend services. Using AgentGlow in another project is a different job: see the skill in
[skills/agentglow/SKILL.md](skills/agentglow/SKILL.md). This file is for changing AgentGlow itself.

## Layout

| Path | What |
|---|---|
| `backend/agentglow/` | PyPI package `agentglow`: `server.py` (FastAPI app, endpoints), `state.py` (Hub: ingest, replay, scopes), `mapper.py` (spans -> world events), `backend.py` (backend services), `primitives.py` (generic primitives, producer + server side), `hv.py` (high-volume decisions), `claude_code.py` (hooks + Claude Code traces), `scrub.py` (privacy), `plumbing.py` (backend-mode export policy), `watch.py` (`watch()`, `pulse()`, `register_mcp()`), `manual.py` (manual API), `otel.py` (`LiveSpanProcessor`, OTLP decoding), `scope.py`, `auth.py`, `cli.py` (`agentglow serve`), `static/` (built UI, not committed) |
| `backend/tests/` | pytest; `fixtures/` real captured spans, `golden.py` + `test_backend_regression.py` pin agent-only output |
| `frontend/src/` | `AgentScene.tsx` (library entry), `index.ts` (exports), `themes.ts` (the 7 themes), `main.tsx` + `Gallery.tsx` (standalone app), `node.ts` (`agentglow/node`), `pulse.ts` (`agentglow/pulse`) |
| `frontend/src/scenes/<theme>/` | one folder per theme: `neural`, `constellation`, `orbit`, `atom`, `flow`, `bubblechamber`, `fireworks` |
| `frontend/src/scenes/shared/` | `world.ts` (WorldEvent type + the reducer `apply()`), `prims.ts`, `sse.ts`, `sim*.ts` (simulators), `Hud.tsx`, `PrimPanel.tsx`, `kit/` (shared scene kit: layout, fit, labels, overlays; `kit/PORTING.md`) |
| `frontend/cli/` | npm bin `agentglow` (Claude Code setup, server start via uv); `lib/` (settings merge, server, uv, autostart), `test/` (node:test) |
| `examples/` | `claude-code`, `quickstart`, `langgraph`, `openai-agents`, `custom-loop`, `deepagents-hatchet` (demo stack), `fastapi-faststream`, `node-proxy`, `react-embed` |
| `plugin/` | Claude Code plugin (hooks, ensure-server script, `/agentglow:open`, a copy of the skill); `.claude-plugin/marketplace.json` at the root lists it |
| `skills/agentglow/` | the user-facing skill: `SKILL.md` + `references/` |
| `docs/SPEC.md` | **source of truth** for the contracts: endpoints, span -> world event mapping, attributes, privacy, primitives |
| `docker-compose.yml`, `.env.example` | the demo stack (AgentGlow on host port 8101) |

One uv workspace at the root (`pyproject.toml`, single `uv.lock`): members `backend` and the Python examples.

## Build, test, run

```bash
uv sync --all-packages                                   # Python: everything into ./.venv
uv run --package agentglow pytest backend/tests -q       # backend tests (or: cd backend && uv run pytest -q)

cd frontend && npm ci
npx tsc --noEmit -p .                                    # typecheck
npm run build:app                                        # UI -> backend/agentglow/static (tsc + vite)
npm run build:lib                                        # library -> frontend/dist (index, node, pulse, types)
npm run build:demo                                       # static GitHub Pages demo (simulator only) -> frontend/demo-dist
npm test                                                 # CLI, plugin, skill-copy and node/pulse tests (node --test)
```
CI (`.github/workflows/ci.yml`) runs `npm test`, both builds, the backend tests and import checks of the examples.

Run locally:
```bash
(cd frontend && npm run build:app) && uv run agentglow serve        # http://localhost:8100 (gallery), /neural, ?sim=1
(cd frontend && npm run dev)                                        # Vite on :5173, proxies /live to :8100 (AGENTGLOW_URL)
node frontend/cli/agentglow.mjs status                              # the CLI from source
AGENTGLOW_PY_SPEC=$PWD/backend node frontend/cli/agentglow.mjs start   # CLI serving this checkout (editable)
```
Port 8100 may be taken by the user's own `npx agentglow setup` server: use `--port` for experiments.

Demo stack: `cp .env.example .env` (one LLM key), `docker compose up -d --build`, UI on http://localhost:8101,
Hatchet UI :8180, trigger :8300. No LLM key: `examples/fastapi-faststream` (Redis only).

## Conventions

- Python: uv only (`uv run`, `uv add`, `uv sync`), never bare `pip` / `python`.
- No em dashes anywhere (code, comments, docs, commit messages). Plain hyphens, colons or parentheses.
- Privacy: scrub once at the ingestion boundary (`scrub.py`, applied by the Hub for every path), not per adapter.
  Backend mode is strict by default (allow-list in `plumbing.py` / `scrub.strict_attrs`, `node.ts` for Node). New
  attributes are dropped in strict mode unless added to the allow-list on purpose; never let bodies, headers, URLs
  with ids, statements, prompts or exception messages through by default.
- Backend services must not change agent-only traces: `backend/tests/test_backend_regression.py` compares every
  fixture with the v0.3.0 goldens. Keep it identical; never re-record goldens to make a change pass.
- Themes are skins over the shared kit (`scenes/shared/kit`): cross-cutting behavior (layout, fit, labels,
  primitive overlays, decision glyphs) goes in the kit, not per theme. A new feature must render in all 7 themes.
- Tracing never breaks the host app: producers swallow errors, never block, drop when the server is down.
- Keep `docs/SPEC.md`, the READMEs and the skill in sync with behavior changes.
- Skill edits: change `skills/agentglow/`, then copy to `plugin/skills/agentglow/` (a test enforces identical files):
  `rm -rf plugin/skills/agentglow/references && cp skills/agentglow/SKILL.md plugin/skills/agentglow/ && cp -R skills/agentglow/references plugin/skills/agentglow/`.
- `plugin/hooks/hooks.json` must equal the CLI's generated hooks (`frontend/cli/lib/settings.mjs`); a test checks it.

## Adding a world event type

1. Server: emit it from the mapper side that recognizes it (`mapper.py` for agent spans, `backend.py` for services,
   `primitives.py` `Prims.handle` / `Prims.flat` for primitives, `claude_code.py` for hooks). For a primitive: add
   the producer call in `primitives.py`, export it from `agentglow/__init__.py`, accept its flat form
   (`Prims.FLAT`).
2. Contract: document the attributes, flat fields and event shape in `docs/SPEC.md`.
3. Frontend: add it to `WorldEvent` in `frontend/src/scenes/shared/world.ts` and handle it in `apply()` (primitive
   events: `prims.ts`, `PRIM_TYPES`).
4. Draw it once in the kit (`scenes/shared/kit/`, e.g. `Prims.tsx`), HUD / panel if needed, and feed it from the
   simulator (`sim.ts` / `simPrims.ts`) so `?sim=1` shows it.
5. Tests: backend (`backend/tests/test_*.py`); the regression goldens must stay unchanged.

## Release

1. Bump `plugin/.claude-plugin/plugin.json` `version` to the release version (the release workflow fails otherwise;
   the plugin is installed from git, not from the build). PyPI / npm versions come from the tag.
2. Merge the one release PR into `main`.
3. Tag `main`: `git tag vX.Y.Z && git push origin vX.Y.Z`. `.github/workflows/release.yml` builds the UI into the
   wheel, runs the tests, publishes PyPI and npm via OIDC trusted publishing (no secrets).
4. npm takes ~20-25 min before `npx agentglow@X.Y.Z` resolves; the CLI pins the same PyPI version and refreshes uv's
   index once if it is not found yet.

Do not tag, publish or merge release PRs unless the user asks.
