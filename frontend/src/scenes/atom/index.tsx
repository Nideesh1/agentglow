/**
 * /atom - "Atom" (scene-kit theme, preset: radial on the xy plane).
 * Each run is an atom: its NUCLEUS is the run / orchestrator hub and its agents are the electrons orbiting it on
 * tilted shells (subagents circle their own home like a mini-atom, joined to their parent by a directional field
 * line); LLM calls emit photons sized by tokens; MCP servers are outer particle detectors with backend sensor
 * modules; data flows as particle beams; exits decay into fading trails. The knowledge graph is a small molecule
 * on the side (only when the session has a graph).
 */
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useMemo } from "react";
import * as THREE from "three";
import { KitScene, fit, kit } from "../shared/kit";
import { Beams } from "./Detectors";
import { Electron, Messages, Photons } from "./Electrons";
import { MOL_R, hubs, lineMat, runTops } from "./fx";
import { RunAtom } from "./Hub";
import { Molecule } from "./Molecule";

/** the kit MCP crystal in this theme's palette */
const MCP_STYLE = { tint: "#3db8ff", tintAmt: 0.25, gain: 0.9, halo: 0.8, size: 0.85 };

/** Faint polar reference grid behind the atoms (a plotting-plate feel): rings, ticks and radial guides. */
function Plate() {
  const geo = useMemo(() => {
    const v: number[] = [];
    const seg = (a: number[], b: number[]) => v.push(...a, ...b);
    for (const r of [4, 8, 12, 16, 20, 24]) {
      const n = 160;
      for (let i = 0; i < n; i++) {
        if (r > 4 && i % 4 === 3) continue; // dashed outer rings
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 1) / n) * Math.PI * 2;
        seg([Math.cos(a0) * r, Math.sin(a0) * r, 0], [Math.cos(a1) * r, Math.sin(a1) * r, 0]);
      }
    }
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const r0 = 24;
      const r1 = i % 6 === 0 ? 25.2 : 24.5;
      seg([Math.cos(a) * r0, Math.sin(a) * r0, 0], [Math.cos(a) * r1, Math.sin(a) * r1, 0]);
      if (i % 6 === 0) seg([Math.cos(a) * 3, Math.sin(a) * 3, 0], [Math.cos(a) * 24, Math.sin(a) * 24, 0]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
    return g;
  }, []);
  const mat = useMemo(() => lineMat(new THREE.Color("#3db8ff").multiplyScalar(0.075)), []);
  return <lineSegments geometry={geo} material={mat} position={[0, 0, -9]} />;
}

const _p = new THREE.Vector3();
/** keep each run's nucleus (it may sit above the agents) and the run label above the atom in view */
function extents(visit: (p: THREE.Vector3, r: number) => void) {
  for (const r of kit.runs.values()) {
    const h = hubs.get(r.id);
    if (h) visit(h, 0.8 * Math.max(0.6, fit.scale));
    const t = runTops.get(r.id);
    if (t) visit(_p.set(t.x, t.y + 0.5, t.z), 1.2);
  }
}

export default function Scene() {
  return (
    <KitScene
      title="atom · agent orbitals"
      subtitle="Each run is an atom: the nucleus is the run hub, agents are electrons on its shells, subagents orbit their parent · LLM calls emit photons sized by tokens · ◎ MCP detectors with backend sensors · graph = molecule on the side · exit = decay"
      className="atom-root"
      preset="radial"
      plane="xy"
      camera={{ position: [0, 3.5, 36], fov: 46 }}
      bg="#02040c"
      gl={{ antialias: true }}
      fit={{ nRef: 4, min: 0.62, max: 1.6, minRadius: 5.5 }}
      agentRadius={0.75}
      graph={{ natural: MOL_R * 1.15, radius: 2.3 }}
      peripheryGap={3.8}
      Background={<Plate />}
      Agent={Electron}
      RunMarker={RunAtom}
      mcpStyle={MCP_STYLE}
      GraphResource={Molecule}
      cluster={{ radius: 1.3, variant: "orb" }}
      extents={extents}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.05} luminanceThreshold={0.22} luminanceSmoothing={0.25} radius={0.7} />
          <Vignette eskil={false} offset={0.25} darkness={0.85} />
        </EffectComposer>
      }
    >
      <Photons />
      <Messages />
      <Beams />
    </KitScene>
  );
}
