// ============================================================================
// src/sections/PersonalKycSection.tsx
// Section 2 for Personal Loan applicants — BVN, NIN, ID document, proof of address.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import FormInput from "../components/FormInput";
import SelectInput from "../components/SelectInput";
import FileUpload from "../components/FileUpload";
import SectionShell from "../components/SectionShell";
import { useApplication } from "../context/ApplicationContext";
import { kycSchema, type KycForm } from "../utils/validation";
import type { UploadedDocument, DocumentSlot } from "../types/documents";
import {
  verifyMyBvn,
  verifyMyNin,
  verifyMyLiveness,
  confirmKycOwnershipOtp,
  resendKycOwnershipOtp,
  type KycOtpChallenge,
} from "../services/apiClient";
import PremblyKycWidgetButton from "../components/PremblyKycWidgetButton";

const ID_TYPES = [
  { value: "National ID Card",       label: "National ID Card" },
  { value: "International Passport", label: "International Passport" },
  { value: "Driver's Licence",         label: "Driver's Licence" },
  { value: "Voter's Card",            label: "Voter's Card" },
];

function maskIdNumber(value: string): string {
  if (!value || value.length < 4) return value;
  const lastFour = value.slice(-4);
  const stars = "*".repeat(Math.max(0, value.length - 4));
  return stars + lastFour;
}

function pickStr(details: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = details[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function normalizePhotoData(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length < 20) return undefined;
  if (raw.startsWith("data:")) return raw;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  return `data:image/jpeg;base64,${raw.replace(/\s/g, "")}`;
}

export default function PersonalKycSection() {
  const { application, patchKyc, patchPersonalInfo, patchDocuments, markSectionStatus, next } = useApplication();
  const [verification, setVerification] = useState<{ bvn?: string; nin?: string; liveness?: string }>({});
  const [verificationError, setVerificationError] = useState("");
  const [livenessBusy, setLivenessBusy] = useState(false);
  const [otpMethodPickerFor, setOtpMethodPickerFor] = useState<null | "BVN" | "NIN">(null);
  const [activeOtpChallenge, setActiveOtpChallenge] = useState<null | {
    idType: "BVN" | "NIN";
    challenge: KycOtpChallenge;
    otpCode: string;
    cooldown: number;
    error?: string;
    busy?: boolean;
  }>(null);
  const countdownRef = useRef<number | null>(null);
  if (!application) return null;
  const currentApplication = application;
  const bvnDisplay = application.kyc?.bvnVerified ? maskIdNumber(application.kyc?.bvn || "") : application.kyc?.bvn || "";
  const ninDisplay = application.kyc?.ninVerified ? maskIdNumber(application.kyc?.nin || "") : application.kyc?.nin || "";
  const bvnLocked = application.kyc?.bvnVerified === true;
  const ninLocked = application.kyc?.ninVerified === true;
  const livenessLocked = application.kyc?.livenessVerified === true;

  const identityInfo = useMemo(() => {
    const details = (application.kyc?.verifiedDetails ?? {}) as Record<string, unknown>;
    const personal = application.personalInfo ?? {};
    const fullName = pickStr(details, ["full_name", "fullName", "name"]) ?? personal.fullName ?? "";
    const phone = pickStr(details, ["phone_number", "phoneNumber", "phone", "mobile", "telephoneno"]) ?? personal.phone ?? "";
    const dateOfBirth = pickStr(details, ["date_of_birth", "dateOfBirth", "birthdate", "dob"]) ?? personal.dateOfBirth ?? "";
    const address = pickStr(details, ["address", "residence_address", "residentialAddress"]) ?? personal.residentialAddress ?? "";
    const state = pickStr(details, ["state"]) ?? personal.state ?? "";
    const lga = pickStr(details, ["lga", "local_government", "localGovernmentArea"]) ?? personal.lga ?? "";
    const gender = pickStr(details, ["gender", "sex"]);
    const nationality = pickStr(details, ["nationality"]);
    const photoRaw = pickStr(details, ["identityPhoto", "photo", "photograph", "image", "face_image", "selfie"]);
    const identityPhoto = normalizePhotoData(photoRaw) ?? normalizePhotoData(application.kyc?.identityPhotoUrl) ?? normalizePhotoData(application.kyc?.selfieImageData);
    return { fullName, phone, dateOfBirth, address, state, lga, gender, nationality, identityPhoto, anyPopulated: !!(fullName || phone || dateOfBirth || address || state || lga) };
  }, [application.kyc?.verifiedDetails, application.kyc?.identityPhotoUrl, application.kyc?.selfieImageData, application.personalInfo]);

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

  useEffect(() => {
    if (application.kyc?.bvn) setValue("bvn", application.kyc.bvn, { shouldValidate: true, shouldDirty: true });
    if (application.kyc?.nin) setValue("nin", application.kyc.nin, { shouldValidate: true, shouldDirty: true });
  }, [application.kyc?.bvn, application.kyc?.nin, setValue]);

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
    const value = type === "BVN" ? currentApplication.kyc?.bvn || "" : currentApplication.kyc?.nin || "";
    setOtpMethodPickerFor(null);
    const lowerType = type.toLowerCase() as "bvn" | "nin";
    setVerification((current) => ({ ...current, [lowerType]: "Verifying…" }));
    setActiveOtpChallenge(null);
    try {
      const names = currentApplication.personalInfo?.fullName?.trim().split(/\s+/) ?? [];
      const response = type === "BVN"
        ? await verifyMyBvn(value, names[0], names.slice(1).join(" "), undefined, channel)
        : await verifyMyNin(value, names[0], names.slice(1).join(" "), undefined, channel);
      const challenge = (response as any)?.otpChallenge as KycOtpChallenge | undefined;
      if (challenge && challenge.requiresPhoneVerification) {
        setActiveOtpChallenge({ idType: type, challenge, otpCode: "", cooldown: challenge.resendSecondsRemaining });
        setVerificationError(`A verification code was sent to the phone number on ${type} records ending in ···${challenge.phoneLastFour}. Enter the code to confirm ownership.`);
        setVerification((current) => ({ ...current, [lowerType]: "OTP required" }));
        return;
      }
      const status = response.verificationStatus === "SUCCESS" ? "Verified" : response.error || "Verification failed";
      setVerification((current) => ({ ...current, [lowerType]: status }));
      if (response.verificationStatus === "SUCCESS") {
        const details = response.verifiedDetails ?? {};
        const photoUrl = normalizePhotoData(pickStr(details, ["identityPhoto", "photo", "photograph", "image", "face_image", "selfie"]));
        patchKyc({ [lowerType === "bvn" ? "bvnVerified" : "ninVerified"]: true, verifiedDetails: details, ...(photoUrl ? { identityPhotoUrl: photoUrl } : {}) });
        const pick = (keys: string[]) => keys.map((key) => details[key]).find((item) => typeof item === "string" && item.trim()) as string | undefined;
        const autofill = Object.fromEntries(Object.entries({ fullName: pick(["full_name", "fullName", "name"]), phone: pick(["phone_number", "phone", "mobile"]), dateOfBirth: pick(["date_of_birth", "dateOfBirth", "dob"]) }).filter(([, item]) => item));
        if (Object.keys(autofill).length) patchPersonalInfo(autofill);
        if (lowerType === "bvn") {
          setValue("bvn", maskIdNumber(value), { shouldValidate: true });
        } else {
          setValue("nin", maskIdNumber(value), { shouldValidate: true });
        }
      }
    } catch (error) {
      setVerification((current) => ({ ...current, [lowerType]: "Verification failed" }));
      setVerificationError(error instanceof Error ? error.message : `Unable to verify ${type}`);
    }
  }

  async function submitActiveKycOtp() {
    if (!activeOtpChallenge || activeOtpChallenge.otpCode.length !== 6) return;
    setActiveOtpChallenge((current) => current ? { ...current, busy: true, error: undefined } : current);
    try {
      const confirmed = await confirmKycOwnershipOtp({ idType: activeOtpChallenge.idType, challengeId: activeOtpChallenge.challenge.challengeId, code: activeOtpChallenge.otpCode });
      const lowerType = activeOtpChallenge.idType.toLowerCase() as "bvn" | "nin";
      const value = lowerType === "bvn" ? currentApplication.kyc?.bvn : currentApplication.kyc?.nin;
      patchKyc({ [lowerType === "bvn" ? "bvnVerified" : "ninVerified"]: true, checklist: confirmed.checklist as any });
      setVerification((current) => ({ ...current, [lowerType]: "Verified" }));
      setVerificationError("");
      setActiveOtpChallenge(null);
      if (value) {
        if (lowerType === "bvn") setValue("bvn", maskIdNumber(value), { shouldValidate: true });
        else setValue("nin", maskIdNumber(value), { shouldValidate: true });
      }
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

  async function verifyLiveness(file: File) {
    setLivenessBusy(true); setVerificationError("");
    try {
      const idType = currentApplication.kyc?.bvnVerified ? "BVN" : currentApplication.kyc?.ninVerified ? "NIN" : undefined;
      if (!idType) { setVerificationError("Verify your BVN or NIN before starting face verification."); return; }
      const response = await verifyMyLiveness(file, { idType, idNumber: idType === "BVN" ? currentApplication.kyc?.bvn : currentApplication.kyc?.nin, dateOfBirth: currentApplication.personalInfo?.dateOfBirth });
      const success = response.verificationStatus === "SUCCESS";
      const selfieData = success ? (response as any).selfieImageData : undefined;
      patchKyc({ livenessVerified: success, livenessStatus: response.verificationStatus, ...(selfieData ? { selfieImageData: selfieData } : {}) });
      setVerification((current) => ({ ...current, liveness: success ? "Verified" : response.error || "Verification failed" }));
    } catch (error) { setVerificationError(error instanceof Error ? error.message : "Unable to complete liveness verification"); }
    finally { setLivenessBusy(false); }
  }

  const hasIdDoc = Boolean(application.documents?.identificationDocument);
  const hasProof = Boolean(application.documents?.proofOfAddress);
  const bestSelfieImage = application.kyc?.selfieImageData || identityInfo.identityPhoto;

  function onSubmit(data: KycForm) {
    const patchPayload: Partial<KycForm> = { ...data };
    if (bvnLocked) patchPayload.bvn = currentApplication.kyc?.bvn || "";
    if (ninLocked) patchPayload.nin = currentApplication.kyc?.nin || "";
    patchKyc(patchPayload as any);
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
          {bvnLocked ? (
            <div>
              <label className="velo-label">BVN <span className="text-red-500">*</span></label>
              <div className="velo-input flex items-center justify-between cursor-not-allowed bg-slate-50/80 text-slate-700">
                <div className="flex items-center gap-2">
                  <span className="font-bold tracking-wider font-mono text-slate-900">{bvnDisplay}</span>
                  <span className="text-[10px] uppercase font-semibold text-emerald-700 bg-emerald-100/70 border border-emerald-200 px-1.5 py-0.5 rounded">Verified</span>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400">
                  <rect x="4" y="11" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.8"/>
                  <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                </svg>
              </div>
              <p className="velo-helper mt-1 text-slate-500">BVN verified and locked for your security.</p>
            </div>
          ) : (
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
          )}
          {ninLocked ? (
            <div>
              <label className="velo-label">NIN <span className="text-red-500">*</span></label>
              <div className="velo-input flex items-center justify-between cursor-not-allowed bg-slate-50/80 text-slate-700">
                <div className="flex items-center gap-2">
                  <span className="font-bold tracking-wider font-mono text-slate-900">{ninDisplay}</span>
                  <span className="text-[10px] uppercase font-semibold text-emerald-700 bg-emerald-100/70 border border-emerald-200 px-1.5 py-0.5 rounded">Verified</span>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400">
                  <rect x="4" y="11" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.8"/>
                  <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                </svg>
              </div>
              <p className="velo-helper mt-1 text-slate-500">NIN verified and locked for your security.</p>
            </div>
          ) : (
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
          )}
          <div className="-mt-3 sm:col-start-1">
            {bvnLocked ? (
              <span className="ml-2 text-xs inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-md font-semibold">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                BVN Verified
              </span>
            ) : (
              <>
                <button type="button" className="btn-secondary text-xs" onClick={() => void verifyIdentity("bvn", application.kyc?.bvn || "")}>Verify BVN instantly</button>
                {verification.bvn && <span className={`ml-2 text-xs ${verification.bvn === "Verified" ? "text-emerald-600" : "text-slate-500"}`}>{verification.bvn}</span>}
              </>
            )}
          </div>
          <div className="-mt-3 sm:col-start-2">
            {ninLocked ? (
              <span className="ml-2 text-xs inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-md font-semibold">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                NIN Verified
              </span>
            ) : (
              <>
                <button type="button" className="btn-secondary text-xs" onClick={() => void verifyIdentity("nin", application.kyc?.nin || "")}>Verify NIN instantly</button>
                {verification.nin && <span className={`ml-2 text-xs ${verification.nin === "Verified" ? "text-emerald-600" : "text-slate-500"}`}>{verification.nin}</span>}
              </>
            )}
          </div>
        </div>

        {identityInfo.anyPopulated && (bvnLocked || ninLocked) && (
          <div className="rounded-xl border border-sky-200 bg-sky-50/70 p-4 sm:p-5">
            <div className="flex items-center gap-2 mb-3">
              <svg className="text-sky-700" width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 12c2.7 0 5-2.3 5-5S14.7 2 12 2 7 4.3 7 7s2.3 5 5 5z" stroke="currentColor" strokeWidth="1.8"/>
                <path d="M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
              <h3 className="text-sm font-bold text-sky-900">Identity Information <span className="text-xs text-sky-700 font-medium">(Retrieved from records · Locked)</span></h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
              {identityInfo.fullName && (
                <div>
                  <label className="text-[11px] uppercase tracking-wide text-sky-700 font-semibold">Full Name</label>
                  <div className="mt-0.5 text-sm text-slate-800 bg-white/70 border border-sky-100 rounded-lg px-3 py-2">{identityInfo.fullName}</div>
                </div>
              )}
              {identityInfo.phone && (
                <div>
                  <label className="text-[11px] uppercase tracking-wide text-sky-700 font-semibold">Phone Number</label>
                  <div className="mt-0.5 text-sm text-slate-800 bg-white/70 border border-sky-100 rounded-lg px-3 py-2">{identityInfo.phone}</div>
                </div>
              )}
              {identityInfo.dateOfBirth && (
                <div>
                  <label className="text-[11px] uppercase tracking-wide text-sky-700 font-semibold">Date of Birth</label>
                  <div className="mt-0.5 text-sm text-slate-800 bg-white/70 border border-sky-100 rounded-lg px-3 py-2">{identityInfo.dateOfBirth}</div>
                </div>
              )}
              {identityInfo.gender && (
                <div>
                  <label className="text-[11px] uppercase tracking-wide text-sky-700 font-semibold">Gender</label>
                  <div className="mt-0.5 text-sm text-slate-800 bg-white/70 border border-sky-100 rounded-lg px-3 py-2">{identityInfo.gender}</div>
                </div>
              )}
              {identityInfo.state && (
                <div>
                  <label className="text-[11px] uppercase tracking-wide text-sky-700 font-semibold">State of Origin</label>
                  <div className="mt-0.5 text-sm text-slate-800 bg-white/70 border border-sky-100 rounded-lg px-3 py-2">{identityInfo.state}</div>
                </div>
              )}
              {identityInfo.lga && (
                <div>
                  <label className="text-[11px] uppercase tracking-wide text-sky-700 font-semibold">Local Government (LGA)</label>
                  <div className="mt-0.5 text-sm text-slate-800 bg-white/70 border border-sky-100 rounded-lg px-3 py-2">{identityInfo.lga}</div>
                </div>
              )}
              {identityInfo.address && (
                <div className="sm:col-span-2">
                  <label className="text-[11px] uppercase tracking-wide text-sky-700 font-semibold">Residential Address</label>
                  <div className="mt-0.5 text-sm text-slate-800 bg-white/70 border border-sky-100 rounded-lg px-3 py-2">{identityInfo.address}</div>
                </div>
              )}
              {identityInfo.nationality && (
                <div>
                  <label className="text-[11px] uppercase tracking-wide text-sky-700 font-semibold">Nationality</label>
                  <div className="mt-0.5 text-sm text-slate-800 bg-white/70 border border-sky-100 rounded-lg px-3 py-2">{identityInfo.nationality}</div>
                </div>
              )}
            </div>
          </div>
        )}

        {verificationError && <p className="text-sm text-red-600">{verificationError}</p>}

        <div className={`rounded-xl border p-4 sm:p-5 ${livenessLocked ? "border-emerald-200 bg-emerald-50/60" : "border-emerald-200 bg-emerald-50/60"}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h3 className="text-sm font-semibold text-emerald-800">Liveness verification <span className="text-red-500">*</span></h3>
            {livenessLocked && (
              <span className="text-xs inline-flex items-center gap-1 text-emerald-700 bg-white border border-emerald-200 px-2 py-1 rounded-md font-bold shadow-sm">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Verified & Locked
              </span>
            )}
          </div>
          <p className="mb-3 text-xs text-emerald-700">Complete a quick in-app selfie scan using the camera verification widget to confirm your identity.</p>
          {bestSelfieImage ? (
            <div className="mb-4 flex flex-col sm:flex-row items-start gap-4">
              <div className="relative w-40 h-40 shrink-0 rounded-xl overflow-hidden border-2 border-emerald-300 bg-white shadow-inner">
                <img src={bestSelfieImage} alt="Verified identity photo" className="w-full h-full object-cover" />
                <div className="absolute inset-0 pointer-events-none border-2 border-emerald-400/30 rounded-xl" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-emerald-800 mb-1">Identity Photo on Record</div>
                <p className="text-xs text-emerald-700 leading-relaxed">
                  This image was captured from your {application.kyc?.selfieImageData ? "liveness scan" : bvnLocked ? "BVN" : "NIN"} records during verification and will be used to confirm your identity at disbursement.
                </p>
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            {livenessLocked ? (
              <div className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-800 bg-white/80 border border-emerald-200 px-4 py-2 rounded-xl">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <rect x="4" y="10" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.8"/>
                  <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                  <circle cx="12" cy="15" r="1.8" fill="currentColor"/>
                </svg>
                Liveness check completed · cannot retrigger
              </div>
            ) : (
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
            )}
          </div>
          {verification.liveness && !livenessLocked && <p className={`mt-3 text-xs font-semibold ${verification.liveness === "Verified" ? "text-emerald-600" : "text-red-600"}`}>{livenessBusy ? "Checking…" : verification.liveness}</p>}
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

        {otpMethodPickerFor && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-fade-in">
            <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-2xl animate-slide-in-left">
              <div className="mb-5">
                <h3 className="text-lg font-extrabold text-velo-900 dark:text-white">Verify {otpMethodPickerFor} ownership</h3>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Choose how to receive your one-time verification code.</p>
              </div>
              <div className="grid gap-3 space-y-3">
                <button
                  type="button"
                  onClick={() => void verifyIdentityWithChannel(otpMethodPickerFor, "SMS")}
                  className="w-full text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-velo-300 dark:hover:border-velo-500 hover:bg-velo-50 dark:hover:bg-velo-900/20 transition group"
                >
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg bg-velo-500 text-white flex items-center justify-center shrink-0">
                      <span className="text-lg">💬</span>
                    </div>
                    <div>
                      <div className="font-bold text-velo-900 dark:text-white">SMS</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">Receive code via text message</div>
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => void verifyIdentityWithChannel(otpMethodPickerFor, "WHATSAPP")}
                  className="w-full text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-emerald-300 dark:hover:border-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition group"
                >
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg bg-emerald-500 text-white flex items-center justify-center shrink-0">
                      <span className="text-lg">💚</span>
                    </div>
                    <div>
                      <div className="font-bold text-velo-900 dark:text-white">WhatsApp</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">Receive code on WhatsApp</div>
                    </div>
                  </div>
                </button>
              </div>
              <div className="mt-5 text-right">
                <button
                  type="button"
                  onClick={() => setOtpMethodPickerFor(null)}
                  className="btn-secondary text-sm"
                >Cancel</button>
              </div>
            </div>
          </div>
        )}

        {activeOtpChallenge && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-fade-in">
            <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-2xl animate-slide-in-left">
              <div className="mb-5">
                <h3 className="text-lg font-extrabold text-velo-900 dark:text-white">Enter verification code</h3>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  We sent a 6-digit code to the {activeOtpChallenge.idType} phone number ending in
                  <span className="font-bold text-velo-900 dark:text-white ml-1">
                    ···{activeOtpChallenge.challenge.phoneLastFour}</span> via {activeOtpChallenge.challenge.channel}.
                </p>
              </div>
              <div>
                <label className="velo-label">Verification code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="Enter 6-digit code"
                  value={activeOtpChallenge.otpCode}
                  onChange={(e) => {
                    const code = e.target.value.replace(/\D/g, "");
                    setActiveOtpChallenge((cur) => (cur ? { ...cur, otpCode: code } : cur));
                  }}
                  className="velo-input text-center font-bold tracking-[0.5em] text-xl"
                  autoFocus
                />
              </div>
              {activeOtpChallenge.error && (
                <div className="mt-3 text-sm text-red-600 dark:text-red-400">{activeOtpChallenge.error}</div>
              )}
              <div className="mt-5 flex items-center justify-between">
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {(function () {
                    if (activeOtpChallenge.cooldown > 0) return `Resend available in ${activeOtpChallenge.cooldown}s`;
                    if (activeOtpChallenge.cooldown === 0) return "Code expired";
                    return "";
                  })()}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void resendActiveKycOtp("SMS")}
                    disabled={activeOtpChallenge.cooldown > 0 || activeOtpChallenge.busy}
                    className="text-xs font-semibold text-velo-600 dark:text-velo-400 hover:underline disabled:opacity-60"
                  >Resend SMS</button>
                  <button
                    type="button"
                    onClick={() => void resendActiveKycOtp("WHATSAPP")}
                    disabled={activeOtpChallenge.cooldown > 0 || activeOtpChallenge.busy}
                    className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:underline disabled:opacity-60"
                  >Resend WhatsApp</button>
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setActiveOtpChallenge(null); setVerificationError(""); }}
                  className="btn-secondary text-sm"
                >Cancel</button>
                <button
                  type="button"
                  onClick={() => void submitActiveKycOtp()}
                  disabled={activeOtpChallenge.otpCode.length !== 6 || activeOtpChallenge.busy}
                  className="btn-primary text-sm"
                >{activeOtpChallenge.busy ? "Verifying…" : "Confirm code"}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </SectionShell>
  );
}
