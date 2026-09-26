// ============================================================================
// src/components/admin/AdminDetail.tsx
// Full application detail. Admin can view all KYC data (including BVN/NIN),
// open uploaded documents in Google Drive, and update the status.
// ============================================================================

import React, { useEffect, useState } from "react";
import {
  adminDisburseLoan,
  adminGetApplication,
  adminGetApplicationDraft,
  adminListDisbursements,
  adminRequestDisbursementAccountUpdate,
  adminRetryDisbursement,
  adminRunCreditBureauCheck,
  adminUpdateStatus,
  type AdminApplicationDetail,
  type AdminApplicationDraftDetail,
  type LoanDisbursement,
} from "../../services/adminApi";
import { formatNaira, formatDateLabel } from "../../utils/loanCalculator";
import { documentDownloadUrl, documentPreviewUrl } from "../../utils/documentLinks";
import AgreementPreview from "../AgreementPreview";
import { generateLoanAgreement } from "../../services/agreementGenerator";
import CreditBureauReportModal from "./CreditBureauReportModal";
import Icon from "../Icon";

// Once a loan has been disbursed and is live (or anything downstream of
// disbursed), the disbursement CTA must disappear — money leaves the platform
// exactly once per application ID.
const DISBURSED_LIKE_STATUSES = new Set(["DISBURSED", "ACTIVE", "PAST_DUE", "DEFAULTED", "REPAID", "WRITTEN_OFF"]);

interface AdminDetailProps {
  applicationId: string;
  onBack: () => void;
}

export default function AdminDetail({ applicationId, onBack }: AdminDetailProps) {
  const [app, setApp] = useState<AdminApplicationDetail | null>(null);
  const [draft, setDraft] = useState<AdminApplicationDraftDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newStatus, setNewStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [bureauBusy, setBureauBusy] = useState(false);
  const [bureauMsg, setBureauMsg] = useState<string | null>(null);
  const [bureauModalOpen, setBureauModalOpen] = useState(false);
  // Owner requirement: rejecting a loan application MUST capture a reason —
  // the modal opens as soon as "Reject application" is selected and blocks
  // the decision until a reason is entered (the backend enforces this too).
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      adminGetApplication(applicationId).catch((err) => {
        // Application might not exist yet (e.g. still in DRAFT state with no
        // loanApplications row). Return null so we can fall back to the draft.
        return null as AdminApplicationDetail | null;
      }),
      adminGetApplicationDraft(applicationId).catch(() => null as AdminApplicationDraftDetail | null),
    ])
      .then(([data, draftData]) => {
        if (cancelled) return;
        if (!data && !draftData) {
          setError("Application not found and no saved draft exists for this ID.");
          return;
        }
        setApp(data);
        setDraft(draftData);
        setNewStatus("");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [applicationId]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void adminGetApplication(applicationId).then(setApp).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(interval);
  }, [applicationId]);

  async function handleUpdateStatus(decisionOverride?: "APPROVED" | "REJECTED" | "MORE_INFORMATION_REQUIRED", noteOverride?: string) {
    if (!app) return;
    const decision = decisionOverride ?? newStatus;
    if (!decision) return;
    // Selecting "Reject application" in the dropdown opens the reason prompt
    // instead of applying the decision immediately.
    if (!decisionOverride && decision === "REJECTED") {
      setRejectionReason("");
      setRejectModalOpen(true);
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await adminUpdateStatus(app.applicationId, decision as "APPROVED" | "REJECTED" | "MORE_INFORMATION_REQUIRED", noteOverride ?? "");
      if (res.ok) {
        setApp({ ...app, status: res.status, manualDecision: decision, manualNote: noteOverride ?? app.manualNote });
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

  async function handleRunCreditBureau() {
    if (!app || bureauBusy) return;
    setBureauBusy(true);
    setBureauMsg(null);
    try {
      // The endpoint starts the bureau check in the BACKGROUND (real bureau
      // lookups take 25-90s) and returns the report row immediately —
      // PENDING first, or the final state when the provider answered within
      // the inline window. The 3s polling below keeps the card fresh either
      // way, so the result appears here without any further action.
      const response = await adminRunCreditBureauCheck(app.applicationId);
      if (response.creditReportSnapshot) {
        setApp((current) => (current ? { ...current, creditReportSnapshot: response.creditReportSnapshot } : current));
      }
      setBureauMsg(
        response.message ||
          (response.report?.status === "PENDING"
            ? "Credit bureau check started — the report will refresh automatically."
            : "Credit bureau check finished."),
      );
    } catch (err: any) {
      setBureauMsg(err?.message || "Unable to run the credit bureau check.");
    } finally {
      setBureauBusy(false);
      setTimeout(() => setBureauMsg(null), 12000);
    }
  }

  async function handleDisburse() {
    if (!app) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      // The route WAITS for Flutterwave's real final answer — show the actual
      // provider outcome instead of a generic "submitted" note.
      const response = await adminDisburseLoan(app.applicationId);
      const nextStatus = (response.loan as { status?: string } | undefined)?.status;
      if (nextStatus) setApp((current) => current ? { ...current, status: nextStatus, loan: { ...current.loan, ...(response.loan as object) } } : current);
      const transferStatus = String((response.disbursement as { status?: string } | undefined)?.status || "");
      if (response.ok === false) setSaveMsg(response.error || response.message || "Disbursement failed — see the provider response for details.");
      else if (transferStatus === "SUCCESSFUL") setSaveMsg(response.message || "Loan disbursed successfully.");
      else setSaveMsg(response.message || "Disbursement submitted to Flutterwave — the final status will be confirmed automatically.");
    } catch (err: any) {
      setSaveMsg(err?.message || "Unable to initiate disbursement.");
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 8000);
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

  if (!app && !draft) return null;

  // Draft-only view: when the application hasn't been formally submitted yet,
  // we still want to show admin the borrower's saved progress.
  if (!app && draft) {
    return <DraftDetailView draft={draft} onBack={onBack} />;
  }

  // From this point on, `app` is non-null.
  if (!app) return null;

  const isPersonal = app.applicantType === "PERSONAL";
  const loan = app.loan || {};
  const terminalLoan = ["DISBURSEMENT_PENDING", "DISBURSED", "ACTIVE", "PAST_DUE", "DEFAULTED", "REPAID", "WRITTEN_OFF", "CANCELLED"].includes(String(app.status).toUpperCase());
  const loanRecordStatus = String((loan as { status?: string }).status || app.status || "").toUpperCase();
  const disburseBlocked = DISBURSED_LIKE_STATUSES.has(loanRecordStatus);
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

      {/* Saved draft progress panel (shown when a draft exists alongside the application) */}
      {draft && <DraftProgressPanel draft={draft} />}

      {/* Header card */}
      <div className="velo-card p-4 sm:p-5 lg:p-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-velo-900">
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
            {app.status === "REJECTED" && app.manualNote && (
              <span className="max-w-xs rounded-lg bg-red-50 border border-red-100 px-2.5 py-1.5 text-[11px] leading-snug text-red-700 dark:bg-red-900/20 dark:border-red-900 dark:text-red-300">
                <strong className="font-semibold">Rejection reason:</strong> {app.manualNote}
              </span>
            )}
          </div>
        </div>

        <div className="mt-5 pt-4 border-t border-slate-100 flex flex-col sm:flex-row sm:items-end gap-3">
          {!terminalLoan && app.status !== "APPROVED" && app.status !== "REJECTED" && (
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
              <button type="button" onClick={() => void handleUpdateStatus()} disabled={saving || !newStatus} className="btn-primary">
                {saving ? "Saving…" : "Apply decision"}
              </button>
            </>
          )}
          {app.status === "APPROVED" && !terminalLoan && !disburseBlocked && (
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

      {/* Disbursements & transfers — full provider evidence, retry controls and
          the account-update CTA live HERE so the main loan table stays lean. */}
      <LoanTransfersSection
        applicationId={app.applicationId || (app as unknown as { id?: string }).id || ""}
        loanStatus={loanRecordStatus}
        loanRecordId={(loan as { id?: string }).id ? String((loan as { id?: string }).id) : undefined}
        applicationInternalId={(loan as { applicationId?: string }).applicationId ? String((loan as { applicationId?: string }).applicationId) : undefined}
        onActionMessage={(message) => setSaveMsg(message ?? null)}
      />

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
              <h4 className="text-xs font-semibold text-velo-800 dark:text-slate-200 uppercase tracking-wide">Internal Score</h4>
              {app.creditReportSnapshot?.internal?.band && (
                <span className="badge bg-velo-50 text-velo-700">{app.creditReportSnapshot.internal.band}</span>
              )}
            </div>
            <div className="text-3xl font-semibold text-velo-900 mb-2">
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
            <div className="text-3xl font-semibold text-emerald-900 mb-2 flex items-center gap-2">
              {app.creditReportSnapshot?.external?.score ?? "—"}
              {app.creditReportSnapshot?.external?.status === "PENDING" && (
                <svg className="animate-spin text-amber-500" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-label="Credit bureau check running">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
                  <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
              )}
            </div>
            {app.creditReportSnapshot?.external?.status === "PENDING" && (
              <p className="mb-2 text-xs font-medium text-amber-700">Bureau check running — this card refreshes itself every few seconds.</p>
            )}
            <div className="text-xs text-slate-500 mb-3">
              Provider: {app.creditReportSnapshot?.external?.provider || "Prembly"}
              {app.creditReportSnapshot?.external?.product && app.creditReportSnapshot.external.product !== "CONSUMER_ADVANCE" && (
                <> · {String(app.creditReportSnapshot.external.product).replace(/_/g, " ")}</>
              )}
              {(app.creditReportSnapshot?.external?.pulledAt || app.creditReportSnapshot?.external?.requestedAt) && (
                <> · {app.creditReportSnapshot.external.pulledAt ? "Pulled" : "Requested"} {formatDateLabel(app.creditReportSnapshot.external.pulledAt || app.creditReportSnapshot.external.requestedAt)}</>
              )}
            </div>
            <div className="mb-3">
              <button
                type="button"
                onClick={handleRunCreditBureau}
                disabled={bureauBusy || !app.applicationId}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {bureauBusy ? (
                  <>
                    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
                      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                    </svg>
                    Running bureau check…
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <path d="M4 19V9m6 10V5m6 14v-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                    </svg>
                    Run credit bureau check
                  </>
                )}
              </button>
              <p className="mt-1.5 text-[11px] text-slate-500">
                Pulls a fresh Prembly report — Commercial (Business) Advance with the customer&apos;s RC number and registered name when available, otherwise the consumer check via their verified BVN or NIN. Real bureau lookups can take up to a minute; the result appears here automatically.
              </p>
              {bureauMsg && (
                <p className={`mt-2 rounded-lg px-3 py-2 text-xs font-medium ${app.creditReportSnapshot?.external?.status === "RECEIVED" ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>
                  {bureauMsg}
                </p>
              )}
            </div>
            {app.creditReportSnapshot?.external?.reportReference && (
              <Row label="Provider Ref" value={app.creditReportSnapshot.external.reportReference} mono />
            )}
            {app.creditReportSnapshot?.external?.reason && (
              <p className="mt-2 text-xs text-slate-500">{app.creditReportSnapshot.external.reason}</p>
            )}
            {app.creditReportSnapshot?.external?.normalizedFields && (
              <button
                type="button"
                onClick={() => setBureauModalOpen(true)}
                className="mt-3 inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200 dark:hover:bg-emerald-900/50"
              >
                <Icon name="shield" size={14} />
                View full bureau report
              </button>
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
            const isImage = source && (/^data:image\//i.test(source) || /\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i.test(source) || (document.mimeType || "").startsWith("image/"));
            return <div key={key} className="rounded-lg border border-slate-100 dark:border-slate-800 p-2 bg-white dark:bg-slate-900">
              {isImage ? (
                <a href={source} target="_blank" rel="noopener noreferrer" className="block">
                  <img src={source} alt={label} className="h-28 w-full rounded object-cover bg-slate-50 dark:bg-slate-800" />
                </a>
              ) : source ? (
                <a href={source} target="_blank" rel="noopener noreferrer" className="flex h-28 items-center justify-center rounded bg-slate-50 dark:bg-slate-800 text-xs font-medium text-velo-700 dark:text-velo-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition">
                  <div className="text-center">
                    <svg className="mx-auto mb-1 text-slate-400 dark:text-slate-500" width="24" height="24" viewBox="0 0 24 24" fill="none">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M14 2v6h6M8 13h8M8 17h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    Open file
                  </div>
                </a>
              ) : (
                <div className="flex h-28 items-center justify-center rounded bg-slate-50 dark:bg-slate-800 text-xs text-slate-400 dark:text-slate-500">
                  <div className="text-center">
                    <svg className="mx-auto mb-1" width="24" height="24" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M9 9.5v0M15 9.5v0M9 15c1 1 2 1.5 3 1.5s2-.5 3-1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    No preview
                  </div>
                </div>
              )}
              <div className="mt-2 text-xs font-medium text-slate-700 dark:text-slate-200">{label}</div>
              <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate">{document?.name || document?.fileName || "Uploaded attachment"}</div>
            </div>;
          })}
        </div>
        {!Object.keys(app.documents || {}).length && <div className="text-sm text-slate-500 dark:text-slate-400">No documents uploaded.</div>}
      </Card>

      <Card title="Review Decision & Stage Status">
        <Row label="System Decision" value={app.systemDecision?.decision} />
        <Row label="Manual Decision" value={app.manualDecision} />
        <Row label="Decision Reasons" value={Array.isArray(app.systemDecision?.reasons) ? app.systemDecision.reasons.join("; ") : ""} />
        {Object.entries(app.stageStatuses || {}).map(([stage, status]) => <Row key={stage} label={stage.replace(/_/g, " ")} value={status} />)}
      </Card>

      {/* Full credit-bureau report — beautiful structured rendering of the
          provider response (opens from the “View full bureau report” button). */}
      <CreditBureauReportModal
        open={bureauModalOpen}
        onClose={() => setBureauModalOpen(false)}
        external={app.creditReportSnapshot?.external ?? null}
        borrowerName={isPersonal ? app.personalInfo?.fullName : app.businessInfo?.businessName}
        applicationId={app.applicationId}
      />

      {/* Rejection reason prompt — the decision cannot be applied without a
          reason; it is emailed to the borrower and shown in their dashboard. */}
      {rejectModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true" aria-labelledby="reject-reason-title">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900">
            <div className="flex items-center justify-between gap-3">
              <h2 id="reject-reason-title" className="text-base font-semibold text-velo-900 dark:text-white">Reject loan application</h2>
              <button type="button" className="text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300" onClick={() => { setRejectModalOpen(false); setNewStatus(""); }}>
                Cancel
              </button>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              A reason is required before the application can be rejected. It will be emailed to the borrower, shown in their dashboard and included in their notification feed.
            </p>
            <textarea
              value={rejectionReason}
              onChange={(event) => setRejectionReason(event.target.value)}
              rows={4}
              maxLength={1000}
              autoFocus
              className="velo-input mt-3 w-full"
              placeholder="e.g. The stated monthly income could not be verified against the submitted documents."
            />
            <div className="mt-1 flex justify-between text-[10px] text-slate-400">
              <span>Minimum 3 characters</span>
              <span>{rejectionReason.trim().length}/1000</span>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => { setRejectModalOpen(false); setNewStatus(""); }}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={rejectionReason.trim().length < 3 || saving}
                onClick={async () => {
                  const reason = rejectionReason.trim();
                  setRejectModalOpen(false);
                  await handleUpdateStatus("REJECTED", reason);
                }}
              >
                {saving ? "Rejecting…" : "Confirm rejection"}
              </button>
            </div>
          </div>
        </div>
      )}
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
  return documentPreviewUrl(document) || documentDownloadUrl(document);
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

// ============================================================================
// DraftProgressPanel — shown when a borrower has saved draft progress that
// admin should be able to see (e.g. IN_PROGRESS applications). Renders a
// compact summary card with progress bar + last-saved timestamp.
// ============================================================================

function DraftProgressPanel({ draft }: { draft: AdminApplicationDraftDetail }) {
  const updated = draft.updatedAt ? new Date(draft.updatedAt) : null;
  return (
    <div className="velo-card p-4 sm:p-5 border-l-4 border-l-velo-500">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-velo-900 dark:text-white">Borrower's saved progress</h3>
            <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">{draft.status.replace(/_/g, " ")}</span>
          </div>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            {updated ? `Last saved ${updated.toLocaleString("en-NG")}` : "No save timestamp"}
            {" · "}
            Section {draft.currentSection + 1} of {draft.totalSections}
            {" · "}
            {draft.applicantType === "BUSINESS" ? "Business loan" : "Personal loan"}
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold text-velo-900 dark:text-white">{draft.progressPercent}%</div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400">complete</div>
        </div>
      </div>
      <div className="mt-3 h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
        <div className="h-2 rounded-full bg-velo-500 transition-all" style={{ width: `${draft.progressPercent}%` }} />
      </div>
    </div>
  );
}

// ============================================================================
// DraftDetailView — full draft detail view, shown when the application row
// doesn't exist yet (still in DRAFT state with no loanApplications entry).
// Renders the saved sections in read-only form.
// ============================================================================

function DraftDetailView({ draft, onBack }: { draft: AdminApplicationDraftDetail; onBack: () => void }) {
  const data = draft.data || {};
  const personalInfo = data.personalInfo || {};
  const businessInfo = data.businessInfo || {};
  const businessRep = data.businessRep || {};
  const personalFinancial = data.personalFinancial || {};
  const businessFinancial = data.businessFinancial || {};
  const kyc = data.kyc || {};
  const loanRequest = data.loanRequest || {};
  const collateral = data.collateral || {};
  const witness = data.witness || {};
  const disbursementAccount = data.disbursementAccount || {};
  const updated = draft.updatedAt ? new Date(draft.updatedAt) : null;

  return (
    <div className="space-y-5 animate-fade-in">
      <button type="button" onClick={onBack} className="btn-ghost text-xs">
        <Icon name="arrowLeft" size={14} />
        Back to list
      </button>

      {/* Header */}
      <div className="velo-card p-4 sm:p-5 lg:p-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-semibold text-velo-900 dark:text-white">
                {draft.applicantType === "PERSONAL" ? personalInfo.fullName : businessInfo.businessName || draft.borrower?.fullName || "Borrower"}
              </h1>
              <span className={`badge ${draft.applicantType === "PERSONAL" ? "bg-velo-50 text-velo-700 dark:bg-velo-900/30 dark:text-velo-300" : "bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300"}`}>
                {draft.applicantType === "PERSONAL" ? "Personal" : "Business"}
              </span>
              <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">{draft.status.replace(/_/g, " ")}</span>
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Application ID: <span className="font-mono">{draft.applicationId}</span>
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {updated ? `Last saved ${updated.toLocaleString("en-NG")}` : "No save timestamp"}
              {" · "}Section {draft.currentSection + 1} of {draft.totalSections} · {draft.progressPercent}% complete
            </p>
          </div>
        </div>
        <div className="mt-4 h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
          <div className="h-2 rounded-full bg-velo-500" style={{ width: `${draft.progressPercent}%` }} />
        </div>
      </div>

      {/* Loan request (if saved) */}
      {loanRequest && (loanRequest.amount || loanRequest.tenure || loanRequest.purpose) ? (
        <DetailCard title="Loan request">
          <DetailRow label="Amount" value={loanRequest.amount ? formatNaira(Number(loanRequest.amount)) : "—"} />
          <DetailRow label="Tenure" value={loanRequest.tenure ? `${loanRequest.tenure} days` : "—"} />
          <DetailRow label="Purpose" value={loanRequest.purpose || "—"} />
        </DetailCard>
      ) : null}

      {/* Personal info */}
      {personalInfo && Object.keys(personalInfo).length > 0 ? (
        <DetailCard title="Personal information">
          <DetailRow label="Full name" value={personalInfo.fullName} />
          <DetailRow label="Phone" value={personalInfo.phone} />
          <DetailRow label="Email" value={personalInfo.email} />
          <DetailRow label="Date of birth" value={personalInfo.dateOfBirth} />
          <DetailRow label="Residential address" value={personalInfo.residentialAddress} />
          <DetailRow label="State" value={personalInfo.state} />
          <DetailRow label="LGA" value={personalInfo.lga} />
        </DetailCard>
      ) : null}

      {/* Business info */}
      {draft.applicantType === "BUSINESS" && businessInfo && Object.keys(businessInfo).length > 0 ? (
        <DetailCard title="Business information">
          <DetailRow label="Business name" value={businessInfo.businessName} />
          <DetailRow label="Registration number" value={businessInfo.businessRegistrationNumber} />
          <DetailRow label="Business type" value={businessInfo.businessType} />
          <DetailRow label="Industry" value={businessInfo.businessIndustry} />
          <DetailRow label="Address" value={businessInfo.businessAddress} />
          <DetailRow label="Years in business" value={businessInfo.yearsInBusiness} />
        </DetailCard>
      ) : null}

      {/* Business representative */}
      {draft.applicantType === "BUSINESS" && businessRep && Object.keys(businessRep).length > 0 ? (
        <DetailCard title="Business representative">
          <DetailRow label="Full name" value={businessRep.fullName} />
          <DetailRow label="Position" value={businessRep.position} />
          <DetailRow label="Phone" value={businessRep.phone} />
          <DetailRow label="Email" value={businessRep.email} />
        </DetailCard>
      ) : null}

      {/* KYC */}
      {kyc && Object.keys(kyc).length > 0 ? (
        <DetailCard title="KYC">
          <DetailRow label="BVN" value={kyc.bvn} />
          <DetailRow label="NIN" value={kyc.nin} />
          <DetailRow label="ID type" value={kyc.identificationType} />
          <DetailRow label="ID number" value={kyc.identificationNumber} />
        </DetailCard>
      ) : null}

      {/* Financial */}
      {draft.applicantType === "PERSONAL" && personalFinancial && Object.keys(personalFinancial).length > 0 ? (
        <DetailCard title="Personal financial">
          <DetailRow label="Employment status" value={personalFinancial.employmentStatus} />
          <DetailRow label="Employer" value={personalFinancial.employerBusinessName} />
          <DetailRow label="Monthly income" value={personalFinancial.monthlyIncome ? formatNaira(Number(personalFinancial.monthlyIncome)) : "—"} />
          <DetailRow label="Monthly expenses" value={personalFinancial.monthlyExpenses ? formatNaira(Number(personalFinancial.monthlyExpenses)) : "—"} />
          <DetailRow label="Existing loan obligations" value={personalFinancial.existingLoanObligations} />
          <DetailRow label="Expected repayment source" value={personalFinancial.expectedRepaymentSource} />
        </DetailCard>
      ) : null}

      {draft.applicantType === "BUSINESS" && businessFinancial && Object.keys(businessFinancial).length > 0 ? (
        <DetailCard title="Business financial">
          <DetailRow label="Monthly revenue" value={businessFinancial.monthlyRevenue ? formatNaira(Number(businessFinancial.monthlyRevenue)) : "—"} />
          <DetailRow label="Monthly expenses" value={businessFinancial.monthlyExpenses ? formatNaira(Number(businessFinancial.monthlyExpenses)) : "—"} />
          <DetailRow label="Existing loan obligations" value={businessFinancial.existingLoanObligations} />
          <DetailRow label="Expected repayment source" value={businessFinancial.expectedRepaymentSource} />
        </DetailCard>
      ) : null}

      {/* Disbursement account */}
      {disbursementAccount && Object.keys(disbursementAccount).length > 0 ? (
        <DetailCard title="Disbursement account">
          <DetailRow label="Account name" value={disbursementAccount.accountName} />
          <DetailRow label="Bank name" value={disbursementAccount.bankName} />
          <DetailRow label="Account number" value={disbursementAccount.accountNumber} />
        </DetailCard>
      ) : null}

      {/* Collateral + witness */}
      {collateral && Object.keys(collateral).length > 0 ? (
        <DetailCard title="Collateral">
          <DetailRow label="Type" value={collateral.type} />
          <DetailRow label="Description" value={collateral.description} />
          <DetailRow label="Estimated value" value={collateral.estimatedValue ? formatNaira(Number(collateral.estimatedValue)) : "—"} />
        </DetailCard>
      ) : null}

      {witness && (witness.fullName || witness.phone) ? (
        <DetailCard title="Witness">
          <DetailRow label="Full name" value={witness.fullName} />
          <DetailRow label="Phone" value={witness.phone} />
        </DetailCard>
      ) : null}
    </div>
  );
}

function DetailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="velo-card p-5">
      <h3 className="text-sm font-semibold text-velo-900 dark:text-white mb-3">{title}</h3>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">{children}</dl>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: any }) {
  const display = value === undefined || value === null || value === "" ? "—" : String(value);
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-2 py-1 border-b border-slate-100 dark:border-slate-800 last:border-0">
      <dt className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="font-medium text-velo-900 dark:text-white sm:text-right">{display}</dd>
    </div>
  );
}


// ---------------------------------------------------------------------------
// LoanTransfersSection — every Flutterwave transfer attempt for this loan with
// its real provider response, retry controls and the "ask customer to update
// account" CTA. Moved here from the main loan table so the table stays a
// lean overview and the detail page holds the operational depth.
// ---------------------------------------------------------------------------
function LoanTransfersSection({
  applicationId,
  loanStatus,
  loanRecordId,
  applicationInternalId,
  onActionMessage,
}: {
  applicationId: string;
  loanStatus?: string;
  loanRecordId?: string;
  applicationInternalId?: string;
  onActionMessage?: (message: string | undefined) => void;
}) {
  const [transfers, setTransfers] = useState<LoanDisbursement[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    try {
      const response = await adminListDisbursements({ limit: 200 });
      // Disbursement rows store the application's INTERNAL id, not the public
      // applicationId string — match on every key we know so an active loan
      // always finds its transfers (an empty list here used to re-expose the
      // "Disburse via Flutterwave" CTA on already-disbursed loans).
      const matches = response.disbursements
        .filter(
          (d) =>
            (applicationId && d.applicationId === applicationId) ||
            (applicationInternalId && d.applicationId === applicationInternalId) ||
            (loanRecordId && d.loanId === loanRecordId)
        )
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setTransfers(matches);
    } catch {
      // Non-fatal — the section just shows an empty state.
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationId]);

  async function disburse() {
    setBusy("disburse");
    setActionError("");
    setNotice("");
    try {
      const response = await adminDisburseLoan(applicationId);
      const transferStatus = String((response.disbursement as { status?: string } | undefined)?.status || "");
      let outcome: string | undefined;
      if (response.ok === false) {
        outcome = String(response.error || response.message || "Disbursement failed — see the provider response on the transfer card.");
        setActionError(outcome);
      } else if (transferStatus === "SUCCESSFUL") {
        outcome = String(response.message || "Disbursement successful.");
        setNotice(outcome);
      } else {
        outcome = String(response.message || "Disbursement still processing — the final status is confirmed automatically.");
        setNotice(outcome);
      }
      onActionMessage?.(outcome);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to initiate disbursement");
    } finally {
      setBusy("");
    }
  }

  async function retry(disbursementId: string) {
    setBusy(disbursementId);
    setActionError("");
    setNotice("");
    try {
      const response = await adminRetryDisbursement(disbursementId);
      const transferStatus = String((response.disbursement as { status?: string } | undefined)?.status || "");
      if (response.ok === false) setActionError(String(response.error || response.message || "Retry failed — see the provider response on the transfer card."));
      else if (transferStatus === "SUCCESSFUL") setNotice(String(response.message || "Retry successful."));
      else setNotice(String(response.message || "Retry submitted — the final status is confirmed automatically."));
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to retry disbursement");
    } finally {
      setBusy("");
    }
  }

  async function requestAccountUpdate() {
    setBusy("acct");
    setActionError("");
    setNotice("");
    try {
      const response = await adminRequestDisbursementAccountUpdate(applicationId);
      setNotice(String(response.message || "Account update requested — the customer has been notified."));
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to send the account-update request");
    } finally {
      setBusy("");
    }
  }

  const latest = transfers[0];
  const hasSuccessful = transfers.some((t) => t.status === "SUCCESSFUL");
  const inFlight = transfers.some((t) => ["PROCESSING", "PENDING"].includes(t.status));
  // Status-aware CTA gating: a disbursed/active loan must never show the
  // disburse (or retry) CTA again, even if the transfer list failed to load —
  // and a DISBURSEMENT_PENDING loan is mid-flight until the provider settles.
  const loanStatusUpper = String(loanStatus || "").toUpperCase();
  const disbursedLocked = DISBURSED_LIKE_STATUSES.has(loanStatusUpper);
  const disbursementInFlight = loanStatusUpper === "DISBURSEMENT_PENDING";

  return (
    <div className="velo-card p-4 sm:p-5 lg:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-velo-900 dark:text-white">Disbursements &amp; transfers</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {transfers.length === 0
              ? "No transfer attempts yet for this loan."
              : `${transfers.length} attempt${transfers.length === 1 ? "" : "s"} · newest first.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {latest && latest.status === "FAILED" && !disbursedLocked && (
            <button type="button" className="btn-secondary text-xs" disabled={busy !== "" || inFlight} onClick={() => void retry(latest.id)}>
              {busy === latest.id ? "Retrying…" : "Retry disbursement"}
            </button>
          )}
          {!hasSuccessful && !inFlight && latest?.status !== "FAILED" && !disbursedLocked && !disbursementInFlight && (
            <button type="button" className="btn-primary text-xs" disabled={busy !== ""} onClick={() => void disburse()}>
              {busy === "disburse" ? "Disbursing…" : "Disburse via Flutterwave"}
            </button>
          )}
          {(latest?.status === "FAILED" || (!hasSuccessful && !inFlight)) && !disbursedLocked && !disbursementInFlight && (
            <button
              type="button"
              className="text-[11px] font-semibold text-amber-700 underline decoration-amber-400 underline-offset-2 hover:text-amber-800 disabled:opacity-50 dark:text-amber-400"
              disabled={busy !== ""}
              title="Notify the customer to re-provide a valid disbursement account from their dashboard settings"
              onClick={() => void requestAccountUpdate()}
            >
              {busy === "acct" ? "Sending request…" : "Ask customer to update account"}
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          <span>{actionError}</span>
          <button type="button" className="text-xs font-semibold underline" onClick={() => setActionError("")}>Dismiss</button>
        </div>
      )}
      {notice && (
        <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300">
          <span>{notice}</span>
          <button type="button" className="text-xs font-semibold underline" onClick={() => setNotice("")}>Dismiss</button>
        </div>
      )}

      {disbursedLocked && (
        <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2.5 text-xs text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300">
          <svg className="mt-0.5 flex-shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none">
            <rect x="4" y="10" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" />
          </svg>
          <span>
            <strong>Loan already disbursed and active</strong> — duplicate disbursement is blocked for this application ID. Repayments, reconciliation and the repayment schedule continue automatically.
          </span>
        </div>
      )}
      {disbursementInFlight && !disbursedLocked && (
        <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
          <svg className="mt-0.5 flex-shrink-0 animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
            <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          <span>
            <strong>Disbursement in progress</strong> — the transfer's final status is confirmed automatically. A second disbursement is blocked while this one is unresolved.
          </span>
        </div>
      )}

      {loading ? (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">Loading transfer records…</p>
      ) : transfers.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          Once a disbursement is initiated, every transfer attempt and Flutterwave's real response appears here.
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {transfers.map((t) => (
            <div key={t.id} className={`rounded-xl border p-4 ${t.status === "FAILED" ? "border-red-200 bg-red-50/50 dark:border-red-900/50 dark:bg-red-950/20" : t.status === "SUCCESSFUL" ? "border-emerald-200 bg-emerald-50/40 dark:border-emerald-900/50 dark:bg-emerald-950/20" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
              <div className="flex flex-wrap items-center gap-2 justify-between">
                <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
                  #{t.id.slice(0, 10)}…
                  {t.retryOfId && <span className="ml-2 text-amber-600 dark:text-amber-400">(retry #{t.retryCount || 1})</span>}
                </div>
                <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold uppercase ${t.status === "SUCCESSFUL" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : t.status === "FAILED" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"}`}>
                  {t.status}
                </span>
              </div>
              <div className="mt-2 grid gap-x-6 gap-y-1 text-xs text-slate-600 dark:text-slate-300 sm:grid-cols-2">
                <div>Amount: <strong className="text-velo-900 dark:text-white">{formatNaira(Number(t.amountNaira || 0))}</strong></div>
                <div>Created: {t.createdAt ? new Date(t.createdAt).toLocaleString() : "—"}</div>
                <div>Bank: {t.bankName || t.bankCode || "—"} · Acc: {t.accountNumber ? `••••${String(t.accountNumber).slice(-4)}` : "—"}</div>
                <div>Beneficiary: {t.accountName || "—"}</div>
                {t.providerReference && <div className="sm:col-span-2">Provider ref: <span className="font-mono">{t.providerReference}</span></div>}
              </div>
              {t.status === "FAILED" && (
                <div className="mt-3 rounded-md border border-red-200 bg-white px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-slate-900 dark:text-red-300">
                  <div className="font-semibold">Disbursement failed{t.error ? `: ${t.error}` : ""}.</div>
                  <div className="mt-1">Review the provider response below and the borrower's account, then retry or ask the customer to update their account.</div>
                </div>
              )}
              {t.status === "PROCESSING" && (
                <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                  Transfer is being processed by the provider — the final status is confirmed automatically and this card updates within a minute or two.
                </div>
              )}
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-semibold text-velo-700 hover:underline dark:text-velo-400">View provider response</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-[11px] text-slate-700 dark:bg-slate-900 dark:text-slate-300">
                  {JSON.stringify({ provider: t.providerTransfer, error: t.error }, null, 2)}
                </pre>
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
