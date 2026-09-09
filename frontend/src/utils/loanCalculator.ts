// ============================================================================
// src/utils/loanCalculator.ts
// Independent calculation engine. No React, no DOM, no fetch.
// Imported by UI components, the agreement generator, and the Apps Script
// client. Keep it pure.
// ============================================================================

import type {
  FeeBreakdownItem,
  FeeConfiguration,
  FeeKey,
  LoanCalculation,
} from "../types/loan";
import { config, getLoanProgram, resolveFeesForTenure } from "./config";
import type { LoanProgramKey } from "../types/loan";
import { calculateFee, FEE_LABELS, feeCategory } from "./feeCalculator";

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function formatDateLabel(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

export interface CalculateOptions {
  /** Override the global fee config (used by tests / preview) */
  fees?: FeeConfiguration;
  /** Override "today" for deterministic testing */
  today?: Date;
  loanType?: LoanProgramKey;
}

/**
 * Calculate the full loan breakdown.
 *
 * Note on late fees:
 *   By default late fees are NOT included in the initial repayment total.
 *   They are surfaced separately as informational. To include them in the
 *   initial repayment, set VITE_INCLUDE_LATE_FEE_UPFRONT=true.
 */
export function calculateLoan(
  amount: number,
  tenureDays: number,
  options: CalculateOptions = {}
): LoanCalculation {
  const today = options.today ?? new Date();
  const program = options.loanType ? getLoanProgram(options.loanType) : getLoanProgram("PERSONAL");
  const safeAmount = clampAmount(amount, program.loanLimits);
  const safeTenure = clampTenure(tenureDays, program.tenures);
  const fees = options.fees ?? resolveFeesForTenure({ ...config, ...program }, safeTenure);

  const interest      = calculateTermInterest(safeAmount, fees.interest, safeTenure);
  const serviceFee    = calculateFee(safeAmount, fees.serviceFee);
  const processingFee = calculateFee(safeAmount, fees.processingFee);
  const lateFee       = calculateFee(safeAmount, fees.lateFee);

  const breakdown: FeeBreakdownItem[] = [
    { key: "interest",      label: FEE_LABELS.interest,      amount: interest,      category: feeCategory("interest") },
    { key: "serviceFee",    label: FEE_LABELS.serviceFee,    amount: serviceFee,    category: feeCategory("serviceFee") },
    { key: "processingFee", label: FEE_LABELS.processingFee, amount: processingFee, category: feeCategory("processingFee") },
  ];

  // Upfront total = (loan cost + application fees) that are flagged includeUpfront
  const upfrontFees =
    (fees.interest.includeUpfront      ? interest      : 0) +
    (fees.serviceFee.includeUpfront    ? serviceFee    : 0) +
    (fees.processingFee.includeUpfront ? processingFee : 0) +
    (fees.lateFee.includeUpfront       ? lateFee       : 0);

  const totalFees     = upfrontFees;
  const totalRepayment = safeAmount + totalFees;

  const disbursementDate = today;
  const repaymentDate    = addDays(today, safeTenure);

  return {
    loanAmount: safeAmount,
    interest,
    serviceFee,
    processingFee,
    lateFee,
    totalFees,
    totalRepayment,
    upfrontFees,
    loanCost: interest,
    defaultFee: lateFee,
    tenure: safeTenure,
    tenureLabel: `${safeTenure} Days`,
    disbursementDate: disbursementDate.toISOString(),
    repaymentDate: repaymentDate.toISOString(),
    repaymentDateLabel: formatDateLabel(repaymentDate.toISOString()),
    breakdown,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const LOAN_AMOUNT_SUGGESTIONS = [500_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000, 10_000_000] as const;

export function getSuggestedLoanAmounts(min: number, max: number): number[] {
  return LOAN_AMOUNT_SUGGESTIONS.filter((amount) => amount >= min && amount <= max);
}

export function calculateMonthlyInterest(amount: number, fee: FeeConfiguration["interest"]): number {
  return calculateFee(amount, fee);
}

export function calculateTermInterest(amount: number, fee: FeeConfiguration["interest"], tenureDays: number): number {
  const monthlyInterest = calculateMonthlyInterest(amount, fee);
  const months = tenureDays / 30;
  return fee.type === "percentage" ? Math.round(monthlyInterest * months) : monthlyInterest;
}

/** @deprecated Use calculateMonthlyInterest. Kept for callers outside the UI. */
export const calculateDailyInterest = calculateMonthlyInterest;

export function clampAmount(value: number, limits = config.loanLimits): number {
  const { min, max } = limits;
  if (!Number.isFinite(value)) return config.loanLimits.defaultAmount;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampTenure(value: number, options = config.tenures): number {
  const tenures = options.map((t) => t.value);
  if (tenures.length === 0) return 30;
  if (tenures.includes(value)) return value;
  // fall back to the closest configured tenure
  return tenures.reduce((closest, candidate) =>
    Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest
  , tenures[0]);
}

// ---------------------------------------------------------------------------
// Formatting — used by UI and by the agreement generator
// ---------------------------------------------------------------------------

export function formatNaira(value: number): string {
  if (!Number.isFinite(value)) return "₦0";
  return "₦" + Math.round(value).toLocaleString("en-NG");
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString("en-NG");
}

/**
 * Returns the breakdown split by category. Used by the fee-breakdown UI to
 * show "Application Fees" vs "Loan Cost" vs "Default Fee" cleanly.
 */
export function breakdownByCategory(calc: LoanCalculation): {
  loanCost: FeeBreakdownItem[];
  applicationFees: FeeBreakdownItem[];
  defaultFees: FeeBreakdownItem[];
} {
  const loanCost: FeeBreakdownItem[] = [];
  const applicationFees: FeeBreakdownItem[] = [];
  const defaultFees: FeeBreakdownItem[] = [];

  for (const item of calc.breakdown) {
    if (item.category === "loan-cost") loanCost.push(item);
    else if (item.category === "application-fee") applicationFees.push(item);
    else if (item.category === "default-fee") defaultFees.push(item);
  }

  // Always surface the late fee separately, even when not part of breakdown[]
  if (calc.lateFee > 0 && !defaultFees.find((d) => d.key === "lateFee")) {
    defaultFees.push({
      key: "lateFee" as FeeKey,
      label: FEE_LABELS.lateFee,
      amount: calc.lateFee,
      category: "default-fee",
    });
  }

  return { loanCost, applicationFees, defaultFees };
}
