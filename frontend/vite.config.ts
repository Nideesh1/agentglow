/** App build: gallery + full-screen scenes, written into the Python package (served at / by `agentglow serve`).
 * `--mode demo` (npm run build:demo): the static GitHub Pages demo instead, base /agentglow/, simulator only, into
 * frontend/demo-dist with a copy of index.html per theme and as 404.html so deep links like /agentglow/neural load. */
import react from "@vitejs/plugin-react";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

// keep in sync with THEMES in src/themes.ts (not imported: that module pulls in every scene)
const THEMES = ["neural", "constellation", "orbit", "atom", "flow", "bubblechamber", "fireworks"];
const target = process.env.AGENTGLOW_URL ?? "http://localhost:8100";
const demoOut = fileURLToPath(new URL("./demo-dist", import.meta.url));

/** GitHub Pages has no rewrites: serve the SPA shell at every theme path (200) and as 404.html (anything else). */
function pagesShell(): Plugin {
  return {
    name: "agentglow-pages-shell",
    apply: "build",
    closeBundle() {
      const index = join(demoOut, "index.html");
      for (const t of THEMES) {
        mkdirSync(join(demoOut, t), { recursive: true });
        copyFileSync(index, join(demoOut, t, "index.html"));
      }
      copyFileSync(index, join(demoOut, "404.html"));
    },
  };
}

export default defineConfig(({ mode }) => {
  const demo = mode === "demo";
  return {
    base: demo ? (process.env.AGENTGLOW_BASE ?? "/agentglow/") : "/",
    define: demo ? { "import.meta.env.VITE_DEMO": JSON.stringify("1") } : {},
    resolve: { dedupe: ["react", "react-dom"] },
    plugins: [react(), ...(demo ? [pagesShell()] : [])],
    build: {
      outDir: demo ? demoOut : fileURLToPath(new URL("../backend/agentglow/static", import.meta.url)),
      emptyOutDir: true,
      chunkSizeWarningLimit: 1500,
    },
    // dev: same-origin /live/* → agentglow server
    server: { proxy: { "/live": { target, changeOrigin: true } } },
  };
});
