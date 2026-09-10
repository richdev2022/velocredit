// ============================================================================
// src/sections/PersonalKycSection.tsx
// Section 2 for Personal Loan applicants — BVN, NIN, ID document, proof of address.
// ============================================================================

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import FormInput from "../components/FormInput";
import SelectInput from "../components/SelectInput";
import FileUpload from "../components/FileUpload";
import SectionShell from "../components/SectionShell";
import { useApplication } from "../context/ApplicationContext";
import { kycSchema, type KycForm } from "../utils/validation";
import type { UploadedDocument, DocumentSlot } from "../types/documents";
import { verifyMyBvn, verifyMyNin, verifyMyLiveness } from "../services/apiClient";
import PremblyKycWidgetButton from "../components/PremblyKycWidgetButton";

const ID_TYPES = [
  { value: "National ID Card",       label: "National ID Card" },
  { value: "International Passport", label: "International Passport" },
  { value: "Driver's Licence",         label: "Driver's Licence" },
  { value: "Voter's Card",            label: "Voter's Card" },
];

export default function PersonalKycSection() {
  const { application, patchKyc, patchPersonalInfo, patchDocuments, markSectionStatus, next } = useApplication();
  const [verification, setVerification] = useState<{ bvn?: string; nin?: string; liveness?: string }>({});
  const [verificationError, setVerificationError] = useState("");
  const [livenessBusy, setLivenessBusy] = useState(false);
  if (!application) return null;
  const currentApplication = application;

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

  async function verifyIdentity(type: "bvn" | "nin", value: string) {
    if (!/^\d{11}$/.test(value)) {
      setVerificationError(`${type.toUpperCase()} must be exactly 11 digits.`);
      return;
    }
    setVerificationError("");
    setVerification((current) => ({ ...current, [type]: "Checking with Prembly…" }));
    try {
      const names = currentApplication.personalInfo?.fullName?.trim().split(/\s+/) ?? [];
      const response = type === "bvn"
        ? await verifyMyBvn(value, names[0], names.slice(1).join(" "))
        : await verifyMyNin(value, names[0], names.slice(1).join(" "));
      const status = response.verificationStatus === "SUCCESS" ? "Verified" : response.error || "Verification failed";
      setVerification((current) => ({ ...current, [type]: status }));
      if (response.verificationStatus === "SUCCESS") {
        patchKyc({ [type === "bvn" ? "bvnVerified" : "ninVerified"]: true, verifiedDetails: response.verifiedDetails });
        const details = response.verifiedDetails ?? {};
        const value = (keys: string[]) => keys.map((key) => details[key]).find((item) => typeof item === "string" && item.trim()) as string | undefined;
        const autofill = Object.fromEntries(Object.entries({ fullName: value(["full_name", "fullName", "name"]), phone: value(["phone_number", "phone", "mobile"]), dateOfBirth: value(["date_of_birth", "dateOfBirth", "dob"]) }).filter(([, item]) => item));
        if (Object.keys(autofill).length) patchPersonalInfo(autofill);
      }
    } catch (error) {
      setVerification((current) => ({ ...current, [type]: "Verification failed" }));
      setVerificationError(error instanceof Error ? error.message : `Unable to verify ${type.toUpperCase()}`);
    }
  }

  async function verifyLiveness(file: File) {
    setLivenessBusy(true); setVerificationError("");
    try {
      const idType = currentApplication.kyc?.bvnVerified ? "BVN" : currentApplication.kyc?.ninVerified ? "NIN" : undefined;
      if (!idType) { setVerificationError("Verify your BVN or NIN before starting face verification."); return; }
      const response = await verifyMyLiveness(file, { idType, idNumber: idType === "BVN" ? currentApplication.kyc?.bvn : currentApplication.kyc?.nin, dateOfBirth: currentApplication.personalInfo?.dateOfBirth });
      patchKyc({ livenessVerified: response.verificationStatus === "SUCCESS", livenessStatus: response.verificationStatus });
      setVerification((current) => ({ ...current, liveness: response.verificationStatus === "SUCCESS" ? "Verified" : response.error || "Verification failed" }));
    } catch (error) { setVerificationError(error instanceof Error ? error.message : "Unable to complete liveness verification"); }
    finally { setLivenessBusy(false); }
  }

  const hasIdDoc = Boolean(application.documents?.identificationDocument);
  const hasProof = Boolean(application.documents?.proofOfAddress);

  function onSubmit(data: KycForm) {
    patchKyc(data);
    markSectionStatus("kyc", "completed");
    next();
  }

  const canContinue = isValid && hasIdDoc && hasProof && application.kyc.bvnVerified === true && application.kyc.ninVerified === true && application.kyc.livenessVerified === true;

  return (
    <SectionShell
      title="Identification & KYC"
      description="We use this information to verify your identity. Your details are encrypted and stored securely."
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
            helper="Dial *565*0# on your registered line to retrieve your BVN."
            error={errors.bvn?.message}
            {...register("bvn")}
            onChange={(e) => { register("bvn").onChange(e); sync("bvn", e.target.value); }}
          />
          <FormInput
            label="NIN"
            required
            inputMode="numeric"
            placeholder="11-digit NIN"
            helper="Found on your National Identity Card or via the NIMC app."
            error={errors.nin?.message}
            {...register("nin")}
            onChange={(e) => { register("nin").onChange(e); sync("nin", e.target.value); }}
          />
          <div className="-mt-3 sm:col-start-1">
            <button type="button" className="btn-secondary text-xs" onClick={() => void verifyIdentity("bvn", application.kyc?.bvn || "")}>Verify BVN instantly</button>
            {verification.bvn && <span className={`ml-2 text-xs ${verification.bvn === "Verified" ? "text-emerald-600" : "text-slate-500"}`}>{verification.bvn}</span>}
          </div>
          <div className="-mt-3 sm:col-start-2">
            <button type="button" className="btn-secondary text-xs" onClick={() => void verifyIdentity("nin", application.kyc?.nin || "")}>Verify NIN instantly</button>
            {verification.nin && <span className={`ml-2 text-xs ${verification.nin === "Verified" ? "text-emerald-600" : "text-slate-500"}`}>{verification.nin}</span>}
          </div>
        </div>
        {verificationError && <p className="text-sm text-red-600">{verificationError}</p>}

        <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
          <h3 className="mb-2 text-sm font-semibold text-emerald-800">Liveness verification <span className="text-red-500">*</span></h3>
          <p className="mb-3 text-xs text-emerald-700">Complete a quick in-app selfie scan using our identity verification widget (recommended &amp; primary method).</p>
          <div className="flex flex-wrap items-center gap-3">
            <PremblyKycWidgetButton
              fullName={currentApplication.personalInfo?.fullName}
              email={currentApplication.personalInfo?.email}
              phone={currentApplication.personalInfo?.phone}
              idType={currentApplication.kyc?.bvnVerified ? "BVN" : "NIN"}
              idNumber={currentApplication.kyc?.bvnVerified ? currentApplication.kyc?.bvn ?? "" : currentApplication.kyc?.nin ?? ""}
              onResult={(result) => {
                setVerification((current) => ({ ...current, liveness: result.message }));
                if (result.success) patchKyc({ livenessVerified: true, livenessStatus: "SUCCESS" });
              }}
            />
          </div>
          <div className="mt-4 border-t border-emerald-200/70 pt-3">
            <details className="group">
              <summary className="cursor-pointer text-xs font-medium text-slate-600 hover:text-slate-800">Having trouble with the camera? Click here to upload a selfie instead (fallback).</summary>
              <div className="mt-2">
                <label className="velo-label text-xs">
                  Upload live selfie
                  <input className="velo-input mt-1" type="file" accept="image/jpeg,image/png,image/webp" disabled={livenessBusy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void verifyLiveness(file); }} />
                </label>
              </div>
            </details>
          </div>
          {verification.liveness && <p className={`mt-3 text-xs font-semibold ${verification.liveness === "Verified" ? "text-emerald-600" : "text-red-600"}`}>{livenessBusy ? "Checking…" : verification.liveness}</p>}
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
