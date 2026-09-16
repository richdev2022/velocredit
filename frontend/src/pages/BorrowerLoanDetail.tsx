import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { getBorrowerLoans } from "../services/apiClient";

function statusLabel(status?: string): string {
  const labels: Record<string, string> = { SUBMITTED: "Under review", UNDER_REVIEW: "Under review", APPROVED: "Approved — awaiting disbursement", DISBURSED: "Disbursed", ACTIVE: "Active", PAST_DUE: "Past due", REPAID: "Repaid", PENDING_PROVIDER_CONFIRMATION: "Payment processing", SUCCESSFUL: "Payment confirmed" };
  return labels[String(status ?? "").toUpperCase()] ?? String(status ?? "—").replace(/_/g, " ");
}

type LoanDetailData = {
  loan?: { id?: string; status?: string; totalRepaymentNaira?: number; outstandingNaira?: number };
  schedule?: Array<{ id?: string; installmentNumber?: number; dueDate?: string; totalDueNaira?: number; totalPaidNaira?: number; status?: string }>;
  repayments?: Array<{ id?: string; createdAt?: string; amountNaira?: number; status?: string; providerReference?: string }>;
};

export default function BorrowerLoanDetail() {
  const { loanId = "" } = useParams();
  const [data, setData] = useState<LoanDetailData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!loanId) return;
    getBorrowerLoans(loanId).then((response) => setData(response as unknown as LoanDetailData)).catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to load loan details"));
  }, [loanId]);

  if (error) return <Layout><div className="mx-auto max-w-4xl p-6 text-sm text-red-600">{error}</div></Layout>;
  if (!data) return <Layout><div className="mx-auto max-w-4xl p-6 text-sm text-slate-500">Loading loan details…</div></Layout>;

  return (
    <Layout>
      <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
        <Link to="/borrower" className="text-sm font-semibold text-velo-600">← Back to repayments</Link>
        <section className="velo-card p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Loan details</p>
          <h1 className="mt-2 text-2xl font-bold text-velo-900 dark:text-white">{data.loan?.id ?? loanId}</h1>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div><p className="text-xs text-slate-500">Status</p><p className="font-semibold">{statusLabel(data.loan?.status)}</p></div>
            <div><p className="text-xs text-slate-500">Scheduled</p><p className="font-semibold">₦{Number(data.loan?.totalRepaymentNaira ?? 0).toLocaleString("en-NG")}</p></div>
            <div><p className="text-xs text-slate-500">Outstanding</p><p className="font-semibold">₦{Number(data.loan?.outstandingNaira ?? 0).toLocaleString("en-NG")}</p></div>
          </div>
        </section>
        <section className="velo-card overflow-hidden">
          <h2 className="border-b border-slate-100 px-5 py-4 font-bold dark:border-slate-800">Repayment schedule</h2>
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50 text-left text-slate-500"><tr><th className="px-5 py-3">Installment</th><th className="px-5 py-3">Due date</th><th className="px-5 py-3 text-right">Due</th><th className="px-5 py-3 text-right">Paid</th><th className="px-5 py-3 text-right">Status</th></tr></thead><tbody className="divide-y divide-slate-100 dark:divide-slate-800">{(data.schedule ?? []).map((item) => <tr key={item.id ?? item.installmentNumber}><td className="px-5 py-4">{item.installmentNumber ?? "—"}</td><td className="px-5 py-4">{item.dueDate ? new Date(item.dueDate).toLocaleDateString("en-NG") : "—"}</td><td className="px-5 py-4 text-right">₦{Number(item.totalDueNaira ?? 0).toLocaleString("en-NG")}</td><td className="px-5 py-4 text-right">₦{Number(item.totalPaidNaira ?? 0).toLocaleString("en-NG")}</td><td className="px-5 py-4 text-right">{statusLabel(item.status)}</td></tr>)}</tbody></table></div>
        </section>
        <section className="velo-card overflow-hidden">
          <h2 className="border-b border-slate-100 px-5 py-4 font-bold dark:border-slate-800">Payment history</h2>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">{(data.repayments ?? []).map((payment) => <div key={payment.id} className="flex items-center justify-between gap-4 px-5 py-4 text-sm"><span>{payment.createdAt ? new Date(payment.createdAt).toLocaleString("en-NG") : "—"}</span><strong>₦{Number(payment.amountNaira ?? 0).toLocaleString("en-NG")}</strong><span>{statusLabel(payment.status)}</span></div>)}</div>
        </section>
      </main>
    </Layout>
  );
}
