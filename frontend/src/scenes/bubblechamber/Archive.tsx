/**
 * The knowledge graph is the EVENT ARCHIVE on the side of the chamber (scene-kit GraphResource, drawn in its own
 * frame centred at 0; the kit places, scales and fades it, only when the session has a graph): a short tower of
 * archived event plates, thin glowing translucent slabs like stacked detector photographs, each tilted toward the
 * viewer and the stack fanned a little round its vertical axis so it reads as a solid object from any orbit angle.
 * Graph entities are hashed onto a plate and a cell of its grid (occupied cells glow faintly in their kinds'
 * colours). A READ pulls the plate out of the stack a little (a drawer), lights the entity's cell in the reader's
 * tint and a track carries a spark from the cell to the agent; a WRITE lights the cell white, showers bubbles in it
 * and sends the spark agent -> cell. The most recently touched entities are named next to their cells.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { nodeIndex } from "../shared/useSceneSetup";
import { agentLive, GraphStageSpace, graphToStage, type GraphSlotProps } from "../shared/kit";
import { KIND_COLOR, hash01, useWorld, world } from "../shared/world";
import { FILM, LinePool, TRACK_C, WHITE, additive, bezier, bubbles, burst, clamp01, curl, lineMat, nowS, reduced } from "./fx";

/** plates in the stack, cells per plate (cols x rows) and plate size (archive-local units) */
const PLATES = 7;
const COLS = 8;
const ROWS = 5;
const PW = 6.2;
const PD = 3.5;
const PT = 0.08;
/** vertical gap between plates, tilt toward the viewer, fan (twist) per plate, drawer travel of a read */
const GAP = 0.92;
const TILT = 0.52;
const FAN = 0.09;
const SLIDE = 1.15;
const CPP = COLS * ROWS;
const NC = PLATES * CPP;
const CW = PW / COLS;
const CD = PD / ROWS;
const HALF_H = ((PLATES - 1) / 2) * GAP + (PD / 2) * Math.sin(TILT);
/** natural radius of the archive in its own units */
export const ARCHIVE_R = Math.hypot(PW / 2 + 0.6, HALF_H + 0.4);
const MAX_BEAMS = 32;
const MAX_NAMES = 3;

const PLATE_BOX = new THREE.BoxGeometry(PW, PT, PD);
const PLATE_EDGES = new THREE.EdgesGeometry(PLATE_BOX);
/** the cell grid scribed on a plate's top face (plate-local) */
const PLATE_GRID = (() => {
  const v: number[] = [];
  const y = PT / 2 + 0.004;
  for (let i = 1; i < COLS; i++) {
    const x = -PW / 2 + i * CW;
    v.push(x, y, -PD / 2, x, y, PD / 2);
  }
  for (let j = 1; j < ROWS; j++) {
    const z = -PD / 2 + j * CD;
    v.push(-PW / 2, y, z, PW / 2, y, z);
  }
  // a frame mark along the front edge (the plate's label strip)
  v.push(-PW / 2 + 0.15, y, PD / 2 - 0.14, -PW / 2 + 1.4, y, PD / 2 - 0.14);
  return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
})();
/** a flat square cell lying on the plate (xz) */
const CELL_SQ = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

/** plate p's rest position and orientation in the archive frame */
const plateRest = (p: number, pos: THREE.Vector3, q: THREE.Quaternion) => {
  pos.set(0, (p - (PLATES - 1) / 2) * GAP, 0);
  _e.set(TILT, (p - (PLATES - 1) / 2) * FAN, 0, "YXZ");
  q.setFromEuler(_e);
};
/** cell ci's centre in its plate's frame (just above the top face) */
const cellLocal = (ci: number, out: THREE.Vector3) => {
  const c = ci % CPP;
  return out.set(-PW / 2 + ((c % COLS) + 0.5) * CW, PT / 2 + 0.01, -PD / 2 + (Math.floor(c / COLS) + 0.5) * CD);
};
const _e = new THREE.Euler();

export function Archive({ galaxy }: GraphSlotProps) {
  const n = galaxy.nodes.length;
  const data = useMemo(() => {
    const cellOf = new Int32Array(n);
    const occ = new Float32Array(NC);
    const base = Array.from({ length: NC }, () => new THREE.Color(0, 0, 0));
    const tmp = new THREE.Color();
    galaxy.nodes.forEach((nd, i) => {
      const c = Math.floor(hash01(nd.id, 9) * NC) % NC;
      cellOf[i] = c;
      occ[c]++;
      base[c].add(tmp.set(KIND_COLOR[nd.kind] ?? "#94a3b8"));
    });
    for (let c = 0; c < NC; c++) if (occ[c]) base[c].multiplyScalar(1 / occ[c]).lerp(FILM, 0.35);
    return { cellOf, occ, base, dep: new Float32Array(NC), white: new Float32Array(NC), depC: Array.from({ length: NC }, () => new THREE.Color()) };
  }, [galaxy, n]);
  const plates = useMemo(
    () =>
      Array.from({ length: PLATES }, () => ({
        fill: additive("#000"),
        edge: lineMat("#000"),
        grid: lineMat("#000"),
        m: new THREE.Matrix4(),
        pos: new THREE.Vector3(),
        q: new THREE.Quaternion(),
        slide: 0,
        act: 0,
        read: 0,
        tint: new THREE.Color(),
        want: new THREE.Color(),
      })),
    [],
  );
  const groups = useRef<(THREE.Group | null)[]>([]);
  const cellMat = useMemo(() => new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, side: THREE.DoubleSide }), []);
  const cells = useMemo(() => {
    const im = new THREE.InstancedMesh(CELL_SQ, cellMat, NC);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(NC * 3), 3);
    im.frustumCulled = false;
    im.renderOrder = 3;
    return im;
  }, [cellMat]);
  const beams = useMemo(() => new LinePool(MAX_BEAMS, 24), []);
  const cache = useMemo(() => new Map<string, number>(), [galaxy]); // eslint-disable-line react-hooks/exhaustive-deps
  const showered = useMemo(() => new Set<number>(), []);
  const nameRefs = useRef<(Label3DHandle | null)[]>([]);
  const nameGroups = useRef<(THREE.Group | null)[]>([]);
  const nameShown = useRef<string[]>(Array(MAX_NAMES).fill(""));
  const tmp = useMemo(
    () => ({ v: new THREE.Vector3(), w: new THREE.Vector3(), ctrl: new THREE.Vector3(), h: new THREE.Vector3(), c: new THREE.Color(), cm: new THREE.Matrix4(), sm: new THREE.Matrix4(), off: new THREE.Vector3(), one: new THREE.Vector3(1, 1, 1) }),
    [],
  );
  const cellIdx = (name: string) => {
    let i = cache.get(name);
    if (i === undefined) cache.set(name, (i = nodeIndex(galaxy, name)));
    return data.cellOf[i] ?? 0;
  };
  /** cell ci in the archive frame (uses this frame's plate matrices) */
  const cellPos = (ci: number, out: THREE.Vector3) => cellLocal(ci, out).applyMatrix4(plates[Math.floor(ci / CPP)].m);

  useFrame(({ clock }, delta) => {
    const now = performance.now();
    const t = nowS();
    const dt = Math.min(0.05, delta);
    const time = reduced ? 0 : clock.elapsedTime;
    const { occ, base, dep, white, depC } = data;
    const { v, w, ctrl, h, c, cm, sm, off, one } = tmp;
    dep.fill(0);
    white.fill(0);
    for (const pl of plates) {
      pl.act = 0;
      pl.read = 0;
      pl.want.setRGB(0, 0, 0);
    }

    // ---- deposits from graph reads / writes (cells + which plates are being read)
    for (const f of world.flares) {
      const ci = cellIdx(f.node);
      const age = (now - f.start) / 1000;
      const inst = world.instances.get(f.instance);
      const tc = inst ? TRACK_C[inst.type] : FILM;
      const isW = f.op === "write";
      const k = age < 0.25 ? age / 0.25 : Math.exp(-(age - 0.25) * 1.1);
      if (k > dep[ci]) {
        dep[ci] = k;
        depC[ci].copy(isW ? WHITE : tc);
        white[ci] = isW ? 1 : 0;
      }
      const pl = plates[Math.floor(ci / CPP)];
      if (k > pl.act) {
        pl.act = k;
        pl.want.copy(isW ? WHITE : tc);
      }
      // a read pulls its plate out of the stack (held while the read is fresh)
      if (!isW && age < 2.2) pl.read = Math.max(pl.read, age < 0.2 ? age / 0.2 : clamp01((2.2 - age) / 0.8));
    }

    // ---- plates: slide (drawer), glow, matrices
    for (let p = 0; p < PLATES; p++) {
      const pl = plates[p];
      pl.slide += (pl.read - pl.slide) * Math.min(1, dt * (pl.read > pl.slide ? 7 : 2.5));
      plateRest(p, pl.pos, pl.q);
      // out along the plate's own front direction (toward the viewer at rest) and a hair up
      off.set(0, 0.06, SLIDE).applyQuaternion(pl.q).multiplyScalar(easeSlide(pl.slide));
      pl.pos.add(off);
      pl.m.compose(pl.pos, pl.q, one);
      const g = groups.current[p];
      if (g) {
        g.position.copy(pl.pos);
        g.quaternion.copy(pl.q);
      }
      pl.tint.lerp(pl.act > 0.02 ? pl.want : FILM, Math.min(1, dt * 6));
      const tw = reduced ? 1 : 0.9 + 0.1 * Math.sin(time * 0.7 + p * 1.3);
      const a = pl.act;
      pl.edge.color.copy(FILM).lerp(pl.tint, a).multiplyScalar((0.2 + (0.06 * p) / PLATES) * tw + a * 0.75 + pl.slide * 0.2);
      pl.grid.color.copy(FILM).lerp(pl.tint, a).multiplyScalar(0.06 + a * 0.18);
      pl.fill.color.copy(c.set("#4fd1c5")).lerp(pl.tint, a * 0.8).multiplyScalar(0.03 + a * 0.06 + pl.slide * 0.03);
    }

    // ---- tracks agent <-> cell and the write showers
    beams.begin();
    for (const id of showered) {
      let alive = false;
      for (const f of world.flares) if (f.id === id) alive = true;
      if (!alive) showered.delete(id);
    }
    for (const f of world.flares) {
      const ci = cellIdx(f.node);
      const age = (now - f.start) / 1000;
      const inst = world.instances.get(f.instance);
      const tc = inst ? TRACK_C[inst.type] : FILM;
      const isW = f.op === "write";
      cellPos(ci, v);
      graphToStage(v, w);
      if (isW && !showered.has(f.id) && age > 0.55) {
        // the write lands: a shower of bubbles over the cell
        showered.add(f.id);
        burst(w, 12, 0.45, 0.1, WHITE, 1.0, 2.2, t);
        bubbles().emit(w.x, w.y, w.z, 1.2, WHITE, 0.9, 0.5, t, 2);
      }
      // track agent (t=0) <-> cell (t=1): reads flow cell -> agent, writes agent -> cell
      const sp = agentLive(f.instance);
      if (sp && age < 1.9) {
        curl(sp, w, 0.1, ctrl);
        const fade = Math.min(1, age / 0.2) * Math.pow(1 - age / 1.9, 1.5);
        const hd = isW ? Math.min(1, age * 1.6) : 1 - Math.min(1, age * 1.6);
        c.copy(isW ? WHITE : tc).lerp(WHITE, 0.2);
        beams.add(sp, ctrl, w, c, (isW ? 0.32 : 0.24) * fade, 0.03, 0.99, 0, 0, hd, 1.5 * fade);
        if (hd > 0.02 && hd < 0.98) {
          bezier(sp, ctrl, w, hd, h);
          bubbles().emit(h.x, h.y, h.z, 0.45, c, 1.3 * fade, 0.12, t, 1);
        }
      }
    }
    beams.end();

    // ---- cells: occupied cells glow faintly; deposits swell and light them
    const ic = cells.instanceColor!;
    for (let ci = 0; ci < NC; ci++) {
      const d = dep[ci];
      const has = occ[ci] > 0;
      const tw = reduced ? 1 : 0.85 + 0.15 * Math.sin(time * 0.8 + ci * 1.7);
      const sz = has || d > 0.01 ? (0.36 + 0.12 * Math.min(1, occ[ci] / 3) + 0.4 * d) : 0.0001;
      cellLocal(ci, v);
      sm.makeScale(sz * CW, 1, sz * CD).setPosition(v);
      cm.multiplyMatrices(plates[Math.floor(ci / CPP)].m, sm);
      cells.setMatrixAt(ci, cm);
      c.copy(base[ci]).multiplyScalar(has ? (0.3 + 0.15 * Math.min(1, occ[ci] / 3)) * tw : 0);
      if (d > 0.01) {
        c.r += depC[ci].r * d * 1.5 + d * 0.25 * (1 + white[ci]);
        c.g += depC[ci].g * d * 1.5 + d * 0.25 * (1 + white[ci]);
        c.b += depC[ci].b * d * 1.5 + d * 0.25 * (1 + white[ci]);
      }
      ic.setXYZ(ci, c.r, c.g, c.b);
    }
    cells.instanceMatrix.needsUpdate = true;
    ic.needsUpdate = true;

    // ---- name the most recently touched entities (skip duplicates / near cells)
    let shown = 0;
    for (let q = world.flares.length - 1; q >= 0 && shown < MAX_NAMES; q--) {
      const f = world.flares[q];
      if (now - f.start > 2200) break;
      if (f.area) continue;
      let skip = false;
      cellPos(cellIdx(f.node), v);
      for (let z = 0; z < shown; z++) {
        const g0 = nameGroups.current[z];
        if (nameShown.current[z] === f.node || (g0 && Math.abs(g0.position.y - v.y) < 0.55 && Math.abs(g0.position.x - v.x) < 3.2)) skip = true;
      }
      if (skip) continue;
      const el = nameRefs.current[shown];
      const ng = nameGroups.current[shown];
      if (el && ng) {
        ng.position.copy(v);
        if (nameShown.current[shown] !== f.node) {
          el.setText(`${f.op === "write" ? "wrote" : "read"} · ${f.node}`);
          el.setColor(f.op === "write" ? "#ffffff" : "#8fe9f5");
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
      {plates.map((pl, p) => (
        <group key={p} ref={(x) => void (groups.current[p] = x)}>
          <mesh geometry={PLATE_BOX} material={pl.fill} />
          <lineSegments geometry={PLATE_EDGES} material={pl.edge} />
          <lineSegments geometry={PLATE_GRID} material={pl.grid} />
        </group>
      ))}
      <primitive object={cells} />
      <GraphStageSpace>
        <primitive object={beams.obj} />
      </GraphStageSpace>
      {Array.from({ length: MAX_NAMES }, (_, k) => (
        <group key={k} ref={(x) => void (nameGroups.current[k] = x)}>
          <Label3D ref={(x) => void (nameRefs.current[k] = x)} text="" offset={[0, 0.45]} size={0.24} opacity={0} fadeMs={250} pxRange={[8, 12]} />
        </group>
      ))}
      <ArchiveCaption />
    </>
  );
}

/** drawer motion: quick out, settles (0..1) */
const easeSlide = (x: number) => 1 - Math.pow(1 - clamp01(x), 2);

/** "<graph name> · event archive" over the stack (the sim's generic name reads as the FalkorDB it stands for) */
function ArchiveCaption() {
  const w = useWorld();
  const name = w.graphLabel === "knowledge graph" ? "FalkorDB" : w.graphLabel;
  return (
    <Label3D
      declutter="resource"
      position={[0, HALF_H + 0.75, 0]}
      text={`${name} · event archive`}
      color="#5eead4"
      letterSpacing={0.04}
      size={0.28}
      opacity={0.85}
      pxRange={[8, 12]}
    />
  );
}
