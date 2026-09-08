// ============================================================================
// src/pages/LoanApplication.tsx
// Wizard host. Routes between:
//   /apply                    → choose applicant type (start)
//   /apply?type=PERSONAL      → start a new Personal application directly
//   /apply?type=BUSINESS      → start a new Business application directly
//   /apply/dashboard          → show section dashboard (after first save)
// ============================================================================

import { useEffect } from "react";
import { useSearchParams, useNavigate, Routes, Route, Navigate } from "react-router-dom";
import Layout from "../components/Layout";
import { useApplication, canSubmitApplication } from "../context/ApplicationContext";
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

function Wizard() {
  const {
    application,
    sections,
    currentIndex,
    saveState,
    lastSavedAt,
    navigate,
    submit,
  } = useApplication();

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

  // Each section component renders its own SectionShell — wrap in Layout here
  return <Layout>{renderSection()}</Layout>;
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
  const { application, startNewApplication } = useApplication();

  // If `?type=PERSONAL|BUSINESS` was passed and we don't have an application of
  // that type yet, auto-create one. This lets the landing page link directly
  // to "/apply?type=PERSONAL" to skip the type-selection step.
  useEffect(() => {
    const t = params.get("type");
    if (t === "PERSONAL" || t === "BUSINESS") {
      if (!application || application.applicantType !== t) {
        startNewApplication(t);
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
