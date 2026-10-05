/**
 * Static demo build (`npm run build:demo`, GitHub Pages): no server at all, every view runs the built-in simulator.
 * VITE_DEMO=1 is set by `vite build --mode demo` (vite.config.ts); the normal app and the library never set it.
 */
import "./demo.css";

export const DEMO = import.meta.env.VITE_DEMO === "1";
/** App base path with a trailing slash ("/" normally, "/agentglow/" on GitHub Pages). */
export const BASE = import.meta.env.BASE_URL;
export const REPO = "https://github.com/Nideesh1/agentglow";

/** Small chip on every demo page: what this is and how to get it. */
export function DemoChip() {
  if (!DEMO) return null;
  return (
    <aside className="demo-chip" aria-label="About this demo">
      <span className="demo-chip-dot" aria-hidden />
      <span>Live demo with simulated agents</span>
      <span className="demo-chip-sep" aria-hidden>·</span>
      <span>
        Install: <code>npx agentglow setup</code>
      </span>
      <span className="demo-chip-sep" aria-hidden>·</span>
      <a href={REPO} target="_blank" rel="noopener noreferrer">
        GitHub
      </a>
    </aside>
  );
}
