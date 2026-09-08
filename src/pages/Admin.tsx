import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import AdminLogin from "../components/admin/AdminLogin";
import AdminApplicationsTable from "../components/admin/AdminApplicationsTable";
import AdminDetail from "../components/admin/AdminDetail";
import AdminSettings from "../components/admin/AdminSettings";
import LoanManagerAdmin from "../components/admin/LoanManagerAdmin";
import { config } from "../utils/config";
import { getAdminToken, getAdminRole, clearAdminToken } from "../services/adminApi";

type View="list"|"detail"|"settings"|"managers";
export default function Admin(){const[authed,setAuthed]=useState(()=>Boolean(getAdminToken()));const[role,setRole]=useState<string|null>(()=>getAdminRole());const[view,setView]=useState<View>("list");const[selectedId,setSelectedId]=useState<string|null>(null);const navigate=useNavigate();
 useEffect(()=>{if(!authed)return;const ms=5*60*1000;let timer=window.setTimeout(logout,ms);const reset=()=>{window.clearTimeout(timer);timer=window.setTimeout(logout,ms)};const onUnauthorized=()=>logout();const events:Array<keyof WindowEventMap>=["mousemove","mousedown","keydown","touchstart","scroll"];events.forEach(e=>window.addEventListener(e,reset,{passive:true}));window.addEventListener("velo:admin-unauthorized",onUnauthorized);return()=>{window.clearTimeout(timer);events.forEach(e=>window.removeEventListener(e,reset));window.removeEventListener("velo:admin-unauthorized",onUnauthorized);};},[authed]);
 function logout(){clearAdminToken();setAuthed(false);setRole(null);setView("list");setSelectedId(null);} if(!authed)return <Layout showHomeLink={false}><AdminLogin onLogin={(nextRole)=>{setRole(nextRole||null);setAuthed(true);}}/></Layout>;
 return <Layout showHomeLink={false}><div className="space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-medium uppercase tracking-wider text-velo-600">{config.companyName}</p><h1 className="text-xl sm:text-2xl font-bold text-velo-900">Admin Dashboard</h1><p className="text-sm text-slate-500 mt-1">You will be signed out after 5 minutes of inactivity.</p></div><div className="flex flex-wrap gap-2"><button className="btn-ghost text-xs" onClick={()=>setView("list")}>Applications</button>{role==="ADMIN"&&<><button className="btn-ghost text-xs" onClick={()=>setView("managers")}>Loan Managers</button><button className="btn-ghost text-xs" onClick={()=>setView("settings")}>Loan Settings</button></>}<button className="btn-ghost text-xs" onClick={()=>navigate("/")}>View Site</button><button className="btn-secondary text-xs" onClick={logout}>Log Out</button></div></div>{view==="list"&&<AdminApplicationsTable onSelect={id=>{setSelectedId(id);setView("detail")}}/>}{view==="detail"&&selectedId&&<AdminDetail applicationId={selectedId} onBack={()=>{setView("list");setSelectedId(null)}}/>}{view==="settings"&&<AdminSettings/>}{view==="managers"&&<LoanManagerAdmin/>}</div></Layout>;
}
