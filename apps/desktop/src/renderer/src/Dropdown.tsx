import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A dropdown the app draws itself.
 *
 * Native <select> and <datalist> popups are rendered by the OS: on macOS they
 * come out dark against a light app, they sit wherever the platform decides —
 * over the card below, in the settings page's case — and a datalist FILTERS to
 * what has been typed, so a field saying "10 models" would drop to two the
 * moment a model id was in the box. None of that is stylable or fixable from
 * CSS, which is why this exists rather than a class on a <select>.
 *
 * Values stay free-form where the caller allows it: a provider can serve a
 * model its own list endpoint has not caught up with, and the app refusing to
 * accept a typed id would be the reason a working model could not be used.
 */

export interface DropdownOption {
  value: string;
  label: string;
  /** Right-aligned secondary text: a display name beside an id. */
  hint?: string;
}

export function Dropdown({
  value,
  options,
  onChange,
  placeholder = "Choose…",
  /** Let the user type a value that is not in the list. */
  freeText = false,
  /** Shown above the list when there are more options than fit comfortably. */
  searchable = false,
  className = "",
  ariaLabel,
  testId,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  freeText?: boolean;
  searchable?: boolean;
  className?: string;
  ariaLabel: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [above, setAbove] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // Open upward when there is more room above — the AI drawer's picker sits at
  // the bottom of the window, where a downward list would be clipped.
  useLayoutEffect(() => {
    if (!open) return;
    const box = rootRef.current?.getBoundingClientRect();
    if (!box) return;
    setAbove(window.innerHeight - box.bottom < 240 && box.top > window.innerHeight - box.bottom);
    // A trigger near the right edge — the AI panel's model picker — must open
    // its menu leftward, or the menu runs off the window and makes whatever
    // contains it scroll sideways.
    setAlignRight(box.left + 220 > window.innerWidth - 12);
    // preventScroll, ALWAYS. Focusing the filter otherwise asks the browser to
    // scroll the nearest scrollable ancestor until the input is visible, which
    // shunted the whole AI panel sideways the moment the menu opened.
    if (searchable) searchRef.current?.focus({ preventScroll: true });
  }, [open, searchable]);

  const matches = query.trim() === ""
    ? options
    : options.filter((o) =>
        `${o.value} ${o.label} ${o.hint ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
      );
  const current = options.find((o) => o.value === value);
  const shown = current?.label ?? (value !== "" ? value : placeholder);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className={`dd ${className}`} ref={rootRef}>
      <button
        type="button"
        className="dd-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen(!open)}
        data-testid={testId}
      >
        <span className={`dd-value${value === "" ? " dd-placeholder" : ""}`}>{shown}</span>
        <span className="dd-caret" aria-hidden="true">
          ⌄
        </span>
      </button>
      {open && (
        <div
          className={`dd-menu${above ? " dd-menu-above" : ""}${alignRight ? " dd-menu-right" : ""}`}
          role="listbox"
          ref={listRef}
        >
          {(searchable || freeText) && (
            <input
              ref={searchRef}
              className="dd-search"
              value={query}
              placeholder={freeText ? "Filter, or type any id…" : "Filter…"}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter takes the typed text when it matches nothing — the
                // free-form escape hatch, without a second control for it.
                if (e.key === "Enter" && freeText && query.trim() !== "") {
                  e.preventDefault();
                  pick(matches.length === 1 ? matches[0].value : query.trim());
                }
              }}
              data-testid={testId ? `${testId}-filter` : undefined}
            />
          )}
          <div className="dd-list">
            {matches.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`dd-option${o.value === value ? " dd-option-active" : ""}`}
                onClick={() => pick(o.value)}
              >
                <span className="dd-option-label">{o.label}</span>
                {o.hint && <span className="dd-option-hint">{o.hint}</span>}
              </button>
            ))}
            {matches.length === 0 && (
              <div className="dd-empty">
                {freeText && query.trim() !== ""
                  ? `Press Enter to use “${query.trim()}”`
                  : "Nothing matches."}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
