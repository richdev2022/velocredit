import { useEffect, useState } from "react";
import { getUserSettings, requestOtp, updateUserSettings, verifyOtp, type OtpChannel } from "../services/apiClient";

export default function OtpLoginSettings() {
  const [channel, setChannel] = useState<OtpChannel>("EMAIL");
  const [enabled, setEnabled] = useState(false);
  const [challengeId, setChallengeId] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    getUserSettings().then((settings) => {
      setChannel(settings.preferredOtpChannel);
      setEnabled(settings.otpLoginEnabled);
    }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load security settings"));
  }, []);

  async function saveChannel(next: OtpChannel) {
    setError("");
    try {
      const settings = await updateUserSettings({ preferredOtpChannel: next });
      setChannel(settings.preferredOtpChannel);
      setEnabled(settings.otpLoginEnabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save preferred channel");
    }
  }

  async function enable() {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await requestOtp("LOGIN_STEP_UP", channel);
      setChallengeId(response.challengeId);
      setMessage(`A 6-digit code was sent via ${channel.toLowerCase()}.`);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to send OTP"); }
    finally { setBusy(false); }
  }

  async function confirmEnable() {
    if (code.length !== 6 || !challengeId) return;
    setBusy(true); setError("");
    try {
      await verifyOtp(challengeId, code);
      await updateUserSettings({ preferredOtpChannel: channel, otpLoginEnabled: true });
      setEnabled(true); setChallengeId(""); setCode(""); setMessage("Two-step login is now enabled.");
    } catch (err) { setError(err instanceof Error ? err.message : "Invalid or expired OTP"); }
    finally { setBusy(false); }
  }

  async function disable() {
    setBusy(true); setError("");
    try { await updateUserSettings({ otpLoginEnabled: false }); setEnabled(false); setMessage("Two-step login is now disabled."); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to update two-step login"); }
    finally { setBusy(false); }
  }

  return <section className="velo-card p-4 sm:p-5 lg:p-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="section-heading">Two-step login (OTP)</h2><p className="section-subheading">Require a one-time code after your password to sign in.</p></div>
      <button type="button" onClick={enabled ? disable : enable} disabled={busy} className={`rounded-full px-4 py-2 text-sm font-bold text-white disabled:opacity-60 ${enabled ? "bg-emerald-600" : "bg-slate-500"}`}>{busy ? "Please wait…" : enabled ? "ON — Turn off" : "OFF — Turn on"}</button>
    </div>
    <label className="mt-5 block"><span className="velo-label">Preferred OTP channel</span><select className="velo-input mt-1" value={channel} disabled={busy} onChange={(event) => void saveChannel(event.target.value as OtpChannel)}><option value="EMAIL">Email</option><option value="SMS">Phone (SMS)</option><option value="WHATSAPP">WhatsApp</option></select></label>
    {challengeId && !enabled && <div className="mt-4 space-y-3 rounded-xl border border-velo-100 bg-velo-50/70 p-4 dark:border-velo-900/40 dark:bg-velo-900/20"><label className="block"><span className="velo-label">Verification code</span><input className="velo-input mt-1 text-center text-lg tracking-[0.35em]" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder="000000" /></label><button type="button" className="btn-primary" disabled={busy || code.length !== 6} onClick={() => void confirmEnable()}>Verify and enable</button></div>}
    {message && <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">{message}</p>}
    {error && <p className="mt-3 text-sm text-red-700 dark:text-red-400">{error}</p>}
  </section>;
}
