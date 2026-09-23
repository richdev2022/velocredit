import { useEffect, useState } from "react";
import type { FeeKey } from "../../types/loan";
import { Segmented, Toggle, type FeeValue } from "./settingsUI";

// Permissive decimal regex — allows: "", "0", "0.", "0.1", ".5", "12.345", etc.
const DECIMAL_REGEX = /^\d*\.?\d*$/;

function parseNumber(s: string): number {
  // Allow leading/trailing dot, e.g. ".5" or "5."
  const normalized = s.trim();
  if (normalized === "" || normalized === ".") return 0;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  // Round to 2 decimals to avoid floating-point noise like 0.30000000000000004.
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}

export default function FeeField({ label, value, onChange, baseLabel }: { feeKey: FeeKey; label: string; baseFee: FeeValue; baseLabel?: string; value: FeeValue; onChange: (value: FeeValue) => void }) {
  // Keep a raw text draft so the user can type "0.", "0.1", ".5", etc. without
  // the input snapping back to "0" while they are still typing.
  const [draftValue, setDraftValue] = useState<string>(() => formatNumber(value.value));

  // Re-sync the draft when the upstream value changes externally (e.g. reset).
  useEffect(() => {
    if (parseNumber(draftValue) !== value.value) setDraftValue(formatNumber(value.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.value]);

  function commit(raw: string) {
    // Strip anything that's not a digit or dot so paste-from-clipboard is safe.
    const cleaned = raw.replace(/[^\d.]/g, "");
    // Only allow one dot.
    const firstDot = cleaned.indexOf(".");
    const normalized = firstDot >= 0
      ? cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "")
      : cleaned;
    if (!DECIMAL_REGEX.test(normalized)) return;
    setDraftValue(normalized);
    if (normalized === "" || normalized === ".") {
      onChange({ ...value, value: 0 });
      return;
    }
    const next = parseNumber(normalized);
    if (Number.isFinite(next) && next >= 0) onChange({ ...value, value: next });
  }

  const isPercent = value.type === "percentage";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3.5 transition-colors dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="min-w-0 text-xs font-bold text-velo-900 dark:text-velo-100">{label}</div>
        {baseLabel ? (
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">vs {baseLabel}</span>
        ) : null}
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
            <span className="absolute right-9 top-1/2 -translate-y-1/2 select-none text-sm font-bold text-slate-400">%</span>
          ) : (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 select-none text-sm font-bold text-slate-400">₦</span>
          )}
          <input
            type="text"
            inputMode="decimal"
            value={draftValue}
            onChange={(e) => commit(e.target.value)}
            onBlur={() => {
              if (draftValue === "" || draftValue === ".") setDraftValue("0");
              else setDraftValue(formatNumber(parseNumber(draftValue)));
            }}
            className={`velo-input !py-2 text-sm font-semibold ${isPercent ? "!pr-8" : "!pl-9"}`}
            placeholder="0"
          />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-100 pt-2.5 dark:border-slate-800">
        <Toggle size="sm" checked={value.enabled !== false} onChange={(e) => onChange({ ...value, enabled: e })} label="Active" />
        <Toggle size="sm" checked={value.includeUpfront} onChange={(e) => onChange({ ...value, includeUpfront: e })} label="Charge upfront" />
      </div>
    </div>
  );
}
