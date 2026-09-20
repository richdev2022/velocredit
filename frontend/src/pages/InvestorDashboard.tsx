import { useEffect, useDeferredValue, useMemo, useRef, useState, memo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import Layout from "../components/Layout";
import PremblyKycWidgetButton from "../components/PremblyKycWidgetButton";
import ReceiptPrint from "../components/ReceiptDownload";
import OtpLoginSettings from "../components/OtpLoginSettings";
import InvestorWithdrawalForm from "../components/InvestorWithdrawalForm";
import ProfileSettings from "../components/ProfileSettings";
import { useAuth } from "../context/AuthContext";
import {
  fundWallet,
  getInvestorDashboard,
  getInvestmentPlans,
  getMyKyc,
  getInvestorTransactions,
  uploadKycDocument,
  verifyMyBvn,
  verifyMyNin,
  verifyMyLiveness,
  updateMyKyc,
  verifyWalletFunding,
  confirmKycOwnershipOtp,
  resendKycOwnershipOtp,
  type KycOtpChallenge,
  initializeLoanRepayment,
  createInvestment,
  getAccessToken,
  refreshInvestorWithdrawalStatuses,
} from "../services/apiClient";
import { config } from "../utils/config";
import { documentDownloadUrl, documentPreviewUrl } from "../utils/documentLinks";
import Icon from "../components/Icon";

const money = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
  maximumFractionDigits: 0,
});
type DashboardData = {
  wallet?: { availableMinor?: number; heldMinor?: number };
  investments?: Array<{
    amountNaira?: number;
    expectedEarningsNaira?: number;
    tenureDays?: number;
    annualRatePercent?: number;
    startsAt?: string;
    maturesAt?: string;
    status?: string;
    accrual?: { dailyEarningsNaira?: number; accruedEarningsNaira?: number; expectedEarningsNaira?: number; elapsedDays?: number; remainingDays?: number; isMatured?: boolean };
    expectedInterestMinor?: number;
    expectedInterestNaira?: number;
  }>;
};
type TransactionData = {
  payouts?: Array<Record<string, unknown>>;
  investments?: Array<Record<string, unknown>>;
  ledger?: Array<Record<string, unknown>>;
  walletTransactions?: Array<Record<string, unknown>>;
};
type KycData = {
  status?: string;
  bvn?: string;
  nin?: string;
  checklist?: { bvn?: boolean; nin?: boolean; proofOfAddress?: boolean; passport?: boolean; signature?: boolean; selfieUploaded?: boolean; liveness?: boolean };
  categoryResults?: Record<string, { status?: string; reason?: string }>;
  rejectionReason?: string;
  verifiedDetails?: Record<string, unknown>;
  identityPhoto?: string;
  documents?: Array<{ id?: string; documentType?: string; fileName?: string; mimeType?: string; sizeBytes?: number; status?: string; createdAt?: string; uploadedAt?: string; provider?: string; providerFileId?: string; previewUrl?: string; downloadUrl?: string }>;
};
type Plan = { id: string; name: string; tenureDays: number; annualRatePercent: number; minAmountNaira: number; maxAmountNaira?: number };

type InvestorView = "overview" | "wallet" | "investments" | "kyc" | "transactions" | "payout" | "profile";

type UnifiedTx = {
  id: string;
  kind: "FUNDING" | "INVESTMENT_LOCK" | "INVESTMENT_RETURN" | "INVESTMENT" | "PAYOUT" | "DEPOSIT" | "FEE" | "OTHER";
  direction: "CREDIT" | "DEBIT";
  amountMinor: number;
  label: string;
  narration?: string;
  referenceId?: string;
  createdAt: string;
  balanceAfterMinor?: number;
  raw: Record<string, unknown>;
};

export default function InvestorDashboard() {
  const { user, addUserRole, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null as DashboardData | null);
  const [transactions, setTransactions] = useState(null as TransactionData | null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState<{ text: string; type: "success" | "error" | "info" } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  function showToast(text: string, type: "success" | "error" | "info" = "success") {
    setToast({ text, type });
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 5000);
  }
  const [switchingBusy, setSwitchingBusy] = useState(false);
  const [switchMsg, setSwitchMsg] = useState("");
  const [kyc, setKyc] = useState(null as KycData | null);
  const [kycBusy, setKycBusy] = useState("");
  const [kycError, setKycError] = useState("");
  const [bvn, setBvn] = useState("");
  const [nin, setNin] = useState("");
  const [action, setAction] = useState("" as "plans" | "");
  const [fundingAmount, setFundingAmount] = useState("100000");
  const [plans, setPlans] = useState([] as Plan[]);
  const [fundingBanner, setFundingBanner] = useState(null as { ok: boolean; text: string } | null);
  const [view, setView] = useState(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    const v = params.get("view") as InvestorView | null;
    const valid: InvestorView[] = ["overview", "wallet", "investments", "kyc", "transactions", "payout", "profile"];
    return v && valid.includes(v) ? v : "overview";
  });

  useEffect(() => {
    const params = new URLSearchParams();
    if (view !== "overview") params.set("view", view);
    const hash = params.toString();
    const target = hash ? `#${hash}` : "#";
    if (window.location.hash !== target) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${target}`);
    }
  }, [view]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const investorMenu: Array<{ key: InvestorView; label: string; icon: string; hint?: string }> = [
    { key: "overview", label: "Overview", icon: "grid", hint: "Summary & KPIs" },
    { key: "wallet", label: "Wallet", icon: "wallet", hint: "Fund & withdraw" },
    { key: "investments", label: "Investments", icon: "chart", hint: "Plans & positions" },
    { key: "kyc", label: "Verification", icon: "check", hint: "BVN / NIN / Liveness" },
    { key: "transactions", label: "Transactions", icon: "document", hint: "Transactions & history" },
    { key: "payout", label: "Payout account", icon: "bank", hint: "Bank details" },
    { key: "profile", label: "Profile", icon: "user", hint: "Personal information" },
  ];
  const [otpMethodPickerFor, setOtpMethodPickerFor] = useState(null as "BVN" | "NIN" | null);
  const [otpPickerState, setOtpPickerState] = useState<{ phase: "idle" | "sending" | "success" | "error"; channel?: "SMS" | "WHATSAPP"; message?: string }>({ phase: "idle" });
  const [activeOtpChallenge, setActiveOtpChallenge] = useState(null as null | {
      idType: "BVN" | "NIN";
      challenge: KycOtpChallenge;
      otpCode: string;
      cooldown: number;
      error?: string;
      busy?: boolean;
    });
  const countdownRef = useRef(null as number | null);
  const livenessPollRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (countdownRef.current != null) window.clearInterval(countdownRef.current);
      if (livenessPollRef.current != null) window.clearInterval(livenessPollRef.current);
    };
  }, []);

  const [fundModalOpen, setFundModalOpen] = useState(false);
  const [fundModalAmount, setFundModalAmount] = useState("100000");
  const [fundModalBusy, setFundModalBusy] = useState(false);
  const [investModalOpen, setInvestModalOpen] = useState(false);
  const [investModalPlan, setInvestModalPlan] = useState(null as Plan | null);
  const [investModalAmount, setInvestModalAmount] = useState("");
  const [investModalBusy, setInvestModalBusy] = useState(false);
  const [selectedTx, setSelectedTx] = useState(null as UnifiedTx | null);

  useEffect(() => {
    const fundingStatus = searchParams.get("funding");
    const txRef = searchParams.get("tx_ref");
    const qMessage = searchParams.get("message");
    if (fundingStatus) {
      if (fundingStatus === "success") {
        setFundingBanner({ ok: true, text: qMessage?.trim() || "Wallet was credited successfully. Your balance below reflects the update." });
      } else if (fundingStatus === "failed") {
        setFundingBanner({ ok: false, text: qMessage?.trim() || "Funding was not completed. Try again or contact support." });
      }
      const transactionId = searchParams.get("transaction_id");
      if (transactionId) {
        verifyWalletFunding(transactionId).then((res) => {
          if (res.ok) {
            setFundingBanner({ ok: true, text: "Wallet funding confirmed. Your balance was refreshed." });
          } else if (!fundingBanner) {
            setFundingBanner({ ok: false, text: res.reason || "Funding could not be confirmed at this time. Your balance will update once the provider confirms." });
          }
          Promise.all([getInvestorDashboard(), getInvestorTransactions(), getMyKyc(), getInvestmentPlans()])
            .then(([dashboard, history, kycResponse, plansRes]) => {
              setData(dashboard as DashboardData);
              setTransactions(history as unknown as TransactionData);
              setKyc(kycResponse as unknown as KycData);
              setBvn((kycResponse as any).bvn || "");
              setNin((kycResponse as any).nin || "");
              setPlans((plansRes as any)?.plans || []);
            })
            .catch(() => undefined);
        }).catch(() => undefined);
      }
      const clean = new URLSearchParams(searchParams);
      clean.delete("funding");
      clean.delete("tx_ref");
      clean.delete("message");
      clean.delete("transaction_id");
      clean.delete("status");
      clean.delete("flw_ref");
      setSearchParams(clean, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!user) return;
    Promise.all([getInvestorDashboard(), getInvestorTransactions(), getMyKyc(), getInvestmentPlans()])
      .then(([dashboard, history, kycResponse, plansRes]) => {
        setData(dashboard as DashboardData);
        setTransactions(history as unknown as TransactionData);
        setKyc(kycResponse as unknown as KycData);
        setBvn((kycResponse as any).bvn || "");
        setNin((kycResponse as any).nin || "");
        setPlans((plansRes as any)?.plans || []);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Unable to load investor data")
      );
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const refreshWithdrawalState = async () => {
      try {
        const response = await refreshInvestorWithdrawalStatuses();
        if (cancelled || !response.withdrawals?.length) return;
        const [dashboard, history] = await Promise.all([getInvestorDashboard(), getInvestorTransactions()]);
        if (!cancelled) {
          setData(dashboard as DashboardData);
          setTransactions(history as unknown as TransactionData);
        }
      } catch (_error) {
        // Background provider verification must not interrupt the dashboard.
      }
    };
    void refreshWithdrawalState();
    const withdrawalInterval = window.setInterval(() => void refreshWithdrawalState(), 15000);
    const refreshKycState = async () => {
      try {
        const response = await getMyKyc();
        if (cancelled) return;
        setKyc(response as unknown as KycData);
        setBvn((response as any).bvn || "");
        setNin((response as any).nin || "");
        if (response.status !== user.kycStatus) await refreshUser();
      } catch (_error) {
        // Background refresh must not interrupt the dashboard.
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshKycState();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const interval = window.setInterval(() => void refreshKycState(), 5000);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(interval);
      window.clearInterval(withdrawalInterval);
    };
  }, [user]);

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

  async function verifyIdentity(type: "BVN" | "NIN") {
    const value = type === "BVN" ? bvn : nin;
    if (!/^\d{11}$/.test(value)) {
      setKycError(`${type} must be exactly 11 digits.`);
      return;
    }
    setOtpPickerState({ phase: "idle" });
    setOtpMethodPickerFor(type);
  }

  async function verifyIdentityWithChannel(type: "BVN" | "NIN", channel: "SMS") {
    const value = type === "BVN" ? bvn : nin;
    setOtpPickerState({ phase: "sending", channel });
    setKycBusy(type);
    setKycError("");
    setActiveOtpChallenge(null);
    try {
      const names = (user?.fullName ?? "").trim().split(/\s+/);
      const response = type === "BVN"
        ? await verifyMyBvn(value, names[0], names.slice(1).join(" "), undefined, channel)
        : await verifyMyNin(value, names[0], names.slice(1).join(" "), undefined, channel);
      const challenge = (response as any)?.otpChallenge as KycOtpChallenge | undefined;
      if (challenge && challenge.requiresPhoneVerification) {
        setActiveOtpChallenge({ idType: type, challenge, otpCode: "", cooldown: challenge.resendSecondsRemaining });
        setKycError(`A verification code was sent to the phone number from ${type} records ending in ···${challenge.phoneLastFour}. Enter the code to confirm ownership.`);
        setKycBusy("");
        setOtpMethodPickerFor(null);
        setOtpPickerState({ phase: "idle" });
        return;
      }
      const details = (response as any).verifiedDetails ?? {};
      const photoRaw = details?.identityPhoto || details?.base64Image || details?.photo || undefined;
      const normalizedPhoto = typeof photoRaw === "string" && photoRaw.length > 20
        ? photoRaw.startsWith("data:") ? photoRaw : photoRaw.startsWith("http") ? photoRaw : `data:image/jpeg;base64,${photoRaw.replace(/\s/g, "")}`
        : undefined;
      if (response.verificationStatus === "SUCCESS") {
        setOtpPickerState({ phase: "success", channel, message: `${type} phone matches your registered account — ownership confirmed automatically. No code required.` });
        setKyc((current) => ({
          ...current,
          status: response.status,
          checklist: response.checklist as unknown as KycData["checklist"],
          verifiedDetails: Object.keys(details).length ? details : current?.verifiedDetails,
          identityPhoto: normalizedPhoto || current?.identityPhoto,
        }));
        await refreshUser();
        const msg = `${type} verification completed successfully.`;
        setMessage(msg); showToast(msg, "success");
        window.setTimeout(() => {
          setOtpMethodPickerFor(null);
          setOtpPickerState({ phase: "idle" });
          setKycBusy("");
        }, 1700);
      } else {
        const status = (response as any).error || "Verification failed";
        setKycError(status);
        showToast(status, "error");
        setOtpPickerState({ phase: "error", channel, message: status });
        setKycBusy("");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Unable to verify ${type}`;
      setKycError(msg);
      showToast(msg, "error");
      setOtpPickerState({ phase: "error", channel, message: msg });
      setKycBusy("");
    }
  }

  async function submitActiveKycOtp() {
    if (!activeOtpChallenge || activeOtpChallenge.otpCode.length !== 6) return;
    setActiveOtpChallenge((current) => current ? { ...current, busy: true, error: undefined } : current);
    try {
      const confirmed = await confirmKycOwnershipOtp({ idType: activeOtpChallenge.idType, challengeId: activeOtpChallenge.challenge.challengeId, code: activeOtpChallenge.otpCode });
      setKyc((current) => ({ ...current, status: confirmed.status ?? current?.status, checklist: confirmed.checklist as unknown as KycData["checklist"] }));
      await refreshUser();
      const msg = `${activeOtpChallenge.idType} ownership verified. Thank you.`;
      setMessage(msg); showToast(msg, "success");
      setKycError("");
      setActiveOtpChallenge(null);
    } catch (err) {
        const reason = err instanceof Error ? err.message : "Unable to verify code";
        setActiveOtpChallenge((current) => current ? { ...current, busy: false, error: reason, otpCode: "" } : current);
        setKycError(reason);
        showToast(reason, "error");
    }
  }

  async function resendActiveKycOtp(newChannel?: "SMS") {
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

  async function uploadProofOfAddress(file: File) {
    setKycBusy("PROOF_OF_ADDRESS");
    setKycError("");
    try {
      const response = await uploadKycDocument("PROOF_OF_ADDRESS", file);
      setKyc((current) => ({ ...current, checklist: response.checklist as unknown as KycData["checklist"], documents: [...(current?.documents || []).filter((doc) => doc.documentType !== "PROOF_OF_ADDRESS"), response.document] }));
      setMessage("Proof of address uploaded. Awaiting admin approval. Submit KYC when BVN and NIN are verified.");
      showToast("Proof of address uploaded. Awaiting admin approval.", "info");
    } catch (err) {
      setKycError(err instanceof Error ? err.message : "Unable to upload proof of address");
    } finally {
      setKycBusy("");
    }
  }

  async function uploadSignature(file: File) {
    setKycBusy("SIGNATURE");
    setKycError("");
    try {
      const response = await uploadKycDocument("SIGNATURE", file);
      setKyc((current) => ({ ...current, checklist: response.checklist as unknown as KycData["checklist"], documents: [...(current?.documents || []).filter((doc) => doc.documentType !== "SIGNATURE"), response.document] }));
      setMessage("Signature uploaded. Awaiting admin approval.");
      showToast("Signature uploaded successfully. Awaiting admin approval.", "info");
    } catch (err) {
      setKycError(err instanceof Error ? err.message : "Unable to upload signature");
    } finally {
      setKycBusy("");
    }
  }

  async function submitAddressReview() {
    if (!kyc?.checklist?.bvn || !kyc.checklist.nin) return;
    if (!(kyc as any)?.proofOfAddressDocumentUrl || !(kyc as any)?.signatureDocumentUrl) {
      const msg = "Please upload your proof of address and signature before submitting.";
      setKycError(msg);
      showToast(msg, "error");
      return;
    }
    setBusy(true);
    setKycError("");
    try {
      const response = await import("../services/apiClient").then(({ submitKyc }) => submitKyc());
      setKyc((current) => ({ ...current, status: response.status, checklist: response.checklist as unknown as KycData["checklist"] }));
      await refreshUser();
      const msg = response.message || "KYC documents submitted for verification and admin review.";
      setMessage(msg);
      showToast(msg, "success");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unable to submit KYC documents";
      setKycError(errMsg);
      showToast(errMsg, "error");
    } finally {
      setBusy(false);
    }
  }

  async function uploadSelfieFallback(file: File) {
    setKycBusy("LIVENESS_SELFIE");
    setKycError("");
    try {
      const idNumber = bvn || nin || "";
      const idType = bvn && /^\d{11}$/.test(bvn) ? "BVN" : nin && /^\d{11}$/.test(nin) ? "NIN" : undefined;
      if (!idType || !/^\d{11}$/.test(idNumber || "")) {
        throw new Error("Verify your BVN or NIN first before uploading a selfie.");
      }
      const response = await verifyMyLiveness(file, { idType, idNumber });
      setKyc((current: any) => current ? ({ ...current, status: response.status, checklist: response.checklist as unknown as KycData["checklist"], selfieImageData: (response as any).selfieImageData || current?.selfieImageData, livenessStatus: (response as any).verificationStatus || current?.livenessStatus }) : current);
      await refreshUser();
      const msg = (response as any).message || "Selfie uploaded successfully. An admin will review your liveness check shortly.";
      setMessage(msg);
      showToast(msg, "info");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Liveness selfie upload failed.";
      setKycError(errMsg);
      showToast(errMsg, "error");
    } finally {
      setKycBusy("");
    }
  }

  /*
  async function verifyLivenessFile(file: File) {
    setKycBusy("LIVENESS_FILE");
    setKycError("");
    try {
      const idNumber = bvn || nin || "";
      const idType = bvn && /^\d{11}$/.test(bvn) ? "BVN" : nin && /^\d{11}$/.test(nin) ? "NIN" : undefined;
      const response = await verifyMyLiveness(file, { idType, idNumber });
      setKyc((current) => current ? ({ ...current, status: response.status, checklist: response.checklist as unknown as KycData["checklist"] }) : current);
      await refreshUser();
      setMessage("Liveness check completed.");
    } catch (err) {
      setKycError(err instanceof Error ? err.message : "Liveness check failed. Try again or use the camera widget.");
    } finally {
      setKycBusy("");
    }
  }
  */

  async function onPremblyLivenessResult(result: any) {
    if (result.success) {
      setMessage("Liveness scan submitted. Syncing with the provider — your KYC status will update within 60 seconds.");
      showToast("Liveness scan completed. Status is syncing with the provider and will update shortly.", "success");
      if (typeof result?.selfieImageData === "string" && result.selfieImageData.length > 20) {
        setKyc((current: any) => current ? ({ ...current, selfieImageData: result.selfieImageData }) : current);
      }
      let attempts = 0;
      const maxAttempts = 12;
      if (livenessPollRef.current != null) window.clearInterval(livenessPollRef.current);
      const poll = window.setInterval(async () => {
        attempts += 1;
        try {
          const updated = await getMyKyc();
          const checklist = (updated as any)?.checklist ?? {};
          setKyc(updated as unknown as KycData);
          await refreshUser();
          if (checklist.liveness || checklist.selfieUploaded || attempts >= maxAttempts) {
            window.clearInterval(poll);
            livenessPollRef.current = null;
            const msg = checklist.liveness ? "Liveness verified. Thank you." : "Liveness processing complete. If status hasn't updated yet, refresh in a minute.";
            setMessage(msg);
            if (checklist.liveness) showToast(msg, "success");
          }
        } catch (_e) { /* ignore */ }
      }, 5000);
      livenessPollRef.current = poll;
    } else {
      setKycError(result.message);
      showToast(result.message || "Liveness verification was not completed.", "error");
    }
  }

  async function openAction(nextAction: "plans") {
    setAction(nextAction);
  }

  async function openFundModal() {
    setFundModalAmount(fundingAmount || "100000");
    setFundModalOpen(true);
  }

  async function handleFundModalSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amt = Number(fundModalAmount);
    if (!Number.isFinite(amt) || amt < 1000) {
      setError("Minimum funding amount is ₦1,000.");
      return;
    }
    setFundModalBusy(true);
    setError("");
    try {
      const response = await fundWallet(amt);
      const link = response.checkout?.data?.link;
      if (link) {
        setFundingAmount(String(amt));
        window.location.assign(link);
      } else {
        setMessage(response.message || "Wallet funding is being processed.");
        setFundModalOpen(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start wallet funding");
    } finally {
      setFundModalBusy(false);
    }
  }

  function openInvestModal(plan: Plan) {
    setInvestModalPlan(plan);
    setInvestModalAmount(String(plan.minAmountNaira || 10000));
    setInvestModalOpen(true);
  }

  async function handleInvestModalSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!investModalPlan) return;
    const amt = Number(investModalAmount);
    if (!Number.isFinite(amt)) { setError("Enter a valid amount."); return; }
    if (investModalPlan.minAmountNaira && amt < investModalPlan.minAmountNaira) {
      setError(`Minimum investment is ₦${Number(investModalPlan.minAmountNaira).toLocaleString()}.`);
      return;
    }
    if (investModalPlan.maxAmountNaira && amt > investModalPlan.maxAmountNaira) {
      setError(`Maximum investment is ₦${Number(investModalPlan.maxAmountNaira).toLocaleString()}.`);
      return;
    }
    setInvestModalBusy(true);
    setError("");
    try {
      await createInvestment({ planId: investModalPlan.id, amountNaira: amt });
      setMessage(`Investment of ₦${amt.toLocaleString("en-NG")} created successfully!`);
      setInvestModalOpen(false);
      setInvestModalPlan(null);
      const [dashboard, history] = await Promise.all([getInvestorDashboard(), getInvestorTransactions()]);
      setData(dashboard as DashboardData);
      setTransactions(history as unknown as TransactionData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create investment");
    } finally {
      setInvestModalBusy(false);
    }
  }

  const wallet = data?.wallet;
  const investments = data?.investments ?? [];
  const available = Number(wallet?.availableMinor ?? 0) / 100;
  const locked = Number(wallet?.heldMinor ?? 0) / 100;
  const returns = investments.reduce(
    (sum, item) =>
      sum +
      Number(item.expectedEarningsNaira ?? item.accrual?.expectedEarningsNaira ?? item.expectedInterestNaira ?? Number(item.expectedInterestMinor ?? 0) / 100),
    0
  );
  const totalCapital = available + locked;
  const activeCount = investments.filter((investment) => ["ACTIVE", "PENDING"].includes(String((investment as { status?: string }).status))).length;
  const returnRate = totalCapital ? Math.min(100, Math.round((returns / totalCapital) * 100)) : 0;

  const hasBothRoles = user?.roles.includes("INVESTOR") && user?.roles.includes("BORROWER");
  const checklist = kyc?.checklist ?? {};
  const canSubmitAddressReview = Boolean(checklist.bvn && checklist.nin && (kyc as any)?.proofOfAddressDocumentUrl && (kyc as any)?.signatureDocumentUrl);
  const onboardingRequirements = [
    ["Identity info", "Legal name, DOB, contact", Boolean(checklist.bvn || checklist.nin)],
    ["BVN verification", "11-digit bank verification", Boolean(checklist.bvn)],
    ["NIN verification", "National ID number check", Boolean(checklist.nin)],
    ["Proof of address", "Utility bill or statement", Boolean(checklist.proofOfAddress)],
    ["Payout account", "Bank account for returns", Boolean((data as any)?.payoutAccount?.status === "VERIFIED")],
  ] as const;
  const completedOnboardingRequirements = onboardingRequirements.filter(([, , completed]) => completed).length;

  async function handleEnableBorrower() {
    setSwitchingBusy(true);
    setSwitchMsg("");
    setError("");
    try {
      await addUserRole("BORROWER");
      setSwitchMsg("Borrower access enabled! Redirecting…");
      setTimeout(() => navigate("/borrower"), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to enable borrower access");
    } finally {
      setSwitchingBusy(false);
    }
  }

  return (
    <Layout>
      {toast && (
        <div className="fixed top-4 right-4 z-[100] min-w-[280px] max-w-md animate-fade-in">
          <div className={`rounded-2xl shadow-2xl border px-4 py-3 flex items-start gap-3 ${
            toast.type === "success"
              ? "bg-emerald-50 text-emerald-900 border-emerald-200 dark:bg-emerald-900/80 dark:text-emerald-100 dark:border-emerald-700"
              : toast.type === "error"
              ? "bg-red-50 text-red-900 border-red-200 dark:bg-red-900/80 dark:text-red-100 dark:border-red-700"
              : "bg-sky-50 text-sky-900 border-sky-200 dark:bg-sky-900/80 dark:text-sky-100 dark:border-sky-700"
          }`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="shrink-0 mt-0.5">
              {toast.type === "success" ? (
                <path d="M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              ) : toast.type === "error" ? (
                <><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.2" /><path d="M15 9l-6 6M9 9l6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></>
              ) : (
                <><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.2" /><path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></>
              )}
            </svg>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold leading-5">{toast.text}</div>
            </div>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="shrink-0 opacity-70 hover:opacity-100 transition"
              aria-label="Dismiss notification"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>
        </div>
      )}
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-40 bg-slate-900/50 backdrop-blur-sm lg:hidden animate-fade-in"
        />
      )}

      <div className="flex flex-col lg:flex-row gap-4 sm:gap-6 min-h-[calc(100vh-10rem)]">
        <aside
          className={`fixed lg:static z-50 top-0 left-0 h-full w-80 max-w-[86vw] lg:w-72 shrink-0 lg:h-auto transition-transform duration-300 ease-out lg:transform-none ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="lg:hidden absolute top-4 right-4 z-10">
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close sidebar"
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-white/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 shadow-sm hover:bg-white dark:hover:bg-slate-800 transition"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <div className="velo-card p-4 sm:p-5 rounded-2xl lg:rounded-2xl border-0 dark:border-slate-800 shadow-[0_20px_60px_-20px_rgba(16,185,129,0.12)] dark:shadow-none lg:sticky top-4 overflow-hidden bg-gradient-to-br from-emerald-50 via-white to-white dark:from-slate-900 dark:via-slate-900 dark:to-slate-900 relative lg:h-[calc(100vh-2rem)] h-screen lg:min-h-0">
            <div className="absolute -top-12 -right-12 w-40 h-40 rounded-full bg-emerald-400/20 blur-3xl pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-32 h-32 rounded-full bg-velo-400/10 blur-3xl pointer-events-none" />
            <div className="relative overflow-y-auto lg:overflow-y-auto lg:max-h-full max-h-screen pb-20 lg:pb-4 pr-1">
              <div className="flex items-center gap-3 p-3 rounded-2xl bg-white/60 dark:bg-slate-800/60 border border-emerald-100/70 dark:border-slate-700/60 backdrop-blur">
                <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-600 text-white font-black text-lg shadow-md shadow-emerald-500/30">
                  {user?.fullName?.charAt(0)?.toUpperCase() || "V"}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-velo-900 dark:text-white truncate">
                    {user?.fullName || "Investor"}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                    {user?.email || "Welcome aboard"}
                  </div>
                </div>
              </div>

              <nav className="mt-5 sm:mt-6 space-y-1">
                {investorMenu.map((item) => {
                  const active = view === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => { setView(item.key); setMessage(""); setError(""); setSidebarOpen(false); setSelectedTx(null); }}
                      className={`w-full group flex items-center gap-3 px-3.5 py-2.5 sm:py-3 rounded-xl transition-all duration-200 text-left ${
                        active
                          ? "bg-gradient-to-r from-emerald-500 to-emerald-600 text-white shadow-md shadow-emerald-500/25 hover:shadow-lg hover:shadow-emerald-500/30"
                          : "text-slate-600 dark:text-slate-300 hover:bg-emerald-50 dark:hover:bg-slate-800/60 hover:text-velo-900 dark:hover:text-white"
                      }`}
                    >
                      <span className={`text-xl shrink-0 ${active ? "" : "opacity-90"}`}><MenuIcon name={item.icon} /></span>
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-bold ${active ? "" : "group-hover:font-extrabold"}`}>{item.label}</div>
                        {item.hint && (
                          <div className={`text-[10px] truncate ${active ? "text-emerald-50/90" : "text-slate-500 dark:text-slate-400"}`}>{item.hint}</div>
                        )}
                      </div>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className={`shrink-0 transition-transform ${active ? "text-white translate-x-0.5" : "text-slate-400 group-hover:translate-x-0.5"}`}>
                        <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  );
                })}
              </nav>

              <div className="mt-6 sm:mt-8 pt-4 sm:pt-5 border-t border-emerald-100/80 dark:border-slate-800">
                <div className="rounded-2xl bg-gradient-to-br from-emerald-600 to-emerald-700 text-white p-4 shadow-lg shadow-emerald-600/20">
                  <div className="text-[11px] uppercase tracking-wider font-bold text-emerald-100/85">KYC status</div>
                  <div className="mt-1 inline-flex items-center gap-2 text-lg font-black">
                    {user?.kycStatus === "VERIFIED" ? <><Icon name="check" size={18} />Verified</> : user?.kycStatus === "PENDING_VERIFICATION" ? <><Icon name="clock" size={18} />Reviewing</> : <><Icon name="lock" size={18} />Action needed</>}
                  </div>
                  <div className="mt-1 text-[11px] text-emerald-100/80">
                    {user?.kycStatus === "VERIFIED"
                      ? "You're ready to invest!"
                      : view !== "kyc"
                      ? (
                        <button type="button" onClick={() => { setView("kyc"); setSidebarOpen(false); }} className="underline underline-offset-2 font-semibold hover:text-white">
                          <span className="inline-flex items-center gap-1">Tap here to complete <Icon name="arrowRight" size={13} /></span>
                        </button>
                      )
                      : "Complete BVN, NIN, and liveness to verify."}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>

        <main className="flex-1 min-w-0 space-y-4 sm:space-y-6">
          <div className="lg:hidden flex items-center gap-3 mb-2 sm:mb-1">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation"
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl velo-card border-0 text-velo-900 dark:text-white shadow-sm hover:shadow transition hover:bg-velo-50 dark:hover:bg-slate-800"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">Investor dashboard</div>
              <div className="text-base font-extrabold text-velo-900 dark:text-white truncate">
                {investorMenu.find((m) => m.key === view)?.label || "Overview"}
              </div>
            </div>
          </div>

          {view === "overview" && (
            <InvestorOverview
              user={user}
              hasBothRoles={hasBothRoles}
              switchingBusy={switchingBusy}
              switchMsg={switchMsg}
              handleEnableBorrower={handleEnableBorrower}
              fundingBanner={fundingBanner}
              error={error}
              message={message}
              available={available}
              locked={locked}
              returns={returns}
              activeCount={activeCount}
              totalCapital={totalCapital}
              returnRate={returnRate}
              investments={investments}
              data={data}
              kyc={kyc}
              transactions={transactions}
              openAction={openAction}
              action={action}
              plans={plans}
              openFundModal={openFundModal}
              openInvestModal={openInvestModal}
              goToTransactions={() => { setView("transactions"); setAction(""); }}
            />
          )}

          {view === "wallet" && (
            <InvestorWallet
              user={user}
              available={available}
              locked={locked}
              returns={returns}
              fundingBanner={fundingBanner}
              error={error}
              message={message}
              openFundModal={openFundModal}
              onWithdrawal={async (text: string) => {
                setMessage(text);
                const [dashboard, history] = await Promise.all([getInvestorDashboard(), getInvestorTransactions()]);
                setData(dashboard as DashboardData);
                setTransactions(history as unknown as TransactionData);
              }}
            />
          )}

          {view === "investments" && (
            <InvestorInvestments
              investments={investments}
              plans={plans}
              totalCapital={totalCapital}
              returns={returns}
              returnRate={returnRate}
              openInvestModal={openInvestModal}
              setError={setError}
            />
          )}

          {view === "kyc" && (
            <InvestorKyc
              user={user}
              kyc={kyc}
              checklist={checklist}
              bvn={bvn}
              setBvn={setBvn}
              nin={nin}
              setNin={setNin}
              verifyIdentity={verifyIdentity}
              kycBusy={kycBusy}
              canSubmitAddressReview={canSubmitAddressReview}
              submitAddressReview={submitAddressReview}
              busy={busy}
              uploadProofOfAddress={uploadProofOfAddress}
              uploadSignature={uploadSignature}
              onPremblyLivenessResult={onPremblyLivenessResult}
              kycError={kycError}
              message={message}
              activeOtpChallenge={activeOtpChallenge}
              setActiveOtpChallenge={setActiveOtpChallenge}
              submitActiveKycOtp={submitActiveKycOtp}
              resendActiveKycOtp={resendActiveKycOtp}
              otpMethodPickerFor={otpMethodPickerFor}
              setOtpMethodPickerFor={setOtpMethodPickerFor}
              verifyIdentityWithChannel={verifyIdentityWithChannel}
              otpPickerState={otpPickerState}
              setOtpPickerState={setOtpPickerState}
              uploadSelfieFallback={uploadSelfieFallback}
            />
          )}

          {view === "transactions" && (
            <InvestorTransactions
              transactions={transactions}
              selectedTx={selectedTx}
              setSelectedTx={setSelectedTx}
            />
          )}

          {view === "payout" && (
            <InvestorPayoutSection userId={user?.id} />
          )}

          {view === "profile" && (
            <InvestorProfile user={user} />
          )}
        </main>
      </div>

      {fundModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-sm px-4 animate-fade-in">
          <div className="velo-card w-full max-w-md p-6 shadow-2xl animate-slide-in-left">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-bold text-velo-900 dark:text-white">Fund your wallet</h3>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Enter an amount to deposit and start investing.</p>
              </div>
              <button type="button" className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-white" onClick={() => setFundModalOpen(false)} aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>
            </div>
            <form onSubmit={handleFundModalSubmit} className="mt-5 space-y-4">
              <label className="velo-label block">
                Amount (NGN)
                <div className="relative mt-1">
                  <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-slate-500 font-bold text-sm pointer-events-none">₦</span>
                  <input className="velo-input !pl-12 font-bold" type="number" min="1000" step="100" value={fundModalAmount} onChange={(e) => setFundModalAmount(e.target.value)} required autoFocus />
                </div>
                <span className="mt-1 block text-xs text-slate-500">Minimum deposit: ₦1,000</span>
              </label>
              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                <button type="button" className="btn-secondary" onClick={() => setFundModalOpen(false)} disabled={fundModalBusy}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={fundModalBusy}>
                  {fundModalBusy ? "Processing…" : "Continue to payment"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {investModalOpen && investModalPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-sm px-4 animate-fade-in">
          <div className="velo-card w-full max-w-md p-6 shadow-2xl animate-slide-in-left">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-bold text-velo-900 dark:text-white">Invest in {investModalPlan.name}</h3>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{investModalPlan.tenureDays} days · {investModalPlan.annualRatePercent}% p.a.</p>
              </div>
              <button type="button" className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-white" onClick={() => { setInvestModalOpen(false); setInvestModalPlan(null); }} aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>
            </div>
            <div className="mt-4 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 p-4 text-sm space-y-1 border border-emerald-100 dark:border-emerald-900/30">
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">Min investment</span><span className="font-bold text-velo-900 dark:text-white">₦{Number(investModalPlan.minAmountNaira).toLocaleString()}</span></div>
              {investModalPlan.maxAmountNaira && <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">Max investment</span><span className="font-bold text-velo-900 dark:text-white">₦{Number(investModalPlan.maxAmountNaira).toLocaleString()}</span></div>}
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">Available wallet</span><span className="font-bold text-emerald-600">{money.format(available)}</span></div>
            </div>
            <form onSubmit={handleInvestModalSubmit} className="mt-5 space-y-4">
              <label className="velo-label block">
                Amount to invest (NGN)
                <div className="relative mt-1">
                  <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-slate-500 font-bold text-sm pointer-events-none">₦</span>
                  <input className="velo-input !pl-12 font-bold" type="number" min={investModalPlan.minAmountNaira} max={investModalPlan.maxAmountNaira} step="100" value={investModalAmount} onChange={(e) => setInvestModalAmount(e.target.value)} required autoFocus />
                </div>
              </label>
              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                <button type="button" className="btn-secondary" onClick={() => { setInvestModalOpen(false); setInvestModalPlan(null); }} disabled={investModalBusy}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={investModalBusy || available < Number(investModalAmount)}>
                  {investModalBusy ? "Processing…" : available < Number(investModalAmount) ? "Insufficient wallet balance" : "Confirm investment"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </Layout>
  );
}

function InvestorOverview(props: any) {
  const { user, hasBothRoles, switchingBusy, switchMsg, handleEnableBorrower, fundingBanner, error, message, available, locked, returns, activeCount, totalCapital, returnRate, investments, data, kyc, transactions, openAction, action, plans, openFundModal, openInvestModal, goToTransactions } = props;
  const payoutCount = transactions?.payouts?.length ?? 0;
  const checklist = kyc?.checklist ?? {};
  const onboardingRequirements: readonly [string, string, boolean][] = [
    ["Identity info", "Legal name, DOB, contact", Boolean(checklist.bvn || checklist.nin)],
    ["BVN verification", "11-digit bank verification", Boolean(checklist.bvn)],
    ["NIN verification", "National ID number check", Boolean(checklist.nin)],
    ["Proof of address", "Utility bill or statement", Boolean(checklist.proofOfAddress)],
    ["Payout account", "Bank account for returns", Boolean(data?.payoutAccount?.status === "VERIFIED")],
  ];
  const completedOnboardingRequirements = onboardingRequirements.filter(([, , completed]) => completed).length;
  return (
    <div className="space-y-6">
        <div>
        {user && (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-emerald-50 to-white dark:from-emerald-900/20 dark:to-slate-900 border border-emerald-100 dark:border-emerald-900/40">
            <div className="flex items-start gap-3">
              <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-100 to-emerald-50 dark:from-emerald-900 dark:to-emerald-900 text-emerald-600 dark:text-emerald-400">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M3 3v18h18M7 14l4-4 4 4 5-5"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div>
                <div className="text-sm font-bold text-velo-900 dark:text-white">
                  Investor Dashboard
                </div>
                {user.roles.includes("BORROWER") ? (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    You also have borrower access. Switch dashboards anytime — same KYC unlocks everything.
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Enable borrower access anytime. You can complete or continue KYC from the dashboard you choose.
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {hasBothRoles && (
                <Link
                  to="/borrower"
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-velo-600 to-velo-500 text-white text-sm font-semibold shadow-md shadow-velo-500/20 hover:shadow-lg hover:shadow-velo-500/30 hover:scale-[1.02] active:scale-[0.98] transition-all group"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  Switch to Borrower
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="group-hover:translate-x-0.5 transition-transform"
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
              )}
              {!user.roles.includes("BORROWER") && (
                <button
                  type="button"
                  onClick={handleEnableBorrower}
                  disabled={switchingBusy}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-velo-600 to-velo-500 text-white text-sm font-semibold shadow-md shadow-velo-500/20 hover:shadow-lg hover:shadow-velo-500/30 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                  title="Enable borrower access"
                >
                  {switchingBusy ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Enabling…
                    </>
                  ) : (
                    <>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <path
                          d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                        />
                      </svg>
                      Enable Borrower Access
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        )}

        {switchMsg && (
          <div className="rounded-xl border border-emerald-100 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 p-4 text-sm text-emerald-700 dark:text-emerald-400 flex items-start gap-2.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0 mt-0.5 text-emerald-500">
              <path d="M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {switchMsg}
          </div>
        )}

        {fundingBanner && (
          <div className={`rounded-xl border p-4 text-sm flex items-start gap-2.5 ${fundingBanner.ok ? "border-emerald-100 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 text-emerald-700 dark:text-emerald-400" : "border-amber-100 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-900/30 text-amber-700 dark:text-amber-400"}`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className={`shrink-0 mt-0.5 ${fundingBanner.ok ? "text-emerald-500" : "text-amber-500"}`}>
              {fundingBanner.ok
                ? <path d="M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                : <><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" /><path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>}
            </svg>
            {fundingBanner.text}
          </div>
        )}

        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">
              Investor portal
            </p>
            <h1 className="mt-2 text-xl font-bold text-velo-900 sm:text-2xl md:text-3xl dark:text-white">
              Grow your money with clarity.
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              Welcome{user ? `, ${user.fullName}` : ""}. Complete KYC, fund your wallet, and manage your investment plans.
            </p>
          </div>
          <span
            className={`badge ${user?.kycStatus === "VERIFIED" ? "badge-completed" : "badge-pending"}`}
          >
            {user?.kycStatus === "VERIFIED" ? "KYC verified" : "KYC action required"}
          </span>
        </div>

        {error && (
          <div className="rounded-xl border border-red-100 bg-red-50 dark:bg-red-900/20 dark:border-red-900/30 p-4 text-sm text-red-700 dark:text-red-400">
            {error}
          </div>
        )}
        {message && (
          <div className="rounded-xl border border-emerald-100 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 p-4 text-sm text-emerald-700 dark:text-emerald-400">
            {message}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-3">
          <Metric
            label="Available wallet balance"
            value={money.format(available)}
            detail="Available for investment"
          />
          <Metric
            label="Locked investments"
            value={money.format(locked)}
            detail={`${investments.length} active investment(s)`}
          />
          <Metric
            label="Expected returns"
            value={money.format(returns)}
            detail="From loaded investment records"
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-[1.25fr_.75fr]">
          <section className="velo-card overflow-hidden p-5 sm:p-6"><div className="flex items-start justify-between gap-4"><div><h2 className="section-heading">Portfolio performance</h2><p className="section-subheading">Capital and expected earnings across your investments.</p></div><span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">{activeCount} active</span></div><div className="mt-6 grid grid-cols-3 gap-3"><div><p className="text-xs text-slate-500">Capital</p><p className="mt-1 text-base font-bold text-velo-900 dark:text-white">{money.format(totalCapital)}</p></div><div><p className="text-xs text-slate-500">Expected return</p><p className="mt-1 text-base font-bold text-emerald-600">{money.format(returns)}</p></div><div><p className="text-xs text-slate-500">Return ratio</p><p className="mt-1 text-base font-bold text-velo-900 dark:text-white">{returnRate}%</p></div></div><svg className="mt-6 h-24 w-full" viewBox="0 0 520 96" role="img" aria-label="Investment performance chart"><defs><linearGradient id="investor-chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#10b981" stopOpacity=".3"/><stop offset="1" stopColor="#10b981" stopOpacity="0"/></linearGradient></defs><path d="M0 80 C80 72 120 67 170 60 S250 66 310 42 S420 46 520 14 V96 H0Z" fill="url(#investor-chart-fill)"/><path d="M0 80 C80 72 120 67 170 60 S250 66 310 42 S420 46 520 14" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round"/></svg></section>
          <section className="velo-card p-4 sm:p-5 lg:p-6"><h2 className="section-heading">Capital allocation</h2><p className="section-subheading">Where your money sits today.</p><div className="mx-auto mt-6 flex h-36 w-36 items-center justify-center rounded-full" style={{ background: `conic-gradient(#2196f3 0 38%, #10b981 38% 82%, #f59e0b 82% 100%)` }}><div className="flex h-24 w-24 flex-col items-center justify-center rounded-full bg-white dark:bg-slate-900"><span className="text-lg font-bold text-velo-900 dark:text-white">{money.format(totalCapital)}</span><span className="text-[10px] text-slate-500">total value</span></div></div><div className="mt-5 space-y-2 text-xs"><Legend color="bg-sky-500" label="Available wallet" value={money.format(available)} /><Legend color="bg-emerald-500" label="Locked investments" value={money.format(locked)} /><Legend color="bg-amber-500" label="Expected earnings" value={money.format(returns)} /></div></section>
        </div>

        <div className="grid gap-5 lg:grid-cols-[1.3fr_.7fr]">
          <section className="velo-card p-4 sm:p-5 lg:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="section-heading">Complete your onboarding</h2>
                <p className="section-subheading">
                  Identity checks and payout setup are required before investment settlement.
                </p>
              </div>
              <span className="text-sm font-semibold text-velo-600">
                {completedOnboardingRequirements}/5
              </span>
            </div>
            <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div
                className="h-full rounded-full bg-velo-500"
                style={{ width: `${completedOnboardingRequirements * 20}%` }}
              />
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {onboardingRequirements.map(([t, d, completed]) => (
                <div
                  key={t}
                  className={`flex items-start gap-3 p-3.5 rounded-xl border transition-colors ${
                    completed
                      ? "bg-emerald-50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-900/30"
                      : "bg-slate-50 dark:bg-slate-800 border-slate-100 dark:border-slate-700"
                  }`}
                >
                  <div
                    className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                      completed
                        ? "bg-emerald-500 text-white"
                        : "bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400"
                    }`}
                  >
                    {completed ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.2" />
                      </svg>
                    )}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-velo-900 dark:text-white">{t}</div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{d}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="velo-card p-4 sm:p-5 lg:p-6">
            <h2 className="section-heading">Quick actions</h2>
            <p className="section-subheading">Investor essentials at your fingertips.</p>
            <div className="mt-5 space-y-2.5">
              <button type="button" onClick={openFundModal} className="w-full flex items-center justify-between gap-3 p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors group text-left">
                <div className="flex items-center gap-3">
                  <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500 text-white">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M3 3v18h18M7 14l4-4 4 4 5-5"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-velo-900 dark:text-white">
                      Fund wallet
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Deposit to start investing
                    </div>
                  </div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400 group-hover:text-emerald-600 group-hover:translate-x-0.5 transition-all">
                  <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button type="button" onClick={() => void openAction("plans")} className="w-full flex items-center justify-between gap-3 p-3.5 rounded-xl bg-velo-50 dark:bg-velo-900/30 hover:bg-velo-100 dark:hover:bg-velo-900/50 transition-colors group text-left">
                <div className="flex items-center gap-3">
                  <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-velo-500 text-white">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M12 6v6l4 2m5-2a9 9 0 11-18 0 9 9 0 0118 0z"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-velo-900 dark:text-white">
                      View investment plans
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      30–180 day tenors, up to 18%
                    </div>
                  </div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400 group-hover:text-velo-600 group-hover:translate-x-0.5 transition-all">
                  <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button type="button" onClick={goToTransactions} className="w-full flex items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors group text-left">
                <div className="flex items-center gap-3">
                  <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-velo-700 to-velo-600 text-white">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-velo-900 dark:text-white">
                      Transaction history
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {payoutCount} record{payoutCount === 1 ? "" : "s"}
                    </div>
                  </div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400 group-hover:text-velo-600 group-hover:translate-x-0.5 transition-all">
                  <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            {action === "plans" && (
              <div className="mt-4 space-y-2">
                {plans.length ? plans.map((plan: Plan) => (
                  <div key={plan.id} className="flex items-center justify-between rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-700 bg-gradient-to-br from-white to-slate-50 dark:from-slate-900 dark:to-slate-900/50">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-velo-900 dark:text-white">{plan.name} · {plan.tenureDays} days</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Min ₦{Number(plan.minAmountNaira).toLocaleString()} · {plan.annualRatePercent}% p.a.</div>
                    </div>
                    <button type="button" className="btn-primary !py-1.5 !px-3 text-xs" onClick={() => openInvestModal(plan)}>Invest</button>
                  </div>
                )) : <Empty text="Loading investment plans…" />}
              </div>
            )}
          </section>
        </div>

        {plans.length > 0 && (
          <section className="velo-card p-4 sm:p-5 lg:p-6">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="section-heading mb-0">Available investment plans</h2>
                <p className="section-subheading mb-0">Choose a plan and start investing today.</p>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {plans.map((plan: Plan) => (
                <div key={plan.id} className="rounded-2xl border border-slate-100 dark:border-slate-800 p-4 bg-gradient-to-br from-white to-slate-50 dark:from-slate-900 dark:to-slate-900/50 hover:shadow-lg transition-shadow">
                  <div className="flex items-start justify-between">
                    <div className="text-sm font-bold text-velo-900 dark:text-white">{plan.name}</div>
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold">{plan.annualRatePercent}% p.a.</span>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div><p className="text-slate-500 dark:text-slate-400">Tenor</p><p className="font-semibold dark:text-white">{plan.tenureDays}d</p></div>
                    <div><p className="text-slate-500 dark:text-slate-400">Min</p><p className="font-semibold dark:text-white truncate">₦{(plan.minAmountNaira/1000 >= 1 ? plan.minAmountNaira/1000 + "k" : plan.minAmountNaira)}</p></div>
                    <div><p className="text-slate-500 dark:text-slate-400">Rate</p><p className="font-semibold text-emerald-600">{plan.annualRatePercent}%</p></div>
                  </div>
                  <button type="button" className="mt-4 w-full btn-primary text-xs" onClick={() => openInvestModal(plan)}>Invest now</button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function InvestorWallet(props: any) {
  const { available, locked, returns, fundingBanner, error, message, openFundModal, onWithdrawal } = props;
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Wallet</p>
          <h1 className="mt-2 text-xl font-bold text-velo-900 sm:text-2xl md:text-3xl dark:text-white">Manage your funds</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">Fund your wallet and track your balances.</p>
        </div>
        <button type="button" className="btn-primary" onClick={openFundModal}>
          + Fund wallet
        </button>
      </div>
      {fundingBanner && (
        <div className={`rounded-xl border p-4 text-sm flex items-start gap-2.5 ${fundingBanner.ok ? "border-emerald-100 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 text-emerald-700 dark:text-emerald-400" : "border-amber-100 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-900/30 text-amber-700 dark:text-amber-400"}`}>
          {fundingBanner.text}
        </div>
      )}
      {error && <div className="rounded-xl border border-red-100 bg-red-50 dark:bg-red-900/20 dark:border-red-900/30 p-4 text-sm text-red-700 dark:text-red-400">{error}</div>}
      {message && <div className="rounded-xl border border-emerald-100 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 p-4 text-sm text-emerald-700 dark:text-emerald-400">{message}</div>}
      <div className="grid gap-4 md:grid-cols-3">
        <Metric label="Available balance" value={money.format(available)} detail="Ready to invest" />
        <Metric label="Held in investments" value={money.format(locked)} detail="Active positions" />
        <Metric label="Expected earnings" value={money.format(returns)} detail="Projected returns" />
      </div>
      <section className="velo-card p-4 sm:p-5 lg:p-6 rounded-2xl bg-gradient-to-br from-emerald-600 via-emerald-700 to-emerald-800 text-white border-0 shadow-[0_20px_60px_-20px_rgba(6,78,59,0.38)]">
        <div className="absolute -top-10 -right-10 w-36 h-36 rounded-full bg-white/5 blur-xl pointer-events-none"></div>
        <div className="relative flex flex-col sm:flex-row sm:items-end sm:justify-between gap-5">
          <div className="max-w-md">
            <div className="text-[11px] uppercase tracking-wider font-bold text-emerald-100/80">Wallet balance</div>
            <div className="mt-2 text-4xl font-black tracking-tight">{money.format(available)}</div>
            <div className="mt-2 text-sm text-emerald-100/80">Fund your wallet to start earning returns on verified investment plans.</div>
          </div>
          <button type="button" onClick={openFundModal} className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-white text-emerald-700 font-bold shadow-lg hover:shadow-xl hover:scale-[1.02] active:scale-[0.98] transition-all whitespace-nowrap">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M3 3v18h18M7 14l4-4 4 4 5-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Deposit to start investing
          </button>
        </div>
      </section>
      <InvestorWithdrawalForm available={available} onSuccess={onWithdrawal} />
    </div>
  );
}

function InvestorInvestments(props: any) {
  const { investments, plans, totalCapital, returns, returnRate, openInvestModal } = props;
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Investments</p>
          <h1 className="mt-2 text-xl font-bold text-velo-900 sm:text-2xl md:text-3xl dark:text-white">Your investments</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">Plans and active positions.</p>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Metric label="Capital deployed" value={money.format(totalCapital)} detail="Total invested" />
        <Metric label="Expected returns" value={money.format(returns)} detail="Earnings on maturity" />
        <Metric label="Blended return" value={`${returnRate}%`} detail="Weighted rate" />
      </div>
      <section className="velo-card p-4 sm:p-5 lg:p-6">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="section-heading mb-0">Available investment plans</h2>
        </div>
        {plans.length ? (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan: Plan) => (
              <div key={plan.id} className="rounded-2xl border border-slate-100 dark:border-slate-800 p-4 bg-gradient-to-br from-white to-slate-50 dark:from-slate-900 dark:to-slate-900/50 hover:shadow-lg transition-shadow">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-bold text-velo-900 dark:text-white">{plan.name}</div>
                    <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{plan.tenureDays}-day tenor</div>
                  </div>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold">{plan.annualRatePercent}% p.a.</span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div><p className="text-slate-500 dark:text-slate-400">Min</p><p className="font-semibold dark:text-white">₦{Number(plan.minAmountNaira).toLocaleString()}</p></div>
                  {plan.maxAmountNaira && <div><p className="text-slate-500 dark:text-slate-400">Max</p><p className="font-semibold dark:text-white">₦{Number(plan.maxAmountNaira).toLocaleString()}</p></div>}
                </div>
                <button type="button" className="mt-4 w-full btn-primary text-xs" onClick={() => openInvestModal(plan)}>Invest now</button>
              </div>
            ))}
          </div>
        ) : <Empty text="No investment plans available at this time." />}
      </section>
      <section className="velo-card p-4 sm:p-5 lg:p-6">
        <h2 className="section-heading">Investment history</h2>
        <p className="section-subheading">All your positions.</p>
        {investments.length ? (
          <div className="mt-5 space-y-3">
            {investments.map((inv: any, idx: number) => (
              <div key={inv.id || idx} className="rounded-xl border border-slate-100 dark:border-slate-800 p-4 flex flex-wrap justify-between gap-3">
                <div><div className="text-sm font-semibold text-velo-900 dark:text-white">{inv.planSnapshot?.name || `Investment ${idx + 1}`}</div><div className="text-xs text-slate-500 mt-0.5">Status: {inv.status || "UNKNOWN"} · Started: {inv.startsAt ? new Date(inv.startsAt).toLocaleDateString() : "—"}</div><div className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-300"><Icon name="lock" size={13} />Locked until {inv.maturesAt ? new Date(inv.maturesAt).toLocaleDateString() : "maturity"} · {inv.accrual?.remainingDays ?? inv.tenureDays ?? 0} days remaining</div></div>
                <div className="text-right"><div className="font-bold dark:text-white">{money.format(Number(inv.amountNaira ?? 0))}</div><div className="text-xs text-emerald-600">Accrued: +{money.format(Number(inv.accrual?.accruedEarningsNaira ?? 0))}</div><div className="text-[11px] text-slate-500">Maturity interest: {money.format(Number(inv.expectedEarningsNaira ?? 0))}</div></div>
              </div>
            ))}
          </div>
        ) : <Empty text="No investments yet. Fund your wallet and choose a plan to begin." />}
      </section>
    </div>
  );
}

function MenuIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = { grid: <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>, wallet: <><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/></>, chart: <><path d="M4 19V5M4 19h16"/><path d="m7 15 4-4 3 2 5-7"/></>, check: <path d="m5 12 4 4L19 6"/>, document: <><path d="M7 3h7l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></>, bank: <path d="M3 10h18M5 10v8m4-8v8m6-8v8m4-8v8M3 20h18L12 4 3 10Z"/>, user: <><circle cx="12" cy="8" r="3"/><path d="M5 21c.8-4 3.1-6 7-6s6.2 2 7 6"/></> };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.grid}</svg>;
}

function FileIcon() {
  return <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="shrink-0 text-slate-400" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.6"/><path d="M8 13h8M8 17h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>;
}

function InvestorKyc(props: any) {
  const { user, kyc, checklist, bvn, setBvn, nin, setNin, verifyIdentity, kycBusy, canSubmitAddressReview, submitAddressReview, busy, uploadProofOfAddress, uploadSignature, onPremblyLivenessResult, kycError, message, activeOtpChallenge, setActiveOtpChallenge, submitActiveKycOtp, resendActiveKycOtp, otpMethodPickerFor, setOtpMethodPickerFor, verifyIdentityWithChannel, otpPickerState, setOtpPickerState, uploadSelfieFallback } = props;
  const [error, setError] = useState("");
  useEffect(() => { setError(kycError); }, [kycError]);

  const maskId = (value: string) => {
    if (!value || value.length < 4) return value;
    return "*".repeat(Math.max(0, value.length - 4)) + value.slice(-4);
  };
  const pickStr = (details: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) {
      const v = details[key];
      if (typeof v === "string" && v.trim()) return v;
    }
    return undefined;
  };
  const details = (kyc?.verifiedDetails ?? {}) as Record<string, unknown>;
  const identityInfo = {
    fullName: pickStr(details, ["fullName", "full_name", "name"]) || user?.fullName || "",
    phone: pickStr(details, ["phone", "phone_number", "phoneNumber1", "phoneNumber2"]) || user?.phone || "",
    dateOfBirth: pickStr(details, ["dateOfBirth", "date_of_birth", "dob"]) || user?.dateOfBirth || "",
    address: pickStr(details, ["address", "residentialAddress", "residence_address"]) || "",
    state: pickStr(details, ["state", "stateOfOrigin"]) || "",
    lga: pickStr(details, ["lga", "lgaOfOrigin", "local_government"]) || "",
    gender: pickStr(details, ["gender", "sex"]) || "",
    nationality: pickStr(details, ["nationality"]) || "",
  };
  const anyIdentityPopulated = !!(identityInfo.fullName || identityInfo.phone || identityInfo.dateOfBirth || identityInfo.address || identityInfo.state || identityInfo.lga);
  const identityPopulated = (checklist.bvn || checklist.nin) && anyIdentityPopulated;
  const photoRaw = (kyc?.identityPhoto as string | undefined) || pickStr(details, ["base64Image", "identityPhoto", "photo", "photograph"]);
  const governmentPortrait = typeof photoRaw === "string" && photoRaw.length > 20
    ? photoRaw.startsWith("data:") || photoRaw.startsWith("http")
      ? photoRaw
      : `data:image/jpeg;base64,${photoRaw.replace(/\s/g, "")}`
    : undefined;
  const selfieRaw = kyc?.selfieImageData as string | undefined;
  const liveSelfie = typeof selfieRaw === "string" && selfieRaw.length > 20 ? selfieRaw : undefined;
  const bvnLocked = checklist.bvn === true;
  const ninLocked = checklist.nin === true;
  const livenessLocked = checklist.liveness === true;
  const allRequiredChecksComplete = [checklist.bvn, checklist.nin, checklist.liveness, checklist.proofOfAddress, checklist.signature].every(Boolean);
  const displayedKycStatus = kyc?.status === "VERIFIED" && !allRequiredChecksComplete ? "IN_PROGRESS" : kyc?.status;
  const bvnDisplay = bvnLocked ? maskId(bvn) : bvn;
  const ninDisplay = ninLocked ? maskId(nin) : nin;

  // KYC progress counter (6 steps). Each step maps to the checklist + submission:
  // 1 = BVN verified, 2 = NIN verified, 3 = identity info retrieved, 4 = liveness verified, 5 = signature uploaded, 6 = proof of address submitted & pending/verified
  const completedSteps = [
    checklist.bvn === true,
    checklist.nin === true,
    identityPopulated === true,
    livenessLocked === true,
    checklist.signature === true,
    (checklist.proofOfAddress === true || kyc?.status === "SUBMITTED" || kyc?.status === "PENDING_VERIFICATION" || kyc?.status === "VERIFIED"),
  ].filter(Boolean).length;
  const progressPct = Math.min(100, Math.round((completedSteps / 6) * 100));
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Verification</p>
          <h1 className="mt-2 text-xl font-bold text-velo-900 sm:text-2xl md:text-3xl dark:text-white">Complete your KYC</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">Verify BVN, NIN, liveness, and proof of address.</p>
        </div>
      </div>
      {message && <div className="rounded-xl border border-emerald-100 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 p-4 text-sm text-emerald-700 dark:text-emerald-400">{message}</div>}
      {error && <div className="rounded-xl border border-red-100 bg-red-50 dark:bg-red-900/20 dark:border-red-900/30 p-4 text-sm text-red-700 dark:text-red-400">{error}</div>}
      <section className="velo-card p-4 sm:p-5 lg:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="section-heading">Complete your verification</h2>
            <p className="section-subheading">Identity checks and payout setup are required before investment settlement.</p>
          </div>
          <div className="text-right shrink-0">
            <div className="text-sm font-semibold text-velo-600">{completedSteps}/6</div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400">{displayedKycStatus === "VERIFIED" ? "All verified" : "Completed steps"}</div>
          </div>
        </div>
        <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-velo-400 to-velo-600 transition-[width] duration-700 ease-out"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[['BVN', 'bvn'], ['NIN', 'nin'], ['Liveness', 'liveness'], ['Proof of address', 'proofOfAddress'], ['Passport', 'passport'], ['Signature', 'signature']].map(([label, key]) => {
            const result = kyc?.categoryResults?.[key];
            const current = result?.status || (checklist[key] ? 'VERIFIED' : 'NOT_STARTED');
            const rejected = current === 'REJECTED';
            return <div key={key} className={`rounded-xl border p-3 ${rejected ? 'border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-900/15' : 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/30'}`}><div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold text-slate-800 dark:text-slate-200">{label}</span><span className={`text-[10px] font-bold uppercase ${rejected ? 'text-red-700 dark:text-red-300' : current === 'VERIFIED' ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500'}`}>{String(current).replace(/_/g, ' ')}</span></div>{rejected && <p className="mt-2 text-xs leading-5 text-red-700 dark:text-red-300">{result?.reason || kyc?.rejectionReason || 'Verification was not successful.'}</p>}</div>;
          })}
        </div>
        {kyc?.rejectionReason && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/15 dark:text-red-300"><strong>Review note:</strong> {kyc.rejectionReason}</div>}
        {displayedKycStatus !== "VERIFIED" && (
          <div className="mt-6 space-y-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <p className="text-sm font-semibold text-velo-900 dark:text-white">Complete your verification</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="velo-label">
                BVN
                {bvnLocked ? (
                  <>
                    <div className="mt-1 velo-input flex items-center justify-between cursor-not-allowed bg-slate-50/80 dark:bg-slate-900/60 text-slate-700 dark:text-slate-300">
                      <div className="flex items-center gap-2">
                        <span className="font-bold tracking-wider font-mono text-slate-900 dark:text-white">{bvnDisplay}</span>
                        <span className="text-[10px] uppercase font-semibold text-emerald-700 bg-emerald-100/70 border border-emerald-200 px-1.5 py-0.5 rounded dark:bg-emerald-900/40 dark:border-emerald-800 dark:text-emerald-300">Verified</span>
                      </div>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400">
                        <rect x="4" y="11" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.8"/>
                        <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                      </svg>
                    </div>
                    <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">BVN verified and locked for your security.</span>
                  </>
                ) : (
                  <>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <input className="velo-input min-w-0 flex-1 sm:flex-auto" inputMode="numeric" maxLength={11} value={bvn} onChange={(event) => setBvn(event.target.value.replace(/\D/g, ""))} placeholder="11-digit BVN" />
                      <button type="button" className="btn-secondary shrink-0 min-h-[44px]" disabled={kycBusy === "BVN"} onClick={() => verifyIdentity("BVN")}>{kycBusy === "BVN" ? "Verifying…" : "Verify"}</button>
                    </div>
                    <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">Dial *565*0# on your registered line to retrieve your BVN.</span>
                  </>
                )}
              </label>
              <label className="velo-label">
                NIN
                {ninLocked ? (
                  <>
                    <div className="mt-1 velo-input flex items-center justify-between cursor-not-allowed bg-slate-50/80 dark:bg-slate-900/60 text-slate-700 dark:text-slate-300">
                      <div className="flex items-center gap-2">
                        <span className="font-bold tracking-wider font-mono text-slate-900 dark:text-white">{ninDisplay}</span>
                        <span className="text-[10px] uppercase font-semibold text-emerald-700 bg-emerald-100/70 border border-emerald-200 px-1.5 py-0.5 rounded dark:bg-emerald-900/40 dark:border-emerald-800 dark:text-emerald-300">Verified</span>
                      </div>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400">
                        <rect x="4" y="11" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.8"/>
                        <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                      </svg>
                    </div>
                    <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">NIN verified and locked for your security.</span>
                  </>
                ) : (
                  <>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <input className="velo-input min-w-0 flex-1 sm:flex-auto" inputMode="numeric" maxLength={11} value={nin} onChange={(event) => setNin(event.target.value.replace(/\D/g, ""))} placeholder="11-digit NIN" />
                      <button type="button" className="btn-secondary shrink-0 min-h-[44px]" disabled={kycBusy === "NIN"} onClick={() => verifyIdentity("NIN")}>{kycBusy === "NIN" ? "Verifying…" : "Verify"}</button>
                    </div>
                    <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">Found on your National Identity Card or via the NIMC app.</span>
                  </>
                )}
              </label>
            </div>

            {identityPopulated && (
              <div className="rounded-xl border border-sky-200 bg-sky-50/70 p-4 dark:border-sky-800/50 dark:bg-sky-950/20">
                <div className="flex items-center gap-2 mb-3">
                  <svg className="text-sky-700 dark:text-sky-400" width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path d="M12 12c2.7 0 5-2.3 5-5S14.7 2 12 2 7 4.3 7 7s2.3 5 5 5z" stroke="currentColor" strokeWidth="1.8"/>
                    <path d="M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                  </svg>
                  <h3 className="text-sm font-bold text-sky-900 dark:text-sky-200">Identity Information <span className="text-xs font-medium text-sky-700 dark:text-sky-400">(Retrieved from records · Locked)</span></h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
                  {identityInfo.fullName && (
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-sky-700 dark:text-sky-400 font-semibold">Full Name</label>
                      <div className="mt-0.5 text-sm text-slate-800 dark:text-slate-200 bg-white/70 dark:bg-slate-900/70 border border-sky-100 dark:border-sky-900 rounded-lg px-3 py-2">{identityInfo.fullName}</div>
                    </div>
                  )}
                  {identityInfo.phone && (
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-sky-700 dark:text-sky-400 font-semibold">Phone Number</label>
                      <div className="mt-0.5 text-sm text-slate-800 dark:text-slate-200 bg-white/70 dark:bg-slate-900/70 border border-sky-100 dark:border-sky-900 rounded-lg px-3 py-2">{identityInfo.phone}</div>
                    </div>
                  )}
                  {identityInfo.dateOfBirth && (
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-sky-700 dark:text-sky-400 font-semibold">Date of Birth</label>
                      <div className="mt-0.5 text-sm text-slate-800 dark:text-slate-200 bg-white/70 dark:bg-slate-900/70 border border-sky-100 dark:border-sky-900 rounded-lg px-3 py-2">{identityInfo.dateOfBirth}</div>
                    </div>
                  )}
                  {identityInfo.gender && (
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-sky-700 dark:text-sky-400 font-semibold">Gender</label>
                      <div className="mt-0.5 text-sm text-slate-800 dark:text-slate-200 bg-white/70 dark:bg-slate-900/70 border border-sky-100 dark:border-sky-900 rounded-lg px-3 py-2">{identityInfo.gender}</div>
                    </div>
                  )}
                  {identityInfo.state && (
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-sky-700 dark:text-sky-400 font-semibold">State of Origin</label>
                      <div className="mt-0.5 text-sm text-slate-800 dark:text-slate-200 bg-white/70 dark:bg-slate-900/70 border border-sky-100 dark:border-sky-900 rounded-lg px-3 py-2">{identityInfo.state}</div>
                    </div>
                  )}
                  {identityInfo.lga && (
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-sky-700 dark:text-sky-400 font-semibold">Local Government (LGA)</label>
                      <div className="mt-0.5 text-sm text-slate-800 dark:text-slate-200 bg-white/70 dark:bg-slate-900/70 border border-sky-100 dark:border-sky-900 rounded-lg px-3 py-2">{identityInfo.lga}</div>
                    </div>
                  )}
                  {identityInfo.address && (
                    <div className="sm:col-span-2">
                      <label className="text-[11px] uppercase tracking-wide text-sky-700 dark:text-sky-400 font-semibold">Residential Address</label>
                      <div className="mt-0.5 text-sm text-slate-800 dark:text-slate-200 bg-white/70 dark:bg-slate-900/70 border border-sky-100 dark:border-sky-900 rounded-lg px-3 py-2 break-words overflow-hidden">{identityInfo.address}</div>
                    </div>
                  )}
                  {identityInfo.nationality && (
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-sky-700 dark:text-sky-400 font-semibold">Nationality</label>
                      <div className="mt-0.5 text-sm text-slate-800 dark:text-slate-200 bg-white/70 dark:bg-slate-900/70 border border-sky-100 dark:border-sky-900 rounded-lg px-3 py-2">{identityInfo.nationality}</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeOtpChallenge && (
              <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/40 backdrop-blur-sm p-0 sm:p-4">
                <div className="velo-card w-full max-w-md shadow-2xl rounded-none sm:rounded-2xl border-t-2 sm:border-2 border-sky-500 dark:border-sky-400 overflow-hidden">
                  <div className="bg-gradient-to-r from-sky-500 to-velo-500 px-5 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-white">
                        <h3 className="text-base font-bold">Confirm {activeOtpChallenge.idType} ownership</h3>
                        <p className="mt-1 text-xs text-sky-100">
                          Sent via <span className="font-semibold">{activeOtpChallenge.challenge.channel}</span> to ···{activeOtpChallenge.challenge.phoneLastFour}
                        </p>
                      </div>
                      <button type="button" className="rounded-lg p-2 text-white/90 hover:bg-white/15" onClick={() => setActiveOtpChallenge(null)} aria-label="Dismiss"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg></button>
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
              <div className="mb-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <div className={`inline-flex items-center gap-1 self-start px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-[0.12em] border ${livenessLocked ? "bg-slate-100 border-slate-200 text-slate-600 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300" : "bg-amber-100 border-amber-200 text-amber-700 dark:bg-amber-900/30 dark:border-amber-800/60 dark:text-amber-300"}`}>
                    {livenessLocked ? <>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"/><path d="M8 12h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                      Reference — Government ID portrait
                    </> : <>
                      <Icon name="alert" size={10} />
                      Government ID portrait (NOT a selfie scan)
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
                      <Icon name="check" size={10} strokeWidth={2.5} />
                      Your Live Selfie — Liveness Verified
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
                  <>
                    <PremblyKycWidgetButton fullName={user?.fullName} email={user?.email} phone={user?.phone} idType={checklist.bvn ? "BVN" : "NIN"} idNumber={bvn || nin || ""} verifiedDetails={kyc?.verifiedDetails ?? null} onResult={onPremblyLivenessResult} />
                    <label className={`relative inline-flex min-h-[44px] items-center justify-center gap-2 px-5 py-3 text-sm font-bold rounded-xl border transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 ${kycBusy === "LIVENESS_SELFIE" ? "border-slate-200 bg-slate-50 opacity-60 cursor-not-allowed dark:border-slate-700 dark:bg-slate-900/20" : "border-slate-300 bg-white hover:bg-slate-50 text-slate-700 hover:text-slate-900 dark:border-slate-600 dark:bg-slate-800/60 dark:text-slate-200 dark:hover:bg-slate-700/60"}`}>
                      <input className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed" type="file" accept="image/jpeg,image/png,image/webp" disabled={kycBusy === "LIVENESS_SELFIE" || !(bvn && /^\d{11}$/.test(bvn) || nin && /^\d{11}$/.test(nin))} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadSelfieFallback(file); }} />
                      {kycBusy === "LIVENESS_SELFIE" ? (
                        <>
                          <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 12a9 9 0 11-6.219-8.56" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                          Uploading…
                        </>
                      ) : (
                        <>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                          Upload Selfie (Fallback)
                        </>
                      )}
                    </label>
                  </>
                )}
                {!livenessLocked && (checklist.selfieUploaded || checklist.liveness || kyc?.livenessManualUploaded) && <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400"><Icon name="check" size={13} />{checklist.liveness ? "Liveness verified" : "Selfie uploaded · pending admin review"}</span>}
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="velo-label mb-0 block">
                  <div className="flex items-center gap-2">
                    <span>Signature</span>
                    <span className="text-red-500">*</span>
                  </div>
                </label>
                {checklist.signature && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-100/80 dark:bg-emerald-900/40 border border-emerald-200 dark:border-emerald-800/50 px-2.5 py-1 rounded-lg dark:text-emerald-300 shadow-sm">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    Uploaded
                  </span>
                )}
              </div>
              <label className={`group relative flex flex-col items-center justify-center gap-2 w-full min-h-[120px] rounded-2xl border-2 border-dashed cursor-pointer transition-all px-5 py-4 text-center ${kycBusy === "SIGNATURE" ? "border-slate-200 bg-slate-50 opacity-60 cursor-not-allowed dark:border-slate-700 dark:bg-slate-900/20" : checklist.signature ? "border-emerald-300 bg-emerald-50/50 hover:bg-emerald-50 hover:border-emerald-400 dark:border-emerald-700/60 dark:bg-emerald-900/10 dark:hover:bg-emerald-900/20" : "border-slate-300 bg-slate-50 hover:border-velo-500 hover:bg-velo-50/50 hover:shadow-sm dark:border-slate-600 dark:bg-slate-900/30 dark:hover:border-velo-400 dark:hover:bg-velo-950/20"}`}>
                <input className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed peer" type="file" accept="application/pdf,image/jpeg,image/png" disabled={kycBusy === "SIGNATURE" || checklist.signature === true} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadSignature(file); }} />
                <div className={`flex h-12 w-12 items-center justify-center rounded-xl transition-colors ${checklist.signature ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 group-hover:bg-emerald-200 dark:group-hover:bg-emerald-800/50" : "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-300 group-hover:bg-velo-100 dark:group-hover:bg-velo-900/40 group-hover:text-velo-600 dark:group-hover:text-velo-400"}`}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                    <path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <div>
                  <div className={`text-sm font-semibold ${checklist.signature ? "text-emerald-800 dark:text-emerald-200" : "text-slate-800 dark:text-slate-200 group-hover:text-velo-700 dark:group-hover:text-velo-300"}`}>
                    {kycBusy === "SIGNATURE" ? "Uploading…" : checklist.signature ? "Signature approved and locked" : "Click to upload signature"}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">PDF, JPG, or PNG — clear image of your handwritten signature.</div>
                </div>
              </label>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="velo-label mb-0 block">
                  <div className="flex items-center gap-2">
                    <span>Proof of address</span>
                    <span className="text-red-500">*</span>
                  </div>
                </label>
                {checklist.proofOfAddress && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-100/80 dark:bg-emerald-900/40 border border-emerald-200 dark:border-emerald-800/50 px-2.5 py-1 rounded-lg dark:text-emerald-300 shadow-sm">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    Uploaded
                  </span>
                )}
              </div>
              <label className={`group relative flex flex-col items-center justify-center gap-2 w-full min-h-[120px] rounded-2xl border-2 border-dashed cursor-pointer transition-all px-5 py-4 text-center ${kycBusy === "PROOF_OF_ADDRESS" ? "border-slate-200 bg-slate-50 opacity-60 cursor-not-allowed dark:border-slate-700 dark:bg-slate-900/20" : checklist.proofOfAddress ? "border-emerald-300 bg-emerald-50/50 hover:bg-emerald-50 hover:border-emerald-400 dark:border-emerald-700/60 dark:bg-emerald-900/10 dark:hover:bg-emerald-900/20" : "border-slate-300 bg-slate-50 hover:border-velo-500 hover:bg-velo-50/50 hover:shadow-sm dark:border-slate-600 dark:bg-slate-900/30 dark:hover:border-velo-400 dark:hover:bg-velo-950/20"}`}>
                <input className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed peer" type="file" accept="application/pdf,image/jpeg,image/png" disabled={kycBusy === "PROOF_OF_ADDRESS" || checklist.proofOfAddress === true} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadProofOfAddress(file); }} />
                <div className={`flex h-12 w-12 items-center justify-center rounded-xl transition-colors ${checklist.proofOfAddress ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 group-hover:bg-emerald-200 dark:group-hover:bg-emerald-800/50" : "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-300 group-hover:bg-velo-100 dark:group-hover:bg-velo-900/40 group-hover:text-velo-600 dark:group-hover:text-velo-400"}`}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                    <path d="M12 16V4m0 0L7 9m5-5l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </div>
                <div>
                  <div className={`text-sm font-semibold ${checklist.proofOfAddress ? "text-emerald-800 dark:text-emerald-200" : "text-slate-800 dark:text-slate-200 group-hover:text-velo-700 dark:group-hover:text-velo-300"}`}>
                    {kycBusy === "PROOF_OF_ADDRESS" ? "Uploading…" : checklist.proofOfAddress ? "Proof of address approved and locked" : "Click to upload document"}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">PDF, JPG, or PNG — recent utility bill or bank statement.</div>
                </div>
              </label>
              <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 flex items-start gap-2 text-xs leading-5 font-medium text-amber-800 dark:text-amber-200">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                  <path d="M12 8v5M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span>Proof of address can be utility bill, bank statement, house rent receipt that indicate the resident address and not older than 3 months.</span>
              </div>
            </div>
            {kyc?.documents?.length ? (
              <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
                <h3 className="text-sm font-semibold text-velo-900 dark:text-white">Uploaded documents</h3>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {kyc.documents.map((doc: NonNullable<KycData["documents"]>[number]) => {
                    const previewUrl = documentPreviewUrl(doc);
                    const downloadUrl = documentDownloadUrl(doc);
                    const isImage = /^image\//i.test(doc.mimeType || "");
                    return <div key={doc.id || doc.documentType} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                      {isImage && previewUrl ? <img src={previewUrl} alt={doc.fileName || doc.documentType || "Uploaded document"} className="h-12 w-12 rounded-md object-cover" /> : <FileIcon />}
                      <div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold text-slate-800 dark:text-slate-200">{doc.fileName || doc.documentType || "Uploaded document"}</div><div className="text-[11px] text-slate-500">{doc.status || "Uploaded"}</div></div>
                      <div className="flex shrink-0 gap-2">{previewUrl && <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-velo-600 hover:underline">Preview</a>}{downloadUrl && <a href={downloadUrl} download={doc.fileName} className="text-xs font-semibold text-slate-600 hover:underline">Download</a>}</div>
                    </div>;
                  })}
                </div>
              </div>
            ) : null}
            <button type="button" onClick={submitAddressReview} disabled={!canSubmitAddressReview || busy || (kyc?.status === "PENDING_VERIFICATION" && Boolean(checklist.proofOfAddress))} className="btn-primary inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50">
              {busy ? "Submitting…" : kyc?.status === "PENDING_VERIFICATION" && checklist.proofOfAddress ? "Under review" : "Submit documents for review"}
            </button>
            {!canSubmitAddressReview && <p className="text-xs text-slate-500">Verify BVN, NIN, liveness, and upload signature and proof of address before submitting.</p>}
          </div>
        )}
      </section>
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
                disabled={otpPickerState?.phase === "sending"}
                className="rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                onClick={() => { if (otpPickerState?.phase !== "sending") setOtpMethodPickerFor(null); }}
                aria-label="Close"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>
              </button>
            </div>
            <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 border border-t-0 border-slate-200 sm:border rounded-b-none sm:rounded-b-2xl dark:border-slate-700">
              {otpPickerState?.phase === "sending" ? (
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
              ) : otpPickerState?.phase === "success" ? (
                <div className="flex flex-col items-center justify-center py-4 text-center gap-3">
                  <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 animate-pulse">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                  <div>
                    <div className="text-sm font-bold text-slate-900 dark:text-white">Ownership confirmed automatically</div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{otpPickerState.message || "Phone on file already matches your account. No code required."}</div>
                  </div>
                </div>
              ) : otpPickerState?.phase === "error" ? (
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
                      <div className="text-left"><div className="text-sm font-semibold text-velo-900 dark:text-white">Retry SMS</div><div className="text-[11px] text-slate-500 dark:text-slate-400">Text to identity phone</div></div>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="ml-auto text-slate-300 group-hover:text-velo-500 dark:text-slate-600 dark:group-hover:text-velo-400"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                    <button type="button" className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-4 hover:border-emerald-500 hover:bg-emerald-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-emerald-400 dark:hover:bg-emerald-950/20 transition-colors group" onClick={() => void verifyIdentityWithChannel(otpMethodPickerFor, "WHATSAPP")}>
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 group-hover:bg-emerald-500 group-hover:text-white"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M20 12a8 8 0 11-3.2-6.4L20 4l-1.6 3.2A7.9 7.9 0 0120 12zM8.3 15.4c-.2-.5-1-1-1.5-1.1l-.5-.2c-.6-.2-1.3.2-1.3.9 0 1.4 1.8 2.8 4.1 2.8 2 0 3.6-.8 4.6-2.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
                      <div className="text-left"><div className="text-sm font-semibold text-velo-900 dark:text-white">Retry WhatsApp</div><div className="text-[11px] text-slate-500 dark:text-slate-400">Message on WhatsApp</div></div>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="ml-auto text-slate-300 group-hover:text-emerald-500 dark:text-slate-600 dark:group-hover:text-emerald-400"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button type="button" className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-4 hover:border-velo-500 hover:bg-velo-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-velo-400 dark:hover:bg-velo-950/20 transition-colors group" onClick={() => void verifyIdentityWithChannel(otpMethodPickerFor, "SMS")}>
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-sky-400 to-velo-500 text-white shadow-sm shadow-velo-500/20"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg></div>
                    <div className="text-left min-w-0 flex-1"><div className="text-sm font-semibold text-velo-900 dark:text-white">SMS</div><div className="text-[11px] text-slate-500 dark:text-slate-400 break-words">Text to identity phone</div></div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 text-slate-300 group-hover:text-velo-500 dark:text-slate-600 dark:group-hover:text-velo-400"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                  <button type="button" className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-4 hover:border-emerald-500 hover:bg-emerald-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-emerald-400 dark:hover:bg-emerald-950/20 transition-colors group" onClick={() => void verifyIdentityWithChannel(otpMethodPickerFor, "WHATSAPP")}>
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-sm shadow-emerald-500/20"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M20 12a8 8 0 11-3.2-6.4L20 4l-1.6 3.2A7.9 7.9 0 0120 12zM8.3 15.4c-.2-.5-1-1-1.5-1.1l-.5-.2c-.6-.2-1.3.2-1.3.9 0 1.4 1.8 2.8 4.1 2.8 2 0 3.6-.8 4.6-2.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
                    <div className="text-left min-w-0 flex-1"><div className="text-sm font-semibold text-velo-900 dark:text-white">WhatsApp</div><div className="text-[11px] text-slate-500 dark:text-slate-400 break-words">Message on WhatsApp</div></div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 text-slate-300 group-hover:text-emerald-500 dark:text-slate-600 dark:group-hover:text-emerald-400"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function buildUnifiedTxs(data: TransactionData | null): UnifiedTx[] {
  const out: UnifiedTx[] = [];
  if (!data) return out;
  (data.ledger || []).forEach((entry: any) => {
    const entryType = String(entry.entryType || "");
    const direction: "CREDIT" | "DEBIT" = entry.direction === "CREDIT" ? "CREDIT" : entry.direction === "DEBIT" ? "DEBIT" : (["INVESTOR_FUNDING", "INVESTMENT_RETURN", "DEPOSIT_CREDIT", "FUNDING"].some(k => entryType.includes(k)) ? "CREDIT" : "DEBIT");
    let kind: UnifiedTx["kind"] = "OTHER";
    if (/FUNDING|DEPOSIT/.test(entryType)) kind = "FUNDING";
    else if (/INVESTMENT.*LOCK|INVESTMENT_DEBIT/.test(entryType)) kind = "INVESTMENT_LOCK";
    else if (/INVESTMENT.*RETURN|INVESTMENT_CREDIT|MATURITY/.test(entryType)) kind = "INVESTMENT_RETURN";
    else if (/PAYOUT|WITHDRAWAL/.test(entryType)) kind = "PAYOUT";
    else if (/FEE/.test(entryType)) kind = "FEE";
    out.push({
      id: String(entry.id || `ledger-${entry.createdAt}-${entry.amountMinor}`),
      kind,
      direction,
      amountMinor: Number(entry.amountMinor ?? 0),
      label: String(entry.entryType || "Ledger entry").replace(/_/g, " "),
      narration: entry.description || entry.narration,
      referenceId: entry.referenceId,
      createdAt: entry.createdAt || new Date().toISOString(),
      balanceAfterMinor: entry.balanceAfterMinor != null ? Number(entry.balanceAfterMinor) : undefined,
      raw: entry,
    });
  });
  (data.walletTransactions || []).forEach((tx: any) => {
    const isCredit = /CREDIT|DEPOSIT|FUNDING|IN/.test(String(tx.type || tx.direction || "").toUpperCase());
    const amountMinor = tx.amountMinor != null ? Number(tx.amountMinor) : tx.amountNaira != null ? Number(tx.amountNaira) * 100 : 0;
    out.push({
      id: String(tx.id || `wallet-${tx.createdAt}-${tx.amountMinor}`),
      kind: isCredit ? "DEPOSIT" : "OTHER",
      direction: isCredit ? "CREDIT" : "DEBIT",
      amountMinor: Number.isFinite(amountMinor) ? amountMinor : 0,
      label: tx.type ? String(tx.type).replace(/_/g, " ") : "Wallet transaction",
      narration: tx.description || tx.narration,
      referenceId: tx.reference || tx.txRef || tx.transactionId,
      createdAt: tx.createdAt || new Date().toISOString(),
      balanceAfterMinor: tx.balanceAfterMinor != null ? Number(tx.balanceAfterMinor) : undefined,
      raw: tx,
    });
  });
  (data.investments || []).forEach((inv: any, i: number) => {
    const amountMinor = inv.amountMinor != null ? Number(inv.amountMinor) : inv.amountNaira != null ? Number(inv.amountNaira) * 100 : 0;
    out.push({
      id: String(inv.id || `inv-${i}`),
      kind: "INVESTMENT",
      direction: "DEBIT",
      amountMinor: Number.isFinite(amountMinor) ? amountMinor : 0,
      label: inv.planSnapshot?.name ? `Investment: ${inv.planSnapshot.name}` : "New investment",
      narration: `Investment created · Status: ${inv.status || "PENDING"}`,
      referenceId: inv.id,
      createdAt: inv.createdAt || new Date().toISOString(),
      raw: inv,
    });
  });
  (data.payouts || []).forEach((p: any, i: number) => {
    const amountMinor = p.amountMinor != null ? Number(p.amountMinor) : p.amountNaira != null ? Number(p.amountNaira) * 100 : 0;
    out.push({
      id: String(p.id || `payout-${i}`),
      kind: "PAYOUT",
      direction: "CREDIT",
      amountMinor: Number.isFinite(amountMinor) ? amountMinor : 0,
      label: "Investment payout",
      narration: `Payout status: ${p.status || "PENDING"}`,
      referenceId: p.referenceId || p.id,
      createdAt: p.createdAt || new Date().toISOString(),
      raw: p,
    });
  });
  return out.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

type InvestorTransactionsProps = { transactions: TransactionData | null; selectedTx: UnifiedTx | null; setSelectedTx: (t: UnifiedTx | null) => void };

const InvestorTransactionRow = memo(function InvestorTransactionRow({
  tx,
  selected,
  onClick,
}: {
  tx: UnifiedTx;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left flex items-center gap-3 p-3 rounded-xl border transition cursor-pointer ${
        selected
          ? "border-velo-400 bg-velo-50 dark:bg-velo-900/30 dark:border-velo-500"
          : "border-slate-100 dark:border-slate-800 hover:border-velo-200 dark:hover:border-velo-800 hover:bg-slate-50 dark:hover:bg-slate-800/50"
      }`}
    >
      <div className={`mt-0.5 inline-flex h-9 w-9 items-center justify-center rounded-lg flex-shrink-0 ${tx.direction === "CREDIT" ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400" : "bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400"}`}>
        {tx.direction === "CREDIT" ? "▲" : "▼"}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="font-bold text-sm text-velo-900 dark:text-white truncate">{tx.label}</div>
          <div className={`font-black text-sm whitespace-nowrap ${tx.direction === "CREDIT" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
            {tx.direction === "CREDIT" ? "+" : "-"}₦{Math.round(tx.amountMinor / 100).toLocaleString("en-NG")}
          </div>
        </div>
        {tx.narration && <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 line-clamp-1">{tx.narration}</div>}
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="text-[10px] text-slate-400 dark:text-slate-500">{new Date(tx.createdAt).toLocaleString()}</div>
          <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">View details to print</span>
        </div>
      </div>
    </button>
  );
});

function InvestorTransactions(props: InvestorTransactionsProps) {
  const { transactions, selectedTx, setSelectedTx } = props;
  const all = useMemo(() => buildUnifiedTxs(transactions), [transactions]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [searchFilter, setSearchFilter] = useState("");
  const deferredSearch = useDeferredValue(searchFilter);
  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    if (!q) return all;
    return all.filter((tx) =>
      (tx.label ?? "").toLowerCase().includes(q) ||
      (tx.narration ?? "").toLowerCase().includes(q) ||
      (tx.referenceId ?? "").toLowerCase().includes(q) ||
      tx.kind.toLowerCase().includes(q) ||
      String(Math.round(tx.amountMinor / 100)).includes(q.replace(/,/g, ""))
    );
  }, [all, deferredSearch]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const paged = filtered.slice(startIdx, startIdx + pageSize);
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Transactions</p>
          <h1 className="mt-2 text-xl font-bold text-velo-900 sm:text-2xl md:text-3xl dark:text-white">Transactions &amp; history</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">All wallet credits, debits, investments, and payouts.</p>
        </div>
      </div>
      <section className="velo-card p-4 sm:p-5 lg:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="section-heading">All transactions</h2>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <input
              type="search"
              placeholder="Search label, ref, amount…"
              value={searchFilter}
              onChange={(e) => { setSearchFilter(e.target.value); setPage(1); }}
              className="w-full sm:w-64 min-h-[40px] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-velo-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-velo-500/40 focus:border-velo-500"
            />
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
              Show
              <select
                value={pageSize}
                onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                className="min-h-[36px] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-sm"
              >
                {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
        </div>
        {all.length ? (
          <div className="mt-5 space-y-2">
            {paged.map((tx) => (
              <InvestorTransactionRow
                key={tx.id}
                tx={tx}
                selected={selectedTx?.id === tx.id}
                onClick={() => setSelectedTx(tx)}
              />
            ))}
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-t border-slate-100 dark:border-slate-800 pt-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Showing {filtered.length ? startIdx + 1 : 0}–{Math.min(startIdx + pageSize, filtered.length)} of {filtered.length}
                {filtered.length !== all.length && <span className="text-slate-400"> · filtered from {all.length} total</span>}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                  className="min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-semibold text-velo-900 dark:text-white hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span className="inline-flex items-center gap-1"><Icon name="arrowLeft" size={14} />Prev</span>
                </button>
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 px-2">
                  Page {safePage} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage >= totalPages}
                  className="min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-semibold text-velo-900 dark:text-white hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span className="inline-flex items-center gap-1">Next<Icon name="arrowRight" size={14} /></span>
                </button>
              </div>
            </div>
          </div>
        ) : <Empty text="No transactions yet. Fund your wallet or create your first investment to get started." />}
      </section>
      {selectedTx && (
        <div className="transaction-receipt-modal fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-sm px-4 animate-fade-in">
          <div className="velo-card w-full max-w-lg p-6 shadow-2xl animate-slide-in-left max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-bold text-velo-900 dark:text-white">Transaction details</h3>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Reference · {selectedTx.referenceId || selectedTx.id.slice(0, 10)}</p>
              </div>
              <button type="button" className="no-print rounded-lg p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-white" onClick={() => setSelectedTx(null)} aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>
            </div>
            <div className={`mt-5 rounded-2xl p-5 ${selectedTx.direction === "CREDIT" ? "bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 border border-emerald-100 dark:border-emerald-900/30" : "bg-red-50 dark:bg-red-900/20 dark:border-red-900/30 border border-red-100 dark:border-red-900/30"}`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-wider font-bold text-slate-500 dark:text-slate-400">
                    {selectedTx.direction === "CREDIT" ? "Wallet credit" : "Wallet debit"}
                  </div>
                  <div className="mt-1 text-2xl font-black text-velo-900 dark:text-white">{selectedTx.label}</div>
                </div>
                <div className={`text-3xl font-black ${selectedTx.direction === "CREDIT" ? "text-emerald-600" : "text-red-600"}`}>
                  {selectedTx.direction === "CREDIT" ? "+" : "-"}₦{Math.round(selectedTx.amountMinor / 100).toLocaleString("en-NG")}
                </div>
              </div>
            </div>
            <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 p-4">
                <div className="text-[11px] uppercase tracking-wider font-bold text-slate-500 dark:text-slate-400">Date &amp; time</div>
                <div className="mt-1 font-semibold text-velo-900 dark:text-white">{new Date(selectedTx.createdAt).toLocaleString()}</div>
              </div>
              <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 p-4">
                <div className="text-[11px] uppercase tracking-wider font-bold text-slate-500 dark:text-slate-400">Type</div>
                <div className="mt-1 font-semibold text-velo-900 dark:text-white">{selectedTx.kind.replace(/_/g, " ")}</div>
              </div>
              <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 p-4">
                <div className="text-[11px] uppercase tracking-wider font-bold text-slate-500 dark:text-slate-400">Reference ID</div>
                <div className="mt-1 font-mono text-xs font-semibold text-velo-900 dark:text-white break-all">{selectedTx.referenceId || "—"}</div>
              </div>
              <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 p-4">
                <div className="text-[11px] uppercase tracking-wider font-bold text-slate-500 dark:text-slate-400">Wallet balance after</div>
                <div className="mt-1 font-semibold text-velo-900 dark:text-white">{selectedTx.balanceAfterMinor != null ? money.format(selectedTx.balanceAfterMinor / 100) : "—"}</div>
              </div>
              {selectedTx.narration && (
                <div className="sm:col-span-2 rounded-xl bg-slate-50 dark:bg-slate-800/50 p-4">
                  <div className="text-[11px] uppercase tracking-wider font-bold text-slate-500 dark:text-slate-400">Narration</div>
                  <div className="mt-1 font-semibold text-velo-900 dark:text-white">{selectedTx.narration}</div>
                </div>
              )}
            </div>
            <div className="no-print mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setSelectedTx(null)}>Close</button>
              <ReceiptPrint />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InvestorPayoutSection(props: any) {
  const { userId } = props;
  const [banks, setBanks] = useState([] as { id: number; name: string; code: string }[]);
  const [accounts, setAccounts] = useState([] as any[]);
  const [selectedBank, setSelectedBank] = useState("");
  const [bankQuery, setBankQuery] = useState("");
  const [bankMenuOpen, setBankMenuOpen] = useState(false);
  const [accountNumber, setAccountNumber] = useState("");
  const [resolvedName, setResolvedName] = useState(null as string | null);
  const [resolveError, setResolveError] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [defaultId, setDefaultId] = useState(null as string | null);
  const [pendingRequest, setPendingRequest] = useState(null as any);
  const filteredBanks = banks.filter((bank) => bank.name.toLowerCase().includes(bankQuery.trim().toLowerCase()));
  const selectedBankName = banks.find((bank) => bank.code === selectedBank)?.name || "";

  async function loadBanks() {
    if (banks.length) return;
    setBusy("banks");
    try {
      const res = await fetch(`${config.apiUrl}/api/v1/providers/flutterwave/banks`, {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
      });
      if (!res.headers.get("content-type")?.includes("application/json")) {
        throw new Error("Server returned non-JSON response when loading banks");
      }
      const body = await res.json();
      if (body.ok) setBanks(body.banks || []);
      else setError(body.error || "Could not load banks");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to load banks"); }
    finally { setBusy(""); }
  }

  async function reloadAccounts() {
    if (!userId) return;
    try {
      const res = await fetch(`${config.apiUrl}/api/v1/investor/payout-accounts`, {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
      });
      if (!res.headers.get("content-type")?.includes("application/json")) return;
      const body = await res.json();
      if (body.ok) {
        setAccounts(body.accounts || []);
        setDefaultId(body.defaultId || body.accounts?.find((account: any) => account.isDefault)?.id || null);
        setPendingRequest(body.pendingRequest || body.pendingRequests?.[0] || null);
      }
    } catch (_e) { /* ignore */ }
  }

  useEffect(() => { void loadBanks(); void reloadAccounts(); }, [userId]);

  useEffect(() => {
    if (selectedBank && /^\d{10}$/.test(accountNumber) && !resolvedName && !resolveError && busy !== "resolve") void resolveAccount();
  }, [selectedBank, accountNumber, resolvedName, resolveError, busy]);

  async function resolveAccount() {
    if (!selectedBank || accountNumber.length < 10) return;
    setResolveError(""); setResolvedName(null); setBusy("resolve");
    try {
      const res = await fetch(`${config.apiUrl}/api/v1/investor/payout-accounts/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getAccessToken()}` },
        body: JSON.stringify({ bankCode: selectedBank, accountNumber }),
      });
      if (!res.headers.get("content-type")?.includes("application/json")) {
        throw new Error("Server returned non-JSON response when resolving account");
      }
      const body = await res.json();
      if (body.ok) setResolvedName(body.accountName || body.resolved?.accountName || "");
      else setResolveError(body.error || "Could not resolve account");
    } catch (err) { setResolveError(err instanceof Error ? err.message : "Resolution failed"); }
    finally { setBusy(""); }
  }

  async function saveAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedBank || accountNumber.length !== 10 || !resolvedName) return;
    setBusy("save"); setMessage(""); setError("");
    try {
      const bankName = banks.find(b => b.code === selectedBank)?.name;
      const res = await fetch(`${config.apiUrl}/api/v1/investor/payout-accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getAccessToken()}` },
        body: JSON.stringify({ bankCode: selectedBank, bankName, accountNumber, accountName: resolvedName }),
      });
      if (!res.headers.get("content-type")?.includes("application/json")) {
        throw new Error("Server returned non-JSON response when saving account");
      }
      const body = await res.json();
      if (body.ok) {
        if (body.pendingApproval) {
          setMessage(body.message || "Update submitted. Awaiting admin approval.");
          setPendingRequest(body.request || null);
        } else {
          setMessage("Payout account saved.");
          void reloadAccounts();
        }
        setSelectedBank(""); setBankQuery(""); setBankMenuOpen(false); setAccountNumber(""); setResolvedName(null);
      } else setError(body.error || "Save failed");
    } catch (err) { setError(err instanceof Error ? err.message : "Save failed"); }
    finally { setBusy(""); }
  }

  async function setDefault(accId: string) {
    setBusy("default");
    try {
      const res = await fetch(`${config.apiUrl}/api/v1/investor/payout-accounts/${encodeURIComponent(accId)}/default`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${getAccessToken()}` },
      });
      if (!res.headers.get("content-type")?.includes("application/json")) {
        throw new Error("Server returned non-JSON response");
      }
      const body = await res.json();
      if (body.ok) { setDefaultId(accId); setMessage("Default payout account updated."); void reloadAccounts(); }
      else setError(body.error || "Could not update");
    } catch (err) { setError(err instanceof Error ? err.message : "Update failed"); }
    finally { setBusy(""); }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Payout account</p>
          <h1 className="mt-2 text-xl font-bold text-velo-900 sm:text-2xl md:text-3xl dark:text-white">Bank payout setup</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">Add a Nigerian bank account for payouts. Subsequent edits require admin approval.</p>
        </div>
      </div>
      {error && <div className="rounded-xl border border-red-100 bg-red-50 dark:bg-red-900/20 dark:border-red-900/30 p-4 text-sm text-red-700 dark:text-red-400">{error}</div>}
      {message && <div className="rounded-xl border border-emerald-100 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 p-4 text-sm text-emerald-700 dark:text-emerald-400">{message}</div>}
      {pendingRequest && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-900/30 p-4 text-sm text-amber-800 dark:text-amber-300">
          <div className="flex items-center gap-2 font-semibold"><Icon name="clock" size={15} />Payout account change pending admin approval</div>
          <div className="mt-1 text-xs">New: {pendingRequest.newSnapshot?.bankName} ••••{String(pendingRequest.newSnapshot?.accountNumber || "").slice(-4)} — {pendingRequest.newSnapshot?.accountName}</div>
        </div>
      )}
      <section className="velo-card p-4 sm:p-5 lg:p-6">
        <h2 className="section-heading">{accounts.length ? "Edit payout account" : "Add payout account"}</h2>
        <p className="section-subheading">Select your bank and verify the account name before saving.</p>
        <form onSubmit={saveAccount} className="mt-5 grid gap-4 md:grid-cols-3 md:items-end">
          <div className="velo-label relative">
            <label htmlFor="payout-bank-search">Bank <span className="text-red-500">*</span></label>
            <div className="relative mt-1">
              <input
                id="payout-bank-search"
                className="velo-input pr-10"
                value={bankMenuOpen ? bankQuery : selectedBankName}
                onFocus={() => { setBankMenuOpen(true); setBankQuery(""); }}
                onChange={(e) => { setBankQuery(e.target.value); setBankMenuOpen(true); setSelectedBank(""); setResolvedName(null); setResolveError(""); }}
                placeholder={busy === "banks" ? "Loading banks…" : "Search banks…"}
                autoComplete="off"
                required={!selectedBank}
                disabled={busy === "banks"}
                role="combobox"
                aria-expanded={bankMenuOpen}
                aria-controls="payout-bank-options"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true">⌄</span>
            </div>
            {bankMenuOpen && !busy && (
              <div id="payout-bank-options" role="listbox" className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl dark:border-slate-700 dark:bg-slate-900">
                {filteredBanks.length ? filteredBanks.map((bank) => (
                  <button
                    key={bank.code}
                    type="button"
                    role="option"
                    aria-selected={selectedBank === bank.code}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-emerald-50 hover:text-emerald-800 dark:text-slate-200 dark:hover:bg-emerald-900/30 dark:hover:text-emerald-200"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => { setSelectedBank(bank.code); setBankQuery(""); setBankMenuOpen(false); setResolvedName(null); setResolveError(""); }}
                  >
                    <span>{bank.name}</span><span className="ml-3 text-[10px] font-mono text-slate-400">{bank.code}</span>
                  </button>
                )) : <div className="px-3 py-6 text-center text-xs text-slate-500">No banks match “{bankQuery}”.</div>}
              </div>
            )}
          </div>
          <label className="velo-label">
            Account number <span className="text-red-500">*</span>
            <input className="velo-input mt-1" inputMode="numeric" maxLength={10} required value={accountNumber} onChange={(e) => { setAccountNumber(e.target.value.replace(/\D/g, "")); setResolvedName(null); setResolveError(""); }} placeholder="10-digit NUBAN" />
          </label>
          <div className="flex flex-col gap-2">
            {busy === "resolve" && <p className="text-sm text-slate-500">Resolving account name…</p>}
            {resolvedName && <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 p-3 text-sm text-emerald-700 dark:text-emerald-400"><span className="font-semibold">Account name:</span> {resolvedName}</div>}
            {resolveError && <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-900/30 p-3 text-sm text-red-700 dark:text-red-400">{resolveError}</div>}
          </div>
          <div className="md:col-span-3 flex flex-wrap gap-3 items-center">
            <button type="submit" className="btn-primary" disabled={busy === "save" || !resolvedName}>{busy === "save" ? "Saving…" : accounts.length ? "Submit changes for approval" : "Save account"}</button>
            {accounts.length > 0 && <div className="flex items-center gap-1.5 text-xs text-slate-500"><Icon name="alert" size={14} />Subsequent edits require admin approval.</div>}
          </div>
        </form>
      </section>
      <section className="velo-card p-4 sm:p-5 lg:p-6">
        <h2 className="section-heading">Saved payout accounts</h2>
        <p className="section-subheading">Choose a default account for settlements.</p>
        {accounts.length ? (
          <div className="mt-5 space-y-3">
            {accounts.map((acc: any) => (
              <div key={acc.id} className={`rounded-xl border p-4 flex flex-wrap justify-between gap-3 items-center ${defaultId === acc.id ? "border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/10" : "border-slate-100 dark:border-slate-800"}`}>
                <div>
                  <div className="text-sm font-semibold text-velo-900 dark:text-white">{acc.bankName} ••••{String(acc.accountNumber).slice(-4)}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{acc.accountName} · Status: {acc.status}</div>
                </div>
                <div className="flex items-center gap-2">
                  {defaultId === acc.id ? <span className="badge badge-completed">Default</span> : <button type="button" className="btn-secondary text-xs" onClick={() => void setDefault(acc.id)} disabled={busy === "default"}>Set as default</button>}
                </div>
              </div>
            ))}
          </div>
        ) : <Empty text="No payout accounts saved yet." />}
      </section>
    </div>
  );
}

function InvestorProfile(props: any) {
  const { user } = props;
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Profile</p>
          <h1 className="mt-2 text-xl font-bold text-velo-900 sm:text-2xl md:text-3xl dark:text-white">Personal information</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Review and edit your account details, email and phone below.
          </p>
        </div>
      </div>
      <section className="velo-card p-4 sm:p-5 lg:p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          {[["Full name", user?.fullName], ["Email", user?.email], ["Phone", user?.phone], ["KYC status", user?.kycStatus]].map(([k, v]) => (
            <div key={k as string} className="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-4">
              <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">{k}</div>
              <div className="mt-1 font-medium text-velo-900 dark:text-white">{v || "—"}</div>
            </div>
          ))}
        </div>
      </section>
      <ProfileSettings />
      <OtpLoginSettings />
    </div>
  );
}

function Metric(props: any) {
  const { label, value, detail } = props;
  return (
    <div className="velo-card p-4 sm:p-5">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-bold text-velo-900 dark:text-white break-words">{value}</p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{detail}</p>
    </div>
  );
}

function Legend(props: any) { const { color, label, value } = props; return <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-slate-600 dark:text-slate-400"><span className={`h-2.5 w-2.5 rounded-full ${color}`} />{label}</span><strong className="text-velo-900 dark:text-white">{value}</strong></div>; }

function Empty(props: any) { const { text = "No records found." } = props; return <div className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">{text}</div>; }
