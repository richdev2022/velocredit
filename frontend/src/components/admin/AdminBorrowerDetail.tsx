import { useEffect, useState } from "react";
import { adminListLoans } from "../../services/apiClient";
import { adminListDisbursements, type LoanDisbursement } from "../../services/adminApi";
import { formatDateLabel, formatNaira } from "../../utils/loanCalculator";

type Props = {
  borrower: any;
  onBack: () => void;
  onSelectLoan: (loanId: string) => void;
};

export default function AdminBorrowerDetail({ borrower, onBack, onSelectLoan }: Props) {
  const [loans, setLoans] = useState<any[]>([]);
  const [disbursements, setDisbursements] = useState<LoanDisbursement[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    Promise.all([
      adminListLoans(100, 0, undefined, borrower.id),
      adminListDisbursements({ borrowerId: borrower.id, limit: 100 }),
    ]).then(([loanResponse, disbursementResponse]) => {
      if (cancelled) return;
      setLoans(loanResponse.loans as any[]);
      setDisbursements(disbursementResponse.disbursements);
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load borrower details.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [borrower.id]);

  return <div className="space-y-5 animate-fade-in">
    <button type="button" onClick={onBack} className="btn-ghost text-xs">← Back to borrowers</button>
    <section className="velo-card p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-bold text-velo-900 dark:text-white">{borrower.fullName || "Borrower"}</h1><span className="badge bg-velo-50 text-velo-700 dark:bg-velo-900/30 dark:text-velo-300">Borrower</span></div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{borrower.email || "—"} {borrower.phone ? `· ${borrower.phone}` : ""}</p>
          <p className="mt-2 font-mono text-xs text-slate-400">{borrower.id}</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-semibold"><span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-700 dark:bg-slate-800 dark:text-slate-300">KYC: {borrower.kycStatus || "NOT_STARTED"}</span><span className={`rounded-full px-3 py-1.5 ${borrower.isActive === false ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>{borrower.isActive === false ? "Inactive" : "Active"}</span></div>
      </div>
    </section>
    <section className="velo-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800"><div><h2 className="font-semibold text-velo-900 dark:text-white">Loan applications</h2><p className="mt-1 text-xs text-slate-500">Select an application to review its full loan, agreement, and decision details.</p></div><span className="text-xs text-slate-500">{loans.length} records</span></div>
      {loading ? <div className="p-8 text-center text-sm text-slate-500">Loading borrower records…</div> : error ? <div className="m-5 rounded-lg border border-red-100 bg-red-50 p-3 text-sm text-red-700">{error}</div> : loans.length === 0 ? <div className="p-8 text-center text-sm text-slate-500">No loan applications found for this borrower.</div> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-slate-100 text-[11px] uppercase tracking-wider text-slate-500 dark:border-slate-800"><th className="px-5 py-3">Application</th><th className="px-5 py-3">Principal</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Created</th><th className="px-5 py-3">Disbursement</th></tr></thead><tbody className="divide-y divide-slate-100 dark:divide-slate-800">{loans.map((loan) => { const id = loan.applicationId || loan.id; const transfer = disbursements.find((item) => item.applicationId === loan.id || item.loanId === loan.id); return <tr key={id} className="hover:bg-velo-50/40 dark:hover:bg-slate-800/40"><td className="px-5 py-4"><button type="button" onClick={() => onSelectLoan(id)} className="font-mono text-xs font-semibold text-velo-700 hover:underline dark:text-velo-400">{id}</button><div className="mt-1 text-xs text-slate-500">{loan.applicantType || "Loan application"}</div></td><td className="px-5 py-4 font-semibold text-velo-900 dark:text-white">{formatNaira(Number(loan.principalNaira || loan.amountNaira || 0))}</td><td className="px-5 py-4"><span className="badge bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">{String(loan.status || "—").replace(/_/g, " ")}</span></td><td className="px-5 py-4 text-xs text-slate-500">{loan.createdAt ? formatDateLabel(loan.createdAt) : "—"}</td><td className="px-5 py-4 text-xs text-slate-500">{transfer ? `${transfer.status} · ${formatNaira(Number(transfer.amountNaira || 0))}` : "Not disbursed"}</td></tr>; })}</tbody></table></div>}
    </section>
  </div>;
}
