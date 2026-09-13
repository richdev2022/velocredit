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
import Icon from "../components/Icon";

type OtpPickerPhase = "idle" | "sending" | "success" | "error";
type OtpPickerState = { phase: OtpPickerPhase; channel?: "SMS" | "WHATSAPP"; message?: string };

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
  const [otpPickerState, setOtpPickerState] = useState<OtpPickerState>({ phase: "idle" });
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
    setValue,
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

  const details = (application.kyc?.verifiedDetails ?? {}) as Record<string, unknown>;
  const pickStr = (keys: string[]) => {
    for (const key of keys) {
      const v = details[key];
      if (typeof v === "string" && v.trim()) return v;
    }
    return undefined;
  };
  const photoRaw = (application.kyc?.identityPhotoUrl as string | undefined) || pickStr(["base64Image", "identityPhoto", "photo", "photograph"]);
  const governmentPortrait = typeof photoRaw === "string" && photoRaw.length > 20
    ? photoRaw.startsWith("data:") || photoRaw.startsWith("http")
      ? photoRaw
      : `data:image/jpeg;base64,${photoRaw.replace(/\s/g, "")}`
    : undefined;
  const selfieRaw = application.kyc?.selfieImageData as string | undefined;
  const liveSelfie = typeof selfieRaw === "string" && selfieRaw.length > 20 ? selfieRaw : undefined;
  const bvnLocked = application.kyc.bvnVerified === true;
  const ninLocked = application.kyc.ninVerified === true;
  const livenessLocked = application.kyc.livenessVerified === true;

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

  const { onChange: onBvnChange, ...bvnField } = register("bvn");
  const { onChange: onNinChange, ...ninField } = register("nin");

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
    setOtpPickerState({ phase: "idle" });
    setOtpMethodPickerFor(type.toUpperCase() as "BVN" | "NIN");
  }

  async function verifyIdentityWithChannel(type: "BVN" | "NIN", channel: "SMS" | "WHATSAPP") {
    const typeLower = type.toLowerCase() as "bvn" | "nin";
    const value = typeLower === "bvn" ? currentApplication.kyc?.bvn : currentApplication.kyc?.nin;
    if (!value) return;
    setOtpPickerState({ phase: "sending", channel });
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
        setOtpMethodPickerFor(null);
        setOtpPickerState({ phase: "idle" });
        return;
      }
      if (response.verificationStatus === "SUCCESS") {
        setOtpPickerState({ phase: "success", channel, message: "Phone on file already matches your account. No code required." });
        const status = "Verified";
        setVerification((current) => ({ ...current, [typeLower]: status }));
        patchKyc({ [typeLower === "bvn" ? "bvnVerified" : "ninVerified"]: true, verifiedDetails: response.verifiedDetails });
        const respDetails = response.verifiedDetails ?? {};
        const valueFn = (keys: string[]) => keys.map((key) => respDetails[key]).find((item) => typeof item === "string" && item.trim()) as string | undefined;
        const autofill = Object.fromEntries(Object.entries({ fullName: valueFn(["full_name", "fullName", "name"]), phone: valueFn(["phone_number", "phone", "mobile"]), dateOfBirth: valueFn(["date_of_birth", "dateOfBirth", "dob"]) }).filter(([, item]) => item));
        if (Object.keys(autofill).length) patchBusinessRep(autofill);
        window.setTimeout(() => { setOtpMethodPickerFor(null); setOtpPickerState({ phase: "idle" }); }, 1700);
      } else {
        const status = response.error || "Verification failed";
        setVerification((current) => ({ ...current, [typeLower]: status }));
        setOtpPickerState({ phase: "error", channel, message: status });
        setVerificationError(status);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Unable to verify ${type}`;
      setVerification((current) => ({ ...current, [typeLower]: "Verification failed" }));
      setOtpPickerState({ phase: "error", channel, message: msg });
      setVerificationError(msg);
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
      void confirmed;
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

  const hasIdDoc = Boolean(application.documents?.identificationDocument);
  const hasProof = Boolean(application.documents?.proofOfAddress);
  const hasSignature = Boolean(application.documents?.signature);
  const canContinue = isValid && hasIdDoc && hasProof && hasSignature && application.kyc.bvnVerified === true && application.kyc.ninVerified === true && application.kyc.livenessVerified === true;

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
      <div className="min-w-0 space-y-5">
        <div className="rounded-xl bg-velo-50 border border-velo-100 p-3 sm:p-4 flex items-start gap-3">
          <svg className="text-velo-600 shrink-0 mt-0.5" width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M12 2l9 4v6c0 5-3.5 8.5-9 10-5.5-1.5-9-5-9-10V6l9-4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
            <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <p className="text-xs text-velo-700 leading-relaxed">
            Your BVN and NIN are stored securely and used only for identity verification. They are never displayed in URLs, folder names, or your loan agreement.
          </p>
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-2">
          <FormInput
            label="BVN"
            required
            inputMode="numeric"
            placeholder="11-digit BVN"
            helper="Dial *565*0# on your registered line to retrieve your BVN."
            error={errors.bvn?.message}
            {...bvnField}
            onChange={(e) => { onBvnChange(e); sync("bvn", e.target.value); }}
          />
          <FormInput
            label="NIN"
            required
            inputMode="numeric"
            placeholder="11-digit NIN"
            helper="Found on your National Identity Card or via the NIMC app."
            error={errors.nin?.message}
            {...ninField}
            onChange={(e) => { onNinChange(e); sync("nin", e.target.value); }}
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

        <div className={`rounded-xl border p-4 ${livenessLocked ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-800/50 dark:bg-emerald-900/10" : "border-slate-200 bg-slate-50/60 dark:border-slate-700 dark:bg-slate-900/30"}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h3 className={`text-sm font-semibold ${livenessLocked ? "text-emerald-800 dark:text-emerald-300" : "text-slate-800 dark:text-slate-200"}`}>Liveness verification <span className="text-red-500">*</span></h3>
            {livenessLocked && (
              <span className="text-xs inline-flex items-center gap-1 text-emerald-700 bg-white dark:bg-slate-900/80 border border-emerald-200 dark:border-emerald-800 px-2 py-1 rounded-md font-bold shadow-sm dark:text-emerald-300">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Verified &amp; Locked
              </span>
            )}
          </div>
          <p className={`mb-3 text-xs ${livenessLocked ? "text-emerald-700 dark:text-emerald-300/80" : "text-slate-600 dark:text-slate-400"}`}>Complete a quick in-app selfie scan to prove you are the same person shown on your government ID records.</p>
          {!livenessLocked && (
            <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2.5 dark:border-amber-800/60 dark:bg-amber-900/15">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              <div className="min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">Live Scan Still Required</div>
                <p className="mt-0.5 text-xs leading-relaxed text-amber-800/90 dark:text-amber-200/80">The government-ID portrait shown below is a record photo only — it is <span className="font-bold">NOT proof of liveness</span>. You must still run a live selfie scan for us to match your face to the ID.</p>
              </div>
            </div>
          )}
          <div className="mb-4 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <div className={`inline-flex items-center gap-1 self-start px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-[0.12em] border ${livenessLocked ? "bg-slate-100 border-slate-200 text-slate-600 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300" : "bg-amber-100 border-amber-200 text-amber-700 dark:bg-amber-900/30 dark:border-amber-800/60 dark:text-amber-300"}`}>
                {livenessLocked ? <>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"/><path d="M8 12h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  Reference — Government ID portrait
                </> : <>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  ⚠ Government ID portrait (NOT a selfie scan)
                </>}
              </div>
              <div className={`relative aspect-[4/5] w-full rounded-xl overflow-hidden border-2 bg-white shadow-inner ${livenessLocked ? "border-slate-200 dark:border-slate-700" : "border-amber-200 dark:border-amber-800/60"}`}>
                {governmentPortrait ? (
                  <img src={governmentPortrait} alt="BVN/NIN government portrait retrieved from records" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-slate-400 dark:text-slate-500 bg-slate-50 dark:bg-slate-900/30">
                    <svg width="34" height="34" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.6"/><path d="M4 20c1.5-4 5-6 8-6s6.5 2 8 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
                    <div className="text-[10px] font-medium">Complete BVN / NIN first</div>
                  </div>
                )}
              </div>
              <div className="text-[10px] leading-relaxed text-slate-500 dark:text-slate-400 break-words">Portrait pulled from your verified {bvnLocked ? "BVN" : ninLocked ? "NIN" : "government ID"} records. Used as the matching reference for your live selfie.</div>
            </div>
            <div className="flex flex-col gap-2">
              <div className={`inline-flex items-center gap-1 self-start px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-[0.12em] border ${liveSelfie ? "bg-emerald-100 border-emerald-200 text-emerald-700 dark:bg-emerald-900/30 dark:border-emerald-800/60 dark:text-emerald-300" : "bg-slate-100 border-slate-200 text-slate-500 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400"}`}>
                {liveSelfie ? <>
                  <Icon name="check" size={14} /> Your Live Selfie — Liveness Verified
                </> : <>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2 3"/></svg>
                  Pending — Awaiting your live selfie
                </>}
              </div>
              {liveSelfie ? (
                <div className="relative aspect-[4/5] w-full rounded-xl overflow-hidden border-2 border-emerald-300 dark:border-emerald-700 bg-white shadow-inner shadow-emerald-500/10">
                  <img src={liveSelfie} alt="Live captured selfie from liveness widget scan" className="w-full h-full object-cover" />
                  <div className="absolute inset-0 pointer-events-none border-2 border-emerald-400/40 dark:border-emerald-500/40 rounded-xl" />
                </div>
              ) : (
                <div className="relative aspect-[4/5] w-full rounded-xl border-2 border-dashed border-slate-300 bg-slate-50/60 flex flex-col items-center justify-center gap-2 dark:border-slate-600 dark:bg-slate-900/30">
                  <div className="h-14 w-14 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-500 dark:text-slate-300">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.6"/></svg>
                  </div>
                  <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Your live selfie will appear here</div>
                  <div className="text-[10px] px-4 text-center leading-relaxed text-slate-400 dark:text-slate-500 break-words">Click the button below to start a short facial-recognition scan using your camera.</div>
                </div>
              )}
              <div className={`text-[10px] leading-relaxed break-words ${liveSelfie ? "text-emerald-700 dark:text-emerald-300/80" : "text-slate-500 dark:text-slate-400"}`}>{liveSelfie ? "Selfie captured and matched against the government portrait above. Liveness is now locked for your security." : "Captured automatically after you pass the liveness widget. Must match the government-ID portrait to pass."}</div>
            </div>
          </div>
          <div className="flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:items-center">
            {livenessLocked ? (
              <div className="inline-flex max-w-full items-center gap-2 break-words text-xs font-semibold text-emerald-800 dark:text-emerald-200 bg-white/80 dark:bg-slate-900/60 border border-emerald-200 dark:border-emerald-800 px-4 py-2 rounded-xl">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <rect x="4" y="10" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.8"/>
                  <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                  <circle cx="12" cy="15" r="1.8" fill="currentColor"/>
                </svg>
                Liveness check completed · cannot retrigger
              </div>
            ) : (
              <PremblyKycWidgetButton
                fullName={currentApplication.businessRep?.fullName}
                email={currentApplication.businessRep?.email}
                phone={currentApplication.businessRep?.phone}
                idType={currentApplication.kyc?.bvnVerified ? "BVN" : "NIN"}
                idNumber={currentApplication.kyc?.bvnVerified ? currentApplication.kyc?.bvn ?? "" : currentApplication.kyc?.nin ?? ""}
                verifiedDetails={currentApplication.kyc?.verifiedDetails ?? null}
                onResult={(result) => {
                  setVerification((current) => ({ ...current, liveness: result.success ? "Verified" : result.message }));
                  if (result.success) {
                    patchKyc({
                      livenessVerified: true,
                      livenessStatus: "SUCCESS",
                      ...(result.selfieImageData ? { selfieImageData: result.selfieImageData } : {}),
                    });
                  } else {
                    setVerificationError(result.message);
                  }
                }}
              />
            )}
            {!livenessLocked && verification.liveness === "Verified" && <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">✓ Liveness verified</span>}
          </div>
          {verification.liveness && <p className={`mt-2 text-xs font-semibold ${verification.liveness === "Verified" ? "text-emerald-600" : "text-red-600"}`}>{livenessBusy ? "Checking…" : verification.liveness}</p>}
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-2">
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

        <div className="grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-2">
          <FileUpload
            label="Identification Document"
            required
            document={application.documents?.identificationDocument}
            onFile={(doc) => handleFile("identificationDocument", doc)}
            onRemove={() => handleRemoveFile("identificationDocument")}
          />
          <div className="space-y-2">
          <FileUpload
            label="Proof of Address"
            required
            helper="Utility bill, bank statement, or similar (not older than 3 months)."
            document={application.documents?.proofOfAddress}
            onFile={(doc) => handleFile("proofOfAddress", doc)}
            onRemove={() => handleRemoveFile("proofOfAddress")}
          />
          <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 flex items-start gap-2 text-xs leading-5 font-medium text-amber-800 dark:text-amber-200">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
              <path d="M12 8v5M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>Proof of address can be utility bill, bank statement, house rent receipt that indicate the resident address and not older than 3 months.</span>
          </div>
          </div>
        </div>
        <FileUpload
          label="Signature"
          required
          helper="Upload a clear image or PDF of the representative's handwritten signature."
          document={application.documents?.signature}
          onFile={(doc) => handleFile("signature", doc)}
          onRemove={() => handleRemoveFile("signature")}
        />
      </div>

      {otpMethodPickerFor && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/45 backdrop-blur-sm px-2 sm:px-4 pb-0 sm:pb-0">
          <div className="w-full max-w-md overflow-hidden rounded-none sm:rounded-2xl bg-transparent sm:bg-transparent border-t-2 sm:border-2 border-white/0 sm:border-white/0 shadow-2xl animate-slide-in-up">
            <div className="bg-gradient-to-br from-velo-500 via-sky-500 to-sky-600 px-5 py-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/75">Ownership Check</div>
                <h3 className="mt-0.5 text-lg font-bold text-white break-words">Verify {otpMethodPickerFor} ownership</h3>
                <p className="mt-0.5 text-xs text-white/80 break-words">Send a one-time code to the phone number registered with your {otpMethodPickerFor}.</p>
              </div>
              <button
                type="button"
                disabled={otpPickerState.phase === "sending"}
                className="rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                onClick={() => { if (otpPickerState.phase !== "sending") setOtpMethodPickerFor(null); }}
                aria-label="Close"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>
              </button>
            </div>
            <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 border border-t-0 border-slate-200 sm:border rounded-b-none sm:rounded-b-2xl dark:border-slate-700">
              {otpPickerState.phase === "sending" ? (
                <div className="flex flex-col items-center justify-center py-4 text-center gap-3">
                  <div className={`inline-flex h-12 w-12 items-center justify-center rounded-full ${otpPickerState.channel === "WHATSAPP" ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400" : "bg-sky-100 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400"}`}>
                    <svg className="animate-spin" width="22" height="22" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
                      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                  </div>
                  <div>
                    <div className="text-sm font-bold text-slate-900 dark:text-white">Sending via {otpPickerState.channel || "secure channel"}…</div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">Please wait while we contact the identity provider.</div>
                  </div>
                  {otpPickerState.message && <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 italic">{otpPickerState.message}</div>}
                </div>
              ) : otpPickerState.phase === "success" ? (
                <div className="flex flex-col items-center justify-center py-4 text-center gap-3">
                  <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 animate-pulse">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                  <div>
                    <div className="text-sm font-bold text-slate-900 dark:text-white">Ownership confirmed automatically</div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{otpPickerState.message || "Phone on file already matches your account. No code required."}</div>
                  </div>
                </div>
              ) : otpPickerState.phase === "error" ? (
                <div className="space-y-4">
                  <div className="rounded-xl border border-red-200 bg-red-50 dark:border-red-800/60 dark:bg-red-900/15 px-4 py-3 flex items-start gap-3">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="mt-0.5 shrink-0 text-red-600 dark:text-red-400"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-red-800 dark:text-red-200">Verification didn't go through</div>
                      <div className="mt-0.5 text-xs leading-relaxed text-red-700/90 dark:text-red-300/80 break-words">{otpPickerState.message || "There was a temporary issue reaching the identity provider. Try a different channel or try again shortly."}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button type="button" className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-4 hover:border-velo-500 hover:bg-velo-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-velo-400 dark:hover:bg-velo-950/20 transition-colors group" onClick={() => void verifyIdentityWithChannel(otpMethodPickerFor, "SMS")}>
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 group-hover:bg-velo-500 group-hover:text-white"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg></div>
                      <div className="text-left flex-1 min-w-0"><div className="text-sm font-semibold text-velo-900 dark:text-white">Retry SMS</div><div className="text-[11px] text-slate-500 dark:text-slate-400 break-words">Text to identity phone</div></div>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 text-slate-300 group-hover:text-velo-500 dark:text-slate-600 dark:group-hover:text-velo-400"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                    <button type="button" className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-4 hover:border-emerald-500 hover:bg-emerald-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-emerald-400 dark:hover:bg-emerald-950/20 transition-colors group" onClick={() => void verifyIdentityWithChannel(otpMethodPickerFor, "WHATSAPP")}>
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 group-hover:bg-emerald-500 group-hover:text-white"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M20 12a8 8 0 11-3.2-6.4L20 4l-1.6 3.2A7.9 7.9 0 0120 12zM8.3 15.4c-.2-.5-1-1-1.5-1.1l-.5-.2c-.6-.2-1.3.2-1.3.9 0 1.4 1.8 2.8 4.1 2.8 2 0 3.6-.8 4.6-2.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
                      <div className="text-left flex-1 min-w-0"><div className="text-sm font-semibold text-velo-900 dark:text-white">Retry WhatsApp</div><div className="text-[11px] text-slate-500 dark:text-slate-400 break-words">Message on WhatsApp</div></div>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 text-slate-300 group-hover:text-emerald-500 dark:text-slate-600 dark:group-hover:text-emerald-400"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button type="button" className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-4 hover:border-velo-500 hover:bg-velo-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-velo-400 dark:hover:bg-velo-950/20 transition-colors group" onClick={() => void verifyIdentityWithChannel(otpMethodPickerFor, "SMS")}>
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-sky-400 to-velo-500 text-white shadow-sm shadow-velo-500/20"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg></div>
                    <div className="text-left flex-1 min-w-0"><div className="text-sm font-semibold text-velo-900 dark:text-white">SMS</div><div className="text-[11px] text-slate-500 dark:text-slate-400 break-words">Text to identity phone</div></div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 text-slate-300 group-hover:text-velo-500 dark:text-slate-600 dark:group-hover:text-velo-400"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                  <button type="button" className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-4 hover:border-emerald-500 hover:bg-emerald-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-emerald-400 dark:hover:bg-emerald-950/20 transition-colors group" onClick={() => void verifyIdentityWithChannel(otpMethodPickerFor, "WHATSAPP")}>
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-sm shadow-emerald-500/20"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M20 12a8 8 0 11-3.2-6.4L20 4l-1.6 3.2A7.9 7.9 0 0120 12zM8.3 15.4c-.2-.5-1-1-1.5-1.1l-.5-.2c-.6-.2-1.3.2-1.3.9 0 1.4 1.8 2.8 4.1 2.8 2 0 3.6-.8 4.6-2.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
                    <div className="text-left flex-1 min-w-0"><div className="text-sm font-semibold text-velo-900 dark:text-white">WhatsApp</div><div className="text-[11px] text-slate-500 dark:text-slate-400 break-words">Message on WhatsApp</div></div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 text-slate-300 group-hover:text-emerald-500 dark:text-slate-600 dark:group-hover:text-emerald-400"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeOtpChallenge && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/50 backdrop-blur-sm px-2 sm:px-4 pb-0 sm:pb-0 animate-fade-in">
          <div className="w-full max-w-md overflow-hidden rounded-none sm:rounded-2xl shadow-2xl animate-slide-in-up max-h-[92vh]">
            <div className="bg-gradient-to-br from-velo-500 via-sky-500 to-sky-600 px-5 py-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/75">One-Time Verification</div>
                <h3 className="mt-0.5 text-lg font-bold text-white break-words">Enter verification code</h3>
                <p className="mt-0.5 text-xs text-white/85 break-words">
                  We sent a 6-digit code via {activeOtpChallenge.challenge.channel} to the {activeOtpChallenge.idType} phone ending in ···{activeOtpChallenge.challenge.phoneLastFour}.
                </p>
              </div>
              <button type="button" className="rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white shrink-0" onClick={() => setActiveOtpChallenge(null)} aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>
              </button>
            </div>
            <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 border border-t-0 border-slate-200 sm:border rounded-b-none sm:rounded-b-2xl dark:border-slate-700 space-y-5">
              {activeOtpChallenge.error && (
                <div className="rounded-lg border border-red-100 bg-red-50 dark:bg-red-900/20 dark:border-red-900/40 p-3 text-sm text-red-700 dark:text-red-400">{activeOtpChallenge.error}</div>
              )}
              <div className="space-y-2">
                <label className="velo-label block">
                  <span className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">One-time code (6 digits)</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    autoFocus
                    placeholder="• • • • • •"
                    value={activeOtpChallenge.otpCode}
                    onChange={(e) => {
                      const code = e.target.value.replace(/\D/g, "");
                      setActiveOtpChallenge((current) => current ? { ...current, otpCode: code, error: undefined } : current);
                    }}
                    className="velo-input mt-2 tracking-[0.6em] text-center font-bold text-2xl"
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="flex-1 min-w-[120px] rounded-xl border border-sky-200 bg-white px-3 py-2.5 text-sm font-semibold text-sky-800 hover:bg-sky-50 disabled:opacity-60 disabled:cursor-not-allowed dark:border-sky-800 dark:bg-slate-900 dark:text-sky-300 dark:hover:bg-sky-950/30" disabled={activeOtpChallenge.cooldown > 0 || !!activeOtpChallenge.busy} onClick={() => void resendActiveKycOtp("SMS")}>{activeOtpChallenge.cooldown > 0 ? `Resend SMS (${activeOtpChallenge.cooldown}s)` : "Resend via SMS"}</button>
                <button type="button" className="flex-1 min-w-[120px] rounded-xl border border-emerald-200 bg-white px-3 py-2.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-60 disabled:cursor-not-allowed dark:border-emerald-800 dark:bg-slate-900 dark:text-emerald-300 dark:hover:bg-emerald-950/30" disabled={activeOtpChallenge.cooldown > 0 || !!activeOtpChallenge.busy} onClick={() => void resendActiveKycOtp("WHATSAPP")}>{activeOtpChallenge.cooldown > 0 ? `Resend WA (${activeOtpChallenge.cooldown}s)` : "Resend via WhatsApp"}</button>
              </div>
              <button type="button" className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-50 min-h-[48px] text-base font-bold" disabled={activeOtpChallenge.otpCode.length !== 6 || !!activeOtpChallenge.busy} onClick={() => void submitActiveKycOtp()}>{activeOtpChallenge.busy ? "Verifying…" : "Confirm ownership"}</button>
            </div>
          </div>
        </div>
      )}
    </SectionShell>
  );
}
