/**
 * /fireworks - "Fireworks in the night sky" (scene-kit theme, custom "show" preset on the xy plane).
 * Every top-level agent streaks in across the open sky as a shooting star and bursts into a star shell where the kit
 * puts it (subagents are secondary shells thrown off their parent's burst, branching upward); shells hang and sparkle
 * while the agent lives, crackle on LLM calls (by tokens) and when busy (decision halos), spit comets on tool
 * calls, pop a red salute on a deny, pull in to a pulsing ember while waiting and fall away as a willow when done.
 * MCP servers are faceted crystals hanging free in the sky with their backends as satellites on tilted orbits; the knowledge graph is a drift of
 * embers at the side (only when the session has a graph); a final answer is a gold crossette finale.
 * All sparks are one GPU ring buffer (Sky.tsx SparkField). No ground or water: an open starry sky all the way round.
 */
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { KitScene } from "../shared/kit";
import { Embers } from "./Embers";
import { BUDGET, EMBER_RX, KIND_GLITTER, KIND_SPARK, pyro, show } from "./fx";
import type { CrystalStyle } from "../shared/kit";

/** the kit crystals throw their sparks into the show's spark field */
const MCP_STYLE: Partial<CrystalStyle> = {
  emit: (p, v, c) => {
    if (Math.random() > BUDGET) return;
    pyro().emit(p.x, p.y, p.z, v.x, v.y, v.z, 2.4, 2.2, 0.4 + Math.random() * 0.35, 0.06, c, 1, Math.random() < 0.3 ? KIND_GLITTER : KIND_SPARK);
  },
};
import { Trails } from "./Ground";
import { Finale, RunSite } from "./Runs";
import { Branches, Shell } from "./Shells";
import { Backdrop, SparkField } from "./Sky";

// full 360 orbit round the vertical axis (the star field turns with the camera); a moderate polar range keeps the
// shells (laid out on a vertical plane) readable from above and below
const CONTROLS = {
  minPolarAngle: Math.PI * 0.3,
  maxPolarAngle: Math.PI * 0.68,
};

export default function Scene() {
  return (
    <KitScene
      title="fireworks · night show"
      subtitle="Each agent streaks in as a shooting star and bursts into a star shell (subagents = secondary bursts) · shells crackle on LLM calls · ✦ comets on tool calls · red salute = deny · ember = waiting · willow = done · ◆ MCP crystals with orbiting backend satellites · graph = embers"
      preset={show}
      plane="xy"
      camera={{ position: [0, 0, 34], fov: 46, far: 1200 }}
      controls={CONTROLS}
      bg="#03040d"
      gl={{ antialias: true }}
      fit={{ nRef: 4, min: 0.62, max: 1.6, minRadius: 5.5 }}
      agentRadius={1.7}
      graph={{ natural: EMBER_RX * 1.1, radius: 3.4 }}
      Background={<Backdrop />}
      Agent={Shell}
      RunMarker={RunSite}
      mcpStyle={MCP_STYLE}
      GraphResource={Embers}
      cluster={{ radius: 1.5, variant: "stars", glowGain: 0.9 }}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={0.85} luminanceThreshold={0.3} luminanceSmoothing={0.3} radius={0.65} />
          <Vignette eskil={false} offset={0.35} darkness={0.5} />
        </EffectComposer>
      }
    >
      <Branches />
      <Trails />
      <Finale />
      <SparkField />
    </KitScene>
  );
}
