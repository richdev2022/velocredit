// ============================================================================
// scripts/e2eStaleDraftTest.ts
// In-process end-to-end test for the stale-draft / application-ID lifecycle:
//
//   1. GET /borrower/application-draft PURGES drafts whose application is
//      terminal (REPAID) and answers draft:null  (self-heal)
//   2. POST /borrower/applications with a terminal application's ID issues a
//      FRESH application ID (never inherits the repaid one)
//   3. In-flight drafts (UNDER_REVIEW application) are NOT purged
//   4. Non-terminal duplicate submit still returns duplicate:true (same ID)
//   5. Clean submit (no existing application) keeps the client's ID
// ============================================================================

process.env.NODE_ENV = "development";
process.env.API_PORT = "4398";
process.env.API_HOST = "127.0.0.1";
process.env.API_PUBLIC_URL = "http://127.0.0.1:4398";
delete process.env.DATABASE_URL;

import { randomUUID } from "node:crypto";

const BASE = "http://127.0.0.1:4398";
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function report(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  await import("../backend/server/index.js");
  const store = await import("../backend/server/store.js");
  const auth = await import("../backend/server/auth.js");

  const deadline = Date.now() + 30_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) { up = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!up) throw new Error("API did not start within 30s");
  console.log("API is up. Seeding data…\n");

  const now = new Date().toISOString();
  let pass = 0;

  function seedBorrower(email: string, phone: string) {
    const user = {
      id: randomUUID(),
      email,
      phone,
      fullName: "Test Borrower",
      passwordHash: "x",
      roles: ["BORROWER"],
      kycStatus: "VERIFIED",
      createdAt: now,
      isActive: true,
    } as never;
    store.users.push(user);
    return user as unknown as { id: string; email: string; fullName: string };
  }

  function seedApplication(borrowerId: string, applicationId: string, status: string) {
    const application = {
      id: randomUUID(),
      applicationId,
      borrowerId,
      applicantType: "PERSONAL",
      customerSnapshot: { fullName: "Test Borrower" },
      amountNaira: 150000,
      tenureDays: 30,
      status,
      stageStatuses: {},
      stageRejectionNotes: {},
      manualDecision: status === "REPAID" ? "APPROVED" : "PENDING",
      createdAt: now,
      updatedAt: now,
      submittedAt: now,
    } as never;
    store.loanApplications.push(application);
    return application as unknown as { id: string; applicationId: string; status: string };
  }

  function seedDraft(userId: string, applicationId: string) {
    const draft = {
      id: randomUUID(),
      userId,
      applicationId,
      applicantType: "PERSONAL",
      data: { personalInfo: { fullName: "Test Borrower" } },
      lastSectionIndex: 2,
      createdAt: now,
      updatedAt: now,
    } as never;
    store.applicationDrafts.push(draft);
    return draft as unknown as { id: string; applicationId: string };
  }

  function completeKyc(userId: string) {
    const kyc = store.findOrCreateKycCase(userId) as { checklist: Record<string, boolean>; status: string };
    kyc.checklist.bvn = true;
    kyc.checklist.nin = true;
    kyc.checklist.liveness = true;
  }

  // ---- Scenario A: terminal (REPAID) application + stale draft ------------
  const borrowerA = seedBorrower("stale-draft-a@example.com", "+2348022222201");
  seedApplication(borrowerA.id, `APP-OLD-${randomUUID().slice(0, 8)}`, "REPAID");
  const oldApp = (store.loanApplications[store.loanApplications.length - 1] as unknown as { applicationId: string });
  const OLD_ID = oldApp.applicationId;
  seedDraft(borrowerA.id, OLD_ID);
  completeKyc(borrowerA.id);
  const tokenA = auth.issueToken(borrowerA as never);

  // 1 — GET draft purges the stale draft and answers null
  const getRes = await fetch(`${BASE}/api/v1/borrower/application-draft`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  const getBody = await getRes.json() as { ok: boolean; draft: unknown };
  const purged = !store.applicationDrafts.some((d) => (d as { applicationId: string }).applicationId === OLD_ID);
  report(
    "GET draft: stale REPAID draft purged + draft:null",
    getRes.status === 200 && getBody.ok === true && getBody.draft === null && purged,
    `status=${getRes.status} draft=${JSON.stringify(getBody.draft)} purgedFromStore=${purged}`,
  );
  if (getRes.status === 200 && getBody.draft === null && purged) pass += 1;

  // 2 — Resubmitting with the terminal application's ID yields a FRESH ID
  const submitPayload = {
    applicationId: OLD_ID,
    applicantType: "PERSONAL",
    personalInfo: { fullName: "Test Borrower", email: "stale-draft-a@example.com", phone: "+2348022222201" },
    disbursementAccount: { accountName: "Test Borrower", accountNumber: "0123456789", bankCode: "058", bankName: "GTBank" },
    loanRequest: { amount: 150000, tenure: 30, purpose: "Business restock" },
  };
  const postRes = await fetch(`${BASE}/api/v1/borrower/applications`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify(submitPayload),
  });
  const postBody = await postRes.json() as { ok: boolean; application?: { applicationId: string; id: string }; error?: string };
  const newAppId = postBody.application?.applicationId ?? "";
  const freshId = Boolean(newAppId) && newAppId !== OLD_ID;
  const oldUntouched = (store.loanApplications.find((a) => (a as { applicationId: string }).applicationId === OLD_ID) as unknown as { status: string })?.status === "REPAID";
  report(
    "POST applications: terminal ID -> FRESH application ID",
    postRes.status === 201 && postBody.ok === true && freshId && oldUntouched,
    `status=${postRes.status} newId=${newAppId || postBody.error} oldIdKept=${OLD_ID} oldStillRepaid=${oldUntouched}`,
  );
  if (postRes.status === 201 && postBody.ok === true && freshId && oldUntouched) pass += 1;

  // ---- Scenario B: in-flight (UNDER_REVIEW) application -------------------
  const borrowerB = seedBorrower("stale-draft-b@example.com", "+2348022222202");
  seedApplication(borrowerB.id, `APP-LIVE-${randomUUID().slice(0, 8)}`, "UNDER_REVIEW");
  const liveApp = (store.loanApplications[store.loanApplications.length - 1] as unknown as { applicationId: string });
  const LIVE_ID = liveApp.applicationId;
  seedDraft(borrowerB.id, LIVE_ID);
  completeKyc(borrowerB.id);
  const tokenB = auth.issueToken(borrowerB as never);

  // 3 — In-flight draft is returned untouched
  const getResB = await fetch(`${BASE}/api/v1/borrower/application-draft`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  const getBodyB = await getResB.json() as { ok: boolean; draft: { applicationId: string } | null };
  report(
    "GET draft: in-flight UNDER_REVIEW draft preserved",
    getResB.status === 200 && getBodyB.draft?.applicationId === LIVE_ID,
    `status=${getResB.status} draftId=${getBodyB.draft?.applicationId}`,
  );
  if (getResB.status === 200 && getBodyB.draft?.applicationId === LIVE_ID) pass += 1;

  // 4 — Non-terminal duplicate submit still returns duplicate:true (same ID)
  const postResB = await fetch(`${BASE}/api/v1/borrower/applications`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` },
    body: JSON.stringify({ ...submitPayload, applicationId: LIVE_ID, personalInfo: { fullName: "Test Borrower B" } }),
  });
  const postBodyB = await postResB.json() as { ok: boolean; duplicate?: boolean; application?: { applicationId: string } };
  report(
    "POST applications: in-flight ID -> duplicate:true, same ID",
    postResB.status === 200 && postBodyB.duplicate === true && postBodyB.application?.applicationId === LIVE_ID,
    `status=${postResB.status} duplicate=${postBodyB.duplicate} id=${postBodyB.application?.applicationId}`,
  );
  if (postResB.status === 200 && postBodyB.duplicate === true && postBodyB.application?.applicationId === LIVE_ID) pass += 1;

  // ---- Scenario C: clean start keeps the client's fresh ID ----------------
  const borrowerC = seedBorrower("stale-draft-c@example.com", "+2348022222203");
  completeKyc(borrowerC.id);
  const tokenC = auth.issueToken(borrowerC as never);
  const CLEAN_ID = `APP-CLEAN-${randomUUID().slice(0, 8)}`;
  const postResC = await fetch(`${BASE}/api/v1/borrower/applications`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenC}` },
    body: JSON.stringify({ ...submitPayload, applicationId: CLEAN_ID, personalInfo: { fullName: "Test Borrower C" } }),
  });
  const postBodyC = await postResC.json() as { ok: boolean; application?: { applicationId: string } };
  report(
    "POST applications: clean start keeps client application ID",
    postResC.status === 201 && postBodyC.application?.applicationId === CLEAN_ID,
    `status=${postResC.status} id=${postBodyC.application?.applicationId}`,
  );
  if (postResC.status === 201 && postBodyC.application?.applicationId === CLEAN_ID) pass += 1;

  console.log(`\n${pass}/${results.length} checks passed`);
  if (pass !== results.length) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => {
  console.error("e2eStaleDraftTest crashed:", error);
  process.exit(1);
});
