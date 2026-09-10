import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import PremblyKycWidgetButton from "../components/PremblyKycWidgetButton";
import { useAuth } from "../context/AuthContext";
import {
  fundWallet,
  getInvestorDashboard,
  getInvestmentPlans,
  getMyKyc,
  getInvestorTransactions,
  uploadKycDocument,
  verifyMyBvn,
  verifyMyNin,
  verifyMyLiveness,
  updateMyKyc,
} from "../services/apiClient";

const money = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
  maximumFractionDigits: 0,
});
type DashboardData = {
  wallet?: { availableMinor?: number; heldMinor?: number };
  investments?: Array<{
    expectedInterestMinor?: number;
    expectedInterestNaira?: number;
  }>;
};
type TransactionData = {
  payouts?: Array<{ amountNaira?: number; status?: string }>;
  investments?: Array<unknown>;
};
type KycData = {
  status?: string;
  checklist?: { bvn?: boolean; nin?: boolean; proofOfAddress?: boolean; passport?: boolean; signature?: boolean };
};
type Plan = { id: string; name: string; tenureDays: number; annualRatePercent: number; minAmountNaira: number };

export default function InvestorDashboard() {
  const { user, addUserRole, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [transactions, setTransactions] = useState<TransactionData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [switchingBusy, setSwitchingBusy] = useState(false);
  const [switchMsg, setSwitchMsg] = useState("");
  const [kyc, setKyc] = useState<KycData | null>(null);
  const [kycBusy, setKycBusy] = useState("");
  const [kycError, setKycError] = useState("");
  const [bvn, setBvn] = useState("");
  const [nin, setNin] = useState("");
  const [action, setAction] = useState<"fund" | "plans" | "transactions" | "">("");
  const [fundingAmount, setFundingAmount] = useState("100000");
  const [plans, setPlans] = useState<Plan[]>([]);

  useEffect(() => {
    if (!user) return;
    Promise.all([getInvestorDashboard(), getInvestorTransactions(), getMyKyc()])
      .then(([dashboard, history, kycResponse]) => {
        setData(dashboard as DashboardData);
        setTransactions(history as TransactionData);
        setKyc(kycResponse as unknown as KycData);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Unable to load investor data")
      );
  }, [user]);

  async function verifyIdentity(type: "BVN" | "NIN") {
    const value = type === "BVN" ? bvn : nin;
    if (!/^\d{11}$/.test(value)) {
      setKycError(`${type} must be exactly 11 digits.`);
      return;
    }
    setKycBusy(type);
    setKycError("");
    try {
      const names = (user?.fullName ?? "").trim().split(/\s+/);
      const response = type === "BVN"
        ? await verifyMyBvn(value, names[0], names.slice(1).join(" "))
        : await verifyMyNin(value, names[0], names.slice(1).join(" "));
      setKyc((current) => ({ ...current, status: response.status, checklist: response.checklist as unknown as KycData["checklist"] }));
      await refreshUser();
      setMessage(`${type} verification request completed.`);
    } catch (err) {
      setKycError(err instanceof Error ? err.message : `Unable to verify ${type}`);
    } finally {
      setKycBusy("");
    }
  }

  async function uploadProofOfAddress(file: File) {
    setKycBusy("PROOF_OF_ADDRESS");
    setKycError("");
    try {
      const response = await uploadKycDocument("PROOF_OF_ADDRESS", file);
      setKyc((current) => ({ ...current, checklist: response.checklist as unknown as KycData["checklist"] }));
      setMessage("Proof of address uploaded. Submit it for review when BVN and NIN are verified.");
    } catch (err) {
      setKycError(err instanceof Error ? err.message : "Unable to upload proof of address");
    } finally {
      setKycBusy("");
    }
  }

  async function submitAddressReview() {
    if (!kyc?.checklist?.bvn || !kyc.checklist.nin || !kyc.checklist.proofOfAddress) return;
    setBusy(true);
    setKycError("");
    try {
      const response = await import("../services/apiClient").then(({ submitKyc }) => submitKyc());
      setKyc((current) => ({ ...current, status: response.status, checklist: response.checklist as unknown as KycData["checklist"] }));
      await refreshUser();
      setMessage("Proof of address submitted for manual review.");
    } catch (err) {
      setKycError(err instanceof Error ? err.message : "Unable to submit proof of address");
    } finally {
      setBusy(false);
    }
  }

  async function verifyLivenessFile(file: File) {
    setKycBusy("LIVENESS_FILE");
    setKycError("");
    try {
      const idNumber = bvn || nin || "";
      const idType = bvn && /^\d{11}$/.test(bvn) ? "BVN" : nin && /^\d{11}$/.test(nin) ? "NIN" : undefined;
      const response = await verifyMyLiveness(file, { idType, idNumber });
      setKyc((current) => current ? ({ ...current, status: response.status, checklist: response.checklist as unknown as KycData["checklist"] }) : current);
      await refreshUser();
      setMessage("Liveness check completed.");
    } catch (err) {
      setKycError(err instanceof Error ? err.message : "Liveness check failed. Try again or use the camera widget.");
    } finally {
      setKycBusy("");
    }
  }

  async function onPremblyLivenessResult(result: { success: boolean; message: string }) {
    if (result.success) {
      try {
        const updated = await getMyKyc();
        setKyc(updated as unknown as KycData);
        await refreshUser();
      } catch { /* ignore */ }
      setMessage(result.message);
    } else {
      setKycError(result.message);
    }
  }

  async function openAction(nextAction: "fund" | "plans" | "transactions") {
    setAction(nextAction);
    if (nextAction === "plans" && !plans.length) {
      try {
        const response = await getInvestmentPlans();
        setPlans(response.plans as Plan[]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load investment plans");
      }
    }
  }

  async function handleFundWallet(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const response = await fundWallet(Number(fundingAmount));
      const link = response.checkout?.data?.link;
      if (link) window.location.assign(link);
      else setMessage(response.message || "Wallet funding is being processed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start wallet funding");
    }
  }

  const wallet = data?.wallet;
  const investments = data?.investments ?? [];
  const available = Number(wallet?.availableMinor ?? 0) / 100;
  const locked = Number(wallet?.heldMinor ?? 0) / 100;
  const returns = investments.reduce(
    (sum, item) =>
      sum +
      Number(item.expectedInterestNaira ?? Number(item.expectedInterestMinor ?? 0) / 100),
    0
  );
  const totalCapital = available + locked;
  const activeCount = investments.filter((investment) => ["ACTIVE", "PENDING"].includes(String((investment as { status?: string }).status))).length;
  const returnRate = totalCapital ? Math.min(100, Math.round((returns / totalCapital) * 100)) : 0;

  const hasBothRoles = user?.roles.includes("INVESTOR") && user?.roles.includes("BORROWER");
  const checklist = kyc?.checklist ?? {};
  const canSubmitAddressReview = Boolean(checklist.bvn && checklist.nin && checklist.proofOfAddress);

  async function handleEnableBorrower() {
    setSwitchingBusy(true);
    setSwitchMsg("");
    setError("");
    try {
      await addUserRole("BORROWER");
      setSwitchMsg("Borrower access enabled! Redirecting…");
      setTimeout(() => navigate("/borrower"), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to enable borrower access");
    } finally {
      setSwitchingBusy(false);
    }
  }

  return (
    <Layout>
      <div className="space-y-6">
        {/* Role switcher / enable borrower banner */}
        {user && (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-emerald-50 to-white dark:from-emerald-900/20 dark:to-slate-900 border border-emerald-100 dark:border-emerald-900/40">
            <div className="flex items-start gap-3">
              <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-100 to-emerald-50 dark:from-emerald-900 dark:to-emerald-900 text-emerald-600 dark:text-emerald-400">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M3 3v18h18M7 14l4-4 4 4 5-5"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div>
                <div className="text-sm font-bold text-velo-900 dark:text-white">
                  Investor Dashboard
                </div>
                {user.roles.includes("BORROWER") ? (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    You also have borrower access. Switch dashboards anytime — same KYC unlocks everything.
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    "Enable borrower access anytime. You can complete or continue KYC from the dashboard you choose."
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {hasBothRoles && (
                <Link
                  to="/borrower"
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-velo-600 to-velo-500 text-white text-sm font-semibold shadow-md shadow-velo-500/20 hover:shadow-lg hover:shadow-velo-500/30 hover:scale-[1.02] active:scale-[0.98] transition-all group"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  Switch to Borrower
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="group-hover:translate-x-0.5 transition-transform"
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
              )}
              {!user.roles.includes("BORROWER") && (
                <button
                  type="button"
                  onClick={handleEnableBorrower}
                  disabled={switchingBusy}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-velo-600 to-velo-500 text-white text-sm font-semibold shadow-md shadow-velo-500/20 hover:shadow-lg hover:shadow-velo-500/30 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                  title="Enable borrower access"
                >
                  {switchingBusy ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Enabling…
                    </>
                  ) : (
                    <>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <path
                          d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                        />
                      </svg>
                      Enable Borrower Access
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        )}

        {switchMsg && (
          <div className="rounded-xl border border-emerald-100 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 p-4 text-sm text-emerald-700 dark:text-emerald-400 flex items-start gap-2.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0 mt-0.5 text-emerald-500">
              <path d="M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {switchMsg}
          </div>
        )}

        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">
              Investor portal
            </p>
            <h1 className="mt-2 text-2xl font-bold text-velo-900 sm:text-3xl dark:text-white">
              Grow your money with clarity.
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              Welcome{user ? `, ${user.fullName}` : ""}. Complete KYC, fund your wallet, and manage your investment plans.
            </p>
          </div>
          <span
            className={`badge ${user?.kycStatus === "VERIFIED" ? "badge-completed" : "badge-pending"}`}
          >
            {user?.kycStatus === "VERIFIED" ? "KYC verified" : "KYC action required"}
          </span>
        </div>

        {error && (
          <div className="rounded-xl border border-red-100 bg-red-50 dark:bg-red-900/20 dark:border-red-900/30 p-4 text-sm text-red-700 dark:text-red-400">
            {error}
          </div>
        )}
        {message && (
          <div className="rounded-xl border border-emerald-100 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 p-4 text-sm text-emerald-700 dark:text-emerald-400">
            {message}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-3">
          <Metric
            label="Available wallet balance"
            value={money.format(available)}
            detail="Available for investment"
          />
          <Metric
            label="Locked investments"
            value={money.format(locked)}
            detail={`${investments.length} active investment(s)`}
          />
          <Metric
            label="Expected returns"
            value={money.format(returns)}
            detail="From loaded investment records"
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-[1.25fr_.75fr]">
          <section className="velo-card overflow-hidden p-5 sm:p-6"><div className="flex items-start justify-between gap-4"><div><h2 className="section-heading">Portfolio performance</h2><p className="section-subheading">Capital and expected earnings across your investments.</p></div><span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">{activeCount} active</span></div><div className="mt-6 grid grid-cols-3 gap-3"><div><p className="text-xs text-slate-500">Capital</p><p className="mt-1 text-base font-bold text-velo-900 dark:text-white">{money.format(totalCapital)}</p></div><div><p className="text-xs text-slate-500">Expected return</p><p className="mt-1 text-base font-bold text-emerald-600">{money.format(returns)}</p></div><div><p className="text-xs text-slate-500">Return ratio</p><p className="mt-1 text-base font-bold text-velo-900 dark:text-white">{returnRate}%</p></div></div><svg className="mt-6 h-24 w-full" viewBox="0 0 520 96" role="img" aria-label="Investment performance chart"><defs><linearGradient id="investor-chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#10b981" stopOpacity=".3"/><stop offset="1" stopColor="#10b981" stopOpacity="0"/></linearGradient></defs><path d="M0 80 C80 72 120 67 170 60 S250 66 310 42 S420 46 520 14 V96 H0Z" fill="url(#investor-chart-fill)"/><path d="M0 80 C80 72 120 67 170 60 S250 66 310 42 S420 46 520 14" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round"/></svg></section>
          <section className="velo-card p-5 sm:p-6"><h2 className="section-heading">Capital allocation</h2><p className="section-subheading">Where your money sits today.</p><div className="mx-auto mt-6 flex h-36 w-36 items-center justify-center rounded-full" style={{ background: `conic-gradient(#2196f3 0 38%, #10b981 38% 82%, #f59e0b 82% 100%)` }}><div className="flex h-24 w-24 flex-col items-center justify-center rounded-full bg-white dark:bg-slate-900"><span className="text-lg font-bold text-velo-900 dark:text-white">{money.format(totalCapital)}</span><span className="text-[10px] text-slate-500">total value</span></div></div><div className="mt-5 space-y-2 text-xs"><Legend color="bg-sky-500" label="Available wallet" value={money.format(available)} /><Legend color="bg-emerald-500" label="Locked investments" value={money.format(locked)} /><Legend color="bg-amber-500" label="Expected earnings" value={money.format(returns)} /></div></section>
        </div>

        <div className="grid gap-5 lg:grid-cols-[1.3fr_.7fr]">
          <section className="velo-card p-5 sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="section-heading">Complete your onboarding</h2>
                <p className="section-subheading">
                  Identity checks and payout setup are required before investment settlement.
                </p>
              </div>
              <span className="text-sm font-semibold text-velo-600">
                {user?.kycStatus === "VERIFIED" ? "5/5" : "0/5"}
              </span>
            </div>
            <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div
                className={`h-full rounded-full bg-velo-500 ${user?.kycStatus === "VERIFIED" ? "w-full" : "w-0"}`}
              />
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {[
                ["Identity info", "Legal name, DOB, contact"],
                ["BVN verification", "11-digit bank verification"],
                ["NIN verification", "National ID number check"],
                ["Proof of address", "Utility bill or statement"],
                ["Payout account", "Bank account for returns"],
              ].map(([t, d]) => (
                <div
                  key={t}
                  className={`flex items-start gap-3 p-3.5 rounded-xl border transition-colors ${
                    user?.kycStatus === "VERIFIED"
                      ? "bg-emerald-50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-900/30"
                      : "bg-slate-50 dark:bg-slate-800 border-slate-100 dark:border-slate-700"
                  }`}
                >
                  <div
                    className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                      user?.kycStatus === "VERIFIED"
                        ? "bg-emerald-500 text-white"
                        : "bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400"
                    }`}
                  >
                    {user?.kycStatus === "VERIFIED" ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.2" />
                      </svg>
                    )}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-velo-900 dark:text-white">{t}</div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{d}</div>
                  </div>
                </div>
              ))}
            </div>
            {kycError && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{kycError}</p>}
            {user?.kycStatus !== "VERIFIED" && (
              <div className="mt-6 space-y-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
                <p className="text-sm font-semibold text-velo-900 dark:text-white">Complete your verification</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="velo-label">
                    BVN
                    <div className="mt-1 flex gap-2">
                      <input className="velo-input min-w-0" inputMode="numeric" maxLength={11} value={bvn} onChange={(event) => setBvn(event.target.value.replace(/\D/g, ""))} placeholder="11-digit BVN" />
                      <button type="button" className="btn-secondary shrink-0" disabled={kycBusy === "BVN"} onClick={() => verifyIdentity("BVN")}>{kycBusy === "BVN" ? "Checking…" : checklist.bvn ? "Verified" : "Verify"}</button>
                    </div>
                  </label>
                  <label className="velo-label">
                    NIN
                    <div className="mt-1 flex gap-2">
                      <input className="velo-input min-w-0" inputMode="numeric" maxLength={11} value={nin} onChange={(event) => setNin(event.target.value.replace(/\D/g, ""))} placeholder="11-digit NIN" />
                      <button type="button" className="btn-secondary shrink-0" disabled={kycBusy === "NIN"} onClick={() => verifyIdentity("NIN")}>{kycBusy === "NIN" ? "Checking…" : checklist.nin ? "Verified" : "Verify"}</button>
                    </div>
                  </label>
                </div>

                <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-800/50 dark:bg-emerald-900/10">
                  <h3 className="mb-2 text-sm font-semibold text-emerald-800 dark:text-emerald-300">Liveness verification <span className="text-red-500">*</span></h3>
                  <p className="mb-3 text-xs text-emerald-700 dark:text-emerald-300/80">Complete a quick in-app selfie scan using our identity verification widget (recommended &amp; primary method).</p>
                  <div className="flex flex-wrap items-center gap-3">
                    <PremblyKycWidgetButton
                      fullName={user?.fullName}
                      email={user?.email}
                      phone={user?.phone}
                      idType={checklist.bvn ? "BVN" : "NIN"}
                      idNumber={bvn || nin || ""}
                      onResult={onPremblyLivenessResult}
                    />
                    {checklist.selfieUploaded && <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">✓ Liveness verified</span>}
                  </div>
                  <div className="mt-4 border-t border-emerald-200/70 pt-3 dark:border-emerald-700/40">
                    <details className="group">
                      <summary className="cursor-pointer text-xs font-medium text-slate-600 hover:text-slate-800 dark:text-slate-300 dark:hover:text-white">Having trouble with the camera? Click here to upload a selfie instead (fallback).</summary>
                      <div className="mt-2">
                        <label className="velo-label text-xs">
                          Upload live selfie
                          <input className="velo-input mt-1" type="file" accept="image/jpeg,image/png,image/webp" disabled={kycBusy === "LIVENESS_FILE"} onChange={(event) => { const file = event.target.files?.[0]; if (file) void verifyLivenessFile(file); }} />
                        </label>
                      </div>
                    </details>
                  </div>
                </div>

                <label className="velo-label block">
                  Proof of address
                  <input className="velo-input mt-1" type="file" accept="application/pdf,image/jpeg,image/png" disabled={kycBusy === "PROOF_OF_ADDRESS"} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadProofOfAddress(file); }} />
                  <span className="mt-1 block text-xs font-normal text-slate-500">Upload a recent utility bill or bank statement.</span>
                </label>
                <button type="button" onClick={submitAddressReview} disabled={!canSubmitAddressReview || busy || kyc?.status === "PENDING_VERIFICATION"} className="btn-primary inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50">
                  {busy ? "Submitting…" : kyc?.status === "PENDING_VERIFICATION" ? "Address under review" : "Submit proof of address for review"}
                </button>
                {!canSubmitAddressReview && <p className="text-xs text-slate-500">Verify BVN and NIN and upload proof of address before submitting for review.</p>}
              </div>
            )}
          </section>

          <section className="velo-card p-5 sm:p-6">
            <h2 className="section-heading">Quick actions</h2>
            <p className="section-subheading">Investor essentials at your fingertips.</p>
            <div className="mt-5 space-y-2.5">
              <button type="button" onClick={() => void openAction("fund")} className="w-full flex items-center justify-between gap-3 p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors group text-left">
                <div className="flex items-center gap-3">
                  <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500 text-white">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M3 3v18h18M7 14l4-4 4 4 5-5"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-velo-900 dark:text-white">
                      Fund wallet
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Deposit to start investing
                    </div>
                  </div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400 group-hover:text-emerald-600 group-hover:translate-x-0.5 transition-all">
                  <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button type="button" onClick={() => void openAction("plans")} className="w-full flex items-center justify-between gap-3 p-3.5 rounded-xl bg-velo-50 dark:bg-velo-900/30 hover:bg-velo-100 dark:hover:bg-velo-900/50 transition-colors group text-left">
                <div className="flex items-center gap-3">
                  <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-velo-500 text-white">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M12 6v6l4 2m5-2a9 9 0 11-18 0 9 9 0 0118 0z"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-velo-900 dark:text-white">
                      View investment plans
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      30–180 day tenors, up to 18%
                    </div>
                  </div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400 group-hover:text-velo-600 group-hover:translate-x-0.5 transition-all">
                  <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button type="button" onClick={() => void openAction("transactions")} className="w-full flex items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors group text-left">
                <div className="flex items-center gap-3">
                  <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-velo-700 to-velo-600 text-white">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-velo-900 dark:text-white">
                      Transaction history
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {transactions?.payouts?.length ?? 0} payout records
                    </div>
                  </div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400 group-hover:text-velo-600 group-hover:translate-x-0.5 transition-all">
                  <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            {action === "fund" && <form onSubmit={handleFundWallet} className="mt-4 flex gap-2"><input className="velo-input" type="number" min="1000" step="100" value={fundingAmount} onChange={(event) => setFundingAmount(event.target.value)} aria-label="Funding amount" /><button className="btn-primary shrink-0" type="submit">Continue to payment</button></form>}
            {action === "plans" && <div className="mt-4 space-y-2">{plans.map((plan) => <div key={plan.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700"><span className="font-semibold text-velo-900 dark:text-white">{plan.name} · {plan.tenureDays} days</span><span className="text-emerald-600">{plan.annualRatePercent}% p.a.</span></div>)}</div>}
            {action === "transactions" && <div className="mt-4 space-y-2 text-sm text-slate-600 dark:text-slate-300">{transactions?.payouts?.length ? transactions.payouts.map((payout, index) => <div key={index} className="flex justify-between"><span>{payout.status ?? "Payout"}</span><span>{money.format(Number(payout.amountNaira ?? 0))}</span></div>) : <p>No payout transactions yet.</p>}</div>}
          </section>
        </div>
      </div>
    </Layout>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="velo-card p-5">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-bold text-velo-900 dark:text-white break-words">{value}</p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{detail}</p>
    </div>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: string }) { return <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-slate-600 dark:text-slate-400"><span className={`h-2.5 w-2.5 rounded-full ${color}`} />{label}</span><strong className="text-velo-900 dark:text-white">{value}</strong></div>; }
