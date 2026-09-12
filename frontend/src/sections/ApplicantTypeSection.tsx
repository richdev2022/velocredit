// ============================================================================
// src/sections/ApplicantTypeSection.tsx
// First step of the wizard — pick Personal or Business loan.
// When resuming an existing saved draft of the same chosen type, the wizard
// jumps directly to the first incomplete section instead of walking the user
// through every section again from the top.
// ============================================================================

import { useMemo, useState } from "react";
import ApplicantTypeSelector from "../components/ApplicantTypeSelector";
import Icon from "../components/Icon";
import SectionShell from "../components/SectionShell";
import { useApplication } from "../context/ApplicationContext";
import { getApplicationDraft } from "../services/apiClient";
import type { ApplicantType, ApplicationData, SectionKey, SectionStatus } from "../types/application";
import { getLoanProgram } from "../utils/config";

const PERSONAL_SECTIONS: SectionKey[] = [
  "applicantType", "kyc", "info", "financial", "loanRequest", "collateral", "agreement", "review",
];
const BUSINESS_SECTIONS: SectionKey[] = [
  "applicantType", "info", "kyc", "businessRep", "financial", "loanRequest", "collateral", "agreement", "review",
];

function deriveStatusForSection(app: ApplicationData, key: SectionKey, applicantType: ApplicantType): SectionStatus {
  switch (key) {
    case "applicantType":
      return applicantType ? "completed" : "not_started";
    case "info": {
      if (applicantType === "PERSONAL") {
        const p = app.personalInfo;
        const account = app.disbursementAccount;
        const ok = Boolean(p.fullName && p.phone && p.email && p.dateOfBirth && p.residentialAddress && p.state && p.lga && account.accountName && account.bankName && account.accountNumber);
        return ok ? "completed" : "not_started";
      }
      const b = app.businessInfo;
      const ok = Boolean(b.businessName && b.businessType && b.businessAddress && b.businessIndustry && b.yearsInBusiness);
      return ok ? "completed" : "not_started";
    }
    case "businessRep": {
      if (applicantType !== "BUSINESS") return "locked";
      const r = app.businessRep;
      const account = app.disbursementAccount;
      const ok = Boolean(r.fullName && r.position && r.phone && r.email && r.residentialAddress && account.accountName && account.bankName && account.accountNumber);
      return ok ? "completed" : "not_started";
    }
    case "kyc": {
      if (applicantType === "BUSINESS" && !app.businessRep?.fullName) return "locked";
      const k = app.kyc || { bvn: "", nin: "", identificationType: "", identificationNumber: "" };
      const ok = Boolean(k.bvn && k.nin && k.identificationType && k.identificationNumber);
      return ok ? "completed" : "not_started";
    }
    case "financial": {
      if (applicantType === "PERSONAL") {
        const f = app.personalFinancial;
        const ok = Boolean(f.employmentStatus && f.monthlyIncome && f.monthlyExpenses && f.expectedRepaymentSource);
        return ok ? "completed" : "not_started";
      }
      const bf = app.businessFinancial;
      const ok = Boolean(bf.averageMonthlyRevenue && bf.averageMonthlyExpenses && bf.expectedRepaymentSource);
      return ok ? "completed" : "not_started";
    }
    case "loanRequest": {
      const req = app.loanRequest;
      const ok = Boolean(req.amount && req.tenure && req.purpose && req.purpose.length >= 10);
      return ok ? "completed" : "not_started";
    }
    case "collateral": {
      const rules = getLoanProgram(applicantType).collateral;
      if (!rules.enabled) return "skipped";
      const c = app.collateral;
      const detailsComplete = Boolean(c?.type && c.description && c.estimatedValue && c.ownership && c.location);
      return rules.required ? (detailsComplete && Boolean(app.documents?.collateralMedia) ? "completed" : "not_started") : (c?.provided ? (detailsComplete && Boolean(app.documents?.collateralMedia) ? "completed" : "not_started") : "completed");
    }
    case "agreement": {
      if (!app.loanRequest?.purpose) return "locked";
      const ok = Boolean(app.agreement?.signedAgreementAccepted);
      return ok ? "completed" : "not_started";
    }
    case "review": {
      if (!app.loanRequest?.purpose) return "locked";
      return "not_started";
    }
  }
}

function computeResumeSectionIndex(app: ApplicationData, applicantType: ApplicantType): number {
  const ordered = applicantType === "PERSONAL" ? PERSONAL_SECTIONS : BUSINESS_SECTIONS;
  let firstIncomplete = 1;
  for (let i = 1; i < ordered.length; i++) {
    const status = deriveStatusForSection(app, ordered[i], applicantType);
    if (status === "completed" || status === "skipped") continue;
    firstIncomplete = i;
    break;
  }
  const saved = typeof app.lastSectionIndex === "number" ? app.lastSectionIndex : 0;
  if (saved > firstIncomplete && saved < ordered.length) return saved;
  return firstIncomplete;
}

export default function ApplicantTypeSection() {
  const { application, update, markSectionStatus, navigate, next, saveNow, startNewApplication, loadExisting, currentIndex, sections } = useApplication();
  const [busyResuming, setBusyResuming] = useState(false);
  const [selected, setSelected] = useState<ApplicantType | null>(application?.applicantType || null);

  const isReturningToSameType = useMemo(() => Boolean(application?.applicantType && application.applicantType === selected), [application?.applicantType, selected]);

  function handleSelect(t: ApplicantType) {
    setSelected(t);
    if (!application) {
      startNewApplication(t);
    } else {
      update("applicantType", t);
    }
  }

  async function handleContinue() {
    if (!selected || busyResuming) return;
    let workingApp = application;
    if (!workingApp) {
      workingApp = startNewApplication(selected);
    } else {
      if (workingApp.applicantType !== selected) {
        update("applicantType", selected);
      }
    }
    markSectionStatus("applicantType", "completed");
    const switchingType = Boolean(application && application.applicantType && application.applicantType !== selected);
    let targetIndex = 1;
    if (!switchingType) {
      setBusyResuming(true);
      try {
        const remote = await getApplicationDraft().catch(() => (null as null));
        let appForJump = workingApp;
        if (remote && remote.draft && remote.draft.data) {
          try {
            const remoteData = remote.draft.data as unknown as ApplicationData;
            const remoteType = remoteData.applicantType || workingApp.applicantType;
            if (remoteType === selected) {
              appForJump = remoteData;
              loadExisting(remote.draft.applicationId || workingApp.applicationId, remoteData, null);
            }
          } catch (_e) { /* ignore */ }
        }
        targetIndex = computeResumeSectionIndex(appForJump, selected);
      } catch (_err) {
        targetIndex = workingApp && !switchingType ? computeResumeSectionIndex(workingApp, selected) : 1;
      } finally {
        setBusyResuming(false);
      }
    }
    void (async () => {
      try { await saveNow(); } catch (_e) { /* ignore */ }
      if (targetIndex === 1 && currentIndex === 0) {
        next();
      } else {
        navigate(targetIndex);
      }
    })();
  }

  return (
    <SectionShell
      title="What type of loan are you applying for?"
      description="Choose the option that best describes your need."
      canContinue={!!selected && !busyResuming}
      continueLabel={busyResuming ? "Loading your progress…" : (isReturningToSameType ? "Resume application" : undefined)}
      onContinue={handleContinue}
    >
      <ApplicantTypeSelector value={selected} onChange={handleSelect} />

      <div className="mt-5 rounded-xl bg-slate-50 border border-slate-100 p-4 flex items-start gap-3">
        <svg className="text-slate-400 shrink-0 mt-0.5" width="18" height="18" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8"/>
          <path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
        </svg>
        <p className="text-xs text-slate-600 leading-relaxed">
          Your selection determines which sections of the form you'll need to complete. You can save and resume at any time.
          {isReturningToSameType && sections.length > 0 ? (
            <span className="mt-2 flex items-start gap-1.5 font-semibold text-emerald-700">
              <Icon name="check" size={14} className="mt-0.5 shrink-0" />We detected a saved {selected === "PERSONAL" ? "personal" : "business"} draft — continuing will take you straight to the next section you need to complete.
            </span>
          ) : null}
        </p>
      </div>
    </SectionShell>
  );
}
