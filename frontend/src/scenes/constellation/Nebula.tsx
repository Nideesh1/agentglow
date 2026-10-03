/**
 * The knowledge graph is a small distant spiral nebula on the side (scene-kit GraphResource, drawn in its own frame
 * centred at 0; the kit places, scales and fades it, only when the session has a graph): graph entities are its stars (colored by kind), relations
 * are thin filaments. A read makes the node flare in the reader's tint and a thin beam carries a spark from the
 * node to the agent star; a write flares the node white, pops a ripple ring and sends the spark agent → node.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { nodeIndex } from "../shared/useSceneSetup";
import { graphView, placeDynamic } from "../shared/graphDyn";
import { agentLive, GraphStageSpace, graphToStage, kit, type GraphSlotProps } from "../shared/kit";
import { KIND_COLOR, hash01, world } from "../shared/world";
import { ArrowPool, CurvePool, ICE, NEBULA_RX, NEBULA_RY, STAR_C, SparkPool, WHITE, bezier, bow, clamp01, reduced, ringTexture, spriteMat } from "./fx";

const MAX_NODES = 260;
const MAX_BEAMS = 40;
const MAX_RIPPLES = 8;
const MAX_NAMES = 4;
const TINT = new THREE.Color("#9db4ff");

const gasVert = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const gasFrag = /* glsl */ `
uniform float uTime; uniform float uAct; varying vec2 vUv;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++){ s += a*n(p); p = p*2.02 + 3.1; a *= 0.5; } return s; }
void main(){
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  float ang = atan(p.y, p.x);
  // spiral-swirl the noise domain
  float sw = ang + r * 2.6 - uTime * 0.012;
  vec2 q = vec2(cos(sw), sin(sw)) * r * 2.4;
  float f = fbm(q + fbm(q * 1.3 + 4.0) * 1.2);
  float arms = 0.55 + 0.45 * cos(2.0 * (ang - r * 3.2 + uTime * 0.006));
  float mask = smoothstep(1.0, 0.15, r);
  float core = exp(-r * r * 9.0);
  vec3 deep = vec3(0.10, 0.06, 0.32);
  vec3 blue = vec3(0.07, 0.18, 0.45);
  vec3 teal = vec3(0.05, 0.30, 0.42);
  vec3 rose = vec3(0.35, 0.10, 0.36);
  vec3 col = mix(deep, blue, smoothstep(0.35, 0.75, f));
  col = mix(col, teal, smoothstep(0.62, 0.9, fbm(q * 0.7 + 9.0)) * 0.6);
  col = mix(col, rose, smoothstep(0.55, 0.85, fbm(q * 0.9 - 5.0)) * 0.35);
  float dens = pow(f, 1.6) * arms * mask;
  vec3 c = col * dens * (2.0 + uAct * 0.9) + vec3(0.55, 0.6, 0.95) * core * 0.5;
  gl_FragColor = vec4(c, 1.0);
}`;

const nodeVert = /* glsl */ `
attribute float aSize; attribute vec3 aColor; uniform float uScale; varying vec3 vC;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vC = aColor; gl_PointSize = aSize * uScale / -mv.z; gl_Position = projectionMatrix * mv; }`;
const nodeFrag = /* glsl */ `
varying vec3 vC;
void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
  float core = smoothstep(0.4, 0.0, r); float halo = pow(1.0 - r, 2.4);
  gl_FragColor = vec4(vC * (core * 1.25 + halo * 0.4), 1.0); }`;

export function Nebula({ galaxy: full }: GraphSlotProps) {
  // the sample (first MAX_NODES) + the dynamic nodes events touched outside it (graphDyn.ts)
  const galaxy = useMemo(() => graphView(full, MAX_NODES), [full]);
  const n = galaxy.nodes.length;
  const { size, gl, camera } = useThree();
  const nameRefs = useRef<(Label3DHandle | null)[]>([]);
  const nameGroups = useRef<(THREE.Group | null)[]>([]);
  const nameShown = useRef<string[]>(Array(MAX_NAMES).fill(""));
  const ripples = useRef<(THREE.Sprite | null)[]>([]);

  const data = useMemo(() => {
    const pos = new Float32Array(n * 3);
    const tilt = -0.18;
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    galaxy.nodes.forEach((nd, i) => {
      const h1 = hash01(nd.id, 1);
      let x: number;
      let y: number;
      if (h1 < 0.22) {
        // central bulge
        const r = 0.22 * Math.sqrt(-2 * Math.log(1 - hash01(nd.id, 2) * 0.95)) * 0.6;
        const th = hash01(nd.id, 3) * Math.PI * 2;
        x = Math.cos(th) * r * NEBULA_RX;
        y = Math.sin(th) * r * NEBULA_RY;
      } else {
        // two loose arms, scatter widening outward
        const a = h1 < 0.61 ? 0 : Math.PI;
        const r = 0.12 + 0.88 * Math.sqrt(hash01(nd.id, 2));
        const th = a + r * 3.1 + (hash01(nd.id, 3) - 0.5) * (0.6 + r * 0.7);
        const sc = 1 + (hash01(nd.id, 7) - 0.5) * 0.35;
        x = Math.cos(th) * r * NEBULA_RX * 0.95 * sc;
        y = Math.sin(th) * r * NEBULA_RY * 0.95 * sc;
      }
      pos.set([x * ct - y * st, x * st + y * ct, (hash01(nd.id, 4) - 0.5) * 4], i * 3);
    });
    // dynamic nodes bud off their anchor (hashed offset: same spot for every viewer)
    placeDynamic(galaxy, pos, NEBULA_RX * 0.12);
    const base = galaxy.nodes.map((nd) => new THREE.Color(KIND_COLOR[nd.kind] ?? "#94a3b8").lerp(TINT, 0.45).multiplyScalar(1));
    const baseSize = galaxy.nodes.map((nd) => 0.42 + Math.pow(hash01(nd.id, 5), 4) * 0.55);
    const ngeo = new THREE.BufferGeometry();
    ngeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    ngeo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(n), 1));
    ngeo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    // filaments: graph links between reasonably close nodes
    const idOf = new Map(galaxy.nodes.map((nd, i) => [nd.id, i]));
    const pairs: number[] = [];
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    for (const l of galaxy.links) {
      const a = idOf.get(l.source);
      const b = idOf.get(l.target);
      if (a === undefined || b === undefined || a === b) continue;
      va.fromArray(pos, a * 3);
      vb.fromArray(pos, b * 3);
      if (va.distanceTo(vb) < 3.2) pairs.push(a, b);
    }
    const lpos = new Float32Array(pairs.length * 3);
    pairs.forEach((i, k) => lpos.set([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], k * 3));
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute("position", new THREE.BufferAttribute(lpos, 3));
    lgeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pairs.length * 3), 3));
    return { pos, base, baseSize, ngeo, lgeo, owner: Int32Array.from(pairs), fire: new Float32Array(n), white: new Float32Array(n), fireC: Array.from({ length: n }, () => new THREE.Color()), phase: galaxy.nodes.map((nd) => hash01(nd.id, 6) * 6.283) };
  }, [galaxy, n]);

  const mats = useMemo(
    () => ({
      gas: new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uAct: { value: 0 } }, vertexShader: gasVert, fragmentShader: gasFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      nodes: new THREE.ShaderMaterial({ uniforms: { uScale: { value: 400 } }, vertexShader: nodeVert, fragmentShader: nodeFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      fil: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      ripples: Array.from({ length: MAX_RIPPLES }, () => spriteMat(ringTexture(), "#000")),
    }),
    [],
  );
  const beams = useMemo(() => new CurvePool(MAX_BEAMS, 24), []);
  const arrows = useMemo(() => new ArrowPool(MAX_BEAMS), []);
  const sparks = useMemo(() => new SparkPool(MAX_BEAMS), []);
  const cache = useMemo(() => new Map<string, number>(), [galaxy]); // eslint-disable-line react-hooks/exhaustive-deps
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), w: new THREE.Vector3(), ctrl: new THREE.Vector3(), h: new THREE.Vector3(), c: new THREE.Color(), act: 0 }), []);
  const idx = (name: string) => {
    let i = cache.get(name);
    if (i === undefined) cache.set(name, (i = nodeIndex(galaxy, name)));
    return i;
  };

  useFrame(({ clock }) => {
    const now = performance.now();
    const gs = Math.max(1e-4, kit.graph.scale);
    const time = reduced ? 0 : clock.elapsedTime;
    const fov = (camera as THREE.PerspectiveCamera).fov;
    const dpr = gl.getPixelRatio();
    mats.nodes.uniforms.uScale.value = (size.height * dpr) / (2 * Math.tan((fov * Math.PI) / 360)) * kit.graph.scale * 2.1; // view-space point sprites follow the side graph's scale (x2.1: still read as stars when small)
    sparks.setScale(size.height, dpr, fov);
    const { pos, base, baseSize, fire, white, fireC, phase } = data;
    const { v, w, ctrl, h, c } = tmp;
    fire.fill(0);
    white.fill(0);
    beams.begin();
    arrows.begin();
    sparks.begin();
    let rp = 0;
    let act = 0;
    for (const f of world.flares) {
      const i = idx(f.node);
      const age = (now - f.start) / 1000;
      const inst = world.instances.get(f.instance);
      const tc = inst ? STAR_C[inst.type] : ICE;
      const isW = f.op === "write";
      const k = age < 0.3 ? age / 0.3 : Math.exp(-(age - 0.3) * 1.1);
      act = Math.max(act, k);
      if (k > fire[i]) {
        fire[i] = k;
        fireC[i].copy(isW ? WHITE : tc);
        white[i] = isW ? 1 : 0;
      }
      v.fromArray(pos, i * 3);
      if (isW && age < 1.6 && rp < MAX_RIPPLES) {
        const sp = ripples.current[rp];
        if (sp) {
          const u = age / 1.6;
          sp.visible = true;
          sp.position.copy(v);
          sp.scale.setScalar(0.4 + u * 3.2);
          mats.ripples[rp].color.setScalar((1 - u) * (1 - u) * 0.9);
        }
        rp++;
      }
      // beam: curve runs agent (t=0) → node (t=1); read sparks flow node → agent, write sparks agent → node
      const sp = agentLive(f.instance);
      if (sp && age < 2.0) {
        graphToStage(v, w); // beams live on stage (inverse group below), the node end follows the side graph
        bow(sp, w, 1.2, 2.5, ctrl);
        const fade = Math.min(1, age / 0.25) * Math.pow(1 - age / 2.0, 1.5);
        const head = isW ? Math.min(1, age * 0.9) : 1 - Math.min(1, age * 0.9);
        c.copy(isW ? WHITE : tc).lerp(WHITE, 0.2);
        beams.add(sp, ctrl, w, c, (isW ? 0.55 : 0.4) * fade, 0.04, 0.99, 0, 1, time, head, 1.9 * fade);
        if (head > 0.02 && head < 0.98) {
          bezier(sp, ctrl, w, head, h);
          sparks.add(h, 0.7, c, 1.6 * fade);
        }
        if (isW) arrows.add(sp, ctrl, w, 0.95, 1, 0.4, WHITE, fade * 1.2);
        else arrows.add(sp, ctrl, w, 0.07, -1, 0.4, c, fade * 1.5);
      }
    }
    for (let z = rp; z < MAX_RIPPLES; z++) {
      const sp = ripples.current[z];
      if (sp) sp.visible = false;
    }
    beams.end();
    arrows.end();
    sparks.end();
    tmp.act += (act - tmp.act) * 0.05;
    mats.gas.uniforms.uTime.value = time;
    mats.gas.uniforms.uAct.value = tmp.act;

    const sz = data.ngeo.getAttribute("aSize") as THREE.BufferAttribute;
    const nc = data.ngeo.getAttribute("aColor") as THREE.BufferAttribute;
    for (let i = 0; i < n; i++) {
      const f = fire[i];
      const tw = reduced ? 1 : 0.85 + 0.15 * Math.sin(time * 0.9 + phase[i]);
      sz.setX(i, baseSize[i] + f * (0.9 + white[i] * 0.5));
      c.copy(base[i]).multiplyScalar(tw);
      if (f > 0.01) {
        c.r += fireC[i].r * f * 1.5 + f * (0.25 + white[i]);
        c.g += fireC[i].g * f * 1.5 + f * (0.25 + white[i]);
        c.b += fireC[i].b * f * 1.5 + f * (0.25 + white[i]);
      }
      nc.setXYZ(i, c.r, c.g, c.b);
    }
    sz.needsUpdate = true;
    nc.needsUpdate = true;

    const lc = data.lgeo.getAttribute("color") as THREE.BufferAttribute;
    const own = data.owner;
    for (let vi = 0; vi < own.length; vi++) {
      const f = Math.max(fire[own[vi]], fire[own[vi ^ 1]]);
      lc.setXYZ(vi, 0.11 + f * 0.45, 0.13 + f * 0.5, 0.3 + f * 0.6);
    }
    lc.needsUpdate = true;

    // name the most recently touched entities (skip duplicates / overlaps)
    let shown = 0;
    for (let q = world.flares.length - 1; q >= 0 && shown < MAX_NAMES; q--) {
      const f = world.flares[q];
      if (now - f.start > 2200) break;
      if (f.area) continue;
      let skip = false;
      for (let z = 0; z < shown; z++) if (nameShown.current[z] === f.node) skip = true;
      if (skip) continue;
      const i = idx(f.node);
      for (let z = 0; z < shown; z++) {
        const g0 = nameGroups.current[z];
        // labels are px-clamped: keep them apart in stage units (local = stage / graph scale)
        if (g0 && Math.abs(g0.position.y - pos[i * 3 + 1]) < 0.9 / gs && Math.abs(g0.position.x - pos[i * 3]) < 4.5 / gs) skip = true;
      }
      if (skip) continue;
      const el = nameRefs.current[shown];
      const ng = nameGroups.current[shown];
      if (el && ng) {
        ng.position.fromArray(pos, i * 3);
        if (nameShown.current[shown] !== f.node) {
          el.setText(`${f.op === "write" ? "wrote" : "read"} · ${f.node}`);
          el.setColor(f.op === "write" ? "#ffffff" : "#9db4ff");
        }
        el.setOpacity(clamp01(1.4 - (now - f.start) / 1600));
      }
      nameShown.current[shown] = f.node;
      shown++;
    }
    for (let z = shown; z < MAX_NAMES; z++) {
      const el = nameRefs.current[z];
      el?.setOpacity(0);
      nameShown.current[z] = "";
    }
  });

  const tilt = -0.18;
  return (
    <>
      <mesh material={mats.gas} position={[0, 0, -1]} rotation={[0, 0, tilt]} renderOrder={-5}>
        <planeGeometry args={[NEBULA_RX * 2.6, NEBULA_RY * 2.9]} />
      </mesh>
      <lineSegments geometry={data.lgeo} material={mats.fil} frustumCulled={false} />
      <points geometry={data.ngeo} material={mats.nodes} frustumCulled={false} />
      {mats.ripples.map((m, k) => (
        <sprite key={k} ref={(x) => void (ripples.current[k] = x)} material={m} visible={false} />
      ))}
      {/* stage space (the side-graph transform undone): beams/sparks/arrows keep their stage size */}
      <GraphStageSpace>
        <primitive object={beams.obj} />
        <primitive object={arrows.mesh} />
        <primitive object={sparks.obj} />
      </GraphStageSpace>
      {Array.from({ length: MAX_NAMES }, (_, k) => (
        <group key={k} ref={(x) => void (nameGroups.current[k] = x)}>
          <Label3D ref={(x) => void (nameRefs.current[k] = x)} text="" offset={[0, 0.4]} size={0.24} opacity={0} fadeMs={250} pxRange={[8, 12]} />
        </group>
      ))}
      <GraphLabel3D position={[0, NEBULA_RY * 1.15, 0]} suffix=" · nebula" color="#8b9cff" letterSpacing={0.04} size={0.28} opacity={0.85} pxRange={[8, 12]} />
    </>
  );
}
