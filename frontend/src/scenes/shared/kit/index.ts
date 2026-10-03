/**
 * SCENE KIT: themes are SKINS, the kit owns BEHAVIOR.
 *
 * A kit theme renders <KitScene> with a layout preset and a handful of slot components. The kit decides WHERE
 * everything is and HOW BIG it is; the theme decides what it LOOKS like. A cross-cutting change (graph placement,
 * scaling, grouping, spacing) is one edit here instead of one per theme.
 *
 * ---------------------------------------------------------------------------------------------- product rules
 *  1. Agents are always the centre. Visible runs are laid out around the stage centre by the theme's preset;
 *     each run is centred on its anchor (1 run = its agents centred on screen).
 *  2. The knowledge graph is just another RESOURCE on the side (like MCP servers + backends), on the outskirts
 *     and small. Resources are shown ONLY WHEN USED: the graph appears on the first `graph` read/write event
 *     (world.hasGraph; sim always uses it), drawing the served FalkorDB sample if any, else the event-grown
 *     galaxy; it fades in at the side and agents don't move. An MCP server (+ the backends calls targeted)
 *     appears on its first `mcp` call and fades out after MCP_IDLE_MS (~90s) idle with nothing in flight
 *     (world.mcpWanted; mcp_register only supplies names/kinds). Hidden or fading resources take no room in
 *     placement / fit. Beams agent <-> graph use graphToStage() / stageToGraph().
 *  3. Adaptive fit (fit.ts): agent scale ~ sqrt(nRef / visible count) clamped, spacing follows, the camera dollies
 *     so everything kit-placed fits the FREE area (canvas minus measured HUD panels) and the projection centre
 *     is shifted into that free area. Calm camera: changes are batched (~1.1s quiet, max 2.5s), then scale then
 *     camera move once (ease-in-out); zoom out promptly, zoom in only after ~7s stable and >18% gain; user
 *     orbit/zoom suspends refit 10s; resize / embedding re-fits quickly (see fit.ts header).
 *  4. Existing behavior is kept: auto-grouping (lod.ts) with one ClusterBall per active lane, Label3D labels
 *     (showLabel), seeded spawn variation and stable sibling slots, subagents fanned from their parent with
 *     directional edges, MCP servers/backends on the outskirts, exit fades (lingerMs), reduced motion,
 *     no autoRotate, no per-frame allocations. Exiting agents never expand out of a cluster; slot mounts are
 *     capped per frame.
 *  5. Labels never pile up: every Label3D takes part in a screen-space declutter pass (labels.ts, ~10Hz) that
 *     ranks it by the slot it renders in and hides / shortens the losers.
 *
 * ---------------------------------------------------------------------------------------------- pieces
 *  state.ts     `kit` singleton: agents (KitAgent), runs (KitRun), mcp (KitMcp + KitBackend), clusterPos[lane],
 *               graph (KitGraph), core extents; helpers agentLive / serverPos / backendPos / runLocal /
 *               graphToStage / stageToGraph / planePoint. One KitScene per page (like `world`).
 *  presets.ts   LayoutPreset = run anchor + fan angle for run i of n, local agent style, cluster ring/row,
 *               periphery style. Built in: radial, drift.
 *  layout.ts    kitTick(): membership -> run-local coords -> run anchors -> clusters/core/periphery -> easing.
 *  fit.ts       fit (scale/spread/label/aspect/insets/cam/wpp), fitTick(), <FitCamera> (frames the content's
 *               screen bounds, labels included, and centres them in the free area), measureInsets().
 *  dim.ts       finished look: done/failed agents stay at their spot DIMMED (agent.dim) until their run ends,
 *               then the whole run fades out together (world.ts isDone / isLive).
 *  labels.ts    label registry + declutter pass (LabelScope context, priorities, framed label rects).
 *  SkillSigil.tsx  amber ring + skill name around an agent using a skill (world `skill` events), all themes;
 *               shown >= SKILL_MIN_MS after a start, lazily mounted, billboarded, sized from the agent.
 *  DecisionGlyph.tsx  fast decision glyph on an agent (world `decision` events: Jev / Laya / LLM-as-judge), all
 *               themes: choice = option-ray fan, noul = gate (green open / red slam, guard deny = red X), score =
 *               gauge; snaps in ~150ms, gone by ~1.6s; stacked labels below the agent, "+N more".
 *               High volume (`hv` decisions): ~0.8s holds, one glyph per agent at a time + "+N".
 *  HighVolume.tsx  decision halos (one instanced mesh: ring split by outcome, thickness ~ rate, from
 *               `decision_stats`), the halo label `jev 42/s · 3% deny`, and order chips (`order`).
 *  Prims.tsx    generic primitives (prims.ts state): per-agent ring (progress arc, lifecycle tint, rejected flash,
 *               restart pulse) + compact status line, business event chips, dashed fallback / callback edges and
 *               backlog ribbons (<PrimEdges>), resource stats under backend nodes.
 *  KitScene.tsx <KitScene> + slot prop types + useKitAgents / useKitRuns / useKitMcp / useKitList,
 *               <GraphStageSpace> (stage-space drawing inside the side graph), `hudInset` (HUD dock).
 *
 * ---------------------------------------------------------------------------------------------- coordinates
 *  Layout is 2D (a = screen-right, b = screen-up, world units) mapped onto the stage plane: "xy" -> (a, b, 0),
 *  "xz" -> (a, 0, -b). A run has a frame: origin, `axis` (subagents fan along it), `side` (top-level agents line up
 *  on it: planner | researcher | writer). Agents carry run-local (u along side, v along axis); runLocal(run,u,v)
 *  maps any run-local point (stations, track ends) to stage space with the run's eased centring applied.
 *
 *  Per frame order: world tick() -> lodTick() -> kitTick() (KitScene's ticker, mounted first), then theme
 *  useFrames. kitTick copies each agent's eased home `pos` into `live`; a theme may add motion to `live`
 *  (drift, shuttling train, holding pattern) and everything that links to the agent reads `live`.
 *
 *  See PORTING.md for the step-by-step recipe to port a theme.
 */
export { kit, kitSummary, reduced, agentLive, serverPos, backendPos, runLocal, graphToStage, stageToGraph, planePoint, planeA, planeB } from "./state";
export type { Plane, KitAgent, KitRun, KitMcp, KitBackend, KitGraph } from "./state";
export { PRESETS, radial, drift, clusterCellSize } from "./presets";
export type { LayoutPreset, LocalStyle, PresetCtx, PresetName } from "./presets";
export { kitTick, kitExtents, kitActiveLanes, kitRoleU, config as kitConfig } from "./layout";
export { fit, fitTick, setFitProfile, FitCamera, measureInsets, DEFAULT_FIT } from "./fit";
export { labels, LabelScope } from "./labels";
export type { LabelKind, LabelScopeValue } from "./labels";
export type { FitProfile } from "./fit";
export { ResourceWire, wireState } from "./ResourceWire";
export { DecisionGlyph, DECISION_COLOR, DECISION_YES, DECISION_NO } from "./DecisionGlyph";
export { DecisionHalos, HaloLabel, OrderChip } from "./HighVolume";
export type { ResourceWireProps } from "./ResourceWire";
export { KitScene, GraphStageSpace, useKitAgents, useKitRuns, useKitMcp, useKitList, useKitGalaxy } from "./KitScene";
export type { KitSceneProps, AgentSlotProps, EdgeSlotProps, RunSlotProps, McpServerSlotProps, BackendSlotProps, GraphSlotProps, ClusterSlotProps } from "./KitScene";
export { PrimMark, EventChip, PrimEdges, ResourceStat } from "./Prims";
export { McpCrystal, McpSatellite, satellitePos, DEFAULT_CRYSTAL } from "./Crystal";
export type { CrystalStyle, SparkEmit } from "./Crystal";
