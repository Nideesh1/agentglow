/**
 * Adaptive fit: agent size, local spacing, label size and camera framing follow the number of visible agents
 * (after auto-grouping) and the FREE canvas area (canvas minus the HUD panels).
 *
 *   fit.scale   agent size multiplier: few agents = big, many = smaller, ~ sqrt(nRef / n), clamped per theme.
 *               KitAgent.scale = roleScale(inst) * fit.scale, so parents stay bigger than subagents.
 *   fit.spread  local spacing multiplier (fan length, sibling gaps) so bigger agents never touch.
 *   fit.label   label size multiplier (Label3D `fit` prop, still clamped by its pxRange).
 *   camera      <FitCamera/> dollies the camera so every kit-placed thing fits the free area, and shifts the
 *               projection centre (camera.setViewOffset) into the middle of the free area: agents are centred
 *               in what you can see, never under a HUD panel. Re-fits on resize/embedding; keeps the user's zoom.
 *
 * Calm camera (one committed target for distance, projection shift AND fit.scale, so they move together):
 *   batch      a spawn / exit / grouping / resource change (or a `task` tool call: a subagent is coming) restarts a
 *              quiet window; the target is only re-committed once content has been quiet BATCH_QUIET_MS (or
 *              BATCH_MAX_MS after it first needed more room), then ONE ease-in-out move (OUT_MS).
 *   asymmetric zoom OUT (content needs >OUT_BAND more distance) right after the batch window, to the largest
 *              fit seen in it; zoom IN only when the gain is > IN_BAND and content has been stable IN_STABLE_MS,
 *              slowly (IN_MS). Between the bands nothing moves (hysteresis: no oscillation). Exiting agents keep
 *              counting until faded, so an exit never zooms in right away.
 *   node cap   FitProfile.maxNode: never closer than the distance at which the largest agent's framed diameter is
 *              that fraction of the viewport height (a lone service is not a sun filling half the screen). A floor
 *              only: busy scenes are framed by their spread well beyond it.
 *   first      the first content after an empty scene is framed right away (zoom in or out, one OUT_MS move), so a
 *              run never stays small at the theme's start distance.
 *   clipped    content (or a framed label) that ends up under a HUD panel / off the canvas at the current framing
 *              (it grew or moved within the bands) counts as "needs zoom-out": same batch window, one move that
 *              also re-centres the projection shift.
 *   user       orbit / zoom / pan suspends auto-refit for USER_HOLD_MS (the user's zoom factor is kept). A manual
 *              zoom OUT sticks: auto-fit may re-centre or zoom further out, but never pulls the camera back in past
 *              the user's distance, until "Fit all" (F, HUD button, double-click on empty space) resets it.
 *   fit all    fitAll(): frames EVERYTHING (every run, cluster, graph sphere, MCP server; not capped by
 *              FitProfile.maxRadius), drops the user's zoom factor and ends a search fly-to; auto-fit then keeps
 *              framing everything.
 *   limits     OrbitControls.maxDistance follows the content (>= 400, 4x the committed fit, 2x the fit-all distance),
 *              so neither the user nor auto-fit hits a fixed cap; camera.far and scene fog follow a manual zoom-out.
 *   resize     re-fits quickly (RESIZE_MS); reduced motion snaps.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { labels, visitLabelRects, type LabelEntry } from "./labels";
import { world } from "../world";
import { kit, reduced } from "./state";

export type FitProfile = {
  /** weighted visible agent count at which scale = 1 (parents count 1, subagents 0.5, clusters 1.5) */
  nRef: number;
  /** clamp for fit.scale */
  min: number;
  max: number;
  /** framing never goes tighter than this half-extent (world units): 1 agent doesn't fill the screen edge to edge */
  minRadius: number;
  /** ...nor wider than this */
  maxRadius: number;
  /** breathing room around the framed content (multiplier) */
  margin: number;
  /**
   * largest on-screen agent: its framed diameter (2 * agentRadius * scale) never exceeds this fraction of the
   * viewport height, so one or two nodes sit at a normal size with room around them instead of filling the screen.
   * Only ever zooms OUT (a minimum camera distance); many agents are framed by their spread long before this binds.
   */
  maxNode: number;
};

/**
 * Search fly-to (search.ts): while `fly.on`, FitCamera eases the orbit target to the focused point (followed while it
 * moves) and the distance to one at which it fills ~FLY_FRAC of the viewport height, centred in the free area;
 * flyHome() eases back to the target, distance and projection shift the fit wants. One ease of FLY_MS each way.
 * Orbit / zoom by the user still works meanwhile (it does not change the remembered zoom factor).
 */
export const fly = {
  on: false,
  /** 0..1 progress (eased in FitCamera) */
  k: 0,
  get: null as null | (() => THREE.Vector3 | undefined),
  radius: (() => 1) as () => number,
  home: new THREE.Vector3(),
  homeSet: false,
  /** smoothed focus point (world) */
  at: new THREE.Vector3(),
};
const FLY_MS = 900;
const FLY_FRAC = 0.22;
export function flyTo(get: () => THREE.Vector3 | undefined, radius: () => number) {
  fly.get = get;
  fly.radius = radius;
  fly.on = true;
}
export function flyHome() {
  fly.on = false;
}

/** "Fit all" requests (F, HUD button, double-click on empty space); FitCamera serves them on its next frame. */
export const fitAllReq = { n: 0 };
export function fitAll() {
  fitAllReq.n++;
  flyHome();
}
/** OrbitControls.maxDistance never goes below this */
export const MIN_MAX_DISTANCE = 400;

/** default FitProfile.maxNode: an agent's framed diameter is at most 8% of the viewport height */
export const MAX_NODE_FRAC = 0.08;

export const DEFAULT_FIT: FitProfile = { nRef: 4, min: 0.6, max: 1.6, minRadius: 5, maxRadius: 80, margin: 1.12, maxNode: MAX_NODE_FRAC };

export const fit = {
  scale: 1,
  spread: 1,
  label: 1,
  /** weighted visible agent count used for the current target */
  n: 0,
  profile: { ...DEFAULT_FIT } as FitProfile,
  /** canvas css px + HUD insets (px) measured by FitCamera */
  w: 1600,
  h: 900,
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  /** free-area aspect (w/h after insets): presets use it to stretch layouts to the visible shape */
  aspect: 16 / 9,
  /**
   * camera framing: `dist` = current camera distance to the orbit target (read it for fog / LOD instead of
   * camera.position), `want` = committed fitted distance before the user's zoom factor `user`, `fit` = the
   * instantaneous fit (what `want` would be with no batching / hysteresis); `points` = framed points
   */
  cam: { want: 0, fit: 0, dist: 0, user: 1, points: 0 },
  /** how much of the free area the content's screen bounds fill [x, y] (debug / verification) */
  fill: [0, 0] as [number, number],
  /** largest framed agent radius (world) seen by the last framing pass (kitExtents): drives FitProfile.maxNode */
  nodeR: 0,
  /** world units per css px at the fitted camera distance (px-clamped labels: world size = px * wpp) */
  wpp: 0.05,
  /** screen shrink of a stage "up" (b) step: 1 for xy stages, |sin(elevation)| for a tilted xz ground plane */
  foreshorten: 1,
};

export function setFitProfile(p: Partial<FitProfile>) {
  fit.profile = { ...DEFAULT_FIT, ...p };
  target = -1;
}

let target = -1;
let lastSig = NaN;
/** scale tween (follows FitCamera's commits) */
const tw = { from: 1, t0: 0, dur: 0 };
const scaleFor = (n: number) => THREE.MathUtils.clamp(Math.sqrt(fit.profile.nRef / Math.max(1, n)), fit.profile.min, fit.profile.max);
/** ease-in-out (smoothstep) 0..1 */
const inOut = (u: number) => u * u * (3 - 2 * u);

/** content timing shared with FitCamera: `nLive` = latest weighted count, `activityAt` = last content change */
export const fitClock = { nLive: 0, activityAt: -1e9 };

/**
 * Once per frame (kitTick): records the weighted count + content signature (`sig` changes on any spawn / exit /
 * fade-out / grouping / resource change) and plays the committed scale tween. The scale TARGET only moves when
 * FitCamera commits a new framing (fitCommit), so agents don't pulse in size per spawn.
 */
export function fitTick(now: number, weightedN: number, sig = weightedN) {
  fitClock.nLive = weightedN;
  if (sig !== lastSig) {
    if (!Number.isNaN(lastSig)) fitClock.activityAt = now;
    lastSig = sig;
  }
  if (target < 0) {
    fit.n = weightedN;
    target = scaleFor(weightedN);
    fit.scale = target;
    tw.dur = 0;
  }
  const u = tw.dur > 0 ? Math.min(1, (now - tw.t0) / tw.dur) : 1;
  fit.scale = tw.from + (target - tw.from) * inOut(u);
  if (u >= 1) fit.scale = target;
  fit.spread = Math.max(0.85, Math.pow(fit.scale, 0.8));
  fit.label = THREE.MathUtils.clamp(Math.pow(fit.scale, 0.5), 0.85, 1.25);
}

/** would a commit now change the scale target (6% hysteresis)? */
const scaleMoves = () => target > 0 && Math.abs(scaleFor(fitClock.nLive) - target) / target > 0.06;

/** FitCamera commits a new framing: the scale target follows (6% hysteresis). */
function fitCommit(now: number, durMs: number) {
  fit.n = fitClock.nLive;
  const t = scaleFor(fit.n);
  if (target > 0 && Math.abs(t - target) / target <= 0.06) return;
  tw.from = fit.scale;
  tw.t0 = now;
  tw.dur = durMs;
  target = t;
}

// ------------------------------------------------------------------ HUD insets

type Rect = { left: number; top: number; right: number; bottom: number };
/** the HUD's footprint: top bar, the dock beside it (LOD chip + theme buttons), the right sidebar (or its icon rail) */
const PANELS = [".hud-top", ".hud-dock", ".hud-side"];
/** Hud dispatches this on `.scene-root` when its footprint changes (sidebar collapse, top bar wrap) */
export const HUD_LAYOUT_EVENT = "agentglow:hud-layout";

/**
 * Measure the HUD panels overlapping the canvas: each panel is excluded by cutting the free rect from whichever
 * side keeps the most room for content of aspect `aspect` (w/h): a tall right column cuts from the right, a wide
 * top bar from the top, and a short top-right panel cuts from the top for wide content but from the right for
 * round content.
 */
export function measureInsets(canvas: HTMLCanvasElement, aspect = 1.6) {
  const root = canvas.closest(".scene-root") ?? canvas.parentElement?.parentElement;
  const c = canvas.getBoundingClientRect();
  const ins = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!root || c.width < 1) return ins;
  const rects: Rect[] = [];
  for (const sel of PANELS) {
    const el = root.querySelector(sel) as HTMLElement | null;
    if (!el || el.offsetParent === null) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) continue;
    const r = { left: b.left - c.left - 6, top: b.top - c.top - 6, right: b.right - c.left + 6, bottom: b.bottom - c.top + 6 };
    if (r.right <= 0 || r.bottom <= 0 || r.left >= c.width || r.top >= c.height) continue;
    rects.push(r);
  }
  // exhaustive: every panel is cut from one of the 4 sides (4^n, n <= 5); keep the assignment that leaves the
  // largest rect of the content's aspect
  const W = c.width;
  const H = c.height;
  const usable = (w: number, h: number) => {
    if (w <= 0 || h <= 0) return 0;
    const uw = Math.min(w, h * aspect);
    return uw * (uw / aspect) + w * h * 1e-3; // tie-break: more leftover room
  };
  const n = rects.length;
  let best = -1;
  for (let code = 0; code < 1 << (2 * n); code++) {
    let l = 0, t = 0, rr = 0, bb = 0;
    for (let i = 0; i < n; i++) {
      const r = rects[i];
      const side = (code >> (2 * i)) & 3;
      if (side === 0) l = Math.max(l, r.right);
      else if (side === 1) rr = Math.max(rr, W - r.left);
      else if (side === 2) t = Math.max(t, r.bottom);
      else bb = Math.max(bb, H - r.top);
    }
    const u = usable(W - l - rr, H - t - bb);
    if (u > best) {
      best = u;
      ins.left = l;
      ins.right = rr;
      ins.top = t;
      ins.bottom = bb;
    }
  }
  // tiny embeds: the free area keeps at least ~32% of each axis (content may then tuck under a panel edge)
  const capX = W * 0.68;
  const capY = H * 0.68;
  if (ins.left + ins.right > capX) {
    const k = capX / (ins.left + ins.right);
    ins.left *= k;
    ins.right *= k;
  }
  if (ins.top + ins.bottom > capY) {
    const k = capY / (ins.top + ins.bottom);
    ins.top *= k;
    ins.bottom *= k;
  }
  return ins;
}

// ------------------------------------------------------------------ camera framing

type Controls = THREE.EventDispatcher<{ start: object; end: object; change: object }> & { target?: THREE.Vector3; minDistance?: number; maxDistance?: number; update?: () => void };

/** A point (stage space) with a radius that must be fully visible. */
export type FitPoint = { p: THREE.Vector3; r: number };

const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Vector3();
const _f = new THREE.Vector3();
const _m = new THREE.Matrix4();
/** max shift of the projection centre (fraction of the free half extent): the orbit target stays in the free area */
const SHIFT = 0.85;
/** floats per framed point (see FitCamera's buffer) */
const S = 8;
// calm camera timing (ms) and hysteresis bands (see the header)
const BATCH_QUIET_MS = 1100;
const BATCH_MAX_MS = 2500;
const OUT_BAND = 1.04;
const OUT_MS = 1000;
const IN_BAND = 1.18;
const IN_STABLE_MS = 7000;
const IN_MS = 2000;
const USER_HOLD_MS = 10000;
const RESIZE_MS = 450;
const STEADY_MS = 300;
/** the first framing of a scene zooms in to at most this fraction of the theme's start distance */
const FIRST_MIN = 0.75;
/** content beyond this fraction of the free half extent counts as clipped (under a HUD panel / off canvas) */
const CLIP_K = 0.985;

/**
 * Frames the camera on the kit content. Mounted by <KitScene>.
 *   points(): stage-space points + radii that must be visible (agents, clusters, MCP, side graph, theme extras)
 *   origin:   stage group offset in world space
 * Only the camera DISTANCE to the orbit target changes (rotation/target stay the user's). The projection centre is
 * shifted (setViewOffset) so the content's screen bounds sit in the middle of the free area: the camera distance
 * is the smallest one at which the content's bounding box (not a box symmetric around the target) fits, so
 * lopsided content (tall buildings, a graph on one side) still fills the free area.
 */
export function FitCamera({ points, origin }: { points: (visit: (p: THREE.Vector3, r: number) => void) => void; origin: THREE.Vector3 }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  const scene = useThree((s) => s.scene);
  const st = useRef({
    // user zoom-out floor (absolute distance; 0 = none), fit-all mode, served fitAll request, fit-all distance
    hold: 0, all: false, req: fitAllReq.n, fullD: 0, fullAt: -1e9, far0: 0, fog0: null as null | { near: number; far: number },
    base: 0, user: 1, userActive: false, userUntil: -1e9, want: 0, lastMeasure: -1e9, hudMoved: false, dir: new THREE.Vector3(), aspect: 1.6, refit: true,
    // committed move: fitted distance (before the user factor) + projection shift tween from -> to
    cur: 0, from: 0, t0: 0, dur: 0, sx: 0, sy: 0, fx: 0, fy: 0, tx: 0, ty: 0,
    // pending zoom-out (since, largest fit seen in the batch window) / zoom-in (since)
    outSince: 0, outMax: 0, inSince: 0,
    // two-phase commit: the scale moves first, then (at `phase2`) the camera fits the resized layout in one move
    phase2: 0, phase2Ms: 0,
    // the instantaneous fit has been steady (<0.5%/frame) since: layout / grouping / labels still easing otherwise
    lastDesired: 0, steadySince: 0,
    // the committed framing was fitted to real content (false while the scene is empty: the theme's start distance)
    framed: false,
  });
  // camera-space points of this frame (x, y, z, r, then a screen-fixed rect around the point in view-angle units
  // [x0, x1, y0, y1] for px-clamped labels), grown on demand; the visitors are created once
  const buf = useRef({ a: new Float64Array(512 * S), n: 0, tgt: new THREE.Vector3(), tpp: 0 });
  const { visit, visitLabel } = useMemo(() => {
    const B = buf.current;
    const push = (x: number, y: number, z: number, r: number, x0: number, x1: number, y0: number, y1: number) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      if ((B.n + 1) * S > B.a.length) {
        const a = new Float64Array(B.a.length * 2);
        a.set(B.a);
        B.a = a;
      }
      _q.set(x - B.tgt.x, y - B.tgt.y, z - B.tgt.z).applyMatrix4(_m);
      const k = B.n * S;
      B.a[k] = _q.x;
      B.a[k + 1] = _q.y;
      B.a[k + 2] = _q.z;
      B.a[k + 3] = r;
      B.a[k + 4] = x0;
      B.a[k + 5] = x1;
      B.a[k + 6] = y0;
      B.a[k + 7] = y1;
      B.n++;
    };
    return {
      visit: (p: THREE.Vector3, r: number) => push(p.x + origin.x, p.y + origin.y, p.z + origin.z, r, 0, 0, 0, 0),
      // label anchors are world positions; css px (y down) -> view-angle units (y up)
      visitLabel: (e: LabelEntry) => push(e.ax, e.ay, e.az, 0, e.ox0 * B.tpp, e.ox1 * B.tpp, -e.oy1 * B.tpp, -e.oy0 * B.tpp),
    };
  }, [origin]);

  useEffect(() => {
    fit.w = size.width;
    fit.h = size.height;
    st.current.lastMeasure = -1e9; // re-measure HUD on resize
    st.current.refit = true; // re-fit quickly (no batch window / hysteresis)
  }, [size.width, size.height]);

  useEffect(() => () => camera.clearViewOffset(), [camera]);

  // the HUD changed shape (sidebar collapsed / expanded, top bar wrapped): re-measure now
  useEffect(() => {
    const root = gl.domElement.closest(".scene-root");
    if (!root) return;
    const on = () => {
      st.current.lastMeasure = -1e9;
      st.current.hudMoved = true;
    };
    root.addEventListener(HUD_LAYOUT_EVENT, on);
    return () => root.removeEventListener(HUD_LAYOUT_EVENT, on);
  }, [gl]);

  useEffect(() => {
    if (!controls) return;
    const s = st.current;
    const onStart = () => (s.userActive = true);
    const onEnd = () => {
      s.userActive = false;
      s.userUntil = performance.now() + USER_HOLD_MS; // no auto-refit for a while after the user moved the view
      // a committed move the user interrupted stops where it is
      s.want = s.from = s.cur;
      s.dur = 0;
      const tgt = controls.target ?? _c.set(0, 0, 0);
      const d = camera.position.distanceTo(tgt);
      // remember the user's zoom relative to our fit (bounded so a wild scroll can't lock the fit out); not while
      // the search fly-to sets the distance
      // zooming OUT has no upper bound here (maxDistance bounds it) and sticks (`hold`) until Fit all
      if (s.cur > 0 && fly.k < 0.01) {
        s.user = Math.max(0.35, d / s.cur);
        s.hold = s.user > 1.02 ? d : 0;
      }
    };
    controls.addEventListener("start", onStart);
    controls.addEventListener("end", onEnd);
    return () => {
      controls.removeEventListener("start", onStart);
      controls.removeEventListener("end", onEnd);
    };
  }, [controls, camera]);

  useFrame((_, dtRaw) => {
    const s = st.current;
    const B = buf.current;
    lastBuf = B;
    dbg = { camera, points, origin, canvas: gl.domElement };
    const dt = Math.min(0.1, dtRaw);
    const now = performance.now();
    const W = Math.max(1, size.width);
    const H = Math.max(1, size.height);
    if (now - s.lastMeasure > 700) {
      s.lastMeasure = now;
      const was = fit.insets;
      // content aspect for the panel cut, floored at 0.9: tall content (one run fanning down) would otherwise cut the
      // wide top bar from the LEFT (a narrow free column), and the next MCP server / graph then zooms the camera out
      fit.insets = measureInsets(gl.domElement, Math.max(0.9, s.aspect));
      // the free area moved (sidebar collapsed / expanded): re-fit like a resize (quick, smooth), not per text tweak
      if (s.hudMoved) {
        const d = Math.max(Math.abs(was.top - fit.insets.top), Math.abs(was.right - fit.insets.right), Math.abs(was.bottom - fit.insets.bottom), Math.abs(was.left - fit.insets.left));
        if (d > 12) s.refit = true;
        s.hudMoved = false;
      }
    }
    const ins = fit.insets;
    const freeW = Math.max(W * 0.3, W - ins.left - ins.right);
    const freeH = Math.max(H * 0.3, H - ins.top - ins.bottom);
    fit.aspect = freeW / freeH;

    const tgt = controls?.target ?? _c.set(0, 0, 0);
    if (!s.base) s.base = camera.position.distanceTo(tgt) || 20;
    // camera basis (rotation only): q = R^T (p - target)
    s.dir.subVectors(camera.position, tgt);
    const cur = s.dir.length() || 1;
    s.dir.divideScalar(cur);
    _m.extractRotation(camera.matrixWorld).invert();
    // ground-plane foreshortening: how much a stage "up" (b) step shrinks on screen (xz stages seen at an angle)
    fit.foreshorten = THREE.MathUtils.clamp(kit.plane === "xz" ? Math.abs(s.dir.y) : Math.sqrt(1 - s.dir.y * s.dir.y), 0.35, 1);
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const hx = (freeW / W) * tanH * camera.aspect; // free half-extent per unit depth (x)
    const hy = (freeH / H) * tanH;
    B.n = 0;
    B.tgt.copy(tgt);
    B.tpp = (2 * tanH) / H;
    fit.nodeR = 0;
    points(visit);
    visitLabelRects(now, visitLabel);
    const n = B.n;
    const P = fit.profile;
    const minD = P.minRadius / Math.min(hx, hy);
    const maxD = P.maxRadius / Math.min(hx, hy);
    let desired: number;
    if (!n) desired = s.want || s.base; // nothing to frame: stay put
    else {
      // smallest distance at which the content's screen bounding box fits the free area (with margin)
      const m = P.margin;
      if (spans(B.a, n, maxD, m, hx, hy)) {
        let lo = Math.max(0.5, Math.min(minD, maxD) * 0.25);
        let hi = maxD;
        for (let it = 0; it < 22; it++) {
          const mid = (lo + hi) / 2;
          if (spans(B.a, n, mid, m, hx, hy)) hi = mid;
          else lo = mid;
        }
        desired = THREE.MathUtils.clamp(hi, minD, maxD);
      } else desired = maxD;
      // never so close that an agent gets huge (a lone service node as a sun filling half the screen): diameter
      // 2r over a viewport height 2 * d * tanH stays <= maxNode. Only a floor: wide content already sits further out.
      if (fit.nodeR > 0 && P.maxNode > 0) desired = Math.max(desired, Math.min(maxD, fit.nodeR / (tanH * P.maxNode)));
      // fit-all distance: everything framed, no maxRadius cap (throttled; always fresh for a Fit all request)
      if (now - s.fullAt > 250 || fitAllReq.n !== s.req) {
        s.fullAt = now;
        s.fullD = Math.max(desired, fullFit(B.a, n, maxD, P.margin, hx, hy));
      }
      if (s.all) desired = Math.max(desired, s.fullD);
    }
    // Fit all: drop the user's zoom (from where the camera is now) and frame everything in one move
    let forced = false;
    if (fitAllReq.n !== s.req) {
      s.req = fitAllReq.n;
      if (s.cur > 0) {
        s.cur = s.from = s.want = cur;
        s.dur = 0;
      }
      s.user = 1;
      s.hold = 0;
      s.all = true;
      s.userUntil = -1e9;
      s.phase2 = 0;
      forced = !!n;
    }
    // content (or a label) outside the free area as framed now: under a HUD panel or off the canvas. Counts as
    // "needs zoom-out" (batched like any zoom-out), and the move re-centres the projection shift.
    let clipped = false;
    if (n) {
      bounds(B.a, n, cur);
      const kx = hx * CLIP_K, ky = hy * CLIP_K;
      clipped = BX[0] < s.sx - kx || BX[1] > s.sx + kx || BX[2] < s.sy - ky || BX[3] > s.sy + ky;
      s.aspect += (THREE.MathUtils.clamp((BX[1] - BX[0]) / Math.max(1e-4, BX[3] - BX[2]), 0.5, 4) - s.aspect) * 0.1;
      fit.fill[0] = (BX[1] - BX[0]) / (2 * hx);
      fit.fill[1] = (BX[3] - BX[2]) / (2 * hy);
    }

    // ---- commit policy: batch window, asymmetric bands, user hold (see the header)
    if (!s.lastDesired || Math.abs(desired - s.lastDesired) / s.lastDesired > 0.005) s.steadySince = now;
    s.lastDesired = desired;
    const steady = now - s.steadySince;
    const following = s.userActive || now < s.userUntil;
    // the policy picks at most one move (no per-frame closures): goTo >= 0 -> move there over goMs;
    // goDecide -> if agent size changes, resize first (the fit measured now is for the old size), then frame
    let goTo = -1;
    let goMs = 0;
    let goDecide = false;
    if (!n) s.framed = false;
    if (forced) {
      goTo = desired;
      goMs = OUT_MS;
    } else if (!s.want || s.refit) {
      goTo = desired;
      goMs = s.want ? RESIZE_MS : 0;
      s.refit = false;
    } else if (!s.framed && n && !following && steady >= STEADY_MS && now - Math.max(fitClock.activityAt, world.spawnHintAt) >= BATCH_QUIET_MS) {
      // first content after an empty scene: frame it once it is quiet (both ways), not only once it outgrows the
      // theme's start distance; later changes go through the calm policy below. Not closer than FIRST_MIN of the
      // start distance: a lone first agent is usually joined by its subagents / MCP servers moments later.
      goTo = Math.max(desired, Math.min(s.want, s.base * FIRST_MIN));
      goMs = OUT_MS;
    } else if (s.phase2) {
      // phase 2: one camera move to the layout at its new size (any direction: the camera hasn't moved yet),
      // once that layout (and any regrouping it caused) has settled
      if (now >= s.phase2 && (steady >= STEADY_MS || now - s.phase2 >= BATCH_MAX_MS)) {
        s.phase2 = 0;
        const r = desired / s.want;
        if (r > 1.02 || r < 1 / 1.02) {
          goTo = desired;
          goMs = s.phase2Ms;
        }
      }
    } else if (!following) {
      const r = desired / s.want;
      const quiet = now - Math.max(fitClock.activityAt, world.spawnHintAt);
      // a move in flight already re-centres: only a settled framing can be "clipped"
      // (the user's own zoom-in may crop on purpose)
      const clip = clipped && s.user >= 0.99 && (s.dur <= 0 || now - s.t0 >= s.dur);
      if (r > OUT_BAND || clip) {
        s.inSince = 0;
        if (!s.outSince) {
          s.outSince = now;
          s.outMax = desired;
        } else s.outMax = Math.max(s.outMax, desired);
        if ((quiet >= BATCH_QUIET_MS && steady >= STEADY_MS) || now - s.outSince >= BATCH_MAX_MS) {
          goTo = Math.max(s.outMax, desired, clip ? s.want : 0);
          goMs = OUT_MS;
          goDecide = true;
        }
      } else {
        s.outSince = 0;
        if (r < 1 / IN_BAND) {
          if (!s.inSince) s.inSince = now;
          if (now - s.inSince >= IN_STABLE_MS && quiet >= IN_STABLE_MS) {
            goTo = desired;
            goMs = IN_MS;
            goDecide = true;
          }
        } else s.inSince = 0;
      }
    }
    if (goTo >= 0) {
      s.outSince = s.inSince = 0;
      if (n) s.framed = true;
      if (goDecide && scaleMoves() && !reduced) {
        fitCommit(now, goMs * 0.8);
        s.phase2 = now + goMs * 0.8 + 250;
        s.phase2Ms = goMs;
      } else {
        const dur = reduced ? 0 : goMs;
        s.from = s.cur || goTo;
        s.want = goTo;
        s.t0 = now;
        s.dur = dur;
        s.fx = s.sx;
        s.fy = s.sy;
        // projection shift that centres the content once the camera arrives
        if (n) {
          bounds(B.a, n, goTo * s.user);
          s.tx = THREE.MathUtils.clamp((BX[0] + BX[1]) / 2, -hx * SHIFT, hx * SHIFT);
          s.ty = THREE.MathUtils.clamp((BX[2] + BX[3]) / 2, -hy * SHIFT, hy * SHIFT);
        }
        fitCommit(now, dur);
      }
    }
    // world per px at the fitted distance (hysteresis: cluster spacing follows it, then the fit follows that)
    const wpp = (2 * tanH * s.want * s.user) / H;
    if (Math.abs(wpp - fit.wpp) / fit.wpp > 0.1) fit.wpp = wpp;

    // ---- play the committed move (ease-in-out): fitted distance + projection shift together
    const u = s.dur > 0 ? Math.min(1, (now - s.t0) / s.dur) : 1;
    const e = inOut(u);
    s.cur = s.from + (s.want - s.from) * e;
    if (following && n) {
      // the user is orbiting: keep the content centred live (like before), no distance change
      bounds(B.a, n, cur);
      const k = 1 - Math.exp(-dt / 0.3);
      s.tx = THREE.MathUtils.clamp((BX[0] + BX[1]) / 2, -hx * SHIFT, hx * SHIFT);
      s.ty = THREE.MathUtils.clamp((BX[2] + BX[3]) / 2, -hy * SHIFT, hy * SHIFT);
      s.sx += (s.tx - s.sx) * k;
      s.sy += (s.ty - s.sy) * k;
      s.fx = s.sx;
      s.fy = s.sy;
    } else {
      s.sx = s.fx + (s.tx - s.fx) * e;
      s.sy = s.fy + (s.ty - s.fy) * e;
    }
    fit.cam.want = s.want;
    fit.cam.fit = desired;
    fit.cam.dist = cur;
    fit.cam.user = s.user;
    fit.cam.points = n;

    // ---- search fly-to (see `fly`): orbit target -> focus point, distance -> close-up, content shift -> 0
    const F = fly;
    const fGoal = F.on ? 1 : 0;
    let fe = 0;
    if (F.k !== fGoal || F.on) {
      if (!F.homeSet) {
        F.home.copy(tgt);
        F.at.copy(tgt);
        F.homeSet = true;
      }
      const step = reduced ? 1 : (dt * 1000) / FLY_MS;
      F.k = fGoal > F.k ? Math.min(1, F.k + step) : Math.max(0, F.k - step);
      const p = F.on ? F.get?.() : undefined;
      if (p) {
        _f.copy(p).add(origin);
        if (reduced) F.at.copy(_f);
        else F.at.lerp(_f, 1 - Math.exp(-dt / 0.18));
      }
      fe = inOut(F.k);
      tgt.copy(F.home).lerp(F.at, fe);
      if (!F.on && F.k <= 0) {
        tgt.copy(F.home);
        F.homeSet = false;
      }
    }

    // projection centre -> centre of the free area, plus the content shift
    const cx = ins.left + freeW / 2;
    const cy = ins.top + freeH / 2;
    const ox = W / 2 - cx + ((s.sx * (1 - fe)) / (tanH * camera.aspect)) * (W / 2);
    const oy = H / 2 - cy - ((s.sy * (1 - fe)) / tanH) * (H / 2);
    const v = camera.view;
    if (!v || !v.enabled || v.fullWidth !== W || v.fullHeight !== H || Math.abs(v.offsetX - ox) > 0.25 || Math.abs(v.offsetY - oy) > 0.25) camera.setViewOffset(W, H, ox, oy, W, H);

    // limits follow the content: the user can always zoom out past everything, auto-fit never hits the cap
    if (controls) {
      const md = Math.max(MIN_MAX_DISTANCE, 4 * s.want * Math.max(1, s.user), 2 * s.fullD, s.hold * 1.5);
      if (controls.maxDistance === undefined || Math.abs(controls.maxDistance - md) / md > 0.02) controls.maxDistance = md;
    }
    if (!s.far0) s.far0 = camera.far;
    const far = Math.max(s.far0, cur * 2.5 + s.fullD);
    if (Math.abs(camera.far - far) / far > 0.05) {
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    // scene fog (theme depth cue) slides back by however far the user zoomed out beyond the fit
    const fog = scene.fog as THREE.Fog | null;
    if (fog && "near" in fog) {
      if (!s.fog0) s.fog0 = { near: fog.near, far: fog.far };
      const extra = Math.max(0, cur - s.cur);
      fog.near = s.fog0.near + extra;
      fog.far = s.fog0.far + extra;
    }

    if (s.userActive) return;
    let want = s.cur * s.user;
    // a manual zoom-out sticks: auto-fit may move further out, never back in past the user's distance
    if (s.hold > 0) {
      want = Math.max(want, s.hold);
      s.hold = want;
    }
    if (fe > 0) want += (Math.max(1, F.radius()) / (tanH * FLY_FRAC) - want) * fe;
    if (controls?.minDistance !== undefined) want = Math.max(want, controls.minDistance);
    if (controls?.maxDistance !== undefined && Number.isFinite(controls.maxDistance)) want = Math.min(want, controls.maxDistance);
    if (Math.abs(want - cur) < 1e-4 && !fe && !F.homeSet) return;
    camera.position.copy(tgt).addScaledVector(s.dir, want);
    controls?.update?.();
  });
  return null;
}

/** smallest distance at which ALL points fit (no maxRadius cap), searched up from `start` */
function fullFit(a: Float64Array, n: number, start: number, m: number, hx: number, hy: number) {
  let hi = Math.max(1, start);
  while (!spans(a, n, hi, m, hx, hy) && hi < 1e6) hi *= 2;
  let lo = hi / 2;
  if (spans(a, n, lo, m, hx, hy)) {
    lo = 0.5;
  }
  for (let it = 0; it < 22; it++) {
    const mid = (lo + hi) / 2;
    if (spans(a, n, mid, m, hx, hy)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** screen bounds in tangent units [minX, maxX, minY, maxY] of camera-space points seen from distance d */
const BX = new Float64Array(4);
function bounds(a: Float64Array, n: number, d: number) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const k = i * S;
    const r = a[k + 3];
    const depth = Math.max(0.05, d - a[k + 2] - r);
    const x = a[k], y = a[k + 1];
    x0 = Math.min(x0, (x - r) / depth + a[k + 4]);
    x1 = Math.max(x1, (x + r) / depth + a[k + 5]);
    y0 = Math.min(y0, (y - r) / depth + a[k + 6]);
    y1 = Math.max(y1, (y + r) / depth + a[k + 7]);
  }
  BX[0] = x0;
  BX[1] = x1;
  BX[2] = y0;
  BX[3] = y1;
}
/** does the content fit the free area (half extents hx/hy per unit depth, margin m) from distance d, once centred? */
function spans(a: Float64Array, n: number, d: number, m: number, hx: number, hy: number) {
  for (let i = 0; i < n; i++) if (d - a[i * S + 2] - a[i * S + 3] <= 0.05) return false; // a point behind the camera
  bounds(a, n, d);
  // the centring shift is clamped (to SHIFT of the half extent): account for the remainder
  const cx = (BX[0] + BX[1]) / 2, cy = (BX[2] + BX[3]) / 2;
  const ex = Math.max(0, Math.abs(cx) - hx * SHIFT), ey = Math.max(0, Math.abs(cy) - hy * SHIFT);
  return ((BX[1] - BX[0]) / 2 + ex) * m <= hx && ((BX[3] - BX[2]) / 2 + ey) * m <= hy;
}

let lastBuf: { a: Float64Array; n: number } | null = null;
let dbg: { camera: THREE.PerspectiveCamera; points: (visit: (p: THREE.Vector3, r: number) => void) => void; origin: THREE.Vector3; canvas: HTMLCanvasElement } | null = null;

/**
 * debug / verification: screen rects (canvas css px) of every framed point (agents, clusters, MCP, backends, side
 * graph, run-label headroom) and every drawn label, and which of them intersect a HUD panel or leave the canvas.
 */
function clipReport() {
  if (!dbg) return null;
  const { camera, points, origin, canvas } = dbg;
  const c = canvas.getBoundingClientRect();
  const W = c.width, H = c.height;
  const root = canvas.closest(".scene-root") ?? document;
  const huds: { sel: string; l: number; t: number; r: number; b: number }[] = [];
  for (const sel of PANELS) {
    const el = root.querySelector(sel) as HTMLElement | null;
    if (!el || el.offsetParent === null) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) continue;
    huds.push({ sel, l: b.left - c.left, t: b.top - c.top, r: b.right - c.left, b: b.bottom - c.top });
  }
  const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const items: { kind: string; name: string; l: number; t: number; r: number; b: number; hits: string[] }[] = [];
  const add = (kind: string, name: string, l: number, t: number, r: number, b: number) => {
    const hits = huds.filter((h) => l < h.r && r > h.l && t < h.b && b > h.t).map((h) => h.sel);
    if (l < 0 || t < 0 || r > W || b > H) hits.push("edge");
    items.push({ kind, name, l: Math.round(l), t: Math.round(t), r: Math.round(r), b: Math.round(b), hits });
  };
  const v = new THREE.Vector3();
  points((p, r) => {
    v.set(p.x + origin.x, p.y + origin.y, p.z + origin.z);
    const depth = v.clone().applyMatrix4(camera.matrixWorldInverse).z * -1;
    v.project(camera);
    const x = ((v.x + 1) / 2) * W, y = ((1 - v.y) / 2) * H;
    const rp = (r / Math.max(0.05, depth)) * (H / 2) / tanH;
    add("point", `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`, x - rp, y - rp, x + rp, y + rp);
  });
  const now = performance.now();
  for (const e of labels.entries)
    if (e.drawn && now - e.seen < 600) {
      const w = e.subOff ? e.w1 : e.w, h = e.subOff ? e.h1 : e.h, x = e.subOff ? e.x1 : e.x, y = e.subOff ? e.y1 : e.y;
      add(`label:${e.kind}`, "", x - w / 2, y - h / 2, x + w / 2, y + h / 2);
    }
  const clipped = items.filter((i) => i.hits.length);
  return { W, H, huds, insets: fit.insets, total: items.length, clipped: clipped.length, items: clipped };
}
/** debug: the points framed last frame, as [screen x, screen y] in view-angle units at the current distance */
function framedPoints() {
  const B = lastBuf;
  if (!B) return [];
  const out: number[][] = [];
  for (let i = 0; i < B.n; i++) {
    const k = i * S;
    const depth = fit.cam.dist - B.a[k + 2];
    out.push([+(B.a[k] / depth).toFixed(3), +(B.a[k + 1] / depth).toFixed(3), +B.a[k + 3].toFixed(2), +B.a[k + 4].toFixed(3), +B.a[k + 5].toFixed(3)]);
  }
  return out;
}

if (typeof window !== "undefined") (window as unknown as { __agentglowFit?: typeof fit & { framedPoints: typeof framedPoints; clipReport: typeof clipReport; fly: typeof fly; camera: () => THREE.PerspectiveCamera | undefined } }).__agentglowFit = Object.assign(fit, { framedPoints, clipReport, fly, camera: () => dbg?.camera });
