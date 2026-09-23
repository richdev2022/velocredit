import { useEffect, useState } from "react";
import { getAccessToken } from "../services/apiClient";
import { config } from "../utils/config";
import Icon from "./Icon";

type DisbursementAccount = {
  id?: string;
  bankCode?: string;
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  status?: string;
  isDefault?: boolean;
};

type Props = {
  userId?: string;
  /** Saved account OR the account submitted with the loan application (fallback). */
  initial?: DisbursementAccount | Record<string, unknown> | null;
  locked?: boolean;
  /** Urgent-attention mode: a loan's disbursement is blocked on this account —
   *  the form unlocks and the customer can submit a verified replacement.
   *  The change takes effect once an ADMIN approves it in the review queue. */
  updateRequested?: boolean;
  onSaved?: (acc: DisbursementAccount | null, meta?: { applied?: boolean }) => void;
  onError?: (msg: string) => void;
};

function asAccount(value: DisbursementAccount | Record<string, unknown> | null | undefined): DisbursementAccount | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const out: DisbursementAccount = {};
  if (typeof v.id === "string") out.id = v.id;
  if (typeof v.bankCode === "string") out.bankCode = v.bankCode;
  if (typeof v.bankName === "string") out.bankName = v.bankName;
  if (typeof v.accountNumber === "string") out.accountNumber = v.accountNumber;
  if (typeof v.accountName === "string") out.accountName = v.accountName;
  if (typeof v.status === "string") out.status = v.status;
  return out;
}

export default function BorrowerDisbursementSection({ userId, initial, locked, updateRequested, onSaved, onError }: Props) {
  const initialAccount = asAccount(initial);
  const [banks, setBanks] = useState<Array<{ id: number; name: string; code: string }>>([]);
  const [account, setAccount] = useState<DisbursementAccount | null>(initialAccount);
  // "saved" = standalone settings account; "application" = account submitted
  // WITH the loan application (surfaced so the borrower can see where the
  // loan will be paid even while the settings form is locked).
  const [accountSource, setAccountSource] = useState<"saved" | "application" | null>(
    typeof (initial as Record<string, unknown> | null | undefined)?.id === "string" &&
      String((initial as Record<string, unknown>).id).startsWith("application:")
      ? "application"
      : initial
      ? "saved"
      : null
  );
  const [selectedBank, setSelectedBank] = useState(initialAccount?.bankCode ?? "");
  const [accountNumber, setAccountNumber] = useState(initialAccount?.accountNumber ?? "");
  const [resolvedName, setResolvedName] = useState<string | null>(initialAccount?.accountName ?? null);
  const [resolveError, setResolveError] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [localError, setLocalError] = useState("");
  const [pendingRequest, setPendingRequest] = useState<{
    id: string;
    newSnapshot?: DisbursementAccount;
    reason?: string;
  } | null>(null);
  const [updateRequestedLive, setUpdateRequestedLive] = useState<boolean>(updateRequested ?? false);
  const urgent = updateRequested || updateRequestedLive;

  useEffect(() => {
    const next = asAccount(initial);
    if (initial) {
      setAccount(next);
      setSelectedBank(next?.bankCode ?? "");
      setAccountNumber(next?.accountNumber ?? "");
      setResolvedName(next?.accountName ?? null);
      setAccountSource(
        typeof (initial as Record<string, unknown>).id === "string" &&
          String((initial as Record<string, unknown>).id).startsWith("application:")
          ? "application"
          : "saved"
      );
    }
  }, [initial]);

  async function loadBanks() {
    if (banks.length) return;
    setBusy("banks");
    try {
      const res = await fetch(`${config.apiUrl}/api/v1/providers/flutterwave/banks`, {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
      }).then((r) => r.json());
      if (res.ok) setBanks(res.banks || []);
      else {
        setLocalError(res.error || "Could not load banks");
        onError?.(res.error || "Could not load banks");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unable to load banks";
      setLocalError(msg);
      onError?.(msg);
    } finally {
      setBusy("");
    }
  }

  async function reloadAccount() {
    if (!userId) return;
    try {
      const res = await fetch(`${config.apiUrl}/api/v1/borrower/disbursement-account`, {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
      }).then((r) => r.json());
      if (res.ok) {
        setAccount(asAccount(res.account ?? null));
        setAccountSource(res.accountSource ?? (res.account ? "saved" : null));
        setPendingRequest(res.pendingRequests?.[0] ?? null);
        if (typeof res.updateRequested === "boolean") setUpdateRequestedLive(res.updateRequested);
      }
    } catch (_e) {
      /* ignore */
    }
  }

  useEffect(() => {
    loadBanks();
    reloadAccount();
  }, [userId]);

  useEffect(() => {
    if (selectedBank && accountNumber.length === 10 && !resolvedName && !resolveError && busy !== "resolve") void resolveAccount();
  }, [selectedBank, accountNumber]);

  async function resolveAccount() {
    if (!selectedBank || accountNumber.length < 10) return;
    setResolveError("");
    setResolvedName(null);
    setBusy("resolve");
    try {
      const res = await fetch(`${config.apiUrl}/api/v1/borrower/disbursement-account/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getAccessToken()}`,
        },
        body: JSON.stringify({ bankCode: selectedBank, accountNumber }),
      }).then((r) => r.json());
      if (res.ok) setResolvedName(res.accountName ?? res.resolved?.accountName ?? null);
      else setResolveError(res.error || "Could not resolve account");
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "Resolution failed");
    } finally {
      setBusy("");
    }
  }

  async function saveAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedBank || accountNumber.length !== 10 || !resolvedName) return;
    setBusy("save");
    setMessage("");
    setLocalError("");
    try {
      const bankName = banks.find((b) => b.code === selectedBank)?.name;
      const res = await fetch(`${config.apiUrl}/api/v1/borrower/disbursement-account`, {
        method: account ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getAccessToken()}`,
        },
        body: JSON.stringify({
          bankCode: selectedBank,
          bankName,
          accountNumber,
          accountName: resolvedName,
        }),
      }).then((r) => r.json());
      if (res.ok) {
        if (res.applied) {
          // (Legacy) auto-applied response — kept for backward compatibility.
          const saved = res.account ?? res.disbursementAccount ?? null;
          setAccount(asAccount(saved));
          setUpdateRequestedLive(false);
          setMessage(res.message || "Your new disbursement account has been verified and attached to your loan. Disbursement can now proceed.");
          onSaved?.(saved, { applied: true });
          setSelectedBank("");
          setAccountNumber("");
          setResolvedName(null);
          reloadAccount();
        } else if (res.pendingApproval) {
          // Changes always wait for admin approval before they take effect.
          const msg = res.message || "Your new account has been verified and submitted — it will take effect as soon as the admin approves the change.";
          setMessage(msg);
          setPendingRequest(res.request || null);
          onSaved?.(account);
        } else {
          setMessage(res.message || "Disbursement account saved.");
          const saved = res.account ?? res.disbursementAccount ?? null;
          setAccount(saved);
          onSaved?.(saved);
          reloadAccount();
        }
        if (!res.pendingApproval && !res.applied) {
          setSelectedBank("");
          setAccountNumber("");
          setResolvedName(null);
        }
      } else {
        setLocalError(res.error || "Save failed");
        onError?.(res.error || "Save failed");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      setLocalError(msg);
      onError?.(msg);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">
            Disbursement account
          </p>
          <h1 className="mt-2 text-2xl font-bold text-velo-900 sm:text-3xl dark:text-white">
            Bank disbursement setup
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
            Add a Nigerian bank account to receive loan disbursements. Subsequent edits require admin
            approval.
          </p>
        </div>
      </div>

      {localError && (
        <div className="rounded-xl border border-red-100 bg-red-50 dark:bg-red-900/20 dark:border-red-900/30 p-4 text-sm text-red-700 dark:text-red-400">
          {localError}
        </div>
      )}
      {message && (
        <div className="rounded-xl border border-emerald-100 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 p-4 text-sm text-emerald-700 dark:text-emerald-400">
          {message}
        </div>
      )}
      {pendingRequest && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-900/30 p-4 text-sm text-amber-800 dark:text-amber-300">
          <div className="font-semibold">⏳ Disbursement account change pending admin approval</div>
          <div className="mt-1 text-xs">
            New: {pendingRequest.newSnapshot?.bankName} ••••
            {String(pendingRequest.newSnapshot?.accountNumber || "").slice(-4)} —{" "}
            {pendingRequest.newSnapshot?.accountName}
          </div>
          {pendingRequest.reason && (
            <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              Note: {pendingRequest.reason}
            </div>
          )}
        </div>
      )}

      {urgent && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/30">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400">
              <Icon name="alert" size={18} />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-bold text-red-800 dark:text-red-300">
                Urgent attention needed — your loan disbursement is on hold
              </div>
              <p className="mt-1 text-xs leading-5 text-red-700 dark:text-red-300/90">
                The bank account saved on your profile could not be verified by our payment provider,
                so your approved loan cannot be paid out yet. Provide a valid account below — it is
                verified instantly and queued for admin approval. As soon as the admin approves the
                change, it is mapped to your loan and disbursement can proceed.
              </p>
            </div>
          </div>
        </div>
      )}

      <section className="velo-card p-5 sm:p-6">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="section-heading">
              {locked ? "Your disbursement account" : account ? (urgent ? "Update disbursement account" : "Edit disbursement account") : "Add disbursement account"}
            </h2>
            <p className="section-subheading">
              Select your bank and verify the account name before saving.
            </p>
          </div>
          {account?.status && (
            <span
              className={`badge ${
                account.status === "VERIFIED" || account.status === "ACTIVE"
                  ? "badge-completed"
                  : "badge-pending"
              }`}
            >
              {String(account.status).replace(/_/g, " ")}
            </span>
          )}
        </div>

        {locked ? (
          <div className="mt-5 space-y-3">
            {account ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/40">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-velo-900 dark:text-white">
                      {account.bankName ?? "Bank"} ••••{String(account.accountNumber ?? "").slice(-4)}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {account.accountName || "Account name on file"}
                      {account.bankCode ? ` · Bank code ${account.bankCode}` : ""}
                    </div>
                    <div className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      {accountSource === "application" ? "Submitted with your loan application" : "Saved disbursement account"}
                    </div>
                  </div>
                  <span className="badge badge-pending">Read-only during review</span>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-300">
                Your loan application has been submitted, but no disbursement account is attached to it yet. Add one below — it will be attached to your application automatically.
              </div>
            )}
            <p className="rounded-xl border border-amber-100 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/30 dark:bg-amber-900/20 dark:text-amber-300">
              This account is locked because you have a submitted loan application. Any change goes to
              Velo for approval first — this protects the account your loan will be paid into.
            </p>
          </div>
        ) : (
          <form
            onSubmit={saveAccount}
            className="mt-5 grid gap-4 md:grid-cols-3 md:items-end"
          >
            <label className="velo-label">
              Bank <span className="text-red-500">*</span>
              <select
                className="velo-input mt-1"
                value={selectedBank}
                onChange={(e) => {
                  setSelectedBank(e.target.value);
                  setResolvedName(null);
                  setResolveError("");
                }}
                required
                disabled={busy === "banks"}
              >
                <option value="">
                  {busy === "banks" ? "Loading banks…" : "Select your bank"}
                </option>
                {banks.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="velo-label">
              Account number <span className="text-red-500">*</span>
              <input
                className="velo-input mt-1"
                inputMode="numeric"
                maxLength={10}
                required
                value={accountNumber}
                onChange={(e) => {
                  setAccountNumber(e.target.value.replace(/\D/g, ""));
                  setResolvedName(null);
                  setResolveError("");
                }}
                placeholder="10-digit NUBAN"
              />
            </label>
            <div className="flex flex-col gap-2">
              {busy === "resolve" && <p className="text-sm text-slate-500">Resolving account name…</p>}
              {resolvedName && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 p-3 text-sm text-emerald-700 dark:text-emerald-400">
                  <span className="font-semibold">Account name:</span> {resolvedName}
                </div>
              )}
              {resolveError && (
                <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-900/30 p-3 text-sm text-red-700 dark:text-red-400">
                  {resolveError}
                </div>
              )}
            </div>
            <div className="md:col-span-3 flex flex-wrap gap-3 items-center">
              <button
                type="submit"
                className="btn-primary"
                disabled={busy === "save" || !resolvedName}
              >
                {busy === "save"
                  ? "Saving…"
                  : urgent
                  ? "Verify & update account"
                  : account
                  ? "Submit changes for approval"
                  : "Save account"}
              </button>
              {account && !urgent && (
                <div className="inline-flex items-center gap-1 text-xs text-slate-500">
                  <Icon name="alert" size={14} className="text-amber-500" />Subsequent edits require admin approval.
                </div>
              )}
            </div>
          </form>
        )}
      </section>

      <section className="velo-card p-5 sm:p-6">
        <h2 className="section-heading">Saved disbursement account</h2>
        <p className="section-subheading">
          Approved loans will be disbursed to the verified account below.
        </p>
        {account ? (
          <div
            className={`mt-5 rounded-xl border p-4 flex flex-wrap justify-between gap-3 items-center ${
              account.status === "VERIFIED" || account.status === "ACTIVE"
                ? "border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/10"
                : "border-slate-100 dark:border-slate-800"
            }`}
          >
            <div>
              <div className="text-sm font-semibold text-velo-900 dark:text-white">
                {account.bankName} ••••{String(account.accountNumber).slice(-4)}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {account.accountName} · Status: {account.status ?? "Pending"}
              </div>
              <div className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                {accountSource === "application" ? "Submitted with your loan application" : "Saved in settings"}
              </div>
            </div>
            {(account.status === "VERIFIED" || account.status === "ACTIVE") && (
              <span className="badge badge-completed">Active</span>
            )}
          </div>
        ) : (
          <div className="mt-5 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
            No disbursement account saved yet.
          </div>
        )}
      </section>
    </div>
  );
}
