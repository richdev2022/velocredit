import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "./QRCode";
import {
  claimFaceHandoffToken,
  createFaceHandoffSession,
  getMyKyc,
  requestFaceManualReview,
  verifyFaceComparison,
  type FaceComparisonResult,
} from "../services/apiClient";

/* ==========================================================================
   FaceVerificationFlow — the customer-facing face verification experience.

   Replaces the old Prembly embedded widget ("liveness check") with a fully
   in-house camera capture compared against the BVN/NIN government portrait
   via Prembly's face-comparison API (server-side).

   Flow (per product spec):
     1. Click "Take a selfie" → INSTRUCTIONS modal (detailed guidance + device
        recommendation: continue on smartphone OR on this device).
     2. "Continue on my smartphone" → QR code + copyable deep link; the phone
        opens /face-verify?ht=… and runs the same capture. The desktop polls
        until the check passes and offers an "I've completed verification on
        my phone" CTA.
     3. "Continue on this device" → live camera with an OVAL HEAD GUIDE and
        SPOKEN AUDIO DIRECTIONS (with mute toggle), 3-2-1 countdown capture.
     4. Preview → "Retake" or "Use this photo" → upload + comparison.
     5. SUCCESS → checklist auto-approved. FAILURE → "Try again" OR
        "Submit for manual review" (admins get an email alert and can approve
        from the KYC review workspace).
   ========================================================================== */

type Step = "closed" | "instructions" | "phone" | "camera" | "preview" | "verifying" | "success" | "failed" | "manual-review" | "manual-review-done";

/** The 8 capture tips shown in the instructions modal (numbered grid). */
const CAPTURE_TIPS = [
  { title: "Find bright, even light", detail: "Face the light source — never sit with a window behind you." },
  { title: "Uncover your face", detail: "Remove glasses, hats and coverings; hairline to chin must be visible." },
  { title: "Use a plain background", detail: "Sit in front of a plain background and be the only person in frame." },
  { title: "Camera at eye level", detail: "Hold it steady, about 30–50 cm away from your face." },
  { title: "Fill the oval guide", detail: "Fit your entire face inside the oval shown on screen." },
  { title: "Look straight ahead", detail: "Both eyes open, neutral expression, looking at the camera." },
  { title: "Keep perfectly still", detail: "No smiling, tilting or turning your head while we capture." },
  { title: "No filters or edits", detail: "The photo must be the real, unedited you." },
] as const;

interface Props {
  /** Called after the face check passes (or was already approved elsewhere). */
  onVerified?: (selfieImageData?: string) => void;
  /** Called after the customer submits the case for manual review. */
  onManualReviewRequested?: () => void;
  /** Full-screen mode for the smartphone deep-link page (no trigger button, opens immediately). */
  standalone?: boolean;
  /** Rendered only when not standalone. */
  triggerLabel?: string;
  triggerClassName?: string;
}

/** Spoken guidance shown/played during the live capture. */
const AUDIO_PROMPTS = {
  ready: "Place your face inside the oval. Look straight at the camera, keep your eyes open and hold still.",
  countdown: "Hold still. Capturing your selfie.",
} as const;

function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
}

export default function FaceVerificationFlow({ onVerified, onManualReviewRequested, standalone = false, triggerLabel = "Take a selfie", triggerClassName }: Props) {
  const [step, setStep] = useState<Step>(standalone ? "instructions" : "closed");
  const [error, setError] = useState("");
  const [resultMessage, setResultMessage] = useState("");
  const [confidence, setConfidence] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [capturedImage, setCapturedImage] = useState<{ file: File; dataUrl: string } | null>(null);
  const [handoffUrl, setHandoffUrl] = useState("");
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [permissionDenied, setPermissionDenied] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pollRef = useRef<number | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const isMobile = isMobileDevice();

  /* ----------------------------- speech guidance ------------------------ */
  const speak = useCallback((text: string) => {
    if (mutedRef.current || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.95;
      utterance.pitch = 1;
      window.speechSynthesis.speak(utterance);
    } catch { /* speech is a nice-to-have — never break the flow */ }
  }, []);

  const stopSpeaking = useCallback(() => {
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  }, []);

  useEffect(() => () => { stopSpeaking(); }, [stopSpeaking]);

  /* ------------------------------ camera mgmt --------------------------- */
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async () => {
    setPermissionDenied(false);
    setError("");
    stopCamera();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      speak(AUDIO_PROMPTS.ready);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setPermissionDenied(true);
        setError("Camera access was blocked. Allow camera access for this site in your browser settings, then try again.");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError("No camera was found on this device. Continue on your smartphone instead.");
      } else {
        setError("Unable to start the camera. Continue on your smartphone instead, or try again.");
      }
    }
  }, [speak, stopCamera]);

  useEffect(() => () => { stopCamera(); }, [stopCamera]);

  // Start (or restart) the camera whenever the flow enters the live capture
  // step — covers the first entry, "Try again" and "Retake" paths.
  useEffect(() => {
    if (step === "camera") void startCamera();
  }, [step, startCamera]);

  /* ------------------------------ handoff/QR ---------------------------- */
  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) { window.clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const checkPhoneVerification = useCallback(async () => {
    try {
      const kyc = await getMyKyc();
      if (kyc.checklist?.liveness) {
        stopPolling();
        setResultMessage("Face verification completed on your phone.");
        setStep("success");
        onVerified?.();
      }
    } catch { /* transient network errors — keep polling */ }
  }, [onVerified, stopPolling]);

  const openPhonePanel = useCallback(async () => {
    setHandoffBusy(true);
    setError("");
    try {
      const session = await createFaceHandoffSession();
      setHandoffUrl(session.url);
      setCopied(false);
      setStep("phone");
      stopPolling();
      pollRef.current = window.setInterval(() => void checkPhoneVerification(), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create the phone verification link. Continue on this device instead.");
    } finally {
      setHandoffBusy(false);
    }
  }, [checkPhoneVerification, stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  /* ------------------------------ capture ------------------------------- */
  const runCountdown = useCallback(async () => {
    speak(AUDIO_PROMPTS.countdown);
    for (const value of [3, 2, 1]) {
      setCountdown(value);
      await new Promise((resolve) => window.setTimeout(resolve, 900));
    }
    setCountdown(null);
  }, [speak]);

  const handleCapture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !streamRef.current) return;
    setBusy(true);
    try {
      await runCountdown();
      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 960;
      const canvas = document.createElement("canvas");
      // Downscale to a max edge of 1024px — plenty for face comparison, keeps
      // the stored selfie (and API payloads) small.
      const scale = Math.min(1, 1024 / Math.max(width, height));
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Unable to process the captured frame");
      // Draw the RAW frame (unmirrored) — what the user sees mirrored in the
      // live view is only a preview convenience.
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((result) => resolve(result), "image/jpeg", 0.85));
      if (!blob) throw new Error("Unable to encode the captured photo");
      const file = new File([blob], "selfie.jpg", { type: "image/jpeg" });
      const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
      stopCamera();
      stopSpeaking();
      setCapturedImage({ file, dataUrl });
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to capture the photo. Please try again.");
    } finally {
      setBusy(false);
    }
  }, [runCountdown, stopCamera, stopSpeaking]);

  /* ------------------------------- upload ------------------------------- */
  const submitSelfie = useCallback(async () => {
    if (!capturedImage) return;
    setBusy(true);
    setError("");
    setResultMessage("");
    setStep("verifying");
    try {
      const response = await verifyFaceComparison(capturedImage.file);
      setConfidence(response.faceMatch?.confidence);
      if (response.verificationStatus === "SUCCESS") {
        setResultMessage(response.message || "Face verification complete.");
        setStep("success");
        onVerified?.(response.selfieImageData);
      } else {
        setResultMessage(response.error || response.message || "We could not match your selfie to your identity record.");
        setStep("failed");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Face verification failed. Please try again.";
      setResultMessage(message);
      setConfidence(undefined);
      setStep("failed");
    } finally {
      setBusy(false);
    }
  }, [capturedImage, onVerified]);

  const submitManualReview = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const response = await requestFaceManualReview(capturedImage?.file ?? null, reviewNote);
      setResultMessage(response.message || "Your selfie has been submitted for manual review.");
      setStep("manual-review-done");
      onManualReviewRequested?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to submit for manual review. Please try again.");
      setStep("failed");
    } finally {
      setBusy(false);
    }
  }, [capturedImage, onManualReviewRequested, reviewNote]);

  /* ------------------------------- helpers ------------------------------ */
  const resetToCamera = useCallback(() => {
    setError("");
    setResultMessage("");
    setConfidence(undefined);
    setStep("camera");
  }, []);

  const closeFlow = useCallback(() => {
    stopCamera();
    stopSpeaking();
    stopPolling();
    setStep("closed");
    setCapturedImage(null);
    setError("");
    setResultMessage("");
    setConfidence(undefined);
    setCountdown(null);
  }, [stopCamera, stopPolling, stopSpeaking]);

  // Auto-close after a verified success (desktop only — standalone keeps its panel).
  useEffect(() => {
    if (step !== "success" || standalone) return;
    const timer = window.setTimeout(() => closeFlow(), 2600);
    return () => window.clearTimeout(timer);
  }, [step, standalone, closeFlow]);

  /* -------------------------------- render ------------------------------ */
  const trigger = standalone ? null : (
    <button
      type="button"
      className={triggerClassName ?? "btn-primary inline-flex min-h-[44px] w-full sm:w-auto items-center justify-center gap-2 px-5 py-3 text-sm font-bold"}
      onClick={() => { setStep("instructions"); setError(""); }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2v11z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {triggerLabel}
    </button>
  );

  if (step === "closed") return trigger;

  // NOTE: the page trigger is intentionally NOT rendered inside the open
  // overlay — a flex sibling next to the card squeezed the whole modal on
  // small screens (the "Take a selfie — verify my face" button used to sit
  // beside the dialog, breaking the layout).
  const overlayClass = standalone
    ? "relative z-10 w-full" // the /face-verify page owns the background, scroll and padding
    : "fixed inset-0 z-50 flex items-center justify-center overflow-y-auto overscroll-contain bg-slate-950/60 p-3 sm:p-6";

  const cardClass = standalone
    ? "mx-auto w-full max-w-lg rounded-2xl bg-white shadow-2xl dark:bg-slate-900"
    : "my-auto w-full max-w-lg rounded-2xl bg-white shadow-2xl dark:bg-slate-900";

  return (
    <div className={overlayClass}>
      <div className={cardClass}>
        {/* ------------------------- INSTRUCTIONS ------------------------- */}
        {step === "instructions" && (
          <div className="p-5 sm:p-7">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-velo-50 text-velo-600 dark:bg-velo-900/40 dark:text-velo-300">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                    <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2v11z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    <circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.8" />
                  </svg>
                </span>
                <div className="min-w-0">
                  <h2 className="text-lg font-bold leading-snug text-velo-900 dark:text-white">Before you take your selfie</h2>
                  <p className="mt-0.5 text-xs font-semibold text-slate-500 dark:text-slate-400">Compared with your BVN/NIN portrait</p>
                </div>
              </div>
              {!standalone && <button type="button" className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800" onClick={closeFlow} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
              </button>}
            </div>

            <p className="mt-4 rounded-xl border border-velo-100 bg-velo-50/70 px-3.5 py-2.5 text-xs leading-relaxed text-slate-600 dark:border-velo-900/50 dark:bg-velo-900/20 dark:text-slate-300">
              Follow these <strong>8 quick steps</strong> so the camera check passes on the first try — a clean capture matters.
            </p>

            <ol className="mt-3.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {CAPTURE_TIPS.map((tip, index) => (
                <li key={tip.title} className="flex items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-800/40">
                  <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-velo-600/10 text-[10px] font-extrabold text-velo-700 dark:bg-velo-300/10 dark:text-velo-300">{index + 1}</span>
                  <span className="min-w-0">
                    <span className="block text-xs font-bold leading-snug text-slate-700 dark:text-slate-200">{tip.title}</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-slate-500 dark:text-slate-400">{tip.detail}</span>
                  </span>
                </li>
              ))}
            </ol>

            {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-600 dark:bg-red-900/20 dark:text-red-300">{error}</p>}

            <div className="mt-5 space-y-2.5">
              {!isMobile && (
                <button type="button" className="btn-primary flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold" disabled={handoffBusy} onClick={() => void openPhonePanel()}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="7" y="2" width="10" height="20" rx="2" stroke="currentColor" strokeWidth="1.8" /><path d="M11 18h2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                  {handoffBusy ? "Preparing link…" : "Continue on my smartphone"}
                  <span className="ml-1 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[9px] font-extrabold uppercase text-emerald-700">Recommended</span>
                </button>
              )}
              <button
                type="button"
                className="btn-secondary flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold"
                onClick={() => { setStep("camera"); }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2v11z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.8" /></svg>
                {isMobile ? "Continue on this device" : "Continue on this computer"}
              </button>
              {isMobile && <p className="text-center text-[11px] text-slate-400">You are already on your phone — perfect for the camera check.</p>}
            </div>
          </div>
        )}

        {/* ------------------------- PHONE / QR --------------------------- */}
        {step === "phone" && (
          <div className="p-5 sm:p-7">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-velo-50 text-velo-600 dark:bg-velo-900/40 dark:text-velo-300">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="7" y="2" width="10" height="20" rx="2" stroke="currentColor" strokeWidth="1.8" /><path d="M11 18h2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                </span>
                <div className="min-w-0">
                  <h2 className="text-lg font-bold leading-snug text-velo-900 dark:text-white">Scan to verify on your phone</h2>
                  <p className="mt-0.5 text-xs font-semibold text-slate-500 dark:text-slate-400">Take the selfie there — this page stays in sync</p>
                </div>
              </div>
              {!standalone && <button type="button" className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800" onClick={closeFlow} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
              </button>}
            </div>

            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-700 dark:bg-slate-800/40">
              <div className="flex flex-col items-center">
                <div className="rounded-2xl border border-slate-200 bg-white p-2.5 shadow-sm dark:border-slate-600">
                  <QRCode value={handoffUrl} size={196} />
                </div>
                <p className="mt-2.5 text-center text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                  Open the <strong>camera app</strong> on your phone and point it at the code — then tap the link that appears.
                </p>
              </div>

              <div className="mt-3.5 border-t border-slate-200 pt-3.5 dark:border-slate-700">
                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Or copy this link into your phone browser</p>
                <div className="mt-2 flex items-center gap-2">
                  <input readOnly value={handoffUrl} className="velo-input min-w-0 flex-1 !py-2 font-mono text-[11px]" onFocus={(event) => event.currentTarget.select()} />
                  <button type="button" className="btn-secondary shrink-0 !px-3 !py-2 text-xs" onClick={async () => { try { await navigator.clipboard.writeText(handoffUrl); setCopied(true); } catch { /* clipboard unavailable */ } }}>{copied ? "Copied" : "Copy"}</button>
                </div>
                <p className="mt-1.5 text-[10px] text-slate-400">The link works for 10 minutes and only for your own verification.</p>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" /></span>
              Waiting for your phone verification…
            </div>

            {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-600 dark:bg-red-900/20 dark:text-red-300">{error}</p>}

            <div className="mt-5 space-y-2.5">
              <button type="button" className="btn-primary w-full rounded-xl px-4 py-3 text-sm font-bold" onClick={() => void checkPhoneVerification()}>I've completed verification on my phone</button>
              <div className="flex gap-2.5">
                <button type="button" className="btn-secondary flex-1 rounded-xl px-4 py-2.5 text-xs font-bold" onClick={resetToCamera}>Use this computer instead</button>
                <button type="button" className="btn-ghost flex-1 rounded-xl px-4 py-2.5 text-xs font-bold" onClick={closeFlow}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* --------------------------- CAMERA ----------------------------- */}
        {step === "camera" && (
          <div className="p-5 sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="inline-flex items-center rounded-full bg-velo-50 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-velo-700 dark:bg-velo-900/40 dark:text-velo-300">Live camera</span>
                <h2 className="mt-2 text-lg font-bold text-velo-900 dark:text-white">Fit your face inside the oval</h2>
              </div>
              <div className="flex items-center gap-1.5">
                <button type="button" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800" onClick={() => { setMuted((m) => { const next = !m; if (next) stopSpeaking(); return next; }); }} aria-label={muted ? "Unmute voice guidance" : "Mute voice guidance"} title={muted ? "Voice guidance off" : "Voice guidance on"}>
                  {muted ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M11 5L6 9H2v6h4l5 4V5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="M22 9l-6 6M16 9l6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M11 5L6 9H2v6h4l5 4V5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                  )}
                </button>
                {!standalone && <button type="button" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800" onClick={closeFlow} aria-label="Close">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                </button>}
              </div>
            </div>

            <div className="relative mt-4 overflow-hidden rounded-2xl bg-slate-900" style={{ aspectRatio: "4 / 3" }}>
              <video ref={videoRef} playsInline muted autoPlay onLoadedMetadata={() => undefined} className="h-full w-full object-cover" style={{ transform: "scaleX(-1)" }} />
              {/* Oval head guide — every part of the face must stay inside */}
              <svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" className="pointer-events-none absolute inset-0 h-full w-full">
                <ellipse cx="200" cy="150" rx="105" ry="138" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="3" strokeDasharray="10 7" />
                <ellipse cx="200" cy="150" rx="112" ry="145" fill="none" stroke="rgba(33,150,243,0.35)" strokeWidth="2" />
                <text x="200" y="292" textAnchor="middle" fill="rgba(255,255,255,0.92)" fontSize="13" fontWeight="600">Align hairline to chin inside the oval</text>
              </svg>
              {countdown !== null && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-950/40">
                  <span className="text-7xl font-black text-white drop-shadow-lg">{countdown}</span>
                </div>
              )}
              {permissionDenied && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-950/80 p-6 text-center">
                  <p className="text-sm font-semibold text-white">Camera access blocked</p>
                  <p className="text-xs text-slate-300">Allow camera access for this site in your browser settings, then tap Retry.</p>
                </div>
              )}
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 text-center text-[10px] font-semibold text-slate-500 sm:grid-cols-3 dark:text-slate-400">
              <div className="rounded-lg bg-slate-50 px-2 py-1.5 dark:bg-slate-800/60">Face the light</div>
              <div className="rounded-lg bg-slate-50 px-2 py-1.5 dark:bg-slate-800/60">Eyes open · look straight</div>
              <div className="rounded-lg bg-slate-50 px-2 py-1.5 dark:bg-slate-800/60">Hold still — no smiling</div>
            </div>

            {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-600 dark:bg-red-900/20 dark:text-red-300">{error}</p>}

            <div className="mt-4 flex items-center justify-between gap-3">
              <button type="button" className="btn-ghost !px-3 text-xs" onClick={() => { stopCamera(); stopSpeaking(); setStep("instructions"); }}>Back</button>
              <button type="button" className="btn-primary flex min-h-[46px] items-center gap-2 rounded-xl px-6 text-sm font-bold" disabled={busy || countdown !== null} onClick={() => void handleCapture()}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" /><circle cx="12" cy="12" r="3.5" fill="currentColor" /></svg>
                {busy ? "Capturing…" : "Take selfie"}
              </button>
            </div>
          </div>
        )}

        {/* --------------------------- PREVIEW ---------------------------- */}
        {step === "preview" && capturedImage && (
          <div className="p-5 sm:p-6">
            <h2 className="text-lg font-bold text-velo-900 dark:text-white">Check your selfie</h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Make sure your whole face is visible, well-lit and nothing covers it. This photo will be compared with your identity record.</p>
            <div className="mt-4 flex justify-center">
              <img src={capturedImage.dataUrl} alt="Captured selfie preview" className="max-h-72 rounded-2xl border border-slate-200 object-contain dark:border-slate-700" />
            </div>
            {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-600 dark:bg-red-900/20 dark:text-red-300">{error}</p>}
            <div className="mt-5 flex gap-3">
              <button type="button" className="btn-secondary flex-1 rounded-xl px-4 py-3 text-sm font-bold" onClick={resetToCamera}>Retake</button>
              <button type="button" className="btn-primary flex-1 rounded-xl px-4 py-3 text-sm font-bold" disabled={busy} onClick={() => void submitSelfie()}>{busy ? "Uploading…" : "Use this photo"}</button>
            </div>
          </div>
        )}

        {/* -------------------------- VERIFYING --------------------------- */}
        {step === "verifying" && (
          <div className="flex flex-col items-center justify-center gap-4 p-10 text-center">
            <svg className="animate-spin text-velo-600" width="40" height="40" viewBox="0 0 24 24" fill="none"><path d="M21 12a9 9 0 11-6.219-8.56" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            <div>
              <p className="text-sm font-bold text-velo-900 dark:text-white">Comparing your selfie…</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">We are matching it against the portrait on your BVN/NIN record. This takes a few seconds.</p>
            </div>
          </div>
        )}

        {/* --------------------------- SUCCESS ---------------------------- */}
        {step === "success" && (
          <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/40">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="#059669" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </span>
            <div>
              <p className="text-base font-bold text-velo-900 dark:text-white">Face verification complete</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{resultMessage}{typeof confidence === "number" ? ` Match confidence: ${Math.round(confidence)}%.` : ""}</p>
            </div>
            {standalone && <p className="rounded-lg bg-velo-50 px-3 py-2 text-xs font-semibold text-velo-700 dark:bg-velo-900/40 dark:text-velo-300">You can close this page and tap "I've completed verification on my phone" on your computer.</p>}
          </div>
        )}

        {/* ---------------------------- FAILED ---------------------------- */}
        {step === "failed" && (
          <div className="p-5 sm:p-6">
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M12 9v4m0 4h.01M10.3 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="#b45309" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </span>
              <div>
                <p className="text-base font-bold text-velo-900 dark:text-white">Face match didn't pass</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{resultMessage}{typeof confidence === "number" ? ` Confidence: ${Math.round(confidence)}%.` : ""}</p>
              </div>
              <div className="w-full rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-left dark:border-slate-700 dark:bg-slate-800/40">
                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Tips for the next attempt</p>
                <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
                  <li>• Move to brighter, even light and face the light source.</li>
                  <li>• Remove glasses or anything covering your face.</li>
                  <li>• Fill the oval completely, look straight ahead and hold still.</li>
                </ul>
              </div>
            </div>
            {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-600 dark:bg-red-900/20 dark:text-red-300">{error}</p>}
            <div className="mt-5 space-y-2.5">
              <button type="button" className="btn-primary w-full rounded-xl px-4 py-3 text-sm font-bold" onClick={resetToCamera}>Try again</button>
              <button type="button" className="btn-secondary w-full rounded-xl px-4 py-3 text-sm font-bold" onClick={() => { setError(""); setStep("manual-review"); }}>Submit for manual review</button>
            </div>
          </div>
        )}

        {/* ------------------------ MANUAL REVIEW ------------------------- */}
        {step === "manual-review" && (
          <div className="p-5 sm:p-6">
            <h2 className="text-lg font-bold text-velo-900 dark:text-white">Submit for manual review</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">Our team will compare your selfie with your identity record by hand and email you the outcome. You can add a short note to help the reviewer.</p>
            <textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={3} maxLength={500} placeholder="Optional note for the review team (e.g. my appearance changed since my ID photo)" className="velo-input mt-4 w-full" />
            {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-600 dark:bg-red-900/20 dark:text-red-300">{error}</p>}
            <div className="mt-4 flex gap-3">
              <button type="button" className="btn-secondary flex-1 rounded-xl px-4 py-3 text-sm font-bold" onClick={() => { setError(""); setStep("failed"); }}>Back</button>
              <button type="button" className="btn-primary flex-1 rounded-xl px-4 py-3 text-sm font-bold" disabled={busy} onClick={() => void submitManualReview()}>{busy ? "Submitting…" : "Submit for review"}</button>
            </div>
          </div>
        )}

        {step === "manual-review-done" && (
          <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-velo-100 dark:bg-velo-900/40">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="#14548b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </span>
            <div>
              <p className="text-base font-bold text-velo-900 dark:text-white">Submitted for manual review</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{resultMessage}</p>
            </div>
            {standalone && <p className="rounded-lg bg-velo-50 px-3 py-2 text-xs font-semibold text-velo-700 dark:bg-velo-900/40 dark:text-velo-300">You can close this page now — the team has your selfie.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Convenience export for tests/storybook. */
export type { FaceComparisonResult };
