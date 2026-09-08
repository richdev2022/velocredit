// ============================================================================
// src/utils/feeCalculator.ts
// Per-fee calculation utility. Pure functions — no React, no side effects.
// ============================================================================

import type { FeeConfig, FeeKey } from "../types/loan";

/**
 * Calculate a single fee given a loan amount and a fee config.
 *   flat        => fee.value (in Naira)
 *   percentage  => loanAmount * fee.value / 100
 */
export function calculateFee(amount: number, fee: FeeConfig): number {
  if (!fee || fee.value == null || Number.isNaN(fee.value)) return 0;
  if (amount <= 0) return fee.type === "flat" ? fee.value : 0;
  if (fee.type === "flat") return fee.value;
  if (fee.type === "percentage") return (amount * fee.value) / 100;
  return 0;
}

/**
 * Returns the human-readable category for a fee key. Used by both the
 * calculator (for grouping) and the UI (for labels & ordering).
 */
export function feeCategory(key: FeeKey): "loan-cost" | "application-fee" | "default-fee" {
  switch (key) {
    case "interest":      return "loan-cost";
    case "serviceFee":    return "application-fee";
    case "processingFee": return "application-fee";
    case "lateFee":       return "default-fee";
  }
}

export const FEE_LABELS: Record<FeeKey, string> = {
  interest: "Interest",
  serviceFee: "Service Fee",
  processingFee: "Processing Fee",
  lateFee: "Late Fee",
};
