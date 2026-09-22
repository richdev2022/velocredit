import { describe, expect, it } from "vitest";
import { getEffectiveConfig, resolveApiUrl, config, applyLoanProducts, applyLoanProduct, baseConfig, sanitizeLoanLimits, safeNaira } from "./config";
import { calculateTermInterest } from "./loanCalculator";

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

  it("skips invalid products but still maps the single valid one (never-empty fallback)", () => {
    refreshTestConfig();
    // "Business Loan" is invalid (min >= max) and must never clobber config.
    // The platform's one VALID product has no personal/business keyword — the
    // intelligent fallback must still map it so no flow renders empty info.
    applyLoanProducts([
      { name: "Unknown Widget Loan", minAmountNaira: 100, maxAmountNaira: 5_000, interestRatePercent: 4, processingFeePercent: 2, lateFeePercent: 1 },
      { name: "Business Loan", minAmountNaira: 500_000, maxAmountNaira: 500_000, interestRatePercent: 4, processingFeePercent: 2, lateFeePercent: 1 },
    ]);
    expect(config.loanPrograms.PERSONAL.loanLimits.min).toBe(100);
    expect(config.loanPrograms.PERSONAL.loanLimits.max).toBe(5_000);
    expect(config.loanPrograms.PERSONAL.productName).toBe("Unknown Widget Loan");
    // The invalid product is skipped — BUSINESS reuses the valid one instead.
    expect(config.loanPrograms.BUSINESS.loanLimits.min).toBe(100);
  });

  it("duplicate rows with the same id must not resurrect stale seed values (production ₦200-vs-₦50,000 regression)", () => {
    refreshTestConfig();
    // Exactly what production once served: the admin-renamed product (v2) AND
    // a stale pre-rename copy with the SAME id and OLD seed terms (v1), listed
    // AFTER the admin row. The stale copy must never win.
    applyLoanProducts([
      { id: "prod-1", name: "Personal Loan", minAmountNaira: 200, maxAmountNaira: 30_000_000, interestRatePercent: 0.9, processingFeePercent: 0, lateFeePercent: 1, version: 2, updatedAt: "2026-09-21T07:36:48.403Z", isActive: true },
      { id: "prod-1", name: "Velo Personal Quick", minAmountNaira: 50_000, maxAmountNaira: 2_000_000, interestRatePercent: 18, processingFeePercent: 2, lateFeePercent: 1, version: 1, updatedAt: "2026-09-13T11:11:53.558Z", isActive: true },
      { id: "prod-2", name: "Business Loan", minAmountNaira: 200, maxAmountNaira: 30_000_000, interestRatePercent: 0.9, processingFeePercent: 0, lateFeePercent: 1, version: 2, updatedAt: "2026-09-21T07:36:50.940Z", isActive: true },
      { id: "prod-2", name: "Velo Business Boost", minAmountNaira: 500_000, maxAmountNaira: 10_000_000, interestRatePercent: 22, processingFeePercent: 3, lateFeePercent: 0.5, version: 1, updatedAt: "2026-09-13T11:11:53.558Z", isActive: true },
    ]);
    expect(config.loanPrograms.PERSONAL.loanLimits.min).toBe(200);
    expect(config.loanPrograms.PERSONAL.loanLimits.max).toBe(30_000_000);
    expect(config.loanPrograms.PERSONAL.fees.interest.value).toBe(0.9);
    expect(config.loanPrograms.PERSONAL.productName).toBe("Personal Loan");
    expect(config.loanPrograms.BUSINESS.loanLimits.min).toBe(200);
    expect(config.loanPrograms.BUSINESS.fees.interest.value).toBe(0.9);
    expect(config.loanLimits.min).toBe(200);
  });

  it("distinct products for the same type resolve to the highest version / newest updatedAt", () => {
    refreshTestConfig();
    applyLoanProducts([
      { id: "a", name: "Personal Loan", minAmountNaira: 1_000, maxAmountNaira: 5_000, interestRatePercent: 5, processingFeePercent: 1, lateFeePercent: 1, version: 2, updatedAt: "2026-01-01T00:00:00.000Z", isActive: true },
      { id: "b", name: "Velo Personal Quick", minAmountNaira: 2_000, maxAmountNaira: 9_000, interestRatePercent: 8, processingFeePercent: 1, lateFeePercent: 1, version: 3, updatedAt: "2026-02-01T00:00:00.000Z", isActive: true },
    ]);
    // Higher version (3) beats the other product even though it is listed last.
    expect(config.loanPrograms.PERSONAL.loanLimits.min).toBe(2_000);
    expect(config.loanPrograms.PERSONAL.loanLimits.max).toBe(9_000);
    expect(config.loanPrograms.PERSONAL.productName).toBe("Velo Personal Quick");
  });

  it("inactive products are never applied", () => {
    refreshTestConfig();
    const before = { ...config.loanPrograms.PERSONAL.loanLimits };
    applyLoanProducts([
      { id: "x", name: "Personal Loan", minAmountNaira: 123, maxAmountNaira: 4_567, interestRatePercent: 3, processingFeePercent: 1, lateFeePercent: 1, version: 9, isActive: false },
    ]);
    expect(config.loanPrograms.PERSONAL.loanLimits).toEqual(before);
  });

  it("programType overrides name keywords when the admin renames products away from personal/business", () => {
    refreshTestConfig();
    applyLoanProducts([
      { id: "p1", name: "Velo Flex Cash", minAmountNaira: 200, maxAmountNaira: 1_000_000, interestRatePercent: 4, processingFeePercent: 1, lateFeePercent: 1, version: 3, isActive: true, programType: "PERSONAL" },
      { id: "b1", name: "Velo Growth Fund", minAmountNaira: 500_000, maxAmountNaira: 10_000_000, interestRatePercent: 9, processingFeePercent: 2, lateFeePercent: 1, version: 2, isActive: true, programType: "BUSINESS" },
    ]);
    expect(config.loanPrograms.PERSONAL.productName).toBe("Velo Flex Cash");
    expect(config.loanPrograms.PERSONAL.loanLimits.min).toBe(200);
    expect(config.loanPrograms.BUSINESS.productName).toBe("Velo Growth Fund");
    expect(config.loanPrograms.BUSINESS.loanLimits.min).toBe(500_000);
  });

  it("a single renamed product with programType BOTH serves both borrower flows", () => {
    refreshTestConfig();
    applyLoanProducts([
      { id: "only", name: "Velo Universal Credit", minAmountNaira: 1_000, maxAmountNaira: 2_000_000, interestRatePercent: 6, processingFeePercent: 1, lateFeePercent: 1, version: 1, isActive: true, programType: "BOTH" },
    ]);
    expect(config.loanPrograms.PERSONAL.productName).toBe("Velo Universal Credit");
    expect(config.loanPrograms.BUSINESS.productName).toBe("Velo Universal Credit");
    expect(config.loanPrograms.PERSONAL.loanLimits.min).toBe(1_000);
    expect(config.loanPrograms.BUSINESS.loanLimits.min).toBe(1_000);
  });

  it("never leaves a flow empty: unmatched products fall back deterministically (cheapest -> PERSONAL)", () => {
    refreshTestConfig();
    applyLoanProducts([
      { id: "u1", name: "Velo Starter", minAmountNaira: 10_000, maxAmountNaira: 500_000, interestRatePercent: 5, processingFeePercent: 1, lateFeePercent: 1, version: 1, isActive: true },
      { id: "u2", name: "Velo Enterprise", minAmountNaira: 1_000_000, maxAmountNaira: 20_000_000, interestRatePercent: 11, processingFeePercent: 2, lateFeePercent: 1, version: 1, isActive: true },
    ]);
    expect(config.loanPrograms.PERSONAL.productName).toBe("Velo Starter");
    expect(config.loanPrograms.BUSINESS.productName).toBe("Velo Enterprise");
    expect(config.loanPrograms.PERSONAL.loanLimits.min).toBe(10_000);
    expect(config.loanPrograms.BUSINESS.loanLimits.min).toBe(1_000_000);
  });

  it("one unmatched product serves BOTH flows so neither renders empty", () => {
    refreshTestConfig();
    applyLoanProducts([
      { id: "solo", name: "Velo One", minAmountNaira: 5_000, maxAmountNaira: 5_000_000, interestRatePercent: 7, processingFeePercent: 1, lateFeePercent: 1, version: 1, isActive: true },
    ]);
    expect(config.loanPrograms.PERSONAL.productName).toBe("Velo One");
    expect(config.loanPrograms.BUSINESS.productName).toBe("Velo One");
  });

  it("explicit programType beats a keyword-name competitor of lower version", () => {
    refreshTestConfig();
    applyLoanProducts([
      { id: "kw", name: "Personal Loan", minAmountNaira: 300, maxAmountNaira: 3_000, interestRatePercent: 2, processingFeePercent: 1, lateFeePercent: 1, version: 1, isActive: true },
      { id: "ex", name: "Velo Prime", minAmountNaira: 800, maxAmountNaira: 8_000, interestRatePercent: 4, processingFeePercent: 1, lateFeePercent: 1, version: 5, isActive: true, programType: "PERSONAL" },
    ]);
    expect(config.loanPrograms.PERSONAL.productName).toBe("Velo Prime");
    expect(config.loanPrograms.PERSONAL.loanLimits.min).toBe(800);
  });

  it("ACTIVE product beats an inactive duplicate carrying a higher version", () => {
    refreshTestConfig();
    // The admin deactivated the newer row — the still-active one must serve
    // the flow, never the deactivated terms.
    applyLoanProducts([
      { id: "old-active", name: "Personal Loan", minAmountNaira: 1_500, maxAmountNaira: 15_000, interestRatePercent: 3, processingFeePercent: 1, lateFeePercent: 1, version: 1, isActive: true },
      { id: "new-inactive", name: "Velo Flex", minAmountNaira: 9_999, maxAmountNaira: 99_999, interestRatePercent: 9, processingFeePercent: 1, lateFeePercent: 1, version: 9, isActive: false, programType: "PERSONAL" },
    ]);
    expect(config.loanPrograms.PERSONAL.productName).toBe("Personal Loan");
    expect(config.loanPrograms.PERSONAL.loanLimits.min).toBe(1_500);
  });
});

describe("all-inactive catalog fallback (production incident 2026-09-21)", () => {
  // EXACT live payload: the admin configured both products but deactivated
  // them; the backend serves the full catalog flagged
  // ALL_PRODUCTS_INACTIVE_FALLBACK. Dropping the rows left the borrower with
  // env defaults (₦100,000 – ₦30,000,000 @ 5%) instead of the admin's terms.
  const allInactiveCatalog = [
    { id: "84610ec2", name: "Personal Loan", description: "Fast personal loan for salaried individuals", minAmountNaira: 200, maxAmountNaira: 30_000_000, defaultTenureDays: 30, interestRatePercent: 0.9, interestType: "ANNUALIZED" as const, processingFeePercent: 0, lateFeePercent: 1, lateFeeType: "COMPOUNDING_DAILY" as const, gracePeriodDays: 3, isActive: false, version: 4, programType: "PERSONAL" as const },
    { id: "885d6b34", name: "Business Loan", description: "Working capital for registered SMEs", minAmountNaira: 200, maxAmountNaira: 30_000_000, defaultTenureDays: 30, interestRatePercent: 0.9, interestType: "ANNUALIZED" as const, processingFeePercent: 0, lateFeePercent: 1, lateFeeType: "COMPOUNDING_DAILY" as const, gracePeriodDays: 5, isActive: false, version: 3, programType: "BUSINESS" as const },
  ];

  it("includeInactive flag (backend ALL_PRODUCTS_INACTIVE_FALLBACK) applies the admin-configured terms", () => {
    refreshTestConfig();
    applyLoanProducts(allInactiveCatalog, { includeInactive: true });
    expect(config.loanPrograms.PERSONAL.loanLimits.min).toBe(200);
    expect(config.loanPrograms.PERSONAL.loanLimits.max).toBe(30_000_000);
    expect(config.loanPrograms.PERSONAL.fees.interest.value).toBe(0.9);
    expect(config.loanPrograms.PERSONAL.productName).toBe("Personal Loan");
    expect(config.loanPrograms.BUSINESS.loanLimits.min).toBe(200);
    expect(config.loanPrograms.BUSINESS.productName).toBe("Business Loan");
    expect(config.loanLimits.min).toBe(200);
  });

  it("the fallback-applied program carries the FULL product detail for rendering", () => {
    refreshTestConfig();
    applyLoanProducts(allInactiveCatalog, { includeInactive: true });
    const product = config.loanPrograms.PERSONAL.product;
    expect(product).toBeTruthy();
    expect(product?.interestType).toBe("ANNUALIZED");
    expect(product?.processingFeePercent).toBe(0);
    expect(product?.lateFeePercent).toBe(1);
    expect(product?.gracePeriodDays).toBe(3);
    expect(product?.defaultTenureDays).toBe(30);
  });

  it("without the flag the inactive rows are still ignored (normal active-filtering path)", () => {
    refreshTestConfig();
    const before = { ...config.loanPrograms.PERSONAL.loanLimits };
    applyLoanProducts(allInactiveCatalog);
    expect(config.loanPrograms.PERSONAL.loanLimits).toEqual(before);
  });

  it("applyLoanProduct applies ONE product strictly to ONE flow (type-scoped endpoint contract)", () => {
    refreshTestConfig();
    const businessBefore = { ...config.loanPrograms.BUSINESS.loanLimits };
    const applied = applyLoanProduct(allInactiveCatalog[0], "PERSONAL");
    expect(applied).toBe(true);
    expect(config.loanPrograms.PERSONAL.productName).toBe("Personal Loan");
    expect(config.loanPrograms.PERSONAL.loanLimits.min).toBe(200);
    expect(config.loanPrograms.PERSONAL.fees.interest.value).toBe(0.9);
    // The OTHER flow must be untouched — no cross-contamination.
    expect(config.loanPrograms.BUSINESS.loanLimits).toEqual(businessBefore);
    expect(config.loanPrograms.BUSINESS.productName).toBeUndefined();
  });

  it("applyLoanProduct rejects invalid products instead of clobbering the flow", () => {
    refreshTestConfig();
    const before = { ...config.loanPrograms.PERSONAL };
    expect(applyLoanProduct({ name: "Broken", minAmountNaira: 500, maxAmountNaira: 500, interestRatePercent: 1, processingFeePercent: 0, lateFeePercent: 0 }, "PERSONAL")).toBe(false);
    expect(applyLoanProduct(null as unknown as Parameters<typeof applyLoanProduct>[0], "PERSONAL")).toBe(false);
    expect(config.loanPrograms.PERSONAL).toEqual(before);
  });

  it("ANNUALIZED products accrue interest prorated over 365 days; SIMPLE_FLAT stays monthly", () => {
    // ₦1,000,000 @ 0.9%: annualized 30 days -> round(1_000_000 × 0.009 × 30/365) = 740
    expect(calculateTermInterest(1_000_000, { type: "percentage", value: 0.9, includeUpfront: true, interestType: "ANNUALIZED" }, 30)).toBe(740);
    // Same product over 180 days -> round(1_000_000 × 0.009 × 180/365) = 4438
    expect(calculateTermInterest(1_000_000, { type: "percentage", value: 0.9, includeUpfront: true, interestType: "ANNUALIZED" }, 180)).toBe(4438);
    // SIMPLE_FLAT / REDUCING_BALANCE / legacy (no type) keep the monthly math:
    // round(1_000_000 × 0.009 × 1 month) = 9000
    expect(calculateTermInterest(1_000_000, { type: "percentage", value: 0.9, includeUpfront: true, interestType: "SIMPLE_FLAT" }, 30)).toBe(9_000);
    expect(calculateTermInterest(1_000_000, { type: "percentage", value: 0.9, includeUpfront: true }, 30)).toBe(9_000);
    // 90 days simple flat -> 3 months -> 27,000
    expect(calculateTermInterest(1_000_000, { type: "percentage", value: 0.9, includeUpfront: true, interestType: "SIMPLE_FLAT" }, 90)).toBe(27_000);
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
