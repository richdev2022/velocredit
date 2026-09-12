import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import SectionShell from "../components/SectionShell";
import FileUpload from "../components/FileUpload";
import AgreementPreview from "../components/AgreementPreview";
import LoanSummary from "../components/LoanSummary";
import { useApplication } from "../context/ApplicationContext";
import { generateLoanAgreement } from "../services/agreementGenerator";

type Stage = "not-generated" | "generated";

export default function AgreementSection() {
  const { application, calculation, update, patchAgreement, patchDocuments, markSectionStatus } = useApplication();
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>(() => application?.agreement?.generatedHtml ? "generated" : "not-generated");
  const [readToEnd, setReadToEnd] = useState(false);

  useEffect(() => {
    if (stage === "not-generated" || !application || !application.agreement.generatedHtml || !calculation) return;
    const currentApplication = application;
    const { html } = generateLoanAgreement(currentApplication, calculation);
    if (html !== currentApplication.agreement.generatedHtml) patchAgreement({ generatedHtml: html });
  }, [application, calculation, patchAgreement, stage]);

  const handleReadToEnd = useCallback((read: boolean) => setReadToEnd(read), []);

  if (!application || !calculation) return null;
  const currentApplication = application;
  const currentCalculation = calculation;

  function handleGenerate() {
    const executionDate = new Date().toISOString();
    const agreement = { ...currentApplication.agreement, executionDate };
    const { html } = generateLoanAgreement({ ...currentApplication, agreement }, currentCalculation);
    patchAgreement({ generatedAt: executionDate, executionDate, generatedHtml: html });
    setStage("generated");
  }


  function handleAcceptConsent(checked: boolean) {
    if (!readToEnd) return;
    patchAgreement({ signedAgreementAccepted: checked });
  }

  function handleContinue() {
    if (!readToEnd || !currentApplication.agreement.signedAgreementAccepted || stage !== "generated") return;
    markSectionStatus("agreement", "completed");
    navigate("/apply/dashboard");
  }

  const hasRequiredSigningData = Boolean(
    application.documents?.identificationDocument &&
    application.documents?.signature &&
    application.witness?.fullName?.trim() &&
    application.witness?.phone?.trim() &&
    application.documents?.witnessPassport &&
    application.documents?.witnessSignature,
  );
  const canContinue = stage === "generated" && readToEnd && hasRequiredSigningData && application.agreement?.signedAgreementAccepted === true;

  return (
    <SectionShell title="Loan Agreement" description="Your loan agreement is generated automatically from the information you provided." canContinue={canContinue} onContinue={handleContinue}>
      <div className="space-y-6">
        <div className="velo-card p-5 sm:p-6 space-y-5">
          <div>
            <h3 className="text-base font-semibold text-velo-900">Witness information</h3>
            <p className="text-sm text-slate-500 mt-1">Enter the witness details and upload their passport and signature. These details will appear in the agreement.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block"><span className="velo-label">Witness full name</span><input className="velo-input mt-1" value={application.witness?.fullName || ""} onChange={(event) => update("witness", { ...application.witness, fullName: event.target.value })} required /></label>
            <label className="block"><span className="velo-label">Witness phone number</span><input className="velo-input mt-1" value={application.witness?.phone || ""} onChange={(event) => update("witness", { ...application.witness, phone: event.target.value })} required /></label>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <FileUpload label="Witness passport" required document={application.documents?.witnessPassport} onFile={(doc) => patchDocuments({ witnessPassport: { ...doc, slot: "witnessPassport" } })} onRemove={() => patchDocuments({ witnessPassport: undefined } as any)} />
            <FileUpload label="Witness signature" required document={application.documents?.witnessSignature} onFile={(doc) => patchDocuments({ witnessSignature: { ...doc, slot: "witnessSignature" } })} onRemove={() => patchDocuments({ witnessSignature: undefined } as any)} />
          </div>
        </div>

        {stage === "not-generated" && (
          <div className="text-center py-6">
            <h3 className="text-base font-semibold text-velo-900">Generate Loan Agreement</h3>
            <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">We’ll populate the agreement with your information, loan terms, and in-app signatures automatically.</p>
            <button type="button" onClick={handleGenerate} className="btn-primary mt-4 mx-auto">Generate Loan Agreement</button>
          </div>
        )}

        {stage === "generated" && <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div className="lg:col-span-1 space-y-3">
              <LoanSummary calculation={calculation} title="Loan Summary" />
              <div className="velo-card p-4"><h4 className="text-sm font-semibold text-velo-900 mb-2">Your Loan Agreement is Ready</h4><p className="text-xs text-slate-500">Read the complete agreement, including its execution details, before acknowledging it.</p></div>
            </div>
            <div className="lg:col-span-2"><AgreementPreview html={application.agreement?.generatedHtml || ""} onReadToEnd={handleReadToEnd} /></div>
          </div>
          <div className="velo-card p-5 sm:p-6 bg-gradient-to-br from-velo-50/40 to-white">
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={application.agreement?.signedAgreementAccepted || false} onChange={(e) => handleAcceptConsent(e.target.checked)} disabled={!readToEnd} className="mt-1 h-4 w-4 rounded border-slate-300 text-velo-500 focus:ring-velo-300 disabled:cursor-not-allowed disabled:opacity-50" />
              <span className={`text-sm ${readToEnd ? "text-slate-700" : "text-slate-400"}`}>I confirm that I have read, understood and agreed to this electronically executed Loan Agreement.<span className="text-red-500 font-medium ml-1">*</span></span>
            </label>
          </div>
        </>}
      </div>
    </SectionShell>
  );
}
