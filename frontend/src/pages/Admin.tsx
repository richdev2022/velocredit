import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import AdminLogin from "../components/admin/AdminLogin";
import AdminApplicationsTable from "../components/admin/AdminApplicationsTable";
import AdminDetail from "../components/admin/AdminDetail";
import AdminSettings from "../components/admin/AdminSettings";
import LoanManagerAdmin from "../components/admin/LoanManagerAdmin";
import AdminWorkspace, { type AdminSection } from "../components/admin/AdminWorkspace";
import AdminAccounts from "../components/admin/AdminAccounts";
import { config } from "../utils/config";
import { getAdminToken, getAdminRole, getAdminPermissions, clearAdminToken, adminLogout } from "../services/adminApi";

type View = AdminSection | "applications" | "detail" | "settings" | "managers" | "ledger" | "withdrawals" | "investor-tools";
const menu: Array<{ key: View; label: string; group: string }> = [
 { key: "overview", label: "Overview", group: "Workspace" },
 { key: "applications", label: "Applications", group: "Workspace" },
 { key: "borrowers", label: "Borrowers", group: "Workspace" },
 { key: "investors", label: "Investors", group: "Workspace" },
 { key: "kyc", label: "KYC review", group: "Risk & money" },
 { key: "payouts", label: "Payouts", group: "Risk & money" },
 { key: "loans", label: "Loans", group: "Risk & money" },
 { key: "ledger", label: "Ledger", group: "Financials" },
 { key: "withdrawals", label: "Withdrawals", group: "Financials" },
 { key: "investor-tools", label: "Investor tools", group: "Financials" },
 { key: "reconciliation", label: "Reconciliation", group: "Insights" },
 { key: "audit", label: "Audit log", group: "Insights" },
 { key: "managers", label: "Admin & managers", group: "Administration" },
 { key: "settings", label: "Platform settings", group: "Administration" },
];
const titles: Record<View, string> = { overview: "Portfolio overview", applications: "Loan applications", borrowers: "Borrower management", investors: "Investor management", kyc: "KYC review", payouts: "Payout operations", loans: "Loan management", ledger: "Admin ledger", withdrawals: "Investor withdrawals", "investor-tools": "Investor tools", reconciliation: "Reconciliation center", audit: "Audit log", managers: "Admin & managers", settings: "Platform settings", detail: "Application detail" };
export default function Admin(){const[authed,setAuthed]=useState(()=>Boolean(getAdminToken()));const[role,setRole]=useState<string|null>(()=>getAdminRole());const[permissions,setPermissions]=useState(()=>getAdminPermissions());const[view,setView]=useState<View>("overview");const[selectedId,setSelectedId]=useState<string|null>(null);const navigate=useNavigate();
 useEffect(()=>{if(!authed)return;const ms=5*60*1000;let timer=window.setTimeout(logout,ms);const reset=()=>{window.clearTimeout(timer);timer=window.setTimeout(logout,ms)};const onUnauthorized=()=>logout();const events:Array<keyof WindowEventMap>=["mousemove","mousedown","keydown","touchstart","scroll"];events.forEach(e=>window.addEventListener(e,reset,{passive:true}));window.addEventListener("velo:admin-unauthorized",onUnauthorized);return()=>{window.clearTimeout(timer);events.forEach(e=>window.removeEventListener(e,reset));window.removeEventListener("velo:admin-unauthorized",onUnauthorized);};},[authed]);
 function logout(){void adminLogout().catch(() => undefined); clearAdminToken();setAuthed(false);setRole(null);setPermissions([]);setView("overview");setSelectedId(null);} if(!authed)return <Layout showHomeLink={false}><AdminLogin onLogin={(nextRole)=>{setRole(nextRole||null);setPermissions(getAdminPermissions());setAuthed(true);}}/></Layout>;
 const groups = [...new Set(menu.map((item) => item.group))];
 const renderSettingsLike = (section: "all"|"ledger"|"withdrawals"|"investor-tools") => {
   return <AdminSettings displaySection={section} />;
 };
 return <Layout showHomeLink={false}><div className="-mx-4 -mt-6 min-h-[calc(100vh-120px)] bg-slate-50 dark:bg-slate-950 sm:-mx-6"><div className="flex min-h-[calc(100vh-120px)] flex-col lg:flex-row"><aside className="w-full shrink-0 border-b border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-800 p-4 lg:min-h-[calc(100vh-120px)] lg:w-64 lg:border-b-0 lg:border-r lg:p-5"><div className="mb-6 flex items-center justify-between lg:block"><div><p className="text-[11px] font-semibold uppercase tracking-wider text-velo-600 dark:text-velo-400">{config.companyName}</p><h1 className="mt-1 text-lg font-bold text-velo-900 dark:text-white">Control centre</h1></div><button className="btn-secondary text-xs lg:mt-5" onClick={logout}>Log out</button></div><nav className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:block">{groups.map((group) => <div key={group} className="contents lg:block"><p className="col-span-full mt-4 hidden px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 first:mt-0 lg:block">{group}</p>{menu.filter((item) => item.group === group && (item.key !== "managers" && item.key !== "settings" || role === "ADMIN")).map((item) => <button key={item.key} className={`mb-1 w-full rounded-lg px-3 py-2 text-left text-sm font-medium transition ${view === item.key ? "bg-velo-50 text-velo-700 dark:bg-velo-900/40 dark:text-velo-300" : "text-slate-600 hover:bg-slate-50 hover:text-velo-700 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"}`} onClick={() => setView(item.key)}>{item.label}</button>)}</div>)}</nav><div className="mt-6 hidden border-t border-slate-100 dark:border-slate-800 pt-4 lg:block"><button className="btn-ghost w-full text-left text-xs" onClick={() => navigate("/")}>View public site</button><p className="mt-3 px-3 text-[11px] text-slate-400 dark:text-slate-500">Auto sign-out after 5 minutes idle.</p></div></aside><main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8 dark:bg-slate-950"><div className="mb-6"><p className="text-xs font-medium uppercase tracking-wider text-velo-600 dark:text-velo-400">Administration</p><h2 className="mt-1 text-2xl font-bold text-velo-900 dark:text-white">{titles[view]}</h2><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Monitor Velo Finance and take action from one place.</p></div>{view === "applications" && <AdminApplicationsTable onSelect={id=>{setSelectedId(id);setView("detail")}}/>}{view === "detail" && selectedId && <AdminDetail applicationId={selectedId} onBack={()=>{setView("applications");setSelectedId(null)}}/>}{view === "settings" && renderSettingsLike("all")}{view === "ledger" && renderSettingsLike("ledger")}{view === "withdrawals" && renderSettingsLike("withdrawals")}{view === "investor-tools" && renderSettingsLike("investor-tools")}{view === "managers" && <div className="space-y-6"><AdminAccounts/><LoanManagerAdmin/></div>}{view !== "applications" && view !== "detail" && view !== "settings" && view !== "managers" && view !== "ledger" && view !== "withdrawals" && view !== "investor-tools" && <AdminWorkspace section={view}/>}</main></div></div></Layout>;
}
