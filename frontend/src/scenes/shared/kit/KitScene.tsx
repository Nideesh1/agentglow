/**
 * <KitScene> - the Canvas plumbing every kit theme shares: data source, camera + OrbitControls (no autoRotate),
 * the per-frame ticker (world tick -> lodTick -> kitTick), adaptive FitCamera, the slot lists (agents, edges,
 * runs, clusters, MCP servers + backends, side graph) and the HUD. A theme passes its look as slots.
 */
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import * as THREE from "three";
import { ClusterBalls, type ClusterBallProps, type ClusterColor } from "../ClusterBall";
import { Hud } from "../Hud";
import { LOD_LANES, lod, lodTick, type LodCluster } from "../lod";
import { useSceneSetup, type Galaxy } from "../useSceneSetup";
import { selectInstance, selectResource, tick, useHasGraph, world } from "../world";
import { LinkPicks, ResourcePick } from "./Picks";
import { CrystalStyleCtx, DEFAULT_CRYSTAL, liftOf, McpCrystal, McpSatellite, type CrystalStyle } from "./Crystal";
import { applyDim } from "./dim";
import { FitCamera, setFitProfile, type FitProfile } from "./fit";
import { LabelScope, labels, labelTick, type LabelScopeValue } from "./labels";
import { config, kitExtents, kitTick } from "./layout";
import { SkillSigil } from "./SkillSigil";
import { DecisionGlyph } from "./DecisionGlyph";
import { DecisionHalos, HaloLabel, OrderChip } from "./HighVolume";
import { Fizzles } from "./Fizzle";
import { HaltMark, haltMix } from "./Halt";
import { EventChip, PrimEdges, PrimMark, ResourceStat } from "./Prims";
import { ServiceLinks } from "./ServiceLinks";
import { PRESETS, type LayoutPreset, type PresetName } from "./presets";
import { kit, type KitAgent, type KitBackend, type KitMcp, type KitRun, type Plane } from "./state";

// ------------------------------------------------------------------ slot props

/** Draw ONE agent. Read `agent.live` / `agent.scale` / `agent.inst` inside useFrame (they change every frame). */
export type AgentSlotProps = { agent: KitAgent; selected: boolean; onSelect: (id: string) => void };
/** Draw the parent -> child edge of `child` (child.inst.parent is set). Parent position: agentLive(parentId). */
export type EdgeSlotProps = { child: KitAgent };
/** Per-run marker (aura, line, sector arc, label). Frame: run.origin / run.axis / run.side, runLocal(). */
export type RunSlotProps = { run: KitRun };
export type McpServerSlotProps = { mcp: KitMcp };
export type BackendSlotProps = { mcp: KitMcp; backend: KitBackend };
/** The side graph, drawn in its OWN local frame (centre 0, radius `graph.natural`); the kit positions/scales/fades it. */
export type GraphSlotProps = { galaxy: Galaxy };
/** Custom cluster (instead of the stock ClusterBall): one per lane, hide it while `cluster.active` is false. */
export type ClusterSlotProps = { lane: number; cluster: LodCluster; pos: THREE.Vector3 };

export type KitSceneProps = {
  title: string;
  subtitle: string;
  /** layout preset (presets.ts) or a custom one */
  preset: PresetName | LayoutPreset;
  /** stage plane of the 2D layout: "xy" (camera looks down -z) or "xz" (ground plane) */
  plane: Plane;
  camera: { position: [number, number, number]; fov?: number; near?: number; far?: number };
  /** orbit target (default origin) */
  target?: [number, number, number];
  /** extra OrbitControls props (polar limits, enableRotate...). autoRotate is never on. */
  controls?: { minPolarAngle?: number; maxPolarAngle?: number; minAzimuthAngle?: number; maxAzimuthAngle?: number; enablePan?: boolean; enableRotate?: boolean };
  /** adaptive fit tuning (nRef, min/max scale, min/max framing radius, margin) */
  fit?: Partial<FitProfile>;
  /** world radius of one agent at scale 1 (used to keep agents fully in view) */
  agentRadius?: number;
  /** "xz" stages: world height of one agent at scale 1 above the ground (towers, trees): its top stays in view */
  agentHeight?: number;
  /** side graph: `natural` = radius of your GraphResource in its own units; `radius` = world radius it gets */
  graph?: { natural: number; radius?: number };
  /** gap between the core (agents) and the periphery (MCP, graph), world units */
  peripheryGap?: number;
  /** canvas background color */
  bg?: string;
  /** extra class on .scene-root */
  className?: string;
  gl?: Record<string, unknown>;

  Agent: ComponentType<AgentSlotProps>;
  Edge?: ComponentType<EdgeSlotProps>;
  RunMarker?: ComponentType<RunSlotProps>;
  /** MCP server / backend look: default = the kit crystal + orbiting satellites (Crystal.tsx), tinted by `mcpStyle` */
  McpServer?: ComponentType<McpServerSlotProps>;
  Backend?: ComponentType<BackendSlotProps>;
  /** the kit crystal's palette tint, brightness, halo, lift above the stage, size, sparks */
  mcpStyle?: Partial<CrystalStyle>;
  GraphResource?: ComponentType<GraphSlotProps>;
  /** stock ClusterBall look (variant/radius...); `color` may be a function of the lane */
  cluster?: Omit<ClusterBallProps, "cluster" | "position" | "place" | "color"> & { color?: ClusterColor };
  /** stage offset added to cluster ball positions (e.g. lift above a ground plane) */
  clusterOffset?: [number, number, number];
  /** or a fully custom cluster */
  Cluster?: ComponentType<ClusterSlotProps>;
  /** inside the Canvas, outside the stage (lights, stars, fog, floor grid) */
  Background?: ReactNode;
  /** last thing in the Canvas (EffectComposer...) */
  PostFX?: ReactNode;
  /** extra things that must stay in view: visit(stagePoint, radius) */
  extents?: (visit: (p: THREE.Vector3, r: number) => void) => void;
  /** theme extras inside the stage (pooled beams, tethers, pulses, particles) reading kit state */
  children?: ReactNode;
  /** extra DOM over the canvas (inside the HUD layer) */
  hudChildren?: ReactNode;
  /** small theme controls (buttons, chips) for the HUD dock: placed beside the LOD chip, never under it */
  hudInset?: ReactNode;
};

const GalaxyCtx = createContext<Galaxy>({ nodes: [], links: [] });
/** The session's graph sample inside a KitScene (empty until the session has a graph). */
export const useKitGalaxy = () => useContext(GalaxyCtx);

// ------------------------------------------------------------------ hooks

/** Re-render when `version()` changes (checked every frame); returns build() of the latest version. */
export function useKitList<T>(version: () => number, build: () => T): T {
  const [state, setState] = useState<{ v: number; value: T }>(() => ({ v: version(), value: build() }));
  const seen = useRef(state.v);
  useFrame(() => {
    const v = version();
    if (v !== seen.current) {
      seen.current = v;
      setState({ v, value: build() });
    }
  });
  return state.value;
}

const agentList = () => [...kit.agents.values()];
const runList = () => [...kit.runs.values()];
const mcpList = () => [...kit.mcp.values()];
const agentsV = () => kit.agentsVersion;
const runsV = () => kit.runsVersion;
const mcpV = () => kit.mcpVersion;

/** Drawn agents (re-renders on membership change). */
export const useKitAgents = () => useKitList(agentsV, agentList);
/** Drawn runs. */
export const useKitRuns = () => useKitList(runsV, runList);
/** MCP servers (re-renders when a server or backend appears). */
export const useKitMcp = () => useKitList(mcpV, mcpList);

// ------------------------------------------------------------------ pieces

function Ticker() {
  useEffect(() => {
    labels.active++;
    return () => void labels.active--;
  }, []);
  useFrame(({ size }) => {
    const now = performance.now();
    tick(now);
    lodTick(now);
    kitTick(now);
    labelTick(now, size.width, size.height);
  }, -2);
  return null;
}

// label declutter classes per slot (see labels.ts)
const SCOPE_RUN: LabelScopeValue = { kind: "run" };
const SCOPE_MCP: LabelScopeValue = { kind: "mcp" };
const SCOPE_BACKEND: LabelScopeValue = { kind: "backend" };
const SCOPE_GRAPH: LabelScopeValue = { kind: "graph" };
const SCOPE_CLUSTER: LabelScopeValue = { kind: "cluster" };

function AgentScope({ agent, children }: { agent: KitAgent; children: ReactNode }) {
  const v = useMemo<LabelScopeValue>(() => ({ kind: agent.depth > 0 ? "sub" : "agent", agent }), [agent]);
  return <LabelScope.Provider value={v}>{children}</LabelScope.Provider>;
}

/** Finished look (dim.ts): dims the Agent + Edge slots of a done/failed agent while it waits for its run to end. */
function Dim({ agent, children }: { agent: KitAgent; children: ReactNode }) {
  const g = useRef<THREE.Group>(null);
  const prev = useRef(0);
  useFrame(() => {
    if (!g.current) return;
    const red = world.halts.size ? haltMix(agent.id) : 0;
    applyDim(g.current, agent.dim, agent.inst.status === "failed", prev.current, red);
    prev.current = Math.max(agent.dim, red);
  });
  return <group ref={g}>{children}</group>;
}

function Agents({ Agent, Edge, selected, onSelect, radius, height }: { Agent: ComponentType<AgentSlotProps>; Edge?: ComponentType<EdgeSlotProps>; selected: string | null; onSelect: (id: string) => void; radius: number; height: number }) {
  const list = useKitAgents();
  return (
    <>
      {list.map((a) => (
        <AgentScope key={a.uid} agent={a}>
          <Dim agent={a}>
            {Edge && a.inst.parent && <Edge child={a} />}
            <Agent agent={a} selected={selected === a.id} onSelect={onSelect} />
          </Dim>
          <SkillSigil agent={a} radius={radius} height={height} />
          <DecisionGlyph agent={a} radius={radius} height={height} />
          <HaloLabel agent={a} radius={radius} height={height} />
          <OrderChip agent={a} radius={radius} height={height} />
          <HaltMark agent={a} radius={radius} height={height} />
          <PrimMark agent={a} radius={radius} height={height} />
          <EventChip agent={a} radius={radius} height={height} />
        </AgentScope>
      ))}
      <DecisionHalos radius={radius} height={height} />
      <Fizzles scale={radius} />
      <PrimEdges radius={radius} />
      <ServiceLinks radius={radius} />
      <LinkPicks radius={radius} />
    </>
  );
}

function Runs({ RunMarker }: { RunMarker: ComponentType<RunSlotProps> }) {
  const list = useKitRuns();
  return (
    <LabelScope.Provider value={SCOPE_RUN}>
      {list.map((r) => (
        <RunMarker key={r.uid} run={r} />
      ))}
    </LabelScope.Provider>
  );
}

function Mcp({ McpServer, Backend, crystal }: { McpServer?: ComponentType<McpServerSlotProps>; Backend?: ComponentType<BackendSlotProps>; crystal: CrystalStyle | null }) {
  const list = useKitMcp();
  const lift = (m: KitMcp) => (crystal ? liftOf(crystal, m.srv) : 0);
  return (
    <>
      {list.map((m) => (
        <Fragment key={m.uid}>
          <LabelScope.Provider value={SCOPE_MCP}>
            {McpServer && (
              <Fade item={m} lift={lift(m)} pick={<ResourcePick sel={{ type: "server", server: m.name }} r={1.0} color={m.srv.color} mix={() => m.mix} />}>
                <McpServer mcp={m} />
              </Fade>
            )}
          </LabelScope.Provider>
          <LabelScope.Provider value={SCOPE_BACKEND}>
            {Backend &&
              [...m.backends.values()].map((b) => (
                <Fade key={b.uid} item={b} lift={lift(m)} pick={crystal ? undefined : <ResourcePick sel={{ type: "backend", server: m.name, resource: b.res.name }} r={0.55} color={m.srv.color} mix={() => b.mix * m.mix} />}>
                  <Backend mcp={m} backend={b} />
                  <ResourceStat mcp={m} backend={b} />
                </Fade>
              ))}
          </LabelScope.Provider>
        </Fragment>
      ))}
    </>
  );
}

/**
 * Fades a resource slot (MCP server / backend) in and out with its `mix`: the slot draws in stage space at
 * item.pos, so the wrapper scales everything about that point (T(pos) S(mix) T(-pos)); hidden at mix 0.
 * Runs before the slots' own useFrames (priority -1, after the ticker's -2): a px-clamped Label3D inside undoes its
 * parents' world scale, and a stale (last-frame) scale would draw it many times too big while the slot fades in.
 */
function Fade({ item, children, pick, lift = 0 }: { item: { pos: THREE.Vector3; mix: number }; children: ReactNode; pick?: ReactNode; lift?: number }) {
  const outer = useRef<THREE.Group>(null);
  const inner = useRef<THREE.Group>(null);
  useFrame(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    const t = Math.min(1, Math.max(0, item.mix));
    const s = t * t * (3 - 2 * t);
    o.position.copy(item.pos);
    o.scale.setScalar(Math.max(0.0001, s));
    i.position.copy(item.pos).negate();
    o.visible = s > 0.002;
  }, -1);
  return (
    <group ref={outer} scale={0.0001} visible={false}>
      <group ref={inner}>{children}</group>
      {pick && <group position-y={lift}>{pick}</group>}
    </group>
  );
}

const LANES = Array.from({ length: LOD_LANES }, (_, k) => k);

function Clusters({ cluster, Cluster, offset }: { cluster?: KitSceneProps["cluster"]; Cluster?: ComponentType<ClusterSlotProps>; offset?: [number, number, number] }) {
  const ox = offset?.[0] ?? 0, oy = offset?.[1] ?? 0, oz = offset?.[2] ?? 0;
  const place = useCallback((lane: number, out: THREE.Vector3) => {
    const p = kit.clusterPos[lane];
    if (p) out.set(p.x + ox, p.y + oy, p.z + oz);
    else out.set(ox, oy, oz);
  }, [ox, oy, oz]);
  if (Cluster)
    return (
      <>
        {LANES.map((k) => (
          <Cluster key={k} lane={k} cluster={lod.clusters[k]} pos={kit.clusterPos[k] ?? new THREE.Vector3()} />
        ))}
      </>
    );
  return <ClusterBalls place={place} {...cluster} />;
}

function SideGraph({ galaxy, Graph }: { galaxy: Galaxy; Graph: ComponentType<GraphSlotProps> }) {
  const has = useHasGraph();
  const on = has && galaxy.nodes.length > 0;
  kit.graphWanted = on;
  useEffect(
    () => () => {
      kit.graphWanted = false;
    },
    [],
  );
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const o = g.current;
    if (!o) return;
    const G = kit.graph;
    o.position.copy(G.pos);
    o.scale.setScalar(Math.max(0.0001, G.scale));
    o.visible = G.mix > 0.002;
  }, -1);
  if (!on) return null;
  return (
    <group ref={g} scale={0.0001} visible={false}>
      <LabelScope.Provider value={SCOPE_GRAPH}>
        <Graph galaxy={galaxy} />
      </LabelScope.Provider>
    </group>
  );
}

/**
 * Inside a GraphResource: children are drawn in STAGE space (the side graph's position/scale is undone), so beams,
 * sparks and arrows keep their stage size and can be positioned with graphToStage() / agentLive() directly.
 */
export function GraphStageSpace({ children }: { children?: ReactNode }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const o = g.current;
    if (!o) return;
    const gs = Math.max(1e-4, kit.graph.scale);
    o.scale.setScalar(1 / gs);
    o.position.copy(kit.graph.pos).multiplyScalar(-1 / gs);
  }, -1);
  return <group ref={g}>{children}</group>;
}

const ORIGIN = new THREE.Vector3();

// ------------------------------------------------------------------ the scene

export function KitScene(p: KitSceneProps) {
  const galaxy = useSceneSetup();
  const [selected, setSelected] = useState<string | null>(null);
  // also straight into the world: re-clicking the same agent after a resource was selected must select it again
  const onSelect = useCallback((id: string) => {
    setSelected(id);
    selectInstance(id);
  }, []);

  // theme config -> kit (idempotent, set before the first frame)
  config.preset = typeof p.preset === "string" ? PRESETS[p.preset] : p.preset;
  config.graphNatural = p.graph?.natural ?? 1;
  config.graphRadius = p.graph?.radius ?? 2.6;
  config.peripheryGap = p.peripheryGap ?? 3.6;
  kit.plane = p.plane;
  const fitKey = JSON.stringify(p.fit ?? {});
  useMemo(() => setFitProfile(p.fit ?? {}), [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // a remount (theme switch) re-snaps everything instead of sweeping from the old layout
    for (const a of kit.agents.values()) a.fresh = true;
    for (const r of kit.runs.values()) r.fresh = true;
    for (const m of kit.mcp.values()) m.fresh = true;
    kit.graph.fresh = true;
  }, []);

  const extentsRef = useRef(p.extents);
  extentsRef.current = p.extents;
  const agentRadius = p.agentRadius ?? 1.1;
  const agentHeight = p.agentHeight ?? 0;
  const points = useCallback(
    (visit: (q: THREE.Vector3, r: number) => void) => {
      kitExtents(visit, agentRadius, agentHeight);
      extentsRef.current?.(visit);
    },
    [agentRadius, agentHeight],
  );

  const styleKey = JSON.stringify({ ...p.mcpStyle, emit: !!p.mcpStyle?.emit });
  const crystal = useMemo<CrystalStyle>(() => ({ ...DEFAULT_CRYSTAL, ...p.mcpStyle }), [styleKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const target = p.target ?? [0, 0, 0];
  // only pass defined control props (undefined would reset drei/three defaults)
  const ctl = useMemo(() => Object.fromEntries(Object.entries(p.controls ?? {}).filter(([, v]) => v !== undefined)), [p.controls]);
  return (
    <div className={`scene-root${p.className ? ` ${p.className}` : ""}`}>
      <Canvas
        camera={{ position: p.camera.position, fov: p.camera.fov ?? 46, near: p.camera.near ?? 0.1, far: p.camera.far ?? 600 }}
        dpr={[1, 2]}
        gl={{ antialias: false, powerPreference: "high-performance", ...p.gl }}
        onPointerMissed={() => {
          setSelected(null);
          selectResource(null);
        }}
      >
        {p.bg && <color attach="background" args={[p.bg]} />}
        <Ticker />
        {p.Background}
        <GalaxyCtx.Provider value={galaxy}>
          <group>
            {p.RunMarker && <Runs RunMarker={p.RunMarker} />}
            {p.GraphResource && <SideGraph galaxy={galaxy} Graph={p.GraphResource} />}
            <CrystalStyleCtx.Provider value={crystal}>
              <Mcp McpServer={p.McpServer ?? McpCrystal} Backend={p.Backend ?? McpSatellite} crystal={p.McpServer ? null : crystal} />
            </CrystalStyleCtx.Provider>
            <Agents Agent={p.Agent} Edge={p.Edge} selected={selected} onSelect={onSelect} radius={agentRadius} height={p.plane === "xz" ? agentHeight : 0} />
            <LabelScope.Provider value={SCOPE_CLUSTER}>
              <Clusters cluster={p.cluster} Cluster={p.Cluster} offset={p.clusterOffset} />
            </LabelScope.Provider>
            {p.children}
          </group>
        </GalaxyCtx.Provider>
        <OrbitControls
          makeDefault
          target={target}
          enableDamping
          dampingFactor={0.06}
          enablePan={false}
          minDistance={2}
          maxDistance={400}
          {...ctl}
        />
        <FitCamera points={points} origin={ORIGIN} />
        {p.PostFX}
      </Canvas>
      <Hud title={p.title} subtitle={p.subtitle} selected={selected} onClose={() => setSelected(null)} inset={p.hudInset}>
        {p.hudChildren}
      </Hud>
    </div>
  );
}
