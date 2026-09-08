import { env } from "./config.js";
import type { CreditScoreResult } from "./credit.js";

export type LoanDecision = "SYSTEM_ELIGIBLE" | "SYSTEM_REVIEW_REQUIRED" | "SYSTEM_INELIGIBLE";
export function evaluateLoanEligibility(score: CreditScoreResult, requestedAmountNaira: number): { decision: LoanDecision; reasons: string[]; evaluatedAt: string; policy: { eligibleScoreMin: number; reviewScoreMin: number } } {
  const reasons = score.factors.filter((factor) => factor.impact < 0).map((factor) => factor.detail);
  const decision = score.score >= env.LOAN_AUTO_ELIGIBLE_SCORE_MIN && requestedAmountNaira > 0 ? "SYSTEM_ELIGIBLE" : score.score >= env.LOAN_AUTO_REVIEW_SCORE_MIN ? "SYSTEM_REVIEW_REQUIRED" : "SYSTEM_INELIGIBLE";
  if (decision === "SYSTEM_ELIGIBLE") reasons.unshift("The internal score meets the configured automatic eligibility threshold; loan manager review is still required before disbursement.");
  if (decision === "SYSTEM_REVIEW_REQUIRED") reasons.unshift("The internal score is within the manual-review band.");
  if (decision === "SYSTEM_INELIGIBLE") reasons.unshift("The internal score is below the configured review threshold.");
  return { decision, reasons, evaluatedAt: new Date().toISOString(), policy: { eligibleScoreMin: env.LOAN_AUTO_ELIGIBLE_SCORE_MIN, reviewScoreMin: env.LOAN_AUTO_REVIEW_SCORE_MIN } };
}
