import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Loan product full-configuration tests (2026-09 consolidation):
 * The catalog is the COMPLETE, single-source-of-truth loan configuration.
 *   1. POST /admin/loan-products accepts the full config — explicit
 *      programType, amount range + default amount, tenor list + default
 *      tenor, service fee, collateral flags — and echoes it back.
 *   2. Cross-field validation: default amount must fall inside the range,
 *      the default tenor must be one of the selected tenors.
 *   3. PATCH merges and re-validates (effective min/max, effective tenor
 *      list), normalizes tenure days (dedup + sort) and can clear them.
 *   4. classifyLoanProductType: EXPLICIT programType wins over name
 *      keywords (a renamed product keeps its flow); legacy keyword rows
 *      still classify; a single active product serves BOTH.
 *   5. resolveLoanProductForApplication binds by explicit programType.
 *   6. captureProductSnapshot captures the FULL terms (service fee, tenor
 *      list, collateral, default amount) so agreed loans survive edits.
 *   7. seedLoanProducts self-heals: a catalog missing a Personal or
 *      Business product gets the matching default added; a fresh catalog
 *      seeds "Personal Loan" + "Business Loan" (the easimoney-style
 *      baseline, ₦100,000–₦30,000,000 @ 5% monthly per tenor).
 *   8. Per-tenor MONTHLY interest rates (easimoney style): POST/PATCH
 *      accept a tenorInterestRates matrix (validated against the tenor
 *      list, normalized, clearable); the approval fallback prices a tenor
 *      with principal × monthlyRate% × (tenor/30) when an entry exists.
 */

const TEST_PREFIX = `test-loanprod-${Date.now()}`;

type StoreModule = typeof import("./store.js");
type RoutesModule = typeof import("./routes.js");

let storeMod: StoreModule;
let routesMod: RoutesModule;
let request: ReturnType<typeof import("supertest")>;
let loanProducts: any[];
let app: any;

const createdProductIds: string[] = [];

describe("Loan product full configuration — catalog is the single source of truth", () => {
  beforeAll(async () => {
    vi.doMock("./providers/prembly.js", () => ({
      verifyBvn: vi.fn(),
      verifyNin: vi.fn(),
      verifyIdentityWithFace: vi.fn(),
      verifyLiveness: vi.fn(),
      requestCreditReport: vi.fn(),
      requestCommercialCreditReport: vi.fn(),
      verifyPremblyWebhook: vi.fn(() => true),
      isTimeoutError: vi.fn(() => false),
    }));

    vi.doMock("./providers/flutterwave.js", () => ({
      initializeRepayment: vi.fn(),
      createLoanDisbursement: vi.fn(),
      createInvestorPayout: vi.fn(),
      initializeWalletFunding: vi.fn(),
      verifyTransaction: vi.fn(),
      verifyTransactionByReference: vi.fn(),
      verifyTransactionWithRetry: vi.fn(),
      verifyTransferWithRetry: vi.fn(),
      pollTransferUntilTerminal: vi.fn(),
      resolveBankAccount: vi.fn(),
      listBanks: vi.fn(async () => []),
      normalizeBankCodeForFlutterwave: vi.fn(async () => undefined),
      FlutterwaveError: class FlutterwaveError extends Error {
        providerResponse?: unknown;
        httpStatus?: number;
      },
    }));

    vi.doMock("./auth.js", async (importOriginal) => {
      const orig = (await importOriginal()) as any;
      return {
        ...orig,
        requireAuth: (_req: any, _res: any, next: any) => next(),
        requireRole: (..._roles: string[]) => (_req: any, _res: any, next: any) => next(),
        createOtpChallenge: vi.fn(),
      };
    });

    // Hermetic: real store module, in-memory only — DB init/persistence stubbed.
    vi.doMock("./store.js", async (importOriginal) => {
      const orig = (await importOriginal()) as StoreModule;
      return {
        ...orig,
        initializeStore: vi.fn(async () => ({})),
        persistStore: vi.fn(async () => ({})),
      };
    });

    const express = (await import("express")).default;
    const supertestPkg = await import("supertest");
    request = (supertestPkg as any).default || supertestPkg;

    storeMod = await import("./store.js");
    routesMod = await import("./routes.js");

    loanProducts = (storeMod as any).loanProducts;

    app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.user = { id: "admin-test", roles: ["ADMIN"] };
      next();
    });
    app.use("/api/v1", routesMod.default);
  }, 60_000);

  afterAll(async () => {
    for (const id of createdProductIds) {
      const index = loanProducts.findIndex((p: any) => p.id === id);
      if (index >= 0) loanProducts.splice(index, 1);
    }
  });

  it("1. POST creates a product carrying the FULL configuration", async () => {
    const response = await request(app)
      .post("/api/v1/admin/loan-products")
      .send({
        name: `${TEST_PREFIX} Salary Advance`,
        description: "Full-config smoke product",
        programType: "PERSONAL",
        minAmountNaira: 50_000,
        maxAmountNaira: 2_500_000,
        defaultAmountNaira: 250_000,
        defaultTenureDays: 60,
        tenureDays: [90, 30, 60, 30],
        interestRatePercent: 4,
        interestType: "ANNUALIZED",
        processingFeePercent: 1.5,
        serviceFeePercent: 0.5,
        lateFeePercent: 0.75,
        lateFeeType: "ONE_TIME",
        gracePeriodDays: 5,
        collateralEnabled: true,
        collateralRequired: true,
        isActive: true,
      });
    expect(response.status).toBe(201);
    const product = response.body.product;
    createdProductIds.push(product.id);
    expect(product.programType).toBe("PERSONAL");
    // Tenure days are normalized: deduped + ascending.
    expect(product.tenureDays).toEqual([30, 60, 90]);
    expect(product.defaultAmountNaira).toBe(250_000);
    expect(product.serviceFeePercent).toBe(0.5);
    expect(product.collateralEnabled).toBe(true);
    expect(product.collateralRequired).toBe(true);
  });

  it("2. POST rejects a default amount outside the min/max range", async () => {
    const response = await request(app)
      .post("/api/v1/admin/loan-products")
      .send({
        name: `${TEST_PREFIX} Broken Range`,
        programType: "BUSINESS",
        minAmountNaira: 100_000,
        maxAmountNaira: 1_000_000,
        defaultAmountNaira: 5_000_000,
        interestRatePercent: 5,
      });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body.error)).toContain("defaultAmountNaira");
  });

  it("3. POST rejects a default tenor that is not one of the allowed tenors", async () => {
    const response = await request(app)
      .post("/api/v1/admin/loan-products")
      .send({
        name: `${TEST_PREFIX} Broken Tenor`,
        minAmountNaira: 100_000,
        maxAmountNaira: 1_000_000,
        defaultTenureDays: 120,
        tenureDays: [30, 60, 90],
        interestRatePercent: 5,
      });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body.error)).toContain("defaultTenureDays");
  });

  it("4. PATCH normalizes tenor lists, re-validates the merged product and can clear optional fields", async () => {
    const created = await request(app)
      .post("/api/v1/admin/loan-products")
      .send({
        name: `${TEST_PREFIX} Patch Me`,
        programType: "BOTH",
        minAmountNaira: 100_000,
        maxAmountNaira: 1_000_000,
        defaultAmountNaira: 500_000,
        defaultTenureDays: 30,
        tenureDays: [30, 60],
        interestRatePercent: 5,
      });
    expect(created.status).toBe(201);
    const product = created.body.product;
    createdProductIds.push(product.id);

    // A patch that would leave the default amount outside the new range is rejected.
    const badRange = await request(app)
      .patch(`/api/v1/admin/loan-products/${product.id}`)
      .send({ maxAmountNaira: 200_000 });
    expect(badRange.status).toBe(400);
    expect(JSON.stringify(badRange.body.error)).toContain("defaultAmountNaira");

    // A patch that leaves the default tenor off the new tenor list is rejected
    // (the product still defaults to 30d; [60,90] would make it invalid).
    const badTenor = await request(app)
      .patch(`/api/v1/admin/loan-products/${product.id}`)
      .send({ tenureDays: [60, 90] });
    expect(badTenor.status).toBe(400);
    expect(JSON.stringify(badTenor.body.error)).toContain("defaultTenureDays");

    // A valid patch updates type + tenors (+ a coherent default tenor) and can
    // clear the default amount.
    const good = await request(app)
      .patch(`/api/v1/admin/loan-products/${product.id}`)
      .send({
        programType: "BUSINESS",
        tenureDays: [180, 60, 60, 90],
        defaultTenureDays: 60,
        defaultAmountNaira: null,
        serviceFeePercent: 1,
        collateralRequired: true,
      });
    expect(good.status).toBe(200);
    expect(good.body.product.programType).toBe("BUSINESS");
    expect(good.body.product.tenureDays).toEqual([60, 90, 180]);
    expect(good.body.product.defaultAmountNaira).toBeUndefined();
    expect(good.body.product.serviceFeePercent).toBe(1);
    expect(good.body.product.collateralRequired).toBe(true);
    expect(good.body.product.version).toBe(product.version + 1);
  });

  it("5. classification: explicit programType wins over name keywords", () => {
    const classify = routesMod.classifyLoanProductType;
    const explicit = { id: "p-explicit", name: "Velo Flex Cash", programType: "PERSONAL", isActive: true } as any;
    expect(classify(explicit)).toBe("PERSONAL");
    const explicitBusiness = { id: "b-explicit", name: "Salary Advance", programType: "BUSINESS", isActive: true } as any;
    expect(classify(explicitBusiness)).toBe("BUSINESS");
    const both = { id: "u-explicit", name: "Universal Credit", programType: "BOTH", isActive: true } as any;
    expect(classify(both)).toBe("BOTH");
    // Legacy keyword fallback still works when no explicit type is stored.
    const keyword = { id: "p-kw", name: "Business Loan", isActive: true } as any;
    expect(classify(keyword)).toBe("BUSINESS");
  });

  it("6. resolveLoanProductForApplication binds by explicit programType, not just the name", () => {
    const before = loanProducts.slice();
    try {
      loanProducts.splice(0, loanProducts.length);
      loanProducts.push({ id: "flex", name: "Velo Flex", programType: "PERSONAL", minAmountNaira: 10_000, maxAmountNaira: 500_000, isActive: true } as any);
      loanProducts.push({ id: "growth", name: "Velo Growth", programType: "BUSINESS", minAmountNaira: 500_000, maxAmountNaira: 5_000_000, isActive: true } as any);
      const resolvedPersonal = routesMod.resolveLoanProductForApplication({ applicantType: "PERSONAL", amountNaira: 50_000 });
      expect(resolvedPersonal?.id).toBe("flex");
      const resolvedBusiness = routesMod.resolveLoanProductForApplication({ applicantType: "BUSINESS", amountNaira: 1_000_000 });
      expect(resolvedBusiness?.id).toBe("growth");
    } finally {
      loanProducts.splice(0, loanProducts.length, ...before);
    }
  });

  it("7. captureProductSnapshot captures the FULL terms", () => {
    const snapshot = routesMod.captureProductSnapshot({
      id: "prod-full",
      name: "Personal Loan",
      programType: "PERSONAL",
      minAmountNaira: 100_000,
      maxAmountNaira: 30_000_000,
      defaultAmountNaira: 150_000,
      defaultTenureDays: 30,
      tenureDays: [30, 60, 90, 180],
      interestRatePercent: 5,
      interestType: "ANNUALIZED",
      processingFeePercent: 2,
      serviceFeePercent: 0.5,
      lateFeePercent: 1,
      lateFeeType: "COMPOUNDING_DAILY",
      gracePeriodDays: 3,
      collateralEnabled: true,
      collateralRequired: false,
      isActive: true,
    } as any);
    expect(snapshot).toBeTruthy();
    expect(snapshot?.programType).toBe("PERSONAL");
    expect(snapshot?.serviceFeePercent).toBe(0.5);
    expect(snapshot?.tenureDays).toEqual([30, 60, 90, 180]);
    expect(snapshot?.defaultAmountNaira).toBe(150_000);
    expect(snapshot?.collateralRequired).toBe(false);
    expect(snapshot?.gracePeriodDays).toBe(3);
  });

  it("8. seedLoanProducts self-heals a catalog missing a Personal or Business product", () => {
    const before = loanProducts.slice();
    try {
      loanProducts.splice(0, loanProducts.length);
      // A single keyword-less product — neither flow is covered.
      loanProducts.push({ id: "orphan", name: "Velo Widget Credit", minAmountNaira: 1_000, maxAmountNaira: 2_000_000, interestRatePercent: 5, interestType: "ANNUALIZED", processingFeePercent: 0, serviceFeePercent: 0, lateFeePercent: 0, lateFeeType: "ONE_TIME", gracePeriodDays: 0, collateralEnabled: true, collateralRequired: false, isActive: true, version: 1, createdAt: new Date().toISOString() } as any);
      storeMod.seedLoanProducts();
      const names = loanProducts.map((p: any) => p.name);
      expect(names).toContain("Personal Loan");
      expect(names).toContain("Business Loan");
      const personal = loanProducts.find((p: any) => p.name === "Personal Loan");
      const business = loanProducts.find((p: any) => p.name === "Business Loan");
      expect(personal.programType).toBe("PERSONAL");
      expect(business.programType).toBe("BUSINESS");
      // Moniepoint-style baseline terms (easimoney defaults, 2026-09).
      expect(personal.minAmountNaira).toBe(100_000);
      expect(personal.maxAmountNaira).toBe(30_000_000);
      expect(personal.interestRatePercent).toBe(18.9);
      expect(personal.interestType).toBe("SIMPLE_FLAT");
      expect(personal.tenureDays).toEqual([30, 60, 91, 180, 360]);
      expect(personal.tenorInterestRates).toEqual(storeMod.DEFAULT_TENOR_INTEREST_RATES);
      // Existing admin products are never renamed or removed.
      expect(loanProducts.find((p: any) => p.id === "orphan")).toBeTruthy();
    } finally {
      loanProducts.splice(0, loanProducts.length, ...before);
    }
  });

  it("9. fresh catalog seeds exactly Personal Loan + Business Loan", () => {
    const before = loanProducts.slice();
    try {
      loanProducts.splice(0, loanProducts.length);
      storeMod.seedLoanProducts();
      expect(loanProducts.length).toBe(2);
      expect(loanProducts.map((p: any) => p.name).sort()).toEqual(["Business Loan", "Personal Loan"]);
      // Both defaults are active and fully configured.
      for (const product of loanProducts) {
        expect(product.isActive).toBe(true);
        expect(product.programType).toBeDefined();
        expect(product.tenureDays.length).toBeGreaterThan(0);
        expect(product.tenureDays).toContain(product.defaultTenureDays);
      }
    } finally {
      loanProducts.splice(0, loanProducts.length, ...before);
    }
  });

  it("10. POST accepts per-tenor monthly interest rates and echoes them normalized", async () => {
    const response = await request(app)
      .post("/api/v1/admin/loan-products")
      .send({
        name: `${TEST_PREFIX} Tenor Rates`,
        programType: "PERSONAL",
        minAmountNaira: 100_000,
        maxAmountNaira: 30_000_000,
        defaultTenureDays: 30,
        tenureDays: [30, 60, 90, 180],
        tenorInterestRates: [
          { tenorDays: 90, monthlyRatePercent: 6 },
          { tenorDays: 30, monthlyRatePercent: 5 },
          { tenorDays: 60, monthlyRatePercent: 5 },
          { tenorDays: 90, monthlyRatePercent: 5.5 }, // duplicate tenor: last wins
          { tenorDays: 180, monthlyRatePercent: 0 },  // interest-free tenor is legitimate
        ],
        interestRatePercent: 5,
        interestType: "SIMPLE_FLAT",
      });
    expect(response.status).toBe(201);
    const product = response.body.product;
    createdProductIds.push(product.id);
    expect(product.tenorInterestRates).toEqual([
      { tenorDays: 30, monthlyRatePercent: 5 },
      { tenorDays: 60, monthlyRatePercent: 5 },
      { tenorDays: 90, monthlyRatePercent: 5.5 },
      { tenorDays: 180, monthlyRatePercent: 0 },
    ]);
    // The effective monthly rate for a tenor resolves from the matrix.
    expect(storeMod.resolveTenorMonthlyRate(product, null, 90)).toBe(5.5);
    expect(storeMod.resolveTenorMonthlyRate(product, null, 60)).toBe(5);
    expect(storeMod.resolveTenorMonthlyRate(product, null, 365)).toBeUndefined();
  });

  it("11. POST rejects a per-tenor rate referencing a tenor outside the tenureDays list", async () => {
    const response = await request(app)
      .post("/api/v1/admin/loan-products")
      .send({
        name: `${TEST_PREFIX} Orphan Tenor Rate`,
        minAmountNaira: 100_000,
        maxAmountNaira: 1_000_000,
        tenureDays: [30, 60],
        tenorInterestRates: [{ tenorDays: 120, monthlyRatePercent: 4 }],
        interestRatePercent: 5,
      });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body.error)).toContain("tenorInterestRates");
  });

  it("12. PATCH sets, prunes and clears per-tenor rates; the approval fallback uses the tenor math", async () => {
    const created = await request(app)
      .post("/api/v1/admin/loan-products")
      .send({
        name: `${TEST_PREFIX} Tenor Patch`,
        programType: "BUSINESS",
        minAmountNaira: 100_000,
        maxAmountNaira: 5_000_000,
        defaultTenureDays: 30,
        tenureDays: [30, 60, 90],
        tenorInterestRates: [{ tenorDays: 30, monthlyRatePercent: 4 }, { tenorDays: 60, monthlyRatePercent: 4.5 }, { tenorDays: 90, monthlyRatePercent: 5 }],
        interestRatePercent: 4,
        interestType: "SIMPLE_FLAT",
      });
    expect(created.status).toBe(201);
    const product = created.body.product;
    createdProductIds.push(product.id);

    // Shrinking the tenor list prunes the orphaned 90d rate entry.
    const shrunk = await request(app)
      .patch(`/api/v1/admin/loan-products/${product.id}`)
      .send({ tenureDays: [30, 60] });
    expect(shrunk.status).toBe(200);
    expect(shrunk.body.product.tenorInterestRates).toEqual([
      { tenorDays: 30, monthlyRatePercent: 4 },
      { tenorDays: 60, monthlyRatePercent: 4.5 },
    ]);

    // Explicitly patching the matrix replaces it wholesale.
    const repatched = await request(app)
      .patch(`/api/v1/admin/loan-products/${product.id}`)
      .send({ tenorInterestRates: [{ tenorDays: 60, monthlyRatePercent: 6 }] });
    expect(repatched.status).toBe(200);
    expect(repatched.body.product.tenorInterestRates).toEqual([{ tenorDays: 60, monthlyRatePercent: 6 }]);

    // An empty array clears the map — the base-rate math applies again.
    const cleared = await request(app)
      .patch(`/api/v1/admin/loan-products/${product.id}`)
      .send({ tenorInterestRates: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.product.tenorInterestRates).toBeUndefined();
    expect(storeMod.resolveTenorMonthlyRate(cleared.body.product, null, 60)).toBeUndefined();
  });

  it("13. seeded defaults carry the easimoney per-tenor matrix (18.9/17.1/locked 91d/10.5/hot 8.7% monthly)", () => {
    const before = loanProducts.slice();
    try {
      loanProducts.splice(0, loanProducts.length);
      storeMod.seedLoanProducts();
      for (const product of loanProducts) {
        expect(product.interestType).toBe("SIMPLE_FLAT");
        expect(product.interestRatePercent).toBe(18.9);
        expect(product.tenureDays).toEqual([30, 60, 91, 180, 360]);
        expect(product.tenorInterestRates).toEqual([
          { tenorDays: 30, monthlyRatePercent: 18.9, status: "AVAILABLE" },
          { tenorDays: 60, monthlyRatePercent: 17.1, status: "AVAILABLE" },
          { tenorDays: 91, monthlyRatePercent: 15.9, status: "LOCKED" },
          { tenorDays: 180, monthlyRatePercent: 10.5, status: "AVAILABLE" },
          { tenorDays: 360, monthlyRatePercent: 8.7, status: "HOT" },
        ]);
        // The locked tenor resolves as LOCKED; the hot tenor as HOT.
        expect(storeMod.resolveTenorStatus(product, null, 91)).toBe("LOCKED");
        expect(storeMod.resolveTenorStatus(product, null, 360)).toBe("HOT");
        expect(storeMod.resolveTenorStatus(product, null, 30)).toBe("AVAILABLE");
        // The default tenure is always a SELECTABLE tenor (never the locked 91d).
        expect(storeMod.resolveTenorStatus(product, null, product.defaultTenureDays)).not.toBe("LOCKED");
      }
      // Business defaults to 60d (working capital); personal to 30d.
      expect(loanProducts.find((p: any) => p.name === "Business Loan").defaultTenureDays).toBe(60);
      expect(loanProducts.find((p: any) => p.name === "Personal Loan").defaultTenureDays).toBe(30);
    } finally {
      loanProducts.splice(0, loanProducts.length, ...before);
    }
  });

  it("14. POST/PATCH carry the per-tenor status (AVAILABLE/LOCKED/HOT) and drop invalid statuses", async () => {
    const created = await request(app)
      .post("/api/v1/admin/loan-products")
      .send({
        name: `${TEST_PREFIX} Tenor Statuses`,
        programType: "PERSONAL",
        minAmountNaira: 100_000,
        maxAmountNaira: 30_000_000,
        defaultTenureDays: 30,
        tenureDays: [30, 60, 91, 360],
        tenorInterestRates: [
          { tenorDays: 30, monthlyRatePercent: 18.9, status: "AVAILABLE" },
          { tenorDays: 60, monthlyRatePercent: 17.1 }, // no status = AVAILABLE downstream
          { tenorDays: 91, monthlyRatePercent: 15.9, status: "LOCKED" },
          { tenorDays: 360, monthlyRatePercent: 8.7, status: "HOT" },
        ],
        interestRatePercent: 18.9,
        interestType: "SIMPLE_FLAT",
      });
    expect(created.status).toBe(201);
    const product = created.body.product;
    createdProductIds.push(product.id);
    expect(product.tenorInterestRates).toEqual([
      { tenorDays: 30, monthlyRatePercent: 18.9, status: "AVAILABLE" },
      { tenorDays: 60, monthlyRatePercent: 17.1 },
      { tenorDays: 91, monthlyRatePercent: 15.9, status: "LOCKED" },
      { tenorDays: 360, monthlyRatePercent: 8.7, status: "HOT" },
    ]);
    expect(storeMod.resolveTenorStatus(product, null, 91)).toBe("LOCKED");
    expect(storeMod.resolveTenorStatus(product, null, 360)).toBe("HOT");
    expect(storeMod.resolveTenorStatus(product, null, 30)).toBe("AVAILABLE");
    expect(storeMod.resolveTenorStatus(product, null, 60)).toBe("AVAILABLE");

    // PATCH: an invalid status is rejected at the API boundary (the JSONB
    // rebuild path still tolerates legacy garbage); a valid HOT survives and
    // the rate itself is editable in the same call.
    const invalid = await request(app)
      .patch(`/api/v1/admin/loan-products/${product.id}`)
      .send({
        tenorInterestRates: [
          { tenorDays: 91, monthlyRatePercent: 14.9, status: "SOMETIMES" },
        ],
      });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body.error)).toContain("Invalid enum value");

    const patched = await request(app)
      .patch(`/api/v1/admin/loan-products/${product.id}`)
      .send({
        tenorInterestRates: [
          { tenorDays: 91, monthlyRatePercent: 14.9 }, // unlocked: back to AVAILABLE
          { tenorDays: 360, monthlyRatePercent: 9.5, status: "HOT" },
        ],
      });
    expect(patched.status).toBe(200);
    expect(patched.body.product.tenorInterestRates).toEqual([
      { tenorDays: 91, monthlyRatePercent: 14.9 },
      { tenorDays: 360, monthlyRatePercent: 9.5, status: "HOT" },
    ]);
    expect(storeMod.resolveTenorStatus(patched.body.product, null, 91)).toBe("AVAILABLE");
    expect(storeMod.resolveTenorStatus(patched.body.product, null, 360)).toBe("HOT");
  });

  it("15. legacy default products (never per-tenor configured) upgrade to the easimoney defaults; customized or renamed products are untouched", () => {
    const before = loanProducts.slice();
    try {
      loanProducts.splice(0, loanProducts.length);
      const now = new Date().toISOString();
      // Task-11-era seed: default names, NO matrix, 5% annualized, old tenor list.
      loanProducts.push({ id: "legacy-personal", name: "Personal Loan", programType: "PERSONAL", minAmountNaira: 100_000, maxAmountNaira: 30_000_000, defaultTenureDays: 30, tenureDays: [30, 60, 90, 180], interestRatePercent: 5, interestType: "ANNUALIZED", processingFeePercent: 2, serviceFeePercent: 0, lateFeePercent: 1, lateFeeType: "COMPOUNDING_DAILY", gracePeriodDays: 3, collateralEnabled: true, collateralRequired: false, isActive: true, version: 2, createdAt: now } as any);
      // Admin-configured row: has a matrix entry → NEVER re-priced.
      loanProducts.push({ id: "custom-business", name: "Business Loan", programType: "BUSINESS", minAmountNaira: 100_000, maxAmountNaira: 5_000_000, defaultTenureDays: 30, tenureDays: [30, 60], tenorInterestRates: [{ tenorDays: 30, monthlyRatePercent: 4 }], interestRatePercent: 4, interestType: "SIMPLE_FLAT", processingFeePercent: 2, serviceFeePercent: 0, lateFeePercent: 1, lateFeeType: "COMPOUNDING_DAILY", gracePeriodDays: 3, collateralEnabled: true, collateralRequired: false, isActive: true, version: 7, createdAt: now } as any);
      // Renamed default: no longer matches the default name → untouched.
      loanProducts.push({ id: "renamed-personal", name: "Velo Personal Plus", programType: "PERSONAL", minAmountNaira: 50_000, maxAmountNaira: 4_000_000, defaultTenureDays: 30, tenureDays: [30, 60], interestRatePercent: 3, interestType: "ANNUALIZED", processingFeePercent: 1, serviceFeePercent: 0, lateFeePercent: 1, lateFeeType: "ONE_TIME", gracePeriodDays: 5, collateralEnabled: false, collateralRequired: false, isActive: true, version: 3, createdAt: now } as any);

      storeMod.seedLoanProducts();

      const personal = loanProducts.find((p: any) => p.id === "legacy-personal");
      expect(personal.tenureDays).toEqual([30, 60, 91, 180, 360]);
      expect(personal.interestRatePercent).toBe(18.9);
      expect(personal.interestType).toBe("SIMPLE_FLAT");
      expect(personal.tenorInterestRates).toEqual(storeMod.DEFAULT_TENOR_INTEREST_RATES);
      // Non-pricing fields stay exactly as the admin had them.
      expect(personal.minAmountNaira).toBe(100_000);
      expect(personal.maxAmountNaira).toBe(30_000_000);
      expect(personal.processingFeePercent).toBe(2);

      const business = loanProducts.find((p: any) => p.id === "custom-business");
      expect(business.tenorInterestRates).toEqual([{ tenorDays: 30, monthlyRatePercent: 4 }]);
      expect(business.tenureDays).toEqual([30, 60]);
      expect(business.interestRatePercent).toBe(4);

      const renamed = loanProducts.find((p: any) => p.id === "renamed-personal");
      expect(renamed.interestRatePercent).toBe(3);
      expect(renamed.tenorInterestRates).toBeUndefined();
    } finally {
      loanProducts.splice(0, loanProducts.length, ...before);
    }
  });
});
