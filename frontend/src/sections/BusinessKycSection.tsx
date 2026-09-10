// ============================================================================
// src/sections/BusinessKycSection.tsx
// Section 3 for Business Loan applicants — Representative's BVN/NIN + ID + proof.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import FormInput from "../components/FormInput";
import SelectInput from "../components/SelectInput";
import FileUpload from "../components/FileUpload";
import SectionShell from "../components/SectionShell";
import { useApplication } from "../context/ApplicationContext";
import { kycSchema, type KycForm } from "../utils/validation";
import type { UploadedDocument, DocumentSlot } from "../types/documents";
import { verifyMyBvn, verifyMyNin, confirmKycOwnershipOtp, resendKycOwnershipOtp, type KycOtpChallenge } from "../services/apiClient";
import PremblyKycWidgetButton from "../components/PremblyKycWidgetButton";

const ID_TYPES = [
  { value: "National ID Card",       label: "National ID Card" },
  { value: "International Passport", label: "International Passport" },
  { value: "Driver's Licence",         label: "Driver's Licence" },
  { value: "Voter's Card",            label: "Voter's Card" },
];

export default function BusinessKycSection() {
  const { application, patchKyc, patchBusinessRep, patchDocuments, markSectionStatus, next } = useApplication();
  const [verification, setVerification] = useState<{ bvn?: string; nin?: string; liveness?: string }>({});
  const [verificationError, setVerificationError] = useState("");
  const [livenessBusy, setLivenessBusy] = useState(false);
  const [otpMethodPickerFor, setOtpMethodPickerFor] = useState(null as "BVN" | "NIN" | null);
  const [activeOtpChallenge, setActiveOtpChallenge] = useState(null as null | {
    idType: "BVN" | "NIN";
    challenge: KycOtpChallenge;
    otpCode: string;
    cooldown: number;
    error?: string;
    busy?: boolean;
  });
  const countdownRef = useRef(null as number | null);
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

  useEffect(() => {
    if (!activeOtpChallenge) return;
    if (countdownRef.current) window.clearInterval(countdownRef.current);
    countdownRef.current = window.setInterval(() => {
      setActiveOtpChallenge((current) => {
        if (!current) return current;
        if (current.cooldown <= 1) {
          if (countdownRef.current) window.clearInterval(countdownRef.current);
          return { ...current, cooldown: 0 };
        }
        return { ...current, cooldown: current.cooldown - 1 };
      });
    }, 1000);
    return () => {
      if (countdownRef.current) window.clearInterval(countdownRef.current);
    };
  }, [activeOtpChallenge?.challenge?.challengeId]);

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
    setOtpMethodPickerFor(type.toUpperCase() as "BVN" | "NIN");
  }

  async function verifyIdentityWithChannel(type: "BVN" | "NIN", channel: "SMS" | "WHATSAPP") {
    const typeLower = type.toLowerCase() as "bvn" | "nin";
    const value = typeLower === "bvn" ? currentApplication.kyc?.bvn : currentApplication.kyc?.nin;
    if (!value) return;
    setOtpMethodPickerFor(null);
    setVerification((current) => ({ ...current, [typeLower]: "Verifying…" }));
    setActiveOtpChallenge(null);
    try {
      const names = currentApplication.businessRep?.fullName?.trim().split(/\s+/) ?? [];
      const response = type === "BVN"
        ? await verifyMyBvn(value, names[0], names.slice(1).join(" "), undefined, channel)
        : await verifyMyNin(value, names[0], names.slice(1).join(" "), undefined, channel);
      const challenge = (response as any)?.otpChallenge as KycOtpChallenge | undefined;
      if (challenge && challenge.requiresPhoneVerification) {
        setActiveOtpChallenge({ idType: type, challenge, otpCode: "", cooldown: challenge.resendSecondsRemaining });
        setVerification((current) => ({ ...current, [typeLower]: "OTP required" }));
        setVerificationError(`A verification code was sent to the phone number from ${type} records ending in ···${challenge.phoneLastFour}. Enter the code to confirm ownership.`);
        return;
      }
      const status = response.verificationStatus === "SUCCESS" ? "Verified" : response.error || "Verification failed";
      setVerification((current) => ({ ...current, [typeLower]: status }));
      if (response.verificationStatus === "SUCCESS") {
        patchKyc({ [typeLower === "bvn" ? "bvnVerified" : "ninVerified"]: true, verifiedDetails: response.verifiedDetails });
        const details = response.verifiedDetails ?? {};
        const valueFn = (keys: string[]) => keys.map((key) => details[key]).find((item) => typeof item === "string" && item.trim()) as string | undefined;
        const autofill = Object.fromEntries(Object.entries({ fullName: valueFn(["full_name", "fullName", "name"]), phone: valueFn(["phone_number", "phone", "mobile"]), dateOfBirth: valueFn(["date_of_birth", "dateOfBirth", "dob"]) }).filter(([, item]) => item));
        if (Object.keys(autofill).length) patchBusinessRep(autofill);
      }
    } catch (error) {
      setVerification((current) => ({ ...current, [typeLower]: "Verification failed" }));
      setVerificationError(error instanceof Error ? error.message : `Unable to verify ${type}`);
    }
  }

  async function submitActiveKycOtp() {
    if (!activeOtpChallenge || activeOtpChallenge.otpCode.length !== 6) return;
    setActiveOtpChallenge((current) => current ? { ...current, busy: true, error: undefined } : current);
    try {
      const confirmed = await confirmKycOwnershipOtp({ idType: activeOtpChallenge.idType, challengeId: activeOtpChallenge.challenge.challengeId, code: activeOtpChallenge.otpCode });
      const typeLower = activeOtpChallenge.idType.toLowerCase() as "bvn" | "nin";
      setVerification((current) => ({ ...current, [typeLower]: "Verified" }));
      patchKyc({ [typeLower === "bvn" ? "bvnVerified" : "ninVerified"]: true });
      setVerificationError("");
      setActiveOtpChallenge(null);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Unable to verify code";
      setActiveOtpChallenge((current) => current ? { ...current, busy: false, error: reason, otpCode: "" } : current);
      setVerificationError(reason);
    }
  }

  async function resendActiveKycOtp(newChannel?: "SMS" | "WHATSAPP") {
    if (!activeOtpChallenge) return;
    try {
      const res = await resendKycOwnershipOtp({ idType: activeOtpChallenge.idType, challengeId: activeOtpChallenge.challenge.challengeId, channel: newChannel });
      setActiveOtpChallenge((current) => current ? {
        ...current,
        challenge: { ...current.challenge, challengeId: res.challengeId, expiresAt: res.expiresAt, channel: res.channel, resendAvailableAt: res.resendAvailableAt, resendSecondsRemaining: res.resendSecondsRemaining },
        otpCode: "",
        cooldown: res.resendSecondsRemaining,
        error: undefined,
      } : current);
    } catch (err) {
      setActiveOtpChallenge((current) => current ? { ...current, error: err instanceof Error ? err.message : "Unable to resend code" } : current);
    }
  }

  // async function verifyLiveness(file: File) { /* commented out — widget-only flow required */
  //   setLivenessBusy(true); setVerificationError("");
  //   try {
  //     const idType = currentApplication.kyc?.bvnVerified ? "BVN" : currentApplication.kyc?.ninVerified ? "NIN" : undefined;
  //     if (!idType) { setVerificationError("Verify your BVN or NIN before starting face verification."); return; }
  //     const response = await verifyMyLiveness(file, { idType, idNumber: idType === "BVN" ? currentApplication.kyc?.bvn : currentApplication.kyc?.nin, dateOfBirth: currentApplication.businessRep?.dateOfBirth });
  //     patchKyc({ livenessVerified: response.verificationStatus === "SUCCESS", livenessStatus: response.verificationStatus });
  //     setVerification((current) => ({ ...current, liveness: response.verificationStatus === "SUCCESS" ? "Verified" : response.error || "Verification failed" }));
  //   } catch (error) { setVerificationError(error instanceof Error ? error.message : "Unable to complete liveness verification"); }
  //   finally { setLivenessBusy(false); }
  // }

  const hasIdDoc = Boolean(application.documents?.identificationDocument);
  const hasProof = Boolean(application.documents?.proofOfAddress);
  const canContinue = isValid && hasIdDoc && hasProof && application.kyc.bvnVerified === true && application.kyc.ninVerified === true && application.kyc.livenessVerified === true;

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

        <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:border-emerald-800/50 dark:bg-emerald-900/10 p-4">
          <div>
            <label className="velo-label">Liveness verification <span className="text-red-500">*</span></label>
            <p className="mt-1 text-xs text-emerald-800 dark:text-emerald-300">Click the camera widget below to scan your face. This verifies you are the rightful owner of the BVN/NIN provided.</p>
          </div>
          <div className="mt-3">
            <PremblyKycWidgetButton
              fullName={currentApplication.businessRep?.fullName}
              email={currentApplication.businessRep?.email}
              phone={currentApplication.businessRep?.phone}
              idType={currentApplication.kyc?.bvnVerified ? "BVN" : "NIN"}
              idNumber={currentApplication.kyc?.bvnVerified ? currentApplication.kyc?.bvn ?? "" : currentApplication.kyc?.nin ?? ""}
              onResult={(result) => {
                setVerification((current) => ({ ...current, liveness: result.success ? "Verified" : result.message }));
                if (result.success) patchKyc({ livenessVerified: true, livenessStatus: "SUCCESS" });
                else setVerificationError(result.message);
              }}
            />
          </div>
          {verification.liveness && <p className={`mt-2 text-xs font-semibold ${verification.liveness === "Verified" ? "text-emerald-600" : "text-red-600"}`}>{livenessBusy ? "Checking…" : verification.liveness}</p>}
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

      {otpMethodPickerFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-fade-in">
          <div className="velo-card rounded-2xl w-full max-w-md p-5 sm:p-6 animate-slide-in-left">
            <h3 className="font-bold text-velo-900 dark:text-white text-lg">Verify {otpMethodPickerFor} ownership</h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Choose how you want to receive the 6-digit verification code. The code will be sent to the phone number associated with your {otpMethodPickerFor} records.
            </p>
            <div className="mt-5 grid gap-3">
              <button type="button" onClick={() => void verifyIdentityWithChannel(otpMethodPickerFor, "SMS")} className="flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 p-4 hover:bg-velo-50 dark:hover:bg-slate-800/60 transition text-left">
                <div className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-xl">💬</div>
                <div>
                  <div className="font-bold text-velo-900 dark:text-white">Send via SMS</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Text message to the {otpMethodPickerFor} phone number</div>
                </div>
              </button>
              <button type="button" onClick={() => void verifyIdentityWithChannel(otpMethodPickerFor, "WHATSAPP")} className="flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 p-4 hover:bg-velo-50 dark:hover:bg-slate-800/60 transition text-left">
                <div className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 text-xl">💚</div>
                <div>
                  <div className="font-bold text-velo-900 dark:text-white">Send via WhatsApp</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">WhatsApp message to the {otpMethodPickerFor} phone number</div>
                </div>
              </button>
            </div>
            <div className="mt-5 text-right">
              <button type="button" onClick={() => setOtpMethodPickerFor(null)} className="btn-secondary text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {activeOtpChallenge && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-fade-in">
          <div className="velo-card rounded-2xl w-full max-w-md p-5 sm:p-6 animate-slide-in-left">
            <h3 className="font-bold text-velo-900 dark:text-white text-lg">Enter verification code</h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              We sent a 6-digit code via {activeOtpChallenge.challenge.channel} to the {activeOtpChallenge.idType} phone number ending in ···{activeOtpChallenge.challenge.phoneLastFour}.
            </p>
            {activeOtpChallenge.error && (
              <div className="mt-3 rounded-lg border border-red-100 bg-red-50 dark:bg-red-900/20 dark:border-red-900/40 p-3 text-sm text-red-700 dark:text-red-400">{activeOtpChallenge.error}</div>
            )}
            <div className="mt-5">
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={activeOtpChallenge.otpCode}
                onChange={(e) => {
                  const code = e.target.value.replace(/\D/g, "");
                  setActiveOtpChallenge((current) => current ? { ...current, otpCode: code } : current);
                }}
                className="w-full velo-input text-center text-2xl font-black tracking-[0.5em] py-4"
              />
              <div className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">
                {activeOtpChallenge.cooldown > 0
                  ? `Resend available in ${activeOtpChallenge.cooldown}s`
                  : (
                    <span>
                      Didn't get the code?&nbsp;
                      <button type="button" onClick={() => void resendActiveKycOtp("SMS")} className="font-semibold text-velo-600 underline underline-offset-2">Resend SMS</button>
                      &nbsp;·&nbsp;
                      <button type="button" onClick={() => void resendActiveKycOtp("WHATSAPP")} className="font-semibold text-emerald-600 underline underline-offset-2">Resend WhatsApp</button>
                    </span>
                  )}
              </div>
            </div>
            <div className="mt-5 flex gap-3 justify-end">
              <button type="button" onClick={() => setActiveOtpChallenge(null)} className="btn-secondary text-sm">Cancel</button>
              <button type="button" onClick={() => void submitActiveKycOtp()} disabled={activeOtpChallenge.otpCode.length !== 6 || !!activeOtpChallenge.busy} className="btn-primary text-sm">
                {activeOtpChallenge.busy ? "Verifying…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </SectionShell>
  );
}
