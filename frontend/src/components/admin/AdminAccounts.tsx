import { useEffect, useState } from "react";
import { ADMIN_PERMISSIONS, adminCreateAdministrator, adminDeleteAdministrator, adminListAdministrators, adminSetAdministratorStatus, type AdminPermission, type Administrator } from "../../services/adminApi";

export default function AdminAccounts() {
  const [rows, setRows] = useState<Administrator[]>([]);
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [roles, setRoles] = useState<string[]>(["ADMIN"]);
  const [permissions, setPermissions] = useState<AdminPermission[]>([...ADMIN_PERMISSIONS]);
  const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function load() { try { setRows((await adminListAdministrators()).administrators); } catch (err) { setError(err instanceof Error ? err.message : "Unable to load administrators"); } }
  useEffect(() => { void load(); }, []);
  async function create() {
    setError(""); setMessage("");
    if (!form.name || !form.email || !form.phone || form.password.length < 12 || !roles.length) { setError("Enter staff details, select a role, and use a password of at least 12 characters."); return; }
    setBusy(true);
    try { await adminCreateAdministrator(form.email, form.name, form.phone, form.password, roles, permissions); setForm({ name: "", email: "", phone: "", password: "" }); setMessage("Staff account created. OTP verification is required at sign-in."); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Unable to create staff account"); } finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <div className="velo-card max-w-3xl space-y-4 p-5">
      <div><h2 className="text-lg font-bold text-velo-900">Administrator and staff accounts</h2><p className="mt-1 text-sm text-slate-500">Administrators have full access. Managers receive only the selected permissions.</p></div>
      <div className="grid gap-3 sm:grid-cols-2">{([["name", "Full name"], ["email", "Email"], ["phone", "Nigerian phone number"], ["password", "Temporary password (12+ characters)"]] as const).map(([key, placeholder]) => <input key={key} className="velo-input" type={key === "password" ? "password" : key === "email" ? "email" : "text"} placeholder={placeholder} value={form[key]} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} />)}</div>
      <div><p className="velo-label">Roles</p><div className="mt-2 flex gap-4">{["ADMIN", "LOAN_MANAGER"].map((role) => <label key={role} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={roles.includes(role)} onChange={() => setRoles((current) => current.includes(role) ? current.filter((item) => item !== role) : [...current, role])} />{role.replace("_", " ")}</label>)}</div></div>
      <div><p className="velo-label">Permissions</p><div className="mt-2 grid gap-2 sm:grid-cols-3">{ADMIN_PERMISSIONS.map((permission) => <label key={permission} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={permissions.includes(permission)} onChange={() => setPermissions((current) => current.includes(permission) ? current.filter((item) => item !== permission) : [...current, permission])} />{permission}</label>)}</div></div>
      {message && <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-3 text-sm text-emerald-700">{message}</div>}{error && <div className="rounded-lg border border-red-100 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      <button className="btn-primary" type="button" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create staff account"}</button>
    </div>
    <div className="velo-card divide-y divide-slate-100">{rows.map((row) => <div className="flex flex-wrap items-center justify-between gap-3 p-4" key={row.id}><div><div className="font-semibold text-velo-900">{row.fullName}</div><div className="text-xs text-slate-500">{row.email} · {row.phone}</div><div className="mt-1 text-xs text-slate-500">{row.roles.join(", ")} · {(row.adminPermissions ?? []).join(", ") || "No permissions"}</div><span className={`badge ${row.isActive === false ? "badge-pending" : "badge-completed"}`}>{row.isActive === false ? "DEACTIVATED" : "ACTIVE"}</span></div><div className="flex gap-2"><button className="btn-ghost text-xs" onClick={async () => { await adminSetAdministratorStatus(row.id, row.isActive === false); await load(); }}>{row.isActive === false ? "Activate" : "Deactivate"}</button><button className="btn-ghost text-xs text-red-600" onClick={async () => { if (window.confirm("Delete this account?")) { await adminDeleteAdministrator(row.id); await load(); } }}>Delete</button></div></div>)}</div>
  </div>;
}
