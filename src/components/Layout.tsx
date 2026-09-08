import { Link, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import Logo from "./Logo";
import { config } from "../utils/config";
import { useTheme } from "../context/ThemeContext";
import { useAuth } from "../context/AuthContext";

interface LayoutProps {
  children: ReactNode;
  showHomeLink?: boolean;
}

export default function Layout({ children, showHomeLink = true }: LayoutProps) {
  const { theme, toggleTheme } = useTheme();
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate("/");
  }

  function dashboardPath() {
    if (!user) return "/account";
    if (user.roles.includes("INVESTOR")) return "/investor";
    return "/borrower";
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 transition-colors">
      <header className="bg-white border-b border-slate-100 sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-3 sm:px-6 h-14 sm:h-16 flex items-center justify-between">
          <Link to="/" className="flex min-w-0 items-center" aria-label={`${config.companyName} home`}>
            <Logo size={20} className="!h-6 sm:!h-7 md:!h-8 w-auto !max-w-[45vw] sm:!max-w-none" />
          </Link>
          <nav className="flex shrink-0 items-center gap-1 sm:gap-2">
            {showHomeLink && (
              <Link to="/" className="btn-ghost hidden text-sm sm:inline-flex">Home</Link>
            )}
            {user ? (
              <>
                <Link to={dashboardPath()} className="btn-ghost px-3 text-sm sm:px-4">
                  <span className="sm:hidden">Dashboard</span>
                  <span className="hidden sm:inline">Dashboard</span>
                </Link>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="btn-ghost px-3 text-sm sm:px-4"
                >
                  <span className="sm:hidden">Logout</span>
                  <span className="hidden sm:inline">Sign out</span>
                </button>
              </>
            ) : (
              <>
                <Link to="/account?mode=login" className="btn-ghost px-3 text-sm sm:px-4">
                  <span className="sm:hidden">Login</span>
                  <span className="hidden sm:inline">Sign in</span>
                </Link>
                <Link
                  to="/account?mode=register"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-velo-600 to-velo-500 text-white text-sm font-semibold shadow-sm shadow-velo-500/20 hover:shadow-md hover:shadow-velo-500/30 hover:scale-[1.02] active:scale-[0.98] transition-all"
                >
                  <span className="sm:hidden">Join</span>
                  <span className="hidden sm:inline">Get started</span>
                </Link>
              </>
            )}
            <button
              type="button"
              onClick={toggleTheme}
              className="btn-ghost h-9 w-9 px-0"
              aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
              title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            >
              {theme === "light" ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
                  <path
                    d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M20.5 15.5A8.5 8.5 0 018.5 3.5a8.5 8.5 0 1012 12z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          </nav>
        </div>
      </header>

      <main className="flex-1 w-full">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-10">{children}</div>
      </main>

      <footer className="bg-white border-t border-slate-100">
        <div className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-[11px] sm:text-xs text-slate-500">
          <div className="flex items-center gap-2 min-w-0 w-full sm:w-auto">
            <Logo size={16} className="!h-4 sm:!h-5 w-auto !max-w-[35vw] sm:!max-w-none shrink-0" />
            <span className="truncate">
              © {new Date().getFullYear()} {config.companyName}. All rights reserved.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 w-full sm:w-auto justify-start sm:justify-end">
            <span>{config.companyWebsite}</span>
            <span className="hidden sm:inline">•</span>
            <span className="hidden sm:inline">Loans are subject to credit assessment.</span>
            <Link to="/admin" className="text-slate-400 hover:text-velo-600 transition">
              Admin
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
