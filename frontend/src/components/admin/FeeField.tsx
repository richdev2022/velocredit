import { useEffect, useState } from "react";
import type { FeeKey } from "../../types/loan";

type FeeValue = { type: "flat" | "percentage"; value: number; includeUpfront: boolean; enabled?: boolean };

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
    setDraftValue(raw);
    if (raw === "" || raw === ".") {
      onChange({ ...value, value: 0 });
      return;
    }
    const next = parseNumber(raw);
    if (Number.isFinite(next) && next >= 0) onChange({ ...value, value: next });
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 transition-colors dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-extrabold text-velo-900 text-xs dark:text-velo-100">{label}</div>
        {baseLabel ? (
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">vs {baseLabel}</span>
        ) : null}
      </div>
      <div className="grid grid-cols-[minmax(7.5rem,0.9fr)_minmax(7rem,1fr)_auto] items-center gap-2">
        <select
          value={value.type}
          onChange={(e) => onChange({ ...value, type: e.target.value as FeeValue["type"] })}
          className="velo-input !py-2 text-xs font-bold w-full"
        >
          <option value="flat">Flat (₦)</option>
          <option value="percentage">Percentage (%)</option>
        </select>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min={0}
          value={draftValue}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => {
            if (draftValue === "" || draftValue === ".") setDraftValue("0");
            else setDraftValue(formatNumber(parseNumber(draftValue)));
          }}
          className="velo-input !py-2 text-sm font-bold w-full min-w-0"
        />
        <span className="text-xs font-bold text-slate-500">{value.type === "flat" ? "₦" : "%"}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-slate-600 dark:text-slate-300">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value.enabled !== false}
            onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
            className="accent-velo-500"
          />
          Active globally
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value.includeUpfront}
            onChange={(e) => onChange({ ...value, includeUpfront: e.target.checked })}
            className="accent-velo-500"
          />
          Include in upfront total repayment
        </label>
      </div>
    </div>
  );
}

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
