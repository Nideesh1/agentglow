/**
 * Graph resource slot: FalkorDB as a small spiral galaxy on the side (only when the session has a graph), drawn in
 * its own frame (radius GALAXY_R); the kit positions, scales and fades it. Instanced nodes colored by kind, faint
 * graph links, flares + write rings, brief node names.
 */
import { Sparkles } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { KIND_COLOR, world } from "../shared/world";
import type { GraphSlotProps } from "../shared/kit";
import { galaxyIdx, galaxyRef, reduced } from "./layout";
import { graphView, placeDynamic } from "../shared/graphDyn";

function galaxyLayout(n: number) {
  const pts: THREE.Vector3[] = [];
  const arms = 3;
  for (let i = 0; i < n; i++) {
    const f = i / n;
    const r = 0.45 + 4.1 * Math.sqrt(f) + (Math.random() - 0.5) * 0.4;
    const arm = i % arms;
    const ang = (arm / arms) * Math.PI * 2 + r * 1.3 + (Math.random() - 0.5) * 0.5;
    pts.push(new THREE.Vector3(Math.cos(ang) * r, (Math.random() - 0.5) * 0.5 * (1.4 - f), Math.sin(ang) * r));
  }
  return pts;
}

const RING_POOL = 32;
const WHITE = new THREE.Color(5, 5, 5);

const SAMPLE = 200;
const TILT = 1.35;
/** natural radius of the galaxy (local units, arms + sparkles): the kit scales it to its side slot */
export const GALAXY_R = 4.75 * TILT + 0.6;
const LABELS = 6;

export function GalaxyCore({ galaxy: full }: GraphSlotProps) {
  // FalkorDB is shown as a representative sample (named entities first), not the full graph
  // + the dynamic nodes events touched outside the sample (graphDyn.ts)
  const galaxy = useMemo(() => graphView(full, SAMPLE), [full]);
  const labelGroups = useRef<(THREE.Group | null)[]>([]);
  const labelDivs = useRef<(Label3DHandle | null)[]>([]);
  const labelOp = useRef<string[]>([]);
  const labelNode = useRef<number[]>(Array(LABELS).fill(-1));
  const group = useRef<THREE.Group>(null);
  const inst = useRef<THREE.InstancedMesh>(null);
  const rings = useRef<THREE.InstancedMesh>(null);
  const nucleus = useRef<THREE.Mesh>(null);
  const n = galaxy.nodes.length;
  // the sampled arms are laid out once per sample size (they never jump when dynamic nodes come and go); dynamic
  // nodes bud off their anchor star at a hashed offset (same spot for every viewer)
  const ns = galaxy.ns;
  const arms = useMemo(() => galaxyLayout(ns), [ns]);
  const pos = useMemo(() => {
    if (n === ns) return arms;
    const flat = new Float32Array(n * 3);
    arms.forEach((p, i) => p.toArray(flat, i * 3));
    placeDynamic(galaxy, flat, 0.55);
    return Array.from({ length: n }, (_, i) => (i < ns ? arms[i] : new THREE.Vector3().fromArray(flat, i * 3)));
  }, [arms, galaxy, n, ns]);
  const base = useMemo(() => galaxy.nodes.map((nd) => new THREE.Color(KIND_COLOR[nd.kind] ?? "#94a3b8")), [galaxy]);
  const amt = useMemo(() => new Float32Array(Math.max(1, n)), [n]);
  const wrote = useMemo(() => new Uint8Array(Math.max(1, n)), [n]);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const v = useMemo(() => new THREE.Vector3(), []);

  const linkGeo = useMemo(() => {
    const idx = new Map(galaxy.nodes.map((nd, i) => [nd.id, i]));
    const arr: number[] = [];
    const cols: number[] = [];
    const seen = new Set<string>();
    const add = (a: number, b: number) => {
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (a === b || seen.has(k)) return;
      seen.add(k);
      arr.push(pos[a].x, pos[a].y, pos[a].z, pos[b].x, pos[b].y, pos[b].z);
      cols.push(base[a].r, base[a].g, base[a].b, base[b].r, base[b].g, base[b].b);
    };
    for (const l of galaxy.links) {
      const a = idx.get(l.source);
      const b = idx.get(l.target);
      if (a !== undefined && b !== undefined && pos[a].distanceTo(pos[b]) < 3) add(a, b);
    }
    // local structure: connect each node to its 2 nearest neighbours
    for (let a = 0; a < n; a++) {
      let b1 = -1, b2 = -1, d1 = 1e9, d2 = 1e9;
      for (let b = 0; b < n; b++) {
        if (b === a) continue;
        const d = pos[a].distanceToSquared(pos[b]);
        if (d < d1) (b2 = b1), (d2 = d1), (b1 = b), (d1 = d);
        else if (d < d2) (b2 = b), (d2 = d);
      }
      if (b1 >= 0) add(a, b1);
      if (b2 >= 0 && d2 < 1.2) add(a, b2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    return g;
  }, [galaxy, pos, base, n]);

  useEffect(() => {
    galaxyRef.pos = pos;
    galaxyRef.index = new Map(galaxy.nodes.map((nd, i) => [nd.name.toLowerCase(), i]));
    galaxyRef.group = group.current;
    return () => void (galaxyRef.group = null);
  }, [galaxy, pos]);

  useFrame(({ camera, clock }) => {
    const g = group.current;
    const mesh = inst.current;
    if (!g || !mesh) return;
    g.updateMatrixWorld();
    const now = performance.now();
    amt.fill(0);
    wrote.fill(0);
    let r = 0;
    for (const f of world.flares) {
      const age = (now - f.start) / 1000;
      const k = galaxyIdx(f.node);
      const e = Math.exp(-age * 1.3);
      if (e > amt[k]) amt[k] = e;
      if (f.op === "write") wrote[k] = 1;
      // expanding billboard ring: write = big white shockwave, read = small tinted ring
      if (rings.current && r < RING_POOL && age < 1.6) {
        v.copy(pos[k]).applyMatrix4(g.matrix);
        tmp.position.copy(v);
        tmp.quaternion.copy(camera.quaternion);
        const p = age / 1.6;
        tmp.scale.setScalar((f.op === "write" ? 0.6 + p * 3.2 : 0.3 + p * 1.4) * (1 - p * 0.2));
        tmp.updateMatrix();
        rings.current.setMatrixAt(r, tmp.matrix);
        if (f.op === "write") col.copy(WHITE).multiplyScalar(1 - p);
        else col.copy(base[k]).multiplyScalar(3 * (1 - p));
        rings.current.setColorAt(r, col);
        r++;
      }
    }
    if (rings.current) {
      rings.current.count = r;
      rings.current.instanceMatrix.needsUpdate = true;
      if (rings.current.instanceColor) rings.current.instanceColor.needsUpdate = true;
    }
    // brief name labels on the most recent flared nodes
    let L = 0;
    for (let q = world.flares.length - 1; q >= 0 && L < LABELS; q--) {
      const f = world.flares[q];
      const age = (now - f.start) / 1000;
      if (age > 1.8) continue;
      if (f.area) continue;
      const k = galaxyIdx(f.node);
      let dup = false;
      for (let j = 0; j < L; j++) if (labelNode.current[j] === k) dup = true;
      if (dup) continue;
      const lg = labelGroups.current[L];
      const ld = labelDivs.current[L];
      if (lg && ld) {
        lg.position.copy(pos[k]);
        if (labelNode.current[L] !== k || labelOp.current[L] !== f.op) {
          ld.setText(`${f.op === "write" ? "wrote · " : ""}${f.node}`);
          labelOp.current[L] = f.op;
          ld.setColor(f.op === "write" ? "#ffffff" : `#${base[k].getHexString()}`);
        }
        ld.setOpacity(Math.min(1, (1.8 - age) / 0.5));
        lg.visible = true;
      }
      labelNode.current[L] = k;
      L++;
    }
    for (let j = L; j < LABELS; j++) {
      labelNode.current[j] = -1;
      if (labelGroups.current[j]) labelGroups.current[j]!.visible = false;
    }
    for (let i = 0; i < n; i++) {
      const f = amt[i];
      tmp.position.copy(pos[i]);
      tmp.quaternion.identity();
      tmp.scale.setScalar(1 + f * (wrote[i] ? 4.5 : 3));
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
      col.copy(base[i]).multiplyScalar(0.85 + f * 5);
      if (wrote[i]) col.lerp(WHITE, f * 0.7);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (nucleus.current) nucleus.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 1.3) * 0.06);
  });

  const nucColor = useMemo(() => new THREE.Color("#c7d2fe").multiplyScalar(2.4), []);
  return (
    <>
      <group ref={group} rotation={[0.3, 0, 0.08]} scale={TILT}>
        <instancedMesh ref={inst} args={[undefined, undefined, Math.max(1, n)]} frustumCulled={false}>
          <sphereGeometry args={[0.065, 10, 10]} />
          <meshBasicMaterial toneMapped={false} />
        </instancedMesh>
        <lineSegments geometry={linkGeo}>
          <lineBasicMaterial vertexColors transparent opacity={0.4} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </lineSegments>
        <mesh ref={nucleus}>
          <sphereGeometry args={[0.38, 32, 32]} />
          <meshBasicMaterial color={nucColor} toneMapped={false} />
        </mesh>
        <mesh>
          <sphereGeometry args={[1.1, 32, 32]} />
          <meshBasicMaterial color="#818cf8" transparent opacity={0.07} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
        {Array.from({ length: LABELS }, (_, j) => (
          <group key={j} ref={(m) => void (labelGroups.current[j] = m)} visible={false}>
            <Label3D ref={(d) => void (labelDivs.current[j] = d)} position={[0, 0.32, 0]} text="" size={0.2} opacity={0} pxRange={[8, 11.5]} />
          </group>
        ))}
        <Sparkles count={reduced ? 30 : 110} scale={[9, 1.3, 9]} size={0.7} speed={reduced ? 0.05 : 0.3} color="#a5b4fc" opacity={0.6} />
      </group>
      <instancedMesh ref={rings} args={[undefined, undefined, RING_POOL]} frustumCulled={false}>
        <ringGeometry args={[0.2, 0.26, 40]} />
        <meshBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
      </instancedMesh>
      <GraphLabel3D position={[0, -0.6, GALAXY_R * 0.78]} color="#a5b4fc" size={0.42} pxRange={[10, 15]} />
    </>
  );
}
