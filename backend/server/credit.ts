export const CREDIT_SCORE_VERSION = "internal-v1";
export type CreditFactor = { code: string; label: string; impact: number; detail: string };
export type CreditScoreInput = { completedLoans: number; onTimePayments: number; latePayments: number; defaultedLoans: number; outstandingMinor: number; totalBorrowedMinor: number; kycVerified: boolean; bureauScore?: number | null };
export type CreditScoreResult = { version: string; score: number; band: "VERY_POOR" | "POOR" | "FAIR" | "GOOD" | "VERY_GOOD"; factors: CreditFactor[]; calculatedAt: string };

export function calculateCreditScore(input: CreditScoreInput): CreditScoreResult {
  const factors: CreditFactor[] = [];
  let score = 500;
  const totalPayments = input.onTimePayments + input.latePayments;
  const onTimeRate = totalPayments ? input.onTimePayments / totalPayments : 0;
  const paymentImpact = Math.round((onTimeRate - 0.5) * 240);
  score += paymentImpact;
  factors.push({ code: "PAYMENT_TIMELINESS", label: "Payment timeliness", impact: paymentImpact, detail: totalPayments ? `${Math.round(onTimeRate * 100)}% of recorded repayments were on time.` : "No verified repayments recorded yet." });
  const historyImpact = Math.min(input.completedLoans * 24, 120);
  score += historyImpact;
  factors.push({ code: "REPAYMENT_HISTORY", label: "Completed loan history", impact: historyImpact, detail: `${input.completedLoans} completed loan(s) contribute to account history.` });
  const defaultImpact = -Math.min(input.defaultedLoans * 140, 280);
  score += defaultImpact;
  if (input.defaultedLoans) factors.push({ code: "DEFAULTS", label: "Default history", impact: defaultImpact, detail: `${input.defaultedLoans} defaulted loan(s) reduce the score.` });
  const utilization = input.totalBorrowedMinor ? input.outstandingMinor / input.totalBorrowedMinor : 0;
  const utilizationImpact = -Math.round(Math.min(utilization, 1) * 100);
  score += utilizationImpact;
  factors.push({ code: "OUTSTANDING_BALANCE", label: "Outstanding balance", impact: utilizationImpact, detail: input.totalBorrowedMinor ? `${Math.round(utilization * 100)}% of borrowed principal remains outstanding.` : "No borrowed principal recorded." });
  if (input.kycVerified) { score += 30; factors.push({ code: "KYC_VERIFIED", label: "Identity verification", impact: 30, detail: "Required identity verification is marked complete." }); }
    if (input.bureauScore != null && Number.isFinite(input.bureauScore)) {
      const bureauScore = Math.max(300, Math.min(850, Math.round(input.bureauScore)));
      const bureauImpact = Math.max(-80, Math.min(80, Math.round((bureauScore - 500) * 0.2)));
      score += bureauImpact;
      factors.push({
        code: "BUREAU_INPUT",
        label: "External credit bureau input",
        impact: bureauImpact,
        detail: `A consented external bureau score of ${bureauScore} was included in this calculation.`,
      });
    }
  const bounded = Math.max(300, Math.min(850, score));
  const band = bounded >= 750 ? "VERY_GOOD" : bounded >= 680 ? "GOOD" : bounded >= 600 ? "FAIR" : bounded >= 500 ? "POOR" : "VERY_POOR";
  return { version: CREDIT_SCORE_VERSION, score: bounded, band, factors, calculatedAt: new Date().toISOString() };
}
