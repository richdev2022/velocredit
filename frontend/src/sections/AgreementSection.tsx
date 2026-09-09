// ============================================================================
// src/sections/AgreementSection.tsx
// Generate -> preview -> download -> sign -> upload signed copy.
// ============================================================================

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import SectionShell from "../components/SectionShell";
import FileUpload from "../components/FileUpload";
import AgreementPreview from "../components/AgreementPreview";
import AgreementDownload from "../components/AgreementDownload";
import LoanSummary from "../components/LoanSummary";
import { useApplication } from "../context/ApplicationContext";
import { generateLoanAgreement } from "../services/agreementGenerator";
import type { UploadedDocument } from "../types/documents";

type Stage = "not-generated" | "generated" | "signed-ready" | "uploaded";

export default function AgreementSection() {
  const { application, calculation, patchAgreement, patchDocuments, markSectionStatus } = useApplication();
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>(() => {
    if (application?.documents?.signedAgreement) return "uploaded";
    if (application?.agreement?.generatedHtml) return "generated";
    return "not-generated";
  });

  if (!application || !calculation) return null;

  function handleGenerate() {
    const { html } = generateLoanAgreement(application!, calculation!);
    patchAgreement({ generatedAt: new Date().toISOString(), generatedHtml: html });
    setStage("generated");
  }

  function handleSignedFile(doc: UploadedDocument) {
    patchDocuments({ signedAgreement: { ...doc, slot: "signedAgreement" } });
    setStage("uploaded");
  }

  function handleRemoveSignedFile() {
    patchDocuments({ signedAgreement: undefined } as any);
    setStage("signed-ready");
  }

  function handleAcceptConsent(checked: boolean) {
    patchAgreement({ signedAgreementAccepted: checked });
  }

  function handleContinue() {
    if (!application?.agreement?.signedAgreementAccepted) return;
    if (!(stage === "generated" || stage === "signed-ready" || stage === "uploaded")) return;
    markSectionStatus("agreement", "completed");
    navigate("/apply/dashboard");
  }

  const canContinue =
    (stage === "generated" || stage === "signed-ready" || stage === "uploaded") &&
    application.agreement?.signedAgreementAccepted === true;

  return (
    <SectionShell
      title="Loan Agreement"
      description="Your loan agreement is generated automatically from the information you provided."
      canContinue={canContinue}
      onContinue={handleContinue}
    >
      <div className="space-y-6">
        {/* Step 1 — Generate */}
        {stage === "not-generated" && (
          <div className="text-center py-6">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-velo-50 text-velo-600 mb-4">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
                <path d="M14 2v6h6M8 13h8M8 17h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </div>
            <h3 className="text-base font-semibold text-velo-900">Generate Loan Agreement</h3>
            <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
              We'll populate the agreement with your information and loan terms automatically. You don't need to re-type anything.
            </p>
            <button type="button" onClick={handleGenerate} className="btn-primary mt-4 mx-auto">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 4v16M4 12h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              Generate Loan Agreement
            </button>
          </div>
        )}

        {/* Step 2 — Preview + Download */}
        {stage !== "not-generated" && (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              <div className="lg:col-span-1 space-y-3">
                <LoanSummary calculation={calculation} title="Loan Summary" />
                <div className="velo-card p-4">
                  <h4 className="text-sm font-semibold text-velo-900 mb-2">Your Loan Agreement is Ready</h4>
                  <p className="text-xs text-slate-500 mb-3">
                    Please download and review the agreement carefully before signing.
                  </p>
                  <AgreementDownload application={application} calculation={calculation} />
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => setStage("signed-ready")}
                      className="btn-ghost text-xs w-full"
                    >
                      {stage === "uploaded" ? "Replace Signed Agreement" : "I've Downloaded — Continue to Upload Signed Copy"}
                    </button>
                  </div>
                </div>
              </div>
              <div className="lg:col-span-2">
                <AgreementPreview html={application.agreement?.generatedHtml || ""} />
              </div>
            </div>

            {/* Step 3 — Upload signed copy */}
            {(stage === "signed-ready" || stage === "uploaded") && (
              <div className="velo-card p-5 sm:p-6 bg-gradient-to-br from-velo-50/40 to-white">
                <h3 className="text-base font-semibold text-velo-900 mb-1">Upload Signed Loan Agreement</h3>
                <p className="text-sm text-slate-500 mb-4">
                  After signing the downloaded agreement (physically or electronically), upload the signed copy here.
                </p>

                <div className="space-y-4">
                  <FileUpload
                    label="Signed Loan Agreement"
                    required
                    document={application.documents?.signedAgreement}
                    onFile={handleSignedFile}
                    onRemove={handleRemoveSignedFile}
                  />

                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={application.agreement?.signedAgreementAccepted || false}
                      onChange={(e) => handleAcceptConsent(e.target.checked)}
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-velo-500 focus:ring-velo-300"
                    />
                    <span className="text-sm text-slate-700">
                      I confirm that I have read, understood and agreed to the terms of the Loan Agreement.
                      <span className="text-red-500 font-medium ml-1">*</span>
                    </span>
                  </label>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </SectionShell>
  );
}
