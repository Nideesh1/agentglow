/**
 * <ClusterBall> - one collapsed lane of runs (see lod.ts): a soft glowing core wrapped in a swarm of points,
 * one point per collapsed agent (colored by role, thinking ones brighter), breathing with the lane's activity,
 * plus a single clickable count badge ("32 runs · 96 agents"). Clicking expands that lane.
 *
 * <ClusterBalls position={(lane, out, t) => …}/> mounts one ball per lane and hides inactive ones, so a theme
 * only supplies where each lane lives. Everything animates in shaders / via refs: no per-frame allocations,
 * no React re-renders while running.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "./Label3D";
import { TYPE_COLOR, type AgentType } from "./world";
import { LOD_LANES, expandLane, lod, type LodCluster } from "./lod";
import { focusCluster } from "./kit/focus";

export type ClusterStyle = "orb" | "stars" | "swarm";

const MAX_POINTS = 220;
const TYPES: AgentType[] = ["planner", "researcher", "writer", "graph_scout", "records_scout", "data_scout"];
const TYPE_C = Object.fromEntries(TYPES.map((t) => [t, new THREE.Color(TYPE_COLOR[t])])) as Record<AgentType, THREE.Color>;

let glowTex: THREE.Texture | null = null;
function glow() {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.18, "rgba(255,255,255,0.55)");
  grd.addColorStop(0.5, "rgba(255,255,255,0.12)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

const VERT = /* glsl */ `
  attribute vec4 aSeed;   // theta, phi(cos), radius 0..1, speed
  attribute vec3 aColor;
  attribute float aBright;
  uniform float uTime, uRadius, uEnergy, uSize, uFlat, uChaos, uPix;
  varying vec3 vColor;
  varying float vA;
  void main() {
    float th = aSeed.x + uTime * aSeed.w * (0.35 + uEnergy * 0.9);
    float cp = aSeed.y;
    float sp = sqrt(max(0.0, 1.0 - cp * cp));
    float r = uRadius * (0.35 + 0.65 * aSeed.z) * (1.0 + 0.06 * sin(uTime * 1.7 + aSeed.x * 7.0) * (0.4 + uEnergy));
    vec3 p = vec3(cos(th) * sp, cp * (1.0 - uFlat), sin(th) * sp) * r;
    // swarm: drift on a lissajous so the school churns
    p += uChaos * uRadius * 0.22 * vec3(sin(uTime * 0.9 * aSeed.w + aSeed.x * 3.0), sin(uTime * 1.1 + aSeed.z * 9.0), cos(uTime * 0.7 * aSeed.w + aSeed.y * 5.0));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float tw = 0.75 + 0.25 * sin(uTime * (2.0 + aSeed.w * 3.0) + aSeed.x * 11.0);
    gl_PointSize = uSize * uPix * (0.7 + 0.6 * aSeed.z) * (1.0 + aBright * 0.6) * tw / max(0.5, -mv.z);
    vColor = aColor * (0.55 + aBright * 0.9 + uEnergy * 0.5);
    vA = tw;
  }
`;
const FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vA;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    float a = smoothstep(0.5, 0.0, r);
    a *= a;
    gl_FragColor = vec4(vColor * a * vA * uOpacity, 1.0);
  }
`;

function makeSwarm() {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(MAX_POINTS * 3); // unused (positions come from aSeed), required by three
  const seed = new Float32Array(MAX_POINTS * 4);
  for (let k = 0; k < MAX_POINTS; k++) {
    // golden-angle spiral so even small counts spread evenly
    seed[k * 4] = k * 2.39996 + Math.random() * 0.3;
    seed[k * 4 + 1] = 1 - (2 * ((k * 0.618034) % 1));
    seed[k * 4 + 2] = Math.pow(Math.random(), 0.45);
    seed[k * 4 + 3] = (0.25 + Math.random() * 0.6) * (Math.random() < 0.5 ? -1 : 1);
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
  geo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 3), 3));
  geo.setAttribute("aBright", new THREE.BufferAttribute(new Float32Array(MAX_POINTS), 1));
  geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 50);
  return geo;
}

export type ClusterBallProps = {
  cluster: LodCluster;
  /** fixed position; or use `place` for a moving anchor */
  position?: [number, number, number];
  /** called every frame to place the ball (write into `out`) */
  place?: (lane: number, out: THREE.Vector3, t: number) => void;
  /** override the lane color */
  color?: string;
  /** base radius in world units (grows gently with agent count) */
  radius?: number;
  /** "orb" (default sphere swarm) · "stars" (flattened, twinkly globular cluster) · "swarm" (churning school) */
  variant?: ClusterStyle;
  /** point size multiplier */
  pointSize?: number;
  /** label offset below the ball (in radii) */
  labelBelow?: number;
  /** extra glow multiplier (themes with weaker bloom) */
  glowGain?: number;
  onClick?: (lane: number) => void;
};

export function ClusterBall({ cluster, position, place, color, radius = 1.4, variant = "orb", pointSize = 1, labelBelow = 1.25, glowGain = 1, onClick }: ClusterBallProps) {
  const root = useRef<THREE.Group>(null);
  const core = useRef<THREE.Sprite>(null);
  const hot = useRef<THREE.Sprite>(null);
  const halo = useRef<THREE.Sprite>(null);
  const hit = useRef<THREE.Mesh>(null);
  const labelG = useRef<THREE.Group>(null);
  const box = useRef<Label3DHandle>(null);
  const col = useMemo(() => new THREE.Color(color ?? cluster.color), [color, cluster.color]);
  const st = useMemo(() => ({ l1: "", l2: "", seen: -1, vis: 0, hover: 0, over: false, r: radius, pos: new THREE.Vector3(), c: new THREE.Color(), tokSeen: -1, thSeen: -1, fresh: true }), [radius]);
  const geo = useMemo(makeSwarm, []);
  const mats = useMemo(() => {
    const sprite = (o: number) => new THREE.SpriteMaterial({ map: glow(), color: "#000", blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, opacity: o });
    const points = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uRadius: { value: radius },
        uEnergy: { value: 0 },
        uSize: { value: 0.16 * radius * pointSize },
        uFlat: { value: variant === "stars" ? 0.55 : 0 },
        uChaos: { value: variant === "swarm" ? 1 : variant === "stars" ? 0 : 0.25 },
        uPix: { value: 1 },
        uOpacity: { value: 0 },
      },
    });
    return { core: sprite(1), hot: sprite(1), halo: sprite(1), points, hit: new THREE.MeshBasicMaterial({ visible: false }) };
  }, [radius, pointSize, variant]);

  useFrame(({ clock, gl, camera }) => {
    const c = cluster;
    const t = clock.elapsedTime;
    const want = c.active && lod.grouped ? 1 : 0;
    st.vis += (want - st.vis) * (want ? 0.06 : 0.12);
    if (st.vis < 0.003) st.vis = 0;
    const visible = st.vis > 0;
    if (root.current) root.current.visible = visible;
    if (box.current && !(visible && want)) box.current.setOpacity(0, true);
    if (!visible) {
      st.fresh = true;
      return;
    }

    if (root.current) {
      if (place) place(c.lane, st.pos, t);
      else if (position) st.pos.set(position[0], position[1], position[2]);
      // glide when the anchor moves (e.g. nudged aside by expanded runs); snap on first appearance
      if (st.fresh) root.current.position.copy(st.pos), (st.fresh = false);
      else root.current.position.lerp(st.pos, 0.06);
    }
    // size grows gently with the crowd (log), breath + pulse from activity
    const e = c.energy;
    const grow = 0.8 + 0.22 * Math.log2(1 + c.agents / 6);
    st.hover += ((st.over ? 1 : 0) - st.hover) * 0.15;
    const r = radius * Math.min(1.7, grow) * (0.6 + 0.4 * st.vis) * (1 + st.hover * 0.08);
    const beat = Math.sin(t * (1.1 + e * 2.6) + c.lane);
    const pulse = 1 + beat * (0.04 + e * 0.1);
    const u = mats.points.uniforms;
    u.uTime.value = t;
    u.uRadius.value = r;
    u.uEnergy.value = e;
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 50;
    u.uPix.value = gl.domElement.height / (2 * Math.tan((fov * Math.PI) / 360));
    u.uOpacity.value = st.vis;
    const g = glowGain * st.vis;
    if (core.current) {
      core.current.scale.setScalar(r * 2.4 * pulse);
      mats.core.color.copy(col).multiplyScalar((0.32 + e * 0.45 + st.hover * 0.2) * g);
    }
    if (hot.current) {
      hot.current.scale.setScalar(r * 0.9 * pulse);
      mats.hot.color.copy(col).lerp(WHITE, 0.55).multiplyScalar((0.35 + e * 0.6) * g);
    }
    if (halo.current) {
      halo.current.scale.setScalar(r * 5.5 * (1 + beat * 0.03));
      mats.halo.color.copy(col).multiplyScalar((0.07 + e * 0.08) * g);
    }
    hit.current?.scale.setScalar(r * 1.15);
    labelG.current?.position.set(0, -r * labelBelow - 0.35, 0);

    // composition changed → recolor the swarm + rewrite the badge (DOM writes only on change)
    if (c.version !== st.seen) {
      st.seen = c.version;
      // ~2 motes per agent (min 18 so a small cluster still reads as a swarm)
      const n = Math.min(MAX_POINTS, Math.max(18, c.agents * 2));
      const ca = geo.getAttribute("aColor") as THREE.BufferAttribute;
      const ba = geo.getAttribute("aBright") as THREE.BufferAttribute;
      let k = 0;
      const scale = c.agents ? n / c.agents : 1;
      for (const ty of TYPES) {
        const m = Math.round(c.types[ty] * scale);
        for (let j = 0; j < m && k < n; j++, k++) {
          st.c.copy(TYPE_C[ty]).lerp(col, 0.25);
          ca.setXYZ(k, st.c.r, st.c.g, st.c.b);
        }
      }
      for (; k < n; k++) ca.setXYZ(k, col.r, col.g, col.b);
      // spread "thinking" brightness evenly across the swarm
      const th = c.agents ? c.thinking / c.agents : 0;
      for (let j = 0; j < n; j++) ba.setX(j, (j * 0.618034) % 1 < th ? 1 : 0);
      ca.needsUpdate = true;
      ba.needsUpdate = true;
      geo.setDrawRange(0, n);
      st.l1 = `${c.runs} run${c.runs === 1 ? "" : "s"} · ${c.agents} agent${c.agents === 1 ? "" : "s"}`;
    }
    const tok = Math.round(c.tokens / 1000);
    if (tok !== st.tokSeen || c.thinking !== st.thSeen) {
      st.tokSeen = tok;
      st.thSeen = c.thinking;
      st.l2 = `${c.thinking} thinking · ${tok >= 1000 ? `${(tok / 1000).toFixed(1)}M` : `${tok}k`} tok`;
    }
    if (box.current) {
      box.current.setText(st.l1, st.l2);
      box.current.setEmphasis(st.over);
      if (want) box.current.setOpacity(Math.min(1, st.vis * 1.2), true);
    }
  });

  const click = (ev?: { stopPropagation?: () => void }) => {
    ev?.stopPropagation?.();
    focusCluster(cluster.lane);
    (onClick ?? expandLane)(cluster.lane);
  };
  const over = (v: boolean) => {
    st.over = v;
    document.body.style.cursor = v ? "pointer" : "";
  };
  return (
    <group ref={root} visible={false}>
      <sprite ref={halo} material={mats.halo} />
      <sprite ref={core} material={mats.core} />
      <sprite ref={hot} material={mats.hot} />
      <points geometry={geo} material={mats.points} frustumCulled={false} />
      <mesh ref={hit} material={mats.hit} onClick={click} onPointerOver={() => over(true)} onPointerOut={() => over(false)}>
        <sphereGeometry args={[1, 12, 8]} />
      </mesh>
      <group ref={labelG}>
        <Label3D
          ref={box}
          text=""
          secondary=""
          color={color ?? cluster.color}
          plate="box"
          size={0.36}
          opacity={0}
          pxRange={[10, 14]}
          renderOrder={28}
          onClick={(e) => click(e)}
          onHover={(v) => over(v)}
        />
      </group>
    </group>
  );
}
const WHITE = new THREE.Color("#ffffff");

const LANES = Array.from({ length: LOD_LANES }, (_, k) => k);

/** Lane color: one color for every lane, or a function of the lane (e.g. alternating palettes). */
export type ClusterColor = string | ((lane: number) => string);

/** One ClusterBall per lane (inactive lanes stay hidden); `place(lane, out, t)` positions each lane's ball. */
export function ClusterBalls({ place, color, ...rest }: Omit<ClusterBallProps, "cluster" | "position" | "color"> & { place: (lane: number, out: THREE.Vector3, t: number) => void; color?: ClusterColor }) {
  return (
    <>
      {LANES.map((k) => (
        <ClusterBall key={k} cluster={lod.clusters[k]} place={place} color={typeof color === "function" ? color(k) : color} {...rest} />
      ))}
    </>
  );
}
