/**
 * /orbit - "Planetary system" (scene-kit theme, preset: radial on the xz plane).
 * Agents are living orbs at the centre, each circling its own home on a small orbit, born out of their parent and
 * imploding on exit; each Hatchet run is an elliptical orbit around its agents with plan / research / write beads;
 * MCP servers are space stations on the outskirts with backend relay probes; FalkorDB is a small spiral galaxy off
 * to the side (only when the session has a graph) that flares and beams to agents on reads / writes.
 */
import { Stars } from "@react-three/drei";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { KitScene } from "../shared/kit";
import { Orb } from "./Agents";
import { GALAXY_R, GalaxyCore } from "./Galaxy";
import { reduced } from "./layout";
import { Beams, Comets, McpPackets, satAlt } from "./Links";
import { RunOrbit } from "./Runs";

/** the kit MCP crystal in this theme's palette */
const MCP_STYLE = { tint: "#93c5fd", tintAmt: 0.15, size: 0.8, lift: satAlt };

const Background = (
  <>
    <fog attach="fog" args={["#03050b", 70, 170]} />
    <Stars radius={130} depth={50} count={reduced ? 1500 : 5000} factor={3.4} saturation={0.4} fade speed={reduced ? 0 : 0.2} />
  </>
);

export default function Scene() {
  return (
    <KitScene
      title="orbit · planetary system"
      subtitle="agents orbit at the centre · each Hatchet run is an orbit · agents are born, work and implode · MCP stations on the rim · knowledge-graph galaxy on the side"
      preset="radial"
      plane="xz"
      camera={{ position: [0, 25, 21], fov: 50 }}
      controls={{ maxPolarAngle: Math.PI * 0.42 }}
      bg="#03050b"
      fit={{ nRef: 4, min: 0.62, max: 1.6, minRadius: 5.5 }}
      agentRadius={0.85}
      graph={{ natural: GALAXY_R, radius: 2.6 }}
      peripheryGap={3.8}
      Background={Background}
      Agent={Orb}
      RunMarker={RunOrbit}
      mcpStyle={MCP_STYLE}
      GraphResource={GalaxyCore}
      cluster={{ radius: 1.35, variant: "stars" }}
      clusterOffset={[0, 1.2, 0]}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.3} luminanceThreshold={0.2} luminanceSmoothing={0.25} radius={0.78} />
          <Vignette eskil={false} offset={0.25} darkness={0.85} />
          <Noise opacity={0.025} />
        </EffectComposer>
      }
    >
      <Beams />
      <Comets />
      <McpPackets />
    </KitScene>
  );
}
