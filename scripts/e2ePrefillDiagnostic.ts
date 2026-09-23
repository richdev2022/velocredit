// ============================================================================
// scripts/e2ePrefillDiagnostic.ts
// Diagnoses the reapply auto-prefill data path end to end:
//   1. Seeds a borrower whose FIRST loan went all the way to REPAID, with a
//      full customerSnapshot (personal/business/kyc/financial/collateral/…).
//   2. Calls GET /borrower/dashboard and extracts EXACTLY what the frontend
//      prefillFromPrevious() extracts.
//   3. Reports which fields would prefill and which would stay empty.
//   4. Also exercises the Fix & Resubmit path (REJECTED application hydration)
//      and the draft endpoint self-heal.
// ============================================================================

process.env.NODE_ENV = "development";
process.env.API_PORT = "4401";
process.env.API_HOST = "127.0.0.1";
process.env.API_PUBLIC_URL = "http://127.0.0.1:4401";
delete process.env.DATABASE_URL;

import { randomUUID } from "node:crypto";

const BASE = "http://127.0.0.1:4401";
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function report(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const now = new Date().toISOString();

const FULL_SNAPSHOT = {
  personalInfo: {
    fullName: "Ada Obi",
    phone: "08012345678",
    email: "ada.obi@example.com",
    dateOfBirth: "1992-04-17",
    residentialAddress: "12 Marina Road, Lagos Island",
    state: "Lagos",
    lga: "Lagos Island",
  },
  disbursementAccount: {
    accountName: "ADA OBI",
    bankName: "Guaranty Trust Bank",
    bankCode: "058",
    accountNumber: "0123456789",
  },
  personalFinancial: {
    employmentStatus: "Self-employed",
    employerBusinessName: "Ada Fabrics",
    monthlyIncome: "350000",
    monthlyExpenses: "120000",
    existingLoanObligations: "None",
    expectedRepaymentSource: "Business revenue",
  },
  businessInfo: {
    businessName: "Ada Fabrics Ventures",
    businessRegistrationNumber: "1234567",
    businessType: "Sole Proprietorship",
    businessAddress: "18 Balogun Market, Lagos",
    businessIndustry: "Retail",
    yearsInBusiness: "6",
  },
  businessRep: {
    fullName: "Ada Obi",
    dateOfBirth: "1992-04-17",
    position: "Owner",
    phone: "08012345678",
    email: "ada.obi@example.com",
    residentialAddress: "12 Marina Road, Lagos Island",
  },
  businessFinancial: {
    averageMonthlyRevenue: "900000",
    averageMonthlyExpenses: "420000",
    existingLoanObligations: "None",
    expectedRepaymentSource: "Daily market sales",
  },
  kyc: {
    bvn: "22212345678",
    nin: "12345678901",
    identificationType: "National ID Card",
    identificationNumber: "12345678901",
    bvnVerified: true,
    ninVerified: true,
    livenessVerified: true,
  },
  loanRequest: { amount: 250000, tenure: 90, purpose: "Restock inventory" },
  collateral: {
    provided: true,
    type: "Inventory",
    description: "Fabric stock",
    estimatedValue: "600000",
    ownership: "Owned",
    location: "Shop 18 Balogun",
    documentReference: "docs/inv.pdf",
  },
  witness: { fullName: "Ngozi Eze", phone: "08087654321" },
  documents: {},
};

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
  console.log("API is up. Seeding…\n");

  // ---- Seed borrower + REPAID application #1 with FULL snapshot ----
  const userId = randomUUID();
  (store.users as unknown as Array<Record<string, unknown>>).push({
    id: userId, email: "prefill@example.com", phone: "08012345678",
    fullName: "Ada Obi", passwordHash: "x", roles: ["BORROWER"],
    kycStatus: "VERIFIED", createdAt: now, isActive: true,
  });
  const app1Id = randomUUID();
  (store.loanApplications as unknown as Array<Record<string, unknown>>).push({
    id: app1Id,
    applicationId: "VEL-LN-2026-000901",
    borrowerId: userId,
    applicantType: "BUSINESS",
    customerSnapshot: FULL_SNAPSHOT,
    amountNaira: 250000,
    tenureDays: 90,
    status: "REPAID",
    stageStatuses: {},
    stageRejectionNotes: {},
    manualDecision: "APPROVED",
    createdAt: now, updatedAt: now, submittedAt: now,
  });

  // ---- Token (issued directly via auth module — seeded hash is not a real password) ----
  const token = auth.issueToken({
    id: userId, email: "prefill@example.com", fullName: "Ada Obi",
    roles: ["BORROWER"], kycStatus: "VERIFIED",
  } as never);
  report("token issued", Boolean(token), token ? "ok" : "no token");
  if (!token) throw new Error("no token");

  // ---- Dashboard: what prefillFromPrevious reads ----
  const dashRes = await fetch(`${BASE}/api/v1/borrower/dashboard`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const dash = (await dashRes.json()) as { applications?: Array<Record<string, unknown>> };
  const apps = Array.isArray(dash.applications) ? dash.applications : [];
  report("dashboard.applications present", apps.length === 1, `${apps.length} application(s)`);

  const relevantStatuses = ["SUBMITTED", "KYC_PENDING", "UNDER_REVIEW", "MORE_INFORMATION_REQUIRED", "APPROVED", "DISBURSED", "ACTIVE", "PAST_DUE", "DEFAULTED", "REPAID", "REJECTED"];
  const previous = apps
    .filter((app) => relevantStatuses.includes(String(app.status ?? "")))
    .sort((a, b) => String(b.submittedAt ?? b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.submittedAt ?? a.updatedAt ?? a.createdAt ?? "")))[0];
  report("previous application found with status REPAID", Boolean(previous), previous ? String(previous.status) : "none");

  const snapshot = ((previous?.customerSnapshot ?? {}) as Record<string, Record<string, unknown>>);
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : NaN);

  // Simulate fillStrings for EVERY section field list used by prefillFromPrevious
  const filled = (incoming: Record<string, unknown> | undefined, fields: string[]): string[] =>
    fields.filter((f) => str(incoming?.[f]));

  const piFilled = filled(snapshot.personalInfo, ["fullName", "phone", "email", "dateOfBirth", "residentialAddress", "state", "lga"]);
  report("personalInfo prefill coverage 7/7", piFilled.length === 7, piFilled.join(", "));

  const disbFilled = filled(snapshot.disbursementAccount, ["accountName", "bankName", "bankCode", "accountNumber"]);
  report("disbursementAccount prefill coverage 4/4", disbFilled.length === 4, disbFilled.join(", "));

  const pfFilled = filled(snapshot.personalFinancial, ["employmentStatus", "employerBusinessName", "monthlyIncome", "monthlyExpenses", "existingLoanObligations", "expectedRepaymentSource"]);
  report("personalFinancial prefill coverage 6/6", pfFilled.length === 6, pfFilled.join(", "));

  const biFilled = filled(snapshot.businessInfo, ["businessName", "businessRegistrationNumber", "businessType", "businessAddress", "businessIndustry", "yearsInBusiness"]);
  report("businessInfo prefill coverage 6/6", biFilled.length === 6, biFilled.join(", "));

  const brFilled = filled(snapshot.businessRep, ["fullName", "dateOfBirth", "position", "phone", "email", "residentialAddress"]);
  report("businessRep prefill coverage 6/6", brFilled.length === 6, brFilled.join(", "));

  const bfFilled = filled(snapshot.businessFinancial, ["averageMonthlyRevenue", "averageMonthlyExpenses", "existingLoanObligations", "expectedRepaymentSource"]);
  report("businessFinancial prefill coverage 4/4", bfFilled.length === 4, bfFilled.join(", "));

  const kycFilled = filled(snapshot.kyc, ["bvn", "nin", "identificationType", "identificationNumber"]);
  report("kyc identifiers prefill coverage 4/4", kycFilled.length === 4, kycFilled.join(", "));
  report("kyc verification flags carry over", snapshot.kyc?.bvnVerified === true && snapshot.kyc?.ninVerified === true && snapshot.kyc?.livenessVerified === true, "");

  const colFilled = filled(snapshot.collateral, ["type", "description", "estimatedValue", "ownership", "location", "documentReference"]);
  report("collateral prefill coverage 6/6", colFilled.length === 6, colFilled.join(", "));
  report("collateral.provided carries over", snapshot.collateral?.provided === true, "");

  report("witness prefill", str(snapshot.witness?.fullName) !== "" && str(snapshot.witness?.phone) !== "", `${snapshot.witness?.fullName ?? ""}`);

  const prevLoan = (snapshot.loanRequest ?? {}) as Record<string, unknown>;
  const prevAmount = num(prevLoan.amount);
  const prevTenure = num(prevLoan.tenure);
  report("loanRequest amount restorable", Number.isFinite(prevAmount) && prevAmount > 0, String(prevAmount));
  report("loanRequest tenure restorable", Number.isFinite(prevTenure) && prevTenure > 0, String(prevTenure));
  report("loanRequest purpose restorable", str(prevLoan.purpose) !== "", String(prevLoan.purpose));

  // ---- Fix & Resubmit path: REJECTED application hydration source ----
  const app2Id = randomUUID();
  (store.loanApplications as unknown as Array<Record<string, unknown>>).push({
    id: app2Id,
    applicationId: "VEL-LN-2026-000902",
    borrowerId: userId,
    applicantType: "BUSINESS",
    customerSnapshot: FULL_SNAPSHOT,
    amountNaira: 400000,
    tenureDays: 180,
    status: "REJECTED",
    stageStatuses: {},
    stageRejectionNotes: {},
    manualDecision: "REJECTED",
    manualNote: "Business revenue not verifiable",
    createdAt: now, updatedAt: now, submittedAt: now,
  });
  const dash2 = (await (await fetch(`${BASE}/api/v1/borrower/dashboard`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { applications?: Array<Record<string, unknown>> };
  const rejected = (dash2.applications ?? []).filter((r) => String(r.status ?? "") === "REJECTED")[0];
  report("REJECTED application exposed on dashboard (hydration source)", Boolean(rejected), rejected ? String(rejected.manualNote) : "none");
  report("REJECTED row carries full snapshot for hydration", Boolean((rejected?.customerSnapshot as Record<string, unknown>)?.businessInfo), "");

  // =================== NEW: server-side reapply-prefill endpoint ===================
  // Seed the borrower's verified KYC case + disbursement account: these must
  // enrich the prefill (verified KYC values win; the saved payout account is
  // preferred over the application snapshot).
  (store.kycCases as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(), userId, status: "VERIFIED",
    bvn: "22212345678", nin: "12345678901",
    checklist: { bvn: true, nin: true, proofOfAddress: true, passport: true, signature: true, liveness: true },
    verifiedDetails: { firstName: "Ada", lastName: "Obi" },
    createdAt: now,
  });
  (store.disbursementAccounts as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(), borrowerId: userId, bankCode: "058",
    bankName: "Guaranty Trust Bank", accountNumber: "0123456789",
    accountName: "ADA OBI", status: "ACTIVE", createdAt: now,
  });
  const prefillRes = await fetch(`${BASE}/api/v1/borrower/applications/reapply-prefill`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const prefillJson = (await prefillRes.json()) as {
    ok?: boolean;
    prefill?: Record<string, Record<string, unknown> | null>;
    meta?: { hasPreviousApplication?: boolean; previousApplicationCount?: number; sourceApplicationId?: string | null };
  };
  report("reapply-prefill endpoint 200", prefillRes.ok && prefillJson.ok === true, String(prefillRes.status));
  report("meta.hasPreviousApplication true (2 applications)", prefillJson.meta?.hasPreviousApplication === true && prefillJson.meta?.previousApplicationCount === 2, JSON.stringify(prefillJson.meta ?? {}));

  const sp = prefillJson.prefill ?? {};
  const s = (obj: Record<string, unknown> | null | undefined, key: string): string => (typeof obj?.[key] === "string" ? (obj![key] as string).trim() : "");
  report("prefill.personalInfo complete 7/7", ["fullName", "phone", "email", "dateOfBirth", "residentialAddress", "state", "lga"].every((k) => s(sp.personalInfo, k)), JSON.stringify(sp.personalInfo ?? {}));
  report("prefill.disbursementAccount complete 4/4", ["accountName", "bankName", "bankCode", "accountNumber"].every((k) => s(sp.disbursementAccount, k)), JSON.stringify(sp.disbursementAccount ?? {}));
  report("prefill.personalFinancial complete 6/6", ["employmentStatus", "employerBusinessName", "monthlyIncome", "monthlyExpenses", "existingLoanObligations", "expectedRepaymentSource"].every((k) => s(sp.personalFinancial, k)), "");
  report("prefill.businessInfo complete 6/6", ["businessName", "businessRegistrationNumber", "businessType", "businessAddress", "businessIndustry", "yearsInBusiness"].every((k) => s(sp.businessInfo, k)), "");
  report("prefill.businessRep complete 6/6", ["fullName", "dateOfBirth", "position", "phone", "email", "residentialAddress"].every((k) => s(sp.businessRep, k)), "");
  report("prefill.businessFinancial complete 4/4", ["averageMonthlyRevenue", "averageMonthlyExpenses", "existingLoanObligations", "expectedRepaymentSource"].every((k) => s(sp.businessFinancial, k)), "");
  report("prefill.kyc identifiers + verified flags", s(sp.kyc, "bvn") === "22212345678" && sp.kyc?.bvnVerified === true && sp.kyc?.ninVerified === true && sp.kyc?.livenessVerified === true, JSON.stringify({ bvn: s(sp.kyc, "bvn").slice(0, 4) + "**", verified: sp.kyc?.bvnVerified }));
  report("prefill.kyc verifiedDetails merged", typeof sp.kyc?.verifiedDetails === "object" && (sp.kyc!.verifiedDetails as Record<string, unknown>).firstName === "Ada", "");
  report("prefill.collateral complete 6/6 + provided", ["type", "description", "estimatedValue", "ownership", "location", "documentReference"].every((k) => s(sp.collateral, k)) && sp.collateral?.provided === true, "");
  report("prefill.witness complete", s(sp.witness, "fullName") !== "" && s(sp.witness, "phone") !== "", "");
  report("prefill.loanRequest complete", s(sp.loanRequest, "purpose") !== "" && Number(sp.loanRequest?.amount) === 250000 && Number(sp.loanRequest?.tenure) === 90, JSON.stringify(sp.loanRequest ?? {}));

  // ---- Fallback proof: a borrower with NO application snapshots at all ----
  const bareUser = randomUUID();
  (store.users as unknown as Array<Record<string, unknown>>).push({
    id: bareUser, email: "bare.prefill@example.com", phone: "08122233344",
    fullName: "Bare Profile", passwordHash: "x", roles: ["BORROWER"],
    kycStatus: "PENDING", createdAt: now, isActive: true, dateOfBirth: "1988-11-05",
  });
  (store.kycCases as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(), userId: bareUser, status: "PENDING_VERIFICATION",
    bvn: "22255554444",
    checklist: { bvn: true, nin: false, proofOfAddress: false, passport: false, signature: false, liveness: false },
    createdAt: now,
  });
  const bareToken = auth.issueToken({ id: bareUser, email: "bare.prefill@example.com", fullName: "Bare Profile", roles: ["BORROWER"] } as never);
  const bareRes = await fetch(`${BASE}/api/v1/borrower/applications/reapply-prefill`, {
    headers: { Authorization: `Bearer ${bareToken}` },
  });
  const bareJson = (await bareRes.json()) as { ok?: boolean; prefill?: Record<string, Record<string, unknown> | null>; meta?: { hasPreviousApplication?: boolean } };
  report("no previous application → hasPreviousApplication false", bareRes.ok && bareJson.meta?.hasPreviousApplication === false, "");
  report("profile+KYC fallback still fills personalInfo", s(bareJson.prefill?.personalInfo, "fullName") === "Bare Profile" && s(bareJson.prefill?.personalInfo, "dateOfBirth") === "1988-11-05", JSON.stringify(bareJson.prefill?.personalInfo ?? {}));
  report("verified BVN carries into kyc fallback", s(bareJson.prefill?.kyc, "bvn") === "22255554444", "");

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
