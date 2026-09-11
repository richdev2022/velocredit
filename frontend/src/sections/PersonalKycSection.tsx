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
  getMyKyc,
  updateMyKyc,
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
  const [otpPickerState, setOtpPickerState] = useState<{ phase: "idle" | "sending" | "success" | "error"; channel?: "SMS" | "WHATSAPP"; message?: string }>({ phase: "idle" });
  const [activeOtpChallenge, setActiveOtpChallenge] = useState<null | {
    idType: "BVN" | "NIN";
    challenge: KycOtpChallenge;
    otpCode: string;
    cooldown: number;
    error?: string;
    busy?: boolean;
  }>(null);
  const countdownRef = useRef<number | null>(null);
  const kycProfileLoadedRef = useRef(false);
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
    const photoRaw = pickStr(details, ["base64Image", "identityPhoto", "photo", "photograph", "image", "face_image", "selfie"]);
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

  useEffect(() => {
    if (kycProfileLoadedRef.current) return;
    kycProfileLoadedRef.current = true;
    let cancelled = false;
    void getMyKyc().then((kyc) => {
      if (cancelled || !kyc?.ok) return;
      const anyKyc = kyc as any;
      const checklist = (anyKyc.checklist || {}) as Record<string, boolean>;
      const existingPersonal = application.personalInfo || {};
      const prefill = anyKyc.profilePrefill as Record<string, string> | undefined;
      if (prefill) {
        const infoPatch: Record<string, string> = {};
        (["fullName", "dateOfBirth", "phone", "residentialAddress", "state", "lga", "email", "gender"] as const).forEach((key) => {
          const existing = (existingPersonal as unknown as Record<string, unknown>)[key] as string | undefined;
          const val = prefill[key];
          if (!existing && typeof val === "string" && val.trim()) infoPatch[key] = val;
        });
        if (Object.keys(infoPatch).length) patchPersonalInfo(infoPatch);
      }
      const existingKyc = application.kyc || {};
      const kycPatch: Record<string, any> = {};
      const profileBvn = typeof anyKyc.bvn === "string" ? anyKyc.bvn : undefined;
      const profileNin = typeof anyKyc.nin === "string" ? anyKyc.nin : undefined;
      if (checklist.bvn && profileBvn && !existingKyc.bvnVerified) {
        kycPatch.bvn = profileBvn;
        kycPatch.bvnVerified = true;
        setValue("bvn", maskIdNumber(profileBvn), { shouldValidate: true });
      }
      if (checklist.nin && profileNin && !existingKyc.ninVerified) {
        kycPatch.nin = profileNin;
        kycPatch.ninVerified = true;
        setValue("nin", maskIdNumber(profileNin), { shouldValidate: true });
      }
      if (checklist.liveness && !existingKyc.livenessVerified) {
        kycPatch.livenessVerified = true;
        if (anyKyc.selfieImageData) kycPatch.selfieImageData = anyKyc.selfieImageData;
      }
      const merged = { ...(anyKyc.verifiedDetails || {}), ...(anyKyc.normalizedFields?.bvn || {}), ...(anyKyc.normalizedFields?.nin || {}) };
      if (Object.keys(merged).length) {
        const currentDetails = (existingKyc.verifiedDetails || {}) as Record<string, unknown>;
        const nextDetails = { ...currentDetails };
        Object.entries(merged).forEach(([k, v]) => { if (nextDetails[k] === undefined) nextDetails[k] = v; });
        kycPatch.verifiedDetails = nextDetails;
        if (!existingKyc.identityPhotoUrl) {
          const photoRaw = pickStr(nextDetails, ["base64Image", "identityPhoto", "photo", "photograph", "image", "face_image", "selfie"]);
          const photo = normalizePhotoData(photoRaw);
          if (photo) kycPatch.identityPhotoUrl = photo;
        }
      }
      if (Object.keys(kycPatch).length) patchKyc(kycPatch);
      const hasProof = Boolean(application.documents?.proofOfAddress);
      if (!hasProof) {
        const url = anyKyc.proofOfAddressUrl as string | undefined;
        const docs = anyKyc.documents as any[] | undefined;
        const proofDoc = docs?.find((d) => d?.documentType === "PROOF_OF_ADDRESS");
        if (url || proofDoc) {
          const upload: UploadedDocument = proofDoc
            ? { ...proofDoc, slot: "proofOfAddress" }
            : ({ name: "Proof of Address (from KYC profile)", size: 0, type: url?.includes(".pdf") ? "application/pdf" : url?.includes("png") ? "image/png" : "image/jpeg", previewUrl: url, slot: "proofOfAddress", uploadedAt: new Date().toISOString() } as any);
          patchDocuments({ proofOfAddress: upload });
        }
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

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
    const value = type === "BVN" ? currentApplication.kyc?.bvn || "" : currentApplication.kyc?.nin || "";
    const lowerType = type.toLowerCase() as "bvn" | "nin";
    setOtpPickerState({ phase: "sending", channel });
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
        setOtpMethodPickerFor(null);
        setOtpPickerState({ phase: "idle" });
        return;
      }
      const status = response.verificationStatus === "SUCCESS" ? "Verified" : response.error || "Verification failed";
      setVerification((current) => ({ ...current, [lowerType]: status }));
      if (response.verificationStatus === "SUCCESS") {
        setOtpPickerState({ phase: "success", channel, message: `${type} phone matches your registered account — ownership confirmed automatically. No code required.` });
        const details = response.verifiedDetails ?? {};
        const photoUrl = normalizePhotoData(pickStr(details, ["base64Image", "identityPhoto", "photo", "photograph", "image", "face_image", "selfie"]));
        patchKyc({ [lowerType === "bvn" ? "bvnVerified" : "ninVerified"]: true, verifiedDetails: details, ...(photoUrl ? { identityPhotoUrl: photoUrl } : {}) });
        const pick = (keys: string[]) => keys.map((key) => details[key]).find((item) => typeof item === "string" && item.trim()) as string | undefined;
        const autofill = Object.fromEntries(Object.entries({ fullName: pick(["full_name", "fullName", "name"]), phone: pick(["phone_number", "phone", "mobile"]), dateOfBirth: pick(["date_of_birth", "dateOfBirth", "dob"]) }).filter(([, item]) => item));
        if (Object.keys(autofill).length) patchPersonalInfo(autofill);
        if (lowerType === "bvn") {
          setValue("bvn", maskIdNumber(value), { shouldValidate: true });
          void updateMyKyc({ bvn: value, checklist: { bvn: true } }).catch(() => {});
        } else {
          setValue("nin", maskIdNumber(value), { shouldValidate: true });
          void updateMyKyc({ nin: value, checklist: { nin: true } }).catch(() => {});
        }
        window.setTimeout(() => {
          setOtpMethodPickerFor(null);
          setOtpPickerState({ phase: "idle" });
        }, 1700);
      } else {
        setOtpPickerState({ phase: "error", channel, message: status });
      }
    } catch (error) {
      setVerification((current) => ({ ...current, [lowerType]: "Verification failed" }));
      const msg = error instanceof Error ? error.message : `Unable to verify ${type}`;
      setVerificationError(msg);
      setOtpPickerState({ phase: "error", channel, message: msg });
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
        if (lowerType === "bvn") {
          setValue("bvn", maskIdNumber(value), { shouldValidate: true });
          void updateMyKyc({ bvn: value, checklist: { bvn: true } }).catch(() => {});
        } else {
          setValue("nin", maskIdNumber(value), { shouldValidate: true });
          void updateMyKyc({ nin: value, checklist: { nin: true } }).catch(() => {});
        }
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
  const governmentPortrait = identityInfo.identityPhoto;
  const liveSelfie = application.kyc?.selfieImageData;

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
          <div className="sm:col-start-1">
            {bvnLocked ? (
              <span className="text-xs inline-flex items-center gap-1.5 text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1.5 rounded-lg font-semibold shadow-sm">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                BVN Verified
              </span>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="btn-secondary text-xs min-h-[38px]" onClick={() => void verifyIdentity("bvn", application.kyc?.bvn || "")}>Verify BVN instantly</button>
                {verification.bvn && <span className={`text-xs ${verification.bvn === "Verified" ? "text-emerald-600 font-semibold" : "text-slate-500"}`}>{verification.bvn}</span>}
              </div>
            )}
          </div>
          <div className="sm:col-start-2">
            {ninLocked ? (
              <span className="text-xs inline-flex items-center gap-1.5 text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1.5 rounded-lg font-semibold shadow-sm">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                NIN Verified
              </span>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="btn-secondary text-xs min-h-[38px]" onClick={() => void verifyIdentity("nin", application.kyc?.nin || "")}>Verify NIN instantly</button>
                {verification.nin && <span className={`text-xs ${verification.nin === "Verified" ? "text-emerald-600 font-semibold" : "text-slate-500"}`}>{verification.nin}</span>}
              </div>
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

        <div className={`rounded-xl border p-4 sm:p-5 ${livenessLocked ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-800/50 dark:bg-emerald-900/10" : "border-slate-200 bg-slate-50/60 dark:border-slate-700 dark:bg-slate-900/30"}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h3 className={`text-sm font-semibold ${livenessLocked ? "text-emerald-800 dark:text-emerald-300" : "text-slate-800 dark:text-slate-200"}`}>Liveness verification <span className="text-red-500">*</span></h3>
            {livenessLocked && (
              <span className="text-xs inline-flex items-center gap-1 text-emerald-700 bg-white dark:bg-slate-900/80 border border-emerald-200 dark:border-emerald-800 px-2 py-1 rounded-md font-bold shadow-sm dark:text-emerald-300">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Verified &amp; Locked
              </span>
            )}
          </div>
          <p className={`mb-3 text-xs ${livenessLocked ? "text-emerald-700 dark:text-emerald-300/80" : "text-slate-600 dark:text-slate-400"}`}>The widget below compares your current live face against the government portrait to confirm you are the legitimate identity owner.</p>

          {!livenessLocked && (governmentPortrait || liveSelfie) && (
            <div className="mb-4 rounded-xl border-2 border-amber-200 bg-amber-50/70 dark:border-amber-800/40 dark:bg-amber-900/10 p-3 sm:p-4">
              <div className="flex items-start gap-2 mb-2">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0 mt-0.5 text-amber-600 dark:text-amber-400"><path d="M12 9v4m0 4h.01M10.3 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-amber-800 dark:text-amber-300">LIVE SCAN STILL REQUIRED</p>
                  <p className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed">
                    You MUST complete a real camera selfie scan using the widget below. The portrait(s) shown here are retrieved from government BVN/NIN records <strong>only</strong> and are not proof of liveness.
                  </p>
                </div>
              </div>
            </div>
          )}

          {(governmentPortrait || liveSelfie) && (
            <div className="mb-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {governmentPortrait && (
                <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/60">
                  <div className={`px-3 py-2 border-b text-[10px] font-bold uppercase tracking-wider ${livenessLocked ? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700" : "bg-amber-100/90 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border-amber-200 dark:border-amber-800/40"}`}>
                    {livenessLocked ? "Reference — Government ID portrait" : "⚠ Government ID portrait (NOT a selfie scan)"}
                  </div>
                  <div className="p-3">
                    <div className="relative aspect-square w-full rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700">
                      <img src={governmentPortrait} alt="BVN/NIN government portrait" className="w-full h-full object-cover" />
                    </div>
                    <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                      Retrieved from {bvnLocked ? "BVN (NIBBS)" : ninLocked ? "NIN (NIMC)" : "identity"} records during verification.
                    </p>
                  </div>
                </div>
              )}
              {liveSelfie ? (
                <div className="rounded-xl overflow-hidden border border-emerald-200 bg-white dark:border-emerald-800/50 dark:bg-slate-900/60">
                  <div className="px-3 py-2 border-b text-[10px] font-bold uppercase tracking-wider bg-emerald-100/90 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/50">
                    ✓ Your Live Selfie — Liveness Verified
                  </div>
                  <div className="p-3">
                    <div className="relative aspect-square w-full rounded-lg overflow-hidden border-2 border-emerald-300 dark:border-emerald-700">
                      <img src={liveSelfie} alt="Live captured selfie" className="w-full h-full object-cover" />
                      <div className="absolute inset-0 pointer-events-none border-4 border-emerald-400/20 rounded-lg" />
                    </div>
                    <p className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400 leading-relaxed font-semibold">
                      Your live face was matched against the government portrait above.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl overflow-hidden border-2 border-dashed border-slate-300 dark:border-slate-600 bg-slate-50/50 dark:bg-slate-900/30">
                  <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Pending — Awaiting your live selfie
                  </div>
                  <div className="p-4 flex flex-col items-center justify-center text-center h-full min-h-[200px]">
                    <div className="h-14 w-14 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 flex items-center justify-center mb-2">
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2v11z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </div>
                    <p className="text-[11px] font-bold text-slate-600 dark:text-slate-300">No live selfie yet</p>
                    <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed max-w-xs">
                      Click <strong>Start Live Selfie Scan</strong> below to open the camera widget and capture your matching selfie.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {livenessLocked ? (
              <div className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-800 dark:text-emerald-200 bg-white/80 dark:bg-slate-900/60 border border-emerald-200 dark:border-emerald-800 px-4 py-2 rounded-xl">
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
                  if (result.success) patchKyc({ livenessVerified: true, livenessStatus: "SUCCESS", ...(result.selfieImageData ? { selfieImageData: result.selfieImageData } : {}) });
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

        {otpMethodPickerFor && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/40 backdrop-blur-sm p-0 sm:p-4 animate-fade-in">
            <div className="w-full max-w-md sm:rounded-2xl rounded-none border-t-2 sm:border-2 border-velo-500 dark:border-velo-400 bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 p-0 shadow-2xl animate-slide-in-left overflow-hidden">
              <div className="bg-gradient-to-r from-velo-500 to-sky-500 px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-white min-w-0">
                    <h3 className="text-base font-bold">Verify {otpMethodPickerFor} ownership</h3>
                    <p className="mt-1 text-xs text-velo-100 leading-relaxed">
                      {otpPickerState.phase === "idle" && "Choose how you want to receive your 6-digit verification code."}
                      {otpPickerState.phase === "sending" && `Sending verification via ${otpPickerState.channel ?? "SMS"}…`}
                      {otpPickerState.phase === "success" && "Ownership verified"}
                      {otpPickerState.phase === "error" && "Verification could not be completed"}
                    </p>
                  </div>
                  <button type="button" className="rounded-lg p-2 text-white/90 hover:bg-white/15 disabled:opacity-50 disabled:cursor-not-allowed" onClick={() => { if (otpPickerState.phase !== "sending") setOtpMethodPickerFor(null); }} disabled={otpPickerState.phase === "sending"} aria-label="Dismiss">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>
                  </button>
                </div>
              </div>
              <div className="p-5 sm:p-6 space-y-4">
                {otpPickerState.phase === "idle" && (
                  <div className="grid gap-3">
                    <button
                      type="button"
                      onClick={() => void verifyIdentityWithChannel(otpMethodPickerFor, "SMS")}
                      className="w-full text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-velo-300 dark:hover:border-velo-500 hover:bg-velo-50 dark:hover:bg-velo-900/20 transition group"
                    >
                      <div className="flex items-center gap-3">
                        <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-velo-400 to-velo-600 text-white flex items-center justify-center shrink-0 shadow-soft group-hover:shadow-md transition">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
                          </svg>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="font-bold text-velo-900 dark:text-white">SMS</div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">Receive code via text message</div>
                        </div>
                        <div className="text-slate-300 dark:text-slate-600 group-hover:text-velo-500 transition shrink-0">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => void verifyIdentityWithChannel(otpMethodPickerFor, "WHATSAPP")}
                      className="w-full text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-emerald-300 dark:hover:border-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition group"
                    >
                      <div className="flex items-center gap-3">
                        <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 text-white flex items-center justify-center shrink-0 shadow-soft group-hover:shadow-md transition">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/>
                          </svg>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="font-bold text-velo-900 dark:text-white">WhatsApp</div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">Receive code on WhatsApp</div>
                        </div>
                        <div className="text-slate-300 dark:text-slate-600 group-hover:text-emerald-500 transition shrink-0">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                        </div>
                      </div>
                    </button>
                  </div>
                )}

                {otpPickerState.phase === "sending" && (
                  <div className="py-4 flex flex-col items-center text-center space-y-3">
                    <div className="relative h-14 w-14">
                      <div className={`absolute inset-0 rounded-full ${otpPickerState.channel === "WHATSAPP" ? "bg-emerald-100 dark:bg-emerald-900/40" : "bg-velo-100 dark:bg-velo-900/40"}`} />
                      <svg className="absolute inset-2 animate-spin" width="40" height="40" viewBox="0 0 24 24" fill="none">
                        <path d="M21 12a9 9 0 11-6.219-8.56" stroke={otpPickerState.channel === "WHATSAPP" ? "#059669" : "#0ea5e9"} strokeWidth="2.5" strokeLinecap="round"/>
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-bold text-velo-900 dark:text-white">Sending verification code via {otpPickerState.channel ?? "SMS"}…</p>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">Please wait a moment while we contact the identity provider.</p>
                    </div>
                  </div>
                )}

                {otpPickerState.phase === "success" && (
                  <div className="py-4 flex flex-col items-center text-center space-y-3">
                    <div className="h-14 w-14 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </div>
                    <div>
                      <p className="text-sm font-bold text-emerald-700 dark:text-emerald-300">Ownership confirmed automatically</p>
                      <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed max-w-sm">
                        {otpPickerState.message ?? "Your phone number on record matches your account. No code was required."}
                      </p>
                    </div>
                  </div>
                )}

                {otpPickerState.phase === "error" && (
                  <div className="space-y-3">
                    <div className="rounded-xl border border-red-100 bg-red-50 dark:border-red-900/40 dark:bg-red-900/20 p-4 flex items-start gap-3">
                      <div className="h-9 w-9 shrink-0 rounded-full bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 flex items-center justify-center">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 9v4m0 4h.01M10.3 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-bold text-red-700 dark:text-red-300">Verification failed</p>
                        <p className="mt-0.5 text-xs text-red-700/90 dark:text-red-300/90 leading-relaxed break-words">
                          {otpPickerState.message ?? "Please try again or choose a different channel."}
                        </p>
                      </div>
                    </div>
                    <button type="button" onClick={() => setOtpPickerState({ phase: "idle" })} className="btn-secondary w-full text-sm">Choose a different channel</button>
                  </div>
                )}

                {otpPickerState.phase === "idle" && (
                  <div className="flex flex-wrap gap-2 justify-end pt-1">
                    <button type="button" onClick={() => setOtpMethodPickerFor(null)} className="btn-secondary text-sm">Cancel</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeOtpChallenge && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/40 backdrop-blur-sm p-0 sm:p-4 animate-fade-in">
            <div className="velo-card w-full max-w-md shadow-2xl rounded-none sm:rounded-2xl border-t-2 sm:border-2 border-sky-500 dark:border-sky-400 overflow-hidden">
              <div className="bg-gradient-to-r from-sky-500 to-velo-500 px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-white min-w-0">
                    <h3 className="text-base font-bold">Confirm {activeOtpChallenge.idType} ownership</h3>
                    <p className="mt-1 text-xs text-sky-100 leading-relaxed">
                      Sent via <span className="font-semibold">{activeOtpChallenge.challenge.channel}</span> to ···{activeOtpChallenge.challenge.phoneLastFour}
                    </p>
                  </div>
                  <button type="button" className="rounded-lg p-2 text-white/90 hover:bg-white/15" onClick={() => { setActiveOtpChallenge(null); setVerificationError(""); }} aria-label="Dismiss">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>
                  </button>
                </div>
              </div>
              <div className="p-5 space-y-4">
                <label className="velo-label block">
                  <span className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">One-time code (6 digits)</span>
                  <input className="velo-input mt-2 tracking-[0.6em] text-center font-bold text-2xl" inputMode="numeric" maxLength={6} autoFocus value={activeOtpChallenge.otpCode} onChange={(event) => setActiveOtpChallenge((c: any) => c ? { ...c, otpCode: event.target.value.replace(/\D/g, ""), error: undefined } : c)} placeholder="• • • • • •" />
                </label>
                {activeOtpChallenge.error && <p className="text-xs font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/40 rounded-lg px-3 py-2">{activeOtpChallenge.error}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="flex-1 min-w-[120px] rounded-xl border border-sky-200 bg-white px-3 py-2.5 text-sm font-semibold text-sky-800 hover:bg-sky-50 disabled:opacity-60 disabled:cursor-not-allowed dark:border-sky-800 dark:bg-slate-900 dark:text-sky-300 dark:hover:bg-sky-950/30" disabled={activeOtpChallenge.cooldown > 0 || activeOtpChallenge.busy} onClick={() => void resendActiveKycOtp("SMS")}>{activeOtpChallenge.cooldown > 0 ? `Resend SMS (${activeOtpChallenge.cooldown}s)` : "Resend via SMS"}</button>
                  <button type="button" className="flex-1 min-w-[120px] rounded-xl border border-emerald-200 bg-white px-3 py-2.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-60 disabled:cursor-not-allowed dark:border-emerald-800 dark:bg-slate-900 dark:text-emerald-300 dark:hover:bg-emerald-950/30" disabled={activeOtpChallenge.cooldown > 0 || activeOtpChallenge.busy} onClick={() => void resendActiveKycOtp("WHATSAPP")}>{activeOtpChallenge.cooldown > 0 ? `Resend WA (${activeOtpChallenge.cooldown}s)` : "Resend via WhatsApp"}</button>
                </div>
                <button type="button" className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-50 min-h-[48px] text-base font-bold" disabled={activeOtpChallenge.otpCode.length !== 6 || activeOtpChallenge.busy} onClick={() => void submitActiveKycOtp()}>{activeOtpChallenge.busy ? "Verifying…" : "Confirm ownership"}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </SectionShell>
  );
}
