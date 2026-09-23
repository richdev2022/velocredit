// ============================================================================
// scripts/smokeRejectionReopen.ts
// Regression smoke tests for:
//   A. REJECTED loan applications are RE-OPENABLE end to end:
//        1. admin rejects with a note -> borrower dashboard exposes the note
//        2. PATCH /borrower/applications/:id works for REJECTED (fix info)
//        3. resubmission (POST /:id/submit) resets the whole review pipeline
//           (manualDecision, note, stage rejections, stage statuses)
//        4. once resubmitted the application is locked again (409 on PATCH)
//        5. non-rejected applications stay protected (PATCH 409 UNDER_REVIEW)
//   B. Disbursement-account VISIBILITY while the settings form is locked:
//        6. no saved account -> GET /borrower/disbursement-account falls back
//           to the account submitted WITH the application (accountSource
//           "application", bankCode preserved)
//        7. saved standalone account wins (accountSource "saved")
//        8. legacy snapshot-only account is found too
//
// Run: env -u DATABASE_URL npx tsx scripts/smokeRejectionReopen.ts
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
    const histories = storeMod.creditHistory as unknown as any[];
    for (let i = histories.length - 1; i >= 0; i--) if (histories[i].userId === id) histories.splice(i, 1);
    const scores = storeMod.creditScores as unknown as any[];
    for (let i = scores.length - 1; i >= 0; i--) if (scores[i].userId === id) scores.splice(i, 1);
    const kycCases = storeMod.kycCases as unknown as any[];
    for (let i = kycCases.length - 1; i >= 0; i--) if (kycCases[i].userId === id) kycCases.splice(i, 1);
  }

  const ts = Date.now();
  const b1 = `smoke-reject-b1-${ts}`;
  const b2 = `smoke-reject-b2-${ts}`;
  const b3 = `smoke-reject-b3-${ts}`;
  const admin = `smoke-reject-admin-${ts}`;
  const borrower1 = makeUser(b1, "Reject Smoke One");
  const borrower2 = makeUser(b2, "Reject Smoke Two");
  makeUser(b3, "Reject Smoke Three");
  const adminUser = makeUser(admin, "Reject Smoke Admin");
  adminUser.roles.push("ADMIN");
  const h1 = { Authorization: `Bearer ${issueTokenFn!(borrower1)}` };
  const h2 = { Authorization: `Bearer ${issueTokenFn!(borrower2)}` };
  const h3 = { Authorization: `Bearer ${issueTokenFn!(users.find((u) => u.id === b3)!)}` };
  const adminHeaders = { Authorization: `Bearer ${issueTokenFn!(adminUser)}` };

  for (const id of [b1, b2, b3]) {
    const kyc = storeMod.findOrCreateKycCase(id) as any;
    kyc.checklist.bvn = true; kyc.checklist.nin = true; kyc.checklist.liveness = true;
    kyc.bvn = "12345678901"; kyc.nin = "12345678901";
  }

  const validPayload = (name: string, purpose: string) => ({
    applicantType: "PERSONAL",
    loanRequest: { amount: 50_000, tenure: 30, purpose },
    personalInfo: { fullName: name },
    disbursementAccount: {
      accountName: name.toUpperCase(),
      accountNumber: "0123456789",
      bankCode: "058",
      bankName: "Guaranty Trust Bank",
    },
  });

  // ==========================================================================
  // A. rejection -> re-access -> fix -> resubmit
  // ==========================================================================
  const created = await request(app)
    .post("/api/v1/borrower/applications")
    .set(h1)
    .send(validPayload("Reject Smoke One", "Smoke test rejection and reopen flow"));
  check("application created (201)", created.status === 201, { status: created.status, body: created.body });
  const appId: string = created.body?.application?.id;
  const applicationId: string = created.body?.application?.applicationId;
  check("application starts UNDER_REVIEW", created.body?.application?.status === "UNDER_REVIEW", created.body?.application?.status);

  // --- admin rejects with a note ---
  const rejectRes = await request(app)
    .post(`/api/v1/admin/loans/${appId}/decision`)
    .set(adminHeaders)
    .send({ decision: "REJECTED", note: "Employment details could not be verified" });
  check("admin rejects application (200)", rejectRes.status === 200, { status: rejectRes.status, body: rejectRes.body });
  check("application status REJECTED", rejectRes.body?.application?.status === "REJECTED", rejectRes.body?.application?.status);
  check("rejection note stored", rejectRes.body?.application?.manualNote === "Employment details could not be verified", rejectRes.body?.application?.manualNote);

  // --- borrower dashboard exposes the rejection note ---
  const dashRes = await request(app).get("/api/v1/borrower/dashboard").set(h1);
  check("dashboard reachable (200)", dashRes.status === 200, { status: dashRes.status });
  const dashApp = (dashRes.body?.applications ?? []).find((a: any) => a.id === appId);
  check("dashboard exposes REJECTED status", dashApp?.status === "REJECTED", dashApp?.status);
  check("dashboard exposes rejection note for the customer", dashApp?.manualNote === "Employment details could not be verified", dashApp?.manualNote);

  // --- PATCH while REJECTED is allowed (fix the failed information) ---
  const patchRes = await request(app)
    .patch(`/api/v1/borrower/applications/${appId}`)
    .set(h1)
    .send({
      personalFinancial: { employmentStatus: "SELF_EMPLOYED", monthlyIncome: "120000", monthlyExpenses: "40000", expectedRepaymentSource: "Business revenue" },
      loanRequest: { amount: 60_000, tenure: 30, purpose: "Updated purpose after rejection feedback" },
    });
  check("PATCH on REJECTED application allowed (200)", patchRes.status === 200, { status: patchRes.status, body: patchRes.body });
  check("patched financials stored in snapshot", patchRes.body?.application?.customerSnapshot?.personalFinancial?.employmentStatus === "SELF_EMPLOYED", patchRes.body?.application?.customerSnapshot?.personalFinancial);
  check("patched loanRequest updates amountNaira", patchRes.body?.application?.amountNaira === 60_000, patchRes.body?.application?.amountNaira);

  // --- resubmission resets the review pipeline ---
  const resubmitRes = await request(app)
    .post(`/api/v1/borrower/applications/${appId}/submit`)
    .set(h1)
    .send({});
  check("resubmission accepted (200)", resubmitRes.status === 200, { status: resubmitRes.status, body: resubmitRes.body });
  check("resubmission flag returned", resubmitRes.body?.resubmitted === true, resubmitRes.body?.resubmitted);
  check("status back to SUBMITTED", resubmitRes.body?.application?.status === "SUBMITTED", resubmitRes.body?.application?.status);
  check("manualDecision reset to PENDING", resubmitRes.body?.application?.manualDecision === "PENDING", resubmitRes.body?.application?.manualDecision);
  check("rejection note cleared", !String(resubmitRes.body?.application?.manualNote ?? "").trim(), resubmitRes.body?.application?.manualNote);
  check("stage rejection notes cleared", Object.keys(resubmitRes.body?.application?.stageRejectionNotes ?? {}).length === 0, resubmitRes.body?.application?.stageRejectionNotes);
  check("credit review stage back to PENDING_REVIEW", resubmitRes.body?.application?.stageStatuses?.credit_review === "PENDING_REVIEW", resubmitRes.body?.application?.stageStatuses);
  check("profile stage marked COMPLETED on resubmission", resubmitRes.body?.application?.stageStatuses?.profile === "COMPLETED", resubmitRes.body?.application?.stageStatuses);
  check("submittedAt refreshed", typeof resubmitRes.body?.application?.submittedAt === "string", resubmitRes.body?.application?.submittedAt);

  // --- once resubmitted, editing is locked again ---
  const patchLockedRes = await request(app)
    .patch(`/api/v1/borrower/applications/${appId}`)
    .set(h1)
    .send({ personalInfo: { fullName: "Should Not Apply" } });
  check("PATCH blocked after resubmission (409)", patchLockedRes.status === 409, { status: patchLockedRes.status, body: patchLockedRes.body });

  // --- non-rejected applications stay protected ---
  const created2 = await request(app)
    .post("/api/v1/borrower/applications")
    .set(h2)
    .send(validPayload("Reject Smoke Two", "Smoke test under-review protection"));
  check("second application created (201)", created2.status === 201, { status: created2.status, body: created2.body });
  const appId2: string = created2.body?.application?.id;
  const patchUnderReviewRes = await request(app)
    .patch(`/api/v1/borrower/applications/${appId2}`)
    .set(h2)
    .send({ personalInfo: { fullName: "Nope" } });
  check("PATCH on UNDER_REVIEW still blocked (409)", patchUnderReviewRes.status === 409, { status: patchUnderReviewRes.status, body: patchUnderReviewRes.body });

  // ==========================================================================
  // B. disbursement-account visibility fallback
  // ==========================================================================
  // b1 has a submitted application carrying the account but NO saved account.
  const b1Saved = disbursementAccounts.filter((a: any) => a.borrowerId === b1);
  check("b1 has no saved disbursement account", b1Saved.length === 0, b1Saved.length);
  const fallbackRes = await request(app).get("/api/v1/borrower/disbursement-account").set(h1);
  check("fallback GET reachable (200)", fallbackRes.status === 200, { status: fallbackRes.status, body: fallbackRes.body });
  check("fallback returns the application-submitted account", fallbackRes.body?.account?.accountNumber === "0123456789", fallbackRes.body?.account);
  check("fallback accountSource is 'application'", fallbackRes.body?.accountSource === "application", fallbackRes.body?.accountSource);
  check("fallback account keeps bankCode 058", fallbackRes.body?.account?.bankCode === "058", fallbackRes.body?.account);
  check("fallback account keeps accountName", fallbackRes.body?.account?.accountName === "REJECT SMOKE ONE", fallbackRes.body?.account);

  // b2: save a standalone account -> saved wins over the application account.
  const b2FallbackBefore = await request(app).get("/api/v1/borrower/disbursement-account").set(h2);
  check("b2 fallback finds application account", b2FallbackBefore.body?.accountSource === "application" && b2FallbackBefore.body?.account?.accountNumber === "0123456789", b2FallbackBefore.body);
  const saveRes = await request(app)
    .post("/api/v1/borrower/disbursement-account")
    .set(h2)
    .send({ accountName: "REJECT SMOKE TWO", accountNumber: "0987654321", bankCode: "044", bankName: "Access Bank" });
  check("b2 saves standalone account (200)", saveRes.status === 200, { status: saveRes.status, body: saveRes.body });
  const b2AfterSave = await request(app).get("/api/v1/borrower/disbursement-account").set(h2);
  check("saved account wins after save", b2AfterSave.body?.accountSource === "saved" && b2AfterSave.body?.account?.accountNumber === "0987654321", b2AfterSave.body);
  check("b2 application was NOT re-stamped (already had account)", created2.body?.application?.disbursementAccount?.accountNumber === "0123456789", created2.body?.application?.disbursementAccount);

  // b3: legacy row with the account ONLY inside customerSnapshot.
  const legacy = {
    id: `smoke-reject-legacy-${ts}`,
    applicationId: `smoke-reject-legacy-app-${ts}`,
    borrowerId: b3,
    applicantType: "PERSONAL",
    customerSnapshot: {
      fullName: "Reject Smoke Three",
      disbursementAccount: { accountName: "REJECT SMOKE THREE", accountNumber: "0111111111", bankCode: "011", bankName: "First Bank" },
    },
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
  loanApplications.push(legacy);
  const b3Res = await request(app).get("/api/v1/borrower/disbursement-account").set(h3);
  check("legacy snapshot-only account discovered", b3Res.body?.account?.accountNumber === "0111111111" && b3Res.body?.accountSource === "application", b3Res.body);
  check("legacy account keeps snapshot bankCode", b3Res.body?.account?.bankCode === "011", b3Res.body?.account);
  const legacyIdx = loanApplications.findIndex((a: any) => a.id === legacy.id);
  if (legacyIdx >= 0) loanApplications.splice(legacyIdx, 1);

  // --- cleanup ---
  cleanupBorrower(b1);
  cleanupBorrower(b2);
  cleanupBorrower(b3);

  console.log(failures === 0 ? "\n[smoke] ALL CHECKS PASSED" : `\n[smoke] ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke] crashed:", err);
  process.exit(1);
});
