/**
 * Label3D - an in-scene text label (troika SDF text via drei <Text>) on a soft rounded plate.
 *
 * Replaces drei <Html> labels: no DOM, no per-label React root, scales with distance (clamped to a px range so
 * it stays legible), takes part in Bloom, and fades/re-texts imperatively through a ref (no React re-renders).
 *
 *   <Label3D text="planner" color="#a78bfa" size={0.22} position={[0, 2, 0]} />
 *   const l = useRef<Label3DHandle>(null);  …  useFrame(() => l.current?.setOpacity(a));  <Label3D ref={l} … />
 *
 * Fonts are bundled (Inter / JetBrains Mono, latin-subset woff, SIL OFL 1.1) so nothing is fetched from a CDN at
 * runtime (the lib build inlines them as data: URLs). Text is sanitized to that subset - symbols like ✓ ▶ ✦ are
 * mapped or dropped - so troika never falls back to its unicode-font-resolver CDN.
 *
 * Many labels: each label = 1 plate draw + 1 draw per text line, zero per-frame allocations, and a label faded
 * to 0 skips drawing entirely. For dynamic sets (graph-node tags etc.) use a fixed pool: render N <Label3D>
 * once, then per frame move `handle.object` (or a wrapper group), `setText`, `setOpacity` (see neural/Cortex.tsx).
 * If draw calls ever matter at 100s of labels, troika's BatchedText (one draw for many texts) is the next step;
 * it needs `troika-three-text` imported directly, which the lib build would then bundle instead of sharing
 * drei's copy - stay on drei <Text> until that's worth it.
 */
import { agentSearchDim } from "./search";
import { Text } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Suspense, useContext, useEffect, useImperativeHandle, useMemo, useRef, type ReactNode, type Ref } from "react";
import * as THREE from "three";
import interUrl from "./fonts/inter-latin-500-normal.woff";
import monoUrl from "./fonts/jetbrains-mono-latin-500-normal.woff";
import { fit } from "./kit/fit";
import { LabelScope, labels, newLabelEntry, registerLabel, unregisterLabel, type LabelKind } from "./kit/labels";
import { STALE_TEXT, idleText, isIdle, isStale, runWait, slotLabel, stepChips, useWorld, waitLabel, type Run } from "./world";

/** kit/dim.ts skips this subtree (the label fades itself) */
const NO_DIM = { kitNoDim: true };
/** camera distance (world units) over which a label fades in: hidden closer than [0], full beyond [1] */
const NEAR_FADE = [1.2, 3.2] as const;

// ------------------------------------------------------------------ types
/** A run of text with its own color (e.g. the active hatchet step). */
export type LabelSeg = { text: string; color?: THREE.ColorRepresentation };
export type LabelLine = string | LabelSeg[];

export interface Label3DHandle {
  /** the positioned outer group - move it freely (pooled labels) */
  readonly object: THREE.Group;
  /** target opacity 0..1 (eased over `fadeMs`); 0 hides the label entirely (no draw calls) */
  setOpacity(o: number, immediate?: boolean): void;
  /** swap text without React (no-op when unchanged); the plate re-sizes when troika finishes */
  setText(text: LabelLine, secondary?: LabelLine | null): void;
  /** accent color (border / bar / underline / leader) */
  setColor(c: THREE.ColorRepresentation): void;
  /** brighter text + stronger border (stands in for bold) */
  setEmphasis(on: boolean): void;
}

export type PlateStyle = "pill" | "tag" | "box" | "bar" | "underline" | "none";

export interface Label3DProps {
  /** main line (string, or colored segments) */
  text: LabelLine;
  /** small dim second line (string or colored segments) */
  secondary?: LabelLine | null;
  /** accent color: plate border / bar / underline */
  color?: THREE.ColorRepresentation;
  /** main text color (default near-white) */
  textColor?: THREE.ColorRepresentation;
  /** default color of the secondary line */
  secondaryColor?: THREE.ColorRepresentation;
  /** font size in world units */
  size?: number;
  /** secondary font size (default size * 0.78) */
  secondarySize?: number;
  opacity?: number;
  /** truncate with … beyond this world width (approximate, by glyph count) */
  maxWidth?: number;
  position?: THREE.Vector3Tuple | THREE.Vector3;
  /** offset in the billboard (screen) plane, world units: [x right, y up] */
  offset?: [number, number];
  /** which point of the plate sits on position+offset */
  anchorX?: "left" | "center" | "right";
  anchorY?: "top" | "middle" | "bottom";
  textAlign?: "left" | "center" | "right";
  plate?: PlateStyle;
  font?: "sans" | "mono";
  uppercase?: boolean;
  /** em units, like CSS letter-spacing in em */
  letterSpacing?: number;
  visible?: boolean;
  /** makes the plate clickable (otherwise the label never intercepts pointer events) */
  onClick?: (e: ThreeEvent<MouseEvent>) => void;
  /** hover in/out of the clickable plate (with onClick) */
  onHover?: (over: boolean) => void;
  /** false (default): drawn on top of the scene; true: occluded by geometry */
  depthTest?: boolean;
  /** 0..1: how much a far label fades, so on-top labels still read as near/far */
  depthFade?: number;
  /** camera distance range for depthFade [start, end] */
  fadeRange?: [number, number];
  renderOrder?: number;
  /** ease time for opacity changes (ms); 0 = instant */
  fadeMs?: number;
  /** clamp the on-screen font size to [min, max] css px; null = pure world scale */
  pxRange?: [number, number] | null;
  /** text brightness multiplier (Bloom: ~1 = soft glow; >1.2 starts to bloom hard) */
  glow?: number;
  /** thin line from the anchor point (position) to the plate (use with `offset`) */
  leader?: boolean;
  /** follow the kit's adaptive fit (fit.label): bigger when few agents, smaller when crowded (still within pxRange) */
  fit?: boolean;
  /**
   * screen-space decluttering (kit/labels.ts): the label's priority class. Default: the slot it is rendered in
   * (agent / run / mcp / backend / graph / cluster / extra). false = never hidden for overlaps.
   */
  declutter?: LabelKind | false;
  ref?: Ref<Label3DHandle>;
  /** text that changes over time (e.g. a job's elapsed timer): re-read ~2x/s and re-texted when it changes */
  live?: (() => LabelLine) | null;
  /** extra objects in billboard space (decorations) */
  children?: ReactNode;
}

// ------------------------------------------------------------------ fonts + text sanitizing
const FONTS = { sans: interUrl, mono: monoUrl } as const;
/** glyphs pre-generated once (troika SDF atlas) so labels never pop in glyph by glyph */
const CHARS = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~·›…\u2014–×•";
/** codepoint coverage of the bundled fontsource "latin" subsets */
const COVERED: [number, number][] = [
  [0x20, 0x7e], [0xa0, 0xff], [0x131, 0x131], [0x152, 0x153], [0x2bb, 0x2bc], [0x2c6, 0x2c6], [0x2da, 0x2da], [0x2dc, 0x2dc],
  [0x2000, 0x206f], [0x20ac, 0x20ac], [0x2122, 0x2122], [0x2191, 0x2191], [0x2193, 0x2193], [0x2212, 0x2212], [0x2215, 0x2215],
];
const covered = (cp: number) => {
  for (const [a, b] of COVERED) if (cp >= a && cp <= b) return true;
  return false;
};
const MAP: Record<string, string> = { "▶": "›", "▸": "›", "→": "›", "⟶": "›", "←": "‹", "✓": "·", "✔": "·", "✕": "×", "✗": "×", "✖": "×", "⋯": "…" };
function sanChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const m = MAP[ch];
    if (m !== undefined) out += m;
    else if (covered(ch.codePointAt(0)!)) out += ch;
  }
  return out;
}
const sanCache = new Map<string, string>();
/** map/drop glyphs the bundled fonts don't have, collapse whitespace, trim stray separators */
export function sanitizeLabel(s: string): string {
  const hit = sanCache.get(s);
  if (hit !== undefined) return hit;
  const out = sanChars(s).replace(/\s+/g, " ").replace(/^[\s·›]+|[\s·›]+$/g, "");
  if (sanCache.size > 2000) sanCache.clear();
  sanCache.set(s, out);
  return out;
}
const clip = (s: string, n: number) => (n > 0 && s.length > n ? s.slice(0, Math.max(1, n - 1)).trimEnd() + "…" : s);

// ------------------------------------------------------------------ shared GPU resources
const PLANE = new THREE.PlaneGeometry(1, 1);
const noRaycast = () => {};
// labels are read like HUD text: never fogged (scene fog would erase far labels on a crowded, zoomed-out stage)
const TEXT_MAT = {
  top: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide }),
  depth: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthTest: true, depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide }),
};
const PLATE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
// rounded-box SDF with an anti-aliased border, optional left accent bar / underline
const PLATE_FRAG = /* glsl */ `
uniform vec2 uSize; uniform float uRadius; uniform float uBorder; uniform float uBar; uniform float uUnder;
uniform vec3 uFill; uniform float uFillA; uniform vec3 uEdge; uniform float uEdgeA; uniform float uOpacity;
varying vec2 vUv;
float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  vec2 p = (vUv - 0.5) * uSize;
  float d = sdBox(p, uSize * 0.5, uRadius);
  float aa = fwidth(d) * 0.75;
  float inside = 1.0 - smoothstep(-aa, aa, d);
  float ring = inside * smoothstep(-uBorder - aa, -uBorder + aa, d) * step(0.00001, uBorder);
  float bar = inside * (1.0 - smoothstep(-aa, aa, p.x + uSize.x * 0.5 - uBar)) * step(0.00001, uBar);
  float under = inside * (1.0 - smoothstep(-aa, aa, p.y + uSize.y * 0.5 - uUnder)) * step(0.00001, uUnder);
  float e = max(max(ring, bar), under);
  vec3 col = mix(uFill, uEdge, e);
  float a = max(inside * uFillA, e * uEdgeA) * uOpacity;
  if (a < 0.002) discard;
  gl_FragColor = vec4(col, a);
}`;

const STYLE: Record<PlateStyle, { fillA: number; edgeA: number; border: number; bar: number; under: number; round: number }> = {
  // border / bar / under in × font size; round in × plate height (0.5 = pill)
  pill: { fillA: 0.52, edgeA: 0.6, border: 0.055, bar: 0, under: 0, round: 0.5 },
  // a near-opaque dark pill with a bold accent border: short-lived callouts (decision labels) that must read on anything
  tag: { fillA: 0.86, edgeA: 0.95, border: 0.085, bar: 0, under: 0, round: 0.5 },
  box: { fillA: 0.62, edgeA: 0.55, border: 0.055, bar: 0, under: 0, round: 0.14 },
  bar: { fillA: 0.66, edgeA: 0.95, border: 0, bar: 0.14, under: 0, round: 0.06 },
  underline: { fillA: 0.52, edgeA: 0.8, border: 0, bar: 0, under: 0.07, round: 0.06 },
  none: { fillA: 0, edgeA: 0, border: 0, bar: 0, under: 0, round: 0 },
};

type Troika = THREE.Mesh & {
  text: string;
  fillOpacity: number;
  colorRanges: Record<number, number> | null;
  textRenderInfo?: { blockBounds: [number, number, number, number] };
  sync(cb?: () => void): void;
};

const BG = new THREE.Color("#03050b");
const WHITE = new THREE.Color("#eef2f8");
const DIM = new THREE.Color("#94a3b8");

/** flatten a line → sanitized string + troika colorRanges (char index → hex) + a change key */
function flattenLine(line: LabelLine | null | undefined, upper: boolean, tmp: THREE.Color) {
  if (line == null) return { text: "", ranges: null as Record<number, number> | null, key: "" };
  if (typeof line === "string") {
    const text = sanitizeLabel(upper ? line.toUpperCase() : line);
    return { text, ranges: null, key: text };
  }
  let text = "";
  let key = "";
  const ranges: Record<number, number> = {};
  for (const seg of line) {
    let t = sanChars(upper ? seg.text.toUpperCase() : seg.text);
    if (!text) t = t.trimStart();
    if (!t) continue;
    const hex = seg.color != null ? tmp.set(seg.color).getHex() : -1;
    if (hex >= 0) ranges[text.length] = hex;
    key += `${t}\u0001${hex}\u0002`;
    text += t;
  }
  return { text: text.trimEnd(), ranges, key };
}

/**
 * The shared run sub-line "hatchet · plan › research › write" as colored segments (current step bright, done
 * steps light, queued dim; a step paused in a wait amber, followed by " · waiting on approval"; an idle run ends with
 * " · idle · 4m"). Runs without Hatchet steps show `fallback` [working, finished, failed?] ("idle · 4m" while idle).
 */
export function runStepsLine(
  run: Run,
  c: { base: string; current: string; done: string; queued?: string },
  fallback: [working: string, done: string, failed?: string] = ["working…", "done"],
): LabelLine {
  const finished = run.status !== "started";
  if (isStale(run)) return [{ text: STALE_TEXT, color: WAIT_COLOR }];
  const idle = !finished && isIdle(run) ? idleText(run) : "";
  if (!run.hasSteps) return [{ text: finished ? (run.status === "failed" ? (fallback[2] ?? "failed") : fallback[1]) : idle || fallback[0], color: c.base }];
  const segs: LabelSeg[] = [{ text: "hatchet · ", color: c.base }];
  const { shown, more } = stepChips(run);
  shown.forEach((st, i) => {
    if (i) segs.push({ text: " › ", color: c.base });
    const state = run.steps[st];
    const paused = state === "running" && !!run.waits[st];
    segs.push({ text: st, color: paused ? WAIT_COLOR : state === "running" ? c.current : state === "done" ? c.done : state === "failed" ? "#ff5d5d" : (c.queued ?? dimHex(c.base)) });
  });
  if (more) segs.push({ text: ` +${more}`, color: c.base });
  const w = finished ? null : runWait(run);
  if (w) segs.push({ text: ` · ${waitLabel(w)}`, color: WAIT_COLOR });
  else if (idle) segs.push({ text: ` · ${idle}`, color: c.base });
  return segs;
}
/** a step paused in a wait (approval, durable sleep) */
export const WAIT_COLOR = "#f59e0b";
const dimTmp = new THREE.Color();
const dimHex = (h: string) => "#" + dimTmp.set(h).lerp(BG, 0.45).getHexString();

// ------------------------------------------------------------------ components
/** Graph/memory caption ("FalkorDB · knowledge graph" when served) - only this re-renders on world changes. */
export function GraphLabel3D({ prefix = "", suffix = "", ...props }: Omit<Label3DProps, "text"> & { prefix?: string; suffix?: string }) {
  const w = useWorld();
  return <Label3D declutter="resource" {...props} text={prefix + w.graphLabel + suffix} />;
}

/** A step slot's caption (`prefix` + its step name, e.g. "gate · plan"); renders nothing until a step lands in the slot. */
export function SlotLabel3D({ run, slot, prefix = "", ...props }: Omit<Label3DProps, "text"> & { run: Run; slot: number; prefix?: string }) {
  useWorld();
  const name = slotLabel(run, slot);
  return name ? <Label3D {...props} text={prefix + name} /> : null;
}

/** In-scene label. Suspends (renders nothing) only until the bundled font is parsed, once per app. */
export function Label3D(props: Label3DProps) {
  return (
    <Suspense fallback={null}>
      <Label3DInner {...props} />
    </Suspense>
  );
}

const DEFAULTS = {
  color: "#818cf8" as THREE.ColorRepresentation,
  size: 0.24,
  opacity: 1,
  maxWidth: 0,
  anchorX: "center" as const,
  anchorY: "middle" as const,
  textAlign: "center" as const,
  plate: "pill" as PlateStyle,
  font: "sans" as const,
  uppercase: false,
  letterSpacing: 0,
  depthTest: false,
  depthFade: 0.22,
  fadeRange: [14, 80] as [number, number],
  renderOrder: 20,
  fadeMs: 0,
  pxRange: [7.5, 15] as [number, number] | null,
  glow: 1,
  leader: false,
  fit: false,
};

function Label3DInner(props: Label3DProps) {
  const p = { ...DEFAULTS, ...stripUndef(props) };
  const P = useRef(p);
  P.current = p; // latest props for imperative/useFrame code (no stale closures)

  const outer = useRef<THREE.Group>(null!);
  const bb = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Group>(null!);
  const plateMesh = useRef<THREE.Mesh>(null!);
  const leaderMesh = useRef<THREE.Mesh>(null);
  const main = useRef<Troika>(null);
  const sub = useRef<Troika>(null);

  // per-label mutable state (never triggers renders)
  const s = useMemo(
    () => ({
      target: p.opacity,
      cur: p.opacity,
      emph: false,
      accent: new THREE.Color(p.color),
      textCol: new THREE.Color(p.textColor ?? WHITE),
      subCol: new THREE.Color(p.secondaryColor ?? DIM),
      mainColor: new THREE.Color(),
      subColor: new THREE.Color(),
      tmp: new THREE.Color(),
      liveAt: 0,
      wp: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      hasSub: false,
      /** declutter: eased visibility factor, secondary line dropped, plate rects (billboard units) */
      dc: 1,
      subOff: false,
      W: 0,
      H: 0,
      bx: 0,
      by: 0,
      W1: 0,
      H1: 0,
      bx1: 0,
      by1: 0,
      ndc: new THREE.Vector3(),
      on: false,
      keyM: "\u0000",
      keyS: "\u0000",
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const mats = useMemo(
    () => ({
      plate: new THREE.ShaderMaterial({
        vertexShader: PLATE_VERT,
        fragmentShader: PLATE_FRAG,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        uniforms: {
          uSize: { value: new THREE.Vector2(1, 1) },
          uRadius: { value: 0.1 },
          uBorder: { value: 0 },
          uBar: { value: 0 },
          uUnder: { value: 0 },
          uFill: { value: BG.clone() },
          uFillA: { value: 0.5 },
          uEdge: { value: new THREE.Color() },
          uEdgeA: { value: 0.5 },
          uOpacity: { value: 1 },
        },
      }),
      leader: new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, fog: false }),
    }),
    [],
  );
  useEffect(() => () => (mats.plate.dispose(), mats.leader.dispose()), [mats]);
  mats.plate.depthTest = p.depthTest;
  mats.leader.depthTest = p.depthTest;

  const api = useMemo(() => {
    const subSize = () => P.current.secondarySize ?? P.current.size * 0.78;
    const maxChars = () => {
      const q = P.current;
      return q.maxWidth > 0 ? Math.max(4, Math.floor(q.maxWidth / (q.size * (q.font === "mono" ? 0.62 : 0.56) * (1 + q.letterSpacing)))) : 0;
    };
    const applyColors = () => {
      const q = P.current;
      const u = mats.plate.uniforms;
      const st = STYLE[q.plate];
      (u.uEdge.value as THREE.Color).copy(s.accent).lerp(WHITE, s.emph ? 0.3 : 0);
      u.uEdgeA.value = Math.min(1, st.edgeA * (s.emph ? 1.45 : 1));
      u.uFillA.value = st.fillA;
      mats.leader.color.copy(s.accent).multiplyScalar(0.85);
      const g = q.glow * (s.emph ? 1.12 : 0.95);
      s.mainColor.copy(s.textCol).multiplyScalar(g);
      s.subColor.copy(s.subCol).multiplyScalar(g);
    };
    /** size the plate to troika's text bounds; place lines, anchor, leader. Also records both plate rects
     *  (with and without the secondary line) for the declutter pass. */
    const layout = () => {
      const m = main.current;
      if (!m || !plateMesh.current || !body.current) return;
      const q = P.current;
      const size = q.size;
      const mb = m.textRenderInfo?.blockBounds;
      const sbb = s.hasSub ? sub.current?.textRenderInfo?.blockBounds : undefined;
      const wM = mb && m.text ? mb[2] - mb[0] : 0;
      const wS = sbb ? sbb[2] - sbb[0] : 0;
      const hM = size * 1.16;
      const st = STYLE[q.plate];
      const bar = st.bar * size;
      const none = q.plate === "none";
      const padY = none ? 0 : size * 0.28;
      const ex = q.offset?.[0] ?? 0;
      const ey = q.offset?.[1] ?? 0;
      // variant 0: as drawn with the secondary line (if any); variant 1: main line only
      let W = 0, H = 0, cw = 0, hS = 0, gap = 0;
      for (let k = 0; k < 2; k++) {
        const withSub = k === 0 && s.hasSub;
        const padX = none ? 0 : size * ((q.plate === "pill" || q.plate === "tag") && !withSub ? 0.6 : 0.5);
        const c = withSub ? Math.max(wM, wS) : wM;
        const hs = withSub ? subSize() * 1.2 : 0;
        const gp = withSub ? size * 0.1 : 0;
        const w = c + padX * 2 + bar;
        const h = hM + gp + hs + padY * 2;
        const bx = ex + (q.anchorX === "left" ? w / 2 : q.anchorX === "right" ? -w / 2 : 0);
        const by = ey + (q.anchorY === "bottom" ? h / 2 : q.anchorY === "top" ? -h / 2 : 0);
        if (k === 0) (s.W = w), (s.H = h), (s.bx = bx), (s.by = by);
        else (s.W1 = s.hasSub ? w : 0), (s.H1 = h), (s.bx1 = bx), (s.by1 = by);
        if ((k === 0) === !(s.hasSub && s.subOff)) (W = w), (H = h), (cw = c), (hS = hs), (gap = gp);
      }
      const u = mats.plate.uniforms;
      (u.uSize.value as THREE.Vector2).set(W, H);
      u.uRadius.value = Math.min(H * st.round, H * 0.5);
      u.uBorder.value = st.border * size;
      u.uBar.value = bar;
      u.uUnder.value = st.under * size;
      plateMesh.current.scale.set(Math.max(W, 1e-4), Math.max(H, 1e-4), 1);
      plateMesh.current.visible = !none && cw > 0;
      const tx = q.textAlign === "left" ? -cw / 2 + bar / 2 : q.textAlign === "right" ? cw / 2 + bar / 2 : bar / 2;
      const yM = H / 2 - padY - hM / 2;
      m.position.set(tx, yM, 0.001);
      if (sub.current) {
        sub.current.position.set(tx, yM - hM / 2 - gap - hS / 2, 0.001);
        sub.current.visible = s.hasSub && !s.subOff;
      }
      body.current.position.set(ex + (q.anchorX === "left" ? W / 2 : q.anchorX === "right" ? -W / 2 : 0), ey + (q.anchorY === "bottom" ? H / 2 : q.anchorY === "top" ? -H / 2 : 0), 0);
      const ld = leaderMesh.current;
      if (ld) {
        const len = Math.hypot(ex, ey);
        ld.visible = len > 1e-3;
        ld.position.set(ex / 2, ey / 2, 0);
        ld.rotation.z = Math.atan2(ey, ex);
        ld.scale.set(Math.max(len, 1e-4), size * 0.05, 1);
      }
    };
    const setLines = (t: LabelLine, sec: LabelLine | null | undefined) => {
      const m = main.current;
      const sm = sub.current;
      if (!m) return;
      const q = P.current;
      const n = maxChars();
      const fm = flattenLine(t, q.uppercase, s.tmp);
      const fs = flattenLine(sec, q.uppercase, s.tmp);
      const km = `${fm.key}|${n}`;
      const ks = `${fs.key}|${n}`;
      if (km !== s.keyM) {
        s.keyM = km;
        m.text = clip(fm.text, n);
        m.colorRanges = fm.ranges;
        m.sync();
      }
      if (sm && ks !== s.keyS) {
        s.keyS = ks;
        const ss = clip(fs.text, n ? Math.round((n * q.size) / subSize()) : 0);
        s.hasSub = !!ss;
        sm.visible = s.hasSub && !s.subOff;
        sm.text = ss;
        sm.colorRanges = fs.ranges;
        sm.sync();
      }
    };
    return { applyColors, layout, setLines };
  }, [mats, s]);

  // troika fires `synccomplete` after every (re)layout → size the plate then
  useEffect(() => {
    const ms = [main.current, sub.current].filter(Boolean) as Troika[];
    const on = () => api.layout();
    for (const m of ms) m.addEventListener("synccomplete" as never, on);
    api.applyColors();
    api.setLines(P.current.text, P.current.secondary);
    api.layout();
    return () => {
      for (const m of ms) m.removeEventListener("synccomplete" as never, on);
    };
  }, [api]);

  // declarative prop changes
  const tKey = flattenLine(p.text, p.uppercase, s.tmp).key;
  const sKey = flattenLine(p.secondary, p.uppercase, s.tmp).key;
  useEffect(() => api.setLines(P.current.text, P.current.secondary), [api, tKey, sKey, p.uppercase, p.maxWidth, p.size]);
  useEffect(() => {
    s.accent.set(P.current.color);
    s.textCol.set(P.current.textColor ?? WHITE);
    s.subCol.set(P.current.secondaryColor ?? DIM);
    api.applyColors();
  }, [api, s, p.color, p.textColor, p.secondaryColor, p.glow, p.plate]);
  useEffect(() => void (s.target = p.opacity), [s, p.opacity]);
  useEffect(() => api.layout(), [api, p.size, p.plate, p.anchorX, p.anchorY, p.textAlign, p.offset?.[0], p.offset?.[1]]);

  useImperativeHandle(
    p.ref,
    () => ({
      get object() {
        return outer.current;
      },
      setOpacity(o: number, immediate = false) {
        s.target = o;
        if (immediate) s.cur = o;
      },
      setText(t: LabelLine, sec?: LabelLine | null) {
        api.setLines(t, sec ?? null);
      },
      setColor(c: THREE.ColorRepresentation) {
        s.tmp.set(c);
        if (!s.tmp.equals(s.accent)) s.accent.copy(s.tmp), api.applyColors();
      },
      setEmphasis(on: boolean) {
        if (on !== s.emph) (s.emph = on), api.applyColors();
      },
    }),
    [api, s],
  );

  // declutter registry entry (kind from the slot this label renders in, unless overridden)
  const scope = useContext(LabelScope);
  const entry = useMemo(
    () => (p.declutter === false ? null : newLabelEntry(p.declutter ?? scope.kind, scope.agent, p.size)),
    [p.declutter, scope, p.size],
  );
  useEffect(() => {
    if (!entry) return;
    registerLabel(entry);
    return () => unregisterLabel(entry);
  }, [entry]);

  useFrame(({ camera, size: vp }, dt) => {
    const o = outer.current;
    const b = bb.current;
    if (!o || !b) return;
    const q = P.current;
    if (q.live) {
      const t = performance.now();
      if (t - s.liveAt > 500) (s.liveAt = t), api.setLines(q.live(), q.secondary ?? null);
    }
    if (s.cur !== s.target) {
      if (q.fadeMs <= 0) s.cur = s.target;
      else {
        s.cur += (s.target - s.cur) * Math.min(1, (dt * 1000) / q.fadeMs);
        if (Math.abs(s.target - s.cur) < 0.004) s.cur = s.target;
      }
    }
    // declutter: ease toward the pass's verdict; apply a dropped / restored secondary line
    const e = entry;
    if (e) {
      const want = labels.active ? e.show : 1;
      s.dc += (want - s.dc) * Math.min(1, dt / 0.12);
      if (Math.abs(want - s.dc) < 0.01) s.dc = want;
      const off = labels.active ? e.subOff : false;
      if (off !== s.subOff && s.hasSub) (s.subOff = off), api.layout();
      e.live = false;
    }
    if (e) {
      e.drawn = false;
      // (re)appearing: note when (newest decision labels win), and show right away instead of waiting for a pass
      const on = s.cur > 0.004 && o.visible;
      if (on && !s.on) {
        e.born = performance.now();
        if (e.kind === "decision") (e.show = 1), (s.dc = 1);
      }
      s.on = on;
    }
    if (s.cur <= 0.004 || !o.visible) {
      b.visible = false;
      return;
    }
    // billboard: undo the parents' world rotation, then face the camera
    o.getWorldPosition(s.wp);
    o.getWorldQuaternion(s.q);
    // world size -> clamp to a css-px range; undo parent scale so `size` stays world units
    const dist = s.wp.distanceTo(camera.position);
    // kit fit: world size follows fit.label (few agents = bigger labels), then the px clamp applies
    const fk = q.fit ? fit.label : 1;
    let sc = fk;
    const pc = camera as THREE.PerspectiveCamera;
    const oc = camera as THREE.OrthographicCamera;
    const worldPerPx = pc.isPerspectiveCamera
      ? (2 * dist * Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2)) / (pc.zoom * vp.height)
      : (oc.top - oc.bottom) / (oc.zoom * vp.height);
    if (q.pxRange) {
      const px = (q.size * fk) / Math.max(worldPerPx, 1e-6);
      const k = labels.pxk;
      sc = (THREE.MathUtils.clamp(px, q.pxRange[0] * k, q.pxRange[1] * k) / px) * fk;
    }
    // project the plate for the declutter pass (only on pass frames, only when really on screen)
    if (e && labels.due && visibleChain(o)) {
      s.ndc.copy(s.wp).project(camera);
      if (s.ndc.z < 1 && s.ndc.z > -1) {
        const kpx = sc / Math.max(worldPerPx, 1e-6);
        const cx = ((s.ndc.x + 1) / 2) * vp.width;
        const cy = ((1 - s.ndc.y) / 2) * vp.height;
        e.x = cx + s.bx * kpx;
        e.y = cy - s.by * kpx;
        e.w = s.W * kpx;
        e.h = s.H * kpx;
        e.x1 = cx + s.bx1 * kpx;
        e.y1 = cy - s.by1 * kpx;
        e.w1 = s.W1 * kpx;
        e.h1 = s.H1 * kpx;
        e.live = e.w > 1 && e.x + e.w / 2 > 0 && e.x - e.w / 2 < vp.width && e.y + e.h / 2 > 0 && e.y - e.h / 2 < vp.height;
        e.clip = e.x - e.w / 2 < -2 || e.x + e.w / 2 > vp.width + 2 || e.y - e.h / 2 < -2 || e.y + e.h / 2 > vp.height + 2;
        e.ax = s.wp.x;
        e.ay = s.wp.y;
        e.az = s.wp.z;
        e.ox0 = e.x - e.w / 2 - cx;
        e.ox1 = e.x + e.w / 2 - cx;
        e.oy0 = e.y - e.h / 2 - cy;
        e.oy1 = e.y + e.h / 2 - cy;
        if (e.w > 1) e.seen = performance.now();
      }
    }
    // a finished agent's label dims with it (kit dim); its slot's other meshes are dimmed by kit/dim.ts
    const ag = scope.agent;
    // labels right in front of the camera fade out (never a giant glyph across the screen when the view passes one)
    const near = THREE.MathUtils.smoothstep(dist, NEAR_FADE[0], NEAR_FADE[1]);
    const sd = ag ? agentSearchDim(ag.id) : scope.dim ? scope.dim() : 0; // scene search: non-matches dim
    const a = near * s.cur * s.dc * (ag ? 1 - 0.55 * ag.dim : 1) * (1 - 0.6 * sd) * (1 - q.depthFade * THREE.MathUtils.smoothstep(dist, q.fadeRange[0], q.fadeRange[1]));
    if (a <= 0.004) {
      b.visible = false;
      return;
    }
    b.visible = true;
    if (e) e.drawn = a > 0.05 && visibleChain(o.parent);
    b.quaternion.copy(s.q.invert()).multiply(camera.quaternion);
    b.scale.setScalar(sc / (o.matrixWorld.getMaxScaleOnAxis() || 1));
    mats.plate.uniforms.uOpacity.value = a;
    mats.leader.opacity = a * 0.65;
    if (main.current) main.current.fillOpacity = a;
    if (sub.current) sub.current.fillOpacity = a * 0.92;
  });

  const tm = p.depthTest ? TEXT_MAT.depth : TEXT_MAT.top;
  const clickable = !!p.onClick;
  return (
    <group ref={outer} position={p.position} visible={p.visible ?? true} userData={NO_DIM}>
      <group ref={bb} visible={false}>
        {p.leader && <mesh ref={leaderMesh} geometry={PLANE} material={mats.leader} renderOrder={p.renderOrder} raycast={noRaycast} />}
        <group ref={body}>
          <mesh
            ref={plateMesh}
            geometry={PLANE}
            material={mats.plate}
            renderOrder={p.renderOrder}
            raycast={clickable ? THREE.Mesh.prototype.raycast : noRaycast}
            onClick={p.onClick}
            onPointerOver={clickable ? () => ((document.body.style.cursor = "pointer"), p.onHover?.(true)) : undefined}
            onPointerOut={clickable ? () => ((document.body.style.cursor = ""), p.onHover?.(false)) : undefined}
          />
          <Text
            ref={main as never}
            font={FONTS[p.font]}
            characters={CHARS}
            fontSize={p.size}
            letterSpacing={p.letterSpacing}
            anchorX={p.textAlign}
            anchorY="middle"
            material={tm}
            renderOrder={p.renderOrder + 1}
            raycast={noRaycast}
            color={s.mainColor}
          >
            {""}
          </Text>
          <Text
            ref={sub as never}
            font={FONTS[p.font]}
            characters={CHARS}
            fontSize={p.secondarySize ?? p.size * 0.78}
            letterSpacing={p.letterSpacing}
            anchorX={p.textAlign}
            anchorY="middle"
            material={tm}
            renderOrder={p.renderOrder + 1}
            raycast={noRaycast}
            color={s.subColor}
            visible={false}
          >
            {""}
          </Text>
          {p.children}
        </group>
      </group>
    </group>
  );
}

/** the object and all its ancestors are visible (a label under a hidden group takes no screen room) */
function visibleChain(o: THREE.Object3D | null) {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}

function stripUndef<T extends object>(o: T): T {
  const r = {} as T;
  for (const k in o) if (o[k] !== undefined) r[k] = o[k];
  return r;
}
