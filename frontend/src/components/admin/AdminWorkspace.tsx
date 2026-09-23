import React, { useEffect, useState } from "react";
import { formatNaira } from "../../utils/loanCalculator";
import {
  adminApprovePayout,
  adminDisburseLoan,
  adminDecideKyc,
  adminDecideKycRequirement,
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
import { documentDownloadUrl, documentPreviewUrl } from "../../utils/documentLinks";
import {
  adminListDisbursements,
  adminListAuditLogs,
  adminCreateUser,
  adminPatchUserRoles,
  adminEditUser,
  adminResetKycCategory,
  adminRequestDisbursementAccountUpdate,
  type KycResetCategory,
  type LoanDisbursement,
} from "../../services/adminApi";
import { LineChart, DonutChart, BarChart, type LineSeries, type DonutSlice, type BarGroup } from "./Charts";

export type AdminSection = "overview" | "borrowers" | "investors" | "kyc" | "payouts" | "loans" | "reconciliation" | "audit";

const moneyKeys = new Set(["disbursedPrincipal", "outstandingPrincipal", "activeInvestmentPrincipal"]);
const labels: Record<string, string> = { users: "Total users", investors: "Investors", borrowers: "Borrowers", kycPending: "KYC pending", kycVerified: "KYC verified", loans: "Loan applications", approvedLoans: "Approved loans", disbursedPrincipal: "Disbursed principal", outstandingPrincipal: "Outstanding principal", investments: "Investments", activeInvestmentPrincipal: "Active investment principal", pendingPayments: "Pending payments", pendingPayouts: "Pending payouts", failedPayouts: "Failed payouts", reconciliationItems: "Reconciliation items" };

export default function AdminWorkspace({ section, onSelectBorrower, onSelectLoan }: { section: AdminSection; onSelectBorrower?: (user: any) => void; onSelectLoan?: (loanId: string) => void }) {
  if (section === "overview") return <Overview />;
  if (section === "borrowers") return <Users role="BORROWER" title="Borrowers" onSelect={onSelectBorrower} />;
  if (section === "investors") return <Investors />;
  if (section === "kyc") return <Kyc />;
  if (section === "payouts") return <Payouts />;
  if (section === "loans") return <Loans onSelect={onSelectLoan} />;
  if (section === "reconciliation") return <Reconciliation />;
  return <Audit />;
}

function Panel({ title, subtitle, children, action }: { title: string; subtitle?: string; children: React.ReactNode; action?: React.ReactNode }) { return <section className="velo-card overflow-hidden dark:bg-slate-900 dark:border-slate-800 rounded-2xl"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 px-5 py-4"><div><h2 className="font-semibold text-velo-900 dark:text-white">{title}</h2>{subtitle && <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{subtitle}</p>}</div>{action}</div><div className="p-5">{children}</div></section>; }
function Empty({ text = "No records found." }: { text?: string }) { return <div className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">{text}</div>; }
function ErrorBox({ message }: { message: string }) { return <div className="rounded-lg border border-red-100 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-400">{message}</div>; }
function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) { return <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-slate-100 dark:border-slate-800 text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{headers.map((header) => <th key={header} className="whitespace-nowrap px-3 py-3">{header}</th>)}</tr></thead><tbody className="divide-y divide-slate-100 dark:divide-slate-800">{children}</tbody></table></div>; }

function KycResetButtons({ user, busyPrefix, actionBusy, onReset }: { user: any; busyPrefix: string; actionBusy: string; onReset: (user: any, category: KycResetCategory) => void | Promise<void>; }) {
  const items: Array<{ cat: KycResetCategory; label: string; hint?: string; tone?: string }> = [
    { cat: "BVN", label: "Reset BVN", hint: "Clear BVN + provider response + checklist.bvn" },
    { cat: "NIN", label: "Reset NIN", hint: "Clear NIN + provider response + checklist.nin" },
    { cat: "LIVENESS", label: "Reset Liveness", hint: "Clear liveness/selfie + checklist.liveness" },
    { cat: "ADDRESS", label: "Reset Address", hint: "Delete proof-of-address doc + checklist.proofOfAddress" },
    { cat: "ALL", label: "Reset Full KYC", hint: "Wipe every KYC field, document, and provider event", tone: "danger" },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(({ cat, label, hint, tone }) => {
        const busy = actionBusy === `${busyPrefix}-${user.id}-${cat}`;
        return (
          <button
            key={cat}
            type="button"
            title={hint}
            disabled={busy}
            onClick={() => void onReset(user, cat)}
            className={`inline-flex px-2 py-1 rounded-lg border text-[10.5px] font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed ${
              tone === "danger"
                ? "border-red-200 bg-red-50 hover:bg-red-100 text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-900/40"
                : "border-slate-200 bg-white hover:bg-amber-50 text-slate-700 hover:text-amber-800 hover:border-amber-300 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-amber-950/30 dark:hover:border-amber-700 dark:hover:text-amber-200"
            }`}
          >
            {busy ? "Resetting…" : label}
          </button>
        );
      })}
    </div>
  );
}

function Overview() {
  const [data, setData] = useState<AdminSummaryResponse | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { getAdminSummary().then(setData).catch((err) => setError(err instanceof Error ? err.message : "Unable to load summary")); }, []);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Panel title="Portfolio overview"><div className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">Loading dashboard overview…</div></Panel>;

  const totals = data.totals || {};
  const trend = data.trends || [];

  // ----- KPI strip (top 4 + an alerts tile) -----
  const kpis: Array<{ label: string; value: string; sub?: string; tone: "default" | "warning" | "danger" }> = [
    { label: "Total users", value: Number(totals.users || 0).toLocaleString(), sub: `${Number(totals.borrowers || 0)} borrowers · ${Number(totals.investors || 0)} investors`, tone: "default" },
    { label: "Disbursed principal", value: formatNaira(Number(totals.disbursedPrincipal || 0)), sub: `${Number(totals.approvedLoans || 0)} approved loans`, tone: "default" },
    { label: "Outstanding principal", value: formatNaira(Number(totals.outstandingPrincipal || 0)), sub: `${Number(totals.loans || 0)} applications total`, tone: "default" },
    { label: "Active investments", value: formatNaira(Number(totals.activeInvestmentPrincipal || 0)), sub: `${Number(totals.investments || 0)} investments`, tone: "default" },
  ];

  const alerts: Array<{ label: string; value: number; severity: "warning" | "danger" }> = [
    { label: "KYC pending", value: Number(totals.kycPending || 0), severity: "warning" },
    { label: "Pending payouts", value: Number(totals.pendingPayouts || 0), severity: "warning" },
    { label: "Failed payouts", value: Number(totals.failedPayouts || 0), severity: "danger" },
    { label: "Reconciliation items", value: Number(totals.reconciliationItems || 0), severity: "danger" },
  ];
  const totalAlerts = alerts.reduce((s, a) => s + a.value, 0);

  // ----- Loan activity trend (line chart) -----
  const trendLabels = trend.map((t) => {
    const d = new Date(t.date);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  });
  const trendSeries: LineSeries[] = [
    { label: "Applications", color: "#10B981", values: trend.map((t) => Number(t.applications || 0)) },
    { label: "Disbursements", color: "#0EA5E9", values: trend.map((t) => Number(t.disbursements || 0)) },
    { label: "Repayments", color: "#F59E0B", values: trend.map((t) => Number(t.repayments || 0)) },
  ];

  // ----- Portfolio mix (donut) -----
  const portfolioSlices: DonutSlice[] = [
    { label: "Approved loans", value: Number(totals.approvedLoans || 0), color: "#10B981" },
    { label: "Pending payments", value: Number(totals.pendingPayments || 0), color: "#F59E0B" },
    { label: "Pending payouts", value: Number(totals.pendingPayouts || 0), color: "#0EA5E9" },
    { label: "KYC pending", value: Number(totals.kycPending || 0), color: "#8B5CF6" },
    { label: "Failed payouts", value: Number(totals.failedPayouts || 0), color: "#EF4444" },
  ];

  // ----- Applications by status (bar chart) -----
  // Pulled from recentActivity + totals where possible.
  const statusGroups: BarGroup[] = [
    {
      label: "Loans",
      bars: [
        { value: Number(totals.loans || 0), color: "#10B981" },
        { value: Number(totals.approvedLoans || 0), color: "#0EA5E9" },
      ],
    },
    {
      label: "Investments",
      bars: [
        { value: Number(totals.investments || 0), color: "#F59E0B" },
      ],
    },
    {
      label: "Payouts",
      bars: [
        { value: Number(totals.pendingPayouts || 0), color: "#8B5CF6" },
        { value: Number(totals.failedPayouts || 0), color: "#EF4444" },
      ],
    },
    {
      label: "Reconciliation",
      bars: [
        { value: Number(totals.reconciliationItems || 0), color: "#F97316" },
      ],
    },
  ];

  return (
    <div className="space-y-5">
      {/* KPI strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/50">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{k.label}</div>
            <div className="mt-1.5 text-2xl font-semibold text-velo-900 dark:text-white">{k.value}</div>
            {k.sub && <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{k.sub}</div>}
          </div>
        ))}
      </div>

      {/* Alerts strip */}
      <div className={`rounded-2xl border p-4 ${totalAlerts > 0 ? "border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/20" : "border-emerald-200 bg-emerald-50 dark:border-emerald-900/40 dark:bg-emerald-900/20"}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2 w-2 rounded-full ${totalAlerts > 0 ? "bg-amber-500" : "bg-emerald-500"}`} />
            <h3 className="text-sm font-semibold text-velo-900 dark:text-white">
              {totalAlerts > 0 ? `${totalAlerts} item${totalAlerts === 1 ? "" : "s"} need attention` : "All clear — no pending alerts"}
            </h3>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
            {alerts.map((a) => (
              <span key={a.label} className="inline-flex items-center gap-1.5">
                <span className={`inline-block h-2 w-2 rounded-full ${a.severity === "danger" ? "bg-red-500" : "bg-amber-500"}`} />
                <span className="text-slate-600 dark:text-slate-300">{a.label}:</span>
                <strong className={a.value > 0 ? (a.severity === "danger" ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-300") : "text-slate-500 dark:text-slate-400"}>{a.value}</strong>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Charts row 1: loan activity trend (left) + portfolio mix (right) */}
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Panel title="Loan activity trend" subtitle="Applications, disbursements, and repayments over the last 7 days">
            {trend.length > 0 ? (
              <LineChart series={trendSeries} labels={trendLabels} height={240} />
            ) : (
              <div className="flex h-52 items-center justify-center text-sm text-slate-500 dark:text-slate-400">Trend data will appear as activity accumulates.</div>
            )}
          </Panel>
        </div>
        <div className="lg:col-span-2">
          <Panel title="Portfolio mix" subtitle="Where attention is needed across the platform">
            <DonutChart slices={portfolioSlices} size={180} />
          </Panel>
        </div>
      </div>

      {/* Charts row 2: bar chart (left) + recent activity (right) */}
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Panel title="Platform volumes" subtitle="Loans, investments, payouts, and reconciliation items at a glance">
            <BarChart groups={statusGroups} height={220} />
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />Total / healthy</span>
              <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-sky-500" />Approved / pending payout</span>
              <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-amber-500" />Investments</span>
              <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-violet-500" />Pending</span>
              <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-red-500" />Failed</span>
              <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-orange-500" />Reconciliation</span>
            </div>
          </Panel>
        </div>
        <div className="lg:col-span-2">
          <Panel title="Recent activity">
            <div className="space-y-2">
              {data.recentActivity?.length ? (
                data.recentActivity.slice(0, 6).map((activity: any, index: number) => (
                  <div key={activity.id || index} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 text-sm dark:bg-slate-950">
                    <span className="font-medium text-slate-700 dark:text-slate-200 truncate pr-2">{activity.action || activity.eventType || "Platform activity"}</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400 shrink-0">{activity.createdAt ? new Date(activity.createdAt).toLocaleString("en-NG") : "Recently"}</span>
                  </div>
                ))
              ) : (
                <Empty text="No recent admin activity yet." />
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
function Users({ role, title, onSelect }: { role: "BORROWER" | undefined; title: string; onSelect?: (user: any) => void }) {
  const [rows, setRows] = useState<any[]>([]); const [error, setError] = useState(""); const [page, setPage] = useState(0); const [total, setTotal] = useState(0); const size = 20;
  const [createOpen, setCreateOpen] = useState(false);
  const [editFor, setEditFor] = useState<any>(null);
  const [actionBusy, setActionBusy] = useState("");
  const [formError, setFormError] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newFullName, setNewFullName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRoles, setNewRoles] = useState<Array<"INVESTOR" | "BORROWER">>(["INVESTOR", "BORROWER"]);
  const [editFullName, setEditFullName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editRoles, setEditRoles] = useState<Array<"INVESTOR" | "BORROWER">>(["INVESTOR", "BORROWER"]);

  async function reload() {
    try {
      const response = await adminListUsers(size, page * size, role);
      setRows(response.users);
      setTotal(response.meta?.total || response.users.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load users");
    }
  }
  useEffect(() => { setPage(0); }, [role]);
  useEffect(() => { void reload(); }, [role, page]);
  const pages = Math.max(1, Math.ceil(total / size));

  async function handleCreate() {
    if (!newEmail || !newFullName || !newPhone || !newPassword || !newRoles.length) return;
    setActionBusy("create"); setFormError("");
    try {
      await adminCreateUser({ email: newEmail, fullName: newFullName, phone: newPhone, password: newPassword, roles: newRoles });
      setCreateOpen(false);
      setNewEmail(""); setNewFullName(""); setNewPhone(""); setNewPassword(""); setNewRoles(["INVESTOR", "BORROWER"]);
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Unable to create user");
    } finally { setActionBusy(""); }
  }

  function openEdit(user: any) {
    setEditFor(user);
    setEditFullName(user.fullName || "");
    setEditPhone(user.phone || "");
    setEditRoles(Array.isArray(user.roles) ? user.roles.filter((r: string) => r === "INVESTOR" || r === "BORROWER") : ["INVESTOR", "BORROWER"]);
    setFormError("");
  }

  async function saveEdit() {
    if (!editFor) return;
    setActionBusy(`edit-${editFor.id}`); setFormError("");
    try {
      await adminEditUser(editFor.id, { fullName: editFullName, phone: editPhone });
      await adminPatchUserRoles(editFor.id, editRoles);
      setEditFor(null);
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Unable to save changes");
    } finally { setActionBusy(""); }
  }

  function RoleChips({ roles }: { roles?: string[] }) {
    if (!roles || !roles.length) return <span className="text-slate-400 text-xs">—</span>;
    return <div className="flex flex-wrap gap-1">{roles.map((r) => <span key={r} className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${r === "INVESTOR" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" : r === "BORROWER" ? "bg-velo-50 text-velo-700 dark:bg-velo-900/30 dark:text-velo-400" : "bg-slate-100 text-slate-600"}`}>{r}</span>)}</div>;
  }

  return (
    <>
      <Panel
        title={`${title} management`}
        action={
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500 dark:text-slate-400">{total} records</span>
            <button type="button" onClick={() => { setCreateOpen(true); setFormError(""); }} className="btn-primary !py-2 !px-3 text-xs font-bold">
              + Create User
            </button>
          </div>
        }
      >
        {error ? <ErrorBox message={error} /> : (
          <Table headers={["Name", "Email", "Phone", "Roles", "KYC", "Status", "Created", "Actions"]}>
            {rows.map((user) => (
              <tr key={user.id} className="hover:bg-velo-50/40 dark:hover:bg-slate-800/40">
                <td className="px-3 py-3 font-medium text-velo-900 dark:text-white">{user.fullName}</td>
                <td className="px-3 py-3 text-slate-600 dark:text-slate-300 text-xs">{user.email}</td>
                <td className="px-3 py-3 text-slate-600 dark:text-slate-300 text-xs">{user.phone || "—"}</td>
                <td className="px-3 py-3"><RoleChips roles={user.roles} /></td>
                <td className="px-3 py-3"><span className="badge bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">{user.kycStatus || "NOT_STARTED"}</span></td>
                <td className="px-3 py-3"><span className={`inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold ${user.isActive === false ? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400" : "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"}`}>{user.isActive === false ? "Inactive" : "Active"}</span></td>
                <td className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400">{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—"}</td>
                <td className="px-3 py-3">
                  <div className="flex gap-2">
                    {onSelect && <button type="button" onClick={() => onSelect(user)} className="px-2.5 py-1 rounded-lg bg-velo-500 text-[11px] font-semibold text-white hover:bg-velo-600">View</button>}
                    <button type="button" onClick={() => openEdit(user)} className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-[11px] font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300">Edit</button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
        {!error && !rows.length && <Empty />}
        {!error && <Pager page={page} pages={pages} onPage={setPage} />}
      </Panel>

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-fade-in">
          <div className="velo-card rounded-2xl w-full max-w-lg p-5 sm:p-6 animate-slide-in-left">
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-semibold text-velo-900 dark:text-white text-lg">Create new user</h3>
              <button type="button" onClick={() => { setCreateOpen(false); setFormError(""); }} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xl leading-none">×</button>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">A wallet is automatically created for the new user.</p>
            {formError && <div className="mt-3"><ErrorBox message={formError} /></div>}
            <div className="mt-4 grid gap-3">
              <label className="velo-label">Full name<input className="velo-input mt-1" value={newFullName} onChange={(e) => setNewFullName(e.target.value)} placeholder="e.g. John Doe" /></label>
              <label className="velo-label">Email<input className="velo-input mt-1" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="you@example.com" /></label>
              <label className="velo-label">Phone<input className="velo-input mt-1" value={newPhone} onChange={(e) => setNewPhone(e.target.value.replace(/\D/g, ""))} placeholder="0801 234 5678" inputMode="numeric" /></label>
              <label className="velo-label">Temporary password (min 12 chars)<input className="velo-input mt-1" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="At least 12 characters" /></label>
              <div>
                <div className="velo-label mb-1">Roles</div>
                <div className="flex flex-wrap gap-2">
                  {(["INVESTOR", "BORROWER"] as const).map((r) => {
                    const checked = newRoles.includes(r);
                    return (
                      <label key={r} className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-xs font-semibold transition ${checked ? "border-velo-400 bg-velo-50 text-velo-800 dark:border-velo-600/50 dark:bg-velo-900/20 dark:text-velo-300" : "border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-400"}`}>
                        <input type="checkbox" checked={checked} onChange={() => setNewRoles(checked ? newRoles.filter((x) => x !== r) : [...newRoles, r])} className="accent-velo-600" />
                        {r}
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="mt-5 flex gap-3 justify-end">
              <button type="button" onClick={() => { setCreateOpen(false); setFormError(""); }} className="btn-secondary text-sm">Cancel</button>
              <button type="button" onClick={() => void handleCreate()} disabled={!newEmail || !newFullName || !newPhone || newPassword.length < 12 || !newRoles.length || actionBusy === "create"} className="btn-primary text-sm">
                {actionBusy === "create" ? "Creating…" : "Create user"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-fade-in">
          <div className="velo-card rounded-2xl w-full max-w-lg p-5 sm:p-6 animate-slide-in-left">
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-semibold text-velo-900 dark:text-white text-lg">Edit user</h3>
              <button type="button" onClick={() => { setEditFor(null); setFormError(""); }} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xl leading-none">×</button>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">Update basic info and access roles for {editFor.fullName || editFor.email}.</p>
            {formError && <div className="mt-3"><ErrorBox message={formError} /></div>}
            <div className="mt-4 grid gap-3">
              <label className="velo-label">Full name<input className="velo-input mt-1" value={editFullName} onChange={(e) => setEditFullName(e.target.value)} /></label>
              <label className="velo-label">Phone<input className="velo-input mt-1" value={editPhone} onChange={(e) => setEditPhone(e.target.value.replace(/\D/g, ""))} inputMode="numeric" /></label>
              <div>
                <div className="velo-label mb-1">Roles</div>
                <div className="flex flex-wrap gap-2">
                  {(["INVESTOR", "BORROWER"] as const).map((r) => {
                    const checked = editRoles.includes(r);
                    return (
                      <label key={r} className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-xs font-semibold transition ${checked ? "border-velo-400 bg-velo-50 text-velo-800 dark:border-velo-600/50 dark:bg-velo-900/20 dark:text-velo-300" : "border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-400"}`}>
                        <input type="checkbox" checked={checked} onChange={() => setEditRoles(checked ? editRoles.filter((x) => x !== r) : [...editRoles, r])} className="accent-velo-600" />
                        {r}
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="mt-5 flex gap-3 justify-end">
              <button type="button" onClick={() => { setEditFor(null); setFormError(""); }} className="btn-secondary text-sm">Cancel</button>
              <button type="button" onClick={() => void saveEdit()} disabled={actionBusy === `edit-${editFor.id}` || !editRoles.length} className="btn-primary text-sm">
                {actionBusy === `edit-${editFor.id}` ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
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
function DocumentTypeIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M14 2v6h6M8 13h8M8 17h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>;
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
  const [rows, setRows] = useState<any[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(""); const [actionBusy, setActionBusy] = useState(""); const [selected, setSelected] = useState<any>(null); const [rejectionReason, setRejectionReason] = useState(""); const [rejecting, setRejecting] = useState(false); const [requirementReject, setRequirementReject] = useState<{ id: string; requirement: any } | null>(null);
  const load = () => adminListKycCases(100).then((response) => setRows(response.cases)).catch((err) => setError(err instanceof Error ? err.message : "Unable to load KYC cases"));
  useEffect(() => { load(); }, []);
  async function decide(id: string, decision: "VERIFIED" | "REJECTED") { if (decision === "REJECTED") { if (!rejectionReason.trim()) { setError("Enter a rejection reason before rejecting this KYC."); return; } setRejecting(false); } setBusy(id); try { await adminDecideKyc(id, { decision, rejectedReason: decision === "REJECTED" ? rejectionReason.trim() : undefined }); setRejectionReason(""); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Unable to update KYC"); } finally { setBusy(""); } }
  async function decideRequirement(id: string, requirement: "bvn" | "nin" | "liveness" | "proofOfAddress" | "passport" | "signature", approved: boolean, note?: string) {
    if (!approved && !note) { setRejectionReason(""); setRequirementReject({ id, requirement }); return; }
    setActionBusy(`requirement-${id}-${requirement}`);
    try {
      const response = await adminDecideKycRequirement(id, requirement, approved, note);
      setSelected((current: any) => current?.id === id ? response.case : current);
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to update KYC requirement"); }
    finally { setActionBusy(""); }
  }
  async function resetKycCase(user: any, category: KycResetCategory) {
    const label: Record<KycResetCategory, string> = { BVN: "BVN", NIN: "NIN", LIVENESS: "Liveness", ADDRESS: "Proof of address", ALL: "Full KYC profile" };
    const reason = category === "ALL"
      ? `This will PERMANENTLY clear every piece of KYC for "${user.fullName}" (BVN, NIN, liveness, proof of address, documents, provider events). User will need to re-verify everything. Continue?`
      : `Reset ${label[category]} for "${user.fullName}"? Any data for this category will be cleared and the user will be asked to re-verify. Continue?`;
    if (!confirm(reason)) return;
    setActionBusy(`kycreset-kycpanel-case-${user.id}-${category}`);
    try {
      await adminResetKycCategory(user.id, category);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unable to reset KYC ${label[category]}`);
    } finally { setActionBusy(""); }
  }
  function ChecklistChips({ checklist }: { checklist?: Record<string, boolean> }) {
    const items = [
      { key: "bvn", label: "BVN" },
      { key: "nin", label: "NIN" },
      { key: "liveness", label: "Liveness" },
      { key: "proofOfAddress", label: "Address" },
      { key: "passport", label: "Passport" },
      { key: "signature", label: "Signature" },
    ];
    const total = Object.keys(checklist || {}).length || 6;
    const done = Object.values(checklist || {}).filter(Boolean).length;
    return (<div className="space-y-2">
      <div className="flex flex-wrap gap-1">{items.map((it) => { const ok = Boolean(checklist?.[it.key]); return (<span key={it.key} className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold border ${ok ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800" : "bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700"}`}>{ok ? "✓ " : "○ "}{it.label}</span>); })}</div>
      <div className="text-[11px] text-slate-500 dark:text-slate-400">{done}/{total} complete</div>
    </div>);
  }
  if (selected) {
    const userShim = { id: selected.userId, fullName: selected.user?.fullName || selected.userId, email: selected.user?.email || "" };
    const checklistItems = [
      ["BVN", "bvn"], ["NIN", "nin"], ["Liveness", "liveness"],
      ["Proof of address", "proofOfAddress"], ["Passport", "passport"], ["Signature", "signature"],
    ];
    const docLabelMap: Record<string, { label: string }> = {
      PROOF_OF_ADDRESS: { label: "Proof of Address" },
      SIGNATURE: { label: "Signature" },
      PASSPORT_PHOTO: { label: "Passport Photo" },
      BVN_SLIP: { label: "BVN Slip" },
      NIN_SLIP: { label: "NIN Slip" },
      BUSINESS_REGISTRATION: { label: "Business Registration" },
      ID_CARD_FRONT: { label: "ID Card (Front)" },
      ID_CARD_BACK: { label: "ID Card (Back)" },
    };
    const docs = Array.isArray(selected.documents) ? selected.documents : [];
    const isImage = (type: string) => /^image\//i.test(type || "") || /\.(png|jpe?g|gif|webp)$/i.test(type || "");
    return (
      <div className="space-y-5 animate-fade-in">
        <button type="button" onClick={() => setSelected(null)} className="btn-ghost text-xs">← Back to review queue</button>
        <div className="velo-card overflow-hidden dark:bg-slate-900 dark:border-slate-800 rounded-2xl">
          <div className="border-b border-slate-100 dark:border-slate-800 px-5 py-5 sm:px-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-xl font-semibold text-velo-900 dark:text-white">{userShim.fullName}</h1>
                  <span className="badge bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">{selected.status}</span>
                </div>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{userShim.email}</p>
                <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">Submitted {selected.submittedAt ? new Date(selected.submittedAt).toLocaleString() : "—"}</p>
              </div>
              <div className="flex gap-2">
                <button className="btn-primary text-xs" disabled={busy === selected.id} onClick={() => decide(selected.id, "VERIFIED")}>{busy === selected.id ? "Saving…" : "Verify KYC"}</button>
                <button className="btn-secondary text-xs" disabled={busy === selected.id} onClick={() => { setRejectionReason(""); setRejecting(true); }}>Reject</button>
              </div>
            </div>
          </div>
          {requirementReject && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"><div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900"><h2 className="text-base font-semibold text-velo-900 dark:text-white">Reject {String(requirementReject.requirement).replace(/([A-Z])/g, ' $1')}</h2><p className="mt-1 text-xs text-slate-500">Enter the reason that will be sent to the customer.</p><textarea value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} rows={4} maxLength={1000} className="velo-input mt-3 w-full" placeholder="Reason for rejection" /><div className="mt-4 flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setRequirementReject(null)}>Cancel</button><button type="button" className="btn-primary bg-red-600 hover:bg-red-700" disabled={!rejectionReason.trim()} onClick={() => { const target = requirementReject; setRequirementReject(null); void decideRequirement(target.id, target.requirement, false, rejectionReason.trim()); }}>Confirm rejection</button></div></div></div>}
          {rejecting && <div className="border-b border-red-100 bg-red-50/70 px-5 py-4 dark:border-red-900/40 dark:bg-red-900/15"><div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold text-red-800 dark:text-red-200">Reject KYC</h2><button type="button" className="text-xs text-red-700" onClick={() => setRejecting(false)}>Cancel</button></div><p className="mt-1 text-xs text-red-700 dark:text-red-300">This reason will be shown in the user dashboard and included in their email.</p><textarea value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} maxLength={1000} rows={3} className="velo-input mt-3 w-full" placeholder="Enter the reason for rejection" /><button type="button" className="btn-primary mt-3 bg-red-600 hover:bg-red-700" disabled={!rejectionReason.trim() || busy === selected.id} onClick={() => void decide(selected.id, "REJECTED")}>Confirm rejection</button></div>}
          <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[1fr_280px]">
            <div className="space-y-6">
              <div>
                <h2 className="text-sm font-semibold text-velo-900 dark:text-white">Verification checklist</h2>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Approve or reject individual KYC requirements. The overall KYC status is set separately with the top buttons.</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {checklistItems.map(([label, key]) => {
                    const complete = Boolean(selected.checklist?.[key]);
                    const busyKey = `requirement-${selected.id}-${key}`;
                    return <div key={key} className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-3 ${complete ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-900/50 dark:bg-emerald-900/15" : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50"}`}><span className="text-sm font-medium text-slate-700 dark:text-slate-200">{label}</span><div className="flex items-center gap-2"><span className={`text-xs font-semibold ${complete ? "text-emerald-700 dark:text-emerald-300" : "text-slate-400"}`}>{complete ? "Approved" : "Pending"}</span><button type="button" className="rounded-lg border border-emerald-200 px-2 py-1 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:hover:bg-emerald-900/20" disabled={actionBusy === busyKey} onClick={() => void decideRequirement(selected.id, key as any, true)}>Approve</button><button type="button" className="rounded-lg border border-red-200 px-2 py-1 text-[10px] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:hover:bg-red-900/20" disabled={actionBusy === busyKey} onClick={() => void decideRequirement(selected.id, key as any, false)}>Reject</button></div></div>;
                  })}
                </div>
              </div>
              <div>
                <h2 className="text-sm font-semibold text-velo-900 dark:text-white">Uploaded documents</h2>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Review all files the user submitted. Click the thumbnail or link to open the document in a new tab.</p>
                {docs.length === 0 ? (
                  <div className="mt-3 rounded-xl border border-dashed border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/30 p-6 text-center">
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">No documents uploaded yet for this KYC case.</div>
                  </div>
                ) : (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {docs.map((doc: any) => {
                      const meta = docLabelMap[doc.documentType] || { label: doc.documentType || "Document" };
                      const previewable = isImage(doc.mimeType || doc.fileName || "");
                      const previewUrl = documentPreviewUrl(doc);
                      const downloadUrl = documentDownloadUrl(doc);
                      const url = previewUrl || downloadUrl;
                      const statusCls =
                        doc.status === "VERIFIED" || doc.status === "APPROVED" ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800/50 dark:bg-emerald-900/10"
                        : doc.status === "REJECTED" ? "border-red-200 bg-red-50 dark:border-red-800/50 dark:bg-red-900/10"
                        : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800/40";
                      return (
                        <div key={doc.id} className={`group rounded-xl border p-3 flex flex-col gap-2 transition hover:shadow-md hover:border-velo-300 dark:hover:border-velo-500 ${statusCls}`}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200"><DocumentTypeIcon />{meta.label}</span>
                            {doc.status && <span className={`text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${doc.status === "VERIFIED" || doc.status === "APPROVED" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : doc.status === "REJECTED" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" : "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300"}`}>{doc.status}</span>}
                          </div>
                          <div className="aspect-video w-full rounded-lg border border-slate-100 dark:border-slate-700 overflow-hidden bg-slate-50 dark:bg-slate-900/60">
                            {previewable ? (
                              <img src={url} alt={doc.fileName || meta.label} className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                            ) : (
                              <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-slate-400 dark:text-slate-500">
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M14 2v6h6M9 13h6M9 17h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
                                <span className="text-[10px] font-semibold">PDF / Document</span>
                              </div>
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-200 truncate" title={doc.fileName}>{doc.fileName || "View document"}</div>
                            <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">{doc.sizeBytes ? `${Math.round(Number(doc.sizeBytes) / 1024)} KB · ` : ""}{doc.createdAt ? new Date(doc.createdAt).toLocaleDateString() : ""}</div>
                          </div>
                          <div className="flex items-center gap-3 text-[10px] font-semibold">
                            {previewUrl && <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="text-velo-600 dark:text-velo-400 hover:underline">Preview</a>}
                            {downloadUrl && <a href={downloadUrl} download={doc.fileName} className="text-slate-600 dark:text-slate-300 hover:underline">Download</a>}
                            {!url && <span className="text-slate-400">File link unavailable</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              {(selected.identityPhoto || selected.selfieImageData) && (
                <div>
                  <h2 className="text-sm font-semibold text-velo-900 dark:text-white">Identity photos</h2>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {selected.identityPhoto && (
                      <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 bg-white dark:bg-slate-800/40">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">Government ID portrait</div>
                        <img src={selected.identityPhoto} alt="Government ID portrait" className="w-full aspect-[4/5] object-cover rounded-lg border border-slate-100 dark:border-slate-700" />
                      </div>
                    )}
                    {selected.selfieImageData && (
                      <div className="rounded-xl border border-emerald-200 dark:border-emerald-800/50 p-3 bg-emerald-50/50 dark:bg-emerald-900/10">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300 mb-2">Liveness selfie</div>
                        <img src={selected.selfieImageData} alt="Live captured selfie" className="w-full aspect-[4/5] object-cover rounded-lg border border-emerald-200 dark:border-emerald-800/60" />
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div>
                <h2 className="text-sm font-semibold text-velo-900 dark:text-white">Case information</h2>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {[['Case ID', selected.id], ['User ID', selected.userId], ['Review status', selected.status], ['Last updated', selected.updatedAt ? new Date(selected.updatedAt).toLocaleString() : '—']].map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 p-4 dark:bg-slate-800/60"><div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div><div className="mt-1 break-all text-sm font-medium text-velo-900 dark:text-white">{value || '—'}</div></div>)}
                </div>
              </div>
            </div>
            <aside className="rounded-xl border border-slate-200 p-4 dark:border-slate-700 h-fit lg:sticky lg:top-4">
              <h2 className="text-sm font-semibold text-velo-900 dark:text-white">Admin actions</h2>
              <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">Reset only the verification step that needs to be completed again.</p>
              <div className="mt-4"><KycResetButtons user={userShim} busyPrefix={`kycreset-kycpanel-case-${selected.id}`} actionBusy={actionBusy} onReset={resetKycCase} /></div>
            </aside>
          </div>
        </div>
      </div>
    );
  }
  return <Panel title="KYC review queue" action={<span className="text-xs text-slate-500 dark:text-slate-400">{rows.length} cases</span>}>{error && <ErrorBox message={error} />}{rows.length ? <Table headers={["Applicant", "Status", "Progress", "Submitted", ""]}>{rows.map((item) => { const completed = Object.values(item.checklist || {}).filter(Boolean).length; const total = Object.keys(item.checklist || {}).length || 6; return (<tr key={item.id} className="cursor-pointer hover:bg-velo-50/40 dark:hover:bg-slate-800/40" onClick={() => setSelected(item)}><td className="px-3 py-4"><div className="font-medium text-velo-900 dark:text-white">{item.user?.fullName || item.userId}</div><div className="text-xs text-slate-500 dark:text-slate-400">{item.user?.email || ""}</div></td><td className="px-3 py-4"><span className="badge bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">{item.status}</span></td><td className="px-3 py-4"><div className="min-w-32"><div className="flex justify-between text-xs text-slate-500 dark:text-slate-400"><span>{completed}/{total} checks</span><span>{Math.round(completed / total * 100)}%</span></div><div className="mt-1.5 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${Math.max(4, completed / total * 100)}%` }} /></div></div></td><td className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">{item.submittedAt ? new Date(item.submittedAt).toLocaleDateString() : "—"}</td><td className="px-3 py-4 text-right"><button type="button" className="btn-secondary text-xs" onClick={(event) => { event.stopPropagation(); setSelected(item); }}>Review <span aria-hidden="true">→</span></button></td></tr>); })}</Table> : <Empty text="No KYC cases are waiting for review." />}</Panel>;
}

function Payouts() {
  const [rows, setRows] = useState<any[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(""); const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const load = () => adminListPayouts(200).then((response) => setRows(response.payouts)).catch((err) => setError(err instanceof Error ? err.message : "Unable to load payouts"));
  useEffect(() => { load(); }, []);
  async function action(id: string, type: "approve" | "retry") { setBusy(id); try { if (type === "approve") await adminApprovePayout(id); else await adminRetryPayout(id); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Unable to process payout"); } finally { setBusy(""); } }
  return <Panel title="Payout operations (investor)" action={<span className="text-xs text-slate-500 dark:text-slate-400">{rows.length} payouts</span>}>{error && <ErrorBox message={error} />}{rows.length ? <Table headers={["Payout ID", "Investor", "Amount", "Type", "Status", "Created", "Provider details", "Actions"]}>{rows.map((item) => { const isOpen = !!expanded[item.id]; const investor = typeof item.userId === "string" ? item.userId : (item.userId?.id ?? ""); return (<React.Fragment key={item.id}><tr className={isOpen ? "bg-emerald-50/40 dark:bg-emerald-900/10" : ""}><td className="px-3 py-3"><button type="button" onClick={() => setExpanded({ ...expanded, [item.id]: !isOpen })} className="text-left"><div className="font-mono text-xs dark:text-slate-200 inline-flex items-center gap-1"><span className={`transform transition-transform ${isOpen ? "rotate-90" : ""}`}>›</span>{item.id}</div>{item.investmentId ? <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">Investment: {String(item.investmentId).slice(0, 10)}…</div> : null}</button></td><td className="px-3 py-3 dark:text-slate-300 text-xs">{item.user?.fullName ?? item.user?.email ?? investor}</td><td className="px-3 py-3 font-semibold dark:text-slate-200">{formatNaira(Number(item.amountNaira || 0))}<div className="text-[11px] text-slate-500 dark:text-slate-400">P {formatNaira(Number(item.principalNaira || 0))} · E {formatNaira(Number(item.earningsNaira || 0))}</div></td><td className="px-3 py-3 text-xs dark:text-slate-300">{item.payoutType || "PAYOUT"}</td><td className="px-3 py-3"><StatusBadge status={item.status} /></td><td className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400">{item.createdAt ? new Date(item.createdAt).toLocaleDateString() : "—"}</td><td className="px-3 py-3"><ProviderResponse title="View transfer" data={item.providerTransfer} error={item.error} /></td><td className="px-3 py-3"><div className="flex flex-wrap gap-2">{["PENDING_APPROVAL"].includes(item.status) && <button className="btn-primary text-xs" disabled={busy === item.id} onClick={() => action(item.id, "approve")}>Approve</button>}{item.status === "FAILED" && <button className="btn-secondary text-xs" disabled={busy === item.id} onClick={() => action(item.id, "retry")}>Retry</button>}</div></td></tr>{isOpen && (<tr><td colSpan={8} className="px-3 py-4 bg-slate-50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-800"><div className="grid gap-3 sm:grid-cols-2 text-xs"><div className="rounded-lg bg-white dark:bg-slate-900 p-3 border border-slate-100 dark:border-slate-800"><div className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">Payout account snapshot</div><pre className="max-h-60 overflow-auto font-mono text-[11px] text-slate-700 dark:text-slate-300">{JSON.stringify(item.payoutAccountSnapshot || {}, null, 2)}</pre></div><div className="rounded-lg bg-white dark:bg-slate-900 p-3 border border-slate-100 dark:border-slate-800"><div className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">Provider reference / timestamps</div><div>providerReference: <span className="font-mono">{item.providerReference || "—"}</span></div><div>verifiedAt: <span className="font-mono">{item.verifiedAt || "—"}</span></div><div>updatedAt: <span className="font-mono">{item.updatedAt || item.createdAt || "—"}</span></div>{item.retryCount != null && <div>retryCount: {Number(item.retryCount || 0)}</div>}</div></div></td></tr>)}</React.Fragment>); })}</Table> : <Empty text="No payouts require attention." />}</Panel>;
}

function Loans({ onSelect }: { onSelect?: (loanId: string) => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [loanRecords, setLoanRecords] = useState<any[]>([]);
  const [disbursements, setDisbursements] = useState<LoanDisbursement[]>([]);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const size = 20;
  const loadDisbursements = () => adminListDisbursements({ limit: 500 }).then((r) => setDisbursements(r.disbursements)).catch(() => setDisbursements([]));
  useEffect(() => {
    const load = () => adminListLoans(size, page * size).then((response) => {
      setRows(response.loans);
      setLoanRecords(((response as any).loanRecords) || []);
      setTotal(response.meta?.total || response.loans.length);
    }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load loans"));
    void load();
    loadDisbursements();
    const interval = window.setInterval(() => { void load(); loadDisbursements(); }, 3000);
    return () => window.clearInterval(interval);
  }, [page]);
  async function disburseLoan(applicationId: string) {
    setBusy(applicationId);
    setActionError("");
    setActionNotice("");
    try {
      // The route now WAITS for Flutterwave's real final answer, so this
      // response carries the actual provider outcome (SUCCESSFUL / FAILED /
      // still-processing). The button stays disabled for the whole wait.
      const response = await adminDisburseLoan(applicationId);
      const transferStatus = String((response.disbursement as { status?: string } | undefined)?.status || "");
      setLoanRecords((current) => [...current.filter((loan) => loan.id !== (response.loan as any).id), response.loan]);
      if (response.ok === false) {
        setActionError(String(response.error || response.message || "Disbursement failed — see the provider response on the transfer card."));
      } else if (transferStatus === "SUCCESSFUL") {
        setActionNotice(String(response.message || "Disbursement successful."));
      }
      await loadDisbursements();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to initiate disbursement");
    } finally {
      setBusy("");
    }
  }
  async function requestAccountUpdate(loanApp: any) {
    setBusy(`acct-${loanApp.id}`);
    setActionError("");
    setActionNotice("");
    try {
      const response = await adminRequestDisbursementAccountUpdate(loanApp.id);
      setActionNotice(String(response.message || "Account update requested — the customer has been notified."));
      const load = () => adminListLoans(size, page * size).then((resp) => {
        setRows(resp.loans);
        setLoanRecords(((resp as any).loanRecords) || []);
        setTotal(resp.meta?.total || resp.loans.length);
      }).catch(() => undefined);
      void load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to send the account-update request");
    } finally {
      setBusy("");
    }
  }
  function disbursementsForLoan(loanAppId: string, loanRecordId?: string) {
    return disbursements
      .filter((d) => (loanRecordId && d.loanId === loanRecordId) || d.applicationId === loanAppId)
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
  // Disbursement button state machine (per loan application):
  //   done      — a transfer succeeded (or the loan reached a post-disbursement
  //               lifecycle status): the Disburse button must NEVER appear again.
  //   inFlight  — an actual transfer is PROCESSING/PENDING: no button, waiting
  //               for the provider.
  //   failed    — the latest transfer FAILED: show status + provider response
  //               (in the transfer card) and offer "Retry disbursement".
  //   ready     — approved and awaiting disbursement. NOTE: a freshly approved
  //               loan is created with status DISBURSEMENT_PENDING BEFORE any
  //               transfer exists, so that status alone must NOT be treated as
  //               in-flight — only real transfer records gate the button.
  //   locked    — anything else (not approved yet).
  const disbursedDoneStatuses = ["DISBURSED", "ACTIVE", "PAST_DUE", "DEFAULTED", "REPAID", "WRITTEN_OFF"];
  function disburseActionFor(loanApp: any, loanRecord: any, transfers: LoanDisbursement[]): { kind: "done" | "inFlight" | "failed" | "ready" | "locked" } {
    const loanStatus = String(loanRecord?.status || "");
    const hasSuccessfulTransfer = transfers.some((t) => t.status === "SUCCESSFUL");
    const inFlightTransfer = transfers.some((t) => ["PROCESSING", "PENDING"].includes(t.status));
    if (hasSuccessfulTransfer || disbursedDoneStatuses.includes(loanStatus)) return { kind: "done" };
    if (inFlightTransfer) return { kind: "inFlight" };
    if (transfers.length > 0 && transfers[0]?.status === "FAILED") return { kind: "failed" };
    if (loanApp.status === "APPROVED" || ["APPROVED", "DISBURSEMENT_PENDING"].includes(loanStatus)) return { kind: "ready" };
    return { kind: "locked" };
  }
  return <Panel title="Loan management & disbursement tracking" action={<span className="text-xs text-slate-500 dark:text-slate-400">{total} applications · {disbursements.length} transfer records</span>}>{error ? <ErrorBox message={error} /> : <>
    {actionError && (
      <div className="mx-3 mt-3 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
        <span>{actionError}</span>
        <button type="button" className="text-xs font-semibold underline" onClick={() => setActionError("")}>Dismiss</button>
      </div>
    )}
    {actionNotice && (
      <div className="mx-3 mt-3 flex items-start justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300">
        <span>{actionNotice}</span>
        <button type="button" className="text-xs font-semibold underline" onClick={() => setActionNotice("")}>Dismiss</button>
      </div>
    )}
    {rows.length ? <Table headers={["Application / Loan", "Borrower", "Principal", "Application status", "Disbursements", "Actions", "Created"]}>{rows.map((loanApp) => {
    const appId = loanApp.id;
    const matchingLoanRecord = loanRecords.find((l: any) => l.applicationId === appId || l.id === appId);
    const loanRecordId = matchingLoanRecord?.id;
    const transfers = disbursementsForLoan(appId, loanRecordId);
    const action = disburseActionFor(loanApp, matchingLoanRecord, transfers);
    return (
      <React.Fragment key={loanApp.id || loanApp.applicationId}>
        <tr>
          <td className="px-3 py-3">
            <button type="button" onClick={() => onSelect?.(loanApp.applicationId || loanApp.id)} className="font-mono text-xs font-semibold text-velo-700 hover:underline dark:text-velo-400">{loanApp.applicationId || loanApp.id}</button>
            {loanRecordId && loanRecordId !== appId && <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Loan record: {String(loanRecordId).slice(0, 12)}…</div>}
          </td>
          <td className="px-3 py-3 dark:text-slate-300">
            <div>{loanApp.customerSnapshot?.fullName || loanApp.borrowerId || "—"}</div>
            {loanApp.customerSnapshot?.email && <div className="text-[11px] text-slate-500 dark:text-slate-400">{loanApp.customerSnapshot.email}</div>}
          </td>
          <td className="px-3 py-3 font-semibold dark:text-slate-200">{formatNaira(Number(loanApp.principalNaira || loanApp.amountNaira || 0))}</td>
          <td className="px-3 py-3">
            <StatusBadge status={matchingLoanRecord?.status || loanApp.status} />
            {matchingLoanRecord?.disbursementAccountNeedsUpdate === true && (
              <div className="mt-1 inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
                Account update requested
              </div>
            )}
          </td>
          <td className="px-3 py-3">
            {transfers.length > 0
              ? (<div className="space-y-2">
                  {transfers.map((t) => (
                    <div key={t.id} className={`rounded-lg border p-3 ${t.status === "FAILED" ? "border-red-200 bg-red-50/50 dark:border-red-900/50 dark:bg-red-950/20" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
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
                        <div className="mt-3 rounded-md border border-red-200 bg-white px-3 py-2 text-[11px] text-red-700 dark:border-red-900/60 dark:bg-slate-900 dark:text-red-300">
                          <div className="font-semibold">Disbursement failed{t.error ? `: ${t.error}` : ""}.</div>
                          <div className="mt-1">Review the provider response above{t.bankName ? ` and the borrower's account (${t.bankName} · ••••${String(t.accountNumber || "").slice(-4)})` : ""}, then click <strong>Retry disbursement</strong> in the Actions column to trigger it again. The button below stays disabled while a transfer is being processed, and disappears permanently once a transfer succeeds.</div>
                        </div>
                      )}
                      {t.status === "PROCESSING" && (
                        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                          Transfer is being processed by the provider. The final status is confirmed automatically — this row updates within a minute or two.
                        </div>
                      )}
                    </div>
                  ))}
                </div>)
              : <span className="text-xs text-slate-400 dark:text-slate-500">No disbursement records</span>}
          </td>
          <td className="px-3 py-3">
            {action.kind === "ready" && <button type="button" className="btn-primary text-xs" disabled={busy === appId} onClick={() => void disburseLoan(appId)}>{busy === appId ? "Disbursing…" : "Disburse"}</button>}
            {action.kind === "failed" && <button type="button" className="btn-primary text-xs" disabled={busy === appId} onClick={() => void disburseLoan(appId)}>{busy === appId ? "Disbursing…" : "Retry disbursement"}</button>}
            {(action.kind === "ready" || action.kind === "failed") && (
              <div className="mt-2">
                <button
                  type="button"
                  className="text-[11px] font-semibold text-amber-700 underline decoration-amber-400 underline-offset-2 hover:text-amber-800 disabled:opacity-50 dark:text-amber-400"
                  disabled={busy === `acct-${appId}`}
                  title="Notify the customer to re-provide a valid disbursement account from their dashboard settings"
                  onClick={() => void requestAccountUpdate(loanApp)}
                >
                  {busy === `acct-${appId}` ? "Sending request…" : "Ask customer to update account"}
                </button>
              </div>
            )}
            {action.kind === "inFlight" && (
              <span className="inline-flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" aria-hidden="true"></span>
                Disbursement in progress…
              </span>
            )}
            {action.kind === "done" && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <span aria-hidden="true">✓</span> Disbursed
              </span>
            )}
            {action.kind === "locked" && <span className="text-xs text-slate-400 dark:text-slate-500">Approve to disburse</span>}
          </td>
          <td className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400">{loanApp.createdAt ? new Date(loanApp.createdAt).toLocaleDateString() : "—"}</td>
        </tr>
      </React.Fragment>
    );
  })}</Table> : <Empty />}{!error && <Pager page={page} pages={Math.max(1, Math.ceil(total / size))} onPage={setPage} />}</>}</Panel>;
}
function Reconciliation() { const [data, setData] = useState<any>(null); const [error, setError] = useState(""); useEffect(() => { adminGetReconciliation().then(setData).catch((err) => setError(err instanceof Error ? err.message : "Unable to load reconciliation")); }, []); const keys = ["providerEvents", "unverifiedDeposits", "unverifiedRepayments", "pendingPayouts", "pendingWithdrawals"]; return <Panel title="Reconciliation center">{error ? <ErrorBox message={error} /> : data ? <div className="space-y-5"><div className="rounded-xl border border-velo-100 dark:border-velo-900/40 bg-velo-50/60 dark:bg-velo-900/20 p-4"><h3 className="font-semibold text-velo-900 dark:text-velo-100">What is matched</h3><p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Each queue is matched against the provider reference, internal record ID, user, amount, currency, and current status before it is marked resolved.</p><div className="mt-3 grid gap-2 text-xs text-slate-600 dark:text-slate-300">{Object.entries(data.guide || {}).map(([key, value]) => <div key={key}><strong className="text-slate-900 dark:text-white">{key.replace(/([A-Z])/g, " $1")}:</strong> {String(value)}</div>)}</div></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{keys.map((key) => <div key={key} className="rounded-xl border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900/50 p-4"><div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{key.replace(/([A-Z])/g, " $1")}</div><div className="mt-2 text-2xl font-semibold text-velo-900 dark:text-white">{data[key]?.length || 0}</div></div>)}</div></div> : <div className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">Loading reconciliation…</div>}</Panel>; }
function Audit() { const [rows, setRows] = useState<any[]>([]); const [error, setError] = useState(""); const [page, setPage] = useState(0); const [total, setTotal] = useState(0); const size = 20; useEffect(() => { adminListAuditLogs({ limit: size, offset: page * size }).then((body) => { setRows(body.logs || []); setTotal(body.meta?.total || 0); }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load audit logs")); }, [page]); return <Panel title="Audit log" action={<span className="text-xs text-slate-500 dark:text-slate-400">{total} events</span>}>{error ? <ErrorBox message={error} /> : rows.length ? <><Table headers={["Date", "User / actor", "Action", "Details", "Network"]}>{rows.map((row) => <tr key={row.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40"><td className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400">{new Date(row.createdAt).toLocaleString()}</td><td className="px-3 py-3 text-xs text-slate-700 dark:text-slate-200">{row.actor?.fullName || "System"}<br /><span className="text-slate-400">{row.actor?.email || "Automated process"}</span></td><td className="px-3 py-3 font-medium text-velo-900 dark:text-white">{row.action}</td><td className="max-w-xs px-3 py-3 text-xs text-slate-600 dark:text-slate-300">{row.targetUser ? `${row.targetUser.fullName} (${row.targetUser.email})` : ""}{row.resourceType ? ` · ${row.resourceType} ${row.resourceId || ""}` : ""}<pre className="mt-1 whitespace-pre-wrap text-[10px] text-slate-400">{row.metadata ? JSON.stringify(row.metadata) : ""}</pre></td><td className="px-3 py-3 text-[10px] text-slate-500 dark:text-slate-400">{row.ipAddress || "—"}<br />{row.userAgent || "—"}</td></tr>)}</Table><Pager page={page} pages={Math.max(1, Math.ceil(total / size))} onPage={setPage} /></> : <Empty />}</Panel>; }
