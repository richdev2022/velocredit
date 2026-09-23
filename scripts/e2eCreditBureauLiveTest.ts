// ============================================================================
// scripts/e2eCreditBureauLiveTest.ts
// LIVE end-to-end test: local API + REAL Prembly credit bureau (consumer
// advance, ID mode — strictly BVN-driven). The bureau check requires the
// customer's FULL 11-digit BVN (BVN is mandatory); a NIN-only borrower is
// rejected with 409 "BVN is mandatory" WITHOUT spending wallet balance.
//
// Behavior:
//   • If /home/z/my-project/scripts/.testIdentity.json contains `bvn`, the
//     script runs the FULL live admin-trigger flow with that BVN (one real
//     bureau lookup, ~350 NGN wallet charge, authorized by the owner).
//   • Without a BVN it asserts the mandatory-BVN gate: the trigger returns
//     409, no provider call is made, no wallet charge.
// ============================================================================

process.env.NODE_ENV = "development";
process.env.API_PORT = "4406";
process.env.API_HOST = "127.0.0.1";
process.env.API_PUBLIC_URL = "http://127.0.0.1:4406";
process.env.PREMBLY_API_KEY = "live_sk_fcxmDmu9P2UtvXVS68OwFvFmfqPeOmAiGyAmdM8";
process.env.PREMBLY_BASE_URL = "https://api.prembly.com";
process.env.PREMBLY_CREDIT_DATA_MODE = "ADVANCE";
delete process.env.PREMBLY_CREDIT_TIMEOUT_MS; // default 90s
delete process.env.DATABASE_URL;

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:4406";
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function report(name: string, ok: boolean, detail: string = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const identity = JSON.parse(readFileSync("/home/z/my-project/scripts/.testIdentity.json", "utf8")) as {
    fullName?: string; dob?: string; nin?: string; bvn?: string;
  };
  const hasBvn = Boolean(identity.bvn && /^\d{11}$/.test(identity.bvn));
  console.log(
    `Live identity: ${identity.fullName} / ` +
    (hasBvn ? `BVN ${identity.bvn!.slice(0, 3)}***${identity.bvn!.slice(-2)}` : "NO full BVN on file") +
    ` / NIN ${identity.nin ? `${identity.nin.slice(0, 3)}***${identity.nin.slice(-2)}` : "-"} / DOB ${identity.dob}`,
  );

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
    await sleep(300);
  }
  if (!up) throw new Error("API did not start within 30s");
  console.log("API is up (in-memory store, REAL Prembly). Seeding…\n");

  const now = new Date().toISOString();
  const adminUser = {
    id: randomUUID(), email: "admin@example.com", phone: "08000000001",
    fullName: "Velo Admin", passwordHash: "x", roles: ["ADMIN"],
    adminPermissions: [], kycStatus: "VERIFIED", createdAt: now, isActive: true,
  } as never;
  (store.users as unknown as Array<Record<string, unknown>>).push(adminUser);

  // The production test customer's consumer identity: NIN-verified (BVN masked).
  const borrower = {
    id: randomUUID(), email: "sunday.live@example.com", phone: "08199990001",
    fullName: identity.fullName ?? "Sunday Itodo", passwordHash: "x", roles: ["BORROWER"],
    kycStatus: "VERIFIED", createdAt: now, isActive: true, dateOfBirth: identity.dob ?? "",
  } as never;
  (store.users as unknown as Array<Record<string, unknown>>).push(borrower);
  (store.kycCases as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(), userId: borrower.id, status: "VERIFIED",
    ...(hasBvn ? { bvn: identity.bvn } : { bvn: "***-***-6804" }), // masked display value when no full BVN is provided
    nin: identity.nin,
    checklist: { bvn: hasBvn, nin: true, liveness: true },
    providerRaw: {
      nin: {
        nin_data: {
          nin: identity.nin,
          firstname: identity.fullName?.split(" ")[0] ?? "SUNDAY",
          middlename: identity.fullName?.split(" ")[1] ?? "GIDEON",
          surname: identity.fullName?.split(" ").slice(2).join(" ") ?? "ITODO",
          birthdate: identity.dob ?? "1998-07-22",
        },
      },
    },
    createdAt: now,
  });

  const applicationId = "VEL-LIVE-2026-000001";
  (store.loanApplications as unknown as Array<Record<string, unknown>>).push({
    id: randomUUID(),
    applicationId,
    borrowerId: borrower.id,
    applicantType: "PERSONAL",
    customerSnapshot: {
      fullName: identity.fullName ?? "Sunday Itodo",
      personalInfo: { fullName: identity.fullName ?? "Sunday Itodo" },
      loanRequest: { amount: 300000, tenure: 30, purpose: "Live bureau verification run" },
    },
    amountNaira: 300000,
    tenureDays: 30,
    status: "UNDER_REVIEW",
    creditReportSnapshot: {},
    stageStatuses: {}, stageRejectionNotes: {}, manualDecision: "PENDING",
    createdAt: now, updatedAt: now, submittedAt: now,
  });

  const adminToken = auth.issueToken({ id: adminUser.id, email: adminUser.email, fullName: adminUser.fullName, roles: ["ADMIN"] } as never);
  const adminHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` };

  // ---- trigger the admin credit bureau check against the REAL provider ----
  const startedAt = Date.now();
  const res = await fetch(`${BASE}/api/v1/admin/loan-applications/${encodeURIComponent(applicationId)}/credit-bureau`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({}),
  });
  const out = (await res.json()) as {
    ok?: boolean; report?: { id?: string; status?: string; score?: number | null; normalizedFields?: Record<string, unknown>; reportReference?: string | null };
    creditReportSnapshot?: Record<string, any>; message?: string; error?: string;
  };
  const elapsedInitial = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (!hasBvn) {
    // BVN is mandatory — the gate must reject BEFORE any provider call so no
    // wallet balance is spent.
    report("NIN-only borrower → 409 BVN mandatory (no wallet charge)", res.status === 409 && /BVN is mandatory/i.test(out.error ?? ""), `${res.status} ${out.error ?? ""}`);
    report("no report row created", !out.report?.id, "");
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n${pass}/${results.length} checks passed`);
    process.exit(pass === results.length ? 0 : 1);
  }

  report("admin trigger returns 200", res.ok && out.ok === true, `${res.status} ${JSON.stringify(out).slice(0, 220)}`);
  report("report row created (id present)", Boolean(out.report?.id), out.report?.id ?? "");
  report(
    "initial status PENDING or already final (async trigger)",
    ["PENDING", "RECEIVED", "FAILED"].includes(String(out.report?.status)),
    `${out.report?.status} after ${elapsedInitial}s`,
  );

  // ---- wait for the REAL bureau answer (observed ~27s) ----
  const reportId = out.report?.id ?? "";
  const pollDeadline = Date.now() + 120_000;
  let finalReport: { id?: string; status?: string; score?: number | null; normalizedFields?: Record<string, unknown>; reportReference?: string | null } | undefined = out.report;
  while (Date.now() < pollDeadline) {
    finalReport = (store.creditReports as unknown as Array<Record<string, unknown> & { id: string }>).find((r) => r.id === reportId) as typeof finalReport;
    if (finalReport && finalReport.status !== "PENDING") break;
    await sleep(2000);
  }
  const elapsedTotal = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nProvider answered in ~${elapsedTotal}s total.\n`);

  report("live report RESOLVED (not stuck PENDING)", finalReport?.status === "RECEIVED" || finalReport?.status === "FAILED", `status=${finalReport?.status} after ${elapsedTotal}s`);
  report(
    "live consumer report RECEIVED (thin file or scored)",
    finalReport?.status === "RECEIVED",
    JSON.stringify({
      status: finalReport?.status,
      score: finalReport?.score ?? null,
      bureauNotice: finalReport?.normalizedFields?.bureauNotice,
      reason: finalReport?.normalizedFields?.reason,
    }),
  );
  report(
    "thin-file notice surfaced (customer has no bureau record)",
    finalReport?.status === "RECEIVED" && (finalReport?.score != null || /no record/i.test(String(finalReport?.normalizedFields?.bureauNotice ?? ""))),
    String(finalReport?.normalizedFields?.bureauNotice ?? `score=${finalReport?.score}`),
  );

  // Application snapshot synced with the final state.
  const detail = await fetch(`${BASE}/api/v1/admin/loans/${encodeURIComponent(applicationId)}`, { headers: adminHeaders });
  const detailBody = (await detail.json()) as { application?: { creditReportSnapshot?: Record<string, any> } };
  const external = detailBody.application?.creditReportSnapshot?.external;
  report("application snapshot external synced", external?.status === finalReport?.status, JSON.stringify({ status: external?.status, score: external?.score ?? null, reason: external?.reason }));

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
