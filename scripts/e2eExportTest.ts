// ============================================================================
// scripts/e2eExportTest.ts
// In-process end-to-end test for the CSV export endpoints + dedup rules.
//
// Boots the real Express API in development mode (in-memory store), seeds a
// realistic dataset through the SAME store functions the production routes use
// (settleWalletDeposit, appendLedger, walletTransactions.push, …), mints real
// JWTs and asserts:
//   1. /investor/export/transactions  → 200, deduped (ONE funding row, NO
//      duplicate FUNDING ledger row, NO INVESTMENT LOCK row), correct amounts
//   2. /investor/export/investments   → 200, naira amounts NOT divided by 100
//   3. /investor/export/unknown       → 400 with dataset list (not 404)
//   4. /admin/export/withdrawals      → 200, naira amounts correct
//   5. /borrower/export/repayments    → 200, naira amounts correct
//   6. /investor/export/transactions with date range → filtered rows only
// ============================================================================

process.env.NODE_ENV = "development";
process.env.API_PORT = "4399";
process.env.API_HOST = "127.0.0.1";
process.env.API_PUBLIC_URL = "http://127.0.0.1:4399";
// The sandbox injects a bogus DATABASE_URL (file: scheme) that the neon client
// rejects at import time — force the supported in-memory mode instead.
delete process.env.DATABASE_URL;

import { randomUUID } from "node:crypto";

const BASE = "http://127.0.0.1:4399";
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function report(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  // Boot the API in-process (same module graph → same store instance).
  await import("../backend/server/index.js");
  const store = await import("../backend/server/store.js");
  const auth = await import("../backend/server/auth.js");

  // Wait for the server to listen.
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

  // ---- Seed: investor user + wallet -------------------------------------
  const investorId = randomUUID();
  const now = new Date().toISOString();
  store.users.push({
    id: investorId,
    email: "export-test-investor@example.com",
    phone: "+2348011111111",
    fullName: "Test Investor",
    passwordHash: "x",
    roles: ["INVESTOR"],
    kycStatus: "VERIFIED",
    createdAt: now,
    isActive: true,
  } as never);
  const wallet = store.findWallet(investorId);

  // ---- Seed: settled wallet funding of ₦100,000 (production code path) ----
  // Exactly what POST /investor/wallet/funding + settleWalletDeposit create.
  const depositTx = {
    id: randomUUID(),
    userId: investorId,
    walletId: wallet.id,
    type: "DEPOSIT",
    amountMinor: 10_000_000, // ₦100,000
    currency: "NGN",
    status: "PENDING_PROVIDER_CONFIRMATION",
    provider: "flutterwave",
    txRef: `VELO-FUND-${randomUUID()}`,
    createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
  } as never;
  store.walletTransactions.push(depositTx);
  const settled = store.settleWalletDeposit({
    txRef: (depositTx as unknown as { txRef: string }).txRef,
    providerReference: "FLW-REF-TEST",
    providerTransactionId: "FLW-TX-TEST",
  });
  if (!settled.ok) throw new Error(`settleWalletDeposit failed: ${settled.reason}`);

  // ---- Seed: ACTIVE investment of ₦250,000 on the 30-day plan ------------
  store.seedInvestmentPlans();
  const plan = store.investmentPlans[0];
  const invStart = new Date(Date.now() - 2 * 86400000);
  const investment = {
    id: randomUUID(),
    investorId,
    planId: plan.id,
    planVersion: plan.version,
    planSnapshot: { ...plan },
    amountNaira: 250_000,
    expectedEarningsNaira: 2_054.79, // 250k @10% for 30d
    tenureDays: 30,
    annualRatePercent: 10,
    startsAt: invStart.toISOString(),
    maturesAt: new Date(invStart.getTime() + 30 * 86400000).toISOString(),
    status: "ACTIVE",
    createdAt: invStart.toISOString(),
  } as never;
  store.investments.push(investment);
  store.appendLedger(wallet, {
    entryType: "INVESTMENT_LOCK",
    referenceId: (investment as unknown as { id: string }).id,
    amountMinor: 25_000_000,
    direction: "DEBIT",
    description: `Investment ${(investment as unknown as { id: string }).id} locked`,
  });
  store.walletTransactions.push({
    id: randomUUID(),
    userId: investorId,
    walletId: wallet.id,
    type: "INVESTMENT",
    amountMinor: 25_000_000,
    currency: "NGN",
    status: "COMPLETED",
    txRef: `VELO-INVEST-${(investment as unknown as { id: string }).id}`,
    createdAt: invStart.toISOString(),
  } as never);

  // ---- Seed: a withdrawal record (₦50,000) -------------------------------
  store.investorWithdrawals.push({
    id: randomUUID(),
    investorId,
    amountNaira: 50_000,
    feeNaira: 100,
    netNaira: 49_900,
    currency: "NGN",
    bankCode: "058",
    bankName: "GTBank",
    accountNumber: "0123456789",
    accountName: "Test Investor",
    status: "SUCCESSFUL",
    createdAt: new Date(Date.now() - 1 * 86400000).toISOString(),
    updatedAt: now,
  } as never);

  // ---- Seed: admin user ---------------------------------------------------
  const adminId = randomUUID();
  store.users.push({
    id: adminId,
    email: "export-test-admin@example.com",
    phone: "+2348022222222",
    fullName: "Test Admin",
    passwordHash: "x",
    roles: ["ADMIN"],
    kycStatus: "VERIFIED",
    createdAt: now,
    isActive: true,
  } as never);
  // Admin wallet credit for the investor (MANUAL_ADJUSTMENT path style).
  store.appendAdminLedger({
    entryType: "WALLET_CREDIT",
    referenceId: randomUUID(),
    investorId,
    amountMinor: 5_000_000,
    direction: "CREDIT",
    description: "Test admin credit",
  });

  const investorToken = auth.issueToken(store.users.find((u) => u.id === investorId)!);
  const adminToken = auth.issueToken(store.users.find((u) => u.id === adminId)!);

  const get = async (path: string, token: string): Promise<{ status: number; text: string; disposition: string }> => {
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, text: await res.text(), disposition: res.headers.get("content-disposition") ?? "" };
  };

  // ---- 1. Investor transactions export: dedup + amounts ------------------
  const tx = await get("/api/v1/investor/export/transactions", investorToken);
  report("investor/transactions status=200 text/csv", tx.status === 200 && tx.text.includes("Date,Type,Direction"), `status=${tx.status}`);
  const txLines = tx.text.split("\r\n").filter((l) => l.trim());
  const fundingRows = txLines.filter((l) => l.includes("Wallet funding"));
  const ledgerFundingRows = txLines.filter((l) => /(^|,)FUNDING(,|$)/.test(l));
  const lockRows = txLines.filter((l) => l.includes("INVESTMENT LOCK"));
  const investmentRows = txLines.filter((l) => l.includes("Investment,DEBIT"));
  const withdrawalRows = txLines.filter((l) => l.includes("Withdrawal,DEBIT"));
  report("funding appears EXACTLY once (dedup)", fundingRows.length === 1 && ledgerFundingRows.length === 0, `walletFunding=${fundingRows.length} ledgerFunding=${ledgerFundingRows.length}`);
  report("no INVESTMENT LOCK duplicate row", lockRows.length === 0, `lockRows=${lockRows.length}`);
  report("investment row present with plan name", investmentRows.length === 1 && investmentRows[0].includes("Velo Flex 30"), investmentRows[0] ?? "missing");
  report("funding amount NOT divided by 100", fundingRows[0]?.includes("100000") === true, fundingRows[0] ?? "missing");
  report("withdrawal amount NOT divided by 100", withdrawalRows[0]?.includes("50000") === true, withdrawalRows[0] ?? "missing");
  report("CSV attachment filename header", /velocredit-transactions.*\.csv/.test(tx.disposition), tx.disposition);

  // ---- 2. Investor investments export ------------------------------------
  const inv = await get("/api/v1/investor/export/investments", investorToken);
  const invLines = inv.text.split("\r\n").filter((l) => l.trim());
  report("investor/investments status=200", inv.status === 200, `status=${inv.status}`);
  report("investment amount NOT divided by 100", invLines[1]?.includes("250000") === true, invLines[1] ?? "missing");
  report("expected earnings NOT divided by 100", invLines[1]?.includes("2054.79") === true, invLines[1] ?? "missing");

  // ---- 3. Unknown dataset → 400 (not 404) --------------------------------
  const unknown = await get("/api/v1/investor/export/unknown-dataset", investorToken);
  report("unknown dataset returns 400 with hint", unknown.status === 400 && unknown.text.includes("Available"), `status=${unknown.status} body=${unknown.text.slice(0, 80)}`);

  // ---- 4. Admin withdrawals export ----------------------------------------
  const adm = await get("/api/v1/admin/export/withdrawals", adminToken);
  const admLines = adm.text.split("\r\n").filter((l) => l.trim());
  report("admin/withdrawals status=200", adm.status === 200, `status=${adm.status}`);
  report("admin withdrawal amounts NOT divided by 100", admLines[1]?.includes("50000") === true && admLines[1]?.includes("100") !== false, admLines[1] ?? "missing");

  // ---- 4b. Admin investors + audit-logs export ----------------------------
  const admInv = await get("/api/v1/admin/export/investors", adminToken);
  const admInvLines = admInv.text.split("\r\n").filter((l) => l.trim());
  report("admin/investors status=200", admInv.status === 200, `status=${admInv.status}`);
  report("admin investor wallet balances in naira", admInvLines[1]?.includes("250000") === true, admInvLines[1] ?? "missing");
  store.auditLogs.push({
    id: randomUUID(),
    userId: adminId,
    action: "EXPORT_TEST_EVENT",
    resourceType: "TEST",
    resourceId: "res-1",
    metadata: { test: true },
    ipAddress: "127.0.0.1",
    createdAt: now,
  } as never);
  const admAudit = await get("/api/v1/admin/export/audit-logs", adminToken);
  const admAuditLines = admAudit.text.split("\r\n").filter((l) => l.trim());
  report("admin/audit-logs status=200", admAudit.status === 200, `status=${admAudit.status}`);
  report("audit log event exported", admAuditLines.some((l) => l.includes("EXPORT_TEST_EVENT")), admAuditLines[1] ?? "missing");

  // ---- 5. Borrower repayments export (seed a repayment) -------------------
  const borrowerId = randomUUID();
  store.users.push({
    id: borrowerId,
    email: "export-test-borrower@example.com",
    phone: "+2348033333333",
    fullName: "Test Borrower",
    passwordHash: "x",
    roles: ["BORROWER"],
    kycStatus: "VERIFIED",
    createdAt: now,
    isActive: true,
  } as never);
  store.repayments.push({
    id: randomUUID(),
    loanId: randomUUID(),
    borrowerId,
    amountNaira: 75_000,
    currency: "NGN",
    status: "SUCCESSFUL",
    provider: "flutterwave",
    onTime: true,
    createdAt: now,
  } as never);
  const borrowerToken = auth.issueToken(store.users.find((u) => u.id === borrowerId)!);
  const rep = await get("/api/v1/borrower/export/repayments", borrowerToken);
  const repLines = rep.text.split("\r\n").filter((l) => l.trim());
  report("borrower/repayments status=200", rep.status === 200, `status=${rep.status}`);
  report("repayment amount NOT divided by 100", repLines[1]?.includes("75000") === true, repLines[1] ?? "missing");

  // ---- 6. Date-range filter ------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  const future = await get(`/api/v1/investor/export/transactions?from=2030-01-01&to=2030-12-31`, investorToken);
  const futureRows = future.text.split("\r\n").filter((l) => l.trim()).length - 1;
  report("date range filters out all seeded rows", future.status === 200 && futureRows === 0, `rows=${futureRows}`);

  // ---- 7. Investor dashboard metrics sanity (active-only analysis source) --
  const dash = await get("/api/v1/investor/dashboard", investorToken);
  const dashJson = JSON.parse(dash.text) as { investments: Array<{ status: string; amountNaira: number; expectedEarningsNaira: number }> };
  const active = dashJson.investments.filter((i) => i.status === "ACTIVE");
  const investedCapital = active.reduce((s, i) => s + Number(i.amountNaira ?? 0), 0);
  report("dashboard exposes single ACTIVE investment", dashJson.investments.length === 1 && investedCapital === 250_000, `investments=${dashJson.investments.length} capital=${investedCapital}`);

  // ---- Summary --------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== ${results.length - failed.length}/${results.length} checks passed =====`);
  if (failed.length > 0) {
    console.log("FAILED CHECKS:");
    for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error("E2E test crashed:", err);
  process.exit(1);
});
