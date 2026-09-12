import { useState } from "react";
import { requestOtp, withdrawInvestorWallet, type OtpChannel } from "../services/apiClient";

type Props = { available: number; onSuccess: (message: string) => void };

export default function InvestorWithdrawalForm({ available, onSuccess }: Props) {
  const [amount, setAmount] = useState("");
  const [bankCode, setBankCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [narration, setNarration] = useState("");
  const [channel, setChannel] = useState<OtpChannel>("EMAIL");
  const [challengeId, setChallengeId] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const validDestination = Number(amount) > 0 && Number(amount) <= available && bankCode.trim().length >= 2 && /^\d{10}$/.test(accountNumber);

  async function sendOtp() {
    if (!validDestination) return;
    setBusy(true); setError("");
    try {
      const result = await requestOtp("WITHDRAWAL", channel);
      setChallengeId(result.challengeId); setOtpCode("");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to send OTP"); }
    finally { setBusy(false); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!challengeId || otpCode.length !== 6 || !validDestination) return;
    setBusy(true); setError("");
    try {
      const result = await withdrawInvestorWallet({ amountNaira: Number(amount), bankCode: bankCode.trim(), accountNumber, narration: narration || undefined, otpChallengeId: challengeId, otpCode });
      onSuccess(`Withdrawal ${result.withdrawal.id} is pending approval.`);
      setAmount(""); setBankCode(""); setAccountNumber(""); setNarration(""); setChallengeId(""); setOtpCode("");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to submit withdrawal"); }
    finally { setBusy(false); }
  }

  return <section className="velo-card p-4 sm:p-5 lg:p-6">
    <h2 className="section-heading">Withdraw funds</h2>
    <p className="section-subheading">Confirm your withdrawal with a one-time code before it is submitted.</p>
    <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={submit}>
      <label className="block"><span className="velo-label">Amount (NGN)</span><div className="relative mt-1"><span className="absolute inset-y-0 left-0 flex items-center pl-4 text-sm font-bold text-slate-500">₦</span><input className="velo-input pl-10" type="number" min="1" max={available} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Enter amount" required /></div></label>
      <label className="block"><span className="velo-label">Bank code</span><input className="velo-input mt-1" value={bankCode} onChange={(event) => setBankCode(event.target.value)} placeholder="e.g. 058" required /></label>
      <label className="block"><span className="velo-label">Account number</span><input className="velo-input mt-1" inputMode="numeric" maxLength={10} value={accountNumber} onChange={(event) => setAccountNumber(event.target.value.replace(/\D/g, ""))} placeholder="10-digit account number" required /></label>
      <label className="block"><span className="velo-label">Narration (optional)</span><input className="velo-input mt-1" maxLength={100} value={narration} onChange={(event) => setNarration(event.target.value)} placeholder="Withdrawal" /></label>
      <div className="sm:col-span-2"><span className="velo-label">Send OTP via</span><div className="mt-2 flex flex-wrap gap-2">{(["EMAIL", "SMS", "WHATSAPP"] as OtpChannel[]).map((option) => <button key={option} type="button" onClick={() => setChannel(option)} className={`rounded-lg border px-3 py-2 text-sm font-semibold ${channel === option ? "border-velo-500 bg-velo-50 text-velo-700" : "border-slate-200 text-slate-600"}`}>{option === "EMAIL" ? "Email" : option === "SMS" ? "SMS" : "WhatsApp"}</button>)}</div></div>
      {!challengeId ? <button type="button" className="btn-secondary sm:w-fit" disabled={busy || !validDestination} onClick={() => void sendOtp()}>{busy ? "Sending…" : "Request OTP"}</button> : <><label className="block sm:col-span-2"><span className="velo-label">OTP code</span><input className="velo-input mt-1 max-w-xs text-center text-lg tracking-[0.35em]" inputMode="numeric" maxLength={6} value={otpCode} onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, ""))} placeholder="000000" required /></label><button type="button" className="btn-secondary sm:w-fit" disabled={busy || !validDestination} onClick={() => void sendOtp()}>Resend OTP</button></>}
      <div className="sm:col-span-2 flex flex-wrap items-center gap-3"><button className="btn-primary" disabled={busy || !validDestination || !challengeId || otpCode.length !== 6}>{busy ? "Submitting…" : "Confirm withdrawal"}</button><span className="text-xs text-slate-500">Available: ₦{available.toLocaleString("en-NG")}</span></div>
      {error && <p className="sm:col-span-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
    </form>
  </section>;
}
