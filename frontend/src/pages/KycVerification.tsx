// ============================================================================
// src/pages/KycVerification.tsx
// STANDALONE identity verification (KYC) page — reachable from both the
// Borrower and Investor dashboards and from the landing "Verification" CTA.
//
// Key behaviour requested by the product:
//   • It is NOT the loan application: this page only handles KYC.
//   • Every detail the customer already gave during their loan application is
//     PULLED IN (BVN/NIN, personal details, uploaded documents) so nothing has
//     to be entered or uploaded twice.
//   • One click re-uses the application documents into the KYC case.
//   • Submitting sends the case to the admin KYC dashboard for approval, and
//     the lifecycle emails (submitted / approved / rejected) fire server-side.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import FileUpload from "../components/FileUpload";
import Icon from "../components/Icon";
import { useAuth } from "../context/AuthContext";
import {
  confirmKycOwnershipOtp,
  getMyKyc,
  reuseKycApplicationDocuments,
  resendKycOwnershipOtp,
  updateMyKyc,
  uploadKycDocument,
  verifyMyBvn,
  verifyMyLiveness,
  verifyMyNin,
  type KycOtpChallenge,
  type KycResponse,
} from "../services/apiClient";
import type { UploadedDocument } from "../types/documents";

type VerificationMap = Record<string, string>;

function statusTone(status: string | undefined): "verified" | "pending" | "rejected" | "idle" {
  switch (status) {
    case "VERIFIED":
    case "APPROVED":
      return "verified";
    case "PENDING_VERIFICATION":
    case "PENDING_REVIEW":
    case "REVIEWING":
    case "IN_PROGRESS":
    case "ACTION_REQUIRED":
    case "PARTIALLY_VERIFIED":
      return "pending";
    case "REJECTED":
    case "EXPIRED":
    case "SUSPENDED":
      return "rejected";
    default:
      return "idle";
  }
}

const STATUS_BADGE: Record<string, string> = {
  verified: "bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-900/60",
  pending: "bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-900/60",
  rejected: "bg-red-50 text-red-700 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-900/60",
  idle: "bg-slate-100 text-slate-500 border border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700",
};

export default function KycVerification() {
  const navigate = useNavigate();
  const { user, refreshUser } = useAuth();
  const [kyc, setKyc] = useState<KycResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [bvnInput, setBvnInput] = useState("");
  const [ninInput, setNinInput] = useState("");
  const [verification, setVerification] = useState<VerificationMap>({});
  const [busyId, setBusyId] = useState<string>("");
  const [activeOtp, setActiveOtp] = useState<{ idType: "BVN" | "NIN"; challenge: KycOtpChallenge; otpCode: string; busy?: boolean; error?: string } | null>(null);

  const [proofDoc, setProofDoc] = useState<UploadedDocument | undefined>(undefined);
  const [signatureDoc, setSignatureDoc] = useState<UploadedDocument | undefined>(undefined);
  const [passportDoc, setPassportDoc] = useState<UploadedDocument | undefined>(undefined);
  const [uploadingSlot, setUploadingSlot] = useState("");
  const [reusing, setReusing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const prefillRef = useRef(false);

  async function loadKyc() {
    try {
      const response = await getMyKyc();
      setKyc(response);
      setError("");
      return response;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load your verification status");
      return null;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadKyc();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prefill from the loan application on first load.
  useEffect(() => {
    if (!kyc || prefillRef.current) return;
    prefillRef.current = true;
    const prefill = kyc.applicationPrefill;
    const checklist = (kyc.checklist ?? {}) as Record<string, boolean>;
    if (!checklist.bvn && typeof prefill?.bvn === "string" && prefill.bvn) setBvnInput(prefill.bvn);
    if (!checklist.nin && typeof prefill?.nin === "string" && prefill.nin) setNinInput(prefill.nin);
  }, [kyc]);

  const checklist = (kyc?.checklist ?? {}) as Record<string, boolean>;
  const status = kyc?.status ?? user?.kycStatus ?? "NOT_STARTED";
  const tone = statusTone(status);
  const prefill = kyc?.applicationPrefill;
  const prefillDocuments = prefill?.documents ?? [];
  const reusableDocTypes = prefillDocuments.filter((doc) => doc.available);
  const requiredChecks = ["bvn", "nin", "liveness", "proofOfAddress", "signature"];
  const completed = requiredChecks.filter((key) => checklist[key]).length;
  const canSubmit = completed === requiredChecks.length && status !== "VERIFIED" && status !== "PENDING_VERIFICATION";
  const allVerified = status === "VERIFIED";

  async function verifyId(type: "BVN" | "NIN") {
    const value = (type === "BVN" ? bvnInput : ninInput).trim();
    if (!/^\d{11}$/.test(value)) {
      setError(`${type} must be exactly 11 digits.`);
      return;
    }
    setError("");
    setNotice("");
    setBusyId(type);
    setVerification((current) => ({ ...current, [type.toLowerCase()]: "Verifying…" }));
    try {
      const names = (prefill?.personalInfo?.fullName || user?.fullName || "").trim().split(/\s+/);
      const response = type === "BVN"
        ? await verifyMyBvn(value, names[0], names.slice(1).join(" "), prefill?.personalInfo?.dateOfBirth, "SMS")
        : await verifyMyNin(value, names[0], names.slice(1).join(" "), prefill?.personalInfo?.dateOfBirth, "SMS");
      const challenge = (response as { otpChallenge?: KycOtpChallenge }).otpChallenge;
      if (challenge?.requiresPhoneVerification) {
        setActiveOtp({ idType: type, challenge, otpCode: "" });
        setNotice(`A verification code was sent to the phone number on your ${type} records ending in ···${challenge.phoneLastFour}. Enter the code below to confirm ownership.`);
        setVerification((current) => ({ ...current, [type.toLowerCase()]: "Enter code" }));
        return;
      }
      if (response.verificationStatus === "SUCCESS") {
        setVerification((current) => ({ ...current, [type.toLowerCase()]: "Verified" }));
        setNotice(`${type} verified successfully.`);
        await refreshKyc();
      } else {
        setVerification((current) => ({ ...current, [type.toLowerCase()]: "Verification failed" }));
        setError(response.error || `${type} verification failed. Check the number and try again.`);
      }
    } catch (err) {
      setVerification((current) => ({ ...current, [type.toLowerCase()]: "Verification failed" }));
      setError(err instanceof Error ? err.message : `Unable to verify ${type}`);
    } finally {
      setBusyId("");
    }
  }

  async function submitOtp() {
    if (!activeOtp || activeOtp.otpCode.length !== 6) return;
    setActiveOtp({ ...activeOtp, busy: true, error: undefined });
    try {
      await confirmKycOwnershipOtp({ idType: activeOtp.idType, challengeId: activeOtp.challenge.challengeId, code: activeOtp.otpCode });
      setVerification((current) => ({ ...current, [activeOtp.idType.toLowerCase()]: "Verified" }));
      setActiveOtp(null);
      setNotice(`${activeOtp.idType} verified successfully.`);
      setError("");
      await refreshKyc();
    } catch (err) {
      setActiveOtp((current) => current ? { ...current, busy: false, error: err instanceof Error ? err.message : "Invalid or expired code", otpCode: "" } : current);
    }
  }

  async function resendOtp() {
    if (!activeOtp) return;
    try {
      const response = await resendKycOwnershipOtp({ idType: activeOtp.idType, challengeId: activeOtp.challenge.challengeId });
      setActiveOtp((current) => current ? {
        ...current,
        challenge: { ...current.challenge, challengeId: response.challengeId, expiresAt: response.expiresAt, channel: response.channel, resendAvailableAt: response.resendAvailableAt, resendSecondsRemaining: response.resendSecondsRemaining },
        otpCode: "",
        error: undefined,
      } : current);
      setNotice("A new verification code has been sent.");
    } catch (err) {
      setActiveOtp((current) => current ? { ...current, error: err instanceof Error ? err.message : "Unable to resend code" } : current);
    }
  }

  async function handleLiveness(file: File) {
    setBusyId("liveness");
    setError("");
    try {
      const idType = checklist.bvn ? "BVN" : checklist.nin ? "NIN" : undefined;
      if (!idType) {
        setError("Verify your BVN or NIN before starting face verification.");
        return;
      }
      const response = await verifyMyLiveness(file, {
        idType,
        idNumber: idType === "BVN" ? bvnInput || prefill?.bvn : ninInput || prefill?.nin,
        dateOfBirth: prefill?.personalInfo?.dateOfBirth,
      });
      if (response.verificationStatus === "SUCCESS") {
        setVerification((current) => ({ ...current, liveness: "Verified" }));
        setNotice("Liveness check completed.");
        await refreshKyc();
      } else {
        setError(response.error || "Liveness verification failed. Try again in good lighting.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to complete liveness verification");
    } finally {
      setBusyId("");
    }
  }

  async function handleDocumentUpload(slot: "PROOF_OF_ADDRESS" | "SIGNATURE" | "PASSPORT_PHOTO", file: File) {
    setUploadingSlot(slot);
    setError("");
    try {
      await uploadKycDocument(slot, file);
      if (slot === "PROOF_OF_ADDRESS") setProofDoc({ slot: "proofOfAddress", name: file.name, type: file.type, size: file.size, data: "", status: "uploaded", addedAt: new Date().toISOString() });
      if (slot === "SIGNATURE") setSignatureDoc({ slot: "signature", name: file.name, type: file.type, size: file.size, data: "", status: "uploaded", addedAt: new Date().toISOString() });
      if (slot === "PASSPORT_PHOTO") setPassportDoc({ slot: "identificationDocument", name: file.name, type: file.type, size: file.size, data: "", status: "uploaded", addedAt: new Date().toISOString() });
      setNotice(`${slot.replace(/_/g, " ").toLowerCase()} uploaded for review.`);
      await refreshKyc();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to upload document");
    } finally {
      setUploadingSlot("");
    }
  }

  async function reuseApplicationDocuments() {
    setReusing(true);
    setError("");
    setNotice("");
    try {
      const response = await reuseKycApplicationDocuments();
      setNotice(response.message);
      await refreshKyc();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reuse your application documents");
    } finally {
      setReusing(false);
    }
  }

  async function submitForVerification() {
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await updateMyKyc({ statusOverride: "PENDING_VERIFICATION" });
      if (response.status === "PENDING_VERIFICATION") {
        setNotice("Your verification has been submitted. Our team will review it and email you the outcome.");
        await refreshKyc();
        await refreshUser();
      } else {
        setError(response.message || "Some required checks are still missing.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to submit your verification");
    } finally {
      setSubmitting(false);
    }
  }

  async function refreshKyc() {
    await loadKyc();
  }

  const categoryResults = kyc?.categoryResults ?? {};
  const docStatus = (types: string[]) => {
    const docs = (kyc?.documents ?? []) as Array<{ documentType?: string; status?: string }>;
    const match = docs.find((doc) => types.includes(String(doc.documentType)) && doc.status);
    return match?.status ?? null;
  };

  return (
    <Layout>
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Identity verification</p>
            <h1 className="mt-2 text-xl font-semibold text-velo-900 sm:text-2xl md:text-3xl dark:text-white">KYC Verification</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
              Confirm your identity once — loans, investing and payouts all unlock when your verification is approved.
              You'll need your BVN or NIN and a working phone number for the one-time code.
            </p>
          </div>
          <button type="button" onClick={() => navigate(-1)} className="btn-ghost text-xs">
            <Icon name="arrowLeft" size={14} /> Back
          </button>
        </div>

        {loading && (
          <div className="rounded-xl border border-sky-100 bg-sky-50 p-4 text-sm text-sky-700 dark:border-sky-900/40 dark:bg-sky-900/20 dark:text-sky-300">
            Checking your latest verification status…
          </div>
        )}
        {error && (
          <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
            <span>{error}</span>
            <button type="button" className="text-xs font-semibold underline" onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {notice && (
          <div className="flex items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-900/20 dark:text-emerald-300">
            <span>{notice}</span>
            <button type="button" className="text-xs font-semibold underline" onClick={() => setNotice("")}>Dismiss</button>
          </div>
        )}

        {/* Overall status */}
        <section className="velo-card p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="section-heading">Overall status</h2>
              <p className="section-subheading">{completed}/5 required checks completed</p>
            </div>
            <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${STATUS_BADGE[tone]}`}>
              {String(status).replace(/_/g, " ")}
            </span>
          </div>
          <div className="mt-4 h-2 rounded-full bg-slate-100 dark:bg-slate-800">
            <div className="h-2 rounded-full bg-gradient-to-r from-velo-500 to-emerald-500 transition-all" style={{ width: `${Math.max(4, (completed / requiredChecks.length) * 100)}%` }} />
          </div>
          {kyc?.rejectionReason && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
              <strong>Review note:</strong> {kyc.rejectionReason}
            </div>
          )}
        </section>

        {/* Pulled from loan application */}
        {!allVerified && prefill && (prefill.bvn || prefill.nin || reusableDocTypes.length > 0) && (
          <section className="rounded-2xl border border-velo-100 bg-gradient-to-br from-velo-50/80 to-white p-5 dark:border-velo-900/40 dark:from-velo-900/20 dark:to-slate-900">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold text-velo-900 dark:text-white">
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-velo-100 text-velo-700 dark:bg-velo-900 dark:text-velo-300">
                    <Icon name="check" size={13} />
                  </span>
                  Details pulled from your loan application
                </h2>
                <p className="mt-1.5 text-sm leading-6 text-slate-600 dark:text-slate-300">
                  {prefill.applicationId ? (
                    <>Application <strong className="font-mono">{prefill.applicationId}</strong> already gave us </>
                  ) : "Your application already gave us "}
                  {prefill.bvn && "your BVN"}{prefill.bvn && prefill.nin ? " and " : ""}{prefill.nin && "your NIN"}
                  {reusableDocTypes.length > 0 && (prefill.bvn || prefill.nin ? ", and your uploaded documents" : "your uploaded documents")}
                  . Everything is pre-filled below — confirm and submit.
                </p>
              </div>
              {reusableDocTypes.length > 0 && (
                <button type="button" onClick={() => void reuseApplicationDocuments()} disabled={reusing} className="btn-secondary shrink-0 text-xs">
                  {reusing ? "Pulling documents…" : "Reuse my application documents"}
                </button>
              )}
            </div>
            {reusableDocTypes.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2">
                {reusableDocTypes.map((doc) => (
                  <li key={doc.slot} className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-slate-600 shadow-sm dark:bg-slate-800 dark:text-slate-300">
                    <Icon name="check" size={11} />
                    {doc.documentType.replace(/_/g, " ")} · {doc.fileName}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {allVerified ? (
          <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center dark:border-emerald-900/50 dark:bg-emerald-900/20">
            <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500 text-white">
              <Icon name="check" size={22} />
            </div>
            <h2 className="mt-3 text-lg font-semibold text-emerald-900 dark:text-emerald-200">Your identity is verified</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-emerald-700 dark:text-emerald-300">
              Every feature on both dashboards is unlocked. You never have to do this again unless our team asks you to re-verify.
            </p>
            <Link to={user?.roles.includes("INVESTOR") ? "/investor" : "/borrower"} className="btn-primary mt-5 inline-flex text-xs">
              Back to dashboard
            </Link>
          </section>
        ) : (
          <>
            {/* Identity numbers */}
            <section className="velo-card p-5">
              <h2 className="section-heading">1 · Verify your identity number</h2>
              <p className="section-subheading">A one-time code confirms you own the number. This is the same check you passed during your loan application.</p>
              <div className="mt-4 grid gap-5 lg:grid-cols-2">
                <div className="space-y-2">
                  <label className="velo-label flex items-center justify-between">
                    <span>BVN</span>
                    {checklist.bvn && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">VERIFIED</span>}
                  </label>
                  {checklist.bvn ? (
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      Verified{kyc?.bvnLastFour ? ` · ending ${kyc.bvnLastFour}` : ""} — carried over from your verification records.
                    </p>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        className="velo-input mt-1 flex-1"
                        value={bvnInput}
                        onChange={(event) => setBvnInput(event.target.value.replace(/\D/g, "").slice(0, 11))}
                        placeholder={prefill?.bvnMasked ?? "11-digit BVN"}
                        inputMode="numeric"
                      />
                      <button type="button" className="btn-primary mt-1 shrink-0 text-xs" disabled={busyId === "BVN"} onClick={() => void verifyId("BVN")}>
                        {busyId === "BVN" ? "Verifying…" : "Verify BVN"}
                      </button>
                    </div>
                  )}
                  {verification.bvn && !checklist.bvn && <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">{verification.bvn}</p>}
                </div>
                <div className="space-y-2">
                  <label className="velo-label flex items-center justify-between">
                    <span>NIN</span>
                    {checklist.nin && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">VERIFIED</span>}
                  </label>
                  {checklist.nin ? (
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      Verified{kyc?.ninLastFour ? ` · ending ${kyc.ninLastFour}` : ""} — carried over from your verification records.
                    </p>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        className="velo-input mt-1 flex-1"
                        value={ninInput}
                        onChange={(event) => setNinInput(event.target.value.replace(/\D/g, "").slice(0, 11))}
                        placeholder={prefill?.ninMasked ?? "11-digit NIN"}
                        inputMode="numeric"
                      />
                      <button type="button" className="btn-primary mt-1 shrink-0 text-xs" disabled={busyId === "NIN"} onClick={() => void verifyId("NIN")}>
                        {busyId === "NIN" ? "Verifying…" : "Verify NIN"}
                      </button>
                    </div>
                  )}
                  {verification.nin && !checklist.nin && <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">{verification.nin}</p>}
                </div>
              </div>

              {activeOtp && (
                <div className="mt-5 space-y-3 rounded-2xl border border-velo-100 bg-velo-50/70 p-4 dark:border-velo-900/40 dark:bg-velo-900/20">
                  <p className="text-sm font-semibold text-velo-900 dark:text-white">
                    Enter the 6-digit code sent to ···{activeOtp.challenge.phoneLastFour} ({activeOtp.challenge.channel})
                  </p>
                  <input
                    className="velo-input text-center text-lg tracking-[0.35em]"
                    inputMode="numeric"
                    maxLength={6}
                    value={activeOtp.otpCode}
                    onChange={(event) => setActiveOtp({ ...activeOtp, otpCode: event.target.value.replace(/\D/g, "") })}
                    placeholder="000000"
                    disabled={activeOtp.busy}
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <button type="button" className="btn-primary text-xs" disabled={activeOtp.busy || activeOtp.otpCode.length !== 6} onClick={() => void submitOtp()}>
                      {activeOtp.busy ? "Confirming…" : "Confirm code"}
                    </button>
                    <button type="button" className="btn-secondary text-xs" onClick={() => void resendOtp()}>Resend code</button>
                    <button type="button" className="btn-ghost text-xs" onClick={() => setActiveOtp(null)}>Cancel</button>
                  </div>
                  {activeOtp.error && <p className="text-sm font-medium text-red-600 dark:text-red-400">{activeOtp.error}</p>}
                </div>
              )}
            </section>

            {/* Liveness */}
            <section className="velo-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="section-heading">2 · Liveness check</h2>
                  <p className="section-subheading">A quick selfie video or photo confirms it is really you. Good lighting helps.</p>
                </div>
                <span className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase ${checklist.liveness ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : STATUS_BADGE.idle}`}>
                  {checklist.liveness ? "Completed" : String(categoryResults.LIVENESS?.status ?? "Pending").replace(/_/g, " ")}
                </span>
              </div>
              {!checklist.liveness && (
                <label className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/60 p-6 text-center transition hover:border-velo-400 hover:bg-velo-50/40 dark:border-slate-600 dark:bg-slate-800/40">
                  {busyId === "liveness" ? (
                    <span className="text-sm font-semibold text-velo-700 dark:text-velo-300">Checking your selfie…</span>
                  ) : (
                    <>
                      <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Tap to capture or upload your selfie</span>
                      <span className="mt-1 text-xs text-slate-500 dark:text-slate-400">JPG or PNG · your BVN or NIN must be verified first</span>
                    </>
                  )}
                  <input
                    type="file"
                    accept="image/*"
                    capture="user"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void handleLiveness(file);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              )}
            </section>

            {/* Documents */}
            <section className="velo-card p-5">
              <h2 className="section-heading">3 · Documents</h2>
              <p className="section-subheading">
                We already have these from your loan application — reusing them is one click. Only upload new files if you skipped them before.
              </p>
              <div className="mt-4 grid gap-5 lg:grid-cols-3">
                <FileUpload
                  label="Proof of address"
                  helper={docStatus(["PROOF_OF_ADDRESS"]) === "PENDING_REVIEW" ? "Pulled from your application — under review" : "Utility bill, tenancy receipt or bank statement"}
                  document={proofDoc}
                  onFile={(doc) => {
                    // FileUpload gives us local data; convert to a real upload.
                    const blob = new File([new Blob([Uint8Array.from(atob(doc.data), (c) => c.charCodeAt(0))], { type: doc.type })], doc.name, { type: doc.type });
                    void handleDocumentUpload("PROOF_OF_ADDRESS", blob);
                  }}
                  onRemove={() => setProofDoc(undefined)}
                />
                <FileUpload
                  label="Signature"
                  helper={docStatus(["SIGNATURE"]) === "PENDING_REVIEW" ? "Pulled from your application — under review" : "Your signature on a plain white sheet"}
                  document={signatureDoc}
                  onFile={(doc) => {
                    const blob = new File([new Blob([Uint8Array.from(atob(doc.data), (c) => c.charCodeAt(0))], { type: doc.type })], doc.name, { type: doc.type });
                    void handleDocumentUpload("SIGNATURE", blob);
                  }}
                  onRemove={() => setSignatureDoc(undefined)}
                />
                <FileUpload
                  label="Passport / ID photo"
                  helper={docStatus(["PASSPORT_PHOTO", "ID_CARD_FRONT", "BVN_SLIP", "NIN_SLIP"]) === "PENDING_REVIEW" ? "Pulled from your application — under review" : "Clear photo of your ID (optional but recommended)"}
                  document={passportDoc}
                  onFile={(doc) => {
                    const blob = new File([new Blob([Uint8Array.from(atob(doc.data), (c) => c.charCodeAt(0))], { type: doc.type })], doc.name, { type: doc.type });
                    void handleDocumentUpload("PASSPORT_PHOTO", blob);
                  }}
                  onRemove={() => setPassportDoc(undefined)}
                />
              </div>
              {uploadingSlot && <p className="mt-3 text-xs font-semibold text-velo-600">Uploading {uploadingSlot.replace(/_/g, " ").toLowerCase()}…</p>}
            </section>

            {/* Submit */}
            <section className="velo-card p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="section-heading">4 · Submit for verification</h2>
                  <p className="section-subheading">
                    Our team reviews your submission (usually within 24–48 hours) and emails you the outcome.
                    {status === "PENDING_VERIFICATION" && " Your verification is currently awaiting review — no further action needed."}
                  </p>
                </div>
                <button type="button" className="btn-primary shrink-0" disabled={!canSubmit && status !== "PENDING_VERIFICATION" || submitting} onClick={() => void submitForVerification()}>
                  {submitting ? "Submitting…" : status === "PENDING_VERIFICATION" ? "Submitted — pending review" : "Submit for verification"}
                </button>
              </div>
              {!canSubmit && status !== "PENDING_VERIFICATION" && (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  Complete all 5 required checks above to enable submission ({completed}/5 done).
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </Layout>
  );
}
