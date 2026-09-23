// ============================================================================
// src/components/admin/ProgramEditor.tsx
// Per-program loan editor (Personal / Business) in the Platform Settings
// console. Restyled to the shared settings design language.
// ============================================================================

import type { LoanProgramConfig, LoanProgramKey, FeeKey } from "../../types/loan";
import FeeField from "./FeeField";
import { NairaField, Chip, Toggle } from "./settingsUI";

const PROGRAM_META: Record<LoanProgramKey, { title: string; blurb: string; accent: string; chip: string }> = {
  PERSONAL: {
    title: "Personal Loan",
    blurb: "Individual borrowers — quick, unsecured consumer credit.",
    accent: "from-velo-500 to-velo-600",
    chip: "bg-velo-100 text-velo-700 dark:bg-velo-900/60 dark:text-velo-300",
  },
  BUSINESS: {
    title: "Business Loan",
    blurb: "Registered businesses — working capital and growth finance.",
    accent: "from-violet-500 to-violet-600",
    chip: "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300",
  },
};

export default function ProgramEditor({ type, value, onChange }: { type: LoanProgramKey; value: LoanProgramConfig; onChange: (value: LoanProgramConfig) => void }) {
  const tenureOptions = [30, 60, 90, 180, 365];
  const meta = PROGRAM_META[type];
  function patch(patch: Partial<LoanProgramConfig>) { onChange({ ...value, ...patch }); }
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      {/* Program header strip */}
      <div className={`flex flex-col gap-3 bg-gradient-to-r ${meta.accent} px-4 py-3 sm:flex-row sm:items-center sm:justify-between`}>
        <div className="min-w-0">
          <h4 className="text-sm font-bold text-white">{meta.title}</h4>
          <p className="text-[11px] leading-4 text-white/80">{meta.blurb}</p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 self-start rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wider sm:self-auto ${meta.chip}`}>
          {type}
        </span>
      </div>

      <div className="p-4 sm:p-5">
        {/* Limits */}
        <div className="mb-4">
          <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Amount limits</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <NairaField compact label="Minimum" value={value.loanLimits.min} onChange={(n) => patch({ loanLimits: { ...value.loanLimits, min: n } })} />
            <NairaField compact label="Maximum" value={value.loanLimits.max} onChange={(n) => patch({ loanLimits: { ...value.loanLimits, max: n } })} />
            <NairaField compact label="Default" value={value.loanLimits.defaultAmount} onChange={(n) => patch({ loanLimits: { ...value.loanLimits, defaultAmount: n } })} />
          </div>
        </div>

        {/* Tenures */}
        <div className="mb-4">
          <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Available tenures</div>
          <div className="flex flex-wrap gap-2">
            {tenureOptions.map((days) => (
              <Chip
                key={days}
                selected={value.tenures.some((t) => t.value === days)}
                onClick={() =>
                  patch({
                    tenures: value.tenures.some((t) => t.value === days)
                      ? value.tenures.filter((t) => t.value !== days)
                      : [...value.tenures, { value: days, label: `${days} Days` }].sort((a, b) => a.value - b.value),
                  })
                }
              >
                {days} days
              </Chip>
            ))}
          </div>
        </div>

        {/* Fees */}
        <div className="mb-1">
          <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Program fees</div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {(Object.keys(value.fees) as FeeKey[]).map((key) => (
              <FeeField
                key={key}
                feeKey={key}
                label={key === "serviceFee" ? "Service Fee" : key === "processingFee" ? "Processing Fee" : key === "lateFee" ? "Default / Late Fee" : "Monthly Interest Rate"}
                baseFee={value.fees[key]}
                value={value.fees[key]}
                onChange={(fee) => patch({ fees: { ...value.fees, [key]: fee } })}
              />
            ))}
          </div>
        </div>

        {/* Collateral */}
        <div className="mt-4 space-y-2.5 border-t border-slate-100 pt-4 dark:border-slate-800">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-velo-900 dark:text-white">Collateral</div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Ask applicants for collateral details and media.</div>
            </div>
            <Toggle size="sm" checked={value.collateral.enabled} onChange={(on) => patch({ collateral: { ...value.collateral, enabled: on } })} />
          </div>
          {value.collateral.enabled && (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3.5 py-2.5 dark:bg-slate-800/60">
              <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">Require supporting media before submission</div>
              <Toggle size="sm" checked={value.collateral.required} onChange={(on) => patch({ collateral: { ...value.collateral, required: on } })} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
