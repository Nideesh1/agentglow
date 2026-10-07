/**
 * HUD theme picker: the HUD title ("neural · living brain") is a button that opens a small menu of every theme
 * (THEME_INFO name + tagline) and switches the scene theme in place. Keyboard: Enter / Space / ArrowDown opens,
 * ArrowUp / ArrowDown / Home / End move, Enter / Space picks, Esc or a click outside closes (focus back on the title).
 * Embedded (<AgentScene/>): calls the config's onThemeChange. Standalone app: main.tsx passes an onThemeChange that
 * swaps the scene and pushes /<theme> (and the menu adds "All themes", the gallery).
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { THEME_INFO, THEMES, type Theme } from "../../themes";

export type ThemePickerProps = {
  title: ReactNode;
  current?: Theme;
  onPick: (t: Theme) => void;
  /** standalone app only: a last "All themes" entry that opens the gallery */
  galleryHref?: string;
};

export function ThemePicker({ title, current, onPick, galleryHref }: ThemePickerProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const n = THEMES.length + (galleryHref ? 1 : 0);

  const show = (at?: number) => {
    setActive(at ?? Math.max(0, current ? THEMES.indexOf(current) : 0));
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };
  const pick = (k: number) => {
    if (k >= THEMES.length) {
      if (galleryHref) location.href = galleryHref;
      return;
    }
    close();
    if (THEMES[k] !== current) onPick(THEMES[k]);
  };

  // outside click / Esc anywhere close it
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);

  const onBtnKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      show(e.key === "ArrowUp" ? n - 1 : undefined);
    }
  };
  const onListKey = (e: ReactKeyboardEvent) => {
    const go = (k: number) => {
      e.preventDefault();
      setActive(((k % n) + n) % n);
    };
    if (e.key === "ArrowDown") go(active + 1);
    else if (e.key === "ArrowUp") go(active - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(n - 1);
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Tab") close(false);
  };

  return (
    <div className="hud-tp" ref={root}>
      <button
        ref={btn}
        type="button"
        className="hud-title hud-tp-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        title="Switch theme"
        onClick={() => (open ? close() : show())}
        onKeyDown={onBtnKey}
      >
        <span className="hud-dot" />
        {title}
        <span className="hud-tp-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <ul
          ref={list}
          id={`${id}-list`}
          className="hud-tp-menu"
          role="listbox"
          aria-label="Theme"
          tabIndex={-1}
          aria-activedescendant={`${id}-o${active}`}
          onKeyDown={onListKey}
        >
          {THEMES.map((t, k) => (
            <li
              key={t}
              id={`${id}-o${k}`}
              role="option"
              aria-selected={t === current}
              className={`hud-tp-opt${k === active ? " is-active" : ""}${t === current ? " is-current" : ""}`}
              onPointerEnter={() => setActive(k)}
              onClick={() => pick(k)}
            >
              <b>{THEME_INFO[t].name}</b>
              <span>{THEME_INFO[t].tagline}</span>
            </li>
          ))}
          {galleryHref && (
            <li
              id={`${id}-o${THEMES.length}`}
              role="option"
              aria-selected={false}
              className={`hud-tp-opt hud-tp-all${active === THEMES.length ? " is-active" : ""}`}
              onPointerEnter={() => setActive(THEMES.length)}
              onClick={() => pick(THEMES.length)}
            >
              <b>All themes</b>
              <span>the gallery</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
