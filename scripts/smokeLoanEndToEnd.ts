// ============================================================================
// scripts/smokeLoanEndToEnd.ts
// End-to-end API smoke test for the loan-product backward-compatibility flow:
//   1. borrower submits an application -> loanProductId + productSnapshot stamped
//   2. admin RENAMES + RE-PRICES the product (fully editable catalog path)
//   3. admin approves the application -> loan terms honour what the borrower
//      saw (saved calculation) and capture a fresh snapshot
//   4. GET /borrower/dashboard + /borrower/loans still return FULL loan
//      information (productName etc.) — never an empty product block
//   5. GET /borrower/loan-products returns programType classifications
//
// Run: env -u DATABASE_URL npx tsx scripts/smokeLoanEndToEnd.ts
// ============================================================================

import express from "express";

// Real JWTs so requireAuth/requireRole accept our smoke-test users.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "smoke-test-secret-0123456789abcdef0123456789";

async function issueTokens(): Promise<void> {
  const auth = await import("../backend/server/auth.js");
  issueTokenFn = (user: any) => (auth as any).issueToken(user);
}
let issueTokenFn: ((user: any) => string) | null = null;

type StoreModule = typeof import("../backend/server/store.js");
type RoutesModule = typeof import("../backend/server/routes.js");

async function main(): Promise<void> {
  await issueTokens();
  if (!issueTokenFn) throw new Error("issueToken not initialised");
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
  app.use((req: any, _res, next) => {
    const id = req.headers["x-test-user-id"];
    if (id) {
      req.user = { id, roles: JSON.parse(req.headers["x-test-roles"] || '["BORROWER"]') };
    }
    next();
  });
  app.use("/api/v1", routesMod.default);

  const loanProducts = storeMod.loanProducts as unknown as any[];
  const personal = loanProducts.find((p) => /personal/i.test(p.name));
  if (!personal) throw new Error("seed personal product missing");

  const borrowerId = `smoke-borrower-${Date.now()}`;
  const adminId = `smoke-admin-${Date.now()}`;
  const adminUser = { id: adminId, email: `${adminId}@example.com`, fullName: "Smoke Admin", roles: ["ADMIN"], kycStatus: "VERIFIED" };
  const borrowerUser = { id: borrowerId, email: `${borrowerId}@example.com`, fullName: "Smoke Borrower", roles: ["BORROWER"], kycStatus: "VERIFIED" };
  const adminHeaders = { Authorization: `Bearer ${issueTokenFn(adminUser)}` };
  const borrowerHeaders = { Authorization: `Bearer ${issueTokenFn(borrowerUser)}` };

  let failures = 0;
  function check(label: string, ok: boolean, detail?: unknown): void {
    console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    if (!ok) failures++;
  }

  // --- 0. ensure the borrower + admin users exist (requireAuth checks the store) ---
  const users = storeMod.users as unknown as any[];
  users.push({
    id: borrowerId, email: `${borrowerId}@example.com`, phone: "08012345678",
    fullName: "Smoke Borrower", passwordHash: "x", roles: ["BORROWER", "INVESTOR"],
    kycStatus: "VERIFIED", isActive: true, createdAt: new Date().toISOString(),
  });
  users.push({
    id: adminId, email: `${adminId}@example.com`, phone: "08012345679",
    fullName: "Smoke Admin", passwordHash: "x", roles: ["ADMIN"],
    kycStatus: "VERIFIED", isActive: true, createdAt: new Date().toISOString(),
  });
  const kyc = storeMod.findOrCreateKycCase(borrowerId) as any;
  kyc.checklist.bvn = true; kyc.checklist.nin = true; kyc.checklist.liveness = true;
  kyc.bvn = "12345678901"; kyc.nin = "12345678901";

  // --- 1. submit an application (what the borrower saw: 5% ANNUALIZED) ---
  const seenCalculation = {
    loanAmount: 100_000, interest: 1_500, serviceFee: 0, processingFee: 2_000,
    lateFee: 1_000, totalFees: 3_500, totalRepayment: 103_500, tenure: 90,
    breakdown: [],
  };
  const createRes = await request(app)
    .post("/api/v1/borrower/applications")
    .set(borrowerHeaders)
    .send({
      applicantType: "PERSONAL",
      loanRequest: { amount: 100_000, tenure: 90, purpose: "Smoke test loan application purpose" },
      calculation: seenCalculation,
      personalInfo: { fullName: "Smoke Borrower" },
    });
  check("application created (201)", createRes.status === 201, createRes.body);
  const application = createRes.body.application;
  check("application stamped with loanProductId", application?.loanProductId === personal.id, application?.loanProductId);
  check("application captured productSnapshot", application?.productSnapshot?.productName === personal.name, application?.productSnapshot);

  // --- 2. admin RENAMES + RE-PRICES the product (catalog editor path) ---
  const versionBefore = Number(personal.version ?? 1);
  const patchRes = await request(app)
    .patch(`/api/v1/admin/loan-products/${personal.id}`)
    .set(adminHeaders)
    .send({ name: "Velo Flex Cash", interestRatePercent: 25, minAmountNaira: 200, maxAmountNaira: 40_000_000, processingFeePercent: 4 });
  check("admin renamed + re-priced product", patchRes.status === 200 && patchRes.body.product.name === "Velo Flex Cash", patchRes.body);
  check("version bumped on edit", Number(patchRes.body.product?.version) === versionBefore + 1, { before: versionBefore, after: patchRes.body.product?.version });

  // --- 3. admin approves the application ---
  const decisionRes = await request(app)
    .post(`/api/v1/admin/loans/${application.id}/decision`)
    .set(adminHeaders)
    .send({ decision: "APPROVED", note: "smoke" });
  check("application approved", decisionRes.status === 200 && decisionRes.body.application.status === "APPROVED", decisionRes.body);

  const loans = storeMod.loans as unknown as any[];
  const loan = loans.find((l) => l.applicationId === application.id);
  check("loan record created", Boolean(loan));
  check("loan linked to renamed product", loan?.loanProductId === personal.id, loan?.loanProductId);
  check("loan snapshot captured NEW name", loan?.productSnapshot?.productName === "Velo Flex Cash", loan?.productSnapshot?.productName);
  // Terms priority: the borrower's SAVED calculation (what they agreed to).
  check("loan interest honours saved calculation", Math.abs(Number(loan?.totalInterestNaira) - 1_500) < 0.01, loan?.totalInterestNaira);
  check("loan fees honour saved calculation", Math.abs(Number(loan?.totalFeesNaira) - 2_000) < 0.01, loan?.totalFeesNaira);
  check("loan total = principal + saved fees", Math.abs(Number(loan?.totalRepaymentNaira) - 103_500) < 0.01, loan?.totalRepaymentNaira);

  // --- 4. borrower dashboard + loans return full product info (never empty) ---
  const dashRes = await request(app).get("/api/v1/borrower/dashboard").set(borrowerHeaders);
  const dashApp = dashRes.body.applications?.find((a: any) => a.id === application.id);
  check("dashboard returns application", Boolean(dashApp));
  check("dashboard application shows productName (renamed)", dashApp?.productName === "Velo Flex Cash", dashApp?.productName);
  check("dashboard application shows product interest", Number(dashApp?.productInterestRatePercent) === 25, dashApp?.productInterestRatePercent);
  const dashLoan = dashRes.body.loans?.find((l: any) => l.id === loan?.id);
  check("dashboard loan shows productName", dashLoan?.productName === "Velo Flex Cash", dashLoan?.productName);

  const loansRes = await request(app).get("/api/v1/borrower/loans").set(borrowerHeaders);
  const listedLoan = loansRes.body.loans?.find((l: any) => l.id === loan?.id);
  check("borrower/loans shows productName + range", listedLoan?.productName === "Velo Flex Cash" && Number(listedLoan?.productMaxAmountNaira) === 40_000_000, listedLoan?.productName);

  // --- 5. borrower loan-products return programType ---
  const productsRes = await request(app).get("/api/v1/borrower/loan-products").set(borrowerHeaders);
  const flexProduct = productsRes.body.products?.find((p: any) => p.id === personal.id);
  check("loan-products visible for borrower", Boolean(flexProduct));
  check("renamed product classified for PERSONAL via keyword-less fallback", flexProduct?.programType === null || flexProduct?.programType === "PERSONAL", flexProduct?.programType);
  const adminProductsRes = await request(app).get("/api/v1/admin/loan-products").set(adminHeaders);
  check("admin sees full catalog", adminProductsRes.status === 200 && Array.isArray(adminProductsRes.body.products));

  // --- cleanup: remove smoke user + application so nothing leaks into other stores ---
  const userIdx = users.findIndex((u) => u.id === borrowerId);
  if (userIdx >= 0) users.splice(userIdx, 1);
  const apps = storeMod.loanApplications as unknown as any[];
  const appIdx = apps.findIndex((a) => a.id === application.id);
  if (appIdx >= 0) apps.splice(appIdx, 1);
  if (loan) {
    const loanIdx = loans.findIndex((l) => l.id === loan.id);
    if (loanIdx >= 0) loans.splice(loanIdx, 1);
    const schedules = storeMod.loanSchedules as unknown as any[];
    for (let i = schedules.length - 1; i >= 0; i--) if (schedules[i].loanId === loan.id) schedules.splice(i, 1);
  }
  const histories = storeMod.creditHistory as unknown as any[];
  for (let i = histories.length - 1; i >= 0; i--) if (histories[i].userId === borrowerId) histories.splice(i, 1);
  const scores = storeMod.creditScores as unknown as any[];
  for (let i = scores.length - 1; i >= 0; i--) if (scores[i].userId === borrowerId) scores.splice(i, 1);

  console.log(failures === 0 ? "\n[smoke] ALL CHECKS PASSED" : `\n[smoke] ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke] crashed:", err);
  process.exit(1);
});
