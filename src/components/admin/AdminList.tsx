// ============================================================================
// src/components/admin/AdminList.tsx
// Lists applications with filters + search. Click a row to view detail.
// ============================================================================

import { useEffect, useCallback, useState } from "react";
import {
  adminListApplications,
  adminListStats,
  type AdminApplicationSummary,
  type AdminStats,
} from "../../services/adminApi";
import { formatNaira, formatDateLabel } from "../../utils/loanCalculator";

interface AdminListProps {
  onSelect: (id: string) => void;
}

const STATUS_FILTERS = [
  { value: "",                label: "All Statuses" },
  { value: "DRAFT",           label: "Draft" },
  { value: "IN_PROGRESS",     label: "In Progress" },
  { value: "SUBMITTED",       label: "Submitted" },
  { value: "UNDER_REVIEW",    label: "Under Review" },
  { value: "APPROVED",        label: "Approved" },
  { value: "REJECTED",        label: "Rejected" },
  { value: "DISBURSED",       label: "Disbursed" },
  { value: "REPAID",          label: "Repaid" },
];

const TYPE_FILTERS = [
  { value: "",          label: "All Types" },
  { value: "PERSONAL",   label: "Personal" },
  { value: "BUSINESS",   label: "Business" },
];

export default function AdminList({ onSelect }: AdminListProps) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [apps, setApps] = useState<AdminApplicationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, listRes] = await Promise.all([
        adminListStats(),
        adminListApplications({ status: statusFilter, type: typeFilter, search, limit: 100, offset: 0 }),
      ]);
      setStats(statsRes);
      setApps(listRes.applications);
      setTotal(listRes.total);
    } catch (err: any) {
      setError(err?.message || "Failed to load applications.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter, search]);

  useEffect(() => {
    const id = setTimeout(load, 350); // debounce search
    return () => clearTimeout(id);
  }, [load]);

  return (
    <div className="space-y-5">
      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
          <StatCard label="Total" value={String(stats.total)} accent="velo" />
          <StatCard label="Submitted" value={String(stats.counts.SUBMITTED || 0)} accent="amber" />
          <StatCard label="Under Review" value={String(stats.counts.UNDER_REVIEW || 0)} accent="blue" />
          <StatCard label="Approved" value={String(stats.counts.APPROVED || 0)} accent="emerald" />
          <StatCard label="Disbursed" value={String(stats.counts.DISBURSED || 0)} accent="emerald" />
        </div>
      )}

      {/* Filters */}
      <div className="velo-card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input
            type="text"
            placeholder="Search by ID, name, email, phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="velo-input"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="velo-input"
          >
            {STATUS_FILTERS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="velo-input"
          >
            {TYPE_FILTERS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
          <span>{total} application{total === 1 ? "" : "s"}{total > 100 ? " (showing first 100 — refine your search)" : ""}</span>
          <button type="button" onClick={load} className="btn-ghost text-xs">Refresh</button>
        </div>
      </div>

      {/* List */}
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-100 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="velo-card p-8 text-center text-sm text-slate-500">Loading applications…</div>
      ) : apps.length === 0 ? (
        <div className="velo-card p-8 text-center text-sm text-slate-500">
          No applications match your filters.
        </div>
      ) : (
        <div className="velo-card overflow-hidden">
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3 font-semibold">Applicant</th>
                  <th className="px-4 py-3 font-semibold">Type</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold text-right">Loan Amount</th>
                  <th className="px-4 py-3 font-semibold text-right">Repayment</th>
                  <th className="px-4 py-3 font-semibold">Submitted</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {apps.map((app) => (
                  <tr
                    key={app.applicationId}
                    onClick={() => onSelect(app.applicationId)}
                    className="hover:bg-velo-50/30 cursor-pointer transition"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-velo-900">{app.applicantName || "—"}</div>
                      <div className="text-xs text-slate-500 font-mono">{app.applicationId}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`badge ${app.applicantType === "PERSONAL" ? "bg-velo-50 text-velo-700" : "bg-violet-50 text-violet-700"}`}>
                        {app.applicantType === "PERSONAL" ? "Personal" : "Business"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={app.status} />
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-velo-900">
                      {formatNaira(app.loanAmount)}
                    </td>
                    <td className="px-4 py-3 text-right text-velo-700">
                      {formatNaira(app.totalRepayment)}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {app.dateSubmitted ? formatDateLabel(app.dateSubmitted) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <svg className="inline text-slate-400" width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden divide-y divide-slate-100">
            {apps.map((app) => (
              <button
                key={app.applicationId}
                type="button"
                onClick={() => onSelect(app.applicationId)}
                className="w-full text-left p-4 hover:bg-slate-50 transition"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-velo-900 truncate">{app.applicantName || "—"}</div>
                    <div className="text-xs text-slate-500 font-mono mt-0.5">{app.applicationId}</div>
                  </div>
                  <StatusBadge status={app.status} />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="text-slate-500">
                    {app.applicantType === "PERSONAL" ? "Personal" : "Business"} • {formatNaira(app.loanAmount)}
                  </span>
                  <span className="text-velo-700 font-medium">{formatNaira(app.totalRepayment)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent: "velo" | "amber" | "blue" | "emerald" }) {
  const colors: Record<string, string> = {
    velo:     "from-velo-50 to-white dark:from-slate-800 dark:to-slate-900 text-velo-700",
    amber:    "from-amber-50 to-white dark:from-amber-950 dark:to-slate-900 text-amber-700",
    blue:     "from-blue-50 to-white dark:from-blue-950 dark:to-slate-900 text-blue-700",
    emerald:  "from-emerald-50 to-white dark:from-emerald-950 dark:to-slate-900 text-emerald-700",
  };
  return (
    <div className={`rounded-xl border border-slate-100 p-3 bg-gradient-to-br ${colors[accent]}`}>
      <div className="text-xs font-medium uppercase tracking-wider opacity-75">{label}</div>
      <div className="text-2xl font-bold mt-0.5">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    DRAFT:          "bg-slate-100 text-slate-600",
    IN_PROGRESS:    "bg-amber-50 text-amber-700",
    SUBMITTED:      "bg-velo-50 text-velo-700",
    UNDER_REVIEW:   "bg-blue-50 text-blue-700",
    APPROVED:       "bg-emerald-50 text-emerald-700",
    REJECTED:       "bg-red-50 text-red-700",
    DISBURSED:      "bg-emerald-100 text-emerald-800",
    REPAID:         "bg-emerald-50 text-emerald-700",
  };
  return (
    <span className={`badge ${map[status] || "bg-slate-100 text-slate-600"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
