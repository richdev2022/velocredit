import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import { useAuth } from "../context/AuthContext";
import {
  getInvestorDashboard,
  getInvestorTransactions,
  submitKyc,
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

export default function InvestorDashboard() {
  const { user, addUserRole } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [transactions, setTransactions] = useState<TransactionData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [switchingBusy, setSwitchingBusy] = useState(false);
  const [switchMsg, setSwitchMsg] = useState("");

  useEffect(() => {
    if (!user) return;
    Promise.all([getInvestorDashboard(), getInvestorTransactions()])
      .then(([dashboard, history]) => {
        setData(dashboard as DashboardData);
        setTransactions(history as TransactionData);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Unable to load investor data")
      );
  }, [user]);

  async function startKyc() {
    setBusy(true);
    setMessage("");
    try {
      const response = (await submitKyc()) as { status?: string };
      setMessage(
        response.status === "PENDING_VERIFICATION"
          ? "KYC submitted for verification."
          : "KYC updated."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to submit KYC");
    } finally {
      setBusy(false);
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
  const isKycVerified = user?.kycStatus === "VERIFIED";

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
                    {isKycVerified
                      ? "You're verified! Enable borrower access to apply for loans anytime."
                      : "Complete KYC verification to access both investing and borrowing with a single account."}
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
                  disabled={switchingBusy || !isKycVerified}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-velo-600 to-velo-500 text-white text-sm font-semibold shadow-md shadow-velo-500/20 hover:shadow-lg hover:shadow-velo-500/30 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                  title={!isKycVerified ? "Complete KYC first to enable borrower access" : ""}
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
            {user?.kycStatus !== "VERIFIED" && (
              <button
                type="button"
                onClick={startKyc}
                disabled={busy}
                className="btn-primary mt-6 inline-flex items-center gap-2"
              >
                {busy ? "Submitting…" : "Submit KYC for review"}
              </button>
            )}
          </section>

          <section className="velo-card p-5 sm:p-6">
            <h2 className="section-heading">Quick actions</h2>
            <p className="section-subheading">Investor essentials at your fingertips.</p>
            <div className="mt-5 space-y-2.5">
              <div className="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors group cursor-pointer">
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
              </div>
              <div className="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-velo-50 dark:bg-velo-900/30 hover:bg-velo-100 dark:hover:bg-velo-900/50 transition-colors group cursor-pointer">
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
              </div>
              <div className="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors group cursor-pointer">
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
              </div>
            </div>
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
