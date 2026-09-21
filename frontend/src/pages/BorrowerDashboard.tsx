import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import { useAuth } from "../context/AuthContext";
import {
  getBorrowerCreditScore,
  getBorrowerDashboard,
  getBorrowerCreditHistory,
  getBorrowerLoans,
  getMyKyc,
  initializeLoanRepayment,
} from "../services/apiClient";
import BorrowerDisbursementSection from "../components/BorrowerDisbursementSection";
import OtpLoginSettings from "../components/OtpLoginSettings";
import ProfileSettings from "../components/ProfileSettings";
import Icon from "../components/Icon";

function formatLoanStatus(status?: string): string {
  const labels: Record<string, string> = {
    SUBMITTED: "Under review",
    KYC_PENDING: "Verification required",
    UNDER_REVIEW: "Under review",
    MORE_INFORMATION_REQUIRED: "More information required",
    APPROVED: "Approved — awaiting disbursement",
    DISBURSEMENT_PENDING: "Disbursement processing",
    DISBURSED: "Disbursed",
    ACTIVE: "Active",
    PAST_DUE: "Past due",
    REPAID: "Repaid",
  };
  return labels[String(status ?? "").toUpperCase()] ?? String(status ?? "—").replace(/_/g, " ");
}

type DashboardData = {
  applications?: Array<{
    id?: string;
    status?: string;
    amountNaira?: number;
    outstandingNaira?: number;
    submittedAt?: string;
    tenureDays?: number;
    interestRatePercent?: number;
    productName?: string;
    disbursedAt?: string;
    maturityDate?: string;
  }>;
  loans?: Array<{
    id?: string;
    status?: string;
    amountNaira?: number;
    outstandingNaira?: number;
    principalNaira?: number;
    applicationId?: string;
    tenureDays?: number;
    disbursedAt?: string;
    dueAt?: string;
    totalRepaymentNaira?: number;
    schedule?: Array<{ totalDueNaira?: number }>;
  }>;
  payments?: Array<{ status?: string; amountNaira?: number }>;
  repayments?: Array<{
    id?: string;
    status?: string;
    amountNaira?: number;
    dueDate?: string;
    paidAt?: string;
    createdAt?: string;
    loanId?: string;
  }>;
  disbursementAccount?: {
    id?: string;
    accountNumber?: string;
    accountName?: string;
    bankName?: string;
    bankCode?: string;
    status?: string;
  } | null;
  creditHistory?: unknown[];
};
type CreditData = {
  score?: {
    score?: number;
    band?: string;
    factors?: Array<{ label: string; detail: string; impact: number }>;
    sources?: Record<string, number>;
    calculatedAt?: string;
  };
};

type RepaymentRecord = {
  id?: string;
  status?: string;
  amountNaira?: number;
  dueDate?: string;
  paidAt?: string;
  createdAt?: string;
  loanId?: string;
};

function repaymentDate(record: RepaymentRecord): number {
  const value = record.paidAt ?? record.createdAt ?? record.dueDate;
  return value ? new Date(value).getTime() : 0;
}

export function sortRepaymentsRecentFirst(records: RepaymentRecord[]): RepaymentRecord[] {
  return records.slice().sort((a, b) => repaymentDate(b) - repaymentDate(a));
}

export function repaymentProgressValues(repayments: RepaymentRecord[], loans: DashboardData["loans"] = []) {
  const paid = repayments
    .filter((payment) => ["SUCCESSFUL", "COMPLETED"].includes(String(payment.status)))
    .reduce((sum, payment) => sum + Number(payment.amountNaira ?? 0), 0);
  const scheduled = loans.reduce((sum, loan) => {
    const schedule = (loan as { schedule?: Array<{ totalDueNaira?: number }> }).schedule;
    const scheduleTotal = schedule?.reduce((total, installment) => total + Number(installment.totalDueNaira ?? 0), 0) ?? 0;
    return sum + (scheduleTotal || Number((loan as { totalRepaymentNaira?: number }).totalRepaymentNaira ?? 0));
  }, 0);
  const progress = scheduled > 0 ? Math.min(100, Math.round((paid / scheduled) * 100)) : 0;
  return { paid, scheduled, progress };
}

export function paginateRepayments(records: RepaymentRecord[], page: number, pageSize: number) {
  const sorted = sortRepaymentsRecentFirst(records);
  return { records: sorted.slice((page - 1) * pageSize, page * pageSize), totalPages: Math.max(1, Math.ceil(sorted.length / pageSize)) };
}

function MenuIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = { grid: <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>, document: <><path d="M7 3h7l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></>, wallet: <><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/></>, star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>, check: <path d="m5 12 4 4L19 6"/>, bank: <><path d="M3 10h18M5 10v8m4-8v8m6-8v8m4-8v8M3 20h18L12 4 3 10Z"/></>, user: <><circle cx="12" cy="8" r="3"/><path d="M5 21c.8-4 3.1-6 7-6s6.2 2 7 6"/></> };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.grid}</svg>;
}

type BorrowerView = "overview" | "applications" | "repayments" | "kyc" | "account" | "credit" | "profile";

export default function BorrowerDashboard() {
  const { user, addUserRole } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null as DashboardData | null);
  const [credit, setCredit] = useState(null as CreditData | null);
  const [error, setError] = useState("");
  const [switchingBusy, setSwitchingBusy] = useState(false);
  const [switchMsg, setSwitchMsg] = useState("");
  const [view, setView] = useState(() => {
    // Persist the current view in the URL hash so refresh keeps the user on
    // the same page.
    const hash = window.location.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    const v = params.get("view") as BorrowerView | null;
    const valid: BorrowerView[] = ["overview", "applications", "repayments", "kyc", "account", "credit", "profile"];
    return v && valid.includes(v) ? v : "overview";
  });

  useEffect(() => {
    const params = new URLSearchParams();
    if (view !== "overview") params.set("view", view);
    const hash = params.toString();
    const target = hash ? `#${hash}` : "#";
    if (window.location.hash !== target) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${target}`);
    }
  }, [view]);

  // Follow the hash on browser back/forward (parity with the admin dashboard).
  useEffect(() => {
    function onHashChange() {
      const hash = window.location.hash.replace(/^#/, "");
      const params = new URLSearchParams(hash);
      const v = params.get("view") as BorrowerView | null;
      const valid: BorrowerView[] = ["overview", "applications", "repayments", "kyc", "account", "credit", "profile"];
      if (v && valid.includes(v)) setView(v);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const [successMsg, setSuccessMsg] = useState("");
  const [repayBusy, setRepayBusy] = useState(null as string | null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [repayModalOpen, setRepayModalOpen] = useState(false);
  const [repayModalLoan, setRepayModalLoan] = useState<{ id: string; outstandingNaira: number; principalNaira?: number; refNo?: string; displayTitle?: string; } | null>(null);
  const [repayCustomAmount, setRepayCustomAmount] = useState("");
  const [repayMode, setRepayMode] = useState<"full" | "custom">("full");
  const [repaySubmitting, setRepaySubmitting] = useState(false);
  const [repayModeMsg, setRepayModeMsg] = useState("");

  const borrowerMenu: Array<{ key: BorrowerView; label: string; icon: string; hint?: string }> = [
    { key: "overview", label: "Overview", icon: "grid", hint: "Summary & KPIs" },
    { key: "applications", label: "Applications", icon: "document", hint: "Loan requests" },
    { key: "repayments", label: "Repayments", icon: "wallet", hint: "Schedules & history" },
    { key: "credit", label: "Credit score", icon: "star", hint: "Score & factors" },
    { key: "kyc", label: "Verification", icon: "check", hint: "Identity checks" },
    { key: "account", label: "Disbursement", icon: "bank", hint: "Bank account" },
    { key: "profile", label: "Profile", icon: "user", hint: "Personal information" },
  ];

  useEffect(() => {
    if (!user) return;
    Promise.all([
      getBorrowerDashboard(),
      getBorrowerCreditScore(),
      getBorrowerLoans(),
      getBorrowerCreditHistory().catch(() => ({ ok: true, events: [], scores: [], reports: [] })),
    ])
      .then(([dashboard, score, loans, history]) => {
        const d = dashboard as unknown as DashboardData;
        setData({
          ...d,
          loans: Array.isArray((loans as { loans?: unknown[] }).loans)
            ? ((loans as { loans: unknown[] }).loans as DashboardData["loans"])
            : [],
          creditHistory: (history as { events?: unknown[] }).events ?? [],
        });
        setCredit(score as CreditData);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load borrower data"));
  }, [user]);

  const active = data?.loans?.find((loan) =>
    ["DISBURSEMENT_PENDING", "ACTIVE", "DISBURSED", "PAST_DUE", "DEFAULTED"].includes(String(loan.status))
  );
  const applicationStatus = data?.applications?.[0]?.status ?? "NOT_STARTED";
  const hasSubmittedApplication = Boolean(
    data?.applications?.some((application) =>
      ["SUBMITTED", "KYC_PENDING", "UNDER_REVIEW", "MORE_INFORMATION_REQUIRED"].includes(String(application.status))
    ) || data?.loans?.some((loan) => !["REPAID", "CANCELLED", "WRITTEN_OFF"].includes(String(loan.status)))
  );

  const hasBothRoles = user?.roles.includes("INVESTOR") && user?.roles.includes("BORROWER");
  const repayments = data?.repayments ?? data?.payments ?? [];
  const repaymentTotals = repaymentProgressValues(repayments, data?.loans);
  const paidRepayments = repaymentTotals.paid;
  const scheduledRepayments = repaymentTotals.scheduled;
  const repaymentProgress = repaymentTotals.progress;

  useEffect(() => {
    if (error || switchMsg || successMsg) {
      const t = setTimeout(() => {
        setError("");
        setSwitchMsg("");
        setSuccessMsg("");
      }, 6000);
      return () => clearTimeout(t);
    }
  }, [error, switchMsg, successMsg]);

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

  function openRepayModal(loanId: string, outstandingNaira: number, principalNaira?: number, refNo?: string, displayTitle?: string) {
    if (!loanId || !outstandingNaira) return;
    setRepayModalLoan({ id: loanId, outstandingNaira: Number(outstandingNaira) || 0, principalNaira: Number(principalNaira) || undefined, refNo, displayTitle });
    setRepayMode("full");
    setRepayCustomAmount("");
    setRepayModeMsg("");
    setError("");
    setRepayModalOpen(true);
  }

  function closeRepayModal() {
    if (repaySubmitting) return;
    setRepayModalOpen(false);
    setRepayModeMsg("");
  }

  async function handleSubmitRepayment() {
    if (!repayModalLoan || repaySubmitting) return;
    const max = Number(repayModalLoan.outstandingNaira || 0);
    const min = 50;
    let amountNaira: number;
    if (repayMode === "full") {
      amountNaira = max;
    } else {
      const clean = String(repayCustomAmount || "").replace(/[^0-9.]/g, "");
      amountNaira = Number(clean);
      if (!clean || !Number.isFinite(amountNaira) || amountNaira <= 0) {
        setRepayModeMsg("Enter a valid amount to continue");
        return;
      }
      if (amountNaira < min) {
        setRepayModeMsg(`Minimum part-payment cannot be below ₦${min.toLocaleString("en-NG")}`);
        return;
      }
      if (amountNaira > max + 0.01) {
        setRepayModeMsg(`You cannot pay up to ₦${max.toLocaleString("en-NG")}. Tap “Pay in full”`);
        return;
      }
    }
    setRepaySubmitting(true);
    setRepayModeMsg("");
    setError("");
    try {
      const res = await initializeLoanRepayment(repayModalLoan.id, amountNaira);
      const checkoutUrl = res.checkout?.url || res.checkout?.link;
      if (checkoutUrl) {
        window.location.assign(checkoutUrl);
      } else {
        setRepayModeMsg(res.error || res.message || "Payment checkout not available right now");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unable to initiate repayment";
      if (/Minimum|outstanding|No repayment needed/.test(msg)) {
        setRepayModeMsg(msg);
      } else {
        setError(msg);
      }
    } finally {
      setRepaySubmitting(false);
    }
  }

  async function handleRepayNow(loanId: string, amountNaira: number, principalNaira?: number, refNo?: string, displayTitle?: string) {
    openRepayModal(loanId, amountNaira, principalNaira, refNo, displayTitle);
  }

  return (
    <Layout>
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-40 bg-slate-900/50 backdrop-blur-sm lg:hidden animate-fade-in"
        />
      )}

      <div className="flex flex-col lg:flex-row gap-4 sm:gap-6 min-h-[calc(100vh-10rem)]">
        <aside
          className={`fixed lg:static z-50 top-0 left-0 h-full w-80 max-w-[86vw] lg:w-72 shrink-0 lg:h-auto transition-transform duration-300 ease-out lg:transform-none ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="lg:hidden absolute top-4 right-4 z-10">
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close sidebar"
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-white/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 shadow-sm hover:bg-white dark:hover:bg-slate-800 transition"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <div className="velo-card p-4 sm:p-5 rounded-2xl lg:rounded-2xl border-0 dark:border-slate-800 shadow-[0_20px_60px_-20px_rgba(79,70,229,0.12)] dark:shadow-none lg:sticky top-4 overflow-hidden bg-gradient-to-br from-indigo-50 via-white to-white dark:from-slate-900 dark:via-slate-900 dark:to-slate-900 relative lg:h-[calc(100vh-2rem)] h-screen lg:min-h-0">
            <div className="absolute -top-12 -right-12 w-40 h-40 rounded-full bg-indigo-400/20 blur-3xl pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-32 h-32 rounded-full bg-velo-400/10 blur-3xl pointer-events-none" />
            <div className="relative overflow-y-auto lg:overflow-y-auto lg:max-h-full max-h-screen pb-20 lg:pb-4 pr-1">
              <div className="flex items-center gap-3 p-3 rounded-2xl bg-white/60 dark:bg-slate-800/60 border border-indigo-100/70 dark:border-slate-700/60 backdrop-blur">
                <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-velo-500 to-indigo-600 text-white font-black text-lg shadow-md shadow-indigo-500/30">
                  {user?.fullName?.charAt(0)?.toUpperCase() || "V"}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-velo-900 dark:text-white truncate">
                    {user?.fullName || "Borrower"}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                    {user?.email || "Welcome aboard"}
                  </div>
                </div>
              </div>

              <nav className="mt-5 sm:mt-6 space-y-1">
                {borrowerMenu.map((item) => {
                  const isActive = view === item.key;
                  return (
                    <button
                      key={item.key}
                      onClick={() => {
                        setView(item.key);
                        setError("");
                        setSuccessMsg("");
                        setSwitchMsg("");
                        setSidebarOpen(false);
                      }}
                      className={`w-full group flex items-center gap-3 px-3.5 py-2.5 sm:py-3 rounded-xl transition-all duration-200 text-left ${
                        isActive
                          ? "bg-gradient-to-r from-velo-600 to-velo-500 text-white shadow-md shadow-velo-500/25 hover:shadow-lg hover:shadow-velo-500/30"
                          : "text-slate-600 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-slate-800/60 hover:text-velo-900 dark:hover:text-white"
                      }`}
                    >
                      <span className={`text-xl shrink-0 ${isActive ? "" : "opacity-90"}`}>
                        <MenuIcon name={item.icon} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-bold ${isActive ? "" : "group-hover:font-extrabold"}`}>
                          {item.label}
                        </div>
                        {item.hint && (
                          <div
                            className={`text-[10px] truncate ${
                              isActive ? "text-indigo-50/90" : "text-slate-500 dark:text-slate-400"
                            }`}
                          >
                            {item.hint}
                          </div>
                        )}
                      </div>
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        className={`shrink-0 transition-transform ${
                          isActive
                            ? "text-white translate-x-0.5"
                            : "text-slate-400 group-hover:translate-x-0.5"
                        }`}
                      >
                        <path
                          d="M9 6l6 6-6 6"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  );
                })}
              </nav>

              <div className="mt-6 sm:mt-8 pt-4 sm:pt-5 border-t border-indigo-100/80 dark:border-slate-800">
                <div className="rounded-2xl bg-gradient-to-br from-velo-600 via-velo-700 to-indigo-700 text-white p-4 shadow-lg shadow-velo-600/20">
                  <div className="text-[11px] uppercase tracking-wider font-bold text-indigo-100/85">
                    Account status
                  </div>
                  <div className="mt-1 inline-flex items-center gap-2 text-lg font-black">
                    {hasSubmittedApplication ? <><Icon name="history" size={18} />Application started</> : user?.kycStatus === "VERIFIED" ? <><Icon name="check" size={18} />Verified — apply now</> : <><Icon name="lock" size={18} />Complete KYC first</>}
                  </div>
                  <div className="mt-1 text-[11px] text-indigo-100/80">
                    {!hasSubmittedApplication ? (
                      <Link
                        to="/apply"
                        className="underline underline-offset-2 font-semibold hover:text-white"
                      >
                        <span className="inline-flex items-center gap-1">Start a new loan application <Icon name="arrowRight" size={13} /></span>
                      </Link>
                    ) : (
                      "You can track every stage of your request here."
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>

        <main className="flex-1 min-w-0 space-y-4 sm:space-y-6">
          <div className="lg:hidden flex items-center gap-3 mb-2 sm:mb-1">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation"
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl velo-card border-0 text-velo-900 dark:text-white shadow-sm hover:shadow transition hover:bg-velo-50 dark:hover:bg-slate-800"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">Borrower dashboard</div>
              <div className="text-base font-extrabold text-velo-900 dark:text-white truncate">
                {borrowerMenu.find((m) => m.key === view)?.label || "Overview"}
              </div>
            </div>
          </div>

          {successMsg && (
            <div className="rounded-xl border border-emerald-100 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 p-4 text-sm text-emerald-700 dark:text-emerald-400 flex items-start gap-2.5">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                className="shrink-0 mt-0.5 text-emerald-500"
              >
                <path
                  d="M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {successMsg}
            </div>
          )}
          {switchMsg && (
            <div className="rounded-xl border border-emerald-100 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 p-4 text-sm text-emerald-700 dark:text-emerald-400 flex items-start gap-2.5">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                className="shrink-0 mt-0.5 text-emerald-500"
              >
                <path
                  d="M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {switchMsg}
            </div>
          )}
          {error && (
            <div className="rounded-xl border border-red-100 bg-red-50 dark:bg-red-900/20 dark:border-red-900/30 p-4 text-sm text-red-700 dark:text-red-400 flex items-start gap-2.5">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                className="shrink-0 mt-0.5 text-red-500"
              >
                <path
                  d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {error}
            </div>
          )}

          {view === "overview" && (
            <BorrowerOverview
              user={user}
              hasBothRoles={hasBothRoles}
              switchingBusy={switchingBusy}
              handleEnableInvestor={handleEnableInvestor}
              data={data}
              credit={credit}
              applicationStatus={applicationStatus}
              hasSubmittedApplication={hasSubmittedApplication}
              repaymentProgress={repaymentProgress}
              paidRepayments={paidRepayments}
              scheduledRepayments={scheduledRepayments}
              active={active}
              repayBusy={repayBusy}
              handleRepayNow={handleRepayNow}
            />
          )}
          {view === "applications" && (
            <BorrowerApplications
              data={data}
              hasSubmittedApplication={hasSubmittedApplication}
            />
          )}
          {view === "repayments" && (
            <BorrowerRepayments
              repayments={repayments}
              repaymentProgress={repaymentProgress}
              paidRepayments={paidRepayments}
              scheduledRepayments={scheduledRepayments}
              active={active}
              repayBusy={repayBusy}
              handleRepayNow={handleRepayNow}
            />
          )}
          {view === "credit" && (
            <BorrowerCredit credit={credit} history={data?.creditHistory ?? []} />
          )}
          {view === "kyc" && <BorrowerKyc user={user} />}
          {view === "account" && (
            <BorrowerDisbursementSection
              userId={user?.id}
              initial={data?.disbursementAccount ?? null}
              locked={hasSubmittedApplication}
              onSaved={(acc) => {
                setData((d) => (d ? { ...d, disbursementAccount: acc } : d));
                setSuccessMsg(
                  acc?.status === "PENDING_APPROVAL"
                    ? "Your disbursement account update has been submitted for admin approval."
                    : "Disbursement account saved successfully."
                );
              }}
              onError={(msg) => setError(msg)}
            />
          )}
          {view === "profile" && <BorrowerProfile user={user} />}
        </main>

        {repayModalOpen && repayModalLoan && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="repay-modal-title"
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center animate-fade-in"
          >
            <button
              type="button"
              aria-label="Close repayment dialog"
              onClick={closeRepayModal}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <div className="relative w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl bg-white dark:bg-slate-900 border-t sm:border border-slate-200 dark:border-slate-800 shadow-2xl animate-[slideInUp_260ms_cubic-bezier(0.22,1,0.36,1)] max-h-[92vh] overflow-y-auto">
              <div className="p-5 sm:p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                          <path d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                      <div
                        id="repay-modal-title"
                        className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-600 dark:text-emerald-400"
                      >
                        Repayment
                      </div>
                    </div>
                    <h2 className="mt-1.5 text-xl sm:text-2xl font-black text-velo-900 dark:text-white">
                      {repayModalLoan.displayTitle || "Make a repayment"}
                    </h2>
                    {repayModalLoan.refNo && (
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        Loan ref <span className="font-mono font-semibold text-slate-700 dark:text-slate-300">{repayModalLoan.refNo}</span>
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={closeRepayModal}
                    disabled={repaySubmitting}
                    aria-label="Close"
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 transition"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>

                <div className="mt-5 rounded-2xl border border-emerald-100 dark:border-emerald-900/40 bg-gradient-to-br from-emerald-50 via-white to-white dark:from-emerald-900/20 dark:via-slate-900 dark:to-slate-900 p-4 sm:p-5">
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300/90">
                    Outstanding balance
                  </p>
                  <div className="mt-1 text-3xl sm:text-4xl font-black text-velo-900 dark:text-white">
                    ₦{Number(repayModalLoan.outstandingNaira || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                  {repayModalLoan.principalNaira ? (
                    <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                      Principal ₦{Number(repayModalLoan.principalNaira).toLocaleString("en-NG")} · Interest & fees included above
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                      Principal and interest combined
                    </p>
                  )}
                </div>

                <div className="mt-5">
                  <p className="text-sm font-bold text-velo-900 dark:text-white">How do you want to repay?</p>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => { setRepayMode("full"); setRepayModeMsg(""); }}
                      className={`text-left rounded-2xl border p-4 transition-all ${
                        repayMode === "full"
                          ? "border-emerald-500 bg-emerald-50/70 dark:bg-emerald-900/25 ring-2 ring-emerald-500/20"
                          : "border-slate-200 dark:border-slate-800 hover:border-emerald-200 dark:hover:border-emerald-900/50 bg-white dark:bg-slate-900"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                          repayMode === "full"
                            ? "bg-emerald-500 text-white shadow-md shadow-emerald-500/30"
                            : "bg-slate-100 dark:bg-slate-800 text-slate-500"
                        }`}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                            <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-extrabold text-velo-900 dark:text-white">Pay in full</div>
                          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 truncate">
                            ₦{Number(repayModalLoan.outstandingNaira || 0).toLocaleString("en-NG")}
                          </div>
                        </div>
                      </div>
                      {repayMode === "full" && (
                        <div className="mt-3 pt-3 border-t border-emerald-100/80 dark:border-emerald-900/40">
                          <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                            Clears this loan completely in one go.
                          </p>
                        </div>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => { setRepayMode("custom"); setRepayModeMsg(""); }}
                      className={`text-left rounded-2xl border p-4 transition-all ${
                        repayMode === "custom"
                          ? "border-velo-500 bg-velo-50/70 dark:bg-velo-900/25 ring-2 ring-velo-500/20"
                          : "border-slate-200 dark:border-slate-800 hover:border-velo-200 dark:hover:border-velo-900/50 bg-white dark:bg-slate-900"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                          repayMode === "custom"
                            ? "bg-velo-500 text-white shadow-md shadow-velo-500/30"
                            : "bg-slate-100 dark:bg-slate-800 text-slate-500"
                        }`}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                            <path d="M12 6v12M6 12h12" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-extrabold text-velo-900 dark:text-white">Pay part amount</div>
                          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 truncate">
                            Min ₦50 · reduces outstanding gradually
                          </div>
                        </div>
                      </div>
                    </button>
                  </div>
                </div>

                {repayMode === "custom" && (
                  <div className="mt-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-4 sm:p-5 space-y-4">
                    <div>
                      <label htmlFor="repay-amount" className="block text-sm font-bold text-velo-900 dark:text-white">
                        Enter amount (NGN)
                      </label>
                      <div className="mt-2 relative">
                        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-extrabold text-slate-500 dark:text-slate-400 text-lg">
                          ₦
                        </span>
                        <input
                          id="repay-amount"
                          type="text"
                          inputMode="decimal"
                          value={repayCustomAmount}
                          disabled={repaySubmitting}
                          placeholder="e.g. 5,000"
                          onChange={(e) => {
                            const raw = e.target.value.replace(/[^0-9.,]/g, "");
                            const digitsOnly = raw.replace(/,/g, "");
                            const numeric = digitsOnly ? Number(digitsOnly) : 0;
                            const max = Number(repayModalLoan?.outstandingNaira || 0);
                            const bounded = Math.min(max, Math.max(0, numeric || 0));
                            const formatted = digitsOnly && bounded > 0
                              ? bounded.toLocaleString("en-NG", { maximumFractionDigits: 2 })
                              : digitsOnly.replace(/\./, ",")
                            setRepayCustomAmount(formatted.replace(/,/g, ""));
                            setRepayModeMsg("");
                          }}
                          className="w-full !pl-12 pr-4 py-3.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-velo-900 dark:text-white text-xl font-black outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 disabled:opacity-60"
                        />
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={repaySubmitting}
                          onClick={() => setRepayCustomAmount(String(Math.round(Number(repayModalLoan?.outstandingNaira || 0) / 2)))}
                          className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-bold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 transition"
                        >
                          ½ of balance
                        </button>
                        <button
                          type="button"
                          disabled={repaySubmitting}
                          onClick={() => setRepayCustomAmount(String(Math.round(Number(repayModalLoan?.outstandingNaira || 0) / 4)))}
                          className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-bold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 transition"
                        >
                          ¼ of balance
                        </button>
                        <button
                          type="button"
                          disabled={repaySubmitting}
                          onClick={() => setRepayCustomAmount("10000")}
                          className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-bold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 transition"
                        >
                          ₦10,000
                        </button>
                        <button
                          type="button"
                          disabled={repaySubmitting}
                          onClick={() => setRepayCustomAmount("50000")}
                          className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-bold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 transition"
                        >
                          ₦50,000
                        </button>
                      </div>
                    </div>
                    <RepayBreakdown
                      fullAmount={Number(repayModalLoan.outstandingNaira || 0)}
                      customInput={repayCustomAmount}
                    />
                  </div>
                )}

                {repayMode === "full" && (
                  <div className="mt-5 rounded-2xl border border-emerald-100 dark:border-emerald-900/40 bg-white dark:bg-slate-900/60 p-4 sm:p-5">
                    <RepayBreakdown fullAmount={Number(repayModalLoan.outstandingNaira || 0)} customInput="" forceFull />
                  </div>
                )}

                {repayModeMsg && (
                  <div className="mt-4 rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 p-3 flex items-start gap-2.5">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0 mt-0.5 text-red-500">
                      <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <p className="text-sm font-semibold text-red-700 dark:text-red-300">{repayModeMsg}</p>
                  </div>
                )}

                <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                  <button
                    type="button"
                    onClick={closeRepayModal}
                    disabled={repaySubmitting}
                    className="sm:flex-1 inline-flex items-center justify-center px-5 py-3.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-bold hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSubmitRepayment}
                    disabled={repaySubmitting}
                    className="sm:flex-[1.4] inline-flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 text-white text-sm font-extrabold shadow-lg shadow-emerald-500/25 hover:shadow-xl hover:shadow-emerald-500/30 hover:scale-[1.01] active:scale-[0.99] transition-all disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
                  >
                    {repaySubmitting ? (
                      <>
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Initializing Flutterwave checkout…
                      </>
                    ) : (
                      <>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                          <path d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        {repayMode === "full"
                          ? `Pay ₦${Number(repayModalLoan.outstandingNaira || 0).toLocaleString("en-NG")} in full`
                          : repayCustomAmount
                          ? `Pay ₦${Number(String(repayCustomAmount).replace(/,/g, "") || 0).toLocaleString("en-NG")}`
                          : "Continue to checkout"}
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

function RepayBreakdown(props: any) {
  const { fullAmount, customInput, forceFull = false } = props;
  const raw = forceFull
    ? Number(fullAmount || 0)
    : Math.min(
        Number(fullAmount || 0),
        Math.max(0, Number(String(customInput || "").replace(/,/g, "")) || 0)
      );
  const estimatedPrincipal = Math.min(
    Number(fullAmount || 0),
    raw
  );
  const estimatedInterest = Math.max(0, raw - estimatedPrincipal);
  const remainingAfter = Math.max(0, Number(fullAmount || 0) - raw);
  const isFull = remainingAfter <= 0.01;
  return (
    <dl className="space-y-2.5 text-sm">
      <div className="flex items-center justify-between gap-3">
        <dt className="font-semibold text-slate-600 dark:text-slate-300">Amount to pay</dt>
        <dd className="font-black text-velo-900 dark:text-white">
          ₦{raw.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </dd>
      </div>
      <div className="flex items-center justify-between gap-3">
        <dt className="font-semibold text-slate-600 dark:text-slate-300">Estimated principal portion</dt>
        <dd className="font-bold text-emerald-700 dark:text-emerald-400">
          ₦{estimatedPrincipal.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </dd>
      </div>
      <div className="flex items-center justify-between gap-3">
        <dt className="font-semibold text-slate-600 dark:text-slate-300">Estimated interest portion</dt>
        <dd className="font-bold text-velo-600 dark:text-velo-400">
          ₦{estimatedInterest.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </dd>
      </div>
      <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
        <dt className="font-bold text-slate-700 dark:text-slate-200">
          {isFull ? "Loan status after payment" : "Outstanding after this payment"}
        </dt>
        <dd className={`font-black ${isFull ? "text-emerald-600 dark:text-emerald-400" : "text-velo-900 dark:text-white"}`}>
          {isFull ? "✅ Fully repaid" : `₦${remainingAfter.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
        </dd>
      </div>
      {isFull && (
        <p className="pt-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
          Finalizing this payment marks the loan as REPAID.
        </p>
      )}
    </dl>
  );
}

function BorrowerOverview(props: any) {
  const {
    user,
    hasBothRoles,
    switchingBusy,
    handleEnableInvestor,
    data,
    credit,
    applicationStatus,
    hasSubmittedApplication,
    repaymentProgress,
    paidRepayments,
    scheduledRepayments,
    active,
    repayBusy,
    handleRepayNow,
  } = props;
  return (
    <div className="space-y-6">
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
                  Enable investor access anytime. One KYC unlocks both dashboards.
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
                  <path
                    d="M5 12h14M13 6l6 6-6 6"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Link>
            )}
            {!user.roles.includes("INVESTOR") && (
              <button
                type="button"
                onClick={handleEnableInvestor}
                disabled={switchingBusy}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 text-white text-sm font-semibold shadow-md shadow-emerald-500/20 hover:shadow-lg hover:shadow-emerald-500/30 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                title="Enable investor access"
              >
                {switchingBusy ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
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

      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Borrower portal</p>
        <h1 className="mt-2 text-xl font-bold text-velo-900 sm:text-2xl md:text-3xl dark:text-white">
          Your loan, in one place.
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
          Welcome{user ? `, ${user.fullName}` : ""}. Track applications, repayments, account verification,
          and credit history.
        </p>
      </div>

      <section className="rounded-2xl border border-velo-100 bg-gradient-to-r from-velo-50 to-white p-4 sm:p-5 dark:border-velo-900/50 dark:from-velo-950/40 dark:to-slate-900">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-velo-600 shadow-sm dark:bg-slate-800 dark:text-velo-400">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 8v4m0 4h.01M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-bold text-velo-900 dark:text-white">See what you need before applying</h2>
              <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-400">Review all requirements for personal and business loans before you start.</p>
            </div>
          </div>
          <Link to="/borrower/requirements" className="btn-primary shrink-0 px-4 py-2.5 text-sm">View requirements</Link>
        </div>
      </section>

      {active && (
        <div className="rounded-2xl border border-amber-200/70 dark:border-amber-700/40 bg-gradient-to-br from-amber-50 via-white to-white dark:from-amber-950/40 dark:via-slate-900 dark:to-slate-900 p-5 sm:p-6 shadow-sm relative overflow-hidden">
          <div className="absolute -top-24 -right-24 w-64 h-64 rounded-full bg-amber-400/10 blur-3xl pointer-events-none" />
          <div className="relative flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-amber-100 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                  Outstanding loan
                </span>
                {active.status && (
                  <span className={`badge ${["PAST_DUE"].includes(active.status) ? "badge-rejected" : "badge-pending"}`}>
                    {formatLoanStatus(active.status)}
                  </span>
                )}
              </div>
              <h3 className="mt-3 text-xl sm:text-2xl font-black text-velo-900 dark:text-white">
                ₦{Number(active.outstandingNaira ?? 0).toLocaleString("en-NG")}
              </h3>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                {active.productName ?? "Term loan"}
                {active.tenureDays ? ` • ${active.tenureDays} days` : ""}
                {active.interestRatePercent ? ` • ${active.interestRatePercent}% interest` : ""}
              </p>
              {active.disbursedAt && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Disbursed {new Date(active.disbursedAt).toLocaleDateString("en-NG")}
                  {active.maturityDate ? ` • Matures ${new Date(active.maturityDate).toLocaleDateString("en-NG")}` : ""}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() =>
                  handleRepayNow(
                    String(active.id ?? ""),
                    Number(active.outstandingNaira ?? 0),
                    Number(active.principalNaira ?? 0) || undefined,
                    String(active.refNo ?? active.applicationId ?? ""),
                    active.productName ?? "Term loan"
                  )
                }
                disabled={!active.id || !active.outstandingNaira}
                className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 text-white text-sm font-bold shadow-lg shadow-emerald-500/25 hover:shadow-xl hover:shadow-emerald-500/30 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
              >
                {repayBusy === String(active.id) ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Redirecting…
                  </>
                ) : (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    Repay Now ₦{Number(active.outstandingNaira ?? 0).toLocaleString("en-NG")}
                  </>
                )}
              </button>
            </div>
          </div>
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
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="section-heading">Repayment health</h2>
              <p className="section-subheading">A simple view of your repayment progress.</p>
            </div>
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
              {repaymentProgress}% paid
            </span>
          </div>
          <div className="mt-6 h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-velo-500 to-emerald-500 transition-all"
              style={{ width: `${repaymentProgress}%` }}
            />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-slate-500">Paid to date</p>
              <p className="mt-1 text-lg font-bold text-velo-900 dark:text-white">
                ₦{paidRepayments.toLocaleString("en-NG")}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Recorded schedule</p>
              <p className="mt-1 text-lg font-bold text-velo-900 dark:text-white">
                ₦{scheduledRepayments.toLocaleString("en-NG")}
              </p>
            </div>
          </div>
          <svg
            className="mt-6 h-20 w-full"
            viewBox="0 0 520 80"
            role="img"
            aria-label="Repayment progress chart"
          >
            <defs>
              <linearGradient id="borrower-chart-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#2196f3" stopOpacity=".28" />
                <stop offset="1" stopColor="#2196f3" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              d="M0 68 C80 60 110 64 170 46 S270 53 330 30 S430 35 520 12 V80 H0Z"
              fill="url(#borrower-chart-fill)"
            />
            <path
              d="M0 68 C80 60 110 64 170 46 S270 53 330 30 S430 35 520 12"
              fill="none"
              stroke="#2196f3"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
        </section>
        <section className="velo-card p-4 sm:p-5 lg:p-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="section-heading">Credit posture</h2>
              <p className="section-subheading">Your current internal score.</p>
            </div>
            <div
              className="relative flex h-20 w-20 items-center justify-center rounded-full"
              style={{
                background: `conic-gradient(#2196f3 ${Math.max(
                  0,
                  Math.min(100, (((credit?.score?.score ?? 300) - 300) / 5.5))
                )}%, #e8eef5 0)`,
              }}
            >
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-xl font-bold text-velo-900 dark:bg-slate-900 dark:text-white">
                {credit?.score?.score ?? "—"}
              </div>
            </div>
          </div>
          <p className="mt-5 text-sm font-semibold text-velo-900 dark:text-white">
            {credit?.score?.band?.replace(/_/g, " ") ?? "Score pending"}
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Keep repayments current and complete your profile to maintain a healthy borrowing position.
          </p>
        </section>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.2fr_.8fr]">
        <section className="velo-card p-4 sm:p-5 lg:p-6">
          <h2 className="section-heading">Loan application</h2>
          <p className="section-subheading">
            Your system decision appears here before a loan manager completes manual review.
          </p>
          {data?.applications?.[0] ? (
            <div className="mt-5 rounded-xl border border-slate-100 p-4 dark:border-slate-700">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-velo-900 dark:text-white">Latest application</span>
                <span className="badge badge-pending">{formatLoanStatus(data.applications[0].status)}</span>
              </div>
              <div className="mt-4 space-y-2 border-t border-slate-100 pt-3 dark:border-slate-700">
                {(data.applications ?? []).slice(0, 4).map((application: NonNullable<DashboardData["applications"]>[number], index: number) => (
                  <div key={application.id ?? index} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-slate-500">{application.id ? `Application ${application.id.slice(0, 8).toUpperCase()}` : "Loan application"}</span>
                    <span className="font-semibold text-velo-700 dark:text-velo-300">{formatLoanStatus(application.status)}</span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
                Requested amount: ₦
                {Number(data.applications[0].amountNaira ?? 0).toLocaleString("en-NG")}
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-500">
                Disbursement destination: {data.disbursementAccount?.bankName ?? "Not set"}
              </p>
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
                  <path
                    d="M5 12h14M13 6l6 6-6 6"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Link>
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-3">
            {hasSubmittedApplication && !["DRAFT", "IN_PROGRESS", "MORE_INFORMATION_REQUIRED"].includes(String(applicationStatus)) ? (
              <span className="rounded-xl bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                Application under review — no new loan applications until repayment
              </span>
            ) : (
              <Link to="/apply" className="btn-primary inline-flex items-center gap-2">
                {data?.applications?.[0] ? "Continue Application" : "New Application"}
              </Link>
            )}
          </div>
        </section>

        <section className="velo-card p-4 sm:p-5 lg:p-6">
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
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Personal or business funding
                  </div>
                </div>
              </div>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                className="text-slate-400 group-hover:text-velo-500 group-hover:translate-x-0.5 transition-all"
              >
                <path
                  d="M5 12h14M13 6l6 6-6 6"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
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
    </div>
  );
}

function BorrowerApplications(props: any) {
  const apps = props.data?.applications ?? [];
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Loan applications</p>
        <h1 className="mt-2 text-xl font-bold text-velo-900 sm:text-2xl md:text-3xl dark:text-white">
          {apps.length ? `${apps.length} application${apps.length > 1 ? "s" : ""}` : "No applications yet"}
        </h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Track every stage of your loan requests.
        </p>
      </div>

      {apps.length === 0 ? (
        <section className="velo-card p-8 text-center">
          <p className="text-sm font-semibold text-velo-900 dark:text-white">No applications yet</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 mb-4">
            Start a new loan application when you're ready.
          </p>
          <Link to="/apply" className="btn-primary inline-flex items-center gap-2">
            Start Application
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M5 12h14M13 6l6 6-6 6"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        </section>
      ) : (
        <div className="space-y-4">
          {apps.map((app: any, i: number) => (
            <section
              key={app.id ?? i}
              className="velo-card p-4 sm:p-5 lg:p-6"
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-bold text-velo-900 dark:text-white">
                      {app.productName ?? "Loan application"}
                    </h3>
                    <span className={`badge ${["REJECTED", "DEFAULTED", "WRITTEN_OFF"].includes(String(app.status)) ? "badge-rejected" : ["DISBURSED", "ACTIVE", "REPAID"].includes(String(app.status)) ? "badge-completed" : "badge-pending"}`}>
                      {formatLoanStatus(app.status)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {app.submittedAt
                      ? `Submitted ${new Date(app.submittedAt).toLocaleString("en-NG")}`
                      : "Draft"}
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-xl font-black text-velo-900 dark:text-white">
                    ₦{Number(app.amountNaira ?? 0).toLocaleString("en-NG")}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {app.tenureDays ? `${app.tenureDays}d tenure` : ""}
                    {app.interestRatePercent ? ` • ${app.interestRatePercent}%` : ""}
                  </div>
                </div>
              </div>
              {app.outstandingNaira && Number(app.outstandingNaira) > 0 && (
                <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs text-slate-500 dark:text-slate-400">Outstanding balance</p>
                      <p className="text-sm font-bold text-amber-700 dark:text-amber-400">
                        ₦{Number(app.outstandingNaira).toLocaleString("en-NG")}
                      </p>
                    </div>
                    <Link to="/borrower" className="btn-ghost text-sm">
                      View overview
                    </Link>
                  </div>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function BorrowerRepayments(props: any) {
  const {
    repayments,
    repaymentProgress,
    paidRepayments,
    scheduledRepayments,
    active,
    repayBusy,
    handleRepayNow,
  } = props;
  const safeRepayments = (repayments ?? []) as RepaymentRecord[];
  const pageSize = 10;
  const [page, setPage] = useState(1);
  const { records: visibleRepayments, totalPages } = paginateRepayments(safeRepayments, page, pageSize);

  useEffect(() => {
    setPage(1);
  }, [safeRepayments.length]);
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Repayments</p>
          <h1 className="mt-2 text-xl font-bold text-velo-900 sm:text-2xl md:text-3xl dark:text-white">
            Schedules & history
          </h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Review your repayment obligations and completed payments.
          </p>
        </div>
        {active && active.id && active.outstandingNaira && (
          <button
            type="button"
            onClick={() =>
              handleRepayNow(
                String(active.id),
                Number(active.outstandingNaira),
                Number(active.principalNaira ?? 0) || undefined,
                String(active.refNo ?? active.applicationId ?? ""),
                active.productName ?? "Term loan"
              )
            }
            disabled={!active.id || !active.outstandingNaira}
            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 text-white text-sm font-bold shadow-lg shadow-emerald-500/25 hover:shadow-xl hover:shadow-emerald-500/30 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {repayBusy === String(active.id) ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Redirecting…
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Repay Now ₦{Number(active.outstandingNaira).toLocaleString("en-NG")}
              </>
            )}
          </button>
        )}
      </div>

      <section className="velo-card p-4 sm:p-5 lg:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="section-heading">Progress summary</h2>
            <p className="section-subheading">Repayment progress against the full schedule.</p>
          </div>
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
            {repaymentProgress}% paid
          </span>
        </div>
        <div className="mt-5 h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-velo-500 to-emerald-500"
            style={{ width: `${repaymentProgress}%` }}
          />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-slate-500">Paid</p>
            <p className="mt-1 text-lg font-bold text-velo-900 dark:text-white">
              ₦{paidRepayments.toLocaleString("en-NG")}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Scheduled</p>
            <p className="mt-1 text-lg font-bold text-velo-900 dark:text-white">
              ₦{scheduledRepayments.toLocaleString("en-NG")}
            </p>
          </div>
        </div>
      </section>

      <section className="velo-card overflow-hidden">
        <header className="flex items-center justify-between gap-3 px-5 sm:px-6 py-4 border-b border-slate-100 dark:border-slate-800">
          <div>
            <h2 className="section-heading">Repayment records</h2>
            <p className="section-subheading">{safeRepayments.length} record(s)</p>
          </div>
        </header>
        {safeRepayments.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
            No repayment records yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500">
                <tr>
                  <th className="text-left px-5 sm:px-6 py-3 font-semibold">Date</th>
                  <th className="text-left px-5 sm:px-6 py-3 font-semibold">Loan ID</th>
                  <th className="text-right px-5 sm:px-6 py-3 font-semibold">Amount</th>
                  <th className="text-right px-5 sm:px-6 py-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {visibleRepayments.map((r: any, i: number) => (
                  <tr key={r.id ?? i} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/30">
                    <td className="px-5 sm:px-6 py-4 text-slate-700 dark:text-slate-300">
                      {r.dueDate || r.paidAt || r.createdAt
                        ? new Date(
                            (r.paidAt ?? r.dueDate ?? r.createdAt) as string
                          ).toLocaleString("en-NG")
                        : "—"}
                    </td>
                    <td className="px-5 sm:px-6 py-4 font-mono text-xs text-slate-600 dark:text-slate-400">
                      {r.loanId ? <Link to={`/borrower/loans/${encodeURIComponent(r.loanId)}`} className="text-velo-600 hover:underline">{r.loanId.slice(0, 10)}</Link> : "—"}
                    </td>
                    <td className="px-5 sm:px-6 py-4 text-right font-bold text-velo-900 dark:text-white">
                      ₦{Number(r.amountNaira ?? 0).toLocaleString("en-NG")}
                    </td>
                    <td className="px-5 sm:px-6 py-4 text-right">
                      <span
                        className={`badge ${
                          ["SUCCESSFUL", "COMPLETED"].includes(String(r.status))
                            ? "badge-completed"
                            : ["FAILED"].includes(String(r.status))
                            ? "badge-rejected"
                            : "badge-pending"
                        }`}
                      >
                        {String(r.status ?? "PENDING").replace(/_/g, " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-5 py-4 text-sm dark:border-slate-800">
            <span className="text-slate-500">Page {page} of {totalPages}</span>
            <div className="flex gap-2">
              <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1} className="btn-secondary px-3 py-2 text-xs disabled:opacity-50">Previous</button>
              <button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page === totalPages} className="btn-secondary px-3 py-2 text-xs disabled:opacity-50">Next</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function BorrowerCredit(props: any) { const { credit, history } = props;
  const factors = credit?.score?.factors ?? [];
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Credit</p>
        <h1 className="mt-2 text-xl font-bold text-velo-900 sm:text-2xl md:text-3xl dark:text-white">
          Credit score & history
        </h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Internal scoring and the key factors that influence your rating.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[.7fr_1.3fr]">
        <section className="velo-card p-4 sm:p-5 lg:p-6 text-center">
          <div
            className="relative mx-auto flex h-36 w-36 items-center justify-center rounded-full"
            style={{
              background: `conic-gradient(#2196f3 ${Math.max(
                0,
                Math.min(100, (((credit?.score?.score ?? 300) - 300) / 5.5))
              )}%, #e8eef5 0)`,
            }}
          >
            <div className="flex h-28 w-28 flex-col items-center justify-center rounded-full bg-white dark:bg-slate-900">
              <div className="text-3xl font-black text-velo-900 dark:text-white">
                {credit?.score?.score ?? "—"}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Score</div>
            </div>
          </div>
          <p className="mt-4 text-sm font-semibold text-velo-900 dark:text-white">
            {credit?.score?.band?.replace(/_/g, " ") ?? "Score pending"}
          </p>
          {credit?.score?.calculatedAt && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Calculated {new Date(credit.score.calculatedAt).toLocaleString("en-NG")}
            </p>
          )}
        </section>
        <section className="velo-card p-4 sm:p-5 lg:p-6">
          <h2 className="section-heading">Key factors</h2>
          <p className="section-subheading">
            Factors that currently affect your internal credit rating.
          </p>
          {factors.length === 0 ? (
            <p className="mt-5 text-sm text-slate-500 dark:text-slate-400">
              No factors available yet. Complete KYC and start transacting to build your score.
            </p>
          ) : (
            <ul className="mt-5 space-y-3">
              {factors.map((f: any, i: number) => (
                <li
                  key={i}
                  className="rounded-xl border border-slate-100 dark:border-slate-700 p-4 flex items-start justify-between gap-3"
                >
                  <div>
                    <div className="text-sm font-semibold text-velo-900 dark:text-white">{f.label}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{f.detail}</div>
                  </div>
                  <span
                    className={`shrink-0 text-xs font-bold px-2 py-1 rounded-md ${
                      f.impact > 0
                        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                        : f.impact < 0
                        ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                        : "bg-slate-50 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                    }`}
                  >
                    {f.impact > 0 ? `+${f.impact}` : f.impact}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="velo-card overflow-hidden">
        <header className="px-5 sm:px-6 py-4 border-b border-slate-100 dark:border-slate-800">
          <h2 className="section-heading">Credit events</h2>
          <p className="section-subheading">{history.length} event(s) on record</p>
        </header>
        {history.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
            No credit events yet.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {(history as Array<{ label?: string; detail?: string; at?: string; impact?: number }>).map(
              (e, i) => (
                <li key={i} className="px-5 sm:px-6 py-4 flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-velo-900 dark:text-white">
                      {e.label ?? "Event"}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{e.detail}</div>
                  </div>
                  <div className="text-right shrink-0">
                    {e.impact != null && (
                      <div
                        className={`text-xs font-bold ${
                          e.impact > 0 ? "text-emerald-600" : e.impact < 0 ? "text-red-600" : "text-slate-500"
                        }`}
                      >
                        {e.impact > 0 ? `+${e.impact}` : e.impact}
                      </div>
                    )}
                    {e.at && (
                      <div className="text-[10px] text-slate-500 mt-1">
                        {new Date(e.at).toLocaleString("en-NG")}
                      </div>
                    )}
                  </div>
                </li>
              )
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

function BorrowerKyc(props: any) {
  const [kyc, setKyc] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function loadKyc() {
    try {
      const response = await getMyKyc();
      setKyc(response);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load KYC status");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void loadKyc();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void loadKyc();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const interval = window.setInterval(() => void loadKyc(), 5000);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(interval);
    };
  }, [props.user?.id]);

  const checklist = kyc?.checklist ?? {};
  const allRequiredChecksComplete = [checklist.bvn, checklist.nin, checklist.liveness, checklist.proofOfAddress, checklist.signature].every(Boolean);
  const reportedStatus = kyc?.status ?? props.user?.kycStatus ?? "NOT_STARTED";
  const status = reportedStatus === "VERIFIED" && !allRequiredChecksComplete ? "IN_PROGRESS" : reportedStatus;
  const categoryResults = kyc?.categoryResults ?? {};
  const completedSteps = [checklist.bvn, checklist.nin, checklist.liveness, checklist.proofOfAddress, checklist.signature].filter(Boolean).length;
  const categories = [["BVN", "bvn"], ["NIN", "nin"], ["Liveness", "liveness"], ["Proof of address", "proofOfAddress"], ["Passport", "passport"], ["Signature", "signature"]] as const;
  const categoryStatus = (key: string) => categoryResults[key]?.status ?? (checklist[key] ? "VERIFIED" : "NOT_STARTED");
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Verification</p>
        <h1 className="mt-2 text-xl font-bold text-velo-900 sm:text-2xl md:text-3xl dark:text-white">Identity & KYC</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Complete your verification to unlock loan and investing features.
        </p>
      </div>

      {loading && <div className="rounded-xl border border-sky-100 bg-sky-50 p-3 text-sm text-sky-700 dark:border-sky-900/40 dark:bg-sky-900/20 dark:text-sky-300">Checking your latest KYC status…</div>}
      {error && <div className="rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">{error}</div>}

      <section className="velo-card p-4 sm:p-5 lg:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="section-heading">Overall KYC status</h2>
            <p className="section-subheading">
              Once verified, every feature on both dashboards is available to you.
            </p>
          </div>
          <span
            className={`badge ${
              status === "VERIFIED"
                ? "badge-completed"
                : ["REJECTED", "EXPIRED", "SUSPENDED"].includes(status)
                ? "badge-rejected"
                : "badge-pending"
            }`}
          >
            {status.replace(/_/g, " ")}
          </span>
        </div>
        <div className="mt-3 text-xs font-semibold text-slate-500 dark:text-slate-400">{completedSteps}/5 required checks completed</div>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <KycStep label="BVN verification" done={Boolean(checklist.bvn)} />
          <KycStep label="NIN verification" done={Boolean(checklist.nin)} />
          <KycStep label="Phone & email" done={Boolean(props.user?.phone && props.user?.email)} />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <KycStep label="Liveness check" done={Boolean(checklist.liveness)} />
          <KycStep label="Proof of address" done={Boolean(checklist.proofOfAddress)} />
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map(([label, key]) => {
            const result = categoryResults[key];
            const current = categoryStatus(key);
            const rejected = current === "REJECTED";
            return <div key={key} className={`rounded-xl border p-3 ${rejected ? "border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-900/15" : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/30"}`}><div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold text-slate-800 dark:text-slate-200">{label}</span><span className={`text-[10px] font-bold uppercase ${rejected ? "text-red-700 dark:text-red-300" : current === "VERIFIED" ? "text-emerald-700 dark:text-emerald-300" : "text-slate-500"}`}>{current.replace(/_/g, " ")}</span></div>{rejected && <p className="mt-2 text-xs leading-5 text-red-700 dark:text-red-300">{result?.reason || kyc?.rejectionReason || "Verification was not successful."}</p>}</div>;
          })}
        </div>
        {kyc?.rejectionReason && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/15 dark:text-red-300"><strong>Review note:</strong> {kyc.rejectionReason}</div>}
      </section>

      {status !== "VERIFIED" && (
        <section className="velo-card p-4 sm:p-5 lg:p-6">
          <h2 className="section-heading">Start / resume verification</h2>
          <p className="section-subheading">
            You'll need your BVN or NIN and a working phone number for OTP.
          </p>
          <div className="mt-5">
            <Link to="/apply" className="btn-primary inline-flex items-center gap-2">
              Go to KYC flow
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M5 12h14M13 6l6 6-6 6"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}

function KycStep({ label, done }: { label: string; done: boolean }) {
  return (
    <div
      className={`rounded-xl border p-4 flex items-center gap-3 ${
        done
          ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800/50 dark:bg-emerald-900/20"
          : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/30"
      }`}
    >
      <div
        className={`inline-flex h-8 w-8 items-center justify-center rounded-full ${
          done
            ? "bg-emerald-500 text-white"
            : "bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          {done ? (
            <path
              d="M5 13l4 4L19 7"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : (
            <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="2.5" />
          )}
        </svg>
      </div>
      <div className="text-sm font-semibold text-velo-900 dark:text-white">{label}</div>
    </div>
  );
}

function BorrowerProfile(props: any) {
  const u = props.user;
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Profile</p>
        <h1 className="mt-2 text-xl font-bold text-velo-900 sm:text-2xl md:text-3xl dark:text-white">Personal information</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Your account details, access roles and edit controls.
        </p>
      </div>

      <section className="velo-card p-4 sm:p-5 lg:p-6">
        <div className="flex items-center gap-4">
          <div className="inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-velo-500 to-indigo-600 text-white font-black text-2xl shadow-md shadow-indigo-500/30">
            {u?.fullName?.charAt(0)?.toUpperCase() || "V"}
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-black text-velo-900 dark:text-white truncate">
              {u?.fullName ?? "—"}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 truncate">{u?.email}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{u?.phone ?? "—"}</p>
          </div>
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs text-slate-500 dark:text-slate-400">User ID</p>
            <p className="mt-1 text-sm font-mono text-velo-900 dark:text-white">{u?.id ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 dark:text-slate-400">Created</p>
            <p className="mt-1 text-sm text-velo-900 dark:text-white">
              {u?.createdAt ? new Date(u.createdAt).toLocaleString("en-NG") : "—"}
            </p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-xs text-slate-500 dark:text-slate-400">Access roles</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {(u?.roles ?? []).map((r: string) => (
                <span
                  key={r}
                  className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-velo-50 text-velo-700 dark:bg-velo-900/30 dark:text-velo-300"
                >
                  {r}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>
      <ProfileSettings />
      <OtpLoginSettings />
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="velo-card p-4 sm:p-5">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-bold text-velo-900 dark:text-white break-words">{value}</p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{detail}</p>
    </div>
  );
}
