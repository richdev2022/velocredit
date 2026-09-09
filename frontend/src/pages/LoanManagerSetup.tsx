import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import Layout from "../components/Layout";
import { setLoanManagerPassword } from "../services/adminApi";

export default function LoanManagerSetup() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError("");
    if (!token) { setError("This invitation link is invalid."); return; }
    if (password.length < 10) { setError("Password must be at least 10 characters."); return; }
    if (password !== confirm) { setError("Passwords do not match."); return; }
    setBusy(true);
    try {
      const res = await setLoanManagerPassword(token, password);
      if (!res.ok) throw new Error(res.error || "Unable to set password.");
      setMessage("Your password has been set successfully. You can now log in to the Velo Finance admin portal.");
    } catch (err: any) { setError(err?.message || "Unable to set password."); }
    finally { setBusy(false); }
  }

  return <Layout showHomeLink={false}><div className="max-w-md mx-auto py-10"><form onSubmit={submit} className="velo-card p-6 space-y-4"><div><h1 className="text-xl font-bold text-velo-900">Set Loan Manager Password</h1><p className="text-sm text-slate-500 mt-1">Choose a password of at least 10 characters. This invitation is valid for 24 hours.</p></div><label className="velo-label">New Password<input className="velo-input mt-1" type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="new-password" required/></label><label className="velo-label">Confirm Password<input className="velo-input mt-1" type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} autoComplete="new-password" required/></label>{message&&<div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3 text-sm text-emerald-700">{message}<div className="mt-2"><Link className="underline font-semibold" to="/admin">Go to admin login</Link></div></div>}{error&&<div className="rounded-lg bg-red-50 border border-red-100 p-3 text-sm text-red-700">{error}</div>}<button className="btn-primary w-full" disabled={busy||!!message}>{busy?"Saving…":"Set Password"}</button></form></div></Layout>;
}
