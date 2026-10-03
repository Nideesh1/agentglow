/**
 * /bubblechamber - "Bubble chamber" (scene-kit theme, preset: radial on the xy plane).
 * A particle-physics bubble chamber photo come alive: agents are charged particles curling in the magnetic field,
 * each leaving a thin track of bubbles that fades in a few seconds (one GPU-aged Points pool for every track).
 * Thinking particles curl tight and bright, waiting ones slow to a small orbit, finished ones spiral in to a stop.
 * The chamber is a real volume: an elliptic glass tank whose axis is the magnetic field (stage z), so every track
 * is a HELIX along the field (radius = curvature, pitch = drift along the axis) and orbiting the camera shows the
 * depth: runs sit at different depths, subagents scatter round their run.
 * A subagent spawn is a decay (the tracks split into a V at a vertex flash), LLM calls are bubble bursts with a
 * delta ray sized by tokens, tool calls kink the track, a guard deny kinks it hard with a red flash. Each run is
 * an event at its own primary vertex; MCP servers are strip detector plates with hexagonal sensor cells for their
 * backends; the knowledge graph is the event archive on the side (a stack of archived event plates).
 */
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { KitScene, kit } from "../shared/kit";
import { ARCHIVE_R, Archive } from "./Archive";
import { Bubbles, Chamber } from "./Chamber";
import { McpTracks } from "./Detectors";
import { agentDepth, tank, vertices } from "./fx";
import { EventVertex, Finals } from "./Runs";
import { AgentDepth, Lineage, Particle } from "./Tracks";

/** the kit MCP crystal in this theme's palette */
const MCP_STYLE = { tint: "#7dd3fc", tintAmt: 0.3, gain: 0.6, halo: 0.4 };

// full 360 orbit round the vertical axis (the back-lit liquid always faces the camera, the tank shows its depth)
const CONTROLS = {
  minPolarAngle: Math.PI * 0.25,
  maxPolarAngle: Math.PI * 0.75,
};

/** keep every run's primary vertex and every agent AT ITS DEPTH in view (near agents project wider), the tank's
 *  mid-length outline (its window always fits the screen) and its two window centres (no effect head-on; from the
 *  side they frame the drum's length) */
function extents(visit: (p: THREE.Vector3, r: number) => void) {
  for (const v of vertices.values()) visit(v, 0.9);
  for (const a of kit.agents.values()) visit(_e.set(a.target.x, a.target.y, agentDepth(a)), 1.1 * a.scale);
  visit(_e.set(tank.rx, 0, 0), 0);
  visit(_e.set(-tank.rx, 0, 0), 0);
  visit(_e.set(0, tank.ry, 0), 0);
  visit(_e.set(0, -tank.ry, 0), 0);
  visit(_e.set(0, 0, tank.hz), 0);
  visit(_e.set(0, 0, -tank.hz), 0);
}
const _e = new THREE.Vector3();

export default function Scene() {
  return (
    <KitScene
      title="bubble chamber · particle tracks"
      subtitle="Agents are charged particles on helices along the field (tight = thinking, slow orbit = waiting, spiral in = done) · a spawn is a decay into a V · LLM calls burst bubbles, tools kink the track, a deny flashes red · each run is an event at its vertex · ▭ MCP detector plates, ⬡ backend cells · graph = event archive (a read pulls its plate out)"
      preset="radial"
      plane="xy"
      camera={{ position: [0, 0, 34], fov: 46, far: 1200 }}
      controls={CONTROLS}
      bg="#010406"
      gl={{ antialias: true }}
      fit={{ nRef: 4, min: 0.62, max: 1.6, minRadius: 5.5 }}
      agentRadius={1.1}
      graph={{ natural: ARCHIVE_R * 1.05, radius: 4.4 }}
      peripheryGap={3.8}
      extents={extents}
      Background={<Chamber />}
      Agent={Particle}
      RunMarker={EventVertex}
      mcpStyle={MCP_STYLE}
      GraphResource={Archive}
      cluster={{ radius: 1.4, variant: "swarm", glowGain: 0.9 }}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={0.9} luminanceThreshold={0.2} luminanceSmoothing={0.3} radius={0.6} />
          <Vignette eskil={false} offset={0.22} darkness={0.85} />
        </EffectComposer>
      }
    >
      <AgentDepth />
      <Lineage />
      <McpTracks />
      <Finals />
      <Bubbles />
    </KitScene>
  );
}
