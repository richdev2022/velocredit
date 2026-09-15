// ============================================================================
// src/components/admin/AdminDetail.tsx
// Full application detail. Admin can view all KYC data (including BVN/NIN),
// open uploaded documents in Google Drive, and update the status.
// ============================================================================

import { useEffect, useState } from "react";
import {
  adminDisburseLoan,
  adminGetApplication,
  adminUpdateStatus,
  type AdminApplicationDetail,
} from "../../services/adminApi";
import { formatNaira, formatDateLabel } from "../../utils/loanCalculator";
import AgreementPreview from "../AgreementPreview";
import { generateLoanAgreement } from "../../services/agreementGenerator";
import Icon from "../Icon";

interface AdminDetailProps {
  applicationId: string;
  onBack: () => void;
}

export default function AdminDetail({ applicationId, onBack }: AdminDetailProps) {
  const [app, setApp] = useState<AdminApplicationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newStatus, setNewStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminGetApplication(applicationId)
      .then((data) => {
        if (cancelled) return;
        setApp(data);
        setNewStatus("");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || "Failed to load application.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [applicationId]);

  async function handleUpdateStatus() {
    if (!app || !newStatus) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await adminUpdateStatus(app.applicationId, newStatus as "APPROVED" | "REJECTED" | "MORE_INFORMATION_REQUIRED");
      if (res.ok) {
        setApp({ ...app, status: res.status });
        setNewStatus("");
        setSaveMsg("Application updated to " + res.status.replace(/_/g, " "));
      } else {
        setSaveMsg("Failed to update status.");
      }
    } catch (err: any) {
      setSaveMsg(err?.message || "Failed to update status.");
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 4000);
    }
  }

  async function handleDisburse() {
    if (!app) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const response = await adminDisburseLoan(app.applicationId);
      const nextStatus = (response.loan as { status?: string } | undefined)?.status;
      if (nextStatus) setApp((current) => current ? { ...current, status: nextStatus, loan: { ...current.loan, ...(response.loan as object) } } : current);
      setSaveMsg(nextStatus === "DISBURSED" ? "Loan disbursed successfully." : "Disbursement submitted to Flutterwave for confirmation.");
    } catch (err: any) {
      setSaveMsg(err?.message || "Unable to initiate disbursement.");
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 4000);
    }
  }

  if (loading) {
    return (
      <div className="velo-card p-8 text-center text-sm text-slate-500">Loading application…</div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3">
        <button type="button" onClick={onBack} className="btn-ghost text-xs">
          <Icon name="arrowLeft" size={14} />
          Back to list
        </button>
        <div className="rounded-lg bg-red-50 border border-red-100 p-3 text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  if (!app) return null;

  const isPersonal = app.applicantType === "PERSONAL";
  const loan = app.loan || {};
  const personalInfo = app.personalInfo || {};
  const businessInfo = app.businessInfo || {};
  const businessRep = app.businessRep || {};
  const kyc = app.kyc || {};
  const financial = app.financial || {};
  const loanAmount = Number(loan.amount ?? loan.principalNaira ?? loan.amountNaira ?? 0);
  const tenure = Number(loan.tenure ?? loan.tenureDays ?? 0);
  const agreementData = {
    applicationId: app.applicationId,
    applicantType: app.applicantType,
    status: app.status,
    personalInfo,
    disbursementAccount: loan.disbursementAccount || app.customerSnapshot?.disbursementAccount || {},
    personalFinancial: isPersonal ? financial : {},
    businessInfo,
    businessRep,
    businessFinancial: isPersonal ? {} : financial,
    kyc,
    loanRequest: { amount: loanAmount, tenure, purpose: String(loan.purpose || "") },
    collateral: app.customerSnapshot?.collateral || {},
    documents: app.documents || {},
    witness: app.customerSnapshot?.witness || { fullName: "", phone: "" },
    agreement: { executionDate: loan.executionDate || app.createdAt || new Date().toISOString() },
  } as any;
  const agreementCalculation = {
    loanAmount,
    interest: Number(loan.interest || 0),
    serviceFee: Number(loan.serviceFee || 0),
    processingFee: Number(loan.processingFee || 0),
    lateFee: Number(loan.lateFee || 0),
    totalFees: Number(loan.totalFees || 0),
    totalRepayment: Number(loan.totalRepayment || loan.totalRepaymentNaira || 0),
    upfrontFees: Number(loan.upfrontFees || 0),
    loanCost: Number(loan.interest || 0),
    defaultFee: Number(loan.lateFee || 0),
    tenure,
    tenureLabel: `${tenure} Days`,
    disbursementDate: loan.disbursementDate || app.createdAt,
    repaymentDate: loan.repaymentDate || loan.dueAt || app.createdAt,
    repaymentDateLabel: formatDateLabel(loan.repaymentDate || loan.dueAt || app.createdAt),
    breakdown: [],
  } as any;
  const adminAgreement = generateLoanAgreement(agreementData, agreementCalculation);

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Back link */}
      <button type="button" onClick={onBack} className="btn-ghost text-xs">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back to list
      </button>

      {/* Header card */}
      <div className="velo-card p-4 sm:p-5 lg:p-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-velo-900">
                {isPersonal ? app.personalInfo.fullName : app.businessInfo.businessName}
              </h1>
              <span className={`badge ${isPersonal ? "bg-velo-50 text-velo-700" : "bg-violet-50 text-violet-700"}`}>
                {isPersonal ? "Personal" : "Business"}
              </span>
            </div>
            <div className="text-sm text-slate-500 font-mono mt-1">{app.applicationId}</div>
            <div className="text-xs text-slate-500 mt-1">
              Created: {formatDateLabel(app.createdAt)} •
              Updated: {formatDateLabel(app.updatedAt)}
              {app.submittedAt && <> • Submitted: {formatDateLabel(app.submittedAt)}</>}
            </div>
          </div>
          <div className="flex flex-col sm:items-end gap-2">
            <span className={`badge ${
              app.status === "APPROVED" || app.status === "DISBURSED" || app.status === "REPAID"
                ? "bg-emerald-50 text-emerald-700"
                : app.status === "REJECTED"
                  ? "bg-red-50 text-red-700"
                  : "bg-amber-50 text-amber-700"
            }`}>
              {app.status.replace(/_/g, " ")}
            </span>
          </div>
        </div>

        <div className="mt-5 pt-4 border-t border-slate-100 flex flex-col sm:flex-row sm:items-end gap-3">
          {app.status !== "APPROVED" && app.status !== "REJECTED" && (
            <>
              <div className="flex-1">
                <label className="velo-label" htmlFor="status-change">Application decision</label>
                <select id="status-change" value={newStatus} onChange={(e) => setNewStatus(e.target.value)} className="velo-input">
                  <option value="">Select a decision</option>
                  <option value="APPROVED">Approve application</option>
                  <option value="MORE_INFORMATION_REQUIRED">Request more information</option>
                  <option value="REJECTED">Reject application</option>
                </select>
              </div>
              <button type="button" onClick={handleUpdateStatus} disabled={saving || !newStatus} className="btn-primary">
                {saving ? "Saving…" : "Apply decision"}
              </button>
            </>
          )}
          {app.status === "APPROVED" && (
            <button type="button" onClick={handleDisburse} disabled={saving} className="btn-primary">
              {saving ? "Submitting…" : "Disburse via Flutterwave"}
            </button>
          )}
        </div>
        {saveMsg && (
          <div className="mt-3 rounded-lg bg-emerald-50 border border-emerald-100 p-2.5 text-xs text-emerald-700">
            {saveMsg}
          </div>
        )}
      </div>

      {/* Loan details */}
      <Card title="Loan Details">
        <Row label="Loan Amount" value={formatNaira(app.loan.amount)} />
        <Row label="Tenure" value={app.loan.tenure} />
        <Row label="Purpose" value={app.loan.purpose} />
        <Row label="Interest" value={formatNaira(app.loan.interest)} />
        <Row label="Service Fee" value={formatNaira(app.loan.serviceFee)} />
        <Row label="Processing Fee" value={formatNaira(app.loan.processingFee)} />
        <Row label="Other Fees" value={formatNaira(app.loan.otherFees)} />
        <Row label="Total Fees" value={formatNaira(app.loan.totalFees)} />
        <Row label="Total Repayment" value={formatNaira(app.loan.totalRepayment)} bold />
        <Row label="Disbursement Date" value={formatDateLabel(app.loan.disbursementDate)} />
        <Row label="Repayment Date" value={formatDateLabel(app.loan.repaymentDate)} />
      </Card>

      <Card title="Loan Agreement">
        <p className="mb-4 text-sm text-slate-500">Review the complete dynamically generated agreement and use Print agreement to print a copy.</p>
        <AgreementPreview html={adminAgreement.html} />
      </Card>

      {/* Applicant info */}
      {isPersonal ? (
        <Card title="Personal Information">
          <Row label="Full Name" value={app.personalInfo.fullName} />
          <Row label="Date of Birth" value={app.personalInfo.dateOfBirth} />
          <Row label="Phone" value={app.personalInfo.phone} />
          <Row label="Email" value={app.personalInfo.email} />
          <Row label="Residential Address" value={app.personalInfo.residentialAddress} />
          <Row label="State" value={app.personalInfo.state} />
          <Row label="LGA" value={app.personalInfo.lga} />
        </Card>
      ) : (
        <>
          <Card title="Business Information">
            <Row label="Business Name" value={app.businessInfo.businessName} />
            <Row label="Registration No." value={app.businessInfo.businessRegistrationNumber} />
            <Row label="Business Type" value={app.businessInfo.businessType} />
            <Row label="Business Address" value={app.businessInfo.businessAddress} />
            <Row label="Industry" value={app.businessInfo.businessIndustry} />
            <Row label="Years in Business" value={app.businessInfo.yearsInBusiness} />
          </Card>
          <Card title="Business Representative">
            <Row label="Full Name" value={app.businessRep.fullName} />
            <Row label="Position" value={app.businessRep.position} />
            <Row label="Phone" value={app.businessRep.phone} />
            <Row label="Email" value={app.businessRep.email} />
            <Row label="Residential Address" value={app.businessRep.residentialAddress} />
          </Card>
        </>
      )}

      {/* KYC — full sensitive info */}
      <Card title="Identification & KYC" sensitive>
        <Row label="BVN" value={app.kyc.bvn} mono />
        <Row label="NIN" value={app.kyc.nin} mono />
        <Row label="ID Type" value={app.kyc.identificationType} />
        <Row label="ID Number" value={app.kyc.identificationNumber} mono />
      </Card>

      {/* Financial */}
      <Card title="Financial Information">
        {isPersonal ? (
          <>
            <Row label="Employment Status" value={app.financial.employmentStatus} />
            <Row label="Employer / Business Name" value={app.financial.employerBusinessName} />
            <Row label="Monthly Income" value={app.financial.monthlyIncome} />
            <Row label="Monthly Expenses" value={app.financial.monthlyExpenses} />
            <Row label="Existing Loan Obligations" value={app.financial.existingLoanObligations} />
            <Row label="Expected Repayment Source" value={app.financial.expectedRepaymentSource} />
          </>
        ) : (
          <>
            <Row label="Avg. Monthly Revenue" value={app.financial.businessRevenue} />
            <Row label="Avg. Monthly Expenses" value={app.financial.businessExpenses} />
            <Row label="Existing Loan Obligations" value={app.financial.existingLoanObligations} />
            <Row label="Expected Repayment Source" value={app.financial.expectedRepaymentSource} />
          </>
        )}
      </Card>

      {/* Credit Reports */}
      <Card title="Credit Report (Internal + External)">
        <div className="mb-4 rounded-lg border border-velo-100 bg-velo-50/50 p-3 text-xs text-slate-600">
          <h4 className="font-semibold text-velo-900">How to read these scores</h4>
          <p className="mt-1">The internal score is Velo's 0–850 assessment from verified identity, repayment history, payment behaviour and outstanding balance. Higher scores indicate lower observed risk.</p>
          <p className="mt-1">Use the band and factor explanations with the system decision: below the review minimum needs careful review, while the eligible minimum is the policy guide—not an automatic approval. The external bureau score is supplied by the provider and may remain pending while consented background checks complete.</p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-lg border border-slate-100 p-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-velo-800 uppercase tracking-wide">Internal Score</h4>
              {app.creditReportSnapshot?.internal?.band && (
                <span className="badge bg-velo-50 text-velo-700">{app.creditReportSnapshot.internal.band}</span>
              )}
            </div>
            <div className="text-3xl font-bold text-velo-900 mb-2">
              {app.creditReportSnapshot?.internal?.score ?? "—"}
            </div>
            <div className="text-xs text-slate-500 mb-3">
              Velo internal rating · calculated at submission
            </div>
            {app.creditReportSnapshot?.internal?.factors &&
              Array.isArray(app.creditReportSnapshot.internal.factors) &&
              app.creditReportSnapshot.internal.factors.length > 0 && (
                <ul className="space-y-1.5 text-xs text-slate-600">
                  {app.creditReportSnapshot.internal.factors.slice(0, 6).map((factor: any, idx: number) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span className="mt-1 inline-block w-1.5 h-1.5 rounded-full bg-velo-500 flex-shrink-0" />
                      <span>{factor?.label || factor?.reason || String(factor)}</span>
                      {typeof factor?.weight === "number" && (
                        <span className="ml-auto font-mono text-slate-400">{Math.round(factor.weight * 100)} pts</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
          </div>

          <div className="rounded-lg border border-slate-100 p-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-emerald-800 uppercase tracking-wide">External Bureau</h4>
              <span className={`badge ${
                app.creditReportSnapshot?.external?.status === "RECEIVED"
                  ? "bg-emerald-50 text-emerald-700"
                  : app.creditReportSnapshot?.external?.status === "PENDING"
                  ? "bg-amber-50 text-amber-700"
                  : app.creditReportSnapshot?.external?.status === "FAILED"
                  ? "bg-red-50 text-red-700"
                  : "bg-slate-50 text-slate-600"
              }`}>
                {app.creditReportSnapshot?.external?.status || "NOT_REQUESTED"}
              </span>
            </div>
            <div className="text-3xl font-bold text-emerald-900 mb-2">
              {app.creditReportSnapshot?.external?.score ?? "—"}
            </div>
            <div className="text-xs text-slate-500 mb-3">
              Provider: {app.creditReportSnapshot?.external?.provider || "Prembly"}
              {(app.creditReportSnapshot?.external?.pulledAt || app.creditReportSnapshot?.external?.requestedAt) && (
                <> · {app.creditReportSnapshot.external.pulledAt ? "Pulled" : "Requested"} {formatDateLabel(app.creditReportSnapshot.external.pulledAt || app.creditReportSnapshot.external.requestedAt)}</>
              )}
            </div>
            {app.creditReportSnapshot?.external?.reportReference && (
              <Row label="Provider Ref" value={app.creditReportSnapshot.external.reportReference} mono />
            )}
            {app.creditReportSnapshot?.external?.reason && (
              <p className="mt-2 text-xs text-slate-500">{app.creditReportSnapshot.external.reason}</p>
            )}
            {app.creditReportSnapshot?.external?.normalizedFields && (
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer font-medium text-slate-700 select-none">
                  View raw external details
                </summary>
                <pre className="mt-2 p-2 rounded bg-slate-50 border border-slate-100 overflow-auto max-h-64 text-[10px] text-slate-700">
{JSON.stringify(app.creditReportSnapshot.external.normalizedFields, null, 2)}
                </pre>
              </details>
            )}
          </div>
        </div>
      </Card>

      <Card title="Disbursement Account">
        <Row label="Institution" value={app.disbursementAccount?.institution || app.loan.disbursementAccount?.institution} />
        <Row label="Bank" value={app.disbursementAccount?.bankName || app.loan.disbursementAccount?.bankName} />
        <Row label="Account Name" value={app.disbursementAccount?.accountName || app.loan.disbursementAccount?.accountName} />
        <Row label="Account Number" value={app.disbursementAccount?.accountNumber || app.loan.disbursementAccount?.accountNumber} mono />
        <Row label="Bank Code" value={app.disbursementAccount?.bankCode || app.loan.disbursementAccount?.bankCode} mono />
      </Card>

      <Card title="Collateral & Witness">
        <Row label="Collateral Type" value={app.collateral?.type} />
        <Row label="Location" value={app.collateral?.location} />
        <Row label="Ownership" value={app.collateral?.ownership} />
        <Row label="Estimated Value" value={app.collateral?.estimatedValue} />
        <Row label="Description" value={app.collateral?.description} />
        <Row label="Witness" value={app.witness?.fullName} />
        <Row label="Witness Phone" value={app.witness?.phone} />
      </Card>

      <Card title="Documents & Attachments">
        {app.documents.driveFolderUrl && <DocLink label="Google Drive Folder" url={app.documents.driveFolderUrl} />}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-2">
          {Object.entries(app.documents || {}).filter(([key]) => key !== "driveFolderUrl").map(([key, raw]) => {
            const document = raw as any;
            const source = documentSource(document);
            const label = key.replace(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase());
            return <div key={key} className="rounded-lg border border-slate-100 p-2">
              {source && /^data:image\//i.test(source) ? <img src={source} alt={label} className="h-28 w-full rounded object-cover" /> : source ? <a href={source} target="_blank" rel="noopener noreferrer" className="flex h-28 items-center justify-center rounded bg-slate-50 text-xs font-medium text-velo-700">Open file</a> : <div className="flex h-28 items-center justify-center rounded bg-slate-50 text-xs text-slate-400">No preview</div>}
              <div className="mt-2 text-xs font-medium text-slate-700">{label}</div>
              <div className="text-[10px] text-slate-500">{document?.name || document?.fileName || "Uploaded attachment"}</div>
            </div>;
          })}
        </div>
        {!Object.keys(app.documents || {}).length && <div className="text-sm text-slate-500">No documents uploaded.</div>}
      </Card>

      <Card title="Review Decision & Stage Status">
        <Row label="System Decision" value={app.systemDecision?.decision} />
        <Row label="Manual Decision" value={app.manualDecision} />
        <Row label="Decision Reasons" value={Array.isArray(app.systemDecision?.reasons) ? app.systemDecision.reasons.join("; ") : ""} />
        {Object.entries(app.stageStatuses || {}).map(([stage, status]) => <Row key={stage} label={stage.replace(/_/g, " ")} value={status} />)}
      </Card>
    </div>
  );
}

function Card({ title, sensitive, children }: { title: string; sensitive?: boolean; children: React.ReactNode }) {
  return (
    <div className="velo-card p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-velo-900">{title}</h3>
        {sensitive && (
          <span className="badge bg-red-50 text-red-700">Sensitive</span>
        )}
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {children}
      </dl>
    </div>
  );
}

function Row({ label, value, bold, mono }: { label: string; value?: string; bold?: boolean; mono?: boolean }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 py-1 border-b border-slate-50 last:border-b-0">
      <dt className="text-slate-500 text-xs sm:text-sm">{label}</dt>
      <dd className={`text-velo-900 ${bold ? "font-semibold" : "font-medium"} ${mono ? "font-mono" : ""} text-sm sm:text-right break-words max-w-full`}>
        {value || <span className="text-slate-400 font-normal">—</span>}
      </dd>
    </div>
  );
}

function documentSource(document: any): string {
  if (!document) return "";
  if (typeof document === "string") return document;
  if (document.data) return `data:${document.type || document.mimeType || "image/jpeg"};base64,${document.data}`;
  return document.previewUrl || document.url || document.downloadUrl || document.driveUrl || "";
}

function DocLink({ label, url }: { label: string; url?: string }) {
  if (!url) {
    return (
      <div className="flex items-center justify-between py-2 border-b border-slate-50 last:border-b-0">
        <span className="text-sm text-slate-600">{label}</span>
        <span className="text-xs text-slate-400">Not uploaded</span>
      </div>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-between py-2 border-b border-slate-50 last:border-b-0 hover:bg-velo-50/40 px-2 -mx-2 rounded transition"
    >
      <span className="text-sm text-velo-900 font-medium">{label}</span>
      <span className="text-xs text-velo-600 inline-flex items-center gap-1">
        Open
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="M7 17L17 7M17 7H8M17 7v9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </span>
    </a>
  );
}
