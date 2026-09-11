import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { ApplicationProvider } from "./context/ApplicationContext";
import StartApplication from "./pages/StartApplication";
import ResumeApplication from "./pages/ResumeApplication";
import SEO from "./components/SEO";
import { ThemeProvider } from "./context/ThemeContext";
import { AuthProvider, useAuth } from "./context/AuthContext";
import AccountAccess from "./pages/AccountAccess";

const LoanApplication = lazy(() => import("./pages/LoanApplication"));
const Admin = lazy(() => import("./pages/Admin"));
const LoanManagerSetup = lazy(() => import("./pages/LoanManagerSetup"));
const InvestorDashboard = lazy(() => import("./pages/InvestorDashboard"));
const BorrowerDashboard = lazy(() => import("./pages/BorrowerDashboard"));

function PageSkeleton({ label = "Loading Velo…" }: { label?: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center space-y-3">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-velo-600 to-velo-500 shadow-lg shadow-velo-500/25 animate-pulse">
          <svg className="animate-spin h-6 w-6 text-white" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        </div>
        <p className="text-sm font-semibold text-velo-700">{label}</p>
      </div>
    </div>
  );
}

function ProtectedRoute({
  children,
  requiredRole,
}: {
  children: ReactNode;
  requiredRole?: "INVESTOR" | "BORROWER" | "ADMIN";
}) {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!loading && !user) {
      navigate(`/account?mode=login&redirect=${encodeURIComponent(location.pathname)}`, {
        replace: true,
      });
    } else if (!loading && user && requiredRole && !user.roles.includes(requiredRole)) {
      if (user.roles.includes("INVESTOR")) {
        navigate("/investor", { replace: true });
      } else if (user.roles.includes("BORROWER")) {
        navigate("/borrower", { replace: true });
      } else {
        navigate("/", { replace: true });
      }
    }
  }, [user, loading, navigate, requiredRole, location.pathname]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center space-y-3">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-velo-600 to-velo-500 shadow-lg shadow-velo-500/25 animate-pulse">
            <svg className="animate-spin h-6 w-6 text-white" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
          </div>
          <p className="text-sm font-semibold text-velo-700">Loading Velo…</p>
        </div>
      </div>
    );
  }

  if (!user) return null;
  if (requiredRole && !user.roles.includes(requiredRole)) return null;

  return <>{children}</>;
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ApplicationProvider>
          <SEO />
          <Suspense fallback={<PageSkeleton />}>
            <Routes>
              <Route path="/" element={<StartApplication />} />
              <Route
                path="/apply/*"
                element={
                  <ProtectedRoute requiredRole="BORROWER">
                    <LoanApplication />
                  </ProtectedRoute>
                }
              />
              <Route path="/resume" element={<ResumeApplication />} />
              <Route path="/account" element={<AccountAccess />} />
              <Route path="/admin/set-password" element={<LoanManagerSetup />} />
              <Route path="/admin/*" element={<Admin />} />
              <Route
                path="/investor/*"
                element={
                  <ProtectedRoute requiredRole="INVESTOR">
                    <InvestorDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/borrower/*"
                element={
                  <ProtectedRoute requiredRole="BORROWER">
                    <BorrowerDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dashboard"
                element={
                  <AuthProviderRoleRouter />
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </ApplicationProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

function AuthProviderRoleRouter() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate("/account?mode=login", { replace: true });
      return;
    }
    if (user.roles.includes("INVESTOR")) {
      navigate("/investor", { replace: true });
    } else if (user.roles.includes("BORROWER")) {
      navigate("/borrower", { replace: true });
    } else {
      navigate("/", { replace: true });
    }
  }, [user, loading, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center space-y-3">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-velo-600 to-velo-500 shadow-lg shadow-velo-500/25 animate-pulse">
          <svg className="animate-spin h-6 w-6 text-white" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        </div>
        <p className="text-sm font-semibold text-velo-700">Redirecting…</p>
      </div>
    </div>
  );
}
