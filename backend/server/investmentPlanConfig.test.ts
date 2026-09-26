import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Investment plan catalog tests (2026-09):
 * The plan catalog is the COMPLETE, admin-owned configuration that decides
 * what investors can invest in — nothing is hardcoded client-side.
 *   1. POST /admin/investment-plans accepts the FULL configuration — flat
 *      earnings, flat gateway fee, capacity cap, availability window,
 *      allow-investments-after-close — and echoes it back.
 *   2. Cross-field validation: inverted min/max rejected; FLAT earnings
 *      without a positive fixed naira amount rejected; duplicate names 409.
 *   3. PATCH updates EVERY parameter (tenure, rateType, capacity, window,
 *      allowNewInvestmentsAfterClose), re-validates the merged plan and can
 *      clear capacity/effectiveTo with null.
 *   4. DELETE refuses (409) while capital-holding investments reference the
 *      plan, and succeeds once they are released.
 *   5. POST /admin/investment-plans/seed fills gaps (missing default names)
 *      and never overwrites existing plans — a second call is a no-op.
 *   6. GET /admin|/investor investment-plans enriches rows with
 *      committedNaira, remainingCapacityNaira and acceptingInvestments;
 *      a past effectiveTo (without allow-after-close) flips accepting to false.
 *   7. POST /investor/investments ENFORCES the admin configuration: rejects
 *      amounts over the remaining capacity and rejects closed plans.
 */

const TEST_PREFIX = `test-planconfig-${Date.now()}`;

type StoreModule = typeof import("./store.js");
type RoutesModule = typeof import("./routes.js");

let storeMod: StoreModule;
let routesMod: RoutesModule;
let request: ReturnType<typeof import("supertest")>;
let express: any;
let investmentPlans: any[];
let investments: any[];
let users: any[];
let kycCases: any[];
let appAdmin: any;
let appInvestor: any;

const createdPlanIds: string[] = [];
const createdInvestmentIds: string[] = [];
const createdUserIds: string[] = [];
const createdKycIds: string[] = [];

const FUTURE_ISO = new Date(Date.now() + 365 * 86400000).toISOString();
const PAST_ISO = new Date(Date.now() - 86400000).toISOString();

describe("Investment plan catalog — admin-owned, nothing hardcoded", () => {
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

    const expressMod = await import("express");
    express = expressMod.default ?? expressMod;
    const supertestPkg = await import("supertest");
    request = (supertestPkg as any).default || supertestPkg;

    storeMod = await import("./store.js");
    routesMod = await import("./routes.js");

    investmentPlans = (storeMod as any).investmentPlans;
    investments = (storeMod as any).investments;
    users = (storeMod as any).users;
    kycCases = (storeMod as any).kycCases;

    // Populate the classic defaults (normally done by initializeStore).
    storeMod.seedInvestmentPlans();

    appAdmin = express();
    appAdmin.use(express.json());
    appAdmin.use((req: any, _res: any, next: any) => {
      req.user = { id: "admin-test", roles: ["ADMIN"] };
      next();
    });
    appAdmin.use("/api/v1", routesMod.default);
  }, 60_000);

  afterAll(() => {
    for (const id of createdInvestmentIds) {
      const index = investments.findIndex((i: any) => i.id === id);
      if (index >= 0) investments.splice(index, 1);
    }
    for (const id of createdPlanIds) {
      const index = investmentPlans.findIndex((p: any) => p.id === id);
      if (index >= 0) investmentPlans.splice(index, 1);
    }
    for (const id of createdUserIds) {
      const index = users.findIndex((u: any) => u.id === id);
      if (index >= 0) users.splice(index, 1);
    }
    for (const id of createdKycIds) {
      const index = kycCases.findIndex((k: any) => k.id === id);
      if (index >= 0) kycCases.splice(index, 1);
    }
  });

  function trackPlan(plan: any): string {
    createdPlanIds.push(plan.id);
    return plan.id;
  }

  function seedInvestment(planId: string, amountNaira: number, status = "ACTIVE"): any {
    const now = new Date().toISOString();
    const row = {
      id: `inv-${Math.random().toString(36).slice(2, 12)}`,
      investorId: "investor-test",
      planId,
      amountNaira,
      expectedEarningsNaira: 0,
      tenureDays: 90,
      annualRatePercent: 12.5,
      startsAt: now,
      maturesAt: new Date(Date.now() + 90 * 86400000).toISOString(),
      status,
      createdAt: now,
    };
    investments.push(row);
    createdInvestmentIds.push(row.id);
    return row;
  }

  function seedInvestor(): string {
    const id = `user-${TEST_PREFIX}-investor`;
    users.push({
      id,
      email: `${TEST_PREFIX}-investor@example.com`,
      fullName: "Plan Tester",
      passwordHash: "$2a$10$placeholder",
      roles: ["INVESTOR"],
      isActive: true,
      createdAt: new Date().toISOString(),
    });
    createdUserIds.push(id);
    const kyc = storeMod.findOrCreateKycCase(id);
    kyc.status = "VERIFIED";
    createdKycIds.push(kyc.id);
    // Fund the wallet so only plan rules can block the investment.
    const wallet = storeMod.findWallet(id);
    wallet.availableMinor = 100_000_000; // ₦1,000,000
    return id;
  }

  function investorApp(userId: string) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.user = { id: userId, roles: ["INVESTOR"] };
      next();
    });
    app.use("/api/v1", routesMod.default);
    return app;
  }

  it("1. POST creates a plan carrying the FULL configuration (flat earnings, flat gateway fee, capacity, window)", async () => {
    const response = await request(appAdmin)
      .post("/api/v1/admin/investment-plans")
      .send({
        name: `${TEST_PREFIX} Flat Yield 90`,
        description: "Fixed-earnings quarterly plan",
        minAmountNaira: 50_000,
        maxAmountNaira: 10_000_000,
        tenureDays: 90,
        annualRatePercent: 0,
        rateType: "FLAT",
        earningsBasis: "FLAT",
        earningsFlatNaira: 25_000,
        earlyLiquidityAllowed: true,
        earlyLiquidityFeeBasis: "FLAT",
        earlyLiquidityFeeFlatNaira: 5_000,
        forfeitInterestOnEarlyExit: true,
        gatewayFeeBasis: "FLAT",
        gatewayFeeFlatNaira: 1_000,
        capacityNaira: 1_000_000,
        allowNewInvestmentsAfterClose: true,
        effectiveTo: FUTURE_ISO,
        isActive: true,
      });
    expect(response.status).toBe(201);
    const plan = response.body.plan;
    trackPlan(plan);
    expect(plan.earningsBasis).toBe("FLAT");
    expect(plan.earningsFlatNaira).toBe(25_000);
    expect(plan.gatewayFeeBasis).toBe("FLAT");
    expect(plan.gatewayFeeFlatNaira).toBe(1_000);
    expect(plan.earlyLiquidityFeeBasis).toBe("FLAT");
    expect(plan.earlyLiquidityFeeFlatNaira).toBe(5_000);
    expect(plan.forfeitInterestOnEarlyExit).toBe(true);
    expect(plan.capacityNaira).toBe(1_000_000);
    expect(plan.allowNewInvestmentsAfterClose).toBe(true);
    expect(plan.effectiveTo).toBe(FUTURE_ISO);
    expect(plan.currency).toBe("NGN");
    expect(plan.version).toBe(1);
  });

  it("2. POST rejects inverted ranges, zero flat earnings and duplicate names", async () => {
    const inverted = await request(appAdmin)
      .post("/api/v1/admin/investment-plans")
      .send({ name: `${TEST_PREFIX} Broken Range`, minAmountNaira: 500_000, maxAmountNaira: 100_000, tenureDays: 30, annualRatePercent: 10, earlyLiquidityAllowed: false, earlyLiquidityFeePercent: 0, gatewayFeePercent: 0, forfeitInterestOnEarlyExit: false, isActive: true });
    expect(inverted.status).toBe(400);
    expect(JSON.stringify(inverted.body.error)).toContain("maxAmountNaira");

    const zeroFlat = await request(appAdmin)
      .post("/api/v1/admin/investment-plans")
      .send({ name: `${TEST_PREFIX} Zero Flat`, minAmountNaira: 50_000, maxAmountNaira: 100_000, tenureDays: 30, annualRatePercent: 0, earningsBasis: "FLAT", earningsFlatNaira: 0, earlyLiquidityAllowed: false, earlyLiquidityFeePercent: 0, gatewayFeePercent: 0, forfeitInterestOnEarlyExit: false, isActive: true });
    expect(zeroFlat.status).toBe(400);
    expect(JSON.stringify(zeroFlat.body.error)).toContain("earningsFlatNaira");

    const dupe = await request(appAdmin)
      .post("/api/v1/admin/investment-plans")
      .send({ name: "Velo Flex 30", minAmountNaira: 50_000, maxAmountNaira: 100_000, tenureDays: 30, annualRatePercent: 10, earlyLiquidityAllowed: false, earlyLiquidityFeePercent: 0, gatewayFeePercent: 0, forfeitInterestOnEarlyExit: false, isActive: true });
    expect(dupe.status).toBe(409);
  });

  it("3. PATCH updates every parameter, re-validates merged fields, and null clears capacity/window", async () => {
    const created = await request(appAdmin)
      .post("/api/v1/admin/investment-plans")
      .send({ name: `${TEST_PREFIX} Patch Me`, minAmountNaira: 10_000, maxAmountNaira: 1_000_000, tenureDays: 30, annualRatePercent: 8, earlyLiquidityAllowed: false, earlyLiquidityFeePercent: 0, gatewayFeePercent: 0, forfeitInterestOnEarlyExit: false, isActive: true });
    expect(created.status).toBe(201);
    const planId = trackPlan(created.body.plan);

    const patched = await request(appAdmin)
      .patch(`/api/v1/admin/investment-plans/${planId}`)
      .send({
        tenureDays: 180,
        rateType: "TENURE_SPECIFIC",
        annualRatePercent: 11,
        capacityNaira: 2_000_000,
        allowNewInvestmentsAfterClose: true,
        effectiveTo: FUTURE_ISO,
        description: "Updated description",
      });
    expect(patched.status).toBe(200);
    const plan = patched.body.plan;
    expect(plan.tenureDays).toBe(180);
    expect(plan.rateType).toBe("TENURE_SPECIFIC");
    expect(plan.annualRatePercent).toBe(11);
    expect(plan.capacityNaira).toBe(2_000_000);
    expect(plan.allowNewInvestmentsAfterClose).toBe(true);
    expect(plan.effectiveTo).toBe(FUTURE_ISO);
    expect(plan.version).toBe(2);

    // Merged re-validation: max below the EXISTING min is rejected.
    const invalid = await request(appAdmin)
      .patch(`/api/v1/admin/investment-plans/${planId}`)
      .send({ maxAmountNaira: 5_000 });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body.error)).toContain("maxAmountNaira");

    // null clears the optional fields.
    const cleared = await request(appAdmin)
      .patch(`/api/v1/admin/investment-plans/${planId}`)
      .send({ capacityNaira: null, effectiveTo: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.plan.capacityNaira).toBeUndefined();
    expect(cleared.body.plan.effectiveTo).toBeUndefined();
  });

  it("4. DELETE refuses while investments hold capital, succeeds once released", async () => {
    const created = await request(appAdmin)
      .post("/api/v1/admin/investment-plans")
      .send({ name: `${TEST_PREFIX} Delete Me`, minAmountNaira: 10_000, maxAmountNaira: 1_000_000, tenureDays: 60, annualRatePercent: 9, earlyLiquidityAllowed: false, earlyLiquidityFeePercent: 0, gatewayFeePercent: 0, forfeitInterestOnEarlyExit: false, isActive: true });
    const planId = trackPlan(created.body.plan);

    seedInvestment(planId, 400_000, "ACTIVE");

    const blocked = await request(appAdmin).delete(`/api/v1/admin/investment-plans/${planId}`);
    expect(blocked.status).toBe(409);
    expect(String(blocked.body.error)).toContain("investment");
    expect(String(blocked.body.error)).toContain("Deactivate");

    // Release the capital (paid out) — now deletion succeeds.
    const inv = investments.find((i: any) => i.planId === planId);
    inv.status = "PAID_OUT";
    const ok = await request(appAdmin).delete(`/api/v1/admin/investment-plans/${planId}`);
    expect(ok.status).toBe(200);
    expect(investmentPlans.some((p: any) => p.id === planId)).toBe(false);
  });

  it("5. Seed fills gaps and never overwrites existing plans", async () => {
    // Remove one default plan so the seed has a gap to fill.
    const missing = investmentPlans.find((p: any) => p.name === "Velo Flex 30")!;
    investmentPlans.splice(investmentPlans.indexOf(missing), 1);

    const first = await request(appAdmin).post("/api/v1/admin/investment-plans/seed").send({});
    expect(first.status).toBe(200);
    expect(first.body.created.map((p: any) => p.name)).toContain("Velo Flex 30");
    expect(first.body.skipped.sort()).toEqual(["Velo Growth 90", "Velo Max 180", "Velo Prime 365"].sort());
    for (const p of first.body.created) trackPlan(p);

    const again = await request(appAdmin).post("/api/v1/admin/investment-plans/seed").send({});
    expect(again.status).toBe(200);
    expect(again.body.created).toHaveLength(0);
    expect(again.body.skipped).toHaveLength(4);
  });

  it("6. Plan listings enrich rows with committed/remaining/accepting — closed plans flip acceptingInvestments", async () => {
    const created = await request(appAdmin)
      .post("/api/v1/admin/investment-plans")
      .send({ name: `${TEST_PREFIX} Capacity 100k`, minAmountNaira: 10_000, maxAmountNaira: 1_000_000, tenureDays: 90, annualRatePercent: 10, earlyLiquidityAllowed: false, earlyLiquidityFeePercent: 0, gatewayFeePercent: 0, forfeitInterestOnEarlyExit: false, capacityNaira: 100_000, isActive: true });
    const planId = trackPlan(created.body.plan);

    seedInvestment(planId, 60_000, "ACTIVE");

    const adminList = await request(appAdmin).get("/api/v1/admin/investment-plans");
    expect(adminList.status).toBe(200);
    const adminRow = adminList.body.plans.find((p: any) => p.id === planId);
    expect(adminRow.committedNaira).toBe(60_000);
    expect(adminRow.remainingCapacityNaira).toBe(40_000);
    expect(adminRow.acceptingInvestments).toBe(true);

    // A released (PAID_OUT) investment must NOT count towards capacity.
    seedInvestment(planId, 100_000, "PAID_OUT");
    const afterRelease = await request(appAdmin).get("/api/v1/admin/investment-plans");
    const rowAfterRelease = afterRelease.body.plans.find((p: any) => p.id === planId);
    expect(rowAfterRelease.committedNaira).toBe(60_000);

    const investorList = await request(investorApp("investor-test")).get("/api/v1/investor/investment-plans");
    expect(investorList.status).toBe(200);
    const investorRow = investorList.body.plans.find((p: any) => p.id === planId);
    expect(investorRow.acceptingInvestments).toBe(true);
    expect(investorRow.remainingCapacityNaira).toBe(40_000);

    // Close the window (no allow-after-close) — accepting flips to false.
    await request(appAdmin).patch(`/api/v1/admin/investment-plans/${planId}`).send({ effectiveTo: PAST_ISO, allowNewInvestmentsAfterClose: false });
    const closedList = await request(investorApp("investor-test")).get("/api/v1/investor/investment-plans");
    const closedRow = closedList.body.plans.find((p: any) => p.id === planId);
    expect(closedRow.acceptingInvestments).toBe(false);
  });

  it("7. POST /investor/investments enforces capacity and closed windows", async () => {
    const investorId = seedInvestor();
    appInvestor = investorApp(investorId);

    const created = await request(appAdmin)
      .post("/api/v1/admin/investment-plans")
      .send({ name: `${TEST_PREFIX} Enforce 100k`, minAmountNaira: 10_000, maxAmountNaira: 1_000_000, tenureDays: 90, annualRatePercent: 12.5, earlyLiquidityAllowed: false, earlyLiquidityFeePercent: 0, gatewayFeePercent: 0, forfeitInterestOnEarlyExit: false, capacityNaira: 100_000, isActive: true });
    const planId = trackPlan(created.body.plan);

    seedInvestment(planId, 60_000, "ACTIVE");

    // Over the remaining capacity (40k left, asking 50k).
    const over = await request(appInvestor)
      .post("/api/v1/investor/investments")
      .send({ planId, amountNaira: 50_000 });
    expect(over.status).toBe(409);
    expect(String(over.body.error)).toContain("remains on this plan");

    // Within the remaining capacity succeeds…
    const fits = await request(appInvestor)
      .post("/api/v1/investor/investments")
      .send({ planId, amountNaira: 40_000 });
    expect(fits.status).toBe(201);
    expect(fits.body.investment.planId).toBe(planId);

    // …and now the plan is fully subscribed.
    const full = await request(appInvestor)
      .post("/api/v1/investor/investments")
      .send({ planId, amountNaira: 10_000 });
    expect(full.status).toBe(409);
    expect(String(full.body.error)).toContain("fully subscribed");

    // Closed plan (past effectiveTo, no allow-after-close) is rejected.
    const closedPlan = await request(appAdmin)
      .post("/api/v1/admin/investment-plans")
      .send({ name: `${TEST_PREFIX} Closed Plan`, minAmountNaira: 10_000, maxAmountNaira: 1_000_000, tenureDays: 90, annualRatePercent: 10, earlyLiquidityAllowed: false, earlyLiquidityFeePercent: 0, gatewayFeePercent: 0, forfeitInterestOnEarlyExit: false, effectiveTo: PAST_ISO, allowNewInvestmentsAfterClose: false, isActive: true });
    const closedId = trackPlan(closedPlan.body.plan);

    const rejected = await request(appInvestor)
      .post("/api/v1/investor/investments")
      .send({ planId: closedId, amountNaira: 20_000 });
    expect(rejected.status).toBe(409);
    expect(String(rejected.body.error)).toContain("closed to new investments");

    // allowNewInvestmentsAfterClose: true keeps it investable past the window.
    await request(appAdmin).patch(`/api/v1/admin/investment-plans/${closedId}`).send({ allowNewInvestmentsAfterClose: true });
    const afterClose = await request(appInvestor)
      .post("/api/v1/investor/investments")
      .send({ planId: closedId, amountNaira: 20_000 });
    expect(afterClose.status).toBe(201);
  });
});
