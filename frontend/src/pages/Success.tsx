// ============================================================================
// src/pages/Success.tsx
// Final success page after submission. Shows the Application ID and offers
// a "Download Application Summary" button.
// ============================================================================

import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import type { ApplicationData } from "../types/application";
import type { LoanCalculation } from "../types/loan";
import { formatNaira, formatDateLabel } from "../utils/loanCalculator";
import { config } from "../utils/config";
import { buildAgreementFilename } from "../utils/applicationId";

interface SuccessPageProps {
  application: ApplicationData;
}

export default function SuccessPage({ application }: SuccessPageProps) {
  const calc: LoanCalculation | null = application.calculation;
  const isPersonal = application.applicantType === "PERSONAL";
  const applicantName = isPersonal
    ? application.personalInfo?.fullName
    : application.businessInfo?.businessName;

  function downloadSummary() {
    const lines = [
      "VELO FINANCE LTD — APPLICATION SUMMARY",
      "======================================",
      "",
      `Application ID:    ${application.applicationId}`,
      `Status:           ${application.status}`,
      `Applicant Type:   ${application.applicantType === "PERSONAL" ? "Personal Loan" : "Business Loan"}`,
      `Submitted At:     ${new Date().toLocaleString()}`,
      "",
      "APPLICANT",
      "---------",
      `Name:             ${applicantName || "—"}`,
      `Phone:            ${isPersonal ? application.personalInfo?.phone : application.businessRep?.phone}`,
      `Email:            ${isPersonal ? application.personalInfo?.email : application.businessRep?.email}`,
      "",
      "LOAN DETAILS",
      "------------",
      ...(calc ? [
        `Loan Amount:      ${formatNaira(calc.loanAmount)}`,
        `Interest:         ${formatNaira(calc.interest)}`,
        `Service Fee:      ${formatNaira(calc.serviceFee)}`,
        `Processing Fee:   ${formatNaira(calc.processingFee)}`,
        `Total Fees:       ${formatNaira(calc.totalFees)}`,
        `Total Repayment:  ${formatNaira(calc.totalRepayment)}`,
        `Tenure:           ${calc.tenureLabel}`,
        `Repayment Date:   ${formatDateLabel(calc.repaymentDate)}`,
      ] : ["(loan calculation not available)"]),
      "",
      "--------------------------------------",
      `${config.companyName} — ${config.companyWebsite}`,
      "We'll contact you regarding the next steps.",
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = buildAgreementFilename(application.applicationId).replace("-Loan-Agreement.pdf", "-Application-Summary.txt");
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Layout showHomeLink={false}>
      <div className="max-w-2xl mx-auto py-8">
        <div className="text-center animate-slide-up">
          <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 mb-5">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="11" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M7 12.5l3 3 7-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>

          <h1 className="text-2xl sm:text-3xl font-bold text-velo-900 text-balance">
            Application Submitted Successfully
          </h1>
          <p className="text-slate-600 mt-2 max-w-md mx-auto text-balance">
            Your loan application has been received and is currently under review.
          </p>

          <div className="mt-6 inline-flex flex-col items-center gap-1 px-5 py-4 rounded-xl bg-velo-50 border border-velo-100">
            <span className="text-xs uppercase tracking-wider text-velo-600 font-semibold">Application ID</span>
            <span className="font-mono font-bold text-lg text-velo-900">{application.applicationId}</span>
          </div>
        </div>

        <div className="velo-card p-5 sm:p-6 mt-8">
          <h2 className="text-base font-semibold text-velo-900 mb-3">What happens next?</h2>
          <ol className="space-y-3">
            <Step n={1} title="Document verification" text="Our team will verify your submitted documents and information." />
            <Step n={2} title="Credit assessment" text="We'll assess your loan eligibility based on the information you provided." />
            <Step n={3} title="Decision & disbursement" text="You'll be contacted regarding the loan decision and next steps for disbursement." />
          </ol>

          <div className="mt-5 rounded-xl bg-slate-50 border border-slate-100 p-4 flex items-start gap-3">
            <svg className="text-slate-400 shrink-0 mt-0.5" width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M3 5h18v14H3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
              <path d="M3 9h18M7 14h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
            <p className="text-sm text-slate-600">
              We'll contact you regarding the next steps. Please keep your Application ID safe — you may need it for follow-up enquiries.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-col sm:flex-row gap-2 justify-center">
          <button type="button" onClick={downloadSummary} className="btn-secondary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 4v12M12 16l-4-4M12 16l4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M4 20h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            Download Application Summary
          </button>
          <Link to="/" className="btn-primary">
            Return to Home
          </Link>
        </div>
      </div>
    </Layout>
  );
}

function Step({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-velo-100 text-velo-700 text-xs font-bold shrink-0">
        {n}
      </span>
      <div>
        <div className="text-sm font-semibold text-velo-900">{title}</div>
        <div className="text-xs text-slate-500 mt-0.5">{text}</div>
      </div>
    </li>
  );
}
