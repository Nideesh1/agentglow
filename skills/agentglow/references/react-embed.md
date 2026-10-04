# `<AgentScene/>` in a React / Next.js app

```bash
npm i agentglow            # React 19; three.js and react-three-fiber come as regular dependencies
```
```tsx
import { AgentScene } from "agentglow";      // also imports the CSS ("agentglow/style.css" if your bundler drops it)

<div style={{ height: 600 }}>                 {/* the scene fills its container: give it a height */}
  <AgentScene theme="neural" source="http://localhost:8100" />
</div>
```

| Prop | Default | |
|---|---|---|
| `theme` | `"neural"` | `neural`, `constellation`, `orbit`, `atom`, `flow`, `bubblechamber`, `fireworks` (each loads lazily as its own chunk) |
| `source` | `""` (same origin) | the `agentglow serve` URL; it reads `/live/stream`, `/live/graph`, `/live/health`. In production: a URL the users' browsers can reach |
| `hud` | `true` | overlay panels (stats, agent list, event log, Selected panel); `false` = just the 3D scene |
| `sim` | `false` | `true`: built-in simulated agents, no server; `"hf"`: high-frequency simulator (30 market agents, ~100 decisions/s). Also kicks in when `source` is unreachable (with a "simulated" badge) |
| `scope` | | only this user's / tenant's runs (`X-AgentGlow-Scope`; with a token, the token decides) |
| `run` | | only this run (`X-AgentGlow-Run`) |
| `token` | | viewer token from your backend (`agentglow.make_token`), sent as `Authorization: Bearer` |
| `clearable` | `true` | HUD "Clear view" button + Shift+C: hides everything on screen for this viewer only, then draws only new activity (runs still going re-appear on their next event); persisted per source / scope / run in localStorage; the "cleared · show all" chip undoes it. The server is untouched |
| `clearedAt` | | controlled clear: epoch ms = clear at that moment, `null` = show everything, unset = the viewer's choice |
| `style`, `className` | | for the container |

Also exported: `THEMES`, `THEME_INFO` (names + one-liners), `type Theme`, `type AgentSceneProps`, `type WorldEvent`.

| Theme | Picture |
|---|---|
| `neural` | a living brain: agents fire as neurons, messages pulse along synapses |
| `constellation` | a night sky: delegation draws constellation lines between agent stars |
| `orbit` | agents orbit a graph galaxy; runs are rings, MCP servers are satellites |
| `atom` | agents are electrons in shells, subagents jump orbits, LLM calls flash photons |
| `flow` | a murmuration: agents condense as eddies out of the current |
| `bubblechamber` | agents curl as particle tracks, spawns decay into a V |
| `fireworks` | agents burst as star shells in a starry sky, subagents as secondary bursts |

Examples:
```tsx
<AgentScene theme="constellation" sim hud={false} style={{ height: 400 }} />            // demo background, no server
<AgentScene source="https://agentglow.yourco.com" scope={user.id} token={token} />       // per-user view
```

Next.js App Router: the package is `"use client"`, so it imports straight into a page. To skip SSR of the canvas:
```tsx
"use client";
import dynamic from "next/dynamic";
const AgentScene = dynamic(() => import("agentglow").then((m) => m.AgentScene), { ssr: false });
```

Notes:
- All scenes on a page share one world. Several scenes with the same `source` work side by side; different sources /
  scopes / tokens on one page are not supported (the most recently mounted wins).
- A cross-origin `source` needs CORS on the server (on by default, `Authorization` and `X-AgentGlow-*` allowed).
- If the server exposes a run webhook, the HUD shows a "Run agents" button (and a workflow picker).
- The standalone app (`agentglow serve`) is the same scene: `/` = gallery, `/<theme>` = full screen, with `?sim=1`,
  `?sim=hf`, `?hud=0`, `?source=<url>`, `?run=<id>`. Scope and token are never read from the URL.

Example app: `examples/react-embed/` (Vite + React, theme switcher, `npm run demo-spans -- http://localhost:8100`
replays a recorded deepagents run).
