import { useCallback, useEffect, useState } from "react";
import { adminListApplications, adminListStats, type AdminApplicationSummary, type AdminStats } from "../../services/adminApi";
import { formatNaira, formatDateLabel } from "../../utils/loanCalculator";

const STATUS_BADGES: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  IN_PROGRESS: "bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800",
  SUBMITTED: "bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800",
  UNDER_REVIEW: "bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800",
  KYC_PENDING: "bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800",
  MORE_INFORMATION_REQUIRED: "bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800",
  APPROVED: "bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800",
  DISBURSEMENT_PENDING: "bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-800",
  DISBURSED: "bg-emerald-100 text-emerald-800 border border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-200 dark:border-emerald-700",
  ACTIVE: "bg-emerald-100 text-emerald-800 border border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-200 dark:border-emerald-700",
  PAST_DUE: "bg-orange-50 text-orange-700 border border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-800",
  DEFAULTED: "bg-red-50 text-red-700 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800",
  REJECTED: "bg-red-50 text-red-700 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800",
  REPAID: "bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800",
  CANCELLED: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  WRITTEN_OFF: "bg-red-50 text-red-700 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800",
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  IN_PROGRESS: "In progress",
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  KYC_PENDING: "KYC pending",
  MORE_INFORMATION_REQUIRED: "More info required",
  APPROVED: "Approved",
  DISBURSEMENT_PENDING: "Disbursement processing",
  DISBURSED: "Disbursed",
  ACTIVE: "Active",
  PAST_DUE: "Past due",
  DEFAULTED: "Defaulted",
  REJECTED: "Rejected",
  REPAID: "Repaid",
  CANCELLED: "Cancelled",
  WRITTEN_OFF: "Written off",
};

function formatStatusLabel(status: string): string {
  return STATUS_LABELS[String(status ?? "").toUpperCase()] ?? String(status ?? "—").replace(/_/g, " ");
}

function badgeClass(status: string): string {
  return STATUS_BADGES[String(status ?? "").toUpperCase()] ?? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
}

export default function AdminApplicationsTable({ onSelect }: { onSelect: (id: string) => void }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [rows, setRows] = useState<AdminApplicationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const size = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [s, l] = await Promise.all([
        adminListStats(),
        adminListApplications({ status, type, search, limit: size, offset: page * size }),
      ]);
      setStats(s);
      setRows(l.applications);
      setTotal(l.total);
    } catch (e: any) {
      setError(e?.message || "Failed to load applications.");
    } finally {
      setLoading(false);
    }
  }, [status, type, search, page]);

  useEffect(() => { setPage(0); }, [status, type, search]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  const pages = Math.max(1, Math.ceil(total / size));

  return (
    <div className="space-y-5">
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <Card label="Total Applications" value={String(stats.total)} />
          <Card label="Loan Disbursed" value={formatNaira(stats.totalLoanDisbursed)} />
          <Card label="Current Revenue" value={formatNaira(stats.realizedRevenue)} />
          <Card label="Awaiting Revenue" value={formatNaira(stats.awaitingRevenue)} />
          <Card label="Repaid" value={String(stats.counts.REPAID || 0)} />
        </div>
      )}

      <div className="velo-card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input
            className="velo-input"
            placeholder="Search ID, name, email, phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="velo-input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All Statuses</option>
            {["DRAFT", "IN_PROGRESS", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "DISBURSED", "REPAID"].map((v) => (
              <option key={v} value={v}>{v.replace(/_/g, " ")}</option>
            ))}
          </select>
          <select className="velo-input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All Types</option>
            <option value="PERSONAL">Personal</option>
            <option value="BUSINESS">Business</option>
          </select>
        </div>
        <div className="mt-2 flex justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>{total} applications · page {page + 1} of {pages}</span>
          <button className="btn-ghost text-xs" onClick={load}>Refresh</button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-100 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="velo-card p-8 text-center text-sm text-slate-500 dark:text-slate-400">Loading applications…</div>
      ) : (
        <div className="velo-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="px-4 py-3">Applicant</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Loan</th>
                  <th className="px-4 py-3 text-right">Repayment</th>
                  <th className="px-4 py-3">Repayment Date</th>
                  <th className="px-4 py-3">Submitted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((a) => (
                  <tr
                    key={a.applicationId}
                    className="hover:bg-velo-50/30 dark:hover:bg-slate-800/40 cursor-pointer transition-colors"
                    onClick={() => onSelect(a.applicationId)}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-velo-900 dark:text-white">{a.applicantName || "—"}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">{a.applicationId}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider ${badgeClass(a.status)}`}>
                        {formatStatusLabel(a.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-velo-900 dark:text-white">{formatNaira(a.loanAmount)}</td>
                    <td className="px-4 py-3 text-right text-slate-700 dark:text-slate-300">{formatNaira(a.totalRepayment)}</td>
                    <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">{a.repaymentDate ? formatDateLabel(a.repaymentDate) : "—"}</td>
                    <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">{a.dateSubmitted ? formatDateLabel(a.dateSubmitted) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && (
            <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">No applications match your filters.</div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <button className="btn-secondary text-xs" disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>Previous</button>
        <span className="text-xs text-slate-500 dark:text-slate-400">Page {page + 1} of {pages}</span>
        <button className="btn-secondary text-xs" disabled={page >= pages - 1 || loading} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-100 dark:border-slate-800 p-3 bg-slate-50 dark:bg-slate-900/50">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div>
      <div className="text-lg font-bold text-velo-900 dark:text-white mt-1">{value}</div>
    </div>
  );
}
