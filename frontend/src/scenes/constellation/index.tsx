/**
 * /constellation - "Night sky" (scene-kit theme, preset: radial).
 * Agents are stars at the centre of the sky (parents brighter/bigger), delegation draws constellation lines
 * parent -> child, LLM calls make a star flare (sized by tokens), MCP servers are planets on the outskirts with their
 * backends as moons, the knowledge graph is a small distant nebula on the side (only when the session has a graph)
 * whose stars light on reads/writes, a final answer is a shooting star, and exiting agents collapse to a faint
 * remnant before fading out.
 */
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { KitScene } from "../shared/kit";
import { NEBULA_RX } from "./fx";
import { Nebula } from "./Nebula";
import { Tethers } from "./Planets";
import { RunGlow, ShootingStars } from "./Runs";
import { Sky } from "./Sky";
import { Lines, Star } from "./Stars";

/** the kit MCP crystal in this theme's palette */
const MCP_STYLE = { tint: "#c7d2fe", tintAmt: 0.15 };

const CONTROLS = {
  minPolarAngle: Math.PI * 0.22,
  maxPolarAngle: Math.PI * 0.78,
  minAzimuthAngle: -Math.PI * 0.35,
  maxAzimuthAngle: Math.PI * 0.35,
};

export default function Scene() {
  return (
    <KitScene
      title="constellation · night sky"
      subtitle="Agents are stars (brighter = parent) · delegation draws constellation lines · stars flare on LLM calls · ◉ MCP planets with backend moons · the graph nebula lights on reads/writes · ✦ final answer = shooting star"
      preset="radial"
      plane="xy"
      camera={{ position: [0, 0, 34], fov: 46, far: 1200 }}
      controls={CONTROLS}
      bg="#040618"
      gl={{ antialias: true }}
      fit={{ nRef: 4, min: 0.62, max: 1.6, minRadius: 5.5 }}
      agentRadius={1.3}
      graph={{ natural: NEBULA_RX * 1.1, radius: 3.6 }}
      Background={<Sky />}
      Agent={Star}
      RunMarker={RunGlow}
      mcpStyle={MCP_STYLE}
      GraphResource={Nebula}
      cluster={{ radius: 1.5, variant: "stars", glowGain: 0.9 }}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={0.95} luminanceThreshold={0.22} luminanceSmoothing={0.35} radius={0.7} />
          <Vignette eskil={false} offset={0.25} darkness={0.75} />
        </EffectComposer>
      }
    >
      <Lines />
      <Tethers />
      <ShootingStars />
    </KitScene>
  );
}
