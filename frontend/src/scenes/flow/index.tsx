/**
 * /flow - "Particle flow field / murmuration" (scene-kit theme, preset: drift on the ground plane).
 * Tens of thousands of particles swirl in luminous currents. Agent instances are bright eddies that condense out of
 * the field AT the kit's agent positions (the kit's targets are the eddies' attractors), spin while working and
 * dissolve back into the current on exit. Each run is a slow vortex loop around its agents with three attractors
 * (plan -> research -> write) lit by step status; handoffs pour a jet between them. Messages are comet streams; MCP
 * servers are pulsars on the outskirts with tethers while calls wait. FalkorDB is a nebula current on the side
 * (only when the session has a graph; flares burst its anchors, writes = white supernova rings).
 */
import { useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { idleText, isIdle, STEP_SLOTS, slotLabel, slotStatus, stepChips, TYPE_COLOR, useWorld, world, type AgentType, jobText } from "../shared/world";
import { KitScene, fit, kit, kitRoleU, runLocal, useKitGalaxy, type AgentSlotProps, type GraphSlotProps, type RunSlotProps } from "../shared/kit";
import { FlowEngine, NEB_R, PULSAR_Y } from "./engine";
import "./flow.css";

/** the kit MCP crystal in this theme's palette */
const MCP_STYLE = { tint: "#a5b4fc", tintAmt: 0.2, gain: 0.6, halo: 0.25, lift: PULSAR_Y };

const _v = new THREE.Vector3();
const STEP_ROLE: AgentType[] = ["planner", "researcher", "writer"];

/** One engine per page (one KitScene per page): created on first use, never rebuilt (the graph grows in place). */
const holder = { engine: null as FlowEngine | null };
const getEngine = () => (holder.engine ??= new FlowEngine());

/** The murmuration itself: steps the engine once per frame (after the kit's ticker) and draws the stage layers. */
function Field() {
  const engine = getEngine();
  const gl = useThree((s) => s.gl);
  const galaxy = useKitGalaxy();
  useEffect(() => {
    engine.setGalaxy(galaxy);
  }, [engine, galaxy]);
  useEffect(() => {
    engine.material.uniforms.uPR.value = gl.getPixelRatio();
    engine.nebMaterial.uniforms.uPR.value = gl.getPixelRatio();
  }, [engine, gl]);
  useEffect(
    () => () => {
      engine.dispose();
      if (holder.engine === engine) holder.engine = null;
    },
    [engine],
  );
  useFrame((state, dt) => {
    engine.update(dt, performance.now(), state.clock.elapsedTime);
  });
  return (
    <group>
      <points geometry={engine.fieldGeo} material={engine.material} frustumCulled={false} />
      <points geometry={engine.runGeo} material={engine.material} frustumCulled={false} />
      <points geometry={engine.streamGeo} material={engine.material} frustumCulled={false} />
      <points geometry={engine.glowGeo} material={engine.material} frustumCulled={false} />
      <lineSegments geometry={engine.beamGeo} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
      <primitive object={engine.cores} />
      <primitive object={engine.attractors} />
      <primitive object={engine.stepRings} />
      <primitive object={engine.rings} />
      {/* MCP servers: the kit crystal at PULSAR_Y (engine.pulsars stays undrawn); the jets remain */}
      <primitive object={engine.pulsarBeams} />
      <primitive object={engine.selRing} />
    </group>
  );
}

/** Agent slot: the eddy is drawn by the engine; this is its click target (and tells the engine what is selected). */
function Eddy({ agent, selected, onSelect }: AgentSlotProps) {
  const hit = useRef<THREE.Mesh>(null);
  useEffect(() => {
    const e = getEngine();
    if (selected) e.selectedId = agent.id;
    else if (e.selectedId === agent.id) e.selectedId = null;
  }, [selected, agent.id]);
  useEffect(
    () => () => {
      const e = holder.engine;
      if (e && e.selectedId === agent.id) e.selectedId = null;
    },
    [agent.id],
  );
  useFrame(() => {
    const m = hit.current;
    if (!m) return;
    m.position.copy(agent.live);
    m.scale.setScalar(Math.max(0.6, fit.scale) * (agent.depth ? 0.8 : 1));
    m.visible = !agent.inst.exitAt;
  });
  return (
    <mesh
      ref={hit}
      onClick={(e) => (e.stopPropagation(), onSelect(agent.id))}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "")}
    >
      <sphereGeometry args={[0.95, 10, 8]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
    </mesh>
  );
}

/** RunMarker slot: the run's name above its vortex + step names over its attractors (the vortex is engine-drawn). */
function RunLabel({ run: kr }: RunSlotProps) {
  useWorld(); // re-render on events (step chips)
  const run = kr.run ?? world.runs.get(kr.id);
  const g = useRef<THREE.Group>(null);
  const steps = useRef<(THREE.Group | null)[]>([]);
  useFrame(() => {
    // above the vortex loop, on its far side
    g.current?.position.set(kr.origin.x, 0.6, kr.origin.z - Math.min(11, Math.hypot(kr.hu, kr.hv) * 0.92 + 0.6) - 1.3);
    for (let k = 0; k < 3; k++) {
      const sg = steps.current[k];
      if (!sg) continue;
      runLocal(kr, kitRoleU(STEP_ROLE[k]), 0, _v);
      sg.position.set(_v.x, 1.45 * Math.max(0.85, fit.scale), _v.z + 0.9 * fit.spread);
    }
  });
  if (!run) return null;
  // small embeds: just the topic (the step chips + per-attractor names would pile up)
  const compact = fit.w < 900;
  const chip = (st: string) => (st === "running" ? run.color : st === "done" ? "#cbd5e1" : st === "failed" ? "#fecaca" : "#64748b");
  const stepLine = () => {
    const { shown, more } = stepChips(run);
    const segs = shown.map((st, i) => ({ text: `${i ? "  " : ""}${st.toUpperCase()}`, color: chip(run.steps[st]) }));
    if (more) segs.push({ text: `  +${more}`, color: chip("queued") });
    if (run.status === "started" && isIdle(run)) segs.push({ text: `  ${idleText(run)}`, color: chip("queued") });
    return segs;
  };
  return (
    <>
      <group ref={g}>
        <Label3D
          text={`${run.hasSteps ? "hatchet · " : ""}${run.topic}`}
          secondary={compact ? undefined : run.hasSteps ? stepLine() : run.status === "started" ? (isIdle(run) ? idleText(run) : "running…") : "run complete"}
          secondarySize={0.24}
          color={run.color}
          size={0.32}
          maxWidth={compact ? 5 : 7}
          fadeMs={300}
          pxRange={[10, 14]}
        />
      </group>
      {run.hasSteps &&
        !compact &&
        STEP_SLOTS.map((i) => (
          <group key={i} ref={(x) => void (steps.current[i] = x)}>
            <Label3D
              text={slotLabel(run, i)}
              font="mono"
              plate="none"
              uppercase
              letterSpacing={0.08}
              textColor={run.color}
              size={0.24}
              opacity={slotStatus(run, i) === "running" ? 1 : slotStatus(run, i) === "done" ? 0.75 : 0.55}
              fadeMs={300}
              pxRange={[7.5, 10.5]}
            />
          </group>
        ))}
    </>
  );
}

/** GraphResource slot: the FalkorDB nebula current, in the side graph's local frame (radius NEB_R). */
function Nebula(_: GraphSlotProps) {
  const engine = getEngine();
  useFrame(() => {
    // point sprites are sized in view space: follow the kit's group scale so the side nebula stays proportionate
    engine.nebMaterial.uniforms.uScale.value = (engine.material.uniforms.uScale.value as number) * kit.graph.scale;
  });
  return (
    <group>
      <points geometry={engine.nebGeo} material={engine.nebMaterial} frustumCulled={false} />
      <points geometry={engine.anchorGeo} material={engine.nebMaterial} frustumCulled={false} />
      <lineSegments geometry={engine.edgeGeo} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
      <GraphLabel3D position={[0, -0.6, NEB_R + 0.9]} color="#a5b4fc" size={0.34} pxRange={[9.5, 13]} />
    </group>
  );
}

/** One floating label that follows the selected (or most recently active) agent eddy. */
function FocusLabel() {
  const g = useRef<THREE.Group>(null);
  const el = useRef<Label3DHandle>(null);
  const last = useRef("");
  useFrame(() => {
    const engine = holder.engine;
    if (!engine) return;
    const id = engine.selectedId ?? world.focus;
    const s = id ? engine.slotOf(id) : null;
    const show = !!s && !!s.inst && !s.inst.exitAt;
    el.current?.setOpacity(show ? 1 : 0);
    if (!s || !s.inst || !g.current || !el.current) return;
    g.current.position.set(s.x, s.y + 1.25 * Math.max(0.85, fit.scale), s.z);
    const txt = (s.inst.job ? jobText(s.inst) : s.inst.name) + " · " + s.inst.status;
    if (txt !== last.current) {
      last.current = txt;
      el.current.setText(txt);
      el.current.setColor(TYPE_COLOR[s.inst.type]);
    }
  });
  return (
    <group ref={g}>
      <Label3D ref={el} text="" size={0.3} opacity={0} fadeMs={300} pxRange={[9, 13]} renderOrder={24} />
    </group>
  );
}

/** Label for the latest FalkorDB flare (node name, read/write), over its anchor in the side nebula. */
function FlareLabel() {
  const g = useRef<THREE.Group>(null);
  const el = useRef<Label3DHandle>(null);
  const last = useRef("");
  useFrame(() => {
    const engine = holder.engine;
    const f = engine?.lastFlare;
    if (!engine || !f || !g.current || !el.current) return;
    const age = (performance.now() - f.at) / 1000;
    el.current.setOpacity(age < 2.2 && kit.graphWanted ? 1 : 0);
    engine.anchorWorld(f.idx, _v);
    g.current.position.set(_v.x, _v.y + 0.9, _v.z);
    if (last.current !== f.name + f.op) {
      last.current = f.name + f.op;
      el.current.setText((f.op === "write" ? "wrote · " : "read · ") + f.name);
      el.current.setColor(f.op === "write" ? "#ffffff" : "#a5b4fc");
    }
  });
  return (
    <group ref={g}>
      <Label3D ref={el} text="" size={0.28} opacity={0} fadeMs={400} pxRange={[8.5, 12]} renderOrder={24} />
    </group>
  );
}

export default function Scene() {
  const fitProfile = useMemo(() => ({ nRef: 4, min: 0.62, max: 1.45, minRadius: 7 }), []);
  return (
    <KitScene
      title="flow · murmuration"
      subtitle="agents are eddies condensing out of the current · hatchet runs are vortices · the knowledge graph is a nebula current on the side"
      preset="drift"
      plane="xz"
      camera={{ position: [0, 25, 28], fov: 50 }}
      controls={{ maxPolarAngle: Math.PI * 0.47 }}
      bg="#020309"
      gl={{ antialias: false }}
      fit={fitProfile}
      agentRadius={1.6}
      graph={{ natural: NEB_R, radius: 3.6 }}
      peripheryGap={4.5}
      Agent={Eddy}
      RunMarker={RunLabel}
      mcpStyle={MCP_STYLE}
      GraphResource={Nebula}
      cluster={{ radius: 1.7, variant: "swarm", pointSize: 1.1 }}
      clusterOffset={[0, 1.8, 0]}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.22} luminanceSmoothing={0.25} radius={0.78} />
          <Vignette eskil={false} offset={0.22} darkness={0.85} />
          <Noise opacity={0.03} />
        </EffectComposer>
      }
    >
      <Field />
      <FocusLabel />
      <FlareLabel />
    </KitScene>
  );
}
