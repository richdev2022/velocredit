import type { FeeKey } from "../../types/loan";

type FeeValue = { type: "flat" | "percentage"; value: number; includeUpfront: boolean };

export default function FeeField({ label, value, onChange }: { feeKey: FeeKey; label: string; baseFee: FeeValue; value: FeeValue; onChange: (value: FeeValue) => void }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="font-extrabold text-velo-900 text-xs mb-2">{label}</div>
      <div className="grid grid-cols-[minmax(7.5rem,0.9fr)_minmax(7rem,1fr)_auto] items-center gap-2">
        <select value={value.type} onChange={(e) => onChange({ ...value, type: e.target.value as FeeValue["type"] })} className="velo-input !py-2 text-xs font-bold w-full">
          <option value="flat">Flat (₦)</option>
          <option value="percentage">Percentage (%)</option>
        </select>
        <input
          type="text"
          inputMode="decimal"
          min={0}
          value={value.value}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              onChange({ ...value, value: 0 });
              return;
            }
            const next = Number(raw);
            if (Number.isFinite(next) && next >= 0) onChange({ ...value, value: next });
          }}
          className="velo-input !py-2 text-sm font-bold w-full min-w-0"
        />
        <span className="text-xs font-bold text-slate-500">{value.type === "flat" ? "₦" : "%"}</span>
      </div>
      <label className="mt-2 flex items-center gap-2 text-[11px] text-slate-600">
        <input type="checkbox" checked={value.includeUpfront} onChange={(e) => onChange({ ...value, includeUpfront: e.target.checked })} className="accent-velo-500" />
        Include in upfront total repayment
      </label>
    </div>
  );
}
