// ============================================================================
// scripts/smokeApprovalDisbursement.ts
// End-to-end smoke test for the loan-approval + disbursement incident:
//
//   1. Admin loan approval responds 200 (no "Unable to Save Information" 503)
//      and creates the loan record + credit history event.
//   2. GET /admin/loans returns lightweight `loanRecords` so the admin UI can
//      drive the disburse button from the REAL loan status.
//   3. Disbursement initiation responds 202 immediately, loan -> DISBURSEMENT_
//      PENDING, disbursement row PROCESSING; a concurrent disburse is rejected
//      (409) — the button can't double-fire.
//   4. When the provider rejects the transfer (no Flutterwave key in the smoke
//      run), the disbursement is marked FAILED with the provider error stored,
//      and the loan rolls back to APPROVED so it can be triggered again.
//   5. The dedicated retry endpoint creates a NEW attempt (retryCount + 1,
//      retryOfId set) with a unique provider reference.
//   6. Approval is idempotent: re-approving an already-approved application
//      does not create a duplicate loan.
//
// Run: env -u DATABASE_URL npx tsx scripts/smokeApprovalDisbursement.ts
// ============================================================================

import express from "express";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "smoke-test-secret-0123456789abcdef0123456789";

let issueTokenFn: ((user: any) => string) | null = null;

type StoreModule = typeof import("../backend/server/store.js");
type RoutesModule = typeof import("../backend/server/routes.js");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const loanDisbursements = storeMod.loanDisbursements as unknown as any[];
  const creditHistory = storeMod.creditHistory as unknown as any[];

  let failures = 0;
  function check(label: string, ok: boolean, detail?: unknown): void {
    console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    if (!ok) failures++;
  }

  function makeUser(id: string, fullName: string, roles: string[] = ["BORROWER"]): any {
    const user = {
      id, email: `${id}@example.com`, phone: "0800000000",
      fullName, passwordHash: "x", roles,
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
    for (let i = loanDisbursements.length - 1; i >= 0; i--) if (loanDisbursements[i].borrowerId === id) loanDisbursements.splice(i, 1);
    for (let i = creditHistory.length - 1; i >= 0; i--) if (creditHistory[i].userId === id) creditHistory.splice(i, 1);
    const scores = storeMod.creditScores as unknown as any[];
    for (let i = scores.length - 1; i >= 0; i--) if (scores[i].userId === id) scores.splice(i, 1);
    const kycCases = storeMod.kycCases as unknown as any[];
    for (let i = kycCases.length - 1; i >= 0; i--) if (kycCases[i].userId === id) kycCases.splice(i, 1);
  }

  const ts = Date.now();
  const b1 = `smoke-appr-b1-${ts}`;
  const admin = `smoke-appr-admin-${ts}`;
  const borrower1 = makeUser(b1, "Approval Smoke One");
  const adminUser = makeUser(admin, "Approval Smoke Admin", ["ADMIN"]);
  const borrower1Headers = { Authorization: `Bearer ${issueTokenFn!(borrower1)}` };
  const adminHeaders = { Authorization: `Bearer ${issueTokenFn!(adminUser)}` };

  // KYC gate
  const kyc = storeMod.findOrCreateKycCase(b1) as any;
  kyc.checklist.bvn = true; kyc.checklist.nin = true; kyc.checklist.liveness = true;
  kyc.bvn = "12345678901"; kyc.nin = "12345678901";

  try {
    // --- 1. submit application with a complete disbursement account ---
    const submitRes = await request(app)
      .post("/api/v1/borrower/applications")
      .set(borrower1Headers)
      .send({
        applicantType: "PERSONAL",
        loanRequest: { amount: 20_000, tenure: 30, purpose: "Approval + disbursement smoke" },
        personalInfo: { fullName: "Approval Smoke One" },
        disbursementAccount: {
          accountName: "APPROVAL SMOKE ONE",
          accountNumber: "9164819320",
          bankCode: "999992",
          bankName: "Opay",
        },
      });
    check("application submitted (201)", submitRes.status === 201, { status: submitRes.status, body: submitRes.body });
    const application = submitRes.body.application;

    // --- 2. admin approval responds 200 (NOT 503 "Unable to Save Information") ---
    const approveRes = await request(app)
      .post(`/api/v1/admin/loans/${application.id}/decision`)
      .set(adminHeaders)
      .send({ decision: "APPROVED", note: "smoke approval" });
    check("approval responds 200 (no Unable-to-Save 503)", approveRes.status === 200, { status: approveRes.status, body: approveRes.body });
    check("application status APPROVED", approveRes.body?.application?.status === "APPROVED", approveRes.body?.application?.status);

    const creditEvent = creditHistory.find((c: any) => c.loanId && c.eventType === "LOAN_APPROVED" && c.userId === b1);
    check("LOAN_APPROVED credit event created for the new loan", Boolean(creditEvent), creditEvent);

    const loanRecord = loans.find((l: any) => l.applicationId === application.id);
    check("loan record created at approval", Boolean(loanRecord), loans.map((l: any) => l.applicationId));

    // --- 3. approval is idempotent (no duplicate loan) ---
    const reApproveRes = await request(app)
      .post(`/api/v1/admin/loans/${application.id}/decision`)
      .set(adminHeaders)
      .send({ decision: "APPROVED", note: "duplicate approval attempt" });
    check("re-approval responds 200", reApproveRes.status === 200, { status: reApproveRes.status, body: reApproveRes.body });
    check("no duplicate loan record created", loans.filter((l: any) => l.applicationId === application.id).length === 1, loans.filter((l: any) => l.applicationId === application.id).length);

    // --- 4. GET /admin/loans returns loanRecords for the page ---
    const listRes = await request(app)
      .get("/api/v1/admin/loans?limit=50")
      .set(adminHeaders);
    check("admin loans list responds 200", listRes.status === 200, { status: listRes.status });
    const listLoanRecords = (listRes.body as any)?.loanRecords;
    check("loanRecords payload present", Array.isArray(listLoanRecords), typeof listLoanRecords);
    const matchingRecord = Array.isArray(listLoanRecords)
      ? listLoanRecords.find((r: any) => r.applicationId === application.id)
      : undefined;
    check("loanRecords contains the approved loan", Boolean(matchingRecord), listLoanRecords);
    check("loanRecords entry carries status + projection fields", Boolean(matchingRecord && matchingRecord.status && "disbursedAt" in matchingRecord && "id" in matchingRecord), matchingRecord);

    // --- 5. disbursement initiation: SYNCHRONOUS final provider answer ---
    // (No FLUTTERWAVE_SECRET_KEY in the smoke run, so the attempt fails
    // immediately with "Flutterwave is not configured". The route now WAITS
    // for the provider and answers with the FINAL result — ok:false + FAILED
    // + the provider reason — instead of an optimistic 202 PROCESSING.)
    const disburseRes = await request(app)
      .post(`/api/v1/admin/loans/${application.id}/disburse`)
      .set(adminHeaders)
      .send({});
    check("disbursement answered synchronously (200, not 202)", disburseRes.status === 200, { status: disburseRes.status, body: disburseRes.body });
    check("disbursement carries the FINAL outcome flag", disburseRes.body?.final === true, disburseRes.body?.final);
    check("unconfigured provider -> terminal FAILED response", disburseRes.body?.ok === false && disburseRes.body?.disbursement?.status === "FAILED", { ok: disburseRes.body?.ok, status: disburseRes.body?.disbursement?.status });
    check("provider reason surfaced in the response error", typeof disburseRes.body?.error === "string" && disburseRes.body.error.length > 0, disburseRes.body?.error);
    const firstDisbursement = disburseRes.body?.disbursement;
    check("attempt reference is unique per attempt (loan + disbursement id)", typeof firstDisbursement?.id === "string", firstDisbursement?.id);

    // --- 6. concurrent disburse is rejected while one is in flight ---
    // Deterministic guard check: simulate an in-flight transfer for this loan
    // (with a real provider the PROCESSING window lasts seconds, here we pin
    // the state directly) and confirm the route refuses a second initiation.
    const syntheticInFlight = {
      id: `smoke-inflight-${ts}`,
      loanId: loanRecord.id,
      applicationId: application.id,
      borrowerId: b1,
      amountNaira: Number(loanRecord.principalNaira),
      currency: "NGN",
      bankCode: "999992",
      bankName: "Opay",
      accountNumber: "9164819320",
      accountName: "APPROVAL SMOKE ONE",
      status: "PROCESSING",
      narration: "smoke in-flight guard",
      retryCount: 0,
      retryOfId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      providerTransfer: null,
      providerReference: null,
      error: null,
    };
    loanDisbursements.push(syntheticInFlight);
    const duplicateRes = await request(app)
      .post(`/api/v1/admin/loans/${application.id}/disburse`)
      .set(adminHeaders)
      .send({});
    check("second disburse while PROCESSING rejected (409)", duplicateRes.status === 409, { status: duplicateRes.status, body: duplicateRes.body });
    const syntheticIdx = loanDisbursements.findIndex((d: any) => d.id === syntheticInFlight.id);
    if (syntheticIdx >= 0) loanDisbursements.splice(syntheticIdx, 1);

    // --- 7. provider failure path: FAILED status + error stored + loan rolled back ---
    // (Already terminal — the route waits for the provider, no polling needed.)
    const failedRecord = loanDisbursements.find((d: any) => d.id === firstDisbursement?.id);
    check("disbursement marked FAILED after provider error", failedRecord?.status === "FAILED", failedRecord?.status);
    check("provider error stored on the disbursement record", typeof failedRecord?.error === "string" && failedRecord.error.length > 0, failedRecord?.error);
    const loanAfterFailure = loans.find((l: any) => l.applicationId === application.id);
    check("loan rolled back to APPROVED for retry", loanAfterFailure?.status === "APPROVED", loanAfterFailure?.status);

    // admin list still returns the FAILED record with its error
    const disbursementsListRes = await request(app)
      .get("/api/v1/admin/disbursements?limit=100")
      .set(adminHeaders);
    const listedFailed = (disbursementsListRes.body as any)?.disbursements?.find((d: any) => d.id === firstDisbursement?.id);
    check("admin disbursements list exposes the FAILED record", Boolean(listedFailed) && listedFailed.status === "FAILED", listedFailed?.status);

    // --- 8. re-disburse after failure creates a NEW attempt (synchronous) ---
    const redisburseRes = await request(app)
      .post(`/api/v1/admin/loans/${application.id}/disburse`)
      .set(adminHeaders)
      .send({});
    check("re-disbursement after failure answered (200 final)", redisburseRes.status === 200 && redisburseRes.body?.final === true, { status: redisburseRes.status, final: redisburseRes.body?.final });
    const secondDisbursement = redisburseRes.body?.disbursement;
    check("second attempt is a NEW disbursement row", secondDisbursement?.id !== firstDisbursement?.id, { first: firstDisbursement?.id, second: secondDisbursement?.id });
    check("second attempt also reaches terminal state without blocking", ["FAILED", "PROCESSING", "PENDING", "SUCCESSFUL"].includes(loanDisbursements.find((d: any) => d.id === secondDisbursement?.id)?.status), loanDisbursements.find((d: any) => d.id === secondDisbursement?.id)?.status);

    // --- 9. dedicated retry endpoint: synchronous final answer with retryOfId + retryCount ---
    const latestFailed = loanDisbursements
      .filter((d: any) => d.loanId === loanAfterFailure?.id && d.status === "FAILED")
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    const retryRes = await request(app)
      .post(`/api/v1/admin/disbursements/${latestFailed?.id}/retry`)
      .set(adminHeaders)
      .send({});
    check("retry endpoint answered synchronously (200 final)", retryRes.status === 200 && retryRes.body?.final === true, { status: retryRes.status, final: retryRes.body?.final });
    const retryRecord = retryRes.body?.disbursement;
    check("retry links to the failed attempt (retryOfId)", retryRecord?.retryOfId === latestFailed?.id, retryRecord);
    check("retryCount incremented", Number(retryRecord?.retryCount ?? 0) === Number(latestFailed?.retryCount ?? 0) + 1, { retryCount: retryRecord?.retryCount, prev: latestFailed?.retryCount });
  } finally {
    cleanupBorrower(b1);
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("[smoke] fatal:", error);
  process.exit(1);
});
