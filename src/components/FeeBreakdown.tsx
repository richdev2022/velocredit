// ============================================================================
// src/components/FeeBreakdown.tsx
// Line-item list of all applicable fees + repayment summary.
// Late fee is shown separately as "if applicable" since it's a default fee,
// not part of the initial repayment total (unless configured otherwise).
// ============================================================================

import type { LoanCalculation } from "../types/loan";
import { breakdownByCategory, formatNaira } from "../utils/loanCalculator";

interface FeeBreakdownProps {
  calculation: LoanCalculation;
  compact?: boolean;
}

export default function FeeBreakdown({ calculation, compact = false }: FeeBreakdownProps) {
  const { loanCost, applicationFees, defaultFees } = breakdownByCategory(calculation);
  const showLateFee = defaultFees.some((f) => f.key === "lateFee" && f.amount > 0);

  return (
    <div className="space-y-1">
      {/* Loan Amount */}
      <Row label="Loan Amount" value={formatNaira(calculation.loanAmount)} muted />

      {/* Loan cost (interest) */}
      {loanCost.map((f) => (
        <Row key={f.key} label={f.label} value={formatNaira(f.amount)} />
      ))}

      {/* Application fees */}
      {applicationFees.map((f) => (
        <Row key={f.key} label={f.label} value={formatNaira(f.amount)} />
      ))}

      {/* Late fee — only shown as informational, NOT added to total */}
      {showLateFee && !compact && (
        <Row
          label="Late Fee (applies only on default)"
          value={formatNaira(calculation.lateFee)}
          small
          muted
        />
      )}

      <div className="border-t border-slate-200 my-2" />

      <Row label="Total Fees" value={formatNaira(calculation.totalFees)} bold />
      <Row label="Total Repayment" value={formatNaira(calculation.totalRepayment)} bold highlight />

      <div className="border-t border-slate-200 my-2" />

      <Row label="Tenure" value={calculation.tenureLabel} />
      <Row label="Repayment Date" value={calculation.repaymentDateLabel} />
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  muted,
  small,
  highlight,
}: {
  label: string;
  value: string;
  bold?: boolean;
  muted?: boolean;
  small?: boolean;
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3
        ${bold ? "font-semibold" : "font-normal"}
        ${highlight ? "text-velo-700" : muted ? "text-slate-500" : "text-velo-900"}
        ${small ? "text-xs" : "text-sm"}
      `}
    >
      <span>{label}</span>
      <span className={bold ? "text-base" : ""}>{value}</span>
    </div>
  );
}
