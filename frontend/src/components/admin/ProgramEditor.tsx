import type { LoanProgramConfig, LoanProgramKey, FeeKey } from "../../types/loan";
import FeeField from "./FeeField";

export default function ProgramEditor({ type, value, onChange }: { type: LoanProgramKey; value: LoanProgramConfig; onChange: (value: LoanProgramConfig) => void }) {
  const tenureOptions = [30, 60, 90, 180, 365];
  function patch(patch: Partial<LoanProgramConfig>) { onChange({ ...value, ...patch }); }
  return (
    <div className="rounded-2xl border border-slate-200 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div><h4 className="font-extrabold text-velo-900">{type === "PERSONAL" ? "Personal Loan" : "Business Loan"}</h4><p className="text-xs text-slate-500">Applicants using this loan type see these settings.</p></div>
        <label className="flex items-center gap-2 text-xs font-bold text-slate-600"><input type="checkbox" checked={value.collateral.enabled} onChange={(e) => patch({ collateral: { ...value.collateral, enabled: e.target.checked } })} className="h-4 w-4 accent-velo-500" /> Collateral enabled</label>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <NumberField label="Minimum amount" value={value.loanLimits.min} onChange={(n) => patch({ loanLimits: { ...value.loanLimits, min: n } })} />
        <NumberField label="Maximum amount" value={value.loanLimits.max} onChange={(n) => patch({ loanLimits: { ...value.loanLimits, max: n } })} />
        <NumberField label="Default amount" value={value.loanLimits.defaultAmount} onChange={(n) => patch({ loanLimits: { ...value.loanLimits, defaultAmount: n } })} />
      </div>
      <div className="mb-4"><div className="text-xs font-bold text-velo-900 mb-2">Available tenures</div><div className="flex flex-wrap gap-2">{tenureOptions.map((days) => <label key={days} className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-bold"><input type="checkbox" checked={value.tenures.some((t) => t.value === days)} onChange={(e) => patch({ tenures: e.target.checked ? [...value.tenures, { value: days, label: `${days} Days` }].sort((a, b) => a.value - b.value) : value.tenures.filter((t) => t.value !== days) })} className="accent-velo-500" />{days} days</label>)}</div></div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {(Object.keys(value.fees) as FeeKey[]).map((key) => <FeeField key={key} feeKey={key} label={key === "serviceFee" ? "Service Fee" : key === "processingFee" ? "Processing Fee" : key === "lateFee" ? "Default / Late Fee" : "Monthly Interest Rate"} baseFee={value.fees[key]} value={value.fees[key]} onChange={(fee) => patch({ fees: { ...value.fees, [key]: fee } })} />)}
      </div>
      {value.collateral.enabled && <label className="mt-4 flex items-center gap-2 text-xs font-bold text-slate-600"><input type="checkbox" checked={value.collateral.required} onChange={(e) => patch({ collateral: { ...value.collateral, required: e.target.checked } })} className="h-4 w-4 accent-velo-500" /> Require collateral details and supporting media</label>}
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="block"><span className="block text-[11px] font-bold text-velo-900 mb-1">{label}</span><input className="velo-input text-sm font-bold" inputMode="numeric" value={value.toLocaleString("en-NG")} onChange={(e) => onChange(Number(e.target.value.replace(/[^0-9]/g, "")) || 0)} /></label>;
}
