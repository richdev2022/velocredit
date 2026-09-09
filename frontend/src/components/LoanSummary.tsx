// ============================================================================
// src/components/LoanSummary.tsx
// Professional summary card shown alongside the Loan Amount selector and on
// the Review screen.
// ============================================================================

import type { LoanCalculation } from "../types/loan";
import FeeBreakdown from "./FeeBreakdown";

interface LoanSummaryProps {
  calculation: LoanCalculation;
  title?: string;
}

export default function LoanSummary({ calculation, title = "Loan Summary" }: LoanSummaryProps) {
  return (
    <div className="velo-card p-5 sm:p-6 bg-gradient-to-br from-white to-slate-50 dark:from-slate-800 dark:to-slate-900">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-base sm:text-lg font-semibold text-velo-900">{title}</h3>
          <p className="text-xs text-slate-500 mt-0.5">Recalculated automatically as you change the amount or tenure.</p>
        </div>
        <span className="badge bg-velo-50 text-velo-700">Live</span>
      </div>

      <FeeBreakdown calculation={calculation} />
    </div>
  );
}
