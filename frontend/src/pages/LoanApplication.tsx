// ============================================================================
// src/pages/LoanApplication.tsx
// Wizard host. Routes between:
//   /apply                    → choose applicant type (start)
//   /apply?type=PERSONAL      → start a new Personal application directly
//   /apply?type=BUSINESS      → start a new Business application directly
//   /apply/dashboard          → show section dashboard (after first save)
// ============================================================================

import { useEffect, useRef } from "react";
import { useSearchParams, useNavigate, Routes, Route, Navigate } from "react-router-dom";
import Layout from "../components/Layout";
import { useApplication, canSubmitApplication } from "../context/ApplicationContext";
import { getBorrowerDashboard } from "../services/apiClient";
import type { ApplicationData } from "../types/application";
import ApplicantTypeSection from "../sections/ApplicantTypeSection";
import PersonalInfoSection from "../sections/PersonalInfoSection";
import PersonalKycSection from "../sections/PersonalKycSection";
import PersonalFinancialSection from "../sections/PersonalFinancialSection";
import BusinessInfoSection from "../sections/BusinessInfoSection";
import BusinessRepSection from "../sections/BusinessRepSection";
import BusinessKycSection from "../sections/BusinessKycSection";
import BusinessFinancialSection from "../sections/BusinessFinancialSection";
import LoanRequestSection from "../sections/LoanRequestSection";
import CollateralSection from "../sections/CollateralSection";
import AgreementSection from "../sections/AgreementSection";
import ReviewSection from "../sections/ReviewSection";
import ApplicationDashboard from "../components/ApplicationDashboard";
import SuccessPage from "./Success";

/**
 * Banner shown when the customer re-opens an application the loan team
 * REJECTED (or flagged MORE_INFORMATION_REQUIRED). Explains what failed and
 * guides them to fix the failed information and resubmit.
 */
function ReapplicationNotice({ application }: { application: ApplicationData }) {
  const isMoreInfo = application.status === "MORE_INFORMATION_REQUIRED";
  const note = application.rejectionNote?.trim();
  return (
    <div
      className={`rounded-xl border p-4 sm:p-5 ${
        isMoreInfo
          ? "border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/20"
          : "border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-900/20"
      }`}
      role="alert"
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
            isMoreInfo ? "bg-amber-500" : "bg-red-500"
          } text-white`}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="min-w-0">
          <p
            className={`text-sm font-bold ${
              isMoreInfo ? "text-amber-900 dark:text-amber-200" : "text-red-900 dark:text-red-200"
            }`}
          >
            {isMoreInfo
              ? "More information required on your loan application"
              : "Your loan application needs changes before it can be approved"}
          </p>
          <p
            className={`mt-1 text-sm leading-6 ${
              isMoreInfo ? "text-amber-800 dark:text-amber-300" : "text-red-800 dark:text-red-300"
            }`}
          >
            {isMoreInfo
              ? "The loan team needs a little more information to continue reviewing your application. Your previous answers are saved — go through the sections below to complete what is missing, then resubmit from Review & Submit."
              : "Your application was declined, but you can fix it and try again. Your previous answers are saved — go through the sections below to update the information that failed, then resubmit it for a fresh review from Review & Submit."}
          </p>
          {note && (
            <p
              className={`mt-2 rounded-lg px-3 py-2 text-sm font-medium ${
                isMoreInfo
                  ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                  : "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200"
              }`}
            >
              Reviewer note: “{note}”
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function PrefillNotice() {
  const { prefilledFrom, dismissPrefillNotice } = useApplication();
  if (!prefilledFrom) return null;
  return (
    <div className="rounded-xl border border-velo-200 bg-velo-50 p-4 dark:border-velo-800 dark:bg-velo-900/30" role="status">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-velo-500 text-white">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-bold text-velo-900 dark:text-white">Your previous details are already filled in</p>
            <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
              We pre-filled every section from your previous loan application and profile. Go through each section to confirm or update anything that has changed — you only need to re-upload documents and re-sign the agreement.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={dismissPrefillNotice}
          className="rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-slate-600 dark:hover:bg-slate-800"
          aria-label="Dismiss prefill notice"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function Wizard() {
  const {
    application,
    sections,
    currentIndex,
    saveState,
    lastSavedAt,
    navigate,
    submit,
    resetApplication,
  } = useApplication();

  // A draft can outlive its own application: if the server has already moved
  // the application to a terminal state (repaid / cancelled / written off),
  // the wizard must NOT keep showing the stale "submitted" screen — drop the
  // stale draft so a new loan request starts with a NEW application ID.
  const staleCheckedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!application || application.status !== "SUBMITTED") return;
    if (staleCheckedRef.current === application.applicationId) return;
    staleCheckedRef.current = application.applicationId;
    let cancelled = false;
    getBorrowerDashboard()
      .then((dashboard) => {
        if (cancelled) return;
        const rows = Array.isArray((dashboard as { applications?: unknown[] }).applications)
          ? ((dashboard as { applications: unknown[] }).applications as Array<Record<string, unknown>>)
          : [];
        const match = rows.find(
          (row) =>
            String(row.applicationId ?? "") === application.applicationId ||
            String(row.id ?? "") === application.applicationId,
        );
        if (match && ["REPAID", "CANCELLED", "WRITTEN_OFF"].includes(String(match.status))) {
          resetApplication();
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [application?.applicationId, application?.status, resetApplication]);

  // No active application — show applicant type selection
  if (!application) {
    return (
      <Layout>
        <ApplicantTypeSection />
      </Layout>
    );
  }

  // Submitted — show success page (SuccessPage wraps itself in Layout)
  if (application.status === "SUBMITTED") {
    return <SuccessPage application={application} />;
  }

  const current = sections[currentIndex];

  if (!current) {
    // Fall back to the dashboard
    return (
      <Layout>
        <div className="space-y-5">
          {(application.status === "REJECTED" || application.status === "MORE_INFORMATION_REQUIRED") && (
            <ReapplicationNotice application={application} />
          )}
          <ApplicationDashboard
            application={application}
            sections={sections}
            currentIndex={currentIndex}
            saveState={saveState}
            lastSavedAt={lastSavedAt}
            onNavigate={navigate}
            onSubmit={submit}
            canSubmit={canSubmitApplication(application, sections)}
          />
        </div>
      </Layout>
    );
  }

  const renderSection = () => {
    switch (current.key) {
      case "applicantType": return <ApplicantTypeSection />;
      case "info":
        return application.applicantType === "PERSONAL"
          ? <PersonalInfoSection />
          : <BusinessInfoSection />;
      case "businessRep":   return <BusinessRepSection />;
      case "kyc":
        return application.applicantType === "PERSONAL"
          ? <PersonalKycSection />
          : <BusinessKycSection />;
      case "financial":
        return application.applicantType === "PERSONAL"
          ? <PersonalFinancialSection />
          : <BusinessFinancialSection />;
      case "loanRequest":   return <LoanRequestSection />;
      case "collateral":    return <CollateralSection />;
      case "agreement":    return <AgreementSection />;
      case "review":       return <ReviewSection />;
      default: return <ApplicantTypeSection />;
    }
  };

  // Each section component renders its own SectionShell — wrap in Layout here.
  // A rejected / more-info application shows the re-application banner above
  // the section so the customer always knows WHY they are editing it, and a
  // freshly prefilled draft shows what was auto-filled from the previous loan.
  return (
    <Layout>
      <div className="space-y-5">
        {(application.status === "REJECTED" || application.status === "MORE_INFORMATION_REQUIRED") && (
          <ReapplicationNotice application={application} />
        )}
        <PrefillNotice />
        {renderSection()}
      </div>
    </Layout>
  );
}

function Dashboard() {
  const { application, sections, currentIndex, saveState, lastSavedAt, navigate, submit, resetApplication } = useApplication();
  const nav = useNavigate();

  if (!application) {
    return (
      <Layout>
        <div className="text-center py-16">
          <h2 className="text-xl font-semibold text-velo-900 mb-2">No active application</h2>
          <p className="text-sm text-slate-500 mb-5">Start a new application to see your dashboard here.</p>
          <button type="button" onClick={() => nav("/apply")} className="btn-primary">
            Start New Application
          </button>
        </div>
      </Layout>
    );
  }

  if (application.status === "SUBMITTED") {
    return <SuccessPage application={application} />;
  }

  return (
    <Layout>
      <div className="space-y-5">
        {(application.status === "REJECTED" || application.status === "MORE_INFORMATION_REQUIRED") && (
          <ReapplicationNotice application={application} />
        )}
        <ApplicationDashboard
          application={application}
          sections={sections}
          currentIndex={currentIndex}
          saveState={saveState}
          lastSavedAt={lastSavedAt}
          onNavigate={(i) => { navigate(i); nav("/apply"); }}
          onSubmit={submit}
          canSubmit={canSubmitApplication(application, sections)}
        />
      </div>
      <div className="mt-6 text-center">
        <button
          type="button"
          onClick={() => { if (confirm("Discard this draft and start over?")) { resetApplication(); nav("/"); } }}
          className="btn-ghost text-xs text-slate-500"
        >
          Discard & Start Over
        </button>
      </div>
    </Layout>
  );
}

function ApplyRoute() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { application, startNewApplication, prefillFromPrevious } = useApplication();

  // If `?type=PERSONAL|BUSINESS` was passed and we don't have an application of
  // that type yet, auto-create one. This lets the landing page link directly
  // to "/apply?type=PERSONAL" to skip the type-selection step.
  useEffect(() => {
    const t = params.get("type");
    if (t === "PERSONAL" || t === "BUSINESS") {
      if (!application || application.applicantType !== t) {
        startNewApplication(t);
        // Returning borrower: prefill every section from their most recent
        // previous application so nothing has to be re-entered. Awaited BEFORE
        // entering the wizard so sections render already populated (and the
        // resume index skips completed sections).
        void (async () => {
          await prefillFromPrevious();
          nav("/apply", { replace: true });
        })();
        return;
      }
      // clear the query string so a refresh doesn't re-trigger creation
      nav("/apply", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <Wizard />;
}

export default function LoanApplication() {
  return (
    <Routes>
      <Route path="/" element={<ApplyRoute />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
