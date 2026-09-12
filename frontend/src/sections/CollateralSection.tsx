import SectionShell from "../components/SectionShell";
import FileUpload from "../components/FileUpload";
import { useApplication } from "../context/ApplicationContext";
import { getLoanProgram } from "../utils/config";
import type { UploadedDocument } from "../types/documents";

export default function CollateralSection() {
  const { application, update, patchDocuments, markSectionStatus, next } = useApplication();
  if (!application || !application.applicantType) return null;

  const rules = getLoanProgram(application.applicantType).collateral;
  const collateral = application.collateral;
  const media = application.documents?.collateralMedia;
  const detailsComplete = Boolean(collateral?.type && collateral.description && collateral.estimatedValue && collateral.ownership && collateral.location);
  const canContinue = !rules.enabled || (detailsComplete && Boolean(media));

  function patch(patch: Partial<typeof collateral>) {
    update("collateral", { ...collateral, ...patch });
  }

  function handleMedia(document: UploadedDocument) {
    patchDocuments({ collateralMedia: { ...document, slot: "collateralMedia" } });
  }

  function removeMedia() {
    patchDocuments({ collateralMedia: undefined } as any);
  }

  function handleContinue() {
    if (!canContinue) return;
    markSectionStatus("collateral", rules.enabled ? "completed" : "skipped");
    next();
  }

  return (
    <SectionShell
      title="Collateral"
      description="Provide the asset details and supporting evidence for this loan."
      canContinue={canContinue}
      onContinue={handleContinue}
    >
      {!rules.enabled ? (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
          Collateral is not required for this loan program. You can continue to the agreement.
        </div>
      ) : (
        <div className="space-y-5">
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block"><span className="velo-label">Collateral type <span className="text-red-500">*</span></span><select className="velo-input" value={collateral.type} onChange={(event) => patch({ type: event.target.value })}><option value="">Select collateral type</option><option>Land or Property</option><option>Vehicle</option><option>Equipment or Machinery</option><option>Inventory or Stock</option><option>Receivables</option><option>Other</option></select></label>
              <label className="block"><span className="velo-label">Estimated value (₦) <span className="text-red-500">*</span></span><div className="relative"><span className="absolute inset-y-0 left-0 flex items-center pl-4 text-slate-500 text-sm pointer-events-none">₦</span><input className="velo-input pl-10" inputMode="numeric" value={collateral.estimatedValue} onChange={(event) => patch({ estimatedValue: event.target.value.replace(/[^0-9,]/g, "") })} placeholder="e.g. 5,000,000" /></div></label>
              <label className="block"><span className="velo-label">Ownership status <span className="text-red-500">*</span></span><select className="velo-input" value={collateral.ownership} onChange={(event) => patch({ ownership: event.target.value })}><option value="">Select ownership</option><option>Owned by me / my business</option><option>Owned jointly</option><option>Third-party asset with consent</option><option>Leased or financed</option></select></label>
              <label className="block"><span className="velo-label">Asset location <span className="text-red-500">*</span></span><input className="velo-input" value={collateral.location} onChange={(event) => patch({ location: event.target.value })} placeholder="City, state, country" /></label>
            </div>
            <label className="block"><span className="velo-label">Collateral description <span className="text-red-500">*</span></span><textarea className="velo-input resize-none" rows={4} value={collateral.description} onChange={(event) => patch({ description: event.target.value })} placeholder="Describe the asset, condition, make/model, title or registration details, and any other relevant information." /></label>
            <label className="block"><span className="velo-label">Title, registration or reference number</span><input className="velo-input" value={collateral.documentReference} onChange={(event) => patch({ documentReference: event.target.value })} placeholder="Optional supporting reference" /></label>
            <FileUpload label="Collateral photo or video" helper="Upload a clear photo, title image, or short video showing the collateral." required media document={media} onFile={handleMedia} onRemove={removeMedia} />
            {!canContinue && <p className="velo-error-text">Complete the collateral details and upload supporting media to continue.</p>}
          </>
        </div>
      )}
    </SectionShell>
  );
}
