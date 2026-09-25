import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import AdminLogin from "../components/admin/AdminLogin";
import AdminApplicationsTable from "../components/admin/AdminApplicationsTable";
import AdminDetail from "../components/admin/AdminDetail";
import AdminBorrowerDetail from "../components/admin/AdminBorrowerDetail";
import AdminSettings from "../components/admin/AdminSettings";
import StaffAdmin from "../components/admin/StaffAdmin";
import RolesPermissions from "../components/admin/RolesPermissions";
import AdminWorkspace, { type AdminSection } from "../components/admin/AdminWorkspace";
import AdminAccountRequests from "../components/admin/AdminAccountRequests";
import { config } from "../utils/config";
import {
  getAdminToken,
  getAdminRole,
  getAdminPermissions,
  clearAdminToken,
  adminLogout,
} from "../services/adminApi";

type View =
  | AdminSection
  | "account-requests"
  | "applications"
  | "detail"
  | "borrower-detail"
  | "settings"
  | "managers"
  | "roles"
  | "ledger"
  | "withdrawals"
  | "investor-tools";

type MenuItem = {
  key: View;
  label: string;
  group: string;
  icon: JSX.Element;
};

const Icons = {
  Overview: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  Applications: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
    </svg>
  ),
  Users: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <path d="M20 8v6M23 11h-6" />
    </svg>
  ),
  Investors: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
    </svg>
  ),
  Shield: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  MoneyOut: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
      <path d="M17 17l3-3-3-3" />
    </svg>
  ),
  Loan: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M2 10h20M6 14h.01M10 14h4" />
    </svg>
  ),
  Book: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
    </svg>
  ),
  Wallet: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 12V8H6a2 2 0 01-2-2c0-1.1.9-2 2-2h12v4" />
      <path d="M4 6v12c0 1.1.9 2 2 2h14v-4" />
      <path d="M18 12a2 2 0 000 4h4v-4h-4z" />
    </svg>
  ),
  Tools: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
    </svg>
  ),
  Chart: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M7 16l4-4 4 4 5-5" />
    </svg>
  ),
  History: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  UserShield: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <path d="M18 8V5m3 3h-6" />
    </svg>
  ),
  RolesShield: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  Settings: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  ),
  Pending: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  ),
  Logout: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  ),
  External: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  ),
};

const menu: MenuItem[] = [
  { key: "overview", label: "Overview", group: "Workspace", icon: Icons.Overview },
  { key: "applications", label: "Applications", group: "Workspace", icon: Icons.Applications },
  { key: "borrowers", label: "Borrowers", group: "Workspace", icon: Icons.Users },
  { key: "investors", label: "Investors", group: "Workspace", icon: Icons.Investors },
  { key: "account-requests", label: "Account requests", group: "Workspace", icon: Icons.Pending },
  { key: "kyc", label: "KYC review", group: "Risk & money", icon: Icons.Shield },
  { key: "payouts", label: "Payouts", group: "Risk & money", icon: Icons.MoneyOut },
  { key: "loans", label: "Loans", group: "Risk & money", icon: Icons.Loan },
  { key: "ledger", label: "Ledger", group: "Financials", icon: Icons.Book },
  { key: "withdrawals", label: "Withdrawals", group: "Financials", icon: Icons.Wallet },
  { key: "investor-tools", label: "Investor tools", group: "Financials", icon: Icons.Tools },
  { key: "reconciliation", label: "Reconciliation", group: "Insights", icon: Icons.Chart },
  { key: "audit", label: "Audit log", group: "Insights", icon: Icons.History },
  { key: "managers", label: "Team management", group: "Administration", icon: Icons.UserShield },
  { key: "roles", label: "Roles & permissions", group: "Administration", icon: Icons.RolesShield },
  { key: "settings", label: "Platform settings", group: "Administration", icon: Icons.Settings },
];

const titles: Record<View, string> = {
  overview: "Portfolio overview",
  applications: "Loan applications",
  borrowers: "Borrower management",
  investors: "Investor management",
  "account-requests": "Account change requests",
  kyc: "KYC review",
  payouts: "Payout operations",
  loans: "Loan management",
  ledger: "Admin ledger",
  withdrawals: "Investor withdrawals",
  "investor-tools": "Investor tools",
  reconciliation: "Reconciliation center",
  audit: "Audit log",
  managers: "Team management",
  roles: "Roles & permissions",
  settings: "Platform settings",
  detail: "Application detail",
  "borrower-detail": "Borrower detail",
};

export default function Admin() {
  const [authed, setAuthed] = useState(() => Boolean(getAdminToken()));
  const [role, setRole] = useState<string | null>(() => getAdminRole());
  const [permissions, setPermissions] = useState(() => getAdminPermissions());
  // Persist the current view + selectedId in the URL hash so that a refresh
  // keeps the user on the same page instead of bouncing back to "overview".
  // Hash format: #view=applications or #view=detail&id=VEL-xxxx
  function readHashState(): { view: View; selectedId: string | null } {
    const hash = window.location.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    const v = params.get("view") as View | null;
    const validViews: View[] = ["overview", "applications", "borrowers", "borrower-detail", "investors", "account-requests", "kyc", "payouts", "loans", "detail", "ledger", "withdrawals", "investor-tools", "reconciliation", "audit", "managers", "roles", "settings"];
    const id = params.get("id");
    return {
      view: v && validViews.includes(v) ? v : "overview",
      selectedId: id || null,
    };
  }
  function writeHashState(view: View, selectedId: string | null) {
    const params = new URLSearchParams();
    if (view !== "overview") params.set("view", view);
    if (selectedId) params.set("id", selectedId);
    const hash = params.toString();
    const target = hash ? `#${hash}` : "#";
    if (window.location.hash !== target) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${target}`);
    }
  }
  const initialHash = readHashState();
  const [view, setView] = useState<View>(initialHash.view);
  const [selectedId, setSelectedId] = useState<string | null>(initialHash.selectedId);
  const [selectedBorrower, setSelectedBorrower] = useState<any>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigate = useNavigate();

  // Sync view + selectedId changes back to the URL hash.
  useEffect(() => {
    writeHashState(view, selectedId);
  }, [view, selectedId]);

  // Listen for browser back/forward so the UI follows the hash.
  useEffect(() => {
    function onHashChange() {
      const next = readHashState();
      setView(next.view);
      setSelectedId(next.selectedId);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!authed) return;
    const ms = 5 * 60 * 1000;
    let timer = window.setTimeout(logout, ms);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(logout, ms);
    };
    const onUnauthorized = () => logout();
    const events: Array<keyof WindowEventMap> = [
      "mousemove",
      "mousedown",
      "keydown",
      "touchstart",
      "scroll",
    ];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    window.addEventListener("velo:admin-unauthorized", onUnauthorized);
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
      window.removeEventListener("velo:admin-unauthorized", onUnauthorized);
    };
  }, [authed]);

  function logout() {
    void adminLogout().catch(() => undefined);
    clearAdminToken();
    setAuthed(false);
    setRole(null);
    setPermissions([]);
    setView("overview");
    setSelectedId(null);
  }

  if (!authed)
    return (
      <Layout showHomeLink={false}>
        <AdminLogin
          onLogin={(nextRole) => {
            setRole(nextRole || null);
            setPermissions(getAdminPermissions());
            setAuthed(true);
          }}
        />
      </Layout>
    );

  const groups = [...new Set(menu.map((item) => item.group))];

  const renderSettingsLike = (
    section: "all" | "ledger" | "withdrawals" | "investor-tools"
  ) => {
    return <AdminSettings displaySection={section} />;
  };

  const visibleMenu = menu.filter((item) => {
    if ((item.key === "managers" || item.key === "roles" || item.key === "settings") && role !== "ADMIN") return false;
    return true;
  });

  const adminName = sessionStorage.getItem("velo:admin-email") || "Admin user";

  return (
    <Layout showHomeLink={false}>
      <div className="-mx-4 -mt-6 min-h-[calc(100vh-120px)] bg-slate-50 dark:bg-slate-950 sm:-mx-6">
        {sidebarOpen && (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 z-40 bg-slate-900/60 backdrop-blur-sm lg:hidden animate-fade-in"
          />
        )}
        <div className="flex min-h-[calc(100vh-120px)] flex-col lg:flex-row relative">
          <aside
            className={`fixed lg:static z-50 top-0 left-0 h-full w-80 max-w-[86vw] lg:w-72 shrink-0 lg:h-auto transition-transform duration-300 ease-out lg:transform-none ${
              sidebarOpen ? "translate-x-0" : "-translate-x-full"
            }`}
          >
            <div className="lg:hidden absolute top-4 right-4 z-10">
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                aria-label="Close sidebar"
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-white/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 shadow-sm hover:bg-white dark:hover:bg-slate-800 transition"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <div className="w-full shrink-0 border-b border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-800 lg:min-h-[calc(100vh-120px)] lg:border-b-0 lg:border-r lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto">
              <div className="p-4 sm:p-5 lg:p-6 space-y-5 lg:space-y-6 h-full flex flex-col overflow-y-auto lg:overflow-y-auto max-h-screen lg:max-h-full pb-20 lg:pb-6 pr-1">
                <div className="flex items-center gap-3">
                  <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-600 text-white shadow-md shadow-emerald-500/20">
                    <svg
                      width="22"
                      height="22"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 2L2 7l10 5 10-5-10-5z" />
                      <path d="M2 17l10 5 10-5" />
                      <path d="M2 12l10 5 10-5" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-600 dark:text-emerald-400">
                      {config.companyName}
                    </p>
                    <h1 className="mt-0.5 text-base font-black text-velo-900 dark:text-white truncate">
                      Admin Control
                    </h1>
                  </div>
                </div>

                <nav className="flex-1 space-y-5 sm:space-y-6">
                  {groups.map((group) => {
                    const items = visibleMenu.filter((item) => item.group === group);
                    if (items.length === 0) return null;
                    return (
                      <div key={group}>
                        <p className="px-2 mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400 dark:text-slate-500">
                          {group}
                        </p>
                        <ul className="space-y-1">
                          {items.map((item) => {
                            const active = view === item.key;
                            return (
                              <li key={item.key}>
                                <button
                                  onClick={() => {
                                    setView(item.key);
                                    setSelectedId(null);
                                    setSelectedBorrower(null);
                                    setSidebarOpen(false);
                                  }}
                                  className={`group w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 text-left ${
                                    active
                                      ? "bg-gradient-to-r from-emerald-600 to-emerald-500 text-white shadow-md shadow-emerald-500/20 hover:shadow-lg hover:shadow-emerald-500/25"
                                      : "text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-velo-900 dark:hover:text-white"
                                  }`}
                                >
                                  <span
                                    className={`shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-lg transition-all ${
                                      active
                                        ? "bg-white/15"
                                        : "bg-slate-100 dark:bg-slate-800 group-hover:bg-emerald-50 dark:group-hover:bg-emerald-900/30 text-slate-500 group-hover:text-emerald-600 dark:group-hover:text-emerald-400"
                                    }`}
                                  >
                                    {item.icon}
                                  </span>
                                  <span className="flex-1 min-w-0 text-sm font-semibold truncate">
                                    {item.label}
                                  </span>
                                  {active && (
                                    <svg
                                      width="14"
                                      height="14"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      className="shrink-0 text-white"
                                    >
                                      <path
                                        d="M9 6l6 6-6 6"
                                        stroke="currentColor"
                                        strokeWidth="2.5"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                  )}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </nav>

                <div className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-3">
                  <button
                    onClick={() => navigate("/")}
                    className="group w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-velo-900 dark:hover:text-white transition-all"
                  >
                    <span className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 group-hover:bg-velo-50 dark:group-hover:bg-velo-900/30 text-slate-500 group-hover:text-velo-600 dark:group-hover:text-velo-400">
                      {Icons.External}
                    </span>
                    <span className="flex-1 text-sm font-semibold">View public site</span>
                  </button>

                  <div className="flex items-center gap-3 px-3 py-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800">
                    <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-velo-500 text-white font-black text-sm shadow-sm">
                      {adminName.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-velo-900 dark:text-white truncate">
                        {adminName}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                        {role ?? "Staff"}
                      </div>
                    </div>
                    <button
                      onClick={logout}
                      title="Log out"
                      className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400 transition-all"
                    >
                      {Icons.Logout}
                    </button>
                  </div>

                  <p className="px-3 text-[10px] text-slate-400 dark:text-slate-500 leading-5">
                    Auto sign-out after 5 minutes of idle time.
                  </p>
                </div>
              </div>
            </div>
          </aside>

          <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8 dark:bg-slate-950 space-y-4 sm:space-y-6">
            <div className="lg:hidden flex items-center gap-3 mb-1">
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open navigation"
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-velo-900 dark:text-white shadow-sm hover:shadow transition hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-bold uppercase tracking-[0.15em] text-emerald-600 dark:text-emerald-400">Administration</div>
                <div className="text-base font-black text-velo-900 dark:text-white truncate">
                  {titles[view]}
                </div>
              </div>
            </div>

            <div className="hidden lg:block">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-600 dark:text-emerald-400">
                Administration
              </p>
              <h2 className="mt-1 text-xl sm:text-2xl lg:text-3xl font-black text-velo-900 dark:text-white">
                {titles[view]}
              </h2>
              <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
                Monitor Velo Finance operations and take action from one unified workspace.
              </p>
            </div>

            {view === "applications" && (
              <AdminApplicationsTable
                onSelect={(id) => {
                  setSelectedId(id);
                  setView("detail");
                }}
              />
            )}
            {view === "detail" && selectedId && (
              <AdminDetail
                applicationId={selectedId}
                onBack={() => {
                  setView("applications");
                  setSelectedId(null);
                  setSelectedBorrower(null);
                }}
              />
            )}
            {view === "borrower-detail" && selectedBorrower && (
              <AdminBorrowerDetail
                borrower={selectedBorrower}
                onBack={() => { setView("borrowers"); setSelectedBorrower(null); }}
                onSelectLoan={(id) => { setSelectedId(id); setView("detail"); }}
              />
            )}
            {view === "account-requests" && <AdminAccountRequests />}
            {view === "settings" && renderSettingsLike("all")}
            {view === "ledger" && renderSettingsLike("ledger")}
            {view === "withdrawals" && renderSettingsLike("withdrawals")}
            {view === "investor-tools" && renderSettingsLike("investor-tools")}
            {view === "managers" && <StaffAdmin />}
            {view === "roles" && <RolesPermissions />}
            {view !== "applications" &&
              view !== "detail" &&
              view !== "borrower-detail" &&
              view !== "settings" &&
              view !== "managers" &&
              view !== "roles" &&
              view !== "ledger" &&
              view !== "withdrawals" &&
              view !== "investor-tools" &&
              view !== "account-requests" && (
                <AdminWorkspace
                  section={view as Exclude<AdminSection, "account-requests">}
                  onSelectBorrower={(borrower) => { setSelectedBorrower(borrower); setView("borrower-detail"); }}
                  onSelectLoan={(id) => { setSelectedId(id); setView("detail"); }}
                />
              )}
          </main>
        </div>
      </div>
    </Layout>
  );
}
