/**
 * Per-scene configuration: where world events come from and how the scene is laid out.
 * The standalone app derives it from the URL (?source= / ?sim=1 / ?hud=0 / ?run=); <AgentScene/> passes props.
 * scope and token never come from the URL (tokens in URLs leak); only the embed props set them.
 */
import { createContext, useContext } from "react";

export type SceneConfig = {
  /** Base URL of the agentglow server ("" = same origin). Endpoints: `${source}/live/stream|graph|health|run`. */
  source: string;
  /** Force the built-in simulator (no network); "hf" = the high-frequency scenario (~30 market agents, ~100 decisions/s). */
  sim: boolean | "hf";
  /** Show the glass HUD (top bar with live totals, Agents | Events | Selected sidebar). */
  hud: boolean;
  /** Embedded in a host page: fill the container instead of the viewport, no theme nav links. */
  embedded: boolean;
  /** Only show agents in this scope (dev servers: sent as `X-AgentGlow-Scope`; with a token the token decides). */
  scope?: string;
  /** Only show this run (sent as `X-AgentGlow-Run`). */
  run?: string;
  /** Bearer token minted by the host backend; sent as `Authorization: Bearer <token>`, never in a URL. */
  token?: string;
  /** Offer the per-viewer "Clear view" HUD button and its Shift+C shortcut (default true). */
  clearable?: boolean;
  /** Controlled clear: epoch ms = clear at that moment, null = show everything, undefined = leave it to the viewer. */
  clearedAt?: number | null;
};

/** Strip trailing slashes so `${source}/live/...` is always well-formed. */
export const normalizeSource = (s: string | null | undefined) => (s ?? "").trim().replace(/\/+$/, "");

/** Config for the standalone app, read from the query string. */
export function configFromUrl(): SceneConfig {
  const q = typeof location === "undefined" ? new URLSearchParams() : new URLSearchParams(location.search);
  const flag = (k: string) => q.has(k) && !["0", "false", "no"].includes(q.get(k)!.toLowerCase());
  return {
    source: normalizeSource(q.get("source")),
    sim: q.get("sim")?.toLowerCase() === "hf" ? "hf" : flag("sim"),
    hud: q.get("hud") === null ? true : flag("hud"),
    embedded: false,
    run: q.get("run")?.trim() || undefined,
    clearable: true,
  };
}

const Ctx = createContext<SceneConfig | null>(null);
export const SceneConfigProvider = Ctx.Provider;

/** Explicit provider config wins; otherwise fall back to the URL (standalone app). */
export function useSceneConfig(): SceneConfig {
  return useContext(Ctx) ?? configFromUrl();
}
