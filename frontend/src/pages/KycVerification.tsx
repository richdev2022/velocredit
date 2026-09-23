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
  getMyDocument,
  getMyKyc,
  reuseKycApplicationDocuments,
  resendKycOwnershipOtp,
  updateMyKyc,
  uploadKycDocument,
  verifyMyBvn,
  verifyMyLiveness,
  verifyMyNin,
  type KycDocumentView,
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

const DOC_STATUS_LABEL: Record<string, string> = {
  PENDING_REVIEW: "Saved — awaiting review",
  PENDING: "Saved — awaiting review",
  VERIFIED: "Verified",
  APPROVED: "Verified",
  REJECTED: "Rejected — replace this file",
  EXPIRED: "Expired — replace this file",
};

/**
 * Client-side image compression — phone photos regularly weigh 3-8 MB, which
 * made KYC uploads crawl. Images above ~400 KB are downscaled to a max edge of
 * 1600 px and re-encoded as JPEG (quality 0.82), which is plenty for document
 * review, while PDFs and already-small files pass through untouched.
 */
async function compressImageForUpload(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml" || file.size <= 400 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const maxEdge = 1600;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1 && file.size <= 1024 * 1024) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((result) => resolve(result), "image/jpeg", 0.82));
    if (!blob || blob.size >= file.size) return file;
    const baseName = file.name.replace(/\.[^.]+$/, "") || "document";
    return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

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

  // Server-persisted documents are the single source of truth: every upload
  // (and every document pulled from the loan application) lands in
  // kyc.documents and is re-hydrated on load, so uploads survive refreshes and
  // logouts. `replacedSlots` only tracks which cards the customer chose to
  // replace during this visit; `uploadingSlot` mirrors in-flight uploads.
  const [replacedSlots, setReplacedSlots] = useState<Record<string, boolean>>({});
  const [uploadingSlot, setUploadingSlot] = useState("");
  const [previewDoc, setPreviewDoc] = useState<{ name: string; mimeType: string; dataUrl: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
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
  // The submit button is disabled ONLY once the case has been submitted for
  // admin review (or is already verified) — never because a checklist item is
  // incomplete. The admin team reviews whatever the customer provides.
  const canSubmit = status !== "VERIFIED" && status !== "PENDING_VERIFICATION";
  const allVerified = status === "VERIFIED";

  // --- Server document hydration -------------------------------------------
  type SlotKey = "proofOfAddress" | "signature" | "passport";
  const slotForDocumentType = (documentType: string): SlotKey | null => {
    if (documentType === "PROOF_OF_ADDRESS") return "proofOfAddress";
    if (documentType === "SIGNATURE") return "signature";
    if (["PASSPORT_PHOTO", "ID_CARD_FRONT", "ID_CARD_BACK", "BVN_SLIP", "NIN_SLIP"].includes(documentType)) return "passport";
    return null;
  };
  const serverDocs: Record<SlotKey, KycDocumentView | undefined> = { proofOfAddress: undefined, signature: undefined, passport: undefined };
  for (const doc of kyc?.documents ?? []) {
    const slot = slotForDocumentType(String(doc.documentType ?? ""));
    if (!slot) continue;
    const current = serverDocs[slot];
    const docTime = Date.parse(String(doc.createdAt ?? "")) || 0;
    const currentTime = Date.parse(String(current?.createdAt ?? "")) || 0;
    if (!current || docTime >= currentTime) serverDocs[slot] = doc;
  }
  const slotDocFor = (slot: SlotKey): UploadedDocument | undefined => {
    if (replacedSlots[slot]) return undefined;
    const doc = serverDocs[slot];
    if (!doc) return undefined;
    return {
      slot: slot === "passport" ? "identificationDocument" : slot,
      name: doc.fileName ?? String(doc.documentType ?? "document").replace(/_/g, " ").toLowerCase(),
      type: doc.mimeType ?? "application/octet-stream",
      size: doc.sizeBytes ?? 0,
      data: "",
      status: "uploaded",
      addedAt: doc.createdAt ?? new Date().toISOString(),
      driveUrl: doc.previewUrl || "",
    } as UploadedDocument;
  };
  const slotStatusFor = (slot: SlotKey): string | null => serverDocs[slot]?.status ?? null;

  async function openPreview(doc: KycDocumentView) {
    // Drive-hosted documents preview straight from Google; inline and
    // snapshot-pulled documents are resolved through the authenticated
    // /me/documents endpoint and rendered in-page.
    if (doc.previewUrl && /^https?:\/\//i.test(doc.previewUrl)) {
      window.open(doc.previewUrl, "_blank", "noopener,noreferrer");
      return;
    }
    setPreviewLoading(true);
    try {
      const detail = await getMyDocument(doc.id);
      const url = detail.document.previewUrl;
      if (!url) {
        setError("This document has no stored copy yet. Please re-upload it.");
        return;
      }
      setPreviewDoc({ name: detail.document.fileName ?? "Document", mimeType: detail.document.mimeType ?? "application/octet-stream", dataUrl: url });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to open the document");
    } finally {
      setPreviewLoading(false);
    }
  }

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

  async function handleLiveness(rawFile: File) {
    setBusyId("liveness");
    setError("");
    try {
      const idType = checklist.bvn ? "BVN" : checklist.nin ? "NIN" : undefined;
      if (!idType) {
        setError("Verify your BVN or NIN before starting face verification.");
        return;
      }
      const file = await compressImageForUpload(rawFile);
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

  async function handleDocumentUpload(slot: "PROOF_OF_ADDRESS" | "SIGNATURE" | "PASSPORT_PHOTO", rawFile: File) {
    setUploadingSlot(slot);
    setError("");
    try {
      const file = await compressImageForUpload(rawFile);
      await uploadKycDocument(slot, file);
      const slotKey = slot === "PROOF_OF_ADDRESS" ? "proofOfAddress" : slot === "SIGNATURE" ? "signature" : "passport";
      setReplacedSlots((current) => ({ ...current, [slotKey]: false }));
      setNotice(`${slot.replace(/_/g, " ").toLowerCase()} saved automatically — refresh-proof and safe to log out.`);
      // Re-pull from the server so the card reflects the PERSISTED record
      // (name, size, review status) instead of a local-only copy.
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

  const docHelper = (slot: "proofOfAddress" | "signature" | "passport", fallback: string) => {
    const docStatus = slotStatusFor(slot);
    if (!docStatus) return fallback;
    const label = DOC_STATUS_LABEL[String(docStatus).toUpperCase()];
    return label ? `${label} · saved on your account` : `${String(docStatus).replace(/_/g, " ").toLowerCase()} · saved on your account`;
  };

  const renderDocSlot = (
    label: string,
    slot: "proofOfAddress" | "signature" | "passport",
    uploadType: "PROOF_OF_ADDRESS" | "SIGNATURE" | "PASSPORT_PHOTO",
    fallbackHelper: string,
  ) => {
    const hydrated = serverDocs[slot];
    return (
      <FileUpload
        label={label}
        helper={docHelper(slot, fallbackHelper)}
        document={slotDocFor(slot)}
        onPreview={hydrated ? () => void openPreview(hydrated) : undefined}
        removeLabel={hydrated ? "Replace" : undefined}
        onRemove={hydrated ? () => setReplacedSlots((current) => ({ ...current, [slot]: true })) : undefined}
        onFile={(doc) => {
          // FileUpload gives us local data; convert to a real upload.
          const blob = new File([new Blob([Uint8Array.from(atob(doc.data), (c) => c.charCodeAt(0))], { type: doc.type })], doc.name, { type: doc.type });
          void handleDocumentUpload(uploadType, blob);
        }}
      />
    );
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
                Anything you upload — here or during your loan application — is saved to your account automatically and stays saved
                after a refresh or logout. Files pulled from your application are listed below; only upload a new file if a slot is empty or a document was rejected.
              </p>
              <div className="mt-4 grid gap-5 lg:grid-cols-3">
                {renderDocSlot("Proof of address", "proofOfAddress", "PROOF_OF_ADDRESS", "Utility bill, tenancy receipt or bank statement")}
                {renderDocSlot("Signature", "signature", "SIGNATURE", "Your signature on a plain white sheet")}
                {renderDocSlot("Passport / ID photo", "passport", "PASSPORT_PHOTO", "Clear photo of your ID (optional but recommended)")}
              </div>
              {uploadingSlot && <p className="mt-3 text-xs font-semibold text-velo-600">Saving {uploadingSlot.replace(/_/g, " ").toLowerCase()}…</p>}
              {previewLoading && <p className="mt-3 text-xs font-semibold text-velo-600">Opening document…</p>}
            </section>

            {/* Submit */}
            <section className="velo-card p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="section-heading">4 · Submit for verification</h2>
                  <p className="section-subheading">
                    Submitting sends everything above to our review team (usually within 24–48 hours) and emails you the outcome.
                    {status === "PENDING_VERIFICATION" && " Your verification is currently awaiting review — no further action needed."}
                  </p>
                </div>
                <button type="button" className="btn-primary shrink-0" disabled={!canSubmit || submitting} onClick={() => void submitForVerification()}>
                  {submitting ? "Submitting…" : status === "PENDING_VERIFICATION" ? "Submitted — pending review" : "Submit for verification"}
                </button>
              </div>
              {!canSubmit ? (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  {status === "PENDING_VERIFICATION"
                    ? "The submit button stays disabled while our team reviews your verification — we will email you the outcome."
                    : "Your identity is verified — no further submission is needed."}
                </p>
              ) : (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  {completed}/5 checks completed so far — you can submit with what you have; our review team checks everything you provide.
                </p>
              )}
            </section>
          </>
        )}

        {/* Document preview overlay */}
        {previewDoc && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4" role="dialog" aria-modal="true" onClick={() => setPreviewDoc(null)}>
            <div className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-slate-900" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
                <p className="truncate text-sm font-semibold text-velo-900 dark:text-white">{previewDoc.name}</p>
                <div className="flex items-center gap-2">
                  <a href={previewDoc.dataUrl} download={previewDoc.name} className="btn-secondary text-[11px]">Download</a>
                  <button type="button" className="btn-ghost text-xs" onClick={() => setPreviewDoc(null)}>Close</button>
                </div>
              </div>
              <div className="max-h-[calc(90vh-56px)] overflow-auto bg-slate-50 dark:bg-slate-950">
                {previewDoc.mimeType.startsWith("image/") ? (
                  <img src={previewDoc.dataUrl} alt={previewDoc.name} className="mx-auto max-h-[calc(90vh-56px)] w-auto object-contain" />
                ) : (
                  <iframe src={previewDoc.dataUrl} title={previewDoc.name} className="h-[calc(90vh-56px)] w-full" />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
