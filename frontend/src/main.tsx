/** Standalone app: "/" = gallery, "/<theme>" = full-screen scene (unknown theme = neural). Config comes from ?source= / ?sim=1 / ?hud=0.
 * Paths are relative to the app base ("/", or "/agentglow/" in the GitHub Pages demo, where 404.html serves deep links). */
import { lazy, StrictMode, Suspense, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BASE, DEMO, DemoChip } from "./demo";
import { configFromUrl, SceneConfigProvider, type SceneConfig } from "./scenes/shared/config";
import { THEME_LOADERS, THEMES, type Theme } from "./themes";

const rel = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : location.pathname.slice(1);
const path = rel.replace(/\/+$/, "").replace(/^\/+/, "");
// unknown paths (e.g. a removed theme like /hive) fall back to neural; "/" is the gallery, except in the hosted demo
// where the landing page IS the neural scene running the simulator (themes stay reachable at /agentglow/<theme>/)
const theme: Theme | null = !path ? (DEMO ? "neural" : null) : (THEMES as readonly string[]).includes(path) ? (path as Theme) : "neural";
if (path && theme !== path) history.replaceState(null, "", `${BASE}${theme}${DEMO ? "/" : ""}${location.search}${location.hash}`);

const Gallery = lazy(() => import("./Gallery"));
const pages = new Map<Theme, ReturnType<typeof lazy>>();
const pageOf = (t: Theme) => {
  let p = pages.get(t);
  if (!p) pages.set(t, (p = lazy(THEME_LOADERS[t])));
  return p;
};
const themeOfPath = (): Theme | null => {
  const r = (location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : location.pathname.slice(1)).replace(/^\/+|\/+$/g, "");
  return (THEMES as readonly string[]).includes(r) ? (r as Theme) : null;
};

/** A theme page with the HUD theme picker: a pick swaps the scene in place and pushes /<theme> (Back works). */
function App({ initial }: { initial: Theme }) {
  const [t, setT] = useState<Theme>(initial);
  useEffect(() => {
    document.title = `AgentGlow · ${t}`;
  }, [t]);
  useEffect(() => {
    const onPop = () => {
      const p = themeOfPath();
      if (p) setT(p);
      else location.reload(); // back to the gallery
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const config = useMemo<SceneConfig>(
    () => ({
      ...configFromUrl(),
      theme: t,
      themePicker: true,
      onThemeChange: (next: Theme) => {
        history.pushState(null, "", `${BASE}${next}${DEMO ? "/" : ""}${location.search}${location.hash}`);
        setT(next);
      },
    }),
    [t],
  );
  const Page = pageOf(t);
  return (
    <SceneConfigProvider value={config}>
      <Suspense fallback={null}>
        <Page />
      </Suspense>
    </SceneConfigProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {theme ? (
      <App initial={theme} />
    ) : (
      <Suspense fallback={null}>
        <Gallery />
      </Suspense>
    )}
    <DemoChip />
  </StrictMode>,
);
