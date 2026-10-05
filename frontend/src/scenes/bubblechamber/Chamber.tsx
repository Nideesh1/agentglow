/**
 * The chamber itself: a near-black liquid lit from behind (faint teal glow, animated film grain) and, in front of
 * it, the TANK: an elliptic glass cylinder round the core whose axis is the magnetic field (stage z). Steel window
 * rims front and back with fiducial crosses on both windows, faint longitudinal staves and a fresnel glass skin,
 * two copper field coils round the ends and a "B" arrow along the axis, so orbiting the camera reads as a volume.
 * Inside: old beam tracks at different depths, now and then a stray low-energy spiral (cosmic background) and
 * <Bubbles/>, the one Points draw that renders every bubble in the scene.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D } from "../shared/Label3D";
import { kit } from "../shared/kit";
import { FILM, bubbles, deltaRay, lineMat, nowS, reduced, tank } from "./fx";

// the back-lit liquid is a camera-facing quad behind the stage (any orbit angle): its look is in quad-local units
const backVert = /* glsl */ `varying vec2 vW; void main(){ vW = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const backFrag = /* glsl */ `
uniform float uTime; varying vec2 vW;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
void main(){
  float r = length(vW * vec2(0.85, 1.0));
  // back-lit chamber: a soft cool glow in the middle, deep blue-black at the edges
  vec3 col = mix(vec3(0.010, 0.030, 0.036), vec3(0.003, 0.007, 0.012), smoothstep(4.0, 46.0, r));
  // emulsion: very low-frequency blotches
  float b = n(vW * 0.07) * 0.6 + n(vW * 0.19 + 3.0) * 0.4;
  col *= 0.8 + 0.45 * b;
  // film grain (screen space, animated)
  float g = h(gl_FragCoord.xy + fract(uTime * 7.31) * 113.0) - 0.5;
  col += vec3(0.006, 0.011, 0.013) * g * 2.0;
  gl_FragColor = vec4(col, 1.0);
}`;

// glass skin: brighter where the surface turns away from the eye (fresnel), so the cylinder's silhouette shows
// from any angle while its face toward the camera stays clear; a few horizontal "reflections" bands
const glassVert = /* glsl */ `
varying vec3 vN; varying vec3 vV; varying float vZ;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vZ = position.y;
  gl_Position = projectionMatrix * mv;
}`;
const glassFrag = /* glsl */ `
uniform vec3 uC; varying vec3 vN; varying vec3 vV; varying float vZ;
void main(){
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float k = pow(f, 4.0) * 0.8 + 0.012;
  // faint streaks along the axis (the steel staves' reflections in the glass)
  k *= 0.85 + 0.15 * smoothstep(0.6, 1.0, abs(vZ));
  gl_FragColor = vec4(uC * k, 1.0);
}`;

const TAU = Math.PI * 2;
/** unit-space tank outline (ellipse radius 1, z -1..1): window rims, staves, coils (scaled by rx, ry, hz) */
function tankGeometry() {
  const ring = (v: number[], r: number, z: number, n = 128) => {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * TAU;
      const a1 = ((i + 1) / n) * TAU;
      v.push(Math.cos(a0) * r, Math.sin(a0) * r, z, Math.cos(a1) * r, Math.sin(a1) * r, z);
    }
  };
  // steel: window rims (double, a flange) front and back + a few thin hoops along the length
  const steel: number[] = [];
  for (const z of [-1, 1]) {
    ring(steel, 1, z);
    ring(steel, 1.045, z);
    ring(steel, 1.045, z * 0.97);
  }
  // longitudinal staves: short ticks at the rims + a dotted line along the barrel
  const staves: number[] = [];
  const S = 24;
  for (let i = 0; i < S; i++) {
    const a = (i / S) * TAU;
    const x = Math.cos(a) * 1.045;
    const y = Math.sin(a) * 1.045;
    for (let k = 0; k < 40; k++) {
      if (k % 2) continue;
      const z0 = -1 + (k / 40) * 2;
      const z1 = -1 + ((k + 1) / 40) * 2;
      staves.push(x, y, z0, x, y, z1);
    }
  }
  for (const z of [-0.34, 0.34]) ring(staves, 1.045, z, 96);
  // magnet coils round the two ends (Helmholtz pair): a few windings each
  const coils: number[] = [];
  for (const zc of [-0.72, 0.72]) for (let w = 0; w < 4; w++) ring(coils, 1.1 + (w % 2) * 0.025, zc + (w - 1.5) * 0.035, 128);
  // old beam tracks: enter along x (across the field) at many depths, curling gently in their xy plane
  const beams: number[] = [];
  let seed = 9001;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 14; k++) {
    const y0 = -0.85 + rnd() * 1.7;
    const z = -0.92 + rnd() * 1.84;
    const R = (6 + rnd() * 14) * (rnd() < 0.5 ? 1 : -1);
    const step = 0.012;
    for (let x = -1.1; x < 1.1; x += step) {
      if (rnd() < 0.42) continue; // dotted
      const x1 = x + step * 0.45;
      const yA = y0 + (x * x) / (2 * R);
      const yB = y0 + (x1 * x1) / (2 * R);
      // only inside the window ellipse
      if (x * x + yA * yA > 0.97 || x1 * x1 + yB * yB > 0.97) continue;
      beams.push(x, yA, z, x1, yB, z);
    }
  }
  const g = (v: number[]) => new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  return { steel: g(steel), staves: g(staves), coils: g(coils), beams: g(beams) };
}

/** fiducial crosses on both windows (built in world xy so they stay square; z = +-1, scaled by hz) */
function fiducials(rx: number, ry: number) {
  const v: number[] = [];
  const a = 0.26;
  const sp = 3;
  for (let x = -Math.floor(rx / sp) * sp; x <= rx; x += sp)
    for (let y = -Math.floor(ry / sp) * sp; y <= ry; y += sp) {
      if ((x / rx) ** 2 + (y / ry) ** 2 > 0.86) continue;
      for (const z of [-1, 1]) v.push(x - a, y, z, x + a, y, z, x, y - a, z, x, y + a, z);
    }
  return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
}

/** the field arrow along the axis (unit length 2 along z, arrowhead at +z) */
const ARROW_GEO = (() => {
  const v: number[] = [];
  for (let k = 0; k < 24; k++) if (k % 2 === 0) v.push(0, 0, -1 + (k / 24) * 2, 0, 0, -1 + ((k + 1) / 24) * 2);
  v.push(0, 0, 1, 0.09, 0, 0.84, 0, 0, 1, -0.09, 0, 0.84, 0, 0, 1, 0, 0.09, 0.84, 0, 0, 1, 0, -0.09, 0.84);
  return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
})();

export function Chamber() {
  const geo = useMemo(tankGeometry, []);
  const mats = useMemo(
    () => ({
      back: new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 } }, vertexShader: backVert, fragmentShader: backFrag, depthWrite: false }),
      steel: lineMat(new THREE.Color("#9fd8e0").multiplyScalar(0.15)),
      staves: lineMat(new THREE.Color("#7cc6d0").multiplyScalar(0.07)),
      coils: lineMat(new THREE.Color("#d79a52").multiplyScalar(0.12)),
      beams: lineMat(new THREE.Color("#8fdcea").multiplyScalar(0.07)),
      fid: lineMat(new THREE.Color("#4fd1c5").multiplyScalar(0.22)),
      arrow: lineMat(new THREE.Color("#d79a52").multiplyScalar(0.45)),
      glass: new THREE.ShaderMaterial({
        uniforms: { uC: { value: new THREE.Color("#6fd3e0").multiplyScalar(0.075) } },
        vertexShader: glassVert,
        fragmentShader: glassFrag,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    }),
    [],
  );
  const glassGeo = useMemo(() => new THREE.CylinderGeometry(1.045, 1.045, 2, 96, 1, true).rotateX(Math.PI / 2), []);
  const fid = useRef<THREE.BufferGeometry | null>(null);
  const fidObj = useRef<THREE.LineSegments>(null);
  const fidKey = useRef("");
  useEffect(() => () => fid.current?.dispose(), []);
  const next = useRef(0);
  const back = useRef<THREE.Mesh>(null);
  const body = useRef<THREE.Group>(null);
  const fidG = useRef<THREE.Group>(null);
  const arrow = useRef<THREE.Group>(null);
  const bLab = useRef<THREE.Group>(null);
  const init = useRef(false);
  useFrame(({ clock, camera }, delta) => {
    mats.back.uniforms.uTime.value = reduced ? 0 : clock.elapsedTime;
    if (back.current) {
      // 14 units behind the stage centre as seen from the camera, facing it
      camera.getWorldDirection(_d);
      back.current.position.copy(_d).multiplyScalar(14);
      back.current.quaternion.copy(camera.quaternion);
    }
    // ---- the tank follows the core (eased; the core itself only resizes on a >8% change)
    const c = kit.core;
    const rx = c.hw + 0.9;
    const ry = c.hh + 0.9;
    // a deep drum: orbiting to the side shows a real volume, not a coin; deep enough for the 3D subagent trees
    let wMax = 0;
    for (const a of kit.agents.values()) wMax = Math.max(wMax, Math.abs(a.w));
    const hz = Math.max(THREE.MathUtils.clamp(0.72 * Math.min(rx, ry), 5, 13), wMax + 2);
    const k = init.current ? Math.min(1, delta * 2.5) : 1;
    init.current = true;
    tank.rx += (rx - tank.rx) * k;
    tank.ry += (ry - tank.ry) * k;
    tank.hz += (hz - tank.hz) * k;
    body.current?.scale.set(tank.rx, tank.ry, tank.hz);
    fidG.current?.scale.set(1, 1, tank.hz);
    const key = `${Math.round(tank.rx * 2)}:${Math.round(tank.ry * 2)}`;
    if (key !== fidKey.current && fidObj.current) {
      fidKey.current = key;
      fid.current?.dispose();
      fid.current = fiducials(tank.rx, tank.ry);
      fidObj.current.geometry = fid.current;
    }
    // field arrow: along the top of the barrel, just outside it
    if (arrow.current) {
      arrow.current.position.set(0, tank.ry * 1.13 + 0.25, 0);
      arrow.current.scale.set(1, 1, tank.hz * 0.55);
    }
    bLab.current?.position.set(0, tank.ry * 1.13 + 0.62, tank.hz * 0.55);

    // cosmic background: a faint stray spiral somewhere in the tank every couple of seconds
    const t = nowS();
    if (reduced || t < next.current) return;
    next.current = t + 1.4 + Math.random() * 2.2;
    const a = Math.random() * TAU;
    const r = Math.sqrt(Math.random()) * 0.85;
    _p.set(Math.cos(a) * r * tank.rx, Math.sin(a) * r * tank.ry, (Math.random() - 0.5) * 1.7 * tank.hz);
    const big = Math.random() < 0.3;
    const sg = Math.random() < 0.5 ? 1 : -1;
    deltaRay(_p, Math.random() * TAU, big ? 0.9 + Math.random() * 0.8 : 0.3 + Math.random() * 0.4, big ? 2.4 : 1.6, big ? 70 : 30, 0.075, FILM, 0.3, 6, t, sg, sg * (big ? 1.4 : 0.6));
  });
  return (
    <>
      <mesh ref={back} material={mats.back} position={[0, 0, -14]} renderOrder={-10} frustumCulled={false}>
        <planeGeometry args={[700, 500]} />
      </mesh>
      <group ref={body}>
        <mesh geometry={glassGeo} material={mats.glass} renderOrder={-5} frustumCulled={false} />
        <lineSegments geometry={geo.steel} material={mats.steel} frustumCulled={false} />
        <lineSegments geometry={geo.staves} material={mats.staves} frustumCulled={false} />
        <lineSegments geometry={geo.coils} material={mats.coils} frustumCulled={false} />
        <lineSegments geometry={geo.beams} material={mats.beams} frustumCulled={false} />
      </group>
      <group ref={fidG}>
        <lineSegments ref={fidObj} material={mats.fid} frustumCulled={false} />
      </group>
      <group ref={arrow}>
        <lineSegments geometry={ARROW_GEO} material={mats.arrow} frustumCulled={false} />
      </group>
      <group ref={bLab}>
        <Label3D text="B field" color="#e0a868" size={0.26} plate="none" opacity={0.75} pxRange={[9, 12]} />
      </group>
    </>
  );
}
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();

/** The single Points draw for every bubble / flash; uploads last frame's writes before anything emits this frame. */
export function Bubbles() {
  const { size, gl, camera } = useThree();
  const pool = useMemo(() => bubbles(), []);
  useFrame(() => {
    pool.flush();
    pool.mat.uniforms.uTime.value = nowS();
    pool.setScale(size.height, gl.getPixelRatio(), (camera as THREE.PerspectiveCamera).fov);
  }, -1);
  return <primitive object={pool.obj} />;
}
