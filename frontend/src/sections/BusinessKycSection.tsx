// ============================================================================
// src/sections/BusinessKycSection.tsx
// Section 3 for Business Loan applicants — Representative's BVN/NIN + ID + proof.
// ============================================================================

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import FormInput from "../components/FormInput";
import SelectInput from "../components/SelectInput";
import FileUpload from "../components/FileUpload";
import SectionShell from "../components/SectionShell";
import { useApplication } from "../context/ApplicationContext";
import { kycSchema, type KycForm } from "../utils/validation";
import type { UploadedDocument, DocumentSlot } from "../types/documents";

const ID_TYPES = [
  { value: "National ID Card",       label: "National ID Card" },
  { value: "International Passport", label: "International Passport" },
  { value: "Driver's Licence",         label: "Driver's Licence" },
  { value: "Voter's Card",            label: "Voter's Card" },
];

export default function BusinessKycSection() {
  const { application, patchKyc, patchDocuments, markSectionStatus, next } = useApplication();
  if (!application) return null;

  const {
    register,
    handleSubmit,
    formState: { errors, isValid },
  } = useForm<KycForm>({
    resolver: zodResolver(kycSchema),
    mode: "onChange",
    defaultValues: {
      bvn: application.kyc?.bvn || "",
      nin: application.kyc?.nin || "",
      identificationType: application.kyc?.identificationType || "",
      identificationNumber: application.kyc?.identificationNumber || "",
    },
  });

  function sync<K extends keyof KycForm>(key: K, value: KycForm[K]) {
    patchKyc({ [key]: value } as any);
  }

  function handleFile(slot: DocumentSlot, doc: UploadedDocument) {
    patchDocuments({ [slot]: { ...doc, slot } });
  }

  function handleRemoveFile(slot: DocumentSlot) {
    patchDocuments({ [slot]: undefined } as any);
  }

  const hasIdDoc = Boolean(application.documents?.identificationDocument);
  const hasProof = Boolean(application.documents?.proofOfAddress);
  const canContinue = isValid && hasIdDoc && hasProof;

  function onSubmit(data: KycForm) {
    patchKyc(data);
    markSectionStatus("kyc", "completed");
    next();
  }

  return (
    <SectionShell
      title="Business Representative Verification"
      description="We verify the identity of the business representative who signs this application."
      canContinue={canContinue}
      onContinue={handleSubmit(onSubmit)}
    >
      <div className="space-y-5">
        <div className="rounded-xl bg-velo-50 border border-velo-100 p-3 sm:p-4 flex items-start gap-3">
          <svg className="text-velo-600 shrink-0 mt-0.5" width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M12 2l9 4v6c0 5-3.5 8.5-9 10-5.5-1.5-9-5-9-10V6l9-4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
            <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <p className="text-xs text-velo-700 leading-relaxed">
            Your BVN and NIN are stored securely and used only for identity verification. They are never displayed in URLs, folder names, or your loan agreement.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <FormInput
            label="BVN"
            required
            inputMode="numeric"
            placeholder="11-digit BVN"
            error={errors.bvn?.message}
            {...register("bvn")}
            onChange={(e) => { register("bvn").onChange(e); sync("bvn", e.target.value); }}
          />
          <FormInput
            label="NIN"
            required
            inputMode="numeric"
            placeholder="11-digit NIN"
            error={errors.nin?.message}
            {...register("nin")}
            onChange={(e) => { register("nin").onChange(e); sync("nin", e.target.value); }}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <SelectInput
            label="Identification Type"
            required
            placeholder="Select ID type"
            options={ID_TYPES}
            error={errors.identificationType?.message}
            {...register("identificationType")}
            onChange={(e) => { register("identificationType").onChange(e); sync("identificationType", e.target.value as any); }}
          />
          <FormInput
            label="Identification Number"
            required
            placeholder="ID number"
            error={errors.identificationNumber?.message}
            {...register("identificationNumber")}
            onChange={(e) => { register("identificationNumber").onChange(e); sync("identificationNumber", e.target.value); }}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <FileUpload
            label="Identification Document"
            required
            document={application.documents?.identificationDocument}
            onFile={(doc) => handleFile("identificationDocument", doc)}
            onRemove={() => handleRemoveFile("identificationDocument")}
          />
          <FileUpload
            label="Proof of Address"
            required
            helper="Utility bill, bank statement, or similar (not older than 3 months)."
            document={application.documents?.proofOfAddress}
            onFile={(doc) => handleFile("proofOfAddress", doc)}
            onRemove={() => handleRemoveFile("proofOfAddress")}
          />
        </div>
      </div>
    </SectionShell>
  );
}
