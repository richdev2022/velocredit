import { useEffect, useMemo, useState } from "react";
import { getInvestorPayoutAccounts, getNigerianBanks, requestOtp, resolveInvestorPayoutAccount, withdrawInvestorWallet, type OtpChannel } from "../services/apiClient";
import Icon from "./Icon";

type Bank = { id: number; name: string; code: string };
type SavedAccount = { id: string; bankCode: string; bankName?: string; accountNumber: string; accountName?: string; status: string; isDefault?: boolean };
type Props = { available: number; onSuccess: (message: string) => void };

export function isValidWithdrawalDestination(amount: string, available: number, bankCode: string, accountNumber: string, accountName: string): boolean {
  return Number(amount) > 0 && Number(amount) <= available && bankCode.trim().length >= 2 && /^\d{10}$/.test(accountNumber) && Boolean(accountName);
}

export default function InvestorWithdrawalForm({ available, onSuccess }: Props) {
  const [amount, setAmount] = useState("");
  const [bankCode, setBankCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountName, setAccountName] = useState("");
  const [narration, setNarration] = useState("");
  const [channel, setChannel] = useState<OtpChannel>("EMAIL");
  const [challengeId, setChallengeId] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [resendAvailableAt, setResendAvailableAt] = useState("");
  const [resendSecondsRemaining, setResendSecondsRemaining] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ ok: boolean; title: string; message: string } | null>(null);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [bankQuery, setBankQuery] = useState("");
  const [bankMenuOpen, setBankMenuOpen] = useState(false);

  const selectedBank = banks.find((bank) => bank.code === bankCode);
  const filteredBanks = useMemo(() => banks.filter((bank) => bank.name.toLowerCase().includes(bankQuery.trim().toLowerCase())), [banks, bankQuery]);
  const validDestination = isValidWithdrawalDestination(amount, available, bankCode, accountNumber, accountName);

  useEffect(() => {
    void Promise.all([getNigerianBanks(), getInvestorPayoutAccounts()]).then(([bankBody, accountBody]) => {
      setBanks(bankBody.banks || []);
      const accounts = accountBody.accounts || [];
      setSavedAccounts(accounts);
      const defaultAccount = accounts.find((account) => account.isDefault) || accounts[0];
      if (defaultAccount) selectSavedAccount(defaultAccount);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!resendAvailableAt) return;
    const updateCountdown = () => setResendSecondsRemaining(Math.max(0, Math.ceil((new Date(resendAvailableAt).getTime() - Date.now()) / 1000)));
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 1000);
    return () => window.clearInterval(timer);
  }, [resendAvailableAt]);

  useEffect(() => {
    if (selectedAccountId || !bankCode || !/^\d{10}$/.test(accountNumber) || accountName || busy === "resolve") return;
    void resolveAccount();
  }, [bankCode, accountNumber, selectedAccountId, accountName, busy]);

  function selectSavedAccount(account: SavedAccount) {
    setSelectedAccountId(account.id);
    setBankCode(account.bankCode);
    setAccountNumber(account.accountNumber.replace(/\D/g, ""));
    setAccountName(account.accountName || "");
    setBankQuery("");
    setBankMenuOpen(false);
    setError("");
  }

  function useAnotherAccount() {
    setSelectedAccountId("");
    setBankCode("");
    setAccountNumber("");
    setAccountName("");
    setBankQuery("");
    setError("");
  }

  async function resolveAccount() {
    if (!bankCode || !/^\d{10}$/.test(accountNumber)) return;
    setBusy("resolve");
    setError("");
    try {
      const body = await resolveInvestorPayoutAccount(bankCode, accountNumber);
      setAccountName(body.accountName || body.resolved?.accountName || "");
    } catch (err) {
      setAccountName("");
      setError(err instanceof Error ? err.message : "Unable to verify account name");
    } finally { setBusy(""); }
  }

  async function sendOtp() {
    if (!validDestination || (challengeId && resendSecondsRemaining > 0)) return;
    setBusy("otp"); setError("");
    try {
      const result = await requestOtp("WITHDRAWAL", channel);
      setChallengeId(result.challengeId); setOtpCode(""); setResendAvailableAt(result.resendAvailableAt); setResendSecondsRemaining(result.resendSecondsRemaining);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to send OTP"); }
    finally { setBusy(""); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!challengeId || otpCode.length !== 6 || !validDestination) return;
    setBusy("submit"); setError("");
    try {
      const response = await withdrawInvestorWallet({ amountNaira: Number(amount), bankCode: bankCode.trim(), accountNumber, narration: narration || undefined, otpChallengeId: challengeId, otpCode });
      const successful = response.withdrawal.status === "SUCCESSFUL";
      setResult({
        ok: successful,
        title: successful ? "Withdrawal successful" : "Withdrawal failed",
        message: successful ? "Your withdrawal was submitted successfully." : (response.message || "The withdrawal failed and your wallet balance was restored."),
      });
      onSuccess(successful ? `Withdrawal ${response.withdrawal.id} was submitted successfully.` : `Withdrawal ${response.withdrawal.id} failed and your wallet balance was restored.`);
      setAmount(""); setNarration(""); setChallengeId(""); setOtpCode(""); setResendAvailableAt(""); setResendSecondsRemaining(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to submit withdrawal";
      setResult({ ok: false, title: "Withdrawal failed", message });
      setError(message);
    }
    finally { setBusy(""); }
  }

  return <section className="velo-card p-4 sm:p-5 lg:p-6">
    <h2 className="section-heading">Withdraw funds</h2>
    <p className="section-subheading">Choose a saved payout account or verify another Nigerian bank account before confirming your withdrawal.</p>
    <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={submit}>
      <label className="block"><span className="velo-label">Amount (NGN)</span><div className="relative mt-1"><span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4 text-sm font-bold text-slate-500">₦</span><input className="velo-input pl-10" type="number" min="1" max={available} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Enter amount" required /></div></label>
      <label className="block"><span className="velo-label">Saved payout account</span><select className="velo-input mt-1" value={selectedAccountId} onChange={(event) => { const account = savedAccounts.find((item) => item.id === event.target.value); if (account) selectSavedAccount(account); else useAnotherAccount(); }}><option value="">Enter another account</option>{savedAccounts.map((account) => <option key={account.id} value={account.id}>{account.bankName || account.bankCode} ••••{account.accountNumber.slice(-4)} — {account.accountName || "Verified account"}</option>)}</select></label>
      <div className="relative">
        <label className="velo-label" htmlFor="withdrawal-bank">Bank</label>
        <input id="withdrawal-bank" className="velo-input mt-1 pr-10" value={bankMenuOpen ? bankQuery : selectedBank?.name || ""} onFocus={() => { setBankMenuOpen(true); setBankQuery(""); }} onChange={(event) => { setSelectedAccountId(""); setBankCode(""); setAccountName(""); setBankQuery(event.target.value); setBankMenuOpen(true); }} placeholder="Search banks" required={!bankCode} autoComplete="off" />
        {bankMenuOpen && <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl">{filteredBanks.map((bank) => <button key={bank.code} type="button" className="flex w-full justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-velo-50" onMouseDown={(event) => event.preventDefault()} onClick={() => { setSelectedAccountId(""); setBankCode(bank.code); setBankQuery(""); setBankMenuOpen(false); setAccountNumber(""); setAccountName(""); }}>{bank.name}<span className="text-xs text-slate-400">{bank.code}</span></button>)}</div>}
      </div>
      <label className="block"><span className="velo-label">Account number</span><input className="velo-input mt-1" inputMode="numeric" maxLength={10} value={accountNumber} onChange={(event) => { setSelectedAccountId(""); setAccountNumber(event.target.value.replace(/\D/g, "")); setAccountName(""); }} placeholder="10-digit account number" required /></label>
      <label className="block"><span className="velo-label">Narration (optional)</span><input className="velo-input mt-1" maxLength={100} value={narration} onChange={(event) => setNarration(event.target.value)} placeholder="Withdrawal" /></label>
      <div className="sm:col-span-2 min-h-6">{busy === "resolve" && <p className="text-sm text-slate-500">Verifying account name…</p>}{accountName && <p className="text-sm font-semibold text-emerald-700">Verified account name: {accountName}</p>}{!accountName && /^\d{10}$/.test(accountNumber) && busy !== "resolve" && <p className="text-sm text-amber-700">Enter a valid bank and account number to verify the account name.</p>}</div>
      <div className="sm:col-span-2"><span className="velo-label">Send OTP via</span><div className="mt-2 flex flex-wrap gap-2">{(["EMAIL", "SMS", "WHATSAPP"] as OtpChannel[]).map((option) => <button key={option} type="button" onClick={() => setChannel(option)} className={`rounded-lg border px-3 py-2 text-sm font-semibold ${channel === option ? "border-velo-500 bg-velo-50 text-velo-700" : "border-slate-200 text-slate-600"}`}>{option === "EMAIL" ? "Email" : option === "SMS" ? "SMS" : "WhatsApp"}</button>)}</div></div>
      {!challengeId ? <button type="button" className="btn-secondary sm:w-fit" disabled={busy !== "" || !validDestination} onClick={() => void sendOtp()}>{busy === "otp" ? "Sending…" : "Request OTP"}</button> : <><label className="block sm:col-span-2"><span className="velo-label">OTP code</span><input className="velo-input mt-1 max-w-xs text-center text-lg tracking-[0.35em]" inputMode="numeric" maxLength={6} value={otpCode} onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, ""))} placeholder="000000" required /></label><div className="flex items-center gap-3"><button type="button" className="btn-secondary sm:w-fit" disabled={busy !== "" || !validDestination || resendSecondsRemaining > 0} onClick={() => void sendOtp()}>{busy === "otp" ? "Sending…" : resendSecondsRemaining > 0 ? `Resend OTP in ${resendSecondsRemaining}s` : "Resend OTP"}</button>{resendSecondsRemaining > 0 && <span className="text-xs text-slate-500" aria-live="polite">Resend available in {resendSecondsRemaining}s</span>}</div></>}
      <div className="sm:col-span-2 flex flex-wrap items-center gap-3"><button className="btn-primary" disabled={busy !== "" || !validDestination || !challengeId || otpCode.length !== 6}>{busy === "submit" ? "Submitting…" : "Confirm withdrawal"}</button><span className="text-xs text-slate-500">Available: ₦{available.toLocaleString("en-NG")}</span></div>
      {error && <p className="sm:col-span-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
    </form>
    {result && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true" aria-labelledby="withdrawal-result-title">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-slate-900">
        <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ${result.ok ? "bg-emerald-100 text-emerald-600" : "bg-red-100 text-red-600"}`}>
          <Icon name={result.ok ? "check" : "x"} size={28} />
        </div>
        <h3 id="withdrawal-result-title" className="mt-4 text-center text-xl font-bold text-velo-900 dark:text-white">{result.title}</h3>
        <p className="mt-2 text-center text-sm leading-6 text-slate-600 dark:text-slate-300">{result.message}</p>
        <button type="button" className="btn-primary mt-6 w-full" onClick={() => setResult(null)}>Close</button>
      </div>
    </div>}
  </section>;
}
