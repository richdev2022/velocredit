import { useState } from "react";
import { adminCreateLoanManager } from "../../services/adminApi";

export default function LoanManagerAdmin() {
  const [name,setName]=useState(""); const [email,setEmail]=useState(""); const [busy,setBusy]=useState(false); const [message,setMessage]=useState(""); const [error,setError]=useState("");
  async function create() {
    setMessage(""); setError(""); if(!email.trim()){setError("Enter the loan manager email.");return;}
    setBusy(true); try { const r=await adminCreateLoanManager(email.trim(),name.trim()||"Loan Manager",window.location.origin); if(!r.ok) throw new Error(r.error||"Unable to create account."); setMessage("Account created. A secure password setup link has been emailed to the loan manager."); setName(""); setEmail(""); } catch(e:any){setError(e?.message||"Unable to create account.");} finally{setBusy(false);}
  }
  return <div className="max-w-2xl"><div className="velo-card p-5 space-y-4"><div><h2 className="text-lg font-bold text-velo-900">Loan Manager Accounts</h2><p className="text-sm text-slate-500 mt-1">Create a manager account. The manager receives an account-created email with a one-time password setup link.</p></div><input className="velo-input" placeholder="Manager name" value={name} onChange={e=>setName(e.target.value)}/><input className="velo-input" type="email" placeholder="Manager email" value={email} onChange={e=>setEmail(e.target.value)}/>{message&&<div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3 text-sm text-emerald-700">{message}</div>}{error&&<div className="rounded-lg bg-red-50 border border-red-100 p-3 text-sm text-red-700">{error}</div>}<button type="button" className="btn-primary" disabled={busy} onClick={create}>{busy?"Creating…":"Create Loan Manager"}</button></div></div>;
}
