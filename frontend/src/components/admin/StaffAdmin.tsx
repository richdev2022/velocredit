// ============================================================================
// src/components/admin/StaffAdmin.tsx
// Team management — the back-office staff directory.
//
// Industry-standard RBAC surface:
//   • A unified table of EVERY staff member (administrators + loan managers)
//     with the columns that matter: identity, role, access, status, tenure.
//   • Click a row → full detail drawer: profile, access control (role
//     assignment + per-permission checklist), status and a danger zone.
//   • Row actions: activate/deactivate, change role, edit permissions, delete.
//   • "Add staff" creates the account (invite email with login details is sent
//     automatically by the API) with a staff-role or custom permission set.
//
// All actions hit the DB-authoritative /admin/staff endpoints, so they work
// across serverless instances (fixes the historic "Administrator not found"
// 404 on delete/deactivate).
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ADMIN_PERMISSIONS,
  adminCreateAdministrator,
  adminCreateLoanManager,
  adminDeleteStaff,
  adminListStaff,
  adminListStaffRoles,
  adminSetStaffStatus,
  adminUpdateStaffAccess,
  PERMISSION_GROUPS,
  PERMISSION_META,
  permissionLabel,
  type AdminPermission,
  type StaffMember,
  type StaffRole,
} from "../../services/adminApi";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
}

function fmtDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  let password = "";
  const random = new Uint32Array(16);
  crypto.getRandomValues(random);
  for (let index = 0; index < 16; index += 1) password += alphabet[random[index] % alphabet.length];
  return password;
}

// Grouped permission checklist used by the drawer, the create modal and the
// roles manager — one consistent control for picking access.
export function PermissionChecklist({ selected, onToggle, disabled = false }: { selected: AdminPermission[]; onToggle: (permission: AdminPermission) => void; disabled?: boolean }) {
  return (
    <div className="space-y-4">
      {PERMISSION_GROUPS.map((group) => {
        const permissions = ADMIN_PERMISSIONS.filter((permission) => PERMISSION_META[permission].group === group);
        if (permissions.length === 0) return null;
        const allSelected = permissions.every((permission) => selected.includes(permission));
        return (
          <div key={group}>
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">{group}</p>
              <button
                type="button"
                disabled={disabled}
                onClick={() => permissions.forEach((permission) => { if (allSelected === selected.includes(permission)) onToggle(permission); })}
                className="text-[11px] font-semibold text-velo-600 hover:text-velo-700 dark:text-velo-300 disabled:opacity-40"
              >
                {allSelected ? "Clear all" : "Select all"}
              </button>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {permissions.map((permission) => {
                const checked = selected.includes(permission);
                return (
                  <label
                    key={permission}
                    className={`flex items-start gap-2.5 rounded-xl border p-2.5 transition ${checked ? "border-velo-300 bg-velo-50/60 dark:border-velo-700 dark:bg-velo-900/20" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"} ${disabled ? "opacity-60" : "cursor-pointer hover:border-velo-300 dark:hover:border-velo-700"}`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-emerald-600"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => onToggle(permission)}
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold text-velo-900 dark:text-slate-100">{PERMISSION_META[permission].label}</span>
                      <span className="block text-[11px] leading-4 text-slate-500 dark:text-slate-400">{PERMISSION_META[permission].description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const ROLE_BADGE: Record<StaffMember["platformRole"], { label: string; className: string }> = {
  ADMIN: { label: "Administrator", className: "bg-velo-50 text-velo-700 dark:bg-velo-900/40 dark:text-velo-200" },
  LOAN_MANAGER: { label: "Loan manager", className: "bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200" },
};

type CreateForm = { fullName: string; email: string; phone: string; password: string; platformRole: "ADMIN" | "LOAN_MANAGER"; accessMode: "role" | "custom" | "full"; roleId: string; permissions: AdminPermission[] };

export default function StaffAdmin({ onChanged }: { onChanged?: () => void }) {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [roles, setRoles] = useState<StaffRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "ADMIN" | "LOAN_MANAGER">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [createVisiblePassword, setCreateVisiblePassword] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>({ fullName: "", email: "", phone: "", password: "", platformRole: "LOAN_MANAGER", accessMode: "role", roleId: "", permissions: [] });
  const [busy, setBusy] = useState(false);

  // Detail-drawer working state (role + permission edits staged before save).
  const member = staff.find((entry) => entry.id === drawerId) ?? null;
  const [drawerRole, setDrawerRole] = useState<string>("");
  const [drawerPermissions, setDrawerPermissions] = useState<AdminPermission[]>([]);
  const [drawerDirty, setDrawerDirty] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [staffResponse, rolesResponse] = await Promise.all([adminListStaff(), adminListStaffRoles()]);
      setStaff(staffResponse.staff);
      setRoles(rolesResponse.roles);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the team directory");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Close the row-action menu on any outside click.
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpenId(null);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function openDrawer(target: StaffMember) {
    setDrawerId(target.id);
    setDrawerRole(target.staffRoleId ?? "");
    setDrawerPermissions(target.platformRole === "ADMIN" ? [...ADMIN_PERMISSIONS] : [...(target.effectivePermissions ?? [])]);
    setDrawerDirty(false);
    setMenuOpenId(null);
  }

  async function toggleStatus(target: StaffMember) {
    setBusy(true); setError(""); setMessage("");
    try {
      await adminSetStaffStatus(target.id, target.isActive === false);
      setMessage(`${target.fullName} is now ${target.isActive === false ? "active" : "deactivated"}.`);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update the staff member");
    } finally { setBusy(false); }
  }

  async function removeStaff(target: StaffMember) {
    if (!window.confirm(`Delete ${target.fullName}'s account permanently? This cannot be undone.`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await adminDeleteStaff(target.id);
      setMessage(`${target.fullName}'s account has been deleted.`);
      if (drawerId === target.id) setDrawerId(null);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete the staff member");
    } finally { setBusy(false); }
  }

  async function saveDrawerAccess() {
    if (!member) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await adminUpdateStaffAccess(member.id, {
        staffRoleId: drawerRole || null,
        permissions: member.platformRole === "ADMIN" ? undefined : drawerPermissions,
      });
      setMessage(`${member.fullName}'s access has been updated. It applies from their next request.`);
      setDrawerDirty(false);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update access");
    } finally { setBusy(false); }
  }

  async function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setMessage("");
    const createdEmail = createForm.email.trim();
    try {
      const isCustom = createForm.accessMode === "custom";
      const roleId = createForm.accessMode === "role" ? createForm.roleId : undefined;
      const permissions = isCustom ? createForm.permissions : undefined;
      const response = createForm.platformRole === "ADMIN"
        ? await adminCreateAdministrator(createdEmail, createForm.fullName.trim(), createForm.phone.trim(), createForm.password, ["ADMIN"])
        : await adminCreateLoanManager(createdEmail, createForm.fullName.trim(), window.location.origin, createForm.phone.trim(), createForm.password, permissions, roleId);
      const deliveryNote = response.notifiedByEmail === false
        ? "Email delivery is not configured — share the login details and sign-in instructions with them manually."
        : "An invite email with their login details and sign-in instructions is on the way; OTP verification is required at sign-in.";
      setMessage(`Staff account created for ${createdEmail}. ${deliveryNote}`);
      setCreateOpen(false);
      setCreateVisiblePassword(false);
      setCreateForm({ fullName: "", email: "", phone: "", password: "", platformRole: "LOAN_MANAGER", accessMode: "role", roleId: "", permissions: [] });
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create the staff account");
    } finally { setBusy(false); }
  }

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return staff.filter((entry) => {
      if (roleFilter !== "all" && entry.platformRole !== roleFilter) return false;
      if (statusFilter === "active" && entry.isActive === false) return false;
      if (statusFilter === "inactive" && entry.isActive !== false) return false;
      if (!query) return true;
      return [entry.fullName, entry.email, entry.phone, entry.staffRoleName ?? "", ...(entry.effectivePermissions ?? [])].join(" ").toLowerCase().includes(query);
    });
  }, [staff, search, roleFilter, statusFilter]);

  const activeCount = staff.filter((entry) => entry.isActive !== false).length;
  const inactiveCount = staff.length - activeCount;
  const effectivePerms = (entry: StaffMember) => entry.platformRole === "ADMIN" ? ADMIN_PERMISSIONS : (entry.effectivePermissions ?? []);

  return (
    <div className="space-y-4 sm:space-y-5">
      {/* Header */}
      <div className="velo-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-velo-900 dark:text-white sm:text-xl">Team management</h2>
            <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
              Every back-office account in one place — administrators hold full access, loan managers carry exactly the permissions their role grants them.
            </p>
          </div>
          <button type="button" className="btn-primary !px-4 !py-2.5 text-sm" onClick={() => setCreateOpen(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            Add staff
          </button>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: "Total staff", value: staff.length, tone: "text-velo-900 dark:text-white" },
            { label: "Active", value: activeCount, tone: "text-emerald-600 dark:text-emerald-400" },
            { label: "Deactivated", value: inactiveCount, tone: "text-amber-600 dark:text-amber-400" },
            { label: "Roles defined", value: roles.length, tone: "text-velo-900 dark:text-white" },
          ].map((stat) => (
            <div key={stat.label} className="rounded-xl border border-slate-100 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-950/60">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400 dark:text-slate-500">{stat.label}</p>
              <p className={`mt-1 text-2xl font-black ${stat.tone}`}>{stat.value}</p>
            </div>
          ))}
        </div>
      </div>

      {(message || error) && (
        <div className={`velo-card border p-4 text-sm ${error ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300" : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300"}`}>
          {error || message}
        </div>
      )}

      {/* Directory */}
      <div className="velo-card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4 dark:border-slate-800">
          <div className="relative min-w-[200px] flex-1">
            <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input
              className="velo-input !py-2.5 !pl-9 text-sm"
              placeholder="Search by name, email, phone or permission…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <select className="velo-input !w-auto !py-2.5 text-sm" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value as typeof roleFilter)}>
            <option value="all">All roles</option>
            <option value="ADMIN">Administrators</option>
            <option value="LOAN_MANAGER">Loan managers</option>
          </select>
          <select className="velo-input !w-auto !py-2.5 text-sm" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="all">Any status</option>
            <option value="active">Active</option>
            <option value="inactive">Deactivated</option>
          </select>
        </div>

        {loading ? (
          <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400">Loading the team directory…</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400">No staff members match the current filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] uppercase tracking-[0.12em] text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-5 py-3 font-bold">Staff member</th>
                  <th className="px-4 py-3 font-bold">Role</th>
                  <th className="px-4 py-3 font-bold">Access</th>
                  <th className="px-4 py-3 font-bold">Status</th>
                  <th className="px-4 py-3 font-bold">Joined</th>
                  <th className="px-4 py-3 font-bold">Last sign-in</th>
                  <th className="px-4 py-3 text-right font-bold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filtered.map((entry) => {
                  const badge = ROLE_BADGE[entry.platformRole];
                  const permissions = effectivePerms(entry);
                  const isMenuOpen = menuOpenId === entry.id;
                  return (
                    <tr
                      key={entry.id}
                      onClick={() => openDrawer(entry)}
                      className="cursor-pointer transition hover:bg-slate-50/80 dark:hover:bg-slate-900/60"
                    >
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 text-xs font-bold text-white shadow-sm">
                            {initials(entry.fullName)}
                          </span>
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5 font-semibold text-velo-900 dark:text-white">
                              <span className="truncate">{entry.fullName}</span>
                              {entry.isPrimary && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">Owner</span>}
                            </span>
                            <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{entry.email}</span>
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${badge.className}`}>{badge.label}</span>
                        {entry.staffRoleName && <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">{entry.staffRoleName}</span>}
                      </td>
                      <td className="px-4 py-3.5">
                        {entry.platformRole === "ADMIN" ? (
                          <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">Full access</span>
                        ) : permissions.length === 0 ? (
                          <span className="text-xs italic text-slate-400">No permissions</span>
                        ) : (
                          <span className="flex flex-wrap items-center gap-1">
                            {permissions.slice(0, 2).map((permission) => (
                              <span key={permission} className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{permissionLabel(permission)}</span>
                            ))}
                            {permissions.length > 2 && <span className="text-[10px] font-bold text-velo-600 dark:text-velo-300">+{permissions.length - 2} more</span>}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3.5">
                        <span className={`badge ${entry.isActive === false ? "badge-pending" : "badge-completed"}`}>{entry.isActive === false ? "Deactivated" : "Active"}</span>
                      </td>
                      <td className="px-4 py-3.5 text-xs text-slate-500 dark:text-slate-400">{fmtDate(entry.createdAt)}</td>
                      <td className="px-4 py-3.5 text-xs text-slate-500 dark:text-slate-400">{fmtDate(entry.lastLoginAt)}</td>
                      <td className="px-4 py-3.5 text-right" onClick={(event) => event.stopPropagation()}>
                        <div className="relative inline-block text-left" ref={isMenuOpen ? menuRef : undefined}>
                          <button
                            type="button"
                            aria-label={`Actions for ${entry.fullName}`}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-velo-900 dark:hover:bg-slate-800 dark:hover:text-white"
                            onClick={() => setMenuOpenId(isMenuOpen ? null : entry.id)}
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
                          </button>
                          {isMenuOpen && (
                            <div className="absolute right-0 top-9 z-20 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-900">
                              <button className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800" onClick={() => openDrawer(entry)}>
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
                                View details
                              </button>
                              {entry.isActive === false ? (
                                <button className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800" disabled={busy} onClick={() => void toggleStatus(entry)}>
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m5 13 4 4L19 7" /></svg>
                                  Activate account
                                </button>
                              ) : (
                                <button className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800" disabled={busy} onClick={() => void toggleStatus(entry)}>
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="6" y="4" width="12" height="16" rx="2" /><path d="M9 2v2M15 2v2" /></svg>
                                  Deactivate account
                                </button>
                              )}
                              <button className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800" onClick={() => { openDrawer(entry); }}>
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 3l1.9 5.8H20l-4.9 3.6 1.9 5.8-5-3.6-5 3.6 1.9-5.8L4 8.8h6.1z" /></svg>
                                Change role / permissions
                              </button>
                              <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
                              <button className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40" disabled={busy} onClick={() => void removeStaff(entry)}>
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13" /></svg>
                                Delete account
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detail drawer */}
      {member && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <button type="button" aria-label="Close details" className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setDrawerId(null)} />
          <aside className="relative z-10 flex h-full w-full max-w-lg flex-col overflow-y-auto bg-white shadow-2xl dark:bg-slate-900 sm:max-w-xl">
            {/* Drawer header */}
            <div className="sticky top-0 z-10 border-b border-slate-100 bg-white/95 px-5 py-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-sm font-bold text-white shadow-md">
                    {initials(member.fullName)}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-base font-bold text-velo-900 dark:text-white">{member.fullName}</p>
                    <p className="truncate text-xs text-slate-500 dark:text-slate-400">{member.email}</p>
                  </div>
                </div>
                <button type="button" aria-label="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => setDrawerId(null)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
            </div>

            <div className="space-y-5 p-5">
              {/* Profile */}
              <section className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-950/50">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">Profile</p>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  {[
                    ["Account type", ROLE_BADGE[member.platformRole].label],
                    ["Staff role", member.staffRoleName ?? "—"],
                    ["Phone", member.phone || "—"],
                    ["Joined", fmtDate(member.createdAt)],
                    ["Last sign-in", fmtDate(member.lastLoginAt)],
                    ["Status", member.isActive === false ? "Deactivated" : "Active"],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">{label}</dt>
                      <dd className="mt-0.5 font-semibold text-velo-900 dark:text-slate-100">{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>

              {/* Access control */}
              <section className="rounded-2xl border border-slate-100 p-4 dark:border-slate-800">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">Access control</p>
                  {member.platformRole === "ADMIN" && <span className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">Administrators always hold full access</span>}
                </div>
                {member.platformRole !== "ADMIN" && (
                  <>
                    <label className="mt-3 block">
                      <span className="velo-label !text-xs">Assigned role</span>
                      <select className="velo-input !py-2.5 text-sm" value={drawerRole} onChange={(event) => { setDrawerRole(event.target.value); setDrawerDirty(true); }}>
                        <option value="">— Custom (direct permissions) —</option>
                        {roles.map((role) => (
                          <option key={role.id} value={role.id}>{role.name} · {role.permissions.length} permission{role.permissions.length === 1 ? "" : "s"}</option>
                        ))}
                      </select>
                    </label>
                    <div className="mt-4">
                      <p className="velo-label !text-xs">Permissions {drawerRole && <span className="font-normal normal-case text-slate-400">(inherited from the role — retune it under Roles &amp; permissions)</span>}</p>
                      <div className={drawerRole ? "pointer-events-none opacity-70" : ""}>
                        <PermissionChecklist
                          selected={drawerPermissions}
                          onToggle={(permission) => {
                            setDrawerPermissions((current) => current.includes(permission) ? current.filter((entry) => entry !== permission) : [...current, permission]);
                            setDrawerDirty(true);
                          }}
                        />
                      </div>
                    </div>
                    <button type="button" className="btn-primary mt-4 w-full !py-2.5 text-sm" disabled={busy || !drawerDirty} onClick={() => void saveDrawerAccess()}>
                      {busy ? "Saving…" : "Save access changes"}
                    </button>
                  </>
                )}
                {member.platformRole === "ADMIN" && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {ADMIN_PERMISSIONS.map((permission) => (
                      <span key={permission} className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="m5 13 4 4L19 7" /></svg>
                        {permissionLabel(permission)}
                      </span>
                    ))}
                  </div>
                )}
              </section>

              {/* Status + danger zone */}
              <section className="rounded-2xl border border-amber-200/70 bg-amber-50/50 p-4 dark:border-amber-900/40 dark:bg-amber-950/20">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-amber-600 dark:text-amber-400">Account controls</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {member.isActive === false ? (
                    <button type="button" className="btn-secondary !px-4 !py-2 text-xs" disabled={busy} onClick={() => void toggleStatus(member)}>Activate account</button>
                  ) : (
                    <button type="button" className="btn-secondary !px-4 !py-2 text-xs" disabled={busy || member.isPrimary} onClick={() => void toggleStatus(member)} title={member.isPrimary ? "The primary administrator cannot be deactivated" : undefined}>
                      Deactivate account
                    </button>
                  )}
                  <button type="button" className="btn-danger !px-4 !py-2 text-xs" disabled={busy || member.isPrimary} onClick={() => void removeStaff(member)} title={member.isPrimary ? "The primary administrator cannot be deleted" : undefined}>
                    Delete permanently
                  </button>
                </div>
                <p className="mt-2 text-[11px] leading-4 text-amber-700/80 dark:text-amber-400/80">
                  Deactivating signs the member out immediately and blocks new sign-ins; their history stays intact. Deleting removes the account permanently.
                </p>
              </section>
            </div>
          </aside>
        </div>
      )}

      {/* Create staff modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button type="button" aria-label="Close" className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setCreateOpen(false)} />
          <div className="relative z-10 max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl dark:bg-slate-900">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-bold text-velo-900 dark:text-white">Add a staff member</h3>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">They'll receive an invite email with their login details and sign-in instructions.</p>
              </div>
              <button type="button" aria-label="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => setCreateOpen(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <form className="mt-5 space-y-4" onSubmit={submitCreate}>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="velo-label !text-xs">Full name</span>
                  <input className="velo-input !py-2.5 text-sm" required minLength={2} maxLength={120} value={createForm.fullName} onChange={(event) => setCreateForm((form) => ({ ...form, fullName: event.target.value }))} placeholder="Adaeze Okafor" />
                </label>
                <label className="block">
                  <span className="velo-label !text-xs">Work email</span>
                  <input className="velo-input !py-2.5 text-sm" required type="email" value={createForm.email} onChange={(event) => setCreateForm((form) => ({ ...form, email: event.target.value }))} placeholder="adaeze@velocredit.ng" />
                </label>
                <label className="block">
                  <span className="velo-label !text-xs">Phone (NGN)</span>
                  <input className="velo-input !py-2.5 text-sm" required value={createForm.phone} onChange={(event) => setCreateForm((form) => ({ ...form, phone: event.target.value }))} placeholder="08012345678" />
                </label>
                <label className="block">
                  <span className="velo-label !text-xs">Temporary password (min 12 chars)</span>
                  <div className="flex gap-2">
                    <input className="velo-input !py-2.5 text-sm" required minLength={12} type={createVisiblePassword ? "text" : "password"} value={createForm.password} onChange={(event) => setCreateForm((form) => ({ ...form, password: event.target.value }))} placeholder="••••••••••••" />
                    <button type="button" className="btn-ghost shrink-0 !px-3 text-xs" onClick={() => { setCreateVisiblePassword(true); setCreateForm((form) => ({ ...form, password: generatePassword() })); }}>Generate</button>
                  </div>
                </label>
              </div>

              <div>
                <span className="velo-label !text-xs">Account type</span>
                <div className="grid gap-2 sm:grid-cols-2">
                  {([
                    { value: "LOAN_MANAGER", title: "Loan manager", hint: "Scoped access — grant exactly the permissions the role carries." },
                    { value: "ADMIN", title: "Administrator", hint: "Full back-office access to every module and setting." },
                  ] as const).map((option) => (
                    <label key={option.value} className={`cursor-pointer rounded-xl border p-3 transition ${createForm.platformRole === option.value ? "border-velo-400 bg-velo-50/60 dark:border-velo-600 dark:bg-velo-900/20" : "border-slate-200 dark:border-slate-700"}`}>
                      <input type="radio" name="platformRole" className="sr-only" checked={createForm.platformRole === option.value} onChange={() => setCreateForm((form) => ({ ...form, platformRole: option.value }))} />
                      <span className="block text-sm font-bold text-velo-900 dark:text-white">{option.title}</span>
                      <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{option.hint}</span>
                    </label>
                  ))}
                </div>
              </div>

              {createForm.platformRole === "LOAN_MANAGER" && (
                <div>
                  <span className="velo-label !text-xs">Access template</span>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {([
                      { value: "role", title: "Use a role", hint: "Pick a defined role" },
                      { value: "custom", title: "Custom", hint: "Hand-pick permissions" },
                      { value: "full", title: "Full access", hint: "All permissions" },
                    ] as const).map((option) => (
                      <label key={option.value} className={`cursor-pointer rounded-xl border p-2.5 text-center transition ${createForm.accessMode === option.value ? "border-velo-400 bg-velo-50/60 dark:border-velo-600 dark:bg-velo-900/20" : "border-slate-200 dark:border-slate-700"}`}>
                        <input type="radio" name="accessMode" className="sr-only" checked={createForm.accessMode === option.value} onChange={() => setCreateForm((form) => ({ ...form, accessMode: option.value }))} />
                        <span className="block text-xs font-bold text-velo-900 dark:text-white">{option.title}</span>
                        <span className="block text-[10px] text-slate-500 dark:text-slate-400">{option.hint}</span>
                      </label>
                    ))}
                  </div>
                  {createForm.accessMode === "role" && (
                    <label className="mt-3 block">
                      <span className="velo-label !text-xs">Role</span>
                      <select className="velo-input !py-2.5 text-sm" required value={createForm.roleId} onChange={(event) => setCreateForm((form) => ({ ...form, roleId: event.target.value }))}>
                        <option value="" disabled>Select a role…</option>
                        {roles.map((role) => (
                          <option key={role.id} value={role.id}>{role.name} · {role.permissions.length} permission{role.permissions.length === 1 ? "" : "s"}</option>
                        ))}
                      </select>
                      {roles.length === 0 && <span className="velo-helper">No roles defined yet — create one under Roles &amp; permissions, or pick “Custom”.</span>}
                    </label>
                  )}
                  {createForm.accessMode === "custom" && (
                    <div className="mt-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                      <PermissionChecklist
                        selected={createForm.permissions}
                        onToggle={(permission) => setCreateForm((form) => ({ ...form, permissions: form.permissions.includes(permission) ? form.permissions.filter((entry) => entry !== permission) : [...form.permissions, permission] }))}
                      />
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button type="button" className="btn-secondary !px-4 !py-2.5 text-sm" onClick={() => setCreateOpen(false)}>Cancel</button>
                <button type="submit" className="btn-primary !px-5 !py-2.5 text-sm" disabled={busy}>
                  {busy ? "Creating…" : "Create staff account"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
