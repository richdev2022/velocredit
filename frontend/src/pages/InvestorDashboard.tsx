import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import Layout from "../components/Layout";
import PremblyKycWidgetButton from "../components/PremblyKycWidgetButton";
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
} from "../services/apiClient";

const money = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
  maximumFractionDigits: 0,
});
type DashboardData = {
  wallet?: { availableMinor?: number; heldMinor?: number };
  investments?: Array<{
    expectedInterestMinor?: number;
    expectedInterestNaira?: number;
  }>;
};
type TransactionData = {
  payouts?: Array<{ amountNaira?: number; status?: string }>;
  investments?: Array<unknown>;
};
type KycData = {
  status?: string;
  checklist?: { bvn?: boolean; nin?: boolean; proofOfAddress?: boolean; passport?: boolean; signature?: boolean; selfieUploaded?: boolean };
};
type Plan = { id: string; name: string; tenureDays: number; annualRatePercent: number; minAmountNaira: number };

export default function InvestorDashboard() {
  const { user, addUserRole, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null as DashboardData | null);
  const [transactions, setTransactions] = useState(null as TransactionData | null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [switchingBusy, setSwitchingBusy] = useState(false);
  const [switchMsg, setSwitchMsg] = useState("");
  const [kyc, setKyc] = useState(null as KycData | null);
  const [kycBusy, setKycBusy] = useState("");
  const [kycError, setKycError] = useState("");
  const [bvn, setBvn] = useState("");
  const [nin, setNin] = useState("");
  const [action, setAction] = useState("" as "fund" | "plans" | "transactions" | "");
  const [fundingAmount, setFundingAmount] = useState("100000");
  const [plans, setPlans] = useState([] as Plan[]);
  const [fundingBanner, setFundingBanner] = useState(null as { ok: boolean; text: string } | null);
  const [view, setView] = useState("overview" as "overview" | "wallet" | "investments" | "kyc" | "transactions" | "payout" | "profile");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const investorMenu: Array<{ key: typeof view; label: string; icon: string; hint?: string }> = [
    { key: "overview", label: "Overview", icon: "🏠", hint: "Summary & KPIs" },
    { key: "wallet", label: "Wallet", icon: "💳", hint: "Fund & withdraw" },
    { key: "investments", label: "Investments", icon: "📈", hint: "Plans & positions" },
    { key: "kyc", label: "Verification", icon: "✅", hint: "BVN / NIN / Liveness" },
    { key: "transactions", label: "Transactions", icon: "🧾", hint: "Ledger & history" },
    { key: "payout", label: "Payout account", icon: "🏦", hint: "Bank details" },
    { key: "profile", label: "Profile", icon: "👤", hint: "Personal information" },
  ];
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
          Promise.all([getInvestorDashboard(), getInvestorTransactions(), getMyKyc()])
            .then(([dashboard, history, kycResponse]) => {
              setData(dashboard as DashboardData);
              setTransactions(history as TransactionData);
              setKyc(kycResponse as unknown as KycData);
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
    Promise.all([getInvestorDashboard(), getInvestorTransactions(), getMyKyc()])
      .then(([dashboard, history, kycResponse]) => {
        setData(dashboard as DashboardData);
        setTransactions(history as TransactionData);
        setKyc(kycResponse as unknown as KycData);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Unable to load investor data")
      );
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
    setOtpMethodPickerFor(type);
  }

  async function verifyIdentityWithChannel(type: "BVN" | "NIN", channel: "SMS" | "WHATSAPP") {
    const value = type === "BVN" ? bvn : nin;
    setOtpMethodPickerFor(null);
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
        setKycError(`A verification code was sent to the phone number ending in ${type} records ending in ···${challenge.phoneLastFour}. Enter the code to confirm ownership.`);
        setKycBusy("");
        return;
      }
      setKyc((current) => ({ ...current, status: response.status, checklist: response.checklist as unknown as KycData["checklist"] }));
      await refreshUser();
      setMessage(`${type} verification completed successfully.`);
    } catch (err) {
      setKycError(err instanceof Error ? err.message : `Unable to verify ${type}`);
    } finally {
      if (!activeOtpChallenge) setKycBusy("");
    }
  }

  async function submitActiveKycOtp() {
    if (!activeOtpChallenge || activeOtpChallenge.otpCode.length !== 6) return;
    setActiveOtpChallenge((current) => current ? { ...current, busy: true, error: undefined } : current);
    try {
      const confirmed = await confirmKycOwnershipOtp({ idType: activeOtpChallenge.idType, challengeId: activeOtpChallenge.challenge.challengeId, code: activeOtpChallenge.otpCode });
      setKyc((current) => ({ ...current, status: confirmed.status ?? current?.status, checklist: confirmed.checklist as unknown as KycData["checklist"] }));
      await refreshUser();
      setMessage(`${activeOtpChallenge.idType} ownership verified. Thank you.`);
      setKycError("");
      setActiveOtpChallenge(null);
    } catch (err) {
        const reason = err instanceof Error ? err.message : "Unable to verify code";
        setActiveOtpChallenge((current) => current ? { ...current, busy: false, error: reason, otpCode: "" } : current);
        setKycError(reason);
    }
  }

  async function resendActiveKycOtp(newChannel?: "SMS"|"WHATSAPP") {
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
      setKyc((current) => ({ ...current, checklist: response.checklist as unknown as KycData["checklist"] }));
      setMessage("Proof of address uploaded. Submit it for review when BVN and NIN are verified.");
    } catch (err) {
      setKycError(err instanceof Error ? err.message : "Unable to upload proof of address");
    } finally {
      setKycBusy("");
    }
  }

  async function submitAddressReview() {
    if (!kyc?.checklist?.bvn || !kyc.checklist.nin || !kyc.checklist.proofOfAddress) return;
    setBusy(true);
    setKycError("");
    try {
      const response = await import("../services/apiClient").then(({ submitKyc }) => submitKyc());
      setKyc((current) => ({ ...current, status: response.status, checklist: response.checklist as unknown as KycData["checklist"] }));
      await refreshUser();
      setMessage("Proof of address submitted for manual review.");
    } catch (err) {
      setKycError(err instanceof Error ? err.message : "Unable to submit proof of address");
    } finally {
      setBusy(false);
    }
  }

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

  async function onPremblyLivenessResult(result: any) {
    if (result.success) {
      setMessage("Liveness scan submitted. Syncing with the provider — your KYC status will update within 60 seconds.");
      let attempts = 0;
      const maxAttempts = 12;
      const poll = window.setInterval(async () => {
        attempts += 1;
        try {
          const updated = await getMyKyc();
          const checklist = (updated as any)?.checklist ?? {};
          setKyc(updated as unknown as KycData);
          await refreshUser();
          if (checklist.liveness || checklist.selfieUploaded || attempts >= maxAttempts) {
            window.clearInterval(poll);
            setMessage(checklist.liveness ? "Liveness verified. Thank you." : "Liveness processing complete. If status hasn't updated yet, refresh in a minute.");
          }
        } catch (_e) { /* ignore */ }
      }, 5000);
    } else {
      setKycError(result.message);
    }
  }

  async function openAction(nextAction: "fund" | "plans" | "transactions") {
    setAction(nextAction);
    if (nextAction === "plans" && !plans.length) {
      try {
        const response = await getInvestmentPlans();
        setPlans(response.plans as Plan[]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load investment plans");
      }
    }
  }

  async function handleFundWallet(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const response = await fundWallet(Number(fundingAmount));
      const link = response.checkout?.data?.link;
      if (link) window.location.assign(link);
      else setMessage(response.message || "Wallet funding is being processed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start wallet funding");
    }
  }

  const wallet = data?.wallet;
  const investments = data?.investments ?? [];
  const available = Number(wallet?.availableMinor ?? 0) / 100;
  const locked = Number(wallet?.heldMinor ?? 0) / 100;
  const returns = investments.reduce(
    (sum, item) =>
      sum +
      Number(item.expectedInterestNaira ?? Number(item.expectedInterestMinor ?? 0) / 100),
    0
  );
  const totalCapital = available + locked;
  const activeCount = investments.filter((investment) => ["ACTIVE", "PENDING"].includes(String((investment as { status?: string }).status))).length;
  const returnRate = totalCapital ? Math.min(100, Math.round((returns / totalCapital) * 100)) : 0;

  const hasBothRoles = user?.roles.includes("INVESTOR") && user?.roles.includes("BORROWER");
  const checklist = kyc?.checklist ?? {};
  const canSubmitAddressReview = Boolean(checklist.bvn && checklist.nin && checklist.proofOfAddress);

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
          style={{ padding: sidebarOpen ? undefined : undefined }}
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
                      onClick={() => { setView(item.key); setMessage(""); setError(""); setSidebarOpen(false); }}
                      className={`w-full group flex items-center gap-3 px-3.5 py-2.5 sm:py-3 rounded-xl transition-all duration-200 text-left ${
                        active
                          ? "bg-gradient-to-r from-emerald-500 to-emerald-600 text-white shadow-md shadow-emerald-500/25 hover:shadow-lg hover:shadow-emerald-500/30"
                          : "text-slate-600 dark:text-slate-300 hover:bg-emerald-50 dark:hover:bg-slate-800/60 hover:text-velo-900 dark:hover:text-white"
                      }`}
                    >
                      <span className={`text-xl shrink-0 ${active ? "" : "opacity-90"}`}>{item.icon}</span>
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
                  <div className="mt-1 text-lg font-black">
                    {user?.kycStatus === "VERIFIED" ? "✅ Verified" : user?.kycStatus === "PENDING_VERIFICATION" ? "⏳ Reviewing" : "🔒 Action needed"}
                  </div>
                  <div className="mt-1 text-[11px] text-emerald-100/80">
                    {user?.kycStatus === "VERIFIED"
                      ? "You're ready to invest!"
                      : view !== "kyc"
                      ? (
                        <button type="button" onClick={() => { setView("kyc"); setSidebarOpen(false); }} className="underline underline-offset-2 font-semibold hover:text-white">
                          Tap here to complete →
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
              kyc={kyc}
              transactions={transactions}
              busy={busy}
              openAction={openAction}
              action={action}
              fundingAmount={fundingAmount}
              setFundingAmount={setFundingAmount}
              handleFundWallet={handleFundWallet}
              plans={plans}
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
              busy={busy}
              action={action}
              openAction={openAction}
              fundingAmount={fundingAmount}
              setFundingAmount={setFundingAmount}
              handleFundWallet={handleFundWallet}
            />
          )}

          {view === "investments" && (
            <InvestorInvestments
              investments={investments}
              plans={plans}
              loadPlans={() => openAction("plans")}
              totalCapital={totalCapital}
              returns={returns}
              returnRate={returnRate}
              busy={busy}
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
              verifyLivenessFile={verifyLivenessFile}
              onPremblyLivenessResult={onPremblyLivenessResult}
              kycError={kycError}
              message={message}
              setMessage={setMessage}
              activeOtpChallenge={activeOtpChallenge}
              setActiveOtpChallenge={setActiveOtpChallenge}
              submitActiveKycOtp={submitActiveKycOtp}
              resendActiveKycOtp={resendActiveKycOtp}
              otpMethodPickerFor={otpMethodPickerFor}
              setOtpMethodPickerFor={setOtpMethodPickerFor}
              verifyIdentityWithChannel={verifyIdentityWithChannel}
            />
          )}

          {view === "transactions" && (
            <InvestorTransactions
              transactions={transactions}
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
    </Layout>
  );
}

function InvestorOverview(props: any) {
  const { user, hasBothRoles, switchingBusy, switchMsg, handleEnableBorrower, fundingBanner, error, message, available, locked, returns, activeCount, totalCapital, returnRate, investments, kyc, transactions, busy, openAction, action, fundingAmount, setFundingAmount, handleFundWallet, plans } = props;
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
                    "Enable borrower access anytime. You can complete or continue KYC from the dashboard you choose."
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
                {user?.kycStatus === "VERIFIED" ? "5/5" : "0/5"}
              </span>
            </div>
            <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div
                className={`h-full rounded-full bg-velo-500 ${user?.kycStatus === "VERIFIED" ? "w-full" : "w-0"}`}
              />
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {[
                ["Identity info", "Legal name, DOB, contact"],
                ["BVN verification", "11-digit bank verification"],
                ["NIN verification", "National ID number check"],
                ["Proof of address", "Utility bill or statement"],
                ["Payout account", "Bank account for returns"],
              ].map(([t, d]) => (
                <div
                  key={t}
                  className={`flex items-start gap-3 p-3.5 rounded-xl border transition-colors ${
                    user?.kycStatus === "VERIFIED"
                      ? "bg-emerald-50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-900/30"
                      : "bg-slate-50 dark:bg-slate-800 border-slate-100 dark:border-slate-700"
                  }`}
                >
                  <div
                    className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                      user?.kycStatus === "VERIFIED"
                        ? "bg-emerald-500 text-white"
                        : "bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400"
                    }`}
                  >
                    {user?.kycStatus === "VERIFIED" ? (
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
              <button type="button" onClick={() => void openAction("fund")} className="w-full flex items-center justify-between gap-3 p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors group text-left">
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
              <button type="button" onClick={() => void openAction("transactions")} className="w-full flex items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors group text-left">
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
                      {transactions?.payouts?.length ?? 0} payout records
                    </div>
                  </div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400 group-hover:text-velo-600 group-hover:translate-x-0.5 transition-all">
                  <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            {action === "fund" && <form onSubmit={handleFundWallet} className="mt-4 flex gap-2"><input className="velo-input" type="number" min="1000" step="100" value={fundingAmount} onChange={(event) => setFundingAmount(event.target.value)} aria-label="Funding amount" /><button className="btn-primary shrink-0" type="submit">Continue to payment</button></form>}
            {action === "plans" && <div className="mt-4 space-y-2">{plans.map((plan: any) => <div key={plan.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700"><span className="font-semibold text-velo-900 dark:text-white">{plan.name} · {plan.tenureDays} days</span><span className="text-emerald-600">{plan.annualRatePercent}% p.a.</span></div>)}</div>}
            {action === "transactions" && <div className="mt-4 space-y-2 text-sm text-slate-600 dark:text-slate-300">{transactions?.payouts?.length ? transactions.payouts.map((payout: any, index: number) => <div key={index} className="flex justify-between"><span>{payout.status ?? "Payout"}</span><span>{money.format(Number(payout.amountNaira ?? 0))}</span></div>) : <p>No payout transactions yet.</p>}</div>}
          </section>
        </div>
      </div>
    </div>
  );
}

function InvestorWallet(props: any) {
  const { available, locked, returns, fundingBanner, error, message, busy, action, openAction, fundingAmount, setFundingAmount, handleFundWallet } = props;
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Wallet</p>
          <h1 className="mt-2 text-xl font-bold text-velo-900 sm:text-2xl md:text-3xl dark:text-white">Manage your funds</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">Fund your wallet and track your balances.</p>
        </div>
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
      <section className="velo-card p-4 sm:p-5 lg:p-6">
        <h2 className="section-heading">Fund wallet</h2>
        <p className="section-subheading">Make a deposit via Flutterwave.</p>
        <form className="mt-5 flex flex-col sm:flex-row gap-3 sm:items-end" onSubmit={handleFundWallet}>
          <label className="velo-label flex-1">
            Amount (NGN)
            <input className="velo-input mt-1" type="number" min="1000" step="100" value={fundingAmount} onChange={(e) => setFundingAmount(e.target.value)} />
          </label>
          <button className="btn-primary whitespace-nowrap" type="submit" disabled={busy}>Continue to payment</button>
        </form>
      </section>
    </div>
  );
}

function InvestorInvestments(props: any) {
  const { investments, plans, loadPlans, totalCapital, returns, returnRate } = props;
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
          {!plans.length && <button type="button" className="btn-secondary text-xs" onClick={() => loadPlans()}>Load plans</button>}
        </div>
        {plans.length ? (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan: Plan) => (
              <div key={plan.id} className="rounded-2xl border border-slate-100 dark:border-slate-800 p-4 bg-gradient-to-br from-white to-slate-50 dark:from-slate-900 dark:to-slate-900/50">
                <div className="text-sm font-bold text-velo-900 dark:text-white">{plan.name}</div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div><p className="text-slate-500">Tenor</p><p className="font-semibold dark:text-white">{plan.tenureDays} days</p></div>
                  <div><p className="text-slate-500">Rate</p><p className="font-semibold text-emerald-600">{plan.annualRatePercent}% p.a.</p></div>
                  <div><p className="text-slate-500">Min</p><p className="font-semibold dark:text-white">₦{Number(plan.minAmountNaira).toLocaleString()}</p></div>
                </div>
              </div>
            ))}
          </div>
        ) : <Empty text="No plans loaded." />}
      </section>
      <section className="velo-card p-4 sm:p-5 lg:p-6">
        <h2 className="section-heading">Investment history</h2>
        <p className="section-subheading">All your positions.</p>
        {investments.length ? (
          <div className="mt-5 space-y-3">
            {investments.map((inv: any, idx: number) => (
              <div key={inv.id || idx} className="rounded-xl border border-slate-100 dark:border-slate-800 p-4 flex flex-wrap justify-between gap-3">
                <div><div className="text-sm font-semibold text-velo-900 dark:text-white">{inv.planSnapshot?.name || `Investment ${idx + 1}`}</div><div className="text-xs text-slate-500 mt-0.5">Status: {inv.status || "UNKNOWN"} · Created: {inv.createdAt ? new Date(inv.createdAt).toLocaleDateString() : "—"}</div></div>
                <div className="text-right"><div className="font-bold dark:text-white">{money.format(Number(inv.amountNaira ?? 0))}</div><div className="text-xs text-emerald-600">+{money.format(Number(inv.expectedEarningsNaira ?? Number(inv.expectedInterestMinor ?? 0) / 100))}</div></div>
              </div>
            ))}
          </div>
        ) : <Empty text="No investments yet. Fund your wallet and choose a plan to begin." />}
      </section>
    </div>
  );
}

function InvestorKyc(props: any) {
  const { user, kyc, checklist, bvn, setBvn, nin, setNin, verifyIdentity, kycBusy, canSubmitAddressReview, submitAddressReview, busy, uploadProofOfAddress, verifyLivenessFile, onPremblyLivenessResult, kycError, message, activeOtpChallenge, setActiveOtpChallenge, submitActiveKycOtp, resendActiveKycOtp, otpMethodPickerFor, setOtpMethodPickerFor, verifyIdentityWithChannel } = props;
  const [error, setError] = useState("");
  useEffect(() => { setError(kycError); }, [kycError]);
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
          <span className="text-sm font-semibold text-velo-600">{user?.kycStatus === "VERIFIED" ? "5/5" : "0/5"}</span>
        </div>
        <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div className={`h-full rounded-full bg-velo-500 ${user?.kycStatus === "VERIFIED" ? "w-full" : "w-0"}`} />
        </div>
        {user?.kycStatus !== "VERIFIED" && (
          <div className="mt-6 space-y-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <p className="text-sm font-semibold text-velo-900 dark:text-white">Complete your verification</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="velo-label">
                BVN
                <div className="mt-1 flex gap-2">
                  <input className="velo-input min-w-0" inputMode="numeric" maxLength={11} value={bvn} onChange={(event) => setBvn(event.target.value.replace(/\D/g, ""))} placeholder="11-digit BVN" />
                  <button type="button" className="btn-secondary shrink-0" disabled={kycBusy === "BVN"} onClick={() => verifyIdentity("BVN")}>{kycBusy === "BVN" ? "Checking…" : checklist.bvn ? "Verified" : "Verify"}</button>
                </div>
              </label>
              <label className="velo-label">
                NIN
                <div className="mt-1 flex gap-2">
                  <input className="velo-input min-w-0" inputMode="numeric" maxLength={11} value={nin} onChange={(event) => setNin(event.target.value.replace(/\D/g, ""))} placeholder="11-digit NIN" />
                  <button type="button" className="btn-secondary shrink-0" disabled={kycBusy === "NIN"} onClick={() => verifyIdentity("NIN")}>{kycBusy === "NIN" ? "Checking…" : checklist.nin ? "Verified" : "Verify"}</button>
                </div>
              </label>
            </div>
            {activeOtpChallenge && (
              <div className="rounded-xl border border-sky-200 bg-sky-50/70 p-4 dark:border-sky-800/50 dark:bg-sky-950/20">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-sky-800 dark:text-sky-300">Confirm {activeOtpChallenge.idType} ownership — enter OTP</h3>
                    <p className="mt-1 text-xs text-sky-700/80 dark:text-sky-300/70">
                      Sent via <span className="font-semibold">{activeOtpChallenge.challenge.channel}</span> to the {activeOtpChallenge.idType}-linked phone number ending in ···{activeOtpChallenge.challenge.phoneLastFour}.
                    </p>
                  </div>
                  <button type="button" className="rounded-md p-1.5 text-sky-700/70 hover:bg-sky-100/70 dark:text-sky-300 dark:hover:bg-sky-900/40" onClick={() => setActiveOtpChallenge(null)} aria-label="Dismiss"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg></button>
                </div>
                <label className="velo-label mt-3 block">
                  One-time code (6 digits)
                  <input className="velo-input mt-1 tracking-[0.5em] text-center font-semibold text-lg" inputMode="numeric" maxLength={6} autoFocus value={activeOtpChallenge.otpCode} onChange={(event) => setActiveOtpChallenge((c: any) => c ? { ...c, otpCode: event.target.value.replace(/\D/g, ""), error: undefined } : c)} placeholder="• • • • • •" />
                </label>
                {activeOtpChallenge.error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{activeOtpChallenge.error}</p>}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-xs">
                    <button type="button" className="rounded-lg border border-sky-200 bg-white px-3 py-1.5 text-sky-800 hover:bg-sky-100 disabled:opacity-60 disabled:cursor-not-allowed dark:border-sky-800 dark:bg-slate-900 dark:text-sky-300 dark:hover:bg-sky-950/30" disabled={activeOtpChallenge.cooldown > 0 || activeOtpChallenge.busy} onClick={() => void resendActiveKycOtp("SMS")}>{activeOtpChallenge.cooldown > 0 ? `Resend SMS (${activeOtpChallenge.cooldown}s)` : "Resend via SMS"}</button>
                    <button type="button" className="rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-emerald-800 hover:bg-emerald-100 disabled:opacity-60 disabled:cursor-not-allowed dark:border-emerald-800 dark:bg-slate-900 dark:text-emerald-300 dark:hover:bg-emerald-950/30" disabled={activeOtpChallenge.cooldown > 0 || activeOtpChallenge.busy} onClick={() => void resendActiveKycOtp("WHATSAPP")}>{activeOtpChallenge.cooldown > 0 ? `Resend WA (${activeOtpChallenge.cooldown}s)` : "Resend via WhatsApp"}</button>
                  </div>
                  <button type="button" className="btn-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={activeOtpChallenge.otpCode.length !== 6 || activeOtpChallenge.busy} onClick={() => void submitActiveKycOtp()}>{activeOtpChallenge.busy ? "Verifying…" : "Confirm ownership"}</button>
                </div>
              </div>
            )}
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-800/50 dark:bg-emerald-900/10">
              <h3 className="mb-2 text-sm font-semibold text-emerald-800 dark:text-emerald-300">Liveness verification <span className="text-red-500">*</span></h3>
              <p className="mb-3 text-xs text-emerald-700 dark:text-emerald-300/80">Complete a quick in-app selfie scan using our identity verification widget (recommended &amp; primary method).</p>
              <div className="flex flex-wrap items-center gap-3">
                <PremblyKycWidgetButton fullName={user?.fullName} email={user?.email} phone={user?.phone} idType={checklist.bvn ? "BVN" : "NIN"} idNumber={bvn || nin || ""} onResult={onPremblyLivenessResult} />
                {checklist.selfieUploaded && <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">✓ Liveness verified</span>}
              </div>
              <div className="mt-4 border-t border-emerald-200/70 pt-3 dark:border-emerald-700/40">
                <details className="group">
                  <summary className="cursor-pointer text-xs font-medium text-slate-600 hover:text-slate-800 dark:text-slate-300 dark:hover:text-white">Having trouble with the camera? Click here to upload a selfie instead (fallback).</summary>
                  <div className="mt-2">
                    <label className="velo-label text-xs">
                      Upload live selfie
                      <input className="velo-input mt-1" type="file" accept="image/jpeg,image/png,image/webp" disabled={kycBusy === "LIVENESS_FILE"} onChange={(event) => { const file = event.target.files?.[0]; if (file) void verifyLivenessFile(file); }} />
                    </label>
                  </div>
                </details>
              </div>
            </div>
            <label className="velo-label block">
              Proof of address
              <input className="velo-input mt-1" type="file" accept="application/pdf,image/jpeg,image/png" disabled={kycBusy === "PROOF_OF_ADDRESS"} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadProofOfAddress(file); }} />
              <span className="mt-1 block text-xs font-normal text-slate-500">Upload a recent utility bill or bank statement.</span>
            </label>
            <button type="button" onClick={submitAddressReview} disabled={!canSubmitAddressReview || busy || kyc?.status === "PENDING_VERIFICATION"} className="btn-primary inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50">
              {busy ? "Submitting…" : kyc?.status === "PENDING_VERIFICATION" ? "Address under review" : "Submit proof of address for review"}
            </button>
            {!canSubmitAddressReview && <p className="text-xs text-slate-500">Verify BVN and NIN and upload proof of address before submitting for review.</p>}
          </div>
        )}
      </section>
      {otpMethodPickerFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 backdrop-blur-sm px-4">
          <div className="velo-card w-full max-w-md p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-bold text-velo-900 dark:text-white">Verify {otpMethodPickerFor} ownership</h3>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Choose how to send a one-time code to the phone number on file with your {otpMethodPickerFor}.</p>
              </div>
              <button type="button" className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-white" onClick={() => setOtpMethodPickerFor(null)} aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button type="button" className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-4 hover:border-velo-500 hover:bg-velo-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-velo-400 dark:hover:bg-velo-950/20 transition-colors group" onClick={() => void verifyIdentityWithChannel(otpMethodPickerFor, "SMS")}>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 group-hover:bg-velo-500 group-hover:text-white"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg></div>
                <div className="text-left"><div className="text-sm font-semibold text-velo-900 dark:text-white">SMS</div><div className="text-[11px] text-slate-500 dark:text-slate-400">Text to identity phone</div></div>
              </button>
              <button type="button" className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-4 hover:border-emerald-500 hover:bg-emerald-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-emerald-400 dark:hover:bg-emerald-950/20 transition-colors group" onClick={() => void verifyIdentityWithChannel(otpMethodPickerFor, "WHATSAPP")}>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 group-hover:bg-emerald-500 group-hover:text-white"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M20 12a8 8 0 11-3.2-6.4L20 4l-1.6 3.2A7.9 7.9 0 0120 12zM8.3 15.4c-.2-.5-1-1-1.5-1.1l-.5-.2c-.6-.2-1.3.2-1.3.9 0 1.4 1.8 2.8 4.1 2.8 2 0 3.6-.8 4.6-2.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
                <div className="text-left"><div className="text-sm font-semibold text-velo-900 dark:text-white">WhatsApp</div><div className="text-[11px] text-slate-500 dark:text-slate-400">Message on WhatsApp</div></div>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type InvestorTransactionsProps = { transactions: TransactionData | null };
function InvestorTransactions(props: InvestorTransactionsProps) {
  const { transactions } = props;
  const payouts = transactions?.payouts ?? [];
  const invs = transactions?.investments ?? [];
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Transactions</p>
          <h1 className="mt-2 text-xl font-bold text-velo-900 sm:text-2xl md:text-3xl dark:text-white">Ledger &amp; history</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">Payouts and investment records.</p>
        </div>
      </div>
      <section className="velo-card p-4 sm:p-5 lg:p-6">
        <h2 className="section-heading">Payouts</h2>
        {payouts.length ? (
          <div className="mt-5 space-y-2">
            {payouts.map((p: any, i: number) => (
              <div key={p.id || i} className="flex justify-between items-center p-3 rounded-xl border border-slate-100 dark:border-slate-800">
                <div><div className="text-sm font-semibold dark:text-white">Investment payout #{String(i + 1).padStart(3, "0")}</div><div className="text-xs text-slate-500">{p.createdAt ? new Date(p.createdAt).toLocaleString() : "—"}</div></div>
                <div className="text-right"><div className="font-bold text-emerald-600">{money.format(Number(p.amountNaira ?? 0))}</div><span className={`badge ${p.status === "SUCCESSFUL" ? "badge-completed" : p.status === "FAILED" ? "badge-pending" : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"}`}>{p.status || "PENDING"}</span></div>
              </div>
            ))}
          </div>
        ) : <Empty text="No payout history yet." />}
      </section>
      <section className="velo-card p-4 sm:p-5 lg:p-6">
        <h2 className="section-heading">Investment records</h2>
        {invs.length ? (
          <div className="mt-5 space-y-2">
            {invs.map((inv: any, i: number) => (
              <div key={inv.id || i} className="flex justify-between items-center p-3 rounded-xl border border-slate-100 dark:border-slate-800">
                <div><div className="text-sm font-semibold dark:text-white">{inv.planSnapshot?.name || `Investment ${i + 1}`}</div><div className="text-xs text-slate-500">{inv.createdAt ? new Date(inv.createdAt).toLocaleDateString() : "—"}</div></div>
                <div className="font-bold dark:text-white">{money.format(Number(inv.amountNaira ?? 0))}</div>
              </div>
            ))}
          </div>
        ) : <Empty text="No investments yet." />}
      </section>
    </div>
  );
}

function InvestorPayoutSection(props: any) {
  const { userId } = props;
  const [banks, setBanks] = useState([] as { id: number; name: string; code: string }[]);
  const [accounts, setAccounts] = useState([] as any[]);
  const [selectedBank, setSelectedBank] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [resolvedName, setResolvedName] = useState(null as string | null);
  const [resolveError, setResolveError] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [defaultId, setDefaultId] = useState(null as string | null);
  const [pendingRequest, setPendingRequest] = useState(null as any);

  async function loadBanks() {
    if (banks.length) return;
    setBusy("banks");
    try {
      const res = await fetch("/api/v1/providers/flutterwave/banks").then(r => r.json());
      if (res.ok) setBanks(res.banks || []);
      else setError(res.error || "Could not load banks");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to load banks"); }
    finally { setBusy(""); }
  }

  async function reloadAccounts() {
    if (!userId) return;
    try {
      const res = await fetch(`/api/v1/investor/payout-accounts`, { headers: { Authorization: `Bearer ${sessionStorage.getItem("velo:token")}` } }).then(r => r.json());
      if (res.ok) {
        setAccounts(res.accounts || []);
        setDefaultId(res.defaultId || null);
        setPendingRequest(res.pendingRequest || null);
      }
    } catch (_e) { /* ignore */ }
  }

  useEffect(() => { loadBanks(); reloadAccounts(); }, [userId]);

  async function resolveAccount() {
    if (!selectedBank || accountNumber.length < 10) return;
    setResolveError(""); setResolvedName(null); setBusy("resolve");
    try {
      const res = await fetch("/api/v1/investor/payout-accounts/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionStorage.getItem("velo:token")}` },
        body: JSON.stringify({ bankCode: selectedBank, accountNumber }),
      }).then(r => r.json());
      if (res.ok) setResolvedName(res.accountName);
      else setResolveError(res.error || "Could not resolve account");
    } catch (err) { setResolveError(err instanceof Error ? err.message : "Resolution failed"); }
    finally { setBusy(""); }
  }

  async function saveAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedBank || accountNumber.length !== 10 || !resolvedName) return;
    setBusy("save"); setMessage(""); setError("");
    try {
      const bankName = banks.find(b => b.code === selectedBank)?.name;
      const res = await fetch("/api/v1/investor/payout-accounts", {
        method: accounts.length ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionStorage.getItem("velo:token")}` },
        body: JSON.stringify({ bankCode: selectedBank, bankName, accountNumber, accountName: resolvedName }),
      }).then(r => r.json());
      if (res.ok) {
        if (res.pendingApproval) {
          setMessage(res.message || "Update submitted. Awaiting admin approval.");
          setPendingRequest(res.request || null);
        } else {
          setMessage("Payout account saved.");
          reloadAccounts();
        }
        setSelectedBank(""); setAccountNumber(""); setResolvedName(null);
      } else setError(res.error || "Save failed");
    } catch (err) { setError(err instanceof Error ? err.message : "Save failed"); }
    finally { setBusy(""); }
  }

  async function setDefault(accId: string) {
    setBusy("default");
    try {
      const res = await fetch(`/api/v1/investor/payout-accounts/${accId}/default`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${sessionStorage.getItem("velo:token")}` },
      }).then(r => r.json());
      if (res.ok) { setDefaultId(accId); setMessage("Default payout account updated."); reloadAccounts(); }
      else setError(res.error || "Could not update");
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
          <div className="font-semibold">⏳ Payout account change pending admin approval</div>
          <div className="mt-1 text-xs">New: {pendingRequest.newSnapshot?.bankName} ••••{String(pendingRequest.newSnapshot?.accountNumber || "").slice(-4)} — {pendingRequest.newSnapshot?.accountName}</div>
        </div>
      )}
      <section className="velo-card p-4 sm:p-5 lg:p-6">
        <h2 className="section-heading">{accounts.length ? "Edit payout account" : "Add payout account"}</h2>
        <p className="section-subheading">Select your bank and verify the account name before saving.</p>
        <form onSubmit={saveAccount} className="mt-5 grid gap-4 md:grid-cols-3 md:items-end">
          <label className="velo-label">
            Bank <span className="text-red-500">*</span>
            <select className="velo-input mt-1" value={selectedBank} onChange={(e) => { setSelectedBank(e.target.value); setResolvedName(null); setResolveError(""); }} required disabled={busy === "banks"}>
              <option value="">{busy === "banks" ? "Loading banks…" : "Select your bank"}</option>
              {banks.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
            </select>
          </label>
          <label className="velo-label">
            Account number <span className="text-red-500">*</span>
            <input className="velo-input mt-1" inputMode="numeric" maxLength={10} required value={accountNumber} onChange={(e) => { setAccountNumber(e.target.value.replace(/\D/g, "")); setResolvedName(null); setResolveError(""); }} onBlur={() => { if (selectedBank && accountNumber.length === 10) void resolveAccount(); }} placeholder="10-digit NUBAN" />
          </label>
          <div className="flex flex-col gap-2">
            <button type="button" className="btn-secondary" onClick={() => void resolveAccount()} disabled={busy === "resolve" || !selectedBank || accountNumber.length !== 10}>{busy === "resolve" ? "Resolving…" : "Verify account name"}</button>
            {resolvedName && <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 p-3 text-sm text-emerald-700 dark:text-emerald-400"><span className="font-semibold">Account name:</span> {resolvedName}</div>}
            {resolveError && <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-900/30 p-3 text-sm text-red-700 dark:text-red-400">{resolveError}</div>}
          </div>
          <div className="md:col-span-3 flex flex-wrap gap-3 items-center">
            <button type="submit" className="btn-primary" disabled={busy === "save" || !resolvedName}>{busy === "save" ? "Saving…" : accounts.length ? "Submit changes for approval" : "Save account"}</button>
            {accounts.length > 0 && <div className="text-xs text-slate-500">⚠️ Subsequent edits require admin approval.</div>}
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
