/** "/" - theme gallery for the standalone app. */
import "./gallery.css";
import { BASE, DEMO, REPO } from "./demo";
import { THEME_INFO, THEMES, type Theme } from "./themes";

const ACCENT: Record<Theme, [string, string]> = {
  orbit: ["#818cf8", "#22d3ee"],
  neural: ["#e879f9", "#818cf8"],
  flow: ["#a5b4fc", "#f0abfc"],
  constellation: ["#c7d2fe", "#60a5fa"],
  atom: ["#38bdf8", "#f472b6"],
  bubblechamber: ["#5eead4", "#bff3ff"],
  fireworks: ["#fbbf24", "#f43f5e"],
};

export default function Gallery() {
  const qs = location.search;
  return (
    <main className="gal">
      <header className="gal-head">
        <h1>
          <span className="gal-dot" /> AgentGlow
        </h1>
        <p>Live 3D views of your agent system, driven only by OpenTelemetry. Span lifecycle = agent lifecycle. Pick a view:</p>
      </header>
      <ul className="gal-grid">
        {THEMES.map((t, i) => (
          <li key={t}>
            <a href={`${BASE}${t}${DEMO ? "/" : ""}${qs}`} className="gal-card" style={{ ["--a" as string]: ACCENT[t][0], ["--b" as string]: ACCENT[t][1] }}>
              <div className="gal-art" aria-hidden>
                <span style={{ ["--d" as string]: `${i * -0.7}s` }} />
              </div>
              <div className="gal-text">
                <h2>{THEME_INFO[t].name}</h2>
                <p>{THEME_INFO[t].tagline}</p>
                <code>/{t}</code>
              </div>
            </a>
          </li>
        ))}
      </ul>
      <footer className="gal-foot">
        {DEMO ? (
          <>
            Every view here runs the built-in simulator in your browser (no server); try <a href={`${BASE}neural/?sim=hf`}>30 market agents</a> for a busy one. To watch your own agents: <code>npx agentglow setup</code> (Claude Code) or{" "}
            <code>pip install agentglow</code>, see{" "}
            <a href={REPO} target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            .
          </>
        ) : (
          <>
            Add <code>?sim=1</code> to any view for the built-in simulator · <code>?source=http://host:8100</code> to point at another server ·{" "}
            <code>?hud=0</code> to hide the HUD
          </>
        )}
      </footer>
    </main>
  );
}
