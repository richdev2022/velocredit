// ============================================================================
// scripts/smokeDisbursementAccount.ts
// End-to-end smoke test for the disbursement-account fixes:
//   1. Loan application WITHOUT a disbursement account -> REJECTED (400) with
//      a readable message (no more "application submitted, then disbursement
//      fails with No disbursement account found")
//   2. Loan application with an INCOMPLETE account (missing bankCode) -> 400
//   3. Complete account -> 201, stored on the application AND its snapshot
//   4. Admin disbursement picks the APPLICATION-SUBMITTED account when no
//      saved account exists, and promotes it into the borrower's saved
//      accounts for future visibility
//   5. Settings POST /borrower/disbursement-account self-heals: stamps the
//      new account onto open applications that carry none (legacy escape hatch)
//   6. guessBankCodeFromName recovers bank codes from bank names
//
// Run: env -u DATABASE_URL npx tsx scripts/smokeDisbursementAccount.ts
// ============================================================================

import express from "express";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "smoke-test-secret-0123456789abcdef0123456789";

let issueTokenFn: ((user: any) => string) | null = null;

type StoreModule = typeof import("../backend/server/store.js");
type RoutesModule = typeof import("../backend/server/routes.js");

async function main(): Promise<void> {
  const auth = await import("../backend/server/auth.js");
  issueTokenFn = (user: any) => (auth as any).issueToken(user);
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

  const users = storeMod.users as unknown as any[];
  const loanApplications = storeMod.loanApplications as unknown as any[];
  const disbursementAccounts = storeMod.disbursementAccounts as unknown as any[];
  const loans = storeMod.loans as unknown as any[];

  let failures = 0;
  function check(label: string, ok: boolean, detail?: unknown): void {
    console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    if (!ok) failures++;
  }

  function makeUser(id: string, fullName: string): any {
    const user = {
      id, email: `${id}@example.com`, phone: "0800000000",
      fullName, passwordHash: "x", roles: ["BORROWER"],
      kycStatus: "VERIFIED", isActive: true, createdAt: new Date().toISOString(),
    };
    users.push(user);
    return user;
  }

  function cleanupBorrower(id: string): void {
    const userIdx = users.findIndex((u) => u.id === id);
    if (userIdx >= 0) users.splice(userIdx, 1);
    for (let i = loanApplications.length - 1; i >= 0; i--) if (loanApplications[i].borrowerId === id) loanApplications.splice(i, 1);
    for (let i = disbursementAccounts.length - 1; i >= 0; i--) if (disbursementAccounts[i].borrowerId === id) disbursementAccounts.splice(i, 1);
    for (let i = loans.length - 1; i >= 0; i--) {
      if (loans[i].borrowerId === id) {
        const schedules = storeMod.loanSchedules as unknown as any[];
        for (let j = schedules.length - 1; j >= 0; j--) if (schedules[j].loanId === loans[i].id) schedules.splice(j, 1);
        loans.splice(i, 1);
      }
    }
    const histories = storeMod.creditHistory as unknown as any[];
    for (let i = histories.length - 1; i >= 0; i--) if (histories[i].userId === id) histories.splice(i, 1);
    const scores = storeMod.creditScores as unknown as any[];
    for (let i = scores.length - 1; i >= 0; i--) if (scores[i].userId === id) scores.splice(i, 1);
    const kycCases = storeMod.kycCases as unknown as any[];
    for (let i = kycCases.length - 1; i >= 0; i--) if (kycCases[i].userId === id) kycCases.splice(i, 1);
  }

  // --- users ---
  const ts = Date.now();
  const b1 = `smoke-disb-b1-${ts}`;
  const b2 = `smoke-disb-b2-${ts}`;
  const admin = `smoke-disb-admin-${ts}`;
  const borrower1 = makeUser(b1, "Disb Smoke One");
  const borrower2 = makeUser(b2, "Disb Smoke Two");
  const adminUser = makeUser(admin, "Disb Smoke Admin");
  adminUser.roles.push("ADMIN");
  const borrower1Headers = { Authorization: `Bearer ${issueTokenFn!(borrower1)}` };
  const borrower2Headers = { Authorization: `Bearer ${issueTokenFn!(borrower2)}` };
  const adminHeaders = { Authorization: `Bearer ${issueTokenFn!(adminUser)}` };

  // KYC gate: the application route requires BVN/NIN/liveness verification.
  for (const id of [b1, b2]) {
    const kyc = storeMod.findOrCreateKycCase(id) as any;
    kyc.checklist.bvn = true; kyc.checklist.nin = true; kyc.checklist.liveness = true;
  kyc.status = "VERIFIED"; // admin-approved KYC (required by the disbursement KYC gate)
    kyc.bvn = "12345678901"; kyc.nin = "12345678901";
  }

  // --- 1. submission WITHOUT disbursement account is rejected ---
  const noAccountRes = await request(app)
    .post("/api/v1/borrower/applications")
    .set(borrower1Headers)
    .send({
      applicantType: "PERSONAL",
      loanRequest: { amount: 50_000, tenure: 30, purpose: "Smoke test without disbursement account" },
      personalInfo: { fullName: "Disb Smoke One" },
    });
  check("submission without disbursement account rejected (400)", noAccountRes.status === 400, { status: noAccountRes.status, body: noAccountRes.body });
  check("rejection error is a readable string", typeof noAccountRes.body?.error === "string" && /disbursement/i.test(noAccountRes.body.error), noAccountRes.body?.error);

  // --- 2. submission with INCOMPLETE account (missing bankCode) is rejected ---
  const missingCodeRes = await request(app)
    .post("/api/v1/borrower/applications")
    .set(borrower1Headers)
    .send({
      applicantType: "PERSONAL",
      loanRequest: { amount: 50_000, tenure: 30, purpose: "Smoke test missing bank code" },
      personalInfo: { fullName: "Disb Smoke One" },
      disbursementAccount: { accountName: "Disb Smoke One", accountNumber: "0123456789", bankName: "Guaranty Trust Bank" },
    });
  check("submission missing bankCode rejected (400)", missingCodeRes.status === 400, { status: missingCodeRes.status, body: missingCodeRes.body });

  // --- 3. complete account -> accepted, stored on application + snapshot ---
  const okRes = await request(app)
    .post("/api/v1/borrower/applications")
    .set(borrower1Headers)
    .send({
      applicantType: "PERSONAL",
      loanRequest: { amount: 50_000, tenure: 30, purpose: "Smoke test with complete disbursement account" },
      personalInfo: { fullName: "Disb Smoke One" },
      disbursementAccount: {
        accountName: "DISB SMOKE ONE",
        accountNumber: "0123456789",
        bankCode: "058",
        bankName: "Guaranty Trust Bank",
      },
    });
  check("submission with complete account accepted (201)", okRes.status === 201, { status: okRes.status, body: okRes.body });
  const application = okRes.body.application;
  check("application carries the submitted account", application?.disbursementAccount?.accountNumber === "0123456789", application?.disbursementAccount);
  check("application account institution stamped VELO", application?.disbursementAccount?.institution === "VELO", application?.disbursementAccount);
  check("customerSnapshot carries account WITH bankCode", application?.customerSnapshot?.disbursementAccount?.bankCode === "058", application?.customerSnapshot?.disbursementAccount);

  // --- 4. admin disbursement picks up the application-submitted account ---
  const approveRes = await request(app)
    .post(`/api/v1/admin/loans/${application.id}/decision`)
    .set(adminHeaders)
    .send({ decision: "APPROVED", note: "smoke" });
  check("application approved", approveRes.status === 200, { status: approveRes.status, body: approveRes.body });

  const savedBefore = disbursementAccounts.filter((a: any) => a.borrowerId === b1);
  check("borrower has NO saved account before disbursement", savedBefore.length === 0, savedBefore);

  const disburseRes = await request(app)
    .post(`/api/v1/admin/loans/${application.id}/disburse`)
    .set(adminHeaders)
    .send({});
  // The disburse route now WAITS for the provider's final answer; without a
  // Flutterwave key in the smoke run the attempt terminates synchronously as
  // FAILED ("Flutterwave is not configured") — the account fields still prove
  // the application account was picked up.
  check("disbursement attempt answered synchronously (200 final)", disburseRes.status === 200 && disburseRes.body?.final === true, { status: disburseRes.status, final: disburseRes.body?.final });
  check("disbursement used application accountNumber", disburseRes.body?.disbursement?.accountNumber === "0123456789", disburseRes.body?.disbursement);
  check("disbursement used application bankCode 058", disburseRes.body?.disbursement?.bankCode === "058", disburseRes.body?.disbursement);
  const savedAfter = disbursementAccounts.find((a: any) => a.borrowerId === b1);
  check("application account PROMOTED to saved account", Boolean(savedAfter) && savedAfter.accountNumber === "0123456789" && savedAfter.status === "ACTIVE", savedAfter);

  // --- 5. settings self-heal: legacy application without account gets stamped ---
  const legacyApp = {
    id: `smoke-legacy-${ts}`,
    applicationId: `smoke-legacy-app-${ts}`,
    borrowerId: b2,
    applicantType: "PERSONAL",
    customerSnapshot: { fullName: "Disb Smoke Two", disbursementAccount: {} },
    amountNaira: 25_000,
    status: "UNDER_REVIEW",
    stageStatuses: {},
    stageRejectionNotes: {},
    manualDecision: "PENDING",
    disbursementInstitution: "VELO",
    disbursementAccount: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
  };
  loanApplications.push(legacyApp);
  const settingsAddRes = await request(app)
    .post("/api/v1/borrower/disbursement-account")
    .set(borrower2Headers)
    .send({ accountName: "DISB SMOKE TWO", accountNumber: "0987654321", bankCode: "044", bankName: "Access Bank" });
  check("settings add account succeeds (200)", settingsAddRes.status === 200, { status: settingsAddRes.status, body: settingsAddRes.body });
  check("saved account created ACTIVE", settingsAddRes.body?.account?.status === "ACTIVE", settingsAddRes.body?.account);
  check("legacy open application stamped with the new account", legacyApp.disbursementAccount?.accountNumber === "0987654321" && legacyApp.customerSnapshot?.disbursementAccount?.bankCode === "044", legacyApp.disbursementAccount);
  check("stampedApplications reported", settingsAddRes.body?.stampedApplications === 1, settingsAddRes.body?.stampedApplications);

  // Second settings POST with an existing account -> goes to approval queue, NOT re-stamped silently
  const settingsEditRes = await request(app)
    .put("/api/v1/borrower/disbursement-account")
    .set(borrower2Headers)
    .send({ accountName: "DISB SMOKE TWO", accountNumber: "0987654322", bankCode: "044", bankName: "Access Bank" });
  check("settings EDIT routes to admin approval (202)", settingsEditRes.status === 202, { status: settingsEditRes.status, body: settingsEditRes.body });

  // --- 6. guessBankCodeFromName recovery ---
  const guess = (routesMod as any).guessBankCodeFromName;
  check("guessBankCodeFromName: GTB", guess("Guaranty Trust Bank plc") === "058", guess("Guaranty Trust Bank plc"));
  check("guessBankCodeFromName: Kuda", guess("Kuda Microfinance Bank") === "50211", guess("Kuda Microfinance Bank"));
  check("guessBankCodeFromName: Access", guess("Access Bank") === "044", guess("Access Bank"));
  check("guessBankCodeFromName: UBA", guess("United Bank for Africa") === "033", guess("United Bank for Africa"));
  check("guessBankCodeFromName: unknown bank -> undefined", guess("Totally Unknown Trust") === undefined, guess("Totally Unknown Trust"));

  // --- cleanup ---
  cleanupBorrower(b1);
  cleanupBorrower(b2);

  console.log(failures === 0 ? "\n[smoke] ALL CHECKS PASSED" : `\n[smoke] ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke] crashed:", err);
  process.exit(1);
});
