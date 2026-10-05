/** Standalone app: "/" = gallery, "/<theme>" = full-screen scene (unknown theme = neural). Config comes from ?source= / ?sim=1 / ?hud=0.
 * Paths are relative to the app base ("/", or "/agentglow/" in the GitHub Pages demo, where 404.html serves deep links). */
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BASE, DEMO, DemoChip } from "./demo";
import { THEME_LOADERS, THEMES, type Theme } from "./themes";

const rel = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : location.pathname.slice(1);
const path = rel.replace(/\/+$/, "").replace(/^\/+/, "");
// unknown paths (e.g. a removed theme like /hive) fall back to neural; "/" is the gallery, except in the hosted demo
// where the landing page IS the neural scene running the simulator (themes stay reachable at /agentglow/<theme>/)
const theme: Theme | null = !path ? (DEMO ? "neural" : null) : (THEMES as readonly string[]).includes(path) ? (path as Theme) : "neural";
const Page = theme ? lazy(THEME_LOADERS[theme]) : lazy(() => import("./Gallery"));
if (path && theme !== path) history.replaceState(null, "", `${BASE}${theme}${DEMO ? "/" : ""}${location.search}${location.hash}`);
if (theme) document.title = `AgentGlow · ${theme}`;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
    <DemoChip />
  </StrictMode>,
);
