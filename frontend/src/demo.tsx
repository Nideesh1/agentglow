/**
 * Static demo build (`npm run build:demo`, GitHub Pages): no server at all, every view runs the built-in simulator.
 * VITE_DEMO=1 is set by `vite build --mode demo` (vite.config.ts); the normal app and the library never set it.
 */
import { useState } from "react";
import "./demo.css";

export const DEMO = import.meta.env.VITE_DEMO === "1";
/** App base path with a trailing slash ("/" normally, "/agentglow/" on GitHub Pages). */
export const BASE = import.meta.env.BASE_URL;
export const REPO = "https://github.com/Nideesh1/agentglow";

const WAYS: { title: string; lines: string[]; note: string }[] = [
  { title: "Claude Code plugin", lines: ["/plugin marketplace add Nideesh1/agentglow", "/plugin install agentglow@agentglow"],
    note: "Type inside Claude Code, then ask: show my agents in 3D" },
  { title: "One command", lines: ["npx agentglow setup"], note: "Hooks into Claude Code and opens the 3D view (needs Node)" },
  { title: "Global install", lines: ["npm i -g agentglow", "agentglow setup"], note: "Same as above, with the agentglow command on your PATH" },
  { title: "Your own agents (Python)", lines: ["uv add agentglow   # or: pip install agentglow"],
    note: "Then agentglow.watch() in LangChain / Hatchet / FastAPI / MCP apps" },
  { title: "React component", lines: ["npm i agentglow"], note: "<AgentScene /> in your own app" },
];

function copy(text: string) {
  try { void navigator.clipboard?.writeText(text); } catch { /* clipboard blocked: the text stays selectable */ }
}

/** Small chip on every demo page: what this is, plus an install panel with every way to get it. */
export function DemoChip() {
  const [open, setOpen] = useState(false);
  if (!DEMO) return null;
  return (
    <>
      {open && (
        <div className="demo-install" role="dialog" aria-label="Install AgentGlow">
          <div className="demo-install-head">
            <span>Install AgentGlow</span>
            <button className="demo-install-x" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </div>
          {WAYS.map((w) => (
            <div key={w.title} className="demo-install-way">
              <div className="demo-install-title">{w.title}</div>
              {w.lines.map((l) => (
                <div key={l} className="demo-install-line">
                  <code>{l}</code>
                  <button onClick={() => copy(l)} title="Copy">copy</button>
                </div>
              ))}
              <div className="demo-install-note">{w.note}</div>
            </div>
          ))}
        </div>
      )}
      <aside className="demo-chip" aria-label="About this demo">
        <span className="demo-chip-dot" aria-hidden />
        <span>Simulated demo</span>
        <span className="demo-chip-sep" aria-hidden>·</span>
        <button className="demo-chip-btn" onClick={() => setOpen(!open)}>Install ▾</button>
        <span className="demo-chip-sep" aria-hidden>·</span>
        <a href={REPO} target="_blank" rel="noopener noreferrer">
          GitHub
        </a>
      </aside>
    </>
  );
}
