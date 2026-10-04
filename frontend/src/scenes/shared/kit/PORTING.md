# Porting a theme to the scene kit

The kit (`frontend/src/scenes/shared/kit/`) owns WHERE things are and HOW BIG they are. A ported theme only
draws. Read `index.ts` (overview), then use the reference ports as templates:

| reference | preset | plane | look at |
|---|---|---|---|
| `neural/`  | `radial` | `xy` | per-agent slot with its own edge (synapse), side graph with beams drawn in graph-local space, MCP + backend slots |
| `orbit/`   | `radial` | `xz` | rings per run as the RunMarker, the galaxy as the side GraphResource |
| `flow/`    | `drift`  | `xz` | agents moving around their home (`live`), backends wired with the kit `<ResourceWire>` |

If a preset is wrong for a theme, write a custom `LayoutPreset` (see `presets.ts`, ~20 lines) and pass the object
as `preset`; do not add per-theme placement code outside it.

## Recipe

1. **index.tsx -> `<KitScene>`.** Delete the theme's `<Canvas>`, `Ticker` (`tick()` / `lodTick()`),
   `<OrbitControls>`, `useSceneSetup()`, `selected` state, `<Hud>` and any stage-shift `<group position=[-2.2,..]>`
   (the kit centres in the free area with a view offset). Keep: background color, lights/stars/fog/floor
   (`Background`), `EffectComposer` (`PostFX`), title/subtitle, camera position + fov, polar limits (`controls`).
   Props to set: `preset`, `plane`, `fit` (start from `{ nRef: 4, min: 0.62, max: 1.6, minRadius: 5.5 }`; `maxNode`, default
   0.08, caps an agent's framed diameter as a fraction of the viewport height so a lone node never fills the screen),
   `agentRadius` (world radius of one agent at scale 1), `graph={{ natural, radius }}`, `peripheryGap`,
   `cluster` (the old `<ClusterBalls>` props) and `clusterOffset` (lift above a ground plane in `xz`).
2. **Agent slot** (`AgentSlotProps = { agent, selected, onSelect }`). Convert the per-agent component:
   - position = `agent.pos` (eased home). If the theme moves agents around their home (drift, shuttle, holding
     pattern), compute the drawn position and WRITE IT INTO `agent.live` every frame. Never keep a private
     position registry (`somaPos`, `trainPos`-only, `blips`-only): links read `agentLive(id)`.
   - size = `agent.scale` (= `roleScale(inst) * fit.scale`). If the theme had its own parent/sub ratio, use
     `fit.scale * themeRatio`. Tall agents on an `xz` ground (towers, trees) set `agentHeight` so their tops stay
     framed.
   - labels: `<Label3D fit .../>`, keep `showLabel(inst.id)` for opacity, keep pxRange; put label offsets that
     depend on size in a group you move in useFrame (`-0.8 * agent.scale`). Overlaps are handled by the kit
     (`labels.ts`): every Label3D is ranked by the slot it renders in and hidden / shortened when it collides;
     override the class with `declutter="run" | "mcp" | ...` or opt out with `declutter={false}`.
   - parent edge: parent position = `agentLive(inst.parent)`; subagents form a radial tree round their top-level agent (each child owns a wedge its whole subtree stays in, one concentric ring per depth), so draw the edge STRAIGHT from parent to child: straight edges never cross (no trunk along `agent.run.axis`, no bow).
   - delete the theme's list component (`Somas`, `Blips`, `Network`): the kit renders one slot per drawn agent,
     keyed by `agent.uid` (collapsed-then-expanded agents get a fresh object).
3. **RunMarker slot** (`{ run }`): auras, lines, sector arcs, run labels. Frame: `run.origin`, `run.axis` (fan
   direction), `run.side` (top-level line), half extents `run.hu` / `run.hv`, eased centroid `run.cu/cv`;
   `runLocal(run, u, v, out)` maps run-local coords to stage. Station/role positions: `kitRoleU("planner")` etc.
   Delete `Pathways`/`Runs` membership code (`isRunExpanded`, `lod.version` checks): the kit lists drawn runs.
4. **Clusters:** delete the theme's `Clusters.tsx` and its `place()`; pass `cluster={{ radius, variant, color }}`
   (+ `clusterOffset`); `color` may be `(lane) => string`. Only for a non-ClusterBall look use the `Cluster` slot.
   The kit spaces balls by their badge size.
5. **MCP:** by default the kit draws every MCP server as a faceted crystal with its backends as satellites on
   tilted orbits (`Crystal.tsx`); a theme tints it with `mcpStyle` (`tint` + `tintAmt`, `gain`, `halo`, `lift` above
   the stage (number or per server slot), `size`, `emit` for sparks) and gets the Resource details click targets
   (`Picks.tsx`) for free. Satellites are colored by resource kind (`SAT_KIND_COLOR`) with their label riding beside
   them. `satellitePos(server, res)` = the moving satellite (trails can end on it), `satelliteRadius` its size. A theme may still
   pass its own `McpServer` slot (`{ mcp }`) and `Backend` slot (`{ mcp, backend }`). Position from `mcp.pos` /
   `backend.pos` EVERY FRAME (they ease when the periphery re-lays out); `mcp.out` = outward direction.
   Delete `satPos`/`backendPos` and the per-server `res.map(<Backend>)`.
   Tethers/packets: `agentLive(instanceId)` and `serverPos(name)` / `backendPos(server, res)`; skip when undefined.
   Always draw the backends (Loki, Prometheus, GitHub API...): a theme without its own server -> backend edge can use
   `<ResourceWire mcp backend />` (idle / in-flight dashes / result pulse). Recent-activity glow: `mcpGlow(activeAt, now)`.
6. **Graph -> side resource** (`GraphResource` slot, `{ galaxy }`): draw the old centerpiece in its OWN frame
   centred at 0 with radius `graph.natural` (shrink internal constants if it was huge). The kit positions,
   scales (`kit.graph.scale`), fades and hides it (rendered only when `world.hasGraph` and the galaxy has nodes;
   never draw a fake graph).
   - beams agent <-> node: either draw inside the slot with `stageToGraph(agentLive(id), tmp)` (neural Cortex)
     or on stage with `graphToStage(nodeLocal, tmp)`.
   - point sprites sized in view space (`gl_PointSize = size * uScale / -mv.z`) must multiply `uScale` by
     `kit.graph.scale`, or the nodes stay full size on a small graph.
   - `ping()`/ripple effects that live on stage: convert with `graphToStage` and scale radii by `kit.graph.scale`.
   - extras outside the slot that need the galaxy: `useKitGalaxy()`.
   - stage-sized beams/sparks drawn inside the slot: wrap them in `<GraphStageSpace>` (undoes the graph transform).
   - which side the graph sits on: `kit.graph.out` (unit outward direction), e.g. captions on the far side.
   - dynamic nodes (`../graphDyn.ts`): the galaxy carries the served sample plus nodes events touched outside it
     (`dyn: true`, LRU-capped at DYN_MAX). Cap with `graphView(galaxy, maxSample)` (never `slice`, it would drop
     them), lay out the first `ns` sampled nodes as before and the rest with `placeDynamic()` / `dynDir()` (hashed:
     stable for every viewer). Name labels skip `f.area` flares (lit for an event that named no node).
7. **Backdrops sized to the content:** read `kit.core.hw / hh / r` (eased half extents of agents + clusters) in
   useFrame. Things that must stay visible but are theme-specific (labels at a line's end,
   a backdrop rim) go in the `extents` prop: `visit(stagePoint, radius)`.
8. **Delete** the theme's layout code: slot tables, `somaTarget`/`homeR`/`flightSlot`/`displaySlot`/`lineAngle`,
   `laneRank`/`rankOffset` fan-outs, `run.slot`-based angles, `scoutCount`, lane `BESIDE` tables, `RANK_GAP`,
   any crowd scale. `run.color` stays (palette). Keep shaders, geometries, materials, easing, pools.
9. **Verify** (see the bottom of this file).

## Pitfalls

- **Order of frames.** KitScene's ticker runs first each frame (tick -> lodTick -> kitTick) and copies `pos` into
  `live`. Slot useFrames run after it. Do not call `tick()`/`lodTick()` in a theme.
- **Read per-frame values inside useFrame**, not in render: `agent.scale`, `agent.pos`, `run.origin`,
  `mcp.pos`, `kit.graph.scale` all change every frame. Render-time reads are fine only for decisions that must
  not flip (e.g. which side a tag goes on: use `agent.target` / `mcp.target` in a `useMemo`).
- **No per-frame allocations:** no `new Vector3`, array literals, closures or template strings in useFrame;
  use module scratch objects (`const _a = new THREE.Vector3()`), pools, `Float64Array` scratch.
- **Plane mapping.** Layout 2D (a right, b up) -> `xy`: (a, b, 0); `xz`: (a, 0, -b). Kit positions have
  y = 0 in `xz`: add altitude in the slot (`pos.y = TRAIN_Y`), never in the kit.
- **Run frame handedness.** `side` is flipped to read left->right; if you build a basis from side/up/axis,
  keep it right-handed.
- **Agents always centred.** Do not offset the stage group or the orbit target to "make room" for HUD panels;
  FitCamera already measures `.hud-top/.hud-dock/.hud-side` (top bar, dock, sidebar or rail) and shifts the projection.
  Theme buttons go in `hudInset` (the dock beside the LOD chip); size HUD DOM with container queries / `cq*` units
  (`.scene-root` is the `agscene` container), never viewport media queries.
- **Fog / LOD by camera distance:** read `fit.cam.dist` (camera distance to the orbit target).
- **Labels are px-clamped**, so their world size grows when the camera backs off; keep run labels close to the
  run (above it). Run / MCP / backend / cluster labels and the graph caption are framed by their screen size
  automatically.
- **Clusters** sit in the plane: lift them with `clusterOffset` on ground themes (`[0, 0.9..1.9, 0]`).
- **One KitScene per page** (the kit is a singleton like `world`).
- Collapsed agents have no `KitAgent`: every effect keyed by agent must handle `agentLive(id) === undefined`.

## Verify

```
cd frontend && npx tsc --noEmit -p . && npm run build:app && npm run build:lib
uv run --no-project --with-editable backend agentglow serve --port 8145          # from repo root
HOLD_S=60 node examples/react-embed/scripts/send-demo-spans.mjs http://localhost:8145
```
Debug hooks (read-only): `window.__agentglowKit` (agents/runs/mcp/core; `.summary()` / JSON = plain data),
`window.__agentglowFit` (scale, measured HUD insets, `cam.want/dist/user`, `fill`, `framedPoints()`) and
`window.__agentglowLabels.snapshot()` (labels shown / hidden by the declutter pass) - handy in `page.evaluate`.

Check at 1600x900 and 600x400 (private headless Playwright): 1 run -> agents big and centred, no graph drawn;
`?sim=1` -> graph small at the side and beams reach it; 3 runs; 300 runs -> grouped, ~60fps, nothing under the
HUD; no console errors.
