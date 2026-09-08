// ============================================================================
// src/sections/ReviewSection.tsx
// Final review screen — embedded inside the wizard. Edit + submit.
// ============================================================================

import { useState } from "react";
import ReviewApplication from "../components/ReviewApplication";
import SectionShell from "../components/SectionShell";
import { useApplication, canSubmitApplication } from "../context/ApplicationContext";
import type { SectionKey } from "../types/application";

export default function ReviewSection() {
  const { application, calculation, sections, goToSection, submit, isSubmitting, submitError } = useApplication();
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);

  if (!application || !calculation) return null;

  const canSubmit = canSubmitApplication(application, sections);

  function handleEdit(key: string) {
    goToSection(key as SectionKey);
  }

  function handleContinue() {
    setShowSubmitConfirm(true);
  }

  function handleConfirmSubmit() {
    void submit();
  }

  return (
    <SectionShell
      title="Review & Submit"
      description="Confirm everything looks correct, then submit your application."
      canContinue={canSubmit}
      onContinue={handleContinue}
      continueLabel="Submit Application"
      hideSaveExit={true}
    >
      <div className="space-y-5">
        <ReviewApplication application={application} calculation={calculation} onEdit={handleEdit} />

        {showSubmitConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-fade-in">
            <div className="velo-card p-6 max-w-md w-full bg-white shadow-elevated">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-velo-50 text-velo-600 mb-4">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-velo-900">Submit your application?</h3>
              <p className="text-sm text-slate-500 mt-1.5">
                Once submitted, your application will be sent to Velo Finance LTD for review. You will not be able to edit the form after submission.
              </p>

              {submitError && (
                <div className="mt-4 rounded-lg bg-red-50 border border-red-100 p-3 text-sm text-red-700">
                  {submitError}
                </div>
              )}

              <div className="mt-6 flex flex-col sm:flex-row gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowSubmitConfirm(false)}
                  disabled={isSubmitting}
                  className="btn-secondary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmSubmit}
                  disabled={isSubmitting}
                  className="btn-primary"
                >
                  {isSubmitting ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25"/>
                        <path d="M22 12a10 10 0 01-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
                      </svg>
                      Submitting…
                    </>
                  ) : (
                    "Submit Loan Application"
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </SectionShell>
  );
}
