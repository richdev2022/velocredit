import { describe, expect, it } from "vitest";
import { getEffectiveConfig, resolveApiUrl, config, applyLoanProducts, baseConfig, sanitizeLoanLimits, safeNaira } from "./config";

describe("loan configuration", () => {
  it("propagates global transaction limits to every loan program", () => {
    const config = getEffectiveConfig({
      loanLimits: { min: 200000, max: 12000000, defaultAmount: 750000 },
      loanPrograms: {
        PERSONAL: { loanLimits: { min: 1, max: 2, defaultAmount: 1 } },
        BUSINESS: { loanLimits: { min: 3, max: 4, defaultAmount: 3 } },
      },
    });

    expect(config.loanLimits).toEqual({ min: 200000, max: 12000000, defaultAmount: 750000 });
    expect(config.loanPrograms.PERSONAL.loanLimits).toEqual(config.loanLimits);
    expect(config.loanPrograms.BUSINESS.loanLimits).toEqual(config.loanLimits);
  });

  it("uses the deployed API when a production build still has the local default", () => {
    expect(resolveApiUrl("http://localhost:4000", "velocredit.ng")).toBe("https://velocredit.onrender.com");
    expect(resolveApiUrl("http://localhost:4000", "localhost")).toBe("http://localhost:4000");
  });

  it("keeps per-program fee overrides independent", () => {
    const config = getEffectiveConfig({
      fees: { interest: { value: 4 } },
      loanPrograms: {
        PERSONAL: { fees: { interest: { value: 6 } } },
        BUSINESS: { fees: { interest: { value: 8 } } },
      },
    });

    expect(config.loanPrograms.PERSONAL.fees.interest.value).toBe(6);
    expect(config.loanPrograms.BUSINESS.fees.interest.value).toBe(8);
  });
});

describe("applyLoanProducts (admin-set limits reaching the borrower)", () => {
  it("applies a valid personal product so the borrower sees the admin limits", () => {
    // Reset to defaults first so the test is order-independent.
    refreshTestConfig();
    applyLoanProducts([
      { name: "Personal Loan", minAmountNaira: 200, maxAmountNaira: 30_000_000, interestRatePercent: 4, processingFeePercent: 2, lateFeePercent: 1 },
    ]);
    expect(config.loanPrograms.PERSONAL.loanLimits.min).toBe(200);
    expect(config.loanPrograms.PERSONAL.loanLimits.max).toBe(30_000_000);
    expect(config.loanLimits.min).toBe(200);
  });

  it("skips invalid products (min >= max, negative, non-finite) instead of clobbering config", () => {
    refreshTestConfig();
    const before = { ...config.loanPrograms.PERSONAL.loanLimits };
    applyLoanProducts([
      { name: "Personal Loan", minAmountNaira: 50_000, maxAmountNaira: 50_000, interestRatePercent: 4, processingFeePercent: 2, lateFeePercent: 1 },
      { name: "Personal Loan", minAmountNaira: -5, maxAmountNaira: 10_000, interestRatePercent: 4, processingFeePercent: 2, lateFeePercent: 1 },
      { name: "Personal Loan", minAmountNaira: Number.NaN, maxAmountNaira: 10_000, interestRatePercent: 4, processingFeePercent: 2, lateFeePercent: 1 },
    ]);
    expect(config.loanPrograms.PERSONAL.loanLimits).toEqual(before);
  });

  it("does not touch global limits when no valid product could be applied", () => {
    refreshTestConfig();
    const before = { ...config.loanLimits };
    applyLoanProducts([
      { name: "Unknown Widget Loan", minAmountNaira: 100, maxAmountNaira: 5_000, interestRatePercent: 4, processingFeePercent: 2, lateFeePercent: 1 },
      { name: "Business Loan", minAmountNaira: 500_000, maxAmountNaira: 500_000, interestRatePercent: 4, processingFeePercent: 2, lateFeePercent: 1 },
    ]);
    expect(config.loanLimits).toEqual(before);
  });
});

describe("sanitizeLoanLimits (Admin toLocaleString crash regression)", () => {
  it("coerces corrupt localStorage / API values (undefined, null, NaN, negative) to finite defaults", () => {
    const fb = baseConfig.loanLimits;
    expect(sanitizeLoanLimits(undefined)).toEqual(fb);
    expect(sanitizeLoanLimits(null)).toEqual(fb);
    expect(sanitizeLoanLimits({})).toEqual(fb);
    expect(sanitizeLoanLimits({ min: undefined, max: null, defaultAmount: Number.NaN }).min).toBe(fb.min);
    expect(sanitizeLoanLimits({ min: undefined, max: null, defaultAmount: Number.NaN }).max).toBe(fb.max);
    expect(sanitizeLoanLimits({ min: undefined, max: null, defaultAmount: Number.NaN }).defaultAmount).toBe(fb.defaultAmount);
    expect(sanitizeLoanLimits({ min: -5, max: 0, defaultAmount: 100 }).min).toBeGreaterThanOrEqual(0);
  });

  it("enforces min <= max ordering and clamps defaultAmount into range", () => {
    const out = sanitizeLoanLimits({ min: 300, max: 200, defaultAmount: 100000 });
    expect(out.min).toBe(200);
    expect(out.max).toBe(300);
    expect(out.defaultAmount).toBe(300);
    const out2 = sanitizeLoanLimits({ min: 200, max: 300, defaultAmount: 5 });
    expect(out2.defaultAmount).toBe(200);
  });

  it("getEffectiveConfig never returns non-finite limits even with a corrupt override", () => {
    const eff = getEffectiveConfig({
      loanLimits: { min: undefined, max: null, defaultAmount: Number.NaN } as any,
      loanPrograms: {
        PERSONAL: { loanLimits: { min: null, max: undefined, defaultAmount: -10 } as any },
      },
    });
    expect(Number.isFinite(eff.loanLimits.min)).toBe(true);
    expect(Number.isFinite(eff.loanLimits.max)).toBe(true);
    expect(Number.isFinite(eff.loanLimits.defaultAmount)).toBe(true);
    expect(Number.isFinite(eff.loanPrograms.PERSONAL.loanLimits.min)).toBe(true);
    expect(Number.isFinite(eff.loanPrograms.PERSONAL.loanLimits.max)).toBe(true);
  });

  it("safeNaira never throws and never renders 'undefined'/'NaN'", () => {
    expect(safeNaira(undefined)).toBe("—");
    expect(safeNaira(null)).toBe("—");
    expect(safeNaira(Number.NaN)).toBe("—");
    expect(safeNaira(1234.5).length).toBeGreaterThan(0);
  });
});

/** Reset the singleton config to baseline so tests don't leak state. */
function refreshTestConfig() {
  Object.assign(config, getEffectiveConfig({}));
  config.loanLimits = { ...baseConfig.loanLimits };
  config.tenures = baseConfig.tenures.slice();
  config.loanPrograms = {
    PERSONAL: structuredClone(baseConfig.loanPrograms.PERSONAL),
    BUSINESS: structuredClone(baseConfig.loanPrograms.BUSINESS),
  };
  config.fees = structuredClone(baseConfig.fees);
}
