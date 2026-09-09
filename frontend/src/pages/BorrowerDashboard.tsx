import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import { useAuth } from "../context/AuthContext";
import { getBorrowerCreditScore, getBorrowerDashboard, updateBorrowerDisbursementAccount } from "../services/apiClient";

type DashboardData = {
  applications?: Array<{ status?: string; amountNaira?: number; outstandingNaira?: number; submittedAt?: string }>;
  payments?: Array<{ status?: string; amountNaira?: number }>;
  repayments?: Array<{ status?: string; amountNaira?: number; createdAt?: string }>;
  disbursementAccount?: { accountNumber?: string; accountName?: string; bankName?: string; status?: string } | null;
};
type CreditData = {
  score?: { score?: number; band?: string; factors?: Array<{ label: string; detail: string; impact: number }> };
};

export default function BorrowerDashboard() {
  const { user, addUserRole } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [credit, setCredit] = useState<CreditData | null>(null);
  const [error, setError] = useState("");
  const [switchingBusy, setSwitchingBusy] = useState(false);
  const [switchMsg, setSwitchMsg] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountMsg, setAccountMsg] = useState("");

  useEffect(() => {
    if (!user) return;
    Promise.all([getBorrowerDashboard(), getBorrowerCreditScore()])
      .then(([dashboard, score]) => {
        setData(dashboard as DashboardData);
        setCredit(score as CreditData);
        const account = (dashboard as DashboardData).disbursementAccount;
        setAccountNumber(account?.accountNumber ?? "");
        setAccountName(account?.accountName ?? "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load borrower data"));
  }, [user]);

  const active = data?.applications?.find((loan) =>
    ["ACTIVE", "DISBURSED", "PAST_DUE"].includes(String(loan.status))
  );
  const applicationStatus = data?.applications?.[0]?.status ?? "NOT_STARTED";
  const hasSubmittedApplication = data?.applications?.some((application) =>
    Boolean(application.submittedAt) ||
    !["DRAFT", "IN_PROGRESS", "MORE_INFORMATION_REQUIRED"].includes(String(application.status))
  ) ?? false;

  const hasBothRoles = user?.roles.includes("INVESTOR") && user?.roles.includes("BORROWER");
  const isKycVerified = user?.kycStatus === "VERIFIED";
  const repayments = data?.repayments ?? data?.payments ?? [];
  const paidRepayments = repayments.filter((payment) => ["SUCCESSFUL", "COMPLETED"].includes(String(payment.status))).reduce((sum, payment) => sum + Number(payment.amountNaira ?? 0), 0);
  const scheduledRepayments = repayments.reduce((sum, payment) => sum + Number(payment.amountNaira ?? 0), 0);
  const repaymentProgress = scheduledRepayments ? Math.min(100, Math.round((paidRepayments / scheduledRepayments) * 100)) : 0;

  async function handleEnableInvestor() {
    setSwitchingBusy(true);
    setSwitchMsg("");
    setError("");
    try {
      await addUserRole("INVESTOR");
      setSwitchMsg("Investor access enabled! Redirecting…");
      setTimeout(() => navigate("/investor"), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to enable investor access");
    } finally {
      setSwitchingBusy(false);
    }
  }

  async function handleSaveAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAccountBusy(true);
    setAccountMsg("");
    setError("");
    try {
      const response = await updateBorrowerDisbursementAccount({ accountNumber, accountName });
      setData((current) => current ? { ...current, disbursementAccount: response.disbursementAccount } : current);
      setAccountMsg("Velo disbursement account saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save disbursement account");
    } finally {
      setAccountBusy(false);
    }
  }

  return (
    <Layout>
      <div className="space-y-6">
        {/* Role switcher / enable investor banner */}
        {user && (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-slate-50 to-white dark:from-slate-900 dark:to-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-start gap-3">
              <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-velo-100 to-velo-50 dark:from-velo-900 dark:to-velo-900 text-velo-600 dark:text-velo-400">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div>
                <div className="text-sm font-bold text-velo-900 dark:text-white">Borrower Dashboard</div>
                {user.roles.includes("INVESTOR") ? (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    You also have investor access. Switch dashboards anytime — one KYC, all features.
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {isKycVerified
                      ? "Great news — you're verified! Enable investor access to start earning up to 18% p.a."
                      : "Complete your KYC to unlock both borrower and investor features with one verification."}
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {hasBothRoles && (
                <Link
                  to="/investor"
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 text-white text-sm font-semibold shadow-md shadow-emerald-500/20 hover:shadow-lg hover:shadow-emerald-500/30 hover:scale-[1.02] active:scale-[0.98] transition-all group"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M3 3v18h18M7 14l4-4 4 4 5-5"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  Switch to Investor
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
              {!user.roles.includes("INVESTOR") && (
                <button
                  type="button"
                  onClick={handleEnableInvestor}
                  disabled={switchingBusy || !isKycVerified}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 text-white text-sm font-semibold shadow-md shadow-emerald-500/20 hover:shadow-lg hover:shadow-emerald-500/30 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                  title={!isKycVerified ? "Complete KYC first to enable investor access" : ""}
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
                      Enable Investor Access
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

        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Borrower portal</p>
          <h1 className="mt-2 text-2xl font-bold text-velo-900 sm:text-3xl dark:text-white">Your loan, in one place.</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
            Welcome{user ? `, ${user.fullName}` : ""}. Track applications, repayments, account verification, and credit history.
          </p>
        </div>

        {error && (
          <div className="rounded-xl border border-red-100 bg-red-50 dark:bg-red-900/20 dark:border-red-900/30 p-4 text-sm text-red-700 dark:text-red-400">
            {error}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-3">
          <Metric
            label="Application status"
            value={applicationStatus.replace(/_/g, " ")}
            detail={`${data?.applications?.length ?? 0} application(s)`}
          />
          <Metric
            label="Outstanding balance"
            value={`₦${Number(active?.outstandingNaira ?? 0).toLocaleString("en-NG")}`}
            detail={active ? "Active loan balance" : "No active loan"}
          />
          <Metric
            label="Internal credit score"
            value={credit?.score?.score ? String(credit.score.score) : "—"}
            detail={credit?.score?.band?.replace(/_/g, " ") ?? "Loading score"}
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-[1.25fr_.75fr]">
          <section className="velo-card overflow-hidden p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4"><div><h2 className="section-heading">Repayment health</h2><p className="section-subheading">A simple view of your repayment progress.</p></div><span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">{repaymentProgress}% paid</span></div>
            <div className="mt-6 h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full rounded-full bg-gradient-to-r from-velo-500 to-emerald-500 transition-all" style={{ width: `${repaymentProgress}%` }} /></div>
            <div className="mt-4 grid grid-cols-2 gap-4"><div><p className="text-xs text-slate-500">Paid to date</p><p className="mt-1 text-lg font-bold text-velo-900 dark:text-white">₦{paidRepayments.toLocaleString("en-NG")}</p></div><div><p className="text-xs text-slate-500">Recorded schedule</p><p className="mt-1 text-lg font-bold text-velo-900 dark:text-white">₦{scheduledRepayments.toLocaleString("en-NG")}</p></div></div>
            <svg className="mt-6 h-20 w-full" viewBox="0 0 520 80" role="img" aria-label="Repayment progress chart"><defs><linearGradient id="borrower-chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#2196f3" stopOpacity=".28"/><stop offset="1" stopColor="#2196f3" stopOpacity="0"/></linearGradient></defs><path d="M0 68 C80 60 110 64 170 46 S270 53 330 30 S430 35 520 12 V80 H0Z" fill="url(#borrower-chart-fill)"/><path d="M0 68 C80 60 110 64 170 46 S270 53 330 30 S430 35 520 12" fill="none" stroke="#2196f3" strokeWidth="3" strokeLinecap="round"/></svg>
          </section>
          <section className="velo-card p-5 sm:p-6"><div className="flex items-start justify-between"><div><h2 className="section-heading">Credit posture</h2><p className="section-subheading">Your current internal score.</p></div><div className="relative flex h-20 w-20 items-center justify-center rounded-full" style={{ background: `conic-gradient(#2196f3 ${Math.max(0, Math.min(100, ((credit?.score?.score ?? 300) - 300) / 5.5))}%, #e8eef5 0)` }}><div className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-xl font-bold text-velo-900 dark:bg-slate-900 dark:text-white">{credit?.score?.score ?? "—"}</div></div></div><p className="mt-5 text-sm font-semibold text-velo-900 dark:text-white">{credit?.score?.band?.replace(/_/g, " ") ?? "Score pending"}</p><p className="mt-1 text-xs leading-5 text-slate-500">Keep repayments current and complete your profile to maintain a healthy borrowing position.</p></section>
        </div>

        <div className="grid gap-5 lg:grid-cols-[1.2fr_.8fr]">
          <section className="velo-card p-5 sm:p-6">
            <h2 className="section-heading">Loan application</h2>
            <p className="section-subheading">
              Your system decision appears here before a loan manager completes manual review.
            </p>
            {data?.applications?.[0] ? (
              <div className="mt-5 rounded-xl border border-slate-100 p-4 dark:border-slate-700">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-velo-900 dark:text-white">Latest application</span>
                  <span className="badge badge-pending">
                    {String(data.applications[0].status).replace(/_/g, " ")}
                  </span>
                </div>
                <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
                  Requested amount: ₦{Number(data.applications[0].amountNaira ?? 0).toLocaleString("en-NG")}
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-500">Disbursement institution: Velo</p>
              </div>
            ) : (
              <div className="mt-5 rounded-xl border border-dashed border-slate-200 p-8 text-center dark:border-slate-700">
                <p className="text-sm font-semibold text-velo-900 dark:text-white">No applications yet</p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 mb-4">
                  Start a new loan application when you're ready.
                </p>
                <Link to="/apply" className="btn-primary inline-flex items-center gap-2">
                  Start Application
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
              </div>
            )}

            <div className="mt-6 flex flex-wrap gap-3">
              <Link to="/apply" className="btn-primary inline-flex items-center gap-2">
                {data?.applications?.[0] ? "Continue Application" : "New Application"}
              </Link>
            </div>
          </section>

          <section className="velo-card p-5 sm:p-6">
            <h2 className="section-heading">Quick actions</h2>
            <p className="section-subheading">Manage your borrower profile.</p>
            <div className="mt-5 space-y-2.5">
              <Link
                to="/apply"
                className="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-velo-50 dark:bg-velo-900/30 hover:bg-velo-100 dark:hover:bg-velo-900/50 transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-velo-500 text-white">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-velo-900 dark:text-white">Apply for a loan</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">Personal or business funding</div>
                  </div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400 group-hover:text-velo-500 group-hover:translate-x-0.5 transition-all">
                  <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Link>
              <div className="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors group cursor-pointer">
                <div className="flex items-center gap-3">
                  <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500 text-white">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-velo-900 dark:text-white">KYC Status</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {user?.kycStatus?.replace(/_/g, " ") ?? "Not started"}
                    </div>
                  </div>
                </div>
                <span
                  className={`badge ${
                    user?.kycStatus === "VERIFIED" ? "badge-completed" : "badge-pending"
                  }`}
                >
                  {user?.kycStatus?.replace(/_/g, " ") ?? "Not started"}
                </span>
              </div>
            </div>
          </section>
        </div>

        <section className="velo-card p-5 sm:p-6">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="section-heading">Disbursement account</h2>
              <p className="section-subheading">Your loan will be disbursed to this Velo account.</p>
            </div>
            {data?.disbursementAccount?.status && (
              <span className="badge badge-pending">{data.disbursementAccount.status.replace(/_/g, " ")}</span>
            )}
          </div>
          {hasSubmittedApplication ? (
            <p className="mt-5 rounded-xl border border-amber-100 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/30 dark:bg-amber-900/20 dark:text-amber-300">
              This account is locked because you have submitted a loan application.
            </p>
          ) : (
            <form className="mt-5 grid gap-4 md:grid-cols-3 md:items-end" onSubmit={handleSaveAccount}>
              <label className="velo-label">
                Bank
                <select className="velo-input mt-1" value="VELO" disabled>
                  <option value="VELO">Velo</option>
                </select>
              </label>
              <label className="velo-label">
                Velo account number<span className="text-red-500 ml-0.5">*</span>
                <input
                  className="velo-input mt-1"
                  inputMode="numeric"
                  maxLength={10}
                  pattern="[0-9]{10}"
                  placeholder="10-digit account number"
                  required
                  value={accountNumber}
                  onChange={(event) => setAccountNumber(event.target.value.replace(/\D/g, ""))}
                />
              </label>
              <label className="velo-label">
                Account name<span className="text-red-500 ml-0.5">*</span>
                <input
                  className="velo-input mt-1"
                  minLength={2}
                  placeholder="Name on the account"
                  required
                  value={accountName}
                  onChange={(event) => setAccountName(event.target.value)}
                />
              </label>
              <div className="md:col-span-3 flex flex-wrap items-center gap-3">
                <button className="btn-primary" type="submit" disabled={accountBusy || accountNumber.length !== 10 || accountName.trim().length < 2}>
                  {accountBusy ? "Saving..." : data?.disbursementAccount ? "Update account" : "Save account"}
                </button>
                {accountMsg && <span className="text-sm text-emerald-700 dark:text-emerald-400">{accountMsg}</span>}
              </div>
            </form>
          )}
        </section>
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
