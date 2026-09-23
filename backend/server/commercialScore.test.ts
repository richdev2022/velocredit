// ============================================================================
// Unit tests for the Commercial (Business) Advance bureau score derivation.
// The score must be DETERMINISTIC for a given report — underwriting depends
// on it — and every adjustment documented in deriveCommercialBureauScore must
// behave as specified.
// ============================================================================
import { describe, expect, it } from "vitest";
import { deriveCommercialBureauScore } from "./providers/prembly.js";

function sectionsFrom(overrides: {
  delinquency?: unknown;
  good?: number;
  bad?: number;
  arrears?: string;
  judgements?: string;
  dishonoured?: string;
  performing?: number;
  nonPerforming?: number;
}): Record<string, Array<Record<string, unknown>>> {
  const history: Array<Record<string, unknown>> = [];
  for (let i = 0; i < (overrides.performing ?? 0); i++) history.push({ PerformanceStatus: "PERFORMING" });
  for (let i = 0; i < (overrides.nonPerforming ?? 0); i++) history.push({ PerformanceStatus: "NON-PERFORMING" });
  return {
    HighestDelinquencyRating: [{ HighestDelinquencyRating: overrides.delinquency ?? "-1" }],
    FacilityPerformanceSummary: [
      {
        TotalAccounts: String((overrides.good ?? 0) + (overrides.bad ?? 0)),
        TotalaccountinGoodcondition: String(overrides.good ?? 0),
        TotalaccountinBadcondition: String(overrides.bad ?? 0),
        TotalAccountarrear: overrides.arrears ?? "0.00",
        TotalNumberofJudgement: overrides.judgements ?? "0",
        TotalNumberofDishonoured: overrides.dishonoured ?? "0",
        TotalOutstandingdebt: "0.00",
      },
    ],
    AccountMonthlyPaymentHistory: history,
  };
}

describe("deriveCommercialBureauScore", () => {
  it("thin file (delinquency -1, no facilities) stays at the 620 base", () => {
    const { score, breakdown } = deriveCommercialBureauScore(sectionsFrom({}));
    expect(score).toBe(620);
    expect(breakdown.delinquencyRating).toBe("-1");
    expect(breakdown.finalScore).toBe(620);
  });

  it("adds +15 per performing facility (capped)", () => {
    expect(deriveCommercialBureauScore(sectionsFrom({ performing: 1 })).score).toBe(635);
    expect(deriveCommercialBureauScore(sectionsFrom({ performing: 3 })).score).toBe(665);
    // cap: +75 → 695
    expect(deriveCommercialBureauScore(sectionsFrom({ performing: 10 })).score).toBe(695);
  });

  it("subtracts per delinquency level 1..5", () => {
    expect(deriveCommercialBureauScore(sectionsFrom({ delinquency: "1" })).score).toBe(560);
    expect(deriveCommercialBureauScore(sectionsFrom({ delinquency: "3" })).score).toBe(440);
    // severity capped at level 5 → −300 → 320
    expect(deriveCommercialBureauScore(sectionsFrom({ delinquency: "7" })).score).toBe(320);
  });

  it("penalises bad-condition accounts, arrears, judgements and dishonoured cheques", () => {
    const sections = sectionsFrom({ bad: 2, arrears: "45,000.00", judgements: "1", dishonoured: "1" });
    // 620 − 90 (bad) − 40 (arrears) − 70 (judgement) − 30 (dishonoured) = 390
    expect(deriveCommercialBureauScore(sections).score).toBe(390);
  });

  it("rewards good standing and combines with penalties, clamped to 300–850", () => {
    const sections = sectionsFrom({ good: 2, bad: 1, performing: 2, nonPerforming: 1 });
    // 620 + 50 (good) − 45 (bad) + 30 (performing) − 35 (non-performing) = 620
    expect(deriveCommercialBureauScore(sections).score).toBe(620);
    // catastrophic file floors at 300
    const worst = sectionsFrom({ delinquency: "5", bad: 10, arrears: "1,000,000", judgements: "5", dishonoured: "5", nonPerforming: 10 });
    expect(deriveCommercialBureauScore(worst).score).toBe(300);
  });

  it("parses comma-formatted numbers and treats empty delinquency as none", () => {
    const sections = sectionsFrom({ arrears: "12,500.50" });
    expect(deriveCommercialBureauScore(sections).score).toBe(580);
    expect(deriveCommercialBureauScore(sectionsFrom({ delinquency: "" })).score).toBe(620);
  });
});
