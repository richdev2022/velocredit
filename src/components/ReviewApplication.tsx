// ============================================================================
// src/components/ReviewApplication.tsx
// Final review screen — shows everything before submission.
// ============================================================================

import type { ApplicationData } from "../types/application";
import type { LoanCalculation } from "../types/loan";
import { formatNaira } from "../utils/loanCalculator";
import { formatDateLabel } from "../utils/loanCalculator";

interface ReviewApplicationProps {
  application: ApplicationData;
  calculation: LoanCalculation;
  onEdit: (sectionKey: string) => void;
}

export default function ReviewApplication({ application, calculation, onEdit }: ReviewApplicationProps) {
  const isPersonal = application.applicantType === "PERSONAL";

  return (
    <div className="space-y-5 animate-fade-in">
      <div>
        <h2 className="section-heading">Review Your Application</h2>
        <p className="section-subheading">Please review all information carefully before submitting.</p>
      </div>

      {/* Applicant Type */}
      <ReviewCard
        title="Applicant Type"
        onEdit={() => onEdit("applicantType")}
        rows={[["Type", application.applicantType === "PERSONAL" ? "Personal Loan" : "Business Loan"]]}
      />

      {/* Personal / Business Info */}
      {isPersonal ? (
        <ReviewCard
          title="Personal Information"
          onEdit={() => onEdit("info")}
          rows={[
            ["Full Name", application.personalInfo?.fullName],
            ["Phone", application.personalInfo?.phone],
            ["Email", application.personalInfo?.email],
            ["Date of Birth", application.personalInfo?.dateOfBirth],
            ["Residential Address", application.personalInfo?.residentialAddress],
            ["State", application.personalInfo?.state],
            ["LGA", application.personalInfo?.lga],
          ]}
        />
      ) : (
        <>
          <ReviewCard
            title="Business Information"
            onEdit={() => onEdit("info")}
            rows={[
              ["Business Name", application.businessInfo?.businessName],
              ["Registration Number", application.businessInfo?.businessRegistrationNumber || "—"],
              ["Business Type", application.businessInfo?.businessType],
              ["Business Address", application.businessInfo?.businessAddress],
              ["Industry", application.businessInfo?.businessIndustry],
              ["Years in Business", application.businessInfo?.yearsInBusiness],
            ]}
          />
          <ReviewCard
            title="Business Representative"
            onEdit={() => onEdit("businessRep")}
            rows={[
              ["Full Name", application.businessRep?.fullName],
              ["Date of Birth", application.businessRep?.dateOfBirth],
              ["Position", application.businessRep?.position],
              ["Phone", application.businessRep?.phone],
              ["Email", application.businessRep?.email],
              ["Residential Address", application.businessRep?.residentialAddress],
            ]}
          />
        </>
      )}

      <ReviewCard
        title="Velo Account Information"
        onEdit={() => onEdit(isPersonal ? "info" : "businessRep")}
        rows={[
          ["Account Name", application.disbursementAccount?.accountName],
          ["Bank Name", application.disbursementAccount?.bankName],
          ["Account Number", application.disbursementAccount?.accountNumber],
        ]}
      />

      {/* KYC */}
      <ReviewCard
        title="Identification & KYC"
        onEdit={() => onEdit("kyc")}
        rows={[
          ["BVN", maskSensitive(application.kyc?.bvn)],
          ["NIN", maskSensitive(application.kyc?.nin)],
          ["Identification Type", application.kyc?.identificationType],
          ["Identification Number", application.kyc?.identificationNumber],
          ["ID Document", documentLabel(application, "identificationDocument")],
          ["Proof of Address", documentLabel(application, "proofOfAddress")],
        ]}
      />

      {/* Financial */}
      {isPersonal ? (
        <ReviewCard
          title="Financial Information"
          onEdit={() => onEdit("financial")}
          rows={[
            ["Employment Status", application.personalFinancial?.employmentStatus],
            ["Employer / Business Name", application.personalFinancial?.employerBusinessName || "—"],
            ["Monthly Income", formatMoney(application.personalFinancial?.monthlyIncome)],
            ["Monthly Expenses", formatMoney(application.personalFinancial?.monthlyExpenses)],
            ["Existing Loan Obligations", application.personalFinancial?.existingLoanObligations || "—"],
            ["Expected Repayment Source", application.personalFinancial?.expectedRepaymentSource],
          ]}
        />
      ) : (
        <ReviewCard
          title="Business Financial Information"
          onEdit={() => onEdit("financial")}
          rows={[
            ["Average Monthly Revenue", formatMoney(application.businessFinancial?.averageMonthlyRevenue)],
            ["Average Monthly Expenses", formatMoney(application.businessFinancial?.averageMonthlyExpenses)],
            ["Existing Loan Obligations", application.businessFinancial?.existingLoanObligations || "—"],
            ["Expected Repayment Source", application.businessFinancial?.expectedRepaymentSource],
          ]}
        />
      )}

      {/* Loan */}
      <ReviewCard
        title="Loan Request & Calculation"
        onEdit={() => onEdit("loanRequest")}
        rows={[
          ["Loan Amount", formatNaira(calculation.loanAmount)],
          ["Tenure", calculation.tenureLabel],
          ["Loan Purpose", application.loanRequest?.purpose],
          ["Interest", formatNaira(calculation.interest)],
          ["Service Fee", formatNaira(calculation.serviceFee)],
          ["Processing Fee", formatNaira(calculation.processingFee)],
          ["Total Fees", formatNaira(calculation.totalFees)],
          ["Total Repayment", formatNaira(calculation.totalRepayment)],
          ["Repayment Date", formatDateLabel(calculation.repaymentDate)],
        ]}
      />

      {/* Signed agreement */}
      <ReviewCard
        title="Signed Loan Agreement"
        onEdit={() => onEdit("agreement")}
        rows={[
          ["Signed Agreement", documentLabel(application, "signedAgreement")],
          ["Consent", application.agreement?.signedAgreementAccepted ? "Accepted" : "Not accepted"],
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function ReviewCard({
  title,
  rows,
  onEdit,
}: {
  title: string;
  rows: [string, string | undefined][];
  onEdit: () => void;
}) {
  return (
    <div className="velo-card p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-velo-900">{title}</h3>
        <button type="button" onClick={onEdit} className="btn-ghost text-xs">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path d="M11 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            <path d="M18.5 2.5a2.121 2.121 0 113 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Edit
        </button>
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 py-1 border-b border-slate-50 last:border-b-0">
            <dt className="text-slate-500 text-xs sm:text-sm">{label}</dt>
            <dd className="text-velo-900 font-medium text-sm sm:text-right break-words max-w-full">
              {value && value !== "—" ? value : <span className="text-slate-400 font-normal">—</span>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function documentLabel(app: ApplicationData, slot: keyof typeof app.documents): string {
  const doc = app.documents?.[slot];
  if (!doc) return "Not uploaded";
  return `✓ ${doc.name}`;
}

function formatMoney(v?: string): string {
  if (!v) return "—";
  const n = Number(v.replace(/[^0-9.]/g, ""));
  if (Number.isNaN(n)) return v;
  return formatNaira(n);
}

function maskSensitive(v?: string): string {
  if (!v || v.length < 5) return "—";
  return `*****${v.slice(-3)}`;
}
