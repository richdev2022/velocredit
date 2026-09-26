import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import FaceVerificationFlow from "../components/FaceVerificationFlow";
import { claimFaceHandoffToken, getMyKyc, setAccessToken } from "../services/apiClient";

/* ==========================================================================
   /face-verify?ht=<token> — smartphone landing page for the face hand-off.

   The desktop KYC flow shows this link as a QR code. Opening it here:
     1. exchanges the short-lived handoff token for a session token
        (no password needed on the phone),
     2. checks whether the face check already passed,
     3. runs the exact same selfie capture + comparison flow.
   ========================================================================== */

type Phase = "claiming" | "ready" | "already-done" | "invalid";

export default function FaceVerifyHandoff() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("ht") ?? "";
  const [phase, setPhase] = useState<Phase>("claiming");
  const [error, setError] = useState("");
  const [userName, setUserName] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setPhase("invalid");
        setError("This link is missing its verification code. Start again from your computer.");
        return;
      }
      try {
        const claimed = await claimFaceHandoffToken(token);
        if (cancelled) return;
        setAccessToken(claimed.accessToken);
        setUserName(claimed.user.fullName);
        try {
          const kyc = await getMyKyc();
          if (kyc.checklist?.liveness) { setPhase("already-done"); return; }
        } catch { /* fall through to the capture flow */ }
        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        setPhase("invalid");
        setError(err instanceof Error ? err.message : "This link has expired. Start again from your computer.");
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-950">
      <div className="mx-auto max-w-lg px-4 pt-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-velo-600 text-sm font-black text-white">V</span>
          <div>
            <p className="text-sm font-extrabold tracking-tight text-velo-900 dark:text-white">Velo Finance</p>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Face verification</p>
          </div>
        </div>
      </div>

      {phase === "claiming" && (
        <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-4 text-center">
          <svg className="animate-spin text-velo-600" width="36" height="36" viewBox="0 0 24 24" fill="none"><path d="M21 12a9 9 0 11-6.219-8.56" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">Preparing your face verification…</p>
        </div>
      )}

      {phase === "invalid" && (
        <div className="mx-4 mt-10 rounded-2xl bg-white p-8 text-center shadow-xl dark:bg-slate-900">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/40">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M12 9v4m0 4h.01M10.3 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="#b91c1c" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <p className="mt-4 text-base font-bold text-velo-900 dark:text-white">Link unavailable</p>
          <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{error}</p>
        </div>
      )}

      {phase === "already-done" && (
        <div className="mx-4 mt-10 rounded-2xl bg-white p-8 text-center shadow-xl dark:bg-slate-900">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/40">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="#059669" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <p className="mt-4 text-base font-bold text-velo-900 dark:text-white">You're already verified</p>
          <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">Your face verification is complete. You can close this page and continue on your computer.</p>
        </div>
      )}

      {phase === "ready" && (
        <div className="mt-6 pb-10">
          <p className="mb-4 px-4 text-center text-xs text-slate-500 dark:text-slate-400">
            {userName ? `Hi ${userName.split(" ")[0]} — ` : ""}take your selfie here, then return to your computer to finish.
          </p>
          <FaceVerificationFlow standalone onVerified={() => setPhase("already-done")} />
        </div>
      )}
    </div>
  );
}
