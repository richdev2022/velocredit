import React, { useEffect, useState } from "react";
import { formatNaira } from "../../utils/loanCalculator";
import {
  adminApprovePayout,
  adminDecideKyc,
  adminGetReconciliation,
  adminListInvestors,
  adminListKycCases,
  adminListLoans,
  adminListPayouts,
  adminListUsers,
  adminRetryPayout,
  getAdminSummary,
  type AdminSummaryResponse,
} from "../../services/apiClient";
import {
  adminListDisbursements,
  adminRetryDisbursement,
  type LoanDisbursement,
} from "../../services/adminApi";

export type AdminSection = "overview" | "borrowers" | "investors" | "kyc" | "payouts" | "loans" | "reconciliation" | "audit";

const moneyKeys = new Set(["disbursedPrincipal", "outstandingPrincipal", "activeInvestmentPrincipal"]);
const labels: Record<string, string> = { users: "Total users", investors: "Investors", borrowers: "Borrowers", kycPending: "KYC pending", kycVerified: "KYC verified", loans: "Loan applications", approvedLoans: "Approved loans", disbursedPrincipal: "Disbursed principal", outstandingPrincipal: "Outstanding principal", investments: "Investments", activeInvestmentPrincipal: "Active investment principal", pendingPayments: "Pending payments", pendingPayouts: "Pending payouts", failedPayouts: "Failed payouts", reconciliationItems: "Reconciliation items" };

export default function AdminWorkspace({ section }: { section: AdminSection }) {
  if (section === "overview") return <Overview />;
  if (section === "borrowers") return <Users role="BORROWER" title="Borrowers" />;
  if (section === "investors") return <Investors />;
  if (section === "kyc") return <Kyc />;
  if (section === "payouts") return <Payouts />;
  if (section === "loans") return <Loans />;
  if (section === "reconciliation") return <Reconciliation />;
  return <Audit />;
}

function Panel({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) { return <section className="velo-card overflow-hidden dark:bg-slate-900 dark:border-slate-800 rounded-2xl"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 px-5 py-4"><h2 className="font-semibold text-velo-900 dark:text-white">{title}</h2>{action}</div><div className="p-5">{children}</div></section>; }
function Empty({ text = "No records found." }: { text?: string }) { return <div className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">{text}</div>; }
function ErrorBox({ message }: { message: string }) { return <div className="rounded-lg border border-red-100 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-400">{message}</div>; }
function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) { return <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-slate-100 dark:border-slate-800 text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{headers.map((header) => <th key={header} className="whitespace-nowrap px-3 py-3">{header}</th>)}</tr></thead><tbody className="divide-y divide-slate-100 dark:divide-slate-800">{children}</tbody></table></div>; }
function Overview() {
  const [data, setData] = useState<AdminSummaryResponse | null>(null); const [error, setError] = useState("");
  useEffect(() => { getAdminSummary().then(setData).catch((err) => setError(err instanceof Error ? err.message : "Unable to load summary")); }, []);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Panel title="Portfolio overview"><div className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">Loading dashboard overview…</div></Panel>;
  const totals = data.totals || {};
  const chartKeys = ["users", "investors", "borrowers", "loans", "investments", "kycPending"];
  const chartMax = Math.max(1, ...chartKeys.map((key) => Number(totals[key] || 0)));
  return <div className="space-y-5"><div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">{Object.entries(totals).map(([key, value]) => <div key={key} className={`rounded-xl border p-4 ${Number(value) > 0 && ["kycPending", "pendingPayouts", "failedPayouts", "reconciliationItems"].includes(key) ? "border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/20" : "border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900/50"}`}><div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{labels[key] || key}</div><div className="mt-2 text-xl font-bold text-velo-900 dark:text-white">{moneyKeys.has(key) ? formatNaira(Number(value)) : Number(value).toLocaleString()}</div></div>)}</div><Panel title="Portfolio analysis"><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{chartKeys.map((key) => <div key={key}><div className="mb-1 flex justify-between text-xs text-slate-500 dark:text-slate-400"><span>{labels[key]}</span><strong className="text-velo-900 dark:text-white">{Number(totals[key] || 0).toLocaleString()}</strong></div><div className="h-3 rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-3 rounded-full bg-velo-500 transition-all" style={{ width: `${Math.max(4, Number(totals[key] || 0) / chartMax * 100)}%` }} /></div></div>)}</div></Panel><Panel title="Recent activity"><Empty text={data.recentActivity?.length ? `${data.recentActivity.length} recent events available in Audit logs.` : "No recent activity yet."} /></Panel></div>;
}

function Users({ role, title }: { role: "BORROWER" | undefined; title: string }) {
  const [rows, setRows] = useState<any[]>([]); const [error, setError] = useState(""); const [page, setPage] = useState(0); const [total, setTotal] = useState(0); const [selected, setSelected] = useState<any>(null); const size = 20;
  useEffect(() => { setPage(0); }, [role]);
  useEffect(() => { adminListUsers(size, page * size, role).then((response) => { setRows(response.users); setTotal(response.meta?.total || response.users.length); }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load users")); }, [role, page]);
  const pages = Math.max(1, Math.ceil(total / size));
  if (selected) return <Panel title={`${title} detail`} action={<button className="btn-secondary text-xs" onClick={() => setSelected(null)}>Back to {title.toLowerCase()}</button>}><DetailFields value={selected} /></Panel>;
  return <Panel title={`${title} management`} action={<span className="text-xs text-slate-500 dark:text-slate-400">{total} records</span>}>{error ? <ErrorBox message={error} /> : <Table headers={["Name", "Email", "Phone", "KYC", "Status", "Created"]}>{rows.map((user) => <tr key={user.id} className="cursor-pointer hover:bg-velo-50/40 dark:hover:bg-slate-800/40" onClick={() => setSelected(user)}><td className="px-3 py-3 font-medium text-velo-900 dark:text-white">{user.fullName}</td><td className="px-3 py-3 text-slate-600 dark:text-slate-300">{user.email}</td><td className="px-3 py-3 text-slate-600 dark:text-slate-300">{user.phone || "—"}</td><td className="px-3 py-3"><span className="badge bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">{user.kycStatus || "NOT_STARTED"}</span></td><td className="px-3 py-3 dark:text-slate-200">{user.isActive === false ? "Inactive" : "Active"}</td><td className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400">{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—"}</td></tr>)}</Table>}{!error && !rows.length && <Empty />}{!error && <Pager page={page} pages={pages} onPage={setPage} />}</Panel>;
}

function Investors() {
  const [rows, setRows] = useState<any[]>([]); const [error, setError] = useState(""); const [page, setPage] = useState(0); const [total, setTotal] = useState(0); const [selected, setSelected] = useState<any>(null); const size = 20;
  useEffect(() => { adminListInvestors(size, page * size).then((response) => { setRows(response.investors); setTotal(response.meta?.total || response.investors.length); }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load investors")); }, [page]);
  const pages = Math.max(1, Math.ceil(total / size));
  if (selected) return <Panel title="Investor detail" action={<button className="btn-secondary text-xs" onClick={() => setSelected(null)}>Back to investors</button>}><DetailFields value={selected} /><div className="mt-6 grid gap-4 sm:grid-cols-2"><div><h3 className="font-semibold text-velo-900 dark:text-white">Investments</h3><p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{selected.investments?.length || 0} investment records</p></div><div><h3 className="font-semibold text-velo-900 dark:text-white">Payouts</h3><p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{selected.payouts?.length || 0} payout records</p></div></div></Panel>;
  return <Panel title="Investor management" action={<span className="text-xs text-slate-500 dark:text-slate-400">{total} investors</span>}>{error ? <ErrorBox message={error} /> : <Table headers={["Investor", "Email", "Wallet", "Investments", "KYC", "Status"]}>{rows.map((investor) => <tr key={investor.id} className="cursor-pointer hover:bg-velo-50/40 dark:hover:bg-slate-800/40" onClick={() => setSelected(investor)}><td className="px-3 py-3 font-medium text-velo-900 dark:text-white">{investor.fullName}</td><td className="px-3 py-3 text-slate-600 dark:text-slate-300">{investor.email}</td><td className="px-3 py-3 font-semibold dark:text-slate-200">{formatNaira(Number(investor.wallet?.availableMinor || 0) / 100)}</td><td className="px-3 py-3 dark:text-slate-300">{investor.investments?.length || 0}</td><td className="px-3 py-3"><span className="badge bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">{investor.kyc?.status || investor.kycStatus || "NOT_STARTED"}</span></td><td className="px-3 py-3 dark:text-slate-200">{investor.isActive === false ? "Inactive" : "Active"}</td></tr>)}</Table>}{!error && !rows.length && <Empty />}{!error && <Pager page={page} pages={pages} onPage={setPage} />}</Panel>;
}

function DetailFields({ value }: { value: any }) { return <div className="grid gap-4 sm:grid-cols-2">{[["Full name", value.fullName], ["Email", value.email], ["Phone", value.phone], ["KYC status", value.kycStatus || value.kyc?.status], ["Account status", value.isActive === false ? "Inactive" : "Active"], ["Created", value.createdAt ? new Date(value.createdAt).toLocaleString() : "—"]].map(([label, content]) => <div key={String(label)} className="rounded-lg bg-slate-50 dark:bg-slate-800/60 p-4"><div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div><div className="mt-1 font-medium text-velo-900 dark:text-white">{content || "—"}</div></div>)}</div>; }
function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) { return <div className="mt-4 flex items-center justify-between border-t border-slate-100 dark:border-slate-800 pt-4"><button className="btn-secondary text-xs" disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</button><span className="text-xs text-slate-500 dark:text-slate-400">Page {page + 1} of {pages}</span><button className="btn-secondary text-xs" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next</button></div>; }
function ProviderResponse({ title, data, error }: { title?: string; data?: unknown; error?: string | null }) {
  const [open, setOpen] = useState(false);
  const hasContent = (data && Object.keys(data as Record<string, unknown>).length > 0) || !!error;
  if (!hasContent) return <span className="text-xs text-slate-400 dark:text-slate-500">—</span>;
  return (
    <div className="mt-1">
      <button type="button" onClick={() => setOpen(!open)} className="text-xs text-emerald-600 hover:text-emerald-500 dark:text-emerald-400 hover:underline inline-flex items-center gap-1">
        <span>{title || "Provider response"}</span>
        <span className={`transform transition-transform ${open ? "rotate-90" : ""}`}>›</span>
      </button>
      {open && (
        <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-950 dark:bg-black/60 p-3 text-[11px] leading-relaxed text-emerald-200 font-mono">
          {JSON.stringify({ providerTransfer: data ?? null, error: error ?? null }, null, 2)}
        </pre>
      )}
    </div>
  );
}
function StatusBadge({ status }: { status?: string }) {
  const s = String(status || "UNKNOWN").toUpperCase();
  const cls =
    s.includes("SUCCESS") || s === "PAID_OUT" || s === "DISBURSED" || s === "VERIFIED"
      ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
      : s.includes("FAIL") || s === "REJECTED"
      ? "bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300"
      : s.includes("PENDING") || s === "PROCESSING" || s.includes("PAYOUT_PENDING") || s === "DISBURSEMENT_PENDING"
      ? "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
      : "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300";
  return <span className={`badge ${cls}`}>{s}</span>;
}

function Kyc() {
  const [rows, setRows] = useState<any[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  const load = () => adminListKycCases(100).then((response) => setRows(response.cases)).catch((err) => setError(err instanceof Error ? err.message : "Unable to load KYC cases"));
  useEffect(() => { load(); }, []);
  async function decide(id: string, decision: "VERIFIED" | "REJECTED") { setBusy(id); try { await adminDecideKyc(id, { decision }); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Unable to update KYC"); } finally { setBusy(""); } }
  return <Panel title="KYC review queue" action={<span className="text-xs text-slate-500 dark:text-slate-400">{rows.length} cases</span>}>{error && <ErrorBox message={error} />}{rows.length ? <Table headers={["Applicant", "Status", "Checklist", "Submitted", "Actions"]}>{rows.map((item) => <tr key={item.id}><td className="px-3 py-3"><div className="font-medium text-velo-900 dark:text-white">{item.user?.fullName || item.userId}</div><div className="text-xs text-slate-500 dark:text-slate-400">{item.user?.email || ""}</div></td><td className="px-3 py-3"><span className="badge bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">{item.status}</span></td><td className="px-3 py-3 text-xs text-slate-600 dark:text-slate-300">{Object.values(item.checklist || {}).filter(Boolean).length}/{Object.keys(item.checklist || {}).length} complete</td><td className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400">{item.submittedAt ? new Date(item.submittedAt).toLocaleDateString() : "—"}</td><td className="px-3 py-3"><div className="flex gap-2"><button className="btn-primary text-xs" disabled={busy === item.id} onClick={() => decide(item.id, "VERIFIED")}>Verify</button><button className="btn-secondary text-xs" disabled={busy === item.id} onClick={() => decide(item.id, "REJECTED")}>Reject</button></div></td></tr>)}</Table> : <Empty text="No KYC cases are waiting for review." />}</Panel>;
}

function Payouts() {
  const [rows, setRows] = useState<any[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(""); const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const load = () => adminListPayouts(200).then((response) => setRows(response.payouts)).catch((err) => setError(err instanceof Error ? err.message : "Unable to load payouts"));
  useEffect(() => { load(); }, []);
  async function action(id: string, type: "approve" | "retry") { setBusy(id); try { if (type === "approve") await adminApprovePayout(id); else await adminRetryPayout(id); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Unable to process payout"); } finally { setBusy(""); } }
  return <Panel title="Payout operations (investor)" action={<span className="text-xs text-slate-500 dark:text-slate-400">{rows.length} payouts</span>}>{error && <ErrorBox message={error} />}{rows.length ? <Table headers={["Payout ID", "Investor", "Amount", "Type", "Status", "Created", "Provider details", "Actions"]}>{rows.map((item) => { const isOpen = !!expanded[item.id]; const investor = typeof item.userId === "string" ? item.userId : (item.userId?.id ?? ""); return (<React.Fragment key={item.id}><tr className={isOpen ? "bg-emerald-50/40 dark:bg-emerald-900/10" : ""}><td className="px-3 py-3"><button type="button" onClick={() => setExpanded({ ...expanded, [item.id]: !isOpen })} className="text-left"><div className="font-mono text-xs dark:text-slate-200 inline-flex items-center gap-1"><span className={`transform transition-transform ${isOpen ? "rotate-90" : ""}`}>›</span>{item.id}</div>{item.investmentId ? <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">Investment: {String(item.investmentId).slice(0, 10)}…</div> : null}</button></td><td className="px-3 py-3 dark:text-slate-300 text-xs">{item.user?.fullName ?? item.user?.email ?? investor}</td><td className="px-3 py-3 font-semibold dark:text-slate-200">{formatNaira(Number(item.amountNaira || 0))}<div className="text-[11px] text-slate-500 dark:text-slate-400">P {formatNaira(Number(item.principalNaira || 0))} · E {formatNaira(Number(item.earningsNaira || 0))}</div></td><td className="px-3 py-3 text-xs dark:text-slate-300">{item.payoutType || "PAYOUT"}</td><td className="px-3 py-3"><StatusBadge status={item.status} /></td><td className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400">{item.createdAt ? new Date(item.createdAt).toLocaleDateString() : "—"}</td><td className="px-3 py-3"><ProviderResponse title="View transfer" data={item.providerTransfer} error={item.error} /></td><td className="px-3 py-3"><div className="flex flex-wrap gap-2">{["PENDING_APPROVAL"].includes(item.status) && <button className="btn-primary text-xs" disabled={busy === item.id} onClick={() => action(item.id, "approve")}>Approve</button>}{item.status === "FAILED" && <button className="btn-secondary text-xs" disabled={busy === item.id} onClick={() => action(item.id, "retry")}>Retry</button>}</div></td></tr>{isOpen && (<tr><td colSpan={8} className="px-3 py-4 bg-slate-50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-800"><div className="grid gap-3 sm:grid-cols-2 text-xs"><div className="rounded-lg bg-white dark:bg-slate-900 p-3 border border-slate-100 dark:border-slate-800"><div className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">Payout account snapshot</div><pre className="max-h-60 overflow-auto font-mono text-[11px] text-slate-700 dark:text-slate-300">{JSON.stringify(item.payoutAccountSnapshot || {}, null, 2)}</pre></div><div className="rounded-lg bg-white dark:bg-slate-900 p-3 border border-slate-100 dark:border-slate-800"><div className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">Provider reference / timestamps</div><div>providerReference: <span className="font-mono">{item.providerReference || "—"}</span></div><div>verifiedAt: <span className="font-mono">{item.verifiedAt || "—"}</span></div><div>updatedAt: <span className="font-mono">{item.updatedAt || item.createdAt || "—"}</span></div>{item.retryCount != null && <div>retryCount: {Number(item.retryCount || 0)}</div>}</div></div></td></tr>)}</React.Fragment>); })}</Table> : <Empty text="No payouts require attention." />}</Panel>;
}

function Loans() {
  const [rows, setRows] = useState<any[]>([]);
  const [disbursedLoans, setDisbursedLoans] = useState<any[]>([]);
  const [disbursements, setDisbursements] = useState<LoanDisbursement[]>([]);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState("");
  const size = 20;
  const loadDisbursements = () => adminListDisbursements({ limit: 500 }).then((r) => setDisbursements(r.disbursements)).catch(() => setDisbursements([]));
  useEffect(() => {
    adminListLoans(size, page * size).then((response) => {
      setRows(response.loans);
      setDisbursedLoans((response as any).disbursedLoans || []);
      setTotal(response.meta?.total || response.loans.length);
    }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load loans"));
    loadDisbursements();
  }, [page]);
  async function retryDisbursement(disbursementId: string) {
    setBusy(disbursementId);
    try { await adminRetryDisbursement(disbursementId); await loadDisbursements(); }
    catch (err) { setError(err instanceof Error ? err.message : "Retry failed"); }
    finally { setBusy(""); }
  }
  function disbursementsForLoan(loanAppId: string, loanRecordId?: string) {
    return disbursements.filter((d) => (loanRecordId && d.loanId === loanRecordId) || d.applicationId === loanAppId);
  }
  return <Panel title="Loan management & disbursement tracking" action={<span className="text-xs text-slate-500 dark:text-slate-400">{total} applications · {disbursements.length} transfer records</span>}>{error ? <ErrorBox message={error} /> : rows.length ? <Table headers={["Application / Loan", "Borrower", "Principal", "Application status", "Disbursements", "Created"]}>{rows.map((loanApp) => {
    const appId = loanApp.id;
    const matchingLoanRecord = disbursedLoans.find((l: any) => l.applicationId === appId || l.id === appId);
    const loanRecordId = matchingLoanRecord?.id;
    const transfers = disbursementsForLoan(appId, loanRecordId);
    return (
      <React.Fragment key={loanApp.id || loanApp.applicationId}>
        <tr>
          <td className="px-3 py-3">
            <div className="font-mono text-xs dark:text-slate-200">{loanApp.applicationId || loanApp.id}</div>
            {loanRecordId && loanRecordId !== appId && <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Loan record: {String(loanRecordId).slice(0, 12)}…</div>}
          </td>
          <td className="px-3 py-3 dark:text-slate-300">
            <div>{loanApp.customerSnapshot?.fullName || loanApp.borrowerId || "—"}</div>
            {loanApp.customerSnapshot?.email && <div className="text-[11px] text-slate-500 dark:text-slate-400">{loanApp.customerSnapshot.email}</div>}
          </td>
          <td className="px-3 py-3 font-semibold dark:text-slate-200">{formatNaira(Number(loanApp.principalNaira || loanApp.amountNaira || 0))}</td>
          <td className="px-3 py-3"><StatusBadge status={matchingLoanRecord?.status || loanApp.status} /></td>
          <td className="px-3 py-3">
            {transfers.length > 0
              ? (<div className="space-y-2">
                  {transfers.map((t) => (
                    <div key={t.id} className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 bg-white dark:bg-slate-900">
                      <div className="flex flex-wrap items-center gap-2 justify-between">
                        <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">#{t.id.slice(0, 10)}…{t.retryOfId ? <span className="ml-2 text-amber-600 dark:text-amber-400">(retry #{t.retryCount || 1})</span> : ""}</div>
                        <StatusBadge status={t.status} />
                      </div>
                      <div className="mt-2 text-[11px] text-slate-600 dark:text-slate-300">
                        <div>Amount: <strong className="text-velo-900 dark:text-white">{formatNaira(Number(t.amountNaira || 0))}</strong></div>
                        <div className="mt-0.5">Bank: {t.bankName || t.bankCode || "—"} · Acc: {t.accountNumber ? `••••${String(t.accountNumber).slice(-4)}` : "—"} · {t.accountName || ""}</div>
                        <div className="mt-0.5">Created: {t.createdAt ? new Date(t.createdAt).toLocaleString() : "—"}</div>
                        {t.providerReference && <div className="mt-0.5">Provider ref: <span className="font-mono">{t.providerReference}</span></div>}
                      </div>
                      <div className="mt-2"><ProviderResponse title="View provider response" data={t.providerTransfer} error={t.error} /></div>
                      {t.status === "FAILED" && (
                        <div className="mt-3 text-right">
                          <button type="button" className="btn-primary text-xs" disabled={busy === t.id} onClick={() => retryDisbursement(t.id)}>
                            {busy === t.id ? "Retrying…" : "Retry transfer"}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>)
              : <span className="text-xs text-slate-400 dark:text-slate-500">No disbursement records</span>}
          </td>
          <td className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400">{loanApp.createdAt ? new Date(loanApp.createdAt).toLocaleDateString() : "—"}</td>
        </tr>
      </React.Fragment>
    );
  })}</Table> : <Empty />}{!error && <Pager page={page} pages={Math.max(1, Math.ceil(total / size))} onPage={setPage} />}</Panel>;
}
function Reconciliation() { const [data, setData] = useState<any>(null); const [error, setError] = useState(""); useEffect(() => { adminGetReconciliation().then(setData).catch((err) => setError(err instanceof Error ? err.message : "Unable to load reconciliation")); }, []); return <Panel title="Reconciliation center">{error ? <ErrorBox message={error} /> : data ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{["providerEvents", "unverifiedDeposits", "unverifiedRepayments", "pendingPayouts"].map((key) => <div key={key} className="rounded-xl border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900/50 p-4"><div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{key.replace(/([A-Z])/g, " $1")}</div><div className="mt-2 text-2xl font-bold text-velo-900 dark:text-white">{data[key]?.length || 0}</div></div>)}</div> : <div className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">Loading reconciliation…</div>}</Panel>; }
function Audit() { const [rows, setRows] = useState<any[]>([]); const [error, setError] = useState(""); useEffect(() => { fetch("/api/v1/admin/audit-logs", { headers: { Authorization: `Bearer ${sessionStorage.getItem("velo:admin-token")}` } }).then((response) => response.json()).then((body) => setRows(body.logs || [])).catch((err) => setError(err instanceof Error ? err.message : "Unable to load audit logs")); }, []); return <Panel title="Audit log" action={<span className="text-xs text-slate-500 dark:text-slate-400">{rows.length} events</span>}>{error ? <ErrorBox message={error} /> : rows.length ? <Table headers={["Time", "Action", "Resource", "Actor"]}>{rows.map((row) => <tr key={row.id}><td className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400">{new Date(row.createdAt).toLocaleString()}</td><td className="px-3 py-3 font-medium text-velo-900 dark:text-white">{row.action}</td><td className="px-3 py-3 text-slate-600 dark:text-slate-300">{row.resourceType} {row.resourceId || ""}</td><td className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400">{row.userId || "system"}</td></tr>)}</Table> : <Empty />}</Panel>; }