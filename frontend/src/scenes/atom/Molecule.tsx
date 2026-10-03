/**
 * Graph resource slot: the knowledge graph is a small MOLECULE on the side (only when the session has a graph),
 * drawn in its own frame (radius MOL_R); the kit positions, scales and fades it. Graph nodes are atoms colored by
 * kind, joined by bonds (graph links + nearest neighbours). Reads light the atom in the reader's colour and fire a
 * particle beam atom → electron; writes flash it white-pink, beam electron → atom, and send a shockwave out.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { nodeIndex } from "../shared/useSceneSetup";
import { graphView, placeDynamic } from "../shared/graphDyn";
import { KIND_COLOR, world } from "../shared/world";
import { agentLive, kit, stageToGraph, type GraphSlotProps } from "../shared/kit";
import { ArrowPool, CurvePool, ICE, MOL_R, PINK, ROSE, TYPE_C, WHITE, addScaled, bezier, glowSprite, lineMat, reduced } from "./fx";

const MAX_NODES = 140;
const NUC_SIZE = 0.17;
const MAX_BEAMS = 40;
const SEG = 18;
const MAX_WAVES = 5;
const MAX_NAMES = 4;
/** atom radius for n atoms: NUC_SIZE for a full molecule, up to 3x for a sparse one (same overall footprint) */
const atomSize = (n: number) => NUC_SIZE * THREE.MathUtils.clamp(Math.sqrt(48 / Math.max(1, n)), 1, 3);

const vert = /* glsl */ `
attribute vec3 aCol; attribute float aFire;
varying vec3 vN; varying vec3 vV; varying vec3 vC; varying float vF;
void main(){
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
  vV = normalize(-mv.xyz); vC = aCol; vF = aFire;
  gl_Position = projectionMatrix * mv;
}`;
const frag = /* glsl */ `
varying vec3 vN; varying vec3 vV; varying vec3 vC; varying float vF;
void main(){
  vec3 n = normalize(vN);
  vec3 L = normalize(vec3(-0.45, 0.65, 0.6));
  float d = max(dot(n, L), 0.0);
  float rim = pow(1.0 - abs(dot(n, normalize(vV))), 2.4);
  float spec = pow(max(dot(reflect(-L, n), normalize(vV)), 0.0), 28.0);
  vec3 col = vC * (0.10 + 0.55 * d) + vC * rim * 0.75 + vec3(spec) * 0.35;
  col += vC * vF * 1.8 + vec3(1.0) * vF * vF * 0.9;
  gl_FragColor = vec4(col, 1.0);
}`;

const waveMat = () =>
  new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() } },
    vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vV;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: /* glsl */ `uniform vec3 uColor; varying vec3 vN; varying vec3 vV;
      void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0); gl_FragColor = vec4(uColor * f, 1.0); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
const WAVE_GEO = new THREE.SphereGeometry(1, 48, 32);

export function Molecule({ galaxy: full }: GraphSlotProps) {
  // the sample (first MAX_NODES) + the dynamic nodes events touched outside it (graphDyn.ts)
  const galaxy = useMemo(() => graphView(full, MAX_NODES), [full]);
  const n = galaxy.nodes.length;

  const data = useMemo(() => {
    const pos = new Float32Array(n * 3);
    const ga = Math.PI * (3 - Math.sqrt(5));
    // a sparse molecule (a live graph grows from the nodes touched so far) gets bigger atoms so it reads at its
    // full size from the first read instead of starting as a few specks
    const ns = galaxy.ns;
    const atomR = atomSize(ns || n);
    for (let i = 0; i < ns; i++) {
      // loose fibonacci ball: index 0 outermost (named entities sit on the surface where they're visible)
      const r = (MOL_R - atomR) * (0.3 + 0.7 * Math.cbrt(1 - i / ns));
      const y = 1 - (2 * (i + 0.5)) / ns;
      const rr = Math.sqrt(1 - y * y);
      pos.set([Math.cos(i * ga) * rr * r, y * r, Math.sin(i * ga) * rr * r], i * 3);
    }
    // dynamic nodes bud off their anchor atom (hashed offset: same spot for every viewer)
    placeDynamic(galaxy, pos, atomR * 3.2);
    const base = galaxy.nodes.map((nd, i) => new THREE.Color(KIND_COLOR[nd.kind] ?? "#94a3b8").lerp(WHITE, 0.08 + ((i * 37) % 10) / 70).multiplyScalar(0.8));
    // bonds: graph links between near atoms + each atom to its nearest neighbour
    const idOf = new Map(galaxy.nodes.map((nd, i) => [nd.id, i]));
    const pairs: number[] = [];
    const seen = new Set<number>();
    const d2 = (a: number, b: number) => (pos[a * 3] - pos[b * 3]) ** 2 + (pos[a * 3 + 1] - pos[b * 3 + 1]) ** 2 + (pos[a * 3 + 2] - pos[b * 3 + 2]) ** 2;
    const bond = (a: number, b: number) => {
      const key = a < b ? a * 4096 + b : b * 4096 + a;
      if (a === b || seen.has(key)) return;
      seen.add(key);
      pairs.push(a, b);
    };
    for (const l of galaxy.links) {
      const a = idOf.get(l.source);
      const b = idOf.get(l.target);
      if (a !== undefined && b !== undefined && d2(a, b) < (MOL_R * 0.9) ** 2) bond(a, b);
    }
    for (let a = 0; a < n; a++) {
      let best = -1;
      let bd = Infinity;
      for (let b = 0; b < n; b++) if (b !== a && d2(a, b) < bd) (bd = d2(a, b)), (best = b);
      if (best >= 0) bond(a, best);
    }
    const bpos = new Float32Array(pairs.length * 3);
    pairs.forEach((i, k) => bpos.set([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], k * 3));
    const bgeo = new THREE.BufferGeometry();
    bgeo.setAttribute("position", new THREE.BufferAttribute(bpos, 3));
    bgeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pairs.length * 3), 3));
    bgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), MOL_R * 2);
    const geo = new THREE.SphereGeometry(1, 20, 14);
    const aCol = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    const aFire = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    geo.setAttribute("aCol", aCol);
    geo.setAttribute("aFire", aFire);
    const mesh = new THREE.InstancedMesh(geo, new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag }), n);
    mesh.frustumCulled = false;
    const o = new THREE.Object3D();
    for (let i = 0; i < n; i++) {
      o.position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      o.scale.setScalar(atomR);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
      aCol.setXYZ(i, base[i].r, base[i].g, base[i].b);
    }
    return { pos, base, atomR, mesh, aCol, aFire, o, bgeo, owner: Int32Array.from(pairs), fire: new Float32Array(n), fireC: Array.from({ length: n }, () => new THREE.Color()) };
  }, [galaxy, n]);

  const mats = useMemo(
    () => ({
      beam: lineMat("#fff", true),
      bond: lineMat("#fff", true),
      core: glowSprite(new THREE.Color("#7a5cff").multiplyScalar(0.35)),
      cloud: glowSprite(new THREE.Color("#1d4ed8").multiplyScalar(0.22)),
      waves: Array.from({ length: MAX_WAVES }, waveMat),
    }),
    [],
  );
  const beams = useMemo(() => new CurvePool(MAX_BEAMS, SEG), []);
  const arrows = useMemo(() => new ArrowPool(MAX_BEAMS), []);
  const waveRefs = useRef<(THREE.Mesh | null)[]>([]);
  const nameRefs = useRef<(Label3DHandle | null)[]>([]);
  const nameGroups = useRef<(THREE.Group | null)[]>([]);
  const nameShown = useRef<string[]>(Array(MAX_NAMES).fill(""));
  // which side of the molecule the name column hangs on: the outward side (away from the agents at the centre)
  const [nameSide, setNameSide] = useState<"left" | "right">("left");
  const cache = useMemo(() => new Map<string, number>(), [galaxy]); // eslint-disable-line react-hooks/exhaustive-deps
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), mid: new THREE.Vector3(), p: new THREE.Vector3(), c: new THREE.Color(), c2: new THREE.Color(), sp: new THREE.Vector3() }), []);
  const idx = (name: string) => {
    let i = cache.get(name);
    if (i === undefined) cache.set(name, (i = nodeIndex(galaxy, name) % n));
    return i;
  };

  useFrame(({ clock, camera, size }) => {
    if (!n) return;
    const now = performance.now();
    const t = clock.elapsedTime;
    const { pos, base, fire, fireC, mesh, aCol, aFire, o } = data;
    fire.fill(0);
    const { v, mid, p, c, c2 } = tmp;
    beams.begin();
    arrows.begin();
    let wv = 0;
    for (const f of world.flares) {
      const i = idx(f.node);
      const age = (now - f.start) / 1000;
      const inst = world.instances.get(f.instance);
      const isW = f.op === "write";
      const tc = isW ? ROSE : inst ? TYPE_C[inst.type] : ICE;
      const k = age < 0.3 ? age / 0.3 : Math.exp(-(age - 0.3) * 1.3);
      if (k > fire[i]) {
        fire[i] = k;
        fireC[i].copy(isW ? WHITE : tc);
      }
      if (isW && age < 1.6 && wv < MAX_WAVES) {
        const m = waveRefs.current[wv];
        if (m) {
          const a = age / 1.6;
          m.visible = true;
          m.scale.setScalar(MOL_R * (1.05 + a * 1.9));
          (m.material as THREE.ShaderMaterial).uniforms.uColor.value.copy(PINK).lerp(WHITE, 0.3).multiplyScalar(0.9 * (1 - a) * (1 - a));
        }
        wv++;
      }
      // particle beam (curve: electron t=0 → nucleon t=1). read = data leaves the nucleus; write = enters it.
      const lv = agentLive(f.instance);
      const sp = lv ? stageToGraph(lv, tmp.sp) : undefined;
      if (sp && age < 2.0) {
        const base0 = beams.next();
        if (base0 < 0) continue;
        v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        mid.copy(sp).add(v).multiplyScalar(0.5);
        mid.z += 0.8;
        const fade = Math.min(1, age / 0.2) * Math.pow(1 - age / 2.0, 1.6);
        const head = isW ? Math.min(1, age * 1.1) : 1 - Math.min(1, age * 1.1);
        for (let s = 0; s < SEG; s++)
          for (let e = 0; e < 2; e++) {
            const tt = (s + e) / SEG;
            bezier(sp, mid, v, tt, p);
            beams.P.setXYZ(base0 + s * 2 + e, p.x, p.y, p.z);
            const pk = Math.exp(-(((tt - head) / 0.07) ** 2)) * 2.2;
            c2.copy(tc).multiplyScalar(fade * (0.18 + pk) * 0.8);
            beams.C.setXYZ(base0 + s * 2 + e, c2.r, c2.g, c2.b);
          }
        if (isW) arrows.add(sp, mid, v, 0.86, 1, 0.38, ROSE, fade * 1.4);
        else arrows.add(sp, mid, v, 0.12, -1, 0.38, tc, fade * 1.4);
      }
    }
    for (let z = wv; z < MAX_WAVES; z++) if (waveRefs.current[z]) waveRefs.current[z]!.visible = false;
    beams.end();
    arrows.end();

    // nucleons: colour + a faint quantum jiggle; fired nucleons swell
    const jig = reduced ? 0 : 0.025;
    for (let i = 0; i < n; i++) {
      const f = fire[i];
      c.copy(base[i]);
      if (f > 0.01) addScaled(c.multiplyScalar(1 - f * 0.5), fireC[i], f * 0.9);
      aCol.setXYZ(i, c.r, c.g, c.b);
      aFire.setX(i, f);
      o.position.set(pos[i * 3] + Math.sin(t * 2.1 + i * 1.7) * jig, pos[i * 3 + 1] + Math.cos(t * 1.8 + i * 2.3) * jig, pos[i * 3 + 2] + Math.sin(t * 1.6 + i) * jig);
      o.scale.setScalar(data.atomR * (1 + f * 0.35));
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    aCol.needsUpdate = true;
    aFire.needsUpdate = true;

    // bonds: faint, brighten when an atom at either end fires
    const bc = data.bgeo.getAttribute("color") as THREE.BufferAttribute;
    const own = data.owner;
    for (let vi = 0; vi < own.length; vi++) {
      const f = Math.max(fire[own[vi]], fire[own[vi ^ 1]]);
      const b0 = base[own[vi]];
      bc.setXYZ(vi, b0.r * 0.22 + f * 0.5, b0.g * 0.22 + f * 0.5, b0.b * 0.22 + f * 0.55);
    }
    bc.needsUpdate = true;

    // name the most recently touched nodes: a column on the molecule's outward side, ~15px apart (labels are px-clamped, so the
    // step is measured in screen pixels converted to graph-local units)
    const cam = camera as THREE.PerspectiveCamera;
    const dist = Math.max(1, cam.position.distanceTo(kit.graph.pos));
    const step = ((15 * 2 * dist * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(1, size.height)) / Math.max(0.05, kit.graph.scale);
    const out = kit.graph.out.x < -0.5 ? "right" : kit.graph.out.x > 0.5 ? "left" : nameSide;
    if (out !== nameSide) setNameSide(out);
    const nx = (out === "right" ? -1 : 1) * (MOL_R + 0.3);
    let shown = 0;
    for (let q = world.flares.length - 1; q >= 0 && shown < MAX_NAMES; q--) {
      const f = world.flares[q];
      if (now - f.start > 2200) break;
      if (f.area) continue;
      let skip = false;
      for (let z = 0; z < shown; z++) if (nameShown.current[z] === f.node) skip = true;
      if (skip) continue;
      const el = nameRefs.current[shown];
      const g = nameGroups.current[shown];
      if (el && g) {
        g.position.set(nx, (1.5 - shown) * step, 0.5);
        if (nameShown.current[shown] !== f.node) {
          el.setText(`${f.op === "write" ? "wrote" : "read"} · ${f.node}`);
          el.setColor(f.op === "write" ? "#ff9ccf" : "#7dd3fc");
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
      <sprite material={mats.cloud} scale={MOL_R * 4.2} position={[0, 0, -1]} />
      <sprite material={mats.core} scale={MOL_R * 1.6} />
      <lineSegments geometry={data.bgeo} material={mats.bond} frustumCulled={false} />
      <primitive object={data.mesh} />
      {mats.waves.map((m, k) => (
        <mesh key={k} ref={(x) => void (waveRefs.current[k] = x)} geometry={WAVE_GEO} material={m} visible={false} />
      ))}
      <lineSegments geometry={beams.geo} material={mats.beam} frustumCulled={false} />
      <primitive object={arrows.mesh} />
      {Array.from({ length: MAX_NAMES }, (_, k) => (
        <group key={k} ref={(x) => void (nameGroups.current[k] = x)}>
          <Label3D ref={(x) => void (nameRefs.current[k] = x)} text="" font="mono" anchorX={nameSide} size={0.24} opacity={0} fadeMs={250} pxRange={[8, 11.5]} />
        </group>
      ))}
      <GraphLabel3D position={[0, -MOL_R - 0.85, 0]} prefix="molecule · " font="mono" color="#ff4fa8" letterSpacing={0.04} size={0.26} opacity={0.75} pxRange={[8.5, 12]} />
    </>
  );
}
