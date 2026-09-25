// ============================================================================
// src/components/admin/RolesPermissions.tsx
// Roles & permissions — manage the reusable permission templates that get
// assigned to back-office staff.
//
//   • Create a role and tick exactly the permissions it should carry.
//   • Edit any role later: check/untick permissions and every member holding
//     the role picks up the new set automatically (propagated by the API).
//   • Delete a role once no staff member is assigned to it.
//
// Roles live in the durable roles/role_permissions tables, so they survive
// server restarts and apply across every serving instance.
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import {
  adminCreateStaffRole,
  adminDeleteStaffRole,
  adminListStaffRoles,
  adminUpdateStaffRole,
  permissionLabel,
  type AdminPermission,
  type StaffRole,
} from "../../services/adminApi";
import { PermissionChecklist } from "./StaffAdmin";

type EditorState = { mode: "create" | "edit"; id?: string; name: string; description: string; permissions: AdminPermission[] };

const EMPTY_EDITOR: EditorState = { mode: "create", name: "", description: "", permissions: [] };

export default function RolesPermissions({ onChanged }: { onChanged?: () => void }) {
  const [roles, setRoles] = useState<StaffRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<StaffRole | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await adminListStaffRoles();
      setRoles(response.roles);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load roles");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function submitEditor(event: React.FormEvent) {
    event.preventDefault();
    if (!editor) return;
    setBusy(true); setError(""); setMessage("");
    try {
      if (editor.mode === "create") {
        await adminCreateStaffRole(editor.name.trim(), editor.description.trim(), editor.permissions);
        setMessage(`Role “${editor.name.trim()}” created — assign it when adding or editing a staff member.`);
      } else if (editor.id) {
        await adminUpdateStaffRole(editor.id, { name: editor.name.trim(), description: editor.description.trim(), permissions: editor.permissions });
        setMessage(`Role “${editor.name.trim()}” updated — every member holding it now carries the new permission set.`);
      }
      setEditor(null);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save the role");
    } finally { setBusy(false); }
  }

  async function deleteRole() {
    if (!confirmDelete) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await adminDeleteStaffRole(confirmDelete.id);
      setMessage(`Role “${confirmDelete.name}” deleted.`);
      setConfirmDelete(null);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete the role");
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="velo-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-velo-900 dark:text-white sm:text-xl">Roles &amp; permissions</h2>
            <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
              Roles are reusable access templates. Create one, tick the permissions it should carry, and assign it to staff — retune it later and every holder updates automatically.
            </p>
          </div>
          <button type="button" className="btn-primary !px-4 !py-2.5 text-sm" onClick={() => setEditor(EMPTY_EDITOR)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            New role
          </button>
        </div>
      </div>

      {(message || error) && (
        <div className={`velo-card border p-4 text-sm ${error ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300" : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300"}`}>
          {error || message}
        </div>
      )}

      {loading ? (
        <div className="velo-card p-10 text-center text-sm text-slate-500 dark:text-slate-400">Loading roles…</div>
      ) : roles.length === 0 ? (
        <div className="velo-card p-10 text-center">
          <p className="text-sm font-semibold text-velo-900 dark:text-white">No roles yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
            Create your first role — for example “Loan officer” with only loan review and KYC permissions — and assign it when adding staff.
          </p>
          <button type="button" className="btn-primary mt-4 !px-4 !py-2.5 text-sm" onClick={() => setEditor(EMPTY_EDITOR)}>Create a role</button>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {roles.map((role) => (
            <div key={role.id} className="velo-card flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-velo-50 text-velo-600 dark:bg-velo-900/40 dark:text-velo-300">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 3l1.9 5.8H20l-4.9 3.6 1.9 5.8-5-3.6-5 3.6 1.9-5.8L4 8.8h6.1z" /></svg>
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-bold text-velo-900 dark:text-white">{role.name}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">{role.memberCount ?? 0} member{role.memberCount === 1 ? "" : "s"} · {role.permissions.length} permission{role.permissions.length === 1 ? "" : "s"}</p>
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    className="btn-ghost !px-3 !py-1.5 text-xs"
                    onClick={() => setEditor({ mode: "edit", id: role.id, name: role.name, description: role.description ?? "", permissions: [...role.permissions] })}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn-danger !px-3 !py-1.5 text-xs"
                    disabled={role.isSystem}
                    title={role.isSystem ? "System roles cannot be deleted" : undefined}
                    onClick={() => setConfirmDelete(role)}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {role.description && <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">{role.description}</p>}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {role.permissions.length === 0 ? (
                  <span className="text-xs italic text-slate-400">No permissions — this role grants no access yet.</span>
                ) : (
                  role.permissions.map((permission) => (
                    <span key={permission} className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{permissionLabel(permission)}</span>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create / edit modal */}
      {editor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button type="button" aria-label="Close" className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setEditor(null)} />
          <div className="relative z-10 max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl dark:bg-slate-900">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-bold text-velo-900 dark:text-white">{editor.mode === "create" ? "Create a role" : `Edit “${editor.name}”`}</h3>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  {editor.mode === "create" ? "Name the role and tick the permissions it grants." : "Retune the permission set — members holding this role pick up the change automatically."}
                </p>
              </div>
              <button type="button" aria-label="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => setEditor(null)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <form className="mt-5 space-y-4" onSubmit={submitEditor}>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="velo-label !text-xs">Role name</span>
                  <input className="velo-input !py-2.5 text-sm" required minLength={2} maxLength={60} value={editor.name} onChange={(event) => setEditor((state) => state ? { ...state, name: event.target.value } : state)} placeholder="e.g. Loan officer" />
                </label>
                <label className="block">
                  <span className="velo-label !text-xs">Description (optional)</span>
                  <input className="velo-input !py-2.5 text-sm" maxLength={280} value={editor.description} onChange={(event) => setEditor((state) => state ? { ...state, description: event.target.value } : state)} placeholder="What is this role responsible for?" />
                </label>
              </div>
              <div>
                <span className="velo-label !text-xs">Permissions</span>
                <PermissionChecklist
                  selected={editor.permissions}
                  onToggle={(permission) => setEditor((state) => state ? { ...state, permissions: state.permissions.includes(permission) ? state.permissions.filter((entry) => entry !== permission) : [...state.permissions, permission] } : state)}
                />
              </div>
              <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <button type="button" className="btn-secondary !px-4 !py-2.5 text-sm" onClick={() => setEditor(null)}>Cancel</button>
                <button type="submit" className="btn-primary !px-5 !py-2.5 text-sm" disabled={busy}>
                  {busy ? "Saving…" : editor.mode === "create" ? "Create role" : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button type="button" aria-label="Close" className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setConfirmDelete(null)} />
          <div className="relative z-10 w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-slate-900">
            <h3 className="text-lg font-bold text-velo-900 dark:text-white">Delete “{confirmDelete.name}”?</h3>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              {confirmDelete.memberCount
                ? `${confirmDelete.memberCount} staff member${confirmDelete.memberCount === 1 ? "" : "s"} still hold${confirmDelete.memberCount === 1 ? "s" : ""} this role — reassign them first.`
                : "This permission template will be removed permanently. Staff accounts are not affected."}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn-secondary !px-4 !py-2.5 text-sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button type="button" className="btn-danger !px-4 !py-2.5 text-sm" disabled={busy || Boolean(confirmDelete.memberCount)} onClick={() => void deleteRole()}>
                {busy ? "Deleting…" : "Delete role"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
