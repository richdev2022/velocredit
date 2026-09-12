// ============================================================================
// src/components/SearchableSelect.tsx
// Reusable searchable combobox with filter, keyboard nav, and click-outside.
// ============================================================================

import { useEffect, useRef, useState } from "react";

interface Option {
  value: string;
  label: string;
}

interface SearchableSelectProps {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  busy?: boolean;
  error?: string;
  busyPlaceholder?: string;
}

export default function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = "Select an option",
  label,
  required,
  disabled,
  busy,
  error,
  busyPlaceholder = "Loading…",
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selectedOption = options.find((o) => o.value === value);
  const displayValue = open ? query : selectedOption?.label ?? query;

  const filtered = options.filter((o) =>
    o.label.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery(selectedOption?.label ?? "");
        setHighlight(-1);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [selectedOption]);

  useEffect(() => {
    if (highlight >= 0 && highlight < filtered.length) {
      const el = document.getElementById(`ss-opt-${filtered[highlight].value}`);
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [highlight, filtered]);

  function commit(opt: Option) {
    onChange(opt.value);
    setQuery(opt.label);
    setOpen(false);
    setHighlight(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
      setOpen(true);
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
      setQuery(selectedOption?.label ?? "");
      setHighlight(-1);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % Math.max(filtered.length, 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) =>
        h <= 0 ? Math.max(filtered.length - 1, -1) : h - 1
      );
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (highlight >= 0 && filtered[highlight]) {
        commit(filtered[highlight]);
      }
      return;
    }
  }

  function onFocus() {
    if (disabled || busy) return;
    setOpen(true);
    setQuery("");
    setHighlight(-1);
  }

  function onChangeInput(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setQuery(v);
    if (!open) setOpen(true);
    setHighlight(-1);
  }

  const isDisabled = disabled || busy;

  return (
    <div className="w-full" ref={containerRef}>
      {label && (
        <label className="velo-label">
          {label}
          {required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
      )}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={busy ? "" : displayValue}
          placeholder={busy ? busyPlaceholder : placeholder}
          onChange={onChangeInput}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          disabled={isDisabled}
          aria-invalid={!!error}
          autoComplete="off"
          className={`velo-input pr-10 appearance-none ${error ? "velo-input-error" : ""} ${isDisabled ? "cursor-not-allowed opacity-70" : ""}`}
        />
        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d={open ? "M14 12l-4-4-4 4" : "M6 8l4 4 4-4"}
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        {open && !isDisabled && (
          <ul
            role="listbox"
            className="absolute z-50 mt-1 w-full max-h-60 overflow-auto rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-2.5 text-sm text-slate-500">No results found</li>
            ) : (
              filtered.map((opt, idx) => (
                <li
                  key={opt.value}
                  id={`ss-opt-${opt.value}`}
                  role="option"
                  aria-selected={opt.value === value}
                  onMouseEnter={() => setHighlight(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(opt);
                  }}
                  className={`px-3 py-2.5 text-sm cursor-pointer ${
                    idx === highlight
                      ? "bg-velo-50 text-velo-900 dark:bg-velo-900/30 dark:text-white"
                      : "text-velo-900 dark:text-white"
                  } ${opt.value === value ? "font-semibold" : ""}`}
                >
                  {opt.label}
                </li>
              ))
            )}
          </ul>
        )}
      </div>
      {error && <p className="velo-error-text">{error}</p>}
    </div>
  );
}
