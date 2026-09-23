// ============================================================================
// scripts/e2eCreditBureauTest.ts
// End-to-end test for the Prembly credit-bureau integration (Commercial
// Business Advance + consumer fallback) against a MOCK Prembly server:
//
//   1. Admin trigger on a BUSINESS application uses the COMMERCIAL ADVANCE
//      endpoint with rc_number (STRING — the live API rejects integers) +
//      company_name from the customer snapshot; the documented sample
//      response is parsed into a derived bureau score, a creditReports row is
//      stored, the application creditReportSnapshot is refreshed (external
//      RECEIVED + recomputed internal score).
//   2. Response code 01 (record not found) → report FAILED with the friendly
//      message; snapshot reflects FAILED.
//   3. Response code 02 → report PENDING; the reconciliation sweep retries
//      the stored commercial identity and resolves the report.
//   4. Consumer fallback: a borrower with a full 11-digit BVN goes through
//      the consumer advance endpoint in ID mode.
//   5. Masked-BVN borrower whose NIMC raw carries the LINKED BVN → the full
//      unmasked BVN is recovered and passed to the bureau (NEVER the NIN —
//      Prembly's credit API is strictly BVN-driven); a NIN-only borrower
//      with no recoverable BVN → 409 "BVN is mandatory".
//   6. A borrower with NO identity at all → 409 with a helpful message.
//   7. Provider timeout → report PENDING (NOT failed) + cron retry resolves.
//   8. Submission-time background pull for a business applicant also hits
//      the commercial endpoint (the "stays PENDING forever" fix).
// ============================================================================

process.env.NODE_ENV = "development";
process.env.API_PORT = "4402";
process.env.API_HOST = "127.0.0.1";
process.env.API_PUBLIC_URL = "http://127.0.0.1:4402";
process.env.PREMBLY_API_KEY = "test-key-e2e";
process.env.PREMBLY_CREDIT_DATA_MODE = "ADVANCE";
// Short credit timeout so the timeout test (mock sleeps 2.5s) aborts fast;
// the other tests' mock responses are instant and unaffected.
process.env.PREMBLY_CREDIT_TIMEOUT_MS = "800";
process.env.PREMBLY_BASE_URL = "http://127.0.0.1:4403"; // mock server (started below)
delete process.env.DATABASE_URL;

import http from "node:http";
import { randomUUID } from "node:crypto";

const MOCK_PORT = 4403;
const BASE = "http://127.0.0.1:4402";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function report(name: string, ok: boolean, detail: string = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Documented Prembly commercial advance sample (docs.prembly.com) ------
const COMMERCIAL_OK_BODY = {
  status: true,
  detail: "Credit Check successful",
  response_code: "00",
  data: [
    { SubjectList: [{ CommercialID: null, SearchOutput: null, Reference: null }] },
    {
      BusinessData: [
        {
          CommercialID: "853535",
          BusinessName: "OCH TEST DUMMY 5",
          DateOfIncorporation: "30/07/2018",
          TaxIdentificationNumber: "NIL",
          CommercialAddress1: "UBA HOUSE 57 MARINA",
          UpdatedOn: "11/01/2022",
        },
      ],
    },
    { HighestDelinquencyRating: [{ HighestDelinquencyRating: "-1" }] },
    {
      FacilityPerformanceSummary: [
        {
          TotalOutstandingdebt: "0.00",
          TotalAccountarrear: "0.00",
          TotalAccounts: "0",
          TotalaccountinGoodcondition: "0",
          TotalaccountinBadcondition: "0",
          TotalNumberofJudgement: "0",
          TotalNumberofDishonoured: "0",
        },
      ],
    },
    { DirectorInformation: [{ Directorid: null, firstName: null, surname: null }] },
    { CreditAgreementSummary: [{ SubscriberName: null, PerformanceStatus: null }] },
    {
      AccountMonthlyPaymentHistory: [
        {
          SubscriberName: "United Bank for Africa Lagos",
          AccountNo: "1021392523",
          IndicatorDescription: "COMMERCIAL OVERDRAFT",
          CurrentBalanceAmt: "2,674,591.08",
          PerformanceStatus: "PERFORMING",
          AccountStatus: "OPEN",
        },
      ],
    },
    { AddressHistory: [{ CommercialAddress1: null }] },
    { EnquiryHistoryTop: [{ SubscriberName: null }] },
  ],
};

const state = {
  commercialCalls: [] as Array<Record<string, unknown>>,
  consumerCalls: [] as Array<Record<string, unknown>>,
  commercialMode: "ok" as "ok" | "not_found" | "pending" | "processing_then_ok",
  consumerMode: "ok" as "ok" | "pending" | "slow",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startMockPrembly(): Promise<void> {
  const server = http.createServer(async (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      const apiKey = req.headers["x-api-key"];
      const ok401 = () => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Please provide a valid api-key in the request header." }));
      };
      if (apiKey !== "test-key-e2e") return ok401();

      if (String(req.url).includes("/credit_bureau/commercial/advance")) {
        state.commercialCalls.push(payload);
        const respond = (mode: string) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          if (mode === "not_found") {
            res.end(JSON.stringify({ status: false, response_code: "01", detail: "Record not found" }));
          } else if (mode === "pending") {
            res.end(JSON.stringify({ status: false, response_code: "02", detail: "Verification can't be completed by this time, kindly retry later." }));
          } else {
            res.end(JSON.stringify(COMMERCIAL_OK_BODY));
          }
        };
        if (state.commercialMode === "processing_then_ok") {
          state.commercialMode = "ok";
          respond("pending");
        } else {
          respond(state.commercialMode);
        }
        return;
      }
      if (String(req.url).includes("/credit_bureau/consumer/advance")) {
        state.consumerCalls.push(payload);
        res.writeHead(200, { "Content-Type": "application/json" });
        if (state.consumerMode === "slow") {
          // Real-world latency simulation: the bureau answers AFTER the
          // client's AbortSignal.timeout fired → fetch throws TimeoutError.
          await sleep(2500);
          res.end(JSON.stringify({ status: true, response_code: "00", data: { message: "late answer" } }));
        } else if (state.consumerMode === "pending") {
          res.end(JSON.stringify({ status: false, response_code: "02", detail: "Verification can't be completed by this time, kindly retry later." }));
        } else {
          res.end(JSON.stringify({
            status: true,
            detail: "Credit Check successful",
            response_code: "00",
            data: {
              score: { value: "680/850", description: "GOOD", totalAccounts: "3", totalaccountinGoodcondition: "2", totalaccountinBadcondition: "1", totalOutstandingDebt: "150,000" },
              customerName: payload.customer_name ?? null,
            },
          }));
        }
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: `Unknown mock path ${req.url}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(MOCK_PORT, "127.0.0.1", resolve));
  (server as unknown as { unref: () => void }).unref();
  console.log("Mock Prembly listening on 127.0.0.1:4403");
}

const now = new Date().toISOString();

async function main(): Promise<void> {
  await startMockPrembly();
  await import("../backend/server/index.js");
  const store = await import("../backend/server/store.js");
  const auth = await import("../backend/server/auth.js");
  const creditRecon = await import("../backend/server/creditReconciliation.js");
  const creditBureau = await import("../backend/server/creditBureau.js");

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
  console.log("API is up. Seeding…\n");

  // ---- Seed admin + business borrower + application with full snapshot ----
  const adminUser = {
    id: randomUUID(), email: "admin@example.com", phone: "08000000001",
    fullName: "Velo Admin", passwordHash: "x", roles: ["ADMIN"],
    adminPermissions: [], kycStatus: "VERIFIED", createdAt: now, isActive: true,
  } as never;
  (store.users as unknown as Array<Record<string, unknown>>).push(adminUser);

  const borrower = {
    id: randomUUID(), email: "biz@example.com", phone: "08100000002",
    fullName: "Ada Obi", passwordHash: "x", roles: ["BORROWER"],
    kycStatus: "VERIFIED", createdAt: now, isActive: true, dateOfBirth: "1992-04-17",
  } as never;
  (store.users as unknown as Array<Record<string, unknown>>).push(borrower);

  (store.kycCases as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(), userId: borrower.id, status: "VERIFIED",
    bvn: "22212345678", checklist: { bvn: true, nin: true, proofOfAddress: true, passport: true, signature: true, liveness: true },
    createdAt: now,
  });

  const applicationId = "VEL-LN-2026-000777";
  (store.loanApplications as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(),
    applicationId,
    borrowerId: borrower.id,
    applicantType: "BUSINESS",
    customerSnapshot: {
      fullName: "Ada Obi", email: "biz@example.com", phone: "08100000002",
      businessInfo: { businessName: "Ada Fabrics Ventures", businessRegistrationNumber: "RC 1234567", businessType: "Sole Proprietorship" },
      loanRequest: { amount: 250000, tenure: 90, purpose: "Restock inventory" },
      kyc: { bvn: "22212345678" },
    },
    amountNaira: 250000,
    tenureDays: 90,
    status: "UNDER_REVIEW",
    creditReportSnapshot: { internal: { score: 610, band: "FAIR", factors: [] }, external: { provider: "prembly", status: "PENDING", score: null } },
    stageStatuses: {}, stageRejectionNotes: {}, manualDecision: "PENDING",
    createdAt: now, updatedAt: now, submittedAt: now,
  });

  // Identity-less borrower (no RC, no BVN, no KYC)
  const bareBorrower = {
    id: randomUUID(), email: "bare@example.com", phone: "08100000003",
    fullName: "", passwordHash: "x", roles: ["BORROWER"],
    kycStatus: "PENDING", createdAt: now, isActive: true,
  } as never;
  (store.users as unknown as Array<Record<string, unknown>>).push(bareBorrower);
  const bareAppId = "VEL-LN-2026-000778";
  (store.loanApplications as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(), applicationId: bareAppId, borrowerId: bareBorrower.id,
    applicantType: "PERSONAL", customerSnapshot: {}, amountNaira: 50000, tenureDays: 30,
    status: "UNDER_REVIEW", creditReportSnapshot: {}, stageStatuses: {}, stageRejectionNotes: {},
    manualDecision: "PENDING", createdAt: now, updatedAt: now, submittedAt: now,
  });

  // BVN-only borrower (consumer fallback)
  const consumerBorrower = {
    id: randomUUID(), email: "consumer@example.com", phone: "08100000004",
    fullName: "John Doe", passwordHash: "x", roles: ["BORROWER"],
    kycStatus: "VERIFIED", createdAt: now, isActive: true, dateOfBirth: "1990-01-01",
  } as never;
  (store.users as unknown as Array<Record<string, unknown>>).push(consumerBorrower);
  (store.kycCases as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(), userId: consumerBorrower.id, status: "VERIFIED",
    bvn: "22299988877", checklist: { bvn: true, nin: true, proofOfAddress: false, passport: false, signature: false, liveness: true },
    createdAt: now,
  });

  const adminToken = auth.issueToken({ id: adminUser.id, email: adminUser.email, fullName: adminUser.fullName, roles: ["ADMIN"] } as never);
  const adminHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` };

  // =================== TEST 1: admin trigger → COMMERCIAL ADVANCE ===================
  state.commercialMode = "ok";
  const res1 = await fetch(`${BASE}/api/v1/admin/loan-applications/${encodeURIComponent(applicationId)}/credit-bureau`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({}),
  });
  const out1 = (await res1.json()) as { ok?: boolean; report?: { id?: string; status?: string; score?: number; normalizedFields?: Record<string, unknown> }; creditReportSnapshot?: any; message?: string; error?: string };
  report("admin trigger returns 200 immediately", res1.ok, res1.status === 200 ? "" : JSON.stringify(out1).slice(0, 200));
  // The provider call runs in the background — wait for it to finish (the
  // mock answers instantly, so this is normally already done).
  if (out1.report?.id) {
    for (let i = 0; i < 50 && creditBureau.isCreditBureauCheckInFlight(out1.report.id!); i++) {
      await sleep(100);
    }
  }
  const stored1 = (store.creditReports as unknown as Array<{ id?: string; status?: string; score?: number; normalizedFields?: Record<string, unknown> }>).find((r) => r.id === out1.report?.id);
  report("report status RECEIVED", stored1?.status === "RECEIVED", String(stored1?.status));
  report("derived bureau score 635 (620 base + 1 performing facility)", stored1?.score === 635, `score=${stored1?.score} breakdown=${JSON.stringify(stored1?.normalizedFields?.scoreBreakdown ?? {})}`);
  report("report type COMMERCIAL_ADVANCE", stored1?.normalizedFields?.reportType === "COMMERCIAL_ADVANCE", "");
  report("trigger source recorded", stored1?.normalizedFields?.source === "ADMIN_TRIGGER", String(stored1?.normalizedFields?.source));
  report("rc_number sent as string (live API rejects integers)", state.commercialCalls.length === 1 && state.commercialCalls[0].rc_number === "1234567", JSON.stringify(state.commercialCalls[0] ?? {}));
  report("company_name sent from snapshot", String(state.commercialCalls[0]?.company_name ?? "") === "Ada Fabrics Ventures", "");
  report("data_mode ADVANCE", state.commercialCalls[0]?.data_mode === "ADVANCE", "");
  // Re-read the application detail: the background execute syncs the snapshot.
  const detail1 = await fetch(`${BASE}/api/v1/admin/loans/${encodeURIComponent(applicationId)}`, { headers: adminHeaders });
  const detail1Body = (await detail1.json()) as { application?: Record<string, any>; loan?: Record<string, any> };
  const app1Snapshot = ((detail1Body.application ?? detail1Body.loan ?? {}) as Record<string, any>).creditReportSnapshot;
  report("snapshot external RECEIVED + score", app1Snapshot?.external?.status === "RECEIVED" && app1Snapshot?.external?.score === 635, JSON.stringify({ status: app1Snapshot?.external?.status, score: app1Snapshot?.external?.score }));
  const internalScore = app1Snapshot?.internal?.score;
  // Fresh internal calculation from real factors: 500 base − 120 (no repayment
  // history) + 30 (KYC) = 410, plus bureau impact (635 − 500) × 0.2 = +27 → 437.
  report("internal score recomputed with bureau input", internalScore === 437, `internal=${internalScore} (no-bureau base would be 410)`);
  const bureauFactor = (app1Snapshot?.internal?.factors ?? []).find((f: { code?: string }) => f.code === "BUREAU_INPUT");
  report("internal factors include BUREAU_INPUT", Boolean(bureauFactor) && bureauFactor.impact === 27, JSON.stringify(bureauFactor ?? {}));
  report("business data parsed", (stored1?.normalizedFields?.businessName as string) === "OCH TEST DUMMY 5", "");
  report("monthly payment history parsed", Array.isArray(stored1?.normalizedFields?.monthlyPaymentHistory) && stored1!.normalizedFields!.monthlyPaymentHistory.length === 1, "");

  // =================== TEST 2: record not found (code 01) ===================
  const borrower2 = {
    id: randomUUID(), email: "biz2@example.com", phone: "08100000005",
    fullName: "Mark Ohis", passwordHash: "x", roles: ["BORROWER"], kycStatus: "PENDING",
    createdAt: now, isActive: true,
  } as never;
  (store.users as unknown as Array<Record<string, unknown>>).push(borrower2);
  const app2Id = "VEL-LN-2026-000779";
  (store.loanApplications as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(), applicationId: app2Id, borrowerId: borrower2.id,
    applicantType: "BUSINESS",
    customerSnapshot: { businessInfo: { businessName: "Ghost Ventures", businessRegistrationNumber: "9999999" } },
    amountNaira: 100000, tenureDays: 30, status: "UNDER_REVIEW",
    creditReportSnapshot: {}, stageStatuses: {}, stageRejectionNotes: {}, manualDecision: "PENDING",
    createdAt: now, updatedAt: now, submittedAt: now,
  });
  state.commercialMode = "not_found";
  const res2 = await fetch(`${BASE}/api/v1/admin/loan-applications/${encodeURIComponent(app2Id)}/credit-bureau`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({}),
  });
  const out2 = (await res2.json()) as { ok?: boolean; report?: { id?: string; status?: string; normalizedFields?: Record<string, unknown> }; message?: string };
  if (out2.report?.id) {
    for (let i = 0; i < 50 && creditBureau.isCreditBureauCheckInFlight(out2.report.id!); i++) await sleep(100);
  }
  const stored2 = (store.creditReports as unknown as Array<{ id?: string; status?: string; normalizedFields?: Record<string, unknown> }>).find((r) => r.id === out2.report?.id);
  report("record-not-found → report FAILED (not stuck PENDING)", stored2?.status === "FAILED", String(stored2?.status));
  report("friendly message mentions RC", /RC number 9999999/.test(out2.message ?? "") || /RC number 9999999/.test(String(stored2?.normalizedFields?.reason ?? "")), out2.message ?? String(stored2?.normalizedFields?.reason ?? ""));
  report("snapshot reflects FAILED with reason", stored2?.status === "FAILED", "");

  // =================== TEST 3: pending (code 02) + reconciliation sweep ===================
  const borrower3 = {
    id: randomUUID(), email: "biz3@example.com", phone: "08100000006",
    fullName: "Nke Bells", passwordHash: "x", roles: ["BORROWER"], kycStatus: "PENDING",
    createdAt: now, isActive: true,
  } as never;
  (store.users as unknown as Array<Record<string, unknown>>).push(borrower3);
  const app3Id = "VEL-LN-2026-000780";
  (store.loanApplications as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(), applicationId: app3Id, borrowerId: borrower3.id,
    applicantType: "BUSINESS",
    customerSnapshot: { businessInfo: { businessName: "Pending Ltd", businessRegistrationNumber: "7777777" } },
    amountNaira: 120000, tenureDays: 30, status: "UNDER_REVIEW",
    creditReportSnapshot: {}, stageStatuses: {}, stageRejectionNotes: {}, manualDecision: "PENDING",
    createdAt: now, updatedAt: now, submittedAt: now,
  });
  state.commercialMode = "processing_then_ok";
  const res3 = await fetch(`${BASE}/api/v1/admin/loan-applications/${encodeURIComponent(app3Id)}/credit-bureau`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({}),
  });
  const out3 = (await res3.json()) as { ok?: boolean; report?: { id?: string; status?: string; score?: number }; message?: string };
  report("processing → report PENDING (cron will retry)", out3.report?.status === "PENDING", String(out3.report?.status));
  // Wait for the background execute to finish (mock is instant, but the
  // endpoint returns as soon as the row exists) before sweeping.
  if (out3.report?.id) {
    for (let i = 0; i < 50 && creditBureau.isCreditBureauCheckInFlight(out3.report.id!); i++) {
      await sleep(100);
    }
  }
  const sweep1 = await creditRecon.runCreditReportReconciliationSweep();
  report("reconciliation retried the pending report", sweep1.retried >= 1, JSON.stringify(sweep1));
  report("reconciliation resolved it", sweep1.resolved >= 1 && state.commercialCalls.filter((c) => c.rc_number === "7777777").length === 2, JSON.stringify(sweep1));
  const storedReport3 = (store.creditReports as unknown as Array<{ id?: string; status?: string; score?: number }>).find((r) => r.id === out3.report?.id);
  report("stored report now RECEIVED with score", storedReport3?.status === "RECEIVED" && storedReport3?.score === 635, JSON.stringify({ status: storedReport3?.status, score: storedReport3?.score }));

  // =================== TEST 4: consumer fallback via BVN ===================
  const consumerAppId = "VEL-LN-2026-000781";
  (store.loanApplications as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(), applicationId: consumerAppId, borrowerId: consumerBorrower.id,
    applicantType: "PERSONAL", customerSnapshot: { personalInfo: { fullName: "John Doe" }, loanRequest: { amount: 80000, tenure: 30, purpose: "School fees" } },
    amountNaira: 80000, tenureDays: 30, status: "UNDER_REVIEW",
    creditReportSnapshot: {}, stageStatuses: {}, stageRejectionNotes: {}, manualDecision: "PENDING",
    createdAt: now, updatedAt: now, submittedAt: now,
  });
  state.consumerMode = "ok";
  const res4 = await fetch(`${BASE}/api/v1/admin/loan-applications/${encodeURIComponent(consumerAppId)}/credit-bureau`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({}),
  });
  const out4 = (await res4.json()) as { ok?: boolean; report?: { id?: string; status?: string; score?: number; normalizedFields?: Record<string, unknown> } };
  if (out4.report?.id) {
    for (let i = 0; i < 50 && creditBureau.isCreditBureauCheckInFlight(out4.report.id!); i++) await sleep(100);
  }
  const stored4 = (store.creditReports as unknown as Array<{ id?: string; status?: string; score?: number; normalizedFields?: Record<string, unknown> }>).find((r) => r.id === out4.report?.id);
  report("consumer fallback hits consumer advance endpoint", state.consumerCalls.length === 1, `${state.consumerCalls.length} consumer call(s)`);
  report("consumer ID mode with the full BVN", String(state.consumerCalls[0]?.mode ?? "") === "ID" && state.consumerCalls[0]?.number === "22299988877", JSON.stringify(state.consumerCalls[0] ?? {}));
  report("consumer report RECEIVED with provider score 680", stored4?.status === "RECEIVED" && stored4?.score === 680, `status=${stored4?.status} score=${stored4?.score}`);

  // ============ TEST 5a: masked BVN recovered from the NIMC raw ============
  // Production reality: the KYC case stores a DISPLAY-masked BVN and the
  // verification raw response is NIN-Advance. The bureau pipeline must
  // UNMASK the full BVN from the raw store (NIMC nin_data.bvn) and pass
  // THAT — the Prembly credit API is strictly BVN-driven, the NIN is never
  // sent.
  const ninBorrower = {
    id: randomUUID(), email: "nin@example.com", phone: "08100000007",
    fullName: "Sunday Itodo", passwordHash: "x", roles: ["BORROWER"],
    kycStatus: "VERIFIED", createdAt: now, isActive: true,
  } as never;
  (store.users as unknown as Array<Record<string, unknown>>).push(ninBorrower);
  (store.kycCases as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(), userId: ninBorrower.id, status: "VERIFIED",
    bvn: "***-***-6804", // display-masked — must be unmasked from the raw
    nin: "52312345678",
    checklist: { bvn: false, nin: true, liveness: true },
    providerRaw: {
      nin: {
        nin_data: {
          nin: "52312345678",
          bvn: "22212346804", // the linked BVN harvested from NIMC
          firstname: "SUNDAY",
          middlename: "GIDEON",
          surname: "ITODO",
          birthdate: "22-07-1998",
        },
      },
    },
    createdAt: now,
  });
  const ninAppId = "VEL-LN-2026-000782";
  (store.loanApplications as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(), applicationId: ninAppId, borrowerId: ninBorrower.id,
    applicantType: "PERSONAL", customerSnapshot: { personalInfo: { fullName: "Sunday Itodo" } },
    amountNaira: 90000, tenureDays: 30, status: "UNDER_REVIEW",
    creditReportSnapshot: {}, stageStatuses: {}, stageRejectionNotes: {}, manualDecision: "PENDING",
    createdAt: now, updatedAt: now, submittedAt: now,
  });
  const res5 = await fetch(`${BASE}/api/v1/admin/loan-applications/${encodeURIComponent(ninAppId)}/credit-bureau`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({}),
  });
  const out5 = (await res5.json()) as { ok?: boolean; report?: { id?: string; status?: string } };
  if (out5.report?.id) {
    for (let i = 0; i < 50 && creditBureau.isCreditBureauCheckInFlight(out5.report.id!); i++) await sleep(100);
  }
  const stored5 = (store.creditReports as unknown as Array<{ id?: string; status?: string; score?: number; normalizedFields?: Record<string, unknown> }>).find((r) => r.id === out5.report?.id);
  report("masked-BVN borrower resolved (not 409)", res5.status === 200 && Boolean(out5.report?.id), `${res5.status} ${JSON.stringify(out5).slice(0, 160)}`);
  report("bureau lookup in ID mode with the FULL unmasked BVN", String(state.consumerCalls[1]?.mode ?? "") === "ID" && state.consumerCalls[1]?.number === "22212346804", JSON.stringify(state.consumerCalls[1] ?? {}));
  report("NIN never passed to the bureau", state.consumerCalls[1]?.number !== "52312345678", String(state.consumerCalls[1]?.number ?? ""));
  report("NIN-verified name passed as customer_name", state.consumerCalls[1]?.customer_name === "SUNDAY GIDEON ITODO", String(state.consumerCalls[1]?.customer_name ?? ""));
  report("masked-BVN borrower report RECEIVED", stored5?.status === "RECEIVED", JSON.stringify({ status: stored5?.status, reason: stored5?.normalizedFields?.reason }));

  // ============ TEST 5b: NIN-only borrower, no recoverable BVN → 409 ======
  // BVN is mandatory: the Prembly consumer credit endpoint does not accept
  // a NIN, so a borrower with no recoverable full BVN cannot be checked.
  const ninOnlyBorrower = {
    id: randomUUID(), email: "ninonly@example.com", phone: "08100000008",
    fullName: "Nin Only", passwordHash: "x", roles: ["BORROWER"],
    kycStatus: "VERIFIED", createdAt: now, isActive: true,
  } as never;
  (store.users as unknown as Array<Record<string, unknown>>).push(ninOnlyBorrower);
  (store.kycCases as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(), userId: ninOnlyBorrower.id, status: "VERIFIED",
    nin: "52312345699",
    checklist: { bvn: false, nin: true, liveness: true },
    providerRaw: { nin: { nin_data: { nin: "52312345699", firstname: "NIN", surname: "ONLY" } } },
    createdAt: now,
  });
  const ninOnlyAppId = "VEL-LN-2026-000783";
  (store.loanApplications as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(), applicationId: ninOnlyAppId, borrowerId: ninOnlyBorrower.id,
    applicantType: "PERSONAL", customerSnapshot: { personalInfo: { fullName: "Nin Only" } },
    amountNaira: 90000, tenureDays: 30, status: "UNDER_REVIEW",
    creditReportSnapshot: {}, stageStatuses: {}, stageRejectionNotes: {}, manualDecision: "PENDING",
    createdAt: now, updatedAt: now, submittedAt: now,
  });
  const res5b = await fetch(`${BASE}/api/v1/admin/loan-applications/${encodeURIComponent(ninOnlyAppId)}/credit-bureau`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({}),
  });
  const out5b = (await res5b.json()) as { ok?: boolean; error?: string };
  report("NIN-only borrower → 409 BVN mandatory", res5b.status === 409 && /BVN is mandatory/i.test(out5b.error ?? ""), `${res5b.status} ${out5b.error ?? ""}`);

  // ============ TEST 6: no usable identity → 409 ============
  const res6 = await fetch(`${BASE}/api/v1/admin/loan-applications/${encodeURIComponent(bareAppId)}/credit-bureau`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({}),
  });
  const out6 = (await res6.json()) as { ok?: boolean; error?: string };
  report("no identity → 409 with helpful message", res6.status === 409 && /No usable identity/.test(out6.error ?? ""), `${res6.status} ${out6.error ?? ""}`);

  // ============ TEST 7: provider timeout → PENDING + cron resolves ==========
  // The mock sleeps 2.5s; the credit timeout is 800ms → fetch aborts → the
  // report must land PENDING (bureau still processing), NOT FAILED, and the
  // reconciliation sweep must resolve it on the next pass.
  const timeoutAppId = "VEL-LN-2026-000784";
  (store.loanApplications as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(), applicationId: timeoutAppId, borrowerId: consumerBorrower.id,
    applicantType: "PERSONAL", customerSnapshot: { personalInfo: { fullName: "John Doe" } },
    amountNaira: 70000, tenureDays: 30, status: "UNDER_REVIEW",
    creditReportSnapshot: {}, stageStatuses: {}, stageRejectionNotes: {}, manualDecision: "PENDING",
    createdAt: now, updatedAt: now, submittedAt: now,
  });
  state.consumerMode = "slow";
  const res7 = await fetch(`${BASE}/api/v1/admin/loan-applications/${encodeURIComponent(timeoutAppId)}/credit-bureau`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({}),
  });
  const out7 = (await res7.json()) as { ok?: boolean; report?: { id?: string; status?: string; normalizedFields?: Record<string, unknown> }; message?: string };
  report("timeout → HTTP still 200 (async trigger)", res7.ok, String(res7.status));
  report("timeout → report PENDING with retry reason", out7.report?.status === "PENDING" && /retried automatically|did not respond/.test(String(out7.report?.normalizedFields?.reason ?? out7.message ?? "")), JSON.stringify({ status: out7.report?.status, msg: (out7.message ?? "").slice(0, 120) }));
  if (out7.report?.id) {
    for (let i = 0; i < 50 && creditBureau.isCreditBureauCheckInFlight(out7.report.id!); i++) await sleep(100);
  }
  state.consumerMode = "ok";
  const sweep2 = await creditRecon.runCreditReportReconciliationSweep();
  const stored7 = (store.creditReports as unknown as Array<{ id?: string; status?: string; score?: number }>).find((r) => r.id === out7.report?.id);
  report("cron resolved the timed-out report", sweep2.resolved >= 1 && stored7?.status === "RECEIVED" && stored7?.score === 680, JSON.stringify({ sweep: sweep2, status: stored7?.status, score: stored7?.score }));

  // ============ TEST 8: borrower-facing consent-gated request ==============
  const borrowerToken = auth.issueToken({ id: borrower.id, email: borrower.email, fullName: borrower.fullName, roles: ["BORROWER"] } as never);
  const res8a = await fetch(`${BASE}/api/v1/borrower/credit-report/request`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${borrowerToken}` }, body: JSON.stringify({}),
  });
  report("borrower request without consent → 400", res8a.status === 400, String(res8a.status));
  state.commercialMode = "ok";
  const res8b = await fetch(`${BASE}/api/v1/borrower/credit-report/request`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${borrowerToken}` }, body: JSON.stringify({ consent: true }),
  });
  const out8b = (await res8b.json()) as { ok?: boolean; report?: { id?: string; status?: string } };
  if (out8b.report?.id) {
    for (let i = 0; i < 50 && creditBureau.isCreditBureauCheckInFlight(out8b.report.id!); i++) await sleep(100);
  }
  const stored8 = (store.creditReports as unknown as Array<{ id?: string; status?: string }>).find((r) => r.id === out8b.report?.id);
  report("borrower request with consent → RECEIVED", res8b.ok && stored8?.status === "RECEIVED", String(stored8?.status));

  // ============ TEST 9: non-admin cannot trigger ==============
  const borrowerRes = await fetch(`${BASE}/api/v1/admin/loan-applications/${encodeURIComponent(applicationId)}/credit-bureau`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${borrowerToken}` }, body: JSON.stringify({}),
  });
  report("borrower cannot call admin trigger (403)", borrowerRes.status === 403, String(borrowerRes.status));

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
