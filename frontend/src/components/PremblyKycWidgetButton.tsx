import useIdentityPayKYC from "prembly-react-kyc";
import { useMemo, useState } from "react";
import { completePremblyWidgetVerification } from "../services/apiClient";
import { useAuth } from "../context/AuthContext";

interface Props {
  fullName?: string;
  email?: string;
  phone?: string;
  idType: "BVN" | "NIN";
  idNumber: string;
  dateOfBirth?: string;
  onResult: (result: { success: boolean; message: string; selfieImageData?: string }) => void;
}

function isSuccessResponse(response: { status?: string | boolean; code?: string; verification_status?: string; data?: Record<string, unknown> }): boolean {
  const candidates: unknown[] = [
    response.status,
    response.code,
    response.verification_status,
    (response.data as any)?.status,
    (response.data as any)?.code,
    (response.data as any)?.verification_status,
    (response.data as any)?.verificationStatus,
  ];
  for (const raw of candidates) {
    if (raw === true) return true;
    if (typeof raw === "string") {
      const s = raw.trim().toLowerCase();
      if (s === "success" || s === "successful" || s === "verified" || s === "pass" || s === "passed" || s === "00" || s === "ok") return true;
    }
  }
  return false;
}

function extractSelfieImage(response: { data?: Record<string, unknown> }): string | undefined {
  const d = response.data ?? {};
  const candidates: unknown[] = [
    (d as any).selfie,
    (d as any).image,
    (d as any).selfieImage,
    (d as any).selfie_image,
    (d as any).photo,
    (d as any).photograph,
    (d as any).face_image,
    (d as any).base64Image,
    (d as any).base64_image,
    (d as any).imageBase64,
    (d as any).data?.selfie,
    (d as any).data?.image,
    (d as any).data?.photo,
  ];
  for (const raw of candidates) {
    if (typeof raw !== "string" || raw.length < 20) continue;
    if (raw.startsWith("data:image")) return raw;
    if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 100) {
      const clean = raw.replace(/\s/g, "");
      return `data:image/jpeg;base64,${clean}`;
    }
  }
  return undefined;
}

export default function PremblyKycWidgetButton({ fullName, email, phone, idType, idNumber, dateOfBirth, onResult }: Props) {
  const { user } = useAuth();
  const resolvedEmail = (email ?? user?.email ?? "").trim();
  const resolvedPhone = (phone ?? user?.phone ?? "").trim();
  const normalizedPhone = resolvedPhone.replace(/[^\d+]/g, "");
  const [firstName = "", ...lastNames] = (fullName ?? user?.fullName ?? "").trim().split(/\s+/);
  const widgetId = import.meta.env.VITE_PREMBLY_WIDGET_ID;
  const widgetKey = import.meta.env.VITE_PREMBLY_WIDGET_KEY;
  const cleanId = (idNumber ?? "").replace(/[^\d]/g, "");
  const canRenderWidget = Boolean(widgetId && widgetKey && /^\d{11}$/.test(cleanId) && firstName && resolvedEmail && normalizedPhone);
  const [sending, setSending] = useState(false);
  const [lastError, setLastError] = useState<string | undefined>(undefined);

  const verifyWithPrembly = useIdentityPayKYC(useMemo(() => ({
    first_name: firstName,
    last_name: lastNames.join(" "),
    email: resolvedEmail,
    phone: normalizedPhone,
    widget_key: widgetKey ?? "",
    widget_id: widgetId ?? "",
    metadata: { id_type: idType, id_number: cleanId, date_of_birth: dateOfBirth ?? "" },
    callback: (response: { status?: string | boolean; code?: string; message?: string; verification_status?: string; data?: Record<string, unknown> }) => {
      const success = isSuccessResponse(response);
      const selfie = extractSelfieImage(response);
      setSending(true);
      setLastError(undefined);
      void completePremblyWidgetVerification({
        status: success ? "SUCCESS" : "FAILED",
        providerReference: typeof (response.data as any)?.reference === "string" ? (response.data as any).reference : typeof (response.data as any)?.provider_reference === "string" ? (response.data as any).provider_reference : undefined,
        rawResponse: response,
        selfieImageData: selfie,
      }).then((res: any) => {
        const finalSelfie = selfie ?? (res as any)?.selfieImageData;
        onResult({
          success,
          message: success
            ? "Live selfie scan completed and verified."
            : (typeof response.message === "string" && response.message.trim().length ? response.message : (typeof (response.data as any)?.message === "string" ? (response.data as any).message : "Liveness verification was not completed. Please try again with good lighting.")),
          selfieImageData: finalSelfie,
        });
      }).catch((error) => {
        setLastError(error instanceof Error ? error.message : "Unable to save identity verification.");
        onResult({ success: false, message: error instanceof Error ? error.message : "Unable to save identity verification." });
      }).finally(() => {
        setSending(false);
      });
    },
  }), [cleanId, dateOfBirth, firstName, idType, lastNames, normalizedPhone, onResult, resolvedEmail, widgetId, widgetKey]));

  if (!widgetId || !widgetKey) {
    return (
      <button type="button" className="btn-secondary w-full sm:w-auto" disabled title="Prembly widget credentials missing from environment.">
        <span className="inline-flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 9v4m0 4h.01M10.3 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Widget not configured
        </span>
      </button>
    );
  }
  if (!/^\d{11}$/.test(cleanId)) {
    return (
      <button type="button" className="btn-secondary w-full sm:w-auto" disabled title="Verify BVN or NIN first before starting liveness scan.">
        <span className="inline-flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Complete BVN / NIN verification first
        </span>
      </button>
    );
  }
  function handleStart() {
    if (!canRenderWidget) {
      setLastError("Verified BVN/NIN details are not available yet. Refresh the verification details and try again.");
      return;
    }
    setSending(true);
    setLastError(undefined);
    try {
      verifyWithPrembly();
    } catch (error) {
      setSending(false);
      setLastError(error instanceof Error ? error.message : "Unable to start the liveness check.");
    }
  }

  return (
    <div className="w-full space-y-2">
      <button
        type="button"
        onClick={handleStart}
        disabled={sending}
        className="btn-primary inline-flex min-h-[44px] w-full sm:w-auto items-center justify-center gap-2 px-5 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
      >
        {sending ? (
          <>
            <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 12a9 9 0 11-6.219-8.56" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            Saving verification…
          </>
        ) : (
          <>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2v11z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Start Live Selfie Scan
          </>
        )}
      </button>
      {!canRenderWidget && !lastError && <p className="text-xs text-slate-500">Loading verified identity details for the secure camera check.</p>}
      {lastError && <p className="break-words text-xs font-medium text-red-600">{lastError}</p>}
    </div>
  );
}
