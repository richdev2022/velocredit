// ============================================================================
// src/components/admin/settingsUI.tsx
// Shared UI primitives for the Platform Settings console.
//
// A small design system so every settings surface (config tabs, investor
// tools, withdrawals, ledger) speaks the same visual language:
//   - SettingRow  : label/description on the left, control on the right
//   - Toggle      : iOS-style sliding switch (replaces checkbox switches)
//   - NairaField  : numeric input with a ₦ prefix chip and thousands display
//   - FeeEditor   : decimal-safe fee value editor with a segmented type control
//   - Pill        : tiny status pill
// ============================================================================

import { useEffect, useState } from "react";

/* ----------------------------------------------------------------------- */
/* Pill — micro status indicator                                            */
/* ----------------------------------------------------------------------- */

export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "success" | "danger" | "warning" | "info";
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
    success: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800",
    danger: "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800",
    warning: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800",
    info: "bg-velo-50 text-velo-700 border-velo-200 dark:bg-velo-900/40 dark:text-velo-300 dark:border-velo-800",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

/* ----------------------------------------------------------------------- */
/* Toggle — iOS-style sliding switch                                        */
/* ----------------------------------------------------------------------- */

export function Toggle({
  checked,
  onChange,
  disabled,
  size = "md",
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  label?: string;
}) {
  const dims = size === "sm" ? { track: "h-5 w-9", knob: "h-3.5 w-3.5", on: "left-[18px]", off: "left-[3px]" } : { track: "h-6 w-11", knob: "h-4 w-4", on: "left-6", off: "left-1" };
  const track = (
    <span
      className={`relative ${dims.track} shrink-0 rounded-full transition-colors duration-200 ${
        checked ? "bg-velo-500" : "bg-slate-300 dark:bg-slate-700"
      }`}
    >
      <span
        className={`absolute top-1 ${dims.knob} rounded-full bg-white shadow transition-all duration-200 ${
          checked ? dims.on : dims.off
        }`}
      />
    </span>
  );

  // With a label: one single clickable, accessible control (avoids the
  // label-wrapping-button double-activation quirk in some browsers).
  if (label) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="inline-flex cursor-pointer select-none items-center gap-2 focus:outline-none focus-visible:ring-4 focus-visible:ring-velo-200 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-velo-800"
      >
        {track}
        <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">{label}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative shrink-0 rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-4 focus-visible:ring-velo-200 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-velo-800"
    >
      {track}
    </button>
  );
}

/* ----------------------------------------------------------------------- */
/* SettingRow — label + description left, control right                     */
/* ----------------------------------------------------------------------- */

export function SettingRow({
  label,
  description,
  children,
  stacked = false,
  last = false,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
  /** stacked=true puts the control under the label (for wide controls) */
  stacked?: boolean;
  last?: boolean;
}) {
  if (stacked) {
    return (
      <div className={`py-4 ${last ? "" : "border-b border-slate-100 dark:border-slate-800"}`}>
        <div className="mb-3">
          <div className="text-sm font-semibold text-velo-900 dark:text-white">{label}</div>
          {description && <div className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</div>}
        </div>
        {children}
      </div>
    );
  }
  return (
    <div className={`flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 ${last ? "" : "border-b border-slate-100 dark:border-slate-800"}`}>
      <div className="min-w-0 sm:max-w-md">
        <div className="text-sm font-semibold text-velo-900 dark:text-white">{label}</div>
        {description && <div className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</div>}
      </div>
      <div className="w-full shrink-0 sm:max-w-[15rem]">{children}</div>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* NairaField — numeric input with ₦ chip                                   */
/* ----------------------------------------------------------------------- */

export function NairaField({
  label,
  value,
  onChange,
  helpText,
  compact = false,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  helpText?: string;
  compact?: boolean;
}) {
  return (
    <label className="block">
      {label && <span className={`mb-1.5 block font-semibold text-velo-900 dark:text-white ${compact ? "text-[11px]" : "text-xs"}`}>{label}</span>}
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400 select-none">₦</span>
        <input
          type="text"
          inputMode="numeric"
          value={Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-NG") : "0"}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/[^0-9]/g, ""));
            onChange(Number.isFinite(n) ? n : 0);
          }}
          className="velo-input !pl-9 text-sm font-semibold"
        />
      </div>
      {helpText && <div className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">{helpText}</div>}
    </label>
  );
}

/* ----------------------------------------------------------------------- */
/* Segmented — two-option segmented control                                 */
/* ----------------------------------------------------------------------- */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className={`grid ${options.length === 2 ? "grid-cols-2" : "grid-cols-" + options.length} gap-0.5 rounded-xl bg-slate-100 p-1 dark:bg-slate-800`}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`rounded-lg font-semibold transition-all duration-150 ${size === "sm" ? "px-2 py-1 text-[10px]" : "px-2.5 py-1.5 text-xs"} ${
            value === opt.value
              ? "bg-white text-velo-700 shadow-sm dark:bg-slate-900 dark:text-velo-300"
              : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* FeeEditor — decimal-safe fee editor with segmented type control          */
/* ----------------------------------------------------------------------- */

export type FeeValue = { type: "flat" | "percentage"; value: number; includeUpfront: boolean; enabled?: boolean };

const DECIMAL_REGEX = /^\d*\.?\d*$/;

function parseDecimal(s: string): number {
  const normalized = s.trim();
  if (normalized === "" || normalized === ".") return 0;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function formatDecimal(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n * 100) / 100);
}

export function FeeEditor({
  label,
  description,
  value,
  onChange,
  baseline,
  baselineLabel,
}: {
  label: string;
  description?: string;
  value: FeeValue;
  onChange: (next: FeeValue) => void;
  baseline?: FeeValue;
  baselineLabel?: string;
}) {
  // Draft state lets the user type "0.", "0.1", ".5" without the input
  // snapping back to "0" mid-keystroke (the decimal-fee bug fix).
  const [draft, setDraft] = useState<string>(() => formatDecimal(value.value));

  useEffect(() => {
    if (parseDecimal(draft) !== value.value) setDraft(formatDecimal(value.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.value]);

  function commit(raw: string) {
    const cleaned = raw.replace(/[^\d.]/g, "");
    const firstDot = cleaned.indexOf(".");
    const normalized =
      firstDot >= 0
        ? cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "")
        : cleaned;
    if (!DECIMAL_REGEX.test(normalized)) return;
    setDraft(normalized);
    if (normalized === "" || normalized === ".") {
      onChange({ ...value, value: 0 });
      return;
    }
    const next = parseDecimal(normalized);
    if (Number.isFinite(next) && next >= 0) onChange({ ...value, value: next });
  }

  const isPercent = value.type === "percentage";
  const changed = baseline && (baseline.type !== value.type || baseline.value !== value.value || baseline.includeUpfront !== value.includeUpfront);

  return (
    <div className={`rounded-2xl border p-4 transition-all duration-200 ${changed ? "border-velo-200 bg-velo-50/40 dark:border-velo-800 dark:bg-velo-900/20" : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"}`}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-bold text-velo-900 dark:text-white">{label}</div>
          {description && <div className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{description}</div>}
        </div>
        {baselineLabel && (
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">vs {baselineLabel}</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="w-[8.5rem] shrink-0">
          <Segmented
            value={value.type}
            options={[
              { value: "flat" as const, label: "Flat ₦" },
              { value: "percentage" as const, label: "Percent %" },
            ]}
            onChange={(t) => onChange({ ...value, type: t })}
            size="sm"
          />
        </div>
        <div className="relative min-w-0 flex-1">
          {isPercent ? (
            <span className="absolute right-9 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400 select-none">%</span>
          ) : (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400 select-none">₦</span>
          )}
          <input
            type="text"
            inputMode="decimal"
            value={draft}
            onChange={(e) => commit(e.target.value)}
            onBlur={() => {
              if (draft === "" || draft === ".") setDraft("0");
              else setDraft(formatDecimal(parseDecimal(draft)));
            }}
            placeholder="0"
            className={`velo-input !py-2 text-sm font-semibold ${isPercent ? "!pr-8" : "!pl-9"}`}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-100 pt-2.5 dark:border-slate-800">
        <Toggle
          size="sm"
          checked={value.enabled !== false}
          onChange={(on) => onChange({ ...value, enabled: on })}
          label="Active"
        />
        <Toggle
          size="sm"
          checked={value.includeUpfront}
          onChange={(on) => onChange({ ...value, includeUpfront: on })}
          label="Charge upfront"
        />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Chip — selectable pill (tenures, quick options)                          */
/* ----------------------------------------------------------------------- */

export function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border-2 px-4 py-2 text-xs font-semibold transition-all duration-150 ${
        selected
          ? "border-velo-500 bg-velo-500 text-white shadow-sm"
          : "border-slate-200 bg-white text-slate-600 hover:border-velo-300 hover:text-velo-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-velo-700"
      }`}
    >
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------------- */
/* PanelCard — bordered panel with a sticky-ish header strip                */
/* ----------------------------------------------------------------------- */

export function PanelCard({
  title,
  description,
  icon,
  action,
  children,
  tone = "default",
}: {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  tone?: "default" | "emerald" | "amber" | "violet" | "sky";
}) {
  const tones: Record<string, string> = {
    default: "text-velo-600 dark:text-velo-400",
    emerald: "text-emerald-600 dark:text-emerald-400",
    amber: "text-amber-600 dark:text-amber-400",
    violet: "text-violet-600 dark:text-violet-400",
    sky: "text-sky-600 dark:text-sky-400",
  };
  return (
    <section className="velo-card overflow-hidden rounded-2xl dark:bg-slate-900 dark:border-slate-800">
      {title && (
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 bg-slate-50/70 px-5 py-4 dark:border-slate-800 dark:bg-slate-900/60">
          <div className="flex min-w-0 items-start gap-3">
            {icon && <span className={`mt-0.5 shrink-0 ${tones[tone]}`}>{icon}</span>}
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-velo-900 dark:text-white">{title}</h3>
              {description && <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>}
            </div>
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      <div className="px-5 py-2">{children}</div>
    </section>
  );
}
