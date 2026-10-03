/**
 * Graph resource slot (side memory node): FalkorDB = a small glass memory orb on the side of the brain, drawn in
 * its own frame (radius ORB_R) - the kit positions, scales and fades it. Graph nodes sit evenly on its surface (Fibonacci sphere),
 * edges are faint great-circle arcs hugging it. Flares: touched nodes brighten + name label + soft beam to the
 * agent (reads in agent color, writes white with a ring ripple spreading across the sphere surface).
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { KIND_COLOR, world } from "../shared/world";
import { nodeIndex } from "../shared/useSceneSetup";
import { dynDir, graphView } from "../shared/graphDyn";
import { agentLive, kit, stageToGraph, type GraphSlotProps } from "../shared/kit";
import { ArrowPool, SPHERE_GEO, TYPE_C, addScaled, glowSpriteMaterial, reduced } from "./fx";

export const ORB_R = 3.3;
const MAX_NODES = 200;
const ARC_SEG = 14;
const MAX_BEAMS = 48;
const BEAM_SEG = 16;
const MAX_RIPPLES = 8;
const MAX_NAMES = 4;
const WHITE = new THREE.Color(1, 1, 1);
const TINT = new THREE.Color("#a78bfa");

// ------------------------------------------------------------------ shaders
const pointVert = /* glsl */ `
attribute float aSize; attribute vec3 aColor; varying vec3 vC; varying float vFacing; uniform float uScale;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normalize(position));
  vFacing = 0.35 + 0.65 * smoothstep(-0.4, 0.5, dot(n, normalize(-mv.xyz)));   // back side dimmer → depth
  gl_PointSize = aSize * uScale / -mv.z; vC = aColor; gl_Position = projectionMatrix * mv; }`;
const pointFrag = /* glsl */ `
varying vec3 vC; varying float vFacing;
void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
  float core = smoothstep(0.45, 0.0, r); float halo = pow(1.0 - r, 2.2);
  gl_FragColor = vec4(vC * vFacing * (core * 1.2 + halo * 0.45), 1.0); }`;

const orbVert = /* glsl */ `
varying vec3 vN; varying vec3 vV; varying vec3 vObj;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vObj = normalize(position);
  gl_Position = projectionMatrix * mv; }`;
const orbFrag = /* glsl */ `
uniform vec3 uRim; uniform vec3 uInner; uniform float uTime;
uniform vec3 uRipC[${MAX_RIPPLES}]; uniform float uRipA[${MAX_RIPPLES}];
varying vec3 vN; varying vec3 vV; varying vec3 vObj;
void main(){
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float rim = pow(f, 3.0);
  float body = pow(1.0 - f, 2.0) * 0.12;                         // faint glassy fill toward the center
  float shimmer = 0.92 + 0.08 * sin(uTime * 0.25 + vObj.y * 3.0 + vObj.x * 2.0);
  vec3 col = uRim * rim * 1.1 * shimmer + uInner * body;
  float rip = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    float a = uRipA[i];
    if (a < 0.0 || a > 1.0) continue;
    float d = acos(clamp(dot(vObj, uRipC[i]), -1.0, 1.0));
    float ring = a * 2.2;
    rip += exp(-pow((d - ring) / 0.06, 2.0)) * (1.0 - a) * (1.0 - a);
  }
  col += vec3(1.0) * rip * 0.6;
  gl_FragColor = vec4(col, 1.0);
}`;

export function Cortex({ galaxy: full }: GraphSlotProps) {
  // a representative sample of the graph (not a count) + the dynamic nodes events touched outside it
  const galaxy = useMemo(() => graphView(full, MAX_NODES), [full]);
  const n = galaxy.nodes.length;
  const { size, gl, camera } = useThree();
  const nameRefs = useRef<(Label3DHandle | null)[]>([]);
  const nameGroups = useRef<(THREE.Group | null)[]>([]);
  const nameShown = useRef<string[]>(Array(MAX_NAMES).fill(""));

  const data = useMemo(() => {
    // Fibonacci sphere: even distribution on the surface
    const pos = new Float32Array(n * 3);
    const unit: THREE.Vector3[] = [];
    const ga = Math.PI * (3 - Math.sqrt(5));
    const ns = galaxy.ns;
    const d: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      // sampled nodes: even Fibonacci spacing; dynamic ones: a point hashed from the name (stable for every viewer)
      const y = 1 - (2 * (i + 0.5)) / Math.max(1, ns);
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const u = i < ns ? new THREE.Vector3(Math.cos(i * ga) * r, y, Math.sin(i * ga) * r) : new THREE.Vector3(...dynDir(galaxy.nodes[i].id, d));
      unit.push(u);
      pos.set([u.x * ORB_R, u.y * ORB_R, u.z * ORB_R], i * 3);
    }
    const base = galaxy.nodes.map((nd) => new THREE.Color(KIND_COLOR[nd.kind] ?? "#94a3b8").lerp(TINT, 0.2).multiplyScalar(0.62));
    const sizes = new Float32Array(n);
    const colors = new Float32Array(n * 3);
    const ngeo = new THREE.BufferGeometry();
    ngeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    ngeo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    ngeo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    // great-circle arcs: graph links, shortest arc, lifted slightly off the surface
    const idOf = new Map(galaxy.nodes.map((nd, i) => [nd.id, i]));
    const pairs: [number, number][] = [];
    const strong: number[] = [];
    for (const l of galaxy.links) {
      const a = idOf.get(l.source);
      const b = idOf.get(l.target);
      // only shorter relations: long arcs wrapping the whole orb read as noise
      if (a !== undefined && b !== undefined && a !== b && unit[a].angleTo(unit[b]) < 1.25) pairs.push([a, b]), strong.push(1);
    }
    // faint geodesic lattice: each node to its 2 nearest neighbours
    for (let i = 0; i < n; i++) {
      let b1 = -1, b2 = -1, d1 = 9, d2 = 9;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const d = unit[i].distanceToSquared(unit[j]);
        if (d < d1) (b2 = b1), (d2 = d1), (b1 = j), (d1 = d);
        else if (d < d2) (b2 = j), (d2 = d);
      }
      if (b1 > i) pairs.push([i, b1]), strong.push(0);
      if (b2 > i) pairs.push([i, b2]), strong.push(0);
    }
    const apos = new Float32Array(pairs.length * ARC_SEG * 2 * 3);
    const acol = new Float32Array(pairs.length * ARC_SEG * 2 * 3);
    const owner = new Int32Array(pairs.length * ARC_SEG * 2 * 2);
    const kindOf = new Uint8Array(pairs.length * ARC_SEG * 2);
    const qa = new THREE.Quaternion();
    const tmpV = new THREE.Vector3();
    pairs.forEach(([a, b], p) => {
      const ua = unit[a];
      const ub = unit[b];
      const ang = ua.angleTo(ub);
      const axis = new THREE.Vector3().crossVectors(ua, ub);
      if (axis.lengthSq() < 1e-6) axis.set(0, 1, 0);
      axis.normalize();
      for (let s = 0; s < ARC_SEG; s++)
        for (let e = 0; e < 2; e++) {
          const t = (s + e) / ARC_SEG;
          qa.setFromAxisAngle(axis, ang * t);
          tmpV.copy(ua).applyQuaternion(qa).multiplyScalar(ORB_R * (1.0 + 0.06 * Math.sin(Math.PI * t) * Math.min(1, ang)));
          const vi = (p * ARC_SEG + s) * 2 + e;
          apos.set([tmpV.x, tmpV.y, tmpV.z], vi * 3);
          owner[vi * 2] = a;
          owner[vi * 2 + 1] = b;
          kindOf[vi] = strong[p];
        }
    });
    const ageo = new THREE.BufferGeometry();
    ageo.setAttribute("position", new THREE.BufferAttribute(apos, 3));
    ageo.setAttribute("color", new THREE.BufferAttribute(acol, 3));
    // beams (soma -> node)
    const bgeo = new THREE.BufferGeometry();
    bgeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_SEG * 2 * 3), 3));
    bgeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_SEG * 2 * 3), 3));
    bgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return { pos, unit, base, ngeo, ageo, owner, kindOf, nArcV: pairs.length * ARC_SEG * 2, bgeo, fire: new Float32Array(n), white: new Float32Array(n), fireC: Array.from({ length: n }, () => new THREE.Color()) };
  }, [galaxy, n]);

  const mats = useMemo(
    () => ({
      nodes: new THREE.ShaderMaterial({ uniforms: { uScale: { value: 400 } }, vertexShader: pointVert, fragmentShader: pointFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      arcs: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      beam: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      orb: new THREE.ShaderMaterial({
        uniforms: {
          uRim: { value: new THREE.Color("#8b7cff").multiplyScalar(0.7) },
          uInner: { value: new THREE.Color("#5b8cff").multiplyScalar(0.6) },
          uTime: { value: 0 },
          uRipC: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector3(0, 1, 0)) },
          uRipA: { value: new Array(MAX_RIPPLES).fill(-1) as number[] },
        },
        vertexShader: orbVert,
        fragmentShader: orbFrag,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      core: glowSpriteMaterial(new THREE.Color("#8b7cff").multiplyScalar(0.22)),
      aura: glowSpriteMaterial(new THREE.Color("#4c1d95").multiplyScalar(0.28)),
    }),
    [],
  );
  const cache = useMemo(() => new Map<string, number>(), [galaxy]); // eslint-disable-line react-hooks/exhaustive-deps
  const arrows = useMemo(() => new ArrowPool(MAX_BEAMS), []);
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), v2: new THREE.Vector3(), mid: new THREE.Vector3(), sp: new THREE.Vector3(), c: new THREE.Color(), c2: new THREE.Color() }), []);
  const idx = (name: string) => {
    let i = cache.get(name);
    if (i === undefined) cache.set(name, (i = nodeIndex(galaxy, name)));
    return i;
  };

  useFrame(({ clock }) => {
    const now = performance.now();
    const { pos, base, fire, white, fireC, unit } = data;
    // point sprites are sized in view space: follow the kit's group scale so the side node stays proportionate
    mats.nodes.uniforms.uScale.value = ((size.height * gl.getPixelRatio()) / (2 * Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360))) * kit.graph.scale;
    mats.orb.uniforms.uTime.value = reduced ? 0 : clock.elapsedTime;
    fire.fill(0);
    white.fill(0);

    const { v, v2, mid, c, c2 } = tmp;
    const bp = data.bgeo.getAttribute("position") as THREE.BufferAttribute;
    const bc = data.bgeo.getAttribute("color") as THREE.BufferAttribute;
    const ripC = mats.orb.uniforms.uRipC.value as THREE.Vector3[];
    const ripA = mats.orb.uniforms.uRipA.value as number[];
    let b = 0;
    arrows.begin();
    let rp = 0;
    for (const f of world.flares) {
      const i = idx(f.node);
      const age = (now - f.start) / 1000;
      const inst = world.instances.get(f.instance);
      const tc = inst ? TYPE_C[inst.type] : WHITE;
      const isW = f.op === "write";
      const k = age < 0.35 ? age / 0.35 : Math.exp(-(age - 0.35) * 1.2);
      if (k > fire[i]) {
        fire[i] = k;
        fireC[i].copy(isW ? WHITE : tc);
        white[i] = isW ? 1 : 0;
      }
      if (isW && age < 1.8 && rp < MAX_RIPPLES) {
        ripC[rp].copy(unit[i]);
        ripA[rp] = age / 1.8;
        rp++;
      }
      // beam: curve runs agent (t=0) → graph node (t=1). Data flow:
      //   read  = data comes OUT of the graph: pulse node → agent, arrow at the agent (agent color)
      //   write = agent → FalkorDB: solid white beam, pulse agent → node, arrow at the node
      // beams are drawn inside the graph group: the agent's stage position in graph-local units
      const live = agentLive(f.instance);
      const sp = live ? stageToGraph(live, tmp.sp) : undefined;
      if (sp && age < 2.2 && b < MAX_BEAMS) {
        v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        mid.copy(sp).add(v).multiplyScalar(0.5);
        mid.z += 1.0;
        const fade = Math.min(1, age / 0.3) * (1 - age / 2.2) ** 1.5;
        const head = isW ? Math.min(1, age * 0.85) : 1 - Math.min(1, age * 0.85);
        for (let s = 0; s < BEAM_SEG; s++)
          for (let e = 0; e < 2; e++) {
            const t = (s + e) / BEAM_SEG;
            const a = 1 - t;
            v2.set(a * a * sp.x + 2 * a * t * mid.x + t * t * v.x, a * a * sp.y + 2 * a * t * mid.y + t * t * v.y, a * a * sp.z + 2 * a * t * mid.z + t * t * v.z);
            const vi = (b * BEAM_SEG + s) * 2 + e;
            bp.setXYZ(vi, v2.x, v2.y, v2.z);
            const pk = Math.exp(-(((t - head) / 0.1) ** 2)) * 1.3;
            c2.copy(isW ? WHITE : tc).multiplyScalar(fade * ((isW ? 0.5 : 0.2) + pk) * 0.75);
            bc.setXYZ(vi, c2.r, c2.g, c2.b);
          }
        if (isW) arrows.add(sp, mid, v, 0.9, 1, 0.42, WHITE, fade * 1.1);
        else arrows.add(sp, mid, v, 0.1, -1, 0.42, tc, fade * 1.3);
        b++;
      }
    }
    for (let z = rp; z < MAX_RIPPLES; z++) ripA[z] = -1;
    data.bgeo.setDrawRange(0, b * BEAM_SEG * 2);
    arrows.end();
    bp.needsUpdate = true;
    bc.needsUpdate = true;

    // nodes
    const sz = data.ngeo.getAttribute("aSize") as THREE.BufferAttribute;
    const nc = data.ngeo.getAttribute("aColor") as THREE.BufferAttribute;
    for (let i = 0; i < n; i++) {
      const f = fire[i];
      sz.setX(i, 0.21 + f * (0.55 + white[i] * 0.25));
      c.copy(base[i]);
      if (f > 0.01) addScaled(addScaled(c, fireC[i], f * 1.6), WHITE, f * (0.3 + white[i] * 1.2));
      nc.setXYZ(i, c.r, c.g, c.b);
    }
    sz.needsUpdate = true;
    nc.needsUpdate = true;

    // arcs: faint, brighten when an endpoint fires
    const ac = data.ageo.getAttribute("color") as THREE.BufferAttribute;
    const own = data.owner;
    for (let vi = 0; vi < data.nArcV; vi++) {
      const a = own[vi * 2];
      const z = own[vi * 2 + 1];
      const f = Math.max(fire[a], fire[z]);
      const k0 = data.kindOf[vi] ? 0.16 : 0.07;
      ac.setXYZ(vi, 0.42 * k0 + f * 0.3, 0.36 * k0 + f * 0.3, 0.85 * k0 + f * 0.4);
    }
    ac.needsUpdate = true;

    // briefly name the most recently touched nodes (skip overlapping ones)
    let shown = 0;
    for (let qf = world.flares.length - 1; qf >= 0 && shown < MAX_NAMES; qf--) {
      const f = world.flares[qf];
      if (now - f.start > 2200) break;
      if (f.area) continue;
      let dup = false;
      for (let z = 0; z < shown; z++) if (nameShown.current[z] === f.node) dup = true;
      if (dup) continue;
      const i = idx(f.node);
      let near = false;
      for (let z = 0; z < shown; z++) {
        const ng0 = nameGroups.current[z];
        if (ng0 && Math.abs(ng0.position.y - pos[i * 3 + 1]) < 0.55 && Math.abs(ng0.position.x - pos[i * 3]) < 3.2) near = true;
      }
      if (near) continue;
      const el = nameRefs.current[shown];
      const ng = nameGroups.current[shown];
      if (el && ng) {
        ng.position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        if (nameShown.current[shown] !== f.node) {
          el.setText(`${f.op === "write" ? "wrote" : "read"} · ${f.node}`);
          el.setColor(f.op === "write" ? "#ffffff" : "#22d3ee");
        }
        el.setOpacity(1);
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

  return (
    <>
      <group>
        <sprite material={mats.aura} scale={ORB_R * 4.2} position={[0, 0, -ORB_R]} />
        <sprite material={mats.core} scale={ORB_R * 1.5} />
        <mesh geometry={SPHERE_GEO} material={mats.orb} scale={ORB_R * 1.02} />
        <lineSegments geometry={data.ageo} material={mats.arcs} frustumCulled={false} />
        <points geometry={data.ngeo} material={mats.nodes} frustumCulled={false} />
      </group>
      <lineSegments geometry={data.bgeo} material={mats.beam} frustumCulled={false} />
      <primitive object={arrows.mesh} />
      {Array.from({ length: MAX_NAMES }, (_, k) => (
        <group key={k} ref={(x) => void (nameGroups.current[k] = x)}>
          <Label3D ref={(x) => void (nameRefs.current[k] = x)} text="" offset={[0, 0.42]} size={0.24} opacity={0} fadeMs={250} pxRange={[8, 12]} />
        </group>
      ))}
      <GraphLabel3D position={[0, -ORB_R - 0.9, 0]} color="#a78bfa" size={0.28} opacity={0.7} pxRange={[8, 12]} />
    </>
  );
}
