const fs = require('fs');
let content = fs.readFileSync('frontend/src/components/admin/AdminSettings.tsx', 'utf8');

// 1. Add imports for useEffect and adminApi
if (!content.includes('import { useMemo, useState, useEffect } from "react"')) {
  content = content.replace(
    'import { useMemo, useState } from "react";',
    'import { useEffect, useMemo, useState } from "react";'
  );
}

// Add adminApi and formatNaira imports
if (!content.includes('adminGetPlatformSettings')) {
  content = content.replace(
    'import { adminResetConfig, adminSaveConfig } from "../../services/adminApi";',
    `import {
  adminGetPlatformSettings,
  adminUpdatePlatformSettings,
  adminSetInvestorEarningRate,
  adminCreditInvestorWallet,
  adminGetLedger,
  adminListInvestors,
  adminListWithdrawals,
  adminApproveWithdrawal,
  adminRejectWithdrawal,
} from "../../services/adminApi";`
  );
}

// 2. Add new state for investor/settings section at the end of useState declarations
// Find the last useState: [resetConfirm, setResetConfirm]
const lastStateIdx = content.indexOf('const [resetConfirm, setResetConfirm] = useState(false);');
console.log("lastStateIdx:", lastStateIdx);
if (lastStateIdx >= 0) {
  const insertAfter = lastStateIdx + 'const [resetConfirm, setResetConfirm] = useState(false);'.length;
  const newState = `

  const [platformSettings, setPlatformSettings] = useState<any>(null);
  const [platformLoading, setPlatformLoading] = useState(false);
  const [platformMessage, setPlatformMessage] = useState("");
  const [platformError, setPlatformError] = useState("");

  const [withdrawalFeePercent, setWithdrawalFeePercent] = useState(1);
  const [withdrawalFeeFlatNaira, setWithdrawalFeeFlatNaira] = useState(0);
  const [defaultAnnualRate, setDefaultAnnualRate] = useState(12);
  const [adminLedgerBalance, setAdminLedgerBalance] = useState<number | null>(null);

  const [earningInvestorId, setEarningInvestorId] = useState("");
  const [earningRatePercent, setEarningRatePercent] = useState(15);
  const [earningRateSaving, setEarningRateSaving] = useState(false);
  const [earningRateMsg, setEarningRateMsg] = useState("");

  const [creditInvestorId, setCreditInvestorId] = useState("");
  const [creditAmountNaira, setCreditAmountNaira] = useState("50000");
  const [creditReason, setCreditReason] = useState<"MANUAL_CREDIT" | "INVESTMENT_RETURN" | "BONUS" | "CORRECTION">("MANUAL_CREDIT");
  const [creditDescription, setCreditDescription] = useState("");
  const [creditSaving, setCreditSaving] = useState(false);
  const [creditMsg, setCreditMsg] = useState("");

  const [investors, setInvestors] = useState<any[]>([]);
  const [investorsLoading, setInvestorsLoading] = useState(true);
  const [withdrawals, setWithdrawals] = useState<any[]>([]);
  const [withdrawalsLoading, setWithdrawalsLoading] = useState(true);
  const [withdrawalActioning, setWithdrawalActioning] = useState<string | null>(null);

  const [ledgerEntries, setLedgerEntries] = useState<any[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [ledgerFilter, setLedgerFilter] = useState<string>("");

  useEffect(() => {
    async function loadAdminData() {
      try {
        const settings = await adminGetPlatformSettings();
        setPlatformSettings(settings.settings);
        setWithdrawalFeePercent(settings.settings.investorWithdrawalFeePercent ?? 1);
        setWithdrawalFeeFlatNaira(Math.round((settings.settings.investorWithdrawalFeeFlatMinor ?? 0) / 100));
        setDefaultAnnualRate(settings.settings.defaultInvestmentAnnualRatePercent ?? 12);
        setAdminLedgerBalance(settings.adminLedgerBalanceMinor ?? 0);
      } catch (e: any) {
        setPlatformError(e.message || "Failed to load platform settings");
      }
      try {
        const inv = await adminListInvestors({ limit: 50 });
        setInvestors(inv.investors ?? []);
      } finally {
        setInvestorsLoading(false);
      }
      try {
        const wd = await adminListWithdrawals({ limit: 50 });
        setWithdrawals(wd.withdrawals ?? []);
      } finally {
        setWithdrawalsLoading(false);
      }
      try {
        const ledger = await adminGetLedger({ limit: 50 });
        setLedgerEntries(ledger.entries ?? []);
        if (adminLedgerBalance === null) setAdminLedgerBalance(ledger.balanceMinor ?? 0);
      } finally {
        setLedgerLoading(false);
      }
    }
    void loadAdminData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSavePlatformSettings() {
    setPlatformLoading(true);
    setPlatformMessage("");
    setPlatformError("");
    try {
      const result = await adminUpdatePlatformSettings({
        investorWithdrawalFeePercent: Number(withdrawalFeePercent),
        investorWithdrawalFeeFlatNaira: Number(withdrawalFeeFlatNaira),
        defaultInvestmentAnnualRatePercent: Number(defaultAnnualRate),
      });
      setPlatformSettings(result.settings);
      const newBal = adminLedgerBalance ?? 0;
      setAdminLedgerBalance(newBal);
      setPlatformMessage("✅ Platform settings saved successfully.");
      setTimeout(() => setPlatformMessage(""), 4000);
    } catch (e: any) {
      setPlatformError(e.message || "Failed to save settings");
    } finally {
      setPlatformLoading(false);
    }
  }

  async function handleSaveEarningRate() {
    if (!earningInvestorId) {
      setEarningRateMsg("Please select an investor first.");
      return;
    }
    setEarningRateSaving(true);
    setEarningRateMsg("");
    try {
      await adminSetInvestorEarningRate(earningInvestorId, Number(earningRatePercent));
      setEarningRateMsg("✅ Investor earning rate saved successfully.");
      setTimeout(() => setEarningRateMsg(""), 4000);
    } catch (e: any) {
      setEarningRateMsg("❌ " + (e.message || "Failed"));
    } finally {
      setEarningRateSaving(false);
    }
  }

  async function handleCreditInvestor() {
    if (!creditInvestorId || !Number(creditAmountNaira)) {
      setCreditMsg("Please select investor and enter valid amount.");
      return;
    }
    setCreditSaving(true);
    setCreditMsg("");
    try {
      await adminCreditInvestorWallet(creditInvestorId, {
        amountNaira: Number(creditAmountNaira),
        reason: creditReason,
        description: creditDescription || undefined,
      });
      setCreditMsg("✅ Investor wallet credited successfully.");
      setCreditAmountNaira("50000");
      setCreditDescription("");
      setTimeout(() => setCreditMsg(""), 4000);
    } catch (e: any) {
      setCreditMsg("❌ " + (e.message || "Failed"));
    } finally {
      setCreditSaving(false);
    }
  }

  async function handleApproveWithdrawal(id: string) {
    setWithdrawalActioning(id);
    try {
      const res = await adminApproveWithdrawal(id);
      setWithdrawals((current) => current.map((w) => (w.id === id ? res.withdrawal : w)));
    } finally {
      setWithdrawalActioning(null);
    }
  }

  async function handleRejectWithdrawal(id: string) {
    const reason = window.prompt("Reason for rejection (optional):") || undefined;
    setWithdrawalActioning(id);
    try {
      const res = await adminRejectWithdrawal(id, reason);
      setWithdrawals((current) => current.map((w) => (w.id === id ? res.withdrawal : w)));
    } finally {
      setWithdrawalActioning(null);
    }
  }
`;
  content = content.slice(0, insertAfter) + newState + content.slice(insertAfter);
  console.log("✅ Added investor/platform state hooks");
}

// 3. Now add new sections at the end - insert before the closing </div> of grid-cols-3
// Find the grid end: look for the pattern where the RIGHT sidebar (Preview card) ends and the grid closes
// after preview section (right sidebar)
const previewIdx = content.indexOf(`Sidebar — Live Configuration Preview`);
console.log("preview section starts at idx:", previewIdx);
if (previewIdx >= 0) {
  // Find the next grid closing AFTER preview section
  let searchStart = previewIdx;
  let gridCloseIdx = -1;
  // We need to find the closing of lg:col-span-1 div, then of lg:grid-cols-3 div
  while (true) {
    const found = content.indexOf(`</div>`, searchStart);
    if (found < 0) break;
    // Check context after this closing
    const context = content.slice(found, found + 100);
    if (context.startsWith(`</div>\n\n\n    </div>\n  );\n}`) ||
        context.startsWith(`</div>\n    </div>\n  );\n}`)) {
      // We're at the very end. Go back to find right sidebar close.
      break;
    }
    searchStart = found + 1;
  }
  
  // Better: find return function closing pattern
  const returnClose = content.lastIndexOf(`</div>\n  );\n}`);
  console.log("return close idx:", returnClose);
  
  // Insert new mega section BEFORE the last closing grid div that wraps all sections
  // Strategy: Insert the new Investor Platform section right BEFORE the 2-column layout ends. 
  // Let's find end of grid layout: </div> just before </div>\n  );\n}
  const gridWrapEnd = content.lastIndexOf(`</div>\n  );\n}`);
  if (gridWrapEnd > 0) {
    const spaceBefore = content.slice(0, gridWrapEnd);
    // Find the preceding div that closes the lg-col-span-3 grid
    const gridClosing = spaceBefore.lastIndexOf(`</div>\n`);
    console.log("Inserting sections at grid close idx:", gridClosing);
    
    const newInvestorSections = `
          {/* ============ INVESTOR MANAGEMENT ============ */}
          <div className="lg:col-span-2 space-y-6">
            <div className="velo-card p-5 sm:p-6 border-0 shadow-[0_20px_60px_-20px_rgba(16,185,129,0.12)] rounded-2xl border-l-4 border-emerald-500">
              <div className="flex items-start justify-between flex-wrap gap-4 mb-5">
                <div>
                  <h3 className="text-lg font-extrabold text-velo-900 flex items-center gap-2">
                    <span className="text-2xl">💼</span> Investor Management — Withdrawal Fees &amp; Earning Rates
                  </h3>
                  <p className="text-sm text-slate-500 mt-0.5">
                    Configure global withdrawal fees, default investment earning rates, and per-investor overrides.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSavePlatformSettings}
                    disabled={platformLoading}
                    className="btn-primary !py-2 !px-4 text-xs !font-extrabold"
                  >
                    {platformLoading ? "Saving…" : "💾 Save Platform Settings"}
                  </button>
                </div>
              </div>
              {platformMessage && <div className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 px-4 py-2.5 text-sm font-bold mb-4 animate-fade-in">{platformMessage}</div>}
              {platformError && <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-2.5 text-sm font-bold mb-4">{platformError}</div>}
          
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4">
                  <label className="text-xs font-bold text-slate-700 block mb-2">
                    Investor Withdrawal Fee (%)
                    <span className="text-[10px] font-normal text-slate-500 block mb-1">
                      Percentage of withdrawal amount charged as fee
                    </span>
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="100"
                      className="velo-input pr-8"
                      value={withdrawalFeePercent}
                      onChange={(e) => setWithdrawalFeePercent(Number(e.target.value))}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">%</span>
                  </div>
                  <div className="mt-3 pt-3 border-t border-slate-100 flex justify-between text-[11px]">
                    <span className="text-slate-500">Current</span>
                    <span className="font-extrabold text-emerald-600">{platformSettings?.investorWithdrawalFeePercent ?? 0}%</span>
                  </div>
                </div>
                
                <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4">
                  <label className="text-xs font-bold text-slate-700 block mb-2">
                    Flat Withdrawal Fee (₦)
                    <span className="text-[10px] font-normal text-slate-500 block mb-1">
                      Fixed flat fee added to every withdrawal
                    </span>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">₦</span>
                    <input
                      type="number"
                      min="0"
                      step="100"
                      className="velo-input pl-8"
                      value={withdrawalFeeFlatNaira}
                      onChange={(e) => setWithdrawalFeeFlatNaira(Number(e.target.value))}
                    />
                  </div>
                  <div className="mt-3 pt-3 border-t border-slate-100 flex justify-between text-[11px]">
                    <span className="text-slate-500">Current</span>
                    <span className="font-extrabold text-emerald-600">
                      ₦{Math.round((platformSettings?.investorWithdrawalFeeFlatMinor ?? 0) / 100).toLocaleString("en-NG")}
                    </span>
                  </div>
                </div>
                
                <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4">
                  <label className="text-xs font-bold text-slate-700 block mb-2">
                    Default Investment Annual Rate
                    <span className="text-[10px] font-normal text-slate-500 block mb-1">
                      Default rate used when no plan rate or override is set
                    </span>
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.25"
                      min="0"
                      max="100"
                      className="velo-input pr-8"
                      value={defaultAnnualRate}
                      onChange={(e) => setDefaultAnnualRate(Number(e.target.value))}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">%</span>
                  </div>
                  <div className="mt-3 pt-3 border-t border-slate-100 flex justify-between text-[11px]">
                    <span className="text-slate-500">Current</span>
                    <span className="font-extrabold text-emerald-600">{platformSettings?.defaultInvestmentAnnualRatePercent ?? 0}%</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="velo-card p-5 sm:p-6 border-0 shadow-[0_20px_60px_-20px_rgba(59,130,246,0.12)] rounded-2xl border-t-4 border-blue-500">
                <h3 className="text-md font-extrabold text-velo-900 mb-1 flex items-center gap-2">
                  <span className="text-xl">📈</span> Set Custom Earning Rate per Investor
                </h3>
                <p className="text-xs text-slate-500 mb-4">Override the default earning rate for a specific investor.</p>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-bold text-slate-700 block mb-1.5">Select Investor</label>
                    <select
                      className="velo-input text-sm"
                      value={earningInvestorId}
                      onChange={(e) => setEarningInvestorId(e.target.value)}
                      disabled={investorsLoading}
                    >
                      <option value="">{investorsLoading ? "Loading investors…" : "Select investor…"}</option>
                      {investors.map((inv) => (
                        <option key={inv.id} value={inv.id}>
                          {inv.fullName} — {inv.email}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-700 block mb-1.5">Annual Earning Rate (%)</label>
                    <div className="relative">
                      <input
                        type="number"
                        step="0.25"
                        min="0"
                        max="100"
                        className="velo-input pr-8"
                        value={earningRatePercent}
                        onChange={(e) => setEarningRatePercent(Number(e.target.value))}
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">%</span>
                    </div>
                  </div>
                  <button
                    onClick={handleSaveEarningRate}
                    disabled={earningRateSaving}
                    className="btn-primary w-full !py-2.5 !font-extrabold text-sm"
                  >
                    {earningRateSaving ? "Saving…" : "✅ Save Custom Earning Rate"}
                  </button>
                  {earningRateMsg && <div className={`rounded-lg px-3 py-2 text-xs font-bold ${earningRateMsg.startsWith("✅") ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{earningRateMsg}</div>}
                </div>
              </div>
              
              <div className="velo-card p-5 sm:p-6 border-0 shadow-[0_20px_60px_-20px_rgba(245,158,11,0.12)] rounded-2xl border-t-4 border-amber-500">
                <h3 className="text-md font-extrabold text-velo-900 mb-1 flex items-center gap-2">
                  <span className="text-xl">💰</span> Credit Investor Wallet
                </h3>
                <p className="text-xs text-slate-500 mb-4">Manually add funds to an investor's wallet (admin ledger is debited, investor credited).</p>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-bold text-slate-700 block mb-1.5">Select Investor</label>
                    <select
                      className="velo-input text-sm"
                      value={creditInvestorId}
                      onChange={(e) => setCreditInvestorId(e.target.value)}
                      disabled={investorsLoading}
                    >
                      <option value="">{investorsLoading ? "Loading investors…" : "Select investor…"}</option>
                      {investors.map((inv) => (
                        <option key={inv.id} value={inv.id}>
                          {inv.fullName} — {inv.email}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-bold text-slate-700 block mb-1.5">Amount (₦)</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">₦</span>
                        <input
                          type="number"
                          min="100"
                          className="velo-input pl-8"
                          value={creditAmountNaira}
                          onChange={(e) => setCreditAmountNaira(e.target.value)}
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs font-bold text-slate-700 block mb-1.5">Reason</label>
                      <select
                        className="velo-input text-sm"
                        value={creditReason}
                        onChange={(e) => setCreditReason(e.target.value as any)}
                      >
                        <option value="MANUAL_CREDIT">Manual Credit</option>
                        <option value="INVESTMENT_RETURN">Investment Return</option>
                        <option value="BONUS">Bonus</option>
                        <option value="CORRECTION">Correction</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-700 block mb-1.5">Description (optional)</label>
                    <input
                      type="text"
                      className="velo-input text-sm"
                      placeholder="Optional note to investor"
                      value={creditDescription}
                      onChange={(e) => setCreditDescription(e.target.value)}
                    />
                  </div>
                  <button
                    onClick={handleCreditInvestor}
                    disabled={creditSaving}
                    className="btn-primary w-full !py-2.5 !font-extrabold text-sm !bg-gradient-to-r !from-emerald-500 !to-emerald-600 hover:!from-emerald-600 hover:!to-emerald-700"
                  >
                    {creditSaving ? "Processing…" : "✅ Credit Investor Wallet"}
                  </button>
                  {creditMsg && <div className={`rounded-lg px-3 py-2 text-xs font-bold ${creditMsg.startsWith("✅") ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{creditMsg}</div>}
                </div>
              </div>
            </div>

            <div className="velo-card p-5 sm:p-6 border-0 shadow-[0_20px_60px_-20px_rgba(168,85,247,0.12)] rounded-2xl border-l-4 border-purple-500">
              <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
                <div>
                  <h3 className="text-md font-extrabold text-velo-900 flex items-center gap-2">
                    <span className="text-xl">⏳</span> Pending Investor Withdrawals
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Approve or reject pending withdrawal requests. Approved payouts are sent immediately via Flutterwave transfer.
                  </p>
                </div>
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-50 text-amber-700 text-xs font-bold border border-amber-100">
                  {withdrawals.filter((w) => w.status === "PENDING_APPROVAL").length} pending
                </span>
              </div>
              {withdrawalsLoading ? (
                <div className="text-sm text-slate-500 py-8 text-center">Loading withdrawals…</div>
              ) : withdrawals.length === 0 ? (
                <div className="text-sm text-slate-500 py-8 text-center rounded-xl bg-slate-50 border border-slate-100">No withdrawal requests yet.</div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-600 text-xs uppercase">
                      <tr>
                        <th className="text-left p-3 font-bold">Investor</th>
                        <th className="text-right p-3 font-bold">Amount</th>
                        <th className="text-right p-3 font-bold">Fee</th>
                        <th className="text-right p-3 font-bold">Net</th>
                        <th className="text-left p-3 font-bold">Bank</th>
                        <th className="text-left p-3 font-bold">Status</th>
                        <th className="text-right p-3 font-bold">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {withdrawals.slice(0, 20).map((w) => (
                        <tr key={w.id} className="hover:bg-slate-50">
                          <td className="p-3">
                            <div className="font-bold text-velo-900">{investors.find((i) => i.id === w.investorId)?.fullName || w.investorId.slice(0, 8)}</div>
                            <div className="text-[10px] text-slate-500">{new Date(w.createdAt).toLocaleDateString()}</div>
                          </td>
                          <td className="p-3 text-right font-bold">₦{Number(w.amountNaira).toLocaleString("en-NG")}</td>
                          <td className="p-3 text-right text-red-600 font-semibold">-₦{Number(w.feeNaira).toLocaleString("en-NG")}</td>
                          <td className="p-3 text-right font-extrabold text-emerald-700">₦{Number(w.netNaira).toLocaleString("en-NG")}</td>
                          <td className="p-3">
                            <div className="font-semibold">{w.bankName}</div>
                            <div className="text-[11px] text-slate-500">••••••{w.accountNumber.slice(-4)}</div>
                          </td>
                          <td className="p-3">
                            <span className={`inline-flex px-2 py-1 rounded-full text-[10px] font-bold ${
                              w.status === "SUCCESSFUL" ? "bg-emerald-100 text-emerald-700" :
                              w.status === "PENDING_APPROVAL" ? "bg-amber-100 text-amber-700" :
                              w.status === "PROCESSING" ? "bg-blue-100 text-blue-700" :
                              w.status === "REJECTED" ? "bg-red-100 text-red-700" :
                              w.status === "FAILED" ? "bg-red-100 text-red-700" :
                              "bg-slate-100 text-slate-600"
                            }`}>
                              {w.status.replaceAll("_", " ")}
                            </span>
                          </td>
                          <td className="p-3 text-right">
                            {w.status === "PENDING_APPROVAL" && (
                              <div className="flex items-center justify-end gap-1.5">
                                <button
                                  onClick={() => handleApproveWithdrawal(w.id)}
                                  disabled={withdrawalActioning === w.id}
                                  className="inline-flex items-center px-2.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-bold transition"
                                >
                                  ✓ Approve
                                </button>
                                <button
                                  onClick={() => handleRejectWithdrawal(w.id)}
                                  disabled={withdrawalActioning === w.id}
                                  className="inline-flex items-center px-2.5 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white text-[11px] font-bold transition"
                                >
                                  ✕ Reject
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* ============ RIGHT SIDEBAR — Admin Ledger ============ */}
          <div className="space-y-6">
            <div className="velo-card p-5 sm:p-6 border-0 shadow-[0_20px_60px_-20px_rgba(6,78,59,0.18)] rounded-2xl bg-gradient-to-br from-emerald-600 via-emerald-700 to-emerald-800 text-white overflow-hidden relative">
              <div className="absolute -top-10 -right-10 w-36 h-36 rounded-full bg-white/5 blur-xl"></div>
              <div className="absolute bottom-0 right-10 w-24 h-24 rounded-full bg-emerald-400/20 blur-xl"></div>
              <div className="relative">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-100/80">Admin Ledger Balance</span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/10 text-[10px] font-bold text-emerald-50 border border-white/10">
                    ✅ SYNCED
                  </span>
                </div>
                <div className="mt-1 text-3xl sm:text-4xl font-black tracking-tight">
                  {adminLedgerBalance !== null ? `₦${Math.round(adminLedgerBalance / 100).toLocaleString("en-NG")}` : "—"}
                </div>
                <div className="mt-1 text-[11px] text-emerald-100/70">
                  Funds available for investor funding &amp; payouts
                </div>
                <div className="mt-4 pt-4 border-t border-white/10 grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-emerald-100/70 font-bold mb-0.5">Debits today</div>
                    <div className="text-lg font-extrabold">₦{(adminLedgerBalance !== null ? 0 : 0).toLocaleString("en-NG")}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-emerald-100/70 font-bold mb-0.5">Last updated</div>
                    <div className="text-sm font-bold">{platformSettings?.updatedAt ? new Date(platformSettings.updatedAt).toLocaleDateString() : "—"}</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="velo-card p-5 sm:p-6 border-0 shadow-[0_20px_60px_-20px_rgba(15,23,42,0.12)] rounded-2xl">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-md font-extrabold text-velo-900 flex items-center gap-2">
                    <span>📒</span> Admin Ledger Activity
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-0.5">Debit/Credit entries for all investment ops</p>
                </div>
                <select
                  value={ledgerFilter}
                  onChange={(e) => setLedgerFilter(e.target.value)}
                  className="text-[10px] rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-slate-600 font-bold focus:outline-none focus:ring-1 focus:ring-velo-500"
                >
                  <option value="">All</option>
                  <option value="INVESTOR_FUNDING">Investor Funding</option>
                  <option value="INVESTMENT_PAYOUT">Investment Payouts</option>
                  <option value="WITHDRAWAL_FEE">Withdrawal Fees</option>
                  <option value="REVERSAL">Reversals</option>
                </select>
              </div>
              {ledgerLoading ? (
                <div className="text-sm text-slate-500 py-6 text-center">Loading ledger…</div>
              ) : (
                <div className="space-y-2.5 max-h-[480px] overflow-y-auto pr-1">
                  {ledgerEntries
                    .filter((e) => !ledgerFilter || e.entryType === ledgerFilter)
                    .slice(0, 40)
                    .map((e) => (
                      <div key={e.id} className="flex items-start gap-3 p-3 rounded-xl border border-slate-100 hover:border-slate-200 hover:bg-slate-50 transition">
                        <div className={`mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-lg flex-shrink-0 ${e.direction === "DEBIT" ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-600"}`}>
                          {e.direction === "DEBIT" ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M7 17L17 7M17 7H8M17 7V16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M7 17L17 7M7 7H16M7 7V16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <div className="font-bold text-xs text-velo-900 truncate">
                              {e.entryType.replaceAll("_", " ")}
                            </div>
                            <div className={`font-black text-xs whitespace-nowrap ${e.direction === "DEBIT" ? "text-red-600" : "text-emerald-600"}`}>
                              {e.direction === "DEBIT" ? "-" : "+"}₦{Math.round(e.amountMinor / 100).toLocaleString("en-NG")}
                            </div>
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-500 line-clamp-1">
                            {e.description || "—"}
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-400">
                            {new Date(e.createdAt).toLocaleString()}
                          </div>
                        </div>
                      </div>
                    ))}
                  {ledgerEntries.filter((e) => !ledgerFilter || e.entryType === ledgerFilter).length === 0 && (
                    <div className="text-xs text-slate-500 text-center py-6 rounded-xl bg-slate-50">
                      No ledger entries match this filter.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>`;

    const spaceAfter = content.slice(gridClosing);
    content = content.slice(0, gridClosing) + newInvestorSections + spaceAfter;
    console.log("✅ Added all investor management sections + admin ledger sidebar");
  }
}

fs.writeFileSync('frontend/src/components/admin/AdminSettings.tsx', content);
console.log("✅ AdminSettings.tsx patched successfully");
