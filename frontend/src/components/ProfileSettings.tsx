import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext";
import {
  patchMe,
  initiateProfileUpdateOtp,
  resendProfileUpdateOtp,
  confirmProfileUpdateOtp,
  type ProfileUpdateChallenge,
  type ProfileUpdateChannel,
} from "../services/apiClient";
import Icon from "./Icon";

type PendingContactUpdate = {
  kind: "phone" | "email";
  challengeId: string;
  pendingPhone?: string;
  pendingEmail?: string;
  channel: ProfileUpdateChannel;
  otpCode: string;
  resendAvailableAt: string;
  expiresAt: string;
  cooldown: number;
  busy?: boolean;
  error?: string;
};

export default function ProfileSettings() {
  const { user, refreshUser } = useAuth();
  const [fullName, setFullName] = useState(user?.fullName ?? "");
  const [dateOfBirth, setDateOfBirth] = useState<string>((user as any)?.dateOfBirth ?? "");
  const [occupation, setOccupation] = useState<string>((user as any)?.occupation ?? "");
  const [sourceOfFunds, setSourceOfFunds] = useState<string>((user as any)?.sourceOfFunds ?? "");
  const [addressLine1, setAddressLine1] = useState<string>(((user as any)?.residentialAddress?.line1 as string) ?? "");
  const [addressCity, setAddressCity] = useState<string>(((user as any)?.residentialAddress?.city as string) ?? "");
  const [addressState, setAddressState] = useState<string>(((user as any)?.residentialAddress?.state as string) ?? "");
  const [newPhone, setNewPhone] = useState(user?.phone ?? "");
  const [newEmail, setNewEmail] = useState(user?.email ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [contactChannel, setContactChannel] = useState<ProfileUpdateChannel>(
    (user as any)?.preferredOtpChannel === "WHATSAPP"
      ? "WHATSAPP"
      : (user as any)?.preferredOtpChannel === "EMAIL"
        ? "EMAIL"
        : "SMS"
  );
  const [pending, setPending] = useState<PendingContactUpdate | null>(null);

  useEffect(() => {
    if (!user) return;
    setFullName(user.fullName ?? "");
    setNewPhone(user.phone ?? "");
    setNewEmail(user.email ?? "");
    setDateOfBirth((user as any)?.dateOfBirth ?? "");
    setOccupation((user as any)?.occupation ?? "");
    setSourceOfFunds((user as any)?.sourceOfFunds ?? "");
    setAddressLine1(((user as any)?.residentialAddress?.line1 as string) ?? "");
    setAddressCity(((user as any)?.residentialAddress?.city as string) ?? "");
    setAddressState(((user as any)?.residentialAddress?.state as string) ?? "");
  }, [user?.id, user?.email, user?.phone, user?.fullName]);

  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => {
      const nowMs = Date.now();
      const resendMs = new Date(pending.resendAvailableAt).getTime();
      setPending((current) => {
        if (!current) return current;
        const remaining = Math.max(0, Math.ceil((resendMs - nowMs) / 1000));
        if (remaining === current.cooldown) return current;
        return { ...current, cooldown: remaining };
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [pending?.challengeId, pending?.resendAvailableAt]);

  const phoneDirty = useMemo(() => {
    const digits = newPhone.replace(/\D/g, "");
    const norm = digits.startsWith("234") && digits.length === 13 ? `0${digits.slice(3)}` : digits;
    const current = (user?.phone ?? "").replace(/\D/g, "");
    return norm !== current && /^0\d{10}$/.test(norm);
  }, [newPhone, user?.phone]);

  const emailDirty = useMemo(() => {
    const next = newEmail.trim().toLowerCase();
    const current = (user?.email ?? "").toLowerCase();
    return next !== current && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next);
  }, [newEmail, user?.email]);

  const canSendContactOtp = phoneDirty || emailDirty;

  async function saveProfile() {
    setError("");
    setMessage("");
    setSaving(true);
    try {
      const payload: Parameters<typeof patchMe>[0] = {};
      if (fullName.trim() && fullName.trim() !== user?.fullName) payload.fullName = fullName.trim();
      if (dateOfBirth) payload.dateOfBirth = dateOfBirth;
      if (occupation.trim()) payload.occupation = occupation.trim();
      if (sourceOfFunds.trim()) payload.sourceOfFunds = sourceOfFunds.trim();
      const address: Record<string, unknown> = {};
      if (addressLine1.trim()) address.line1 = addressLine1.trim();
      if (addressCity.trim()) address.city = addressCity.trim();
      if (addressState.trim()) address.state = addressState.trim();
      if (Object.keys(address).length) payload.residentialAddress = address;
      if (Object.keys(payload).length === 0) {
        setMessage("Nothing to update.");
        return;
      }
      await patchMe(payload);
      await refreshUser();
      setMessage("Profile updated successfully.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update profile");
    } finally {
      setSaving(false);
    }
  }

  async function sendContactOtp() {
    if (!canSendContactOtp) return;
    setError("");
    setMessage("");
    setPending((current) => (current ? { ...current, busy: true, error: undefined } : current));
    try {
      const payload: { phone?: string; email?: string; channel?: ProfileUpdateChannel } = {};
      if (phoneDirty) {
        const digits = newPhone.replace(/\D/g, "");
        payload.phone = digits.startsWith("234") && digits.length === 13 ? `0${digits.slice(3)}` : digits;
      }
      if (emailDirty) payload.email = newEmail.trim();
      if (emailDirty && !phoneDirty) payload.channel = "EMAIL";
      else payload.channel = contactChannel === "EMAIL" ? "SMS" : contactChannel;
      const response = (await initiateProfileUpdateOtp(payload)) as ProfileUpdateChallenge;
      setPending({
        kind: emailDirty ? "email" : "phone",
        challengeId: response.challengeId,
        pendingPhone: response.pendingPhone,
        pendingEmail: response.pendingEmail,
        channel: response.channel,
        otpCode: "",
        resendAvailableAt: response.resendAvailableAt,
        expiresAt: response.expiresAt,
        cooldown: response.resendSecondsRemaining,
      });
      setMessage(
        response.emailMasked
          ? `A 6-digit code was sent to ${response.emailMasked}.`
          : `A 6-digit code was sent via ${response.channel.toLowerCase()} ending in ${response.phoneLastFour ?? "—"}.`
      );
    } catch (err) {
      if (!pending) setError(err instanceof Error ? err.message : "Unable to send verification code");
      else setPending((current) => (current ? { ...current, error: err instanceof Error ? err.message : "Unable to send verification code", busy: false } : current));
    } finally {
      setPending((current) => (current ? { ...current, busy: false } : current));
    }
  }

  async function resendContactOtp() {
    if (!pending) return;
    setError("");
    setPending({ ...pending, busy: true, error: undefined });
    try {
      const response = await resendProfileUpdateOtp({
        challengeId: pending.challengeId,
        channel: pending.channel,
      });
      setPending({
        ...pending,
        challengeId: response.challengeId,
        resendAvailableAt: response.resendAvailableAt,
        expiresAt: response.expiresAt,
        cooldown: response.resendSecondsRemaining,
        channel: response.channel,
        otpCode: "",
        busy: false,
      });
      setMessage("Verification code resent.");
    } catch (err) {
      setPending({ ...pending, busy: false, error: err instanceof Error ? err.message : "Unable to resend verification code" });
    }
  }

  async function verifyContactOtp() {
    if (!pending || pending.otpCode.length !== 6) return;
    setError("");
    setPending({ ...pending, busy: true, error: undefined });
    try {
      const response = await confirmProfileUpdateOtp({
        challengeId: pending.challengeId,
        code: pending.otpCode,
        phone: pending.pendingPhone,
        email: pending.pendingEmail,
      });
      setMessage(response.message || "Contact details updated successfully.");
      await refreshUser();
      setPending(null);
    } catch (err) {
      setPending({
        ...pending,
        busy: false,
        error: err instanceof Error ? err.message : "Invalid or expired code",
      });
    }
  }

  function cancelContactOtp() {
    setPending(null);
    setMessage("");
    setError("");
    setNewPhone(user?.phone ?? "");
    setNewEmail(user?.email ?? "");
  }

  return (
    <section className="velo-card p-4 sm:p-5 lg:p-6 space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="section-heading">Update your profile</h2>
          <p className="section-subheading">
            Edit your details below. Name, address and occupation save immediately. Email and phone require 6-digit verification.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void saveProfile()}
          disabled={saving}
          className="btn-primary inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-bold disabled:opacity-60"
        >
          {saving ? (
            <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 12a9 9 0 11-6.219-8.56" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          ) : (
            <Icon name="check" size={16} />
          )}
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="velo-label">Full legal name</span>
          <input className="velo-input mt-1" value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="e.g. Sunday Itodo" disabled={saving} />
        </label>
        <label className="block">
          <span className="velo-label">Date of birth</span>
          <input type="date" className="velo-input mt-1" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} disabled={saving} />
        </label>
        <label className="block">
          <span className="velo-label">Occupation</span>
          <input className="velo-input mt-1" value={occupation} onChange={(event) => setOccupation(event.target.value)} placeholder="e.g. Software Engineer" disabled={saving} />
        </label>
        <label className="block sm:col-span-2">
          <span className="velo-label">Source of funds</span>
          <input className="velo-input mt-1" value={sourceOfFunds} onChange={(event) => setSourceOfFunds(event.target.value)} placeholder="e.g. Salary, investments" disabled={saving} />
        </label>
        <label className="block sm:col-span-2">
          <span className="velo-label">Residential address</span>
          <input className="velo-input mt-1" value={addressLine1} onChange={(event) => setAddressLine1(event.target.value)} placeholder="Street, house number" disabled={saving} />
        </label>
        <label className="block">
          <span className="velo-label">City / LGA</span>
          <input className="velo-input mt-1" value={addressCity} onChange={(event) => setAddressCity(event.target.value)} placeholder="e.g. Ikeja" disabled={saving} />
        </label>
        <label className="block">
          <span className="velo-label">State</span>
          <input className="velo-input mt-1" value={addressState} onChange={(event) => setAddressState(event.target.value)} placeholder="e.g. Lagos" disabled={saving} />
        </label>
      </div>

      <div className="border-t border-dashed border-slate-200 dark:border-slate-700 pt-6">
        <h3 className="text-lg font-bold text-velo-900 dark:text-white">Contact details</h3>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Changes to your email or phone must be verified with a 6-digit OTP before they take effect.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="velo-label flex items-center gap-2">
              Phone number
              {phoneDirty && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">Unverified</span>}
            </span>
            <input
              className="velo-input mt-1"
              value={newPhone}
              onChange={(event) => setNewPhone(event.target.value)}
              placeholder="080…"
              disabled={saving || Boolean(pending)}
              inputMode="tel"
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Current: <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">{user?.phone ?? "—"}</code></p>
          </label>
          <label className="block">
            <span className="velo-label flex items-center gap-2">
              Email
              {emailDirty && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">Unverified</span>}
            </span>
            <input
              className="velo-input mt-1"
              type="email"
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
              placeholder="name@example.com"
              disabled={saving || Boolean(pending)}
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Current: <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">{user?.email ?? "—"}</code></p>
          </label>
        </div>

        {!pending && (
          <div className="mt-4 flex flex-wrap items-end gap-3">
            {!emailDirty && (
              <label className="block min-w-[180px]">
                <span className="velo-label">OTP channel</span>
                <select
                  className="velo-input mt-1"
                  value={contactChannel}
                  onChange={(event) => setContactChannel(event.target.value as ProfileUpdateChannel)}
                  disabled={saving}
                >
                  <option value="SMS">Text message (SMS)</option>
                  <option value="WHATSAPP">WhatsApp</option>
                  <option value="EMAIL">Email</option>
                </select>
              </label>
            )}
            <button
              type="button"
              onClick={() => void sendContactOtp()}
              disabled={!canSendContactOtp || saving}
              className="btn-secondary inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-bold disabled:opacity-50"
            >
              <Icon name="shield" size={16} />
              Send verification code
            </button>
          </div>
        )}

        {pending && (
          <div className="mt-5 space-y-3 rounded-2xl border border-velo-100 bg-velo-50/70 p-4 dark:border-velo-900/40 dark:bg-velo-900/20">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-velo-900 dark:text-white">
                  Verify the {pending.kind === "email" ? "new email" : "new phone number"}
                </p>
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                  {pending.kind === "email"
                    ? `We sent a 6-digit code to ${pending.pendingEmail ?? "your new email"}.`
                    : `We sent a 6-digit code via ${pending.channel.toLowerCase()} to the new number ending in ${pending.pendingPhone?.slice(-4) ?? "—"}.`}
                </p>
              </div>
              <button
                type="button"
                onClick={cancelContactOtp}
                className="rounded-full px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-white/60 dark:text-slate-300 dark:hover:bg-slate-800/60"
                disabled={pending.busy}
              >
                Cancel
              </button>
            </div>
            <label className="block">
              <span className="velo-label">6-digit code</span>
              <input
                className="velo-input mt-1 text-center text-lg tracking-[0.35em]"
                inputMode="numeric"
                maxLength={6}
                value={pending.otpCode}
                onChange={(event) =>
                  setPending({ ...pending, otpCode: event.target.value.replace(/\D/g, "") })
                }
                disabled={pending.busy}
                placeholder="000000"
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void verifyContactOtp()}
                disabled={pending.busy || pending.otpCode.length !== 6}
                className="btn-primary inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-bold disabled:opacity-60"
              >
                {pending.busy ? (
                  <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 12a9 9 0 11-6.219-8.56" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                ) : (
                  <Icon name="check" size={16} />
                )}
                Verify and save
              </button>
              <button
                type="button"
                onClick={() => void resendContactOtp()}
                disabled={pending.busy || pending.cooldown > 0}
                className="btn-secondary inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                {pending.cooldown > 0 ? `Resend (${pending.cooldown}s)` : "Resend code"}
              </button>
            </div>
            {pending.error && (
              <p className="text-sm font-medium text-red-600 dark:text-red-400 break-words">{pending.error}</p>
            )}
          </div>
        )}
      </div>

      {message && <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">{message}</p>}
      {error && <p className="text-sm font-medium text-red-600 dark:text-red-400 break-words">{error}</p>}
    </section>
  );
}
