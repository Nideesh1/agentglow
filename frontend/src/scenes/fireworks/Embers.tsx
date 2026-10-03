/**
 * The knowledge graph is a drift of embers hanging in the sky at the side (scene-kit GraphResource, drawn in its own
 * frame centred at 0; the kit places, scales and fades it, only when the session has a graph): entities are warm
 * embers tinted by kind, relations are faint smoke threads between near ones (a constellation of embers). A read
 * flares the ember in the reader's color and a thread of light carries a spark node -> shell; a write flares it
 * white, pops a ring and sends the spark shell -> node.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { nodeIndex } from "../shared/useSceneSetup";
import { graphView, placeDynamic } from "../shared/graphDyn";
import { agentLive, GraphStageSpace, graphToStage, kit, type GraphSlotProps } from "../shared/kit";
import { KIND_COLOR, hash01, world } from "../shared/world";
import { CurvePool, EMBER, EMBER_RX, EMBER_RY, GOLD, HeadPool, SHELL_C, WHITE, bezier, bow, clamp01, glowTexture, pointScale, reduced, ringTexture, spriteMat } from "./fx";

const MAX_NODES = 220;
const MAX_BEAMS = 40;
const MAX_RIPPLES = 8;
const MAX_NAMES = 4;

const nodeVert = /* glsl */ `
attribute float aSize; attribute vec3 aColor; uniform float uScale; varying vec3 vC;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vC = aColor; float px = aSize * uScale / -mv.z;
  if (px < 1.6) { vC *= px / 1.6; px = 1.6; } gl_PointSize = px; gl_Position = projectionMatrix * mv; }`;
const nodeFrag = /* glsl */ `
varying vec3 vC;
void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
  gl_FragColor = vec4(vC * (smoothstep(0.4, 0.0, r) * 1.2 + pow(1.0 - r, 2.4) * 0.4), 1.0); }`;

export function Embers({ galaxy: full }: GraphSlotProps) {
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
    galaxy.nodes.forEach((nd, i) => {
      // a loose drifting cloud, denser in the middle, a little wider than tall
      const r = Math.sqrt(hash01(nd.id, 2)) * 0.95;
      const th = hash01(nd.id, 3) * Math.PI * 2;
      pos.set([Math.cos(th) * r * EMBER_RX, Math.sin(th) * r * EMBER_RY, (hash01(nd.id, 4) - 0.5) * 2], i * 3);
    });
    // dynamic nodes bud off their anchor (hashed offset: same spot for every viewer)
    placeDynamic(galaxy, pos, EMBER_RX * 0.12);
    const base = galaxy.nodes.map((nd) => new THREE.Color(KIND_COLOR[nd.kind] ?? "#94a3b8").lerp(EMBER, 0.55).multiplyScalar(0.55));
    const baseSize = galaxy.nodes.map((nd) => 0.32 + Math.pow(hash01(nd.id, 5), 4) * 0.45);
    const ngeo = new THREE.BufferGeometry();
    ngeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    ngeo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(n), 1));
    ngeo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
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
      if (va.distanceTo(vb) < 3.4) pairs.push(a, b);
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
      haze: spriteMat(glowTexture(), "#000"),
      nodes: new THREE.ShaderMaterial({ uniforms: { uScale: { value: 400 } }, vertexShader: nodeVert, fragmentShader: nodeFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      fil: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      ripples: Array.from({ length: MAX_RIPPLES }, () => spriteMat(ringTexture(), "#000")),
    }),
    [],
  );
  const beams = useMemo(() => new CurvePool(MAX_BEAMS, 24), []);
  const heads = useMemo(() => new HeadPool(MAX_BEAMS), []);
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
    mats.nodes.uniforms.uScale.value = pointScale(size.height, dpr, fov) * kit.graph.scale * 1.8;
    heads.setScale(size.height, dpr, fov);
    const { pos, base, baseSize, fire, white, fireC, phase } = data;
    const { v, w, ctrl, h, c } = tmp;
    fire.fill(0);
    white.fill(0);
    beams.begin();
    heads.begin();
    let rp = 0;
    let act = 0;
    for (const f of world.flares) {
      const i = idx(f.node);
      const age = (now - f.start) / 1000;
      const inst = world.instances.get(f.instance);
      const tc = inst ? SHELL_C[inst.type] : GOLD;
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
          sp.scale.setScalar(0.4 + u * 3);
          mats.ripples[rp].color.copy(GOLD).multiplyScalar((1 - u) * (1 - u) * 0.9);
        }
        rp++;
      }
      const sp = agentLive(f.instance);
      if (sp && age < 2.0) {
        graphToStage(v, w);
        bow(sp, w, 1.0, 1.4, ctrl);
        const fade = Math.min(1, age / 0.25) * Math.pow(1 - age / 2.0, 1.5);
        const head = isW ? Math.min(1, age * 0.9) : 1 - Math.min(1, age * 0.9);
        c.copy(isW ? WHITE : tc).lerp(GOLD, 0.25);
        beams.add(sp, ctrl, w, c, (isW ? 0.4 : 0.3) * fade, 0.05, 0.99, 0, time, head, 1.7 * fade);
        if (head > 0.02 && head < 0.98) {
          bezier(sp, ctrl, w, head, h);
          heads.add(h, 0.6, c, 1.5 * fade);
        }
      }
    }
    for (let z = rp; z < MAX_RIPPLES; z++) {
      const sp = ripples.current[z];
      if (sp) sp.visible = false;
    }
    beams.end();
    heads.end();
    tmp.act += (act - tmp.act) * 0.05;
    mats.haze.color.copy(EMBER).multiplyScalar(0.05 + tmp.act * 0.05);

    const sz = data.ngeo.getAttribute("aSize") as THREE.BufferAttribute;
    const nc = data.ngeo.getAttribute("aColor") as THREE.BufferAttribute;
    for (let i = 0; i < n; i++) {
      const f = fire[i];
      // embers breathe: slow, out-of-step glow
      const tw = reduced ? 1 : 0.7 + 0.3 * Math.sin(time * (0.7 + (phase[i] % 1)) + phase[i]);
      sz.setX(i, baseSize[i] + f * (0.8 + white[i] * 0.4));
      c.copy(base[i]).multiplyScalar(tw);
      if (f > 0.01) {
        c.r += fireC[i].r * f * 1.4 + f * (0.2 + white[i]);
        c.g += fireC[i].g * f * 1.4 + f * (0.2 + white[i]);
        c.b += fireC[i].b * f * 1.4 + f * (0.2 + white[i]);
      }
      nc.setXYZ(i, c.r, c.g, c.b);
    }
    sz.needsUpdate = true;
    nc.needsUpdate = true;
    const lc = data.lgeo.getAttribute("color") as THREE.BufferAttribute;
    const own = data.owner;
    for (let vi = 0; vi < own.length; vi++) {
      const f = Math.max(fire[own[vi]], fire[own[vi ^ 1]]);
      lc.setXYZ(vi, 0.2 + f * 0.6, 0.11 + f * 0.45, 0.07 + f * 0.25);
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
        if (g0 && Math.abs(g0.position.y - pos[i * 3 + 1]) < 0.9 / gs && Math.abs(g0.position.x - pos[i * 3]) < 4.5 / gs) skip = true;
      }
      if (skip) continue;
      const el = nameRefs.current[shown];
      const ng = nameGroups.current[shown];
      if (el && ng) {
        ng.position.fromArray(pos, i * 3);
        if (nameShown.current[shown] !== f.node) {
          el.setText(`${f.op === "write" ? "wrote" : "read"} · ${f.node}`);
          el.setColor(f.op === "write" ? "#ffffff" : "#ffc46b");
        }
        el.setOpacity(clamp01(1.4 - (now - f.start) / 1600));
      }
      nameShown.current[shown] = f.node;
      shown++;
    }
    for (let z = shown; z < MAX_NAMES; z++) {
      nameRefs.current[z]?.setOpacity(0);
      nameShown.current[z] = "";
    }
  });

  return (
    <>
      <sprite material={mats.haze} scale={[EMBER_RX * 3.2, EMBER_RY * 3.2, 1]} position={[0, 0, -0.5]} />
      <lineSegments geometry={data.lgeo} material={mats.fil} frustumCulled={false} />
      <points geometry={data.ngeo} material={mats.nodes} frustumCulled={false} />
      {mats.ripples.map((m, k) => (
        <sprite key={k} ref={(x) => void (ripples.current[k] = x)} material={m} visible={false} />
      ))}
      <GraphStageSpace>
        <primitive object={beams.obj} />
        <primitive object={heads.obj} />
      </GraphStageSpace>
      {Array.from({ length: MAX_NAMES }, (_, k) => (
        <group key={k} ref={(x) => void (nameGroups.current[k] = x)}>
          <Label3D ref={(x) => void (nameRefs.current[k] = x)} text="" offset={[0, 0.4]} size={0.24} opacity={0} fadeMs={250} pxRange={[8, 12]} />
        </group>
      ))}
      <GraphLabel3D position={[0, EMBER_RY * 1.18, 0]} suffix=" · embers" color="#ffb066" letterSpacing={0.04} size={0.28} opacity={0.85} pxRange={[8, 12]} />
    </>
  );
}
