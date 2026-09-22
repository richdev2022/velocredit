// ============================================================================
// scripts/smokeLoanProductByType.ts
// Proves the type-scoped borrower catalog contract:
//
//   GET /api/v1/borrower/loan-products?type=PERSONAL|BUSINESS
//     -> returns the SINGLE authoritative product for that borrower flow,
//        stamped with programType, so the loan request screen renders loan
//        information (limits, rate, fees, grace period) for EXACTLY the
//        product the admin configured — never a mix, never env defaults.
//
//   Also covered:
//     - all-inactive catalog: ?type= still returns the best-match product
//       flagged with ALL_PRODUCTS_INACTIVE_FALLBACK (funnel never bricked).
//     - ?productId=<id> returns exactly that product; unknown id -> 404.
//     - explicit programType beats keyword-less names.
//
// Run: env -u DATABASE_URL npx tsx scripts/smokeLoanProductByType.ts
// ============================================================================

import express from "express";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "smoke-test-secret-0123456789abcdef0123456789";

type StoreModule = typeof import("../backend/server/store.js");
type RoutesModule = typeof import("../backend/server/routes.js");

async function main(): Promise<void> {
  const auth = await import("../backend/server/auth.js");
  const issueTokenFn = (user: any) => (auth as any).issueToken(user);
  const storeMod: StoreModule = await import("../backend/server/store.js");
  const routesMod: RoutesModule = await import("../backend/server/routes.js");

  try {
    await storeMod.initializeStore();
  } catch (err) {
    console.warn("[smoke] initializeStore warning:", err instanceof Error ? err.message : err);
  }
  storeMod.seedLoanProducts();
  storeMod.normalizeLoanProducts();

  const supertestPkg = await import("supertest");
  const request = (supertestPkg as any).default || supertestPkg;

  const app = express();
  app.use(express.json());
  app.use("/api/v1", routesMod.default);

  const loanProducts = storeMod.loanProducts as unknown as any[];

  const borrowerId = `smoke-borrower-${Date.now()}`;
  const borrowerUser = { id: borrowerId, email: `${borrowerId}@example.com`, fullName: "Smoke Borrower", roles: ["BORROWER"], kycStatus: "VERIFIED" };
  const borrowerHeaders = { Authorization: `Bearer ${issueTokenFn(borrowerUser)}` };

  const users = storeMod.users as unknown as any[];
  users.push({
    id: borrowerId, email: `${borrowerId}@example.com`, phone: "08012345678",
    fullName: "Smoke Borrower", passwordHash: "x", roles: ["BORROWER"],
    kycStatus: "VERIFIED", isActive: true, createdAt: new Date().toISOString(),
  });

  let failures = 0;
  function check(label: string, ok: boolean, detail?: unknown): void {
    console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    if (!ok) failures++;
  }

  /** Replace the in-memory catalog with an exact fixture (bypasses DB). */
  function setCatalog(products: any[]): void {
    loanProducts.splice(0, loanProducts.length, ...products.map((p) => ({ ...p })));
  }

  const now = new Date().toISOString();

  // ==========================================================================
  // 1. Admin-configured catalog: distinct Personal + Business products.
  //    Borrower limits deliberately different from any seed (₦200 personal).
  // ==========================================================================
  setCatalog([
    { id: "11111111-1111-1111-1111-111111111111", name: "Personal Loan", description: "Salaried workers", minAmountNaira: 200, maxAmountNaira: 30_000_000, defaultTenureDays: 30, interestRatePercent: 0.9, interestType: "ANNUALIZED", processingFeePercent: 0, lateFeePercent: 1, lateFeeType: "COMPOUNDING_DAILY", gracePeriodDays: 3, isActive: true, version: 4, createdAt: now, updatedAt: now },
    { id: "22222222-2222-2222-2222-222222222222", name: "Business Loan", description: "SMEs", minAmountNaira: 5_000, maxAmountNaira: 40_000_000, defaultTenureDays: 60, interestRatePercent: 1.1, interestType: "ANNUALIZED", processingFeePercent: 1, lateFeePercent: 1.5, lateFeeType: "COMPOUNDING_DAILY", gracePeriodDays: 5, isActive: true, version: 3, createdAt: now, updatedAt: now },
  ]);

  const personalRes = await request(app).get("/api/v1/borrower/loan-products?type=PERSONAL").set(borrowerHeaders);
  check("1a: ?type=PERSONAL returns ok:true", personalRes.status === 200 && personalRes.body.ok === true, personalRes.body);
  check("1b: exactly ONE product returned", personalRes.body.products?.length === 1, personalRes.body.products);
  check("1c: it IS the personal product with admin terms", personalRes.body.products?.[0]?.name === "Personal Loan"
    && Number(personalRes.body.products[0].minAmountNaira) === 200
    && Number(personalRes.body.products[0].interestRatePercent) === 0.9
    && personalRes.body.products[0].gracePeriodDays === 3, personalRes.body.products?.[0]);
  check("1d: programType stamped PERSONAL", personalRes.body.products?.[0]?.programType === "PERSONAL", personalRes.body.products?.[0]?.programType);
  check("1e: no fallback notice", personalRes.body.catalogNotice === null, personalRes.body.catalogNotice);

  const businessRes = await request(app).get("/api/v1/borrower/loan-products?type=BUSINESS").set(borrowerHeaders);
  check("1f: ?type=BUSINESS returns the business product only", businessRes.body.products?.length === 1
    && businessRes.body.products[0].name === "Business Loan"
    && Number(businessRes.body.products[0].minAmountNaira) === 5_000, businessRes.body.products);

  // ==========================================================================
  // 2. ?productId= returns the exact product; unknown ids 404.
  // ==========================================================================
  const byIdRes = await request(app).get("/api/v1/borrower/loan-products?productId=22222222-2222-2222-2222-222222222222").set(borrowerHeaders);
  check("2a: ?productId returns that exact product", byIdRes.body.products?.length === 1 && byIdRes.body.products[0].id === "22222222-2222-2222-2222-222222222222", byIdRes.body.products);
  const missingRes = await request(app).get("/api/v1/borrower/loan-products?productId=does-not-exist").set(borrowerHeaders);
  check("2b: unknown productId -> 404 ok:false", missingRes.status === 404 && missingRes.body.ok === false, missingRes.body);

  // ==========================================================================
  // 3. Renamed products WITHOUT any personal/business keyword — the flows
  //    must still split the catalog deterministically (cheapest -> PERSONAL,
  //    next -> BUSINESS), mirroring the frontend's pass-2 fallback. Both
  //    flows get a product; neither renders empty; terms stay per product.
  // ==========================================================================
  const t0 = new Date(Date.now() - 60000).toISOString();
  setCatalog([
    { id: "33333333-3333-3333-3333-333333333333", name: "Velo Flex Cash", minAmountNaira: 300, maxAmountNaira: 3_000_000, defaultTenureDays: 30, interestRatePercent: 2, interestType: "SIMPLE_FLAT", processingFeePercent: 1, lateFeePercent: 1, lateFeeType: "ONE_TIME", gracePeriodDays: 2, isActive: true, version: 2, createdAt: t0, updatedAt: t0 },
    { id: "44444444-4444-4444-4444-444444444444", name: "Velo Growth Fund", minAmountNaira: 750_000, maxAmountNaira: 25_000_000, defaultTenureDays: 180, interestRatePercent: 9, interestType: "REDUCING_BALANCE", processingFeePercent: 2, lateFeePercent: 0.5, lateFeeType: "ONE_TIME", gracePeriodDays: 7, isActive: true, version: 1, createdAt: t0, updatedAt: t0 },
  ]);

  const renamedPersonal = await request(app).get("/api/v1/borrower/loan-products?type=PERSONAL").set(borrowerHeaders);
  check("3a: cheapest keyword-less product -> PERSONAL (deterministic split)", renamedPersonal.body.products?.[0]?.name === "Velo Flex Cash"
    && Number(renamedPersonal.body.products[0].minAmountNaira) === 300, renamedPersonal.body.products?.[0]);
  const renamedBusiness = await request(app).get("/api/v1/borrower/loan-products?type=BUSINESS").set(borrowerHeaders);
  check("3b: next keyword-less product -> BUSINESS (no collision with PERSONAL)", renamedBusiness.body.products?.[0]?.name === "Velo Growth Fund", renamedBusiness.body.products?.[0]);

  // ==========================================================================
  // 4. ALL products inactive — the 2026-09-21 live state. ?type= must STILL
  //    return the best-match product (fallback) with the catalogNotice.
  // ==========================================================================
  for (const p of loanProducts) p.isActive = false;
  const inactivePersonal = await request(app).get("/api/v1/borrower/loan-products?type=PERSONAL").set(borrowerHeaders);
  check("4a: all-inactive ?type=PERSONAL still returns ONE product", inactivePersonal.body.products?.length === 1, inactivePersonal.body.products);
  check("4b: product is the PERSONAL-mapped one (admin terms preserved)", inactivePersonal.body.products?.[0]?.name === "Velo Flex Cash"
    && Number(inactivePersonal.body.products[0].minAmountNaira) === 300, inactivePersonal.body.products?.[0]);
  check("4c: fallback flagged via catalogNotice", inactivePersonal.body.catalogNotice === "ALL_PRODUCTS_INACTIVE_FALLBACK", inactivePersonal.body.catalogNotice);
  check("4d: activeCount reported as 0", inactivePersonal.body.activeCount === 0, inactivePersonal.body.activeCount);

  // ==========================================================================
  // 5. Full-catalog call (no params) still works and is never empty.
  // ==========================================================================
  const fullRes = await request(app).get("/api/v1/borrower/loan-products").set(borrowerHeaders);
  check("5a: full catalog non-empty even when all inactive", fullRes.body.products?.length >= 2, fullRes.body.products?.length);
  check("5b: full catalog also flagged", fullRes.body.catalogNotice === "ALL_PRODUCTS_INACTIVE_FALLBACK", fullRes.body.catalogNotice);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke] fatal:", err);
  process.exit(1);
});
