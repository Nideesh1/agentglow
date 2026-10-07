/** <AgentScene/>: one AgentGlow theme, sized to its container, fed by an agentglow server (or the simulator). */
import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType, type CSSProperties, type LazyExoticComponent } from "react";
import { normalizeSource, SceneConfigProvider, type SceneConfig } from "./scenes/shared/config";
import { THEME_LOADERS, THEMES, type Theme } from "./themes";

export type AgentSceneProps = {
  /** Visual theme. Default "neural". */
  theme?: Theme;
  /** agentglow server base URL, e.g. "http://localhost:8100". Default "" (same origin). */
  source?: string;
  /** Show the HUD (counts, event ticker, agent panel). Default true. */
  hud?: boolean;
  /** Use the built-in simulator instead of a server. Default false (auto-fallback if the server is unreachable). */
  sim?: boolean | "hf";
  /**
   * Only show agents in this scope (e.g. a user or tenant id). Sent as the `X-AgentGlow-Scope` header, never in a URL.
   * On a server that requires tokens the token decides the scope; this is then only a label (and the POST /live/run scope).
   */
  scope?: string;
  /** Only show this one run (sent as the `X-AgentGlow-Run` header). */
  run?: string;
  /**
   * Bearer token minted by YOUR backend (see the root README / SPEC for the format). Sent as
   * `Authorization: Bearer <token>` on every /live/* request, never in a URL. A 401 shows
   * "not authorized" in the HUD instead of falling back to the simulator.
   */
  token?: string;
  /** Show the per-viewer "Clear view" HUD button (and Shift+C). Default true. The server is never touched. */
  clearable?: boolean;
  /**
   * Controlled clear: an epoch-ms timestamp hides everything older for this viewer (as the HUD button does),
   * `null` shows everything again, `undefined` (default) leaves it to the viewer. See also clearView() / showAllView().
   */
  clearedAt?: number | null;
  /** Offer the HUD theme picker (click the HUD title for a menu of every theme). Default true when `hud` is on. */
  themePicker?: boolean;
  /**
   * Called with the theme picked in the HUD. Uncontrolled use (no handler, or a handler that does not change `theme`)
   * still switches: AgentScene keeps the picked theme in its own state until the `theme` prop changes.
   */
  onThemeChange?: (t: Theme) => void;
  style?: CSSProperties;
  className?: string;
};

const cache = new Map<Theme, LazyExoticComponent<ComponentType>>();
function sceneFor(theme: Theme) {
  let c = cache.get(theme);
  if (!c) cache.set(theme, (c = lazy(THEME_LOADERS[theme])));
  return c;
}

const valid = (t: string | undefined): Theme => ((THEMES as readonly string[]).includes(t ?? "") ? (t as Theme) : "neural");

export function AgentScene({ theme = "neural", source = "", hud = true, sim = false, scope, run, token, clearable = true, clearedAt, themePicker, onThemeChange, style, className }: AgentSceneProps) {
  const [picked, setPicked] = useState<Theme>(() => valid(theme));
  useEffect(() => setPicked(valid(theme)), [theme]); // a new `theme` prop wins over the last pick
  const t = picked;
  const picker = themePicker ?? hud;
  const onPick = useMemo(
    () => (next: Theme) => {
      setPicked(next);
      onThemeChange?.(next);
    },
    [onThemeChange],
  );
  const Scene = sceneFor(t);
  const src = normalizeSource(source);
  const config = useMemo<SceneConfig>(
    () => ({ source: src, sim, hud, embedded: true, scope: scope || undefined, run: run || undefined, token: token || undefined, clearable, clearedAt, theme: t, themePicker: picker, onThemeChange: onPick }),
    [src, sim, hud, scope, run, token, clearable, clearedAt, t, picker, onPick],
  );
  return (
    <div className={`agentglow-embed${className ? ` ${className}` : ""}`} style={style} data-theme={t}>
      <SceneConfigProvider value={config}>
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
      </SceneConfigProvider>
    </div>
  );
}

export default AgentScene;
