import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import Layout from "../components/Layout";
import PasswordInput from "../components/PasswordInput";
import { useAuth } from "../context/AuthContext";
import { isValidEmail } from "../utils/validation";
import { loginStepUpResendOtp, resendRegistrationOtp, type OtpChannel, type RegistrationVerification, type LoginOtpRequired, type LoginStepUpRequired, ApiError } from "../services/apiClient";
import { config } from "../utils/config";
import Icon from "../components/Icon";

type Mode = "login" | "register" | "forgot";

export default function AccountAccess() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { login, register, verifyRegistrationOtp, completeLoginOtp, requestPasswordReset, confirmPasswordReset, user, loading } = useAuth();

  const initialMode = searchParams.get("mode") === "register" ? "register" : searchParams.get("mode") === "forgot" ? "forgot" : "login";
  const initialRole = (searchParams.get("role") === "INVESTOR" ? "INVESTOR" : "BORROWER") as "INVESTOR" | "BORROWER";
  const initialType = (searchParams.get("type") === "BUSINESS" ? "BUSINESS" : "PERSONAL") as "PERSONAL" | "BUSINESS";

  const [mode, setMode] = useState<Mode>(initialMode);
  const [role, setRole] = useState<"INVESTOR" | "BORROWER">(initialRole);
  const [loanType, setLoanType] = useState<"PERSONAL" | "BUSINESS">(initialType);

  // Dashboard picker — shown right after login when the account holds BOTH
  // borrower and investor roles, letting the user choose where to land.
  const [showDashboardPicker, setShowDashboardPicker] = useState(false);
  const pickerOpenRef = useRef(false);
  // The picker must only appear for a login that happened ON THIS PAGE — not
  // when a session is silently restored on mount, and not when an already
  // signed-in user revisits /account.
  const userAtMountRef = useRef(user);
  const everLoadingRef = useRef(false);

  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [resetId, setResetId] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [preferredOtpChannel, setPreferredOtpChannel] = useState<OtpChannel>("EMAIL");
  const [signupVerification, setSignupVerification] = useState<RegistrationVerification | null>(null);
  const [loginOtpUser, setLoginOtpUser] = useState<LoginOtpRequired | null>(null);
  const [loginStepUp, setLoginStepUp] = useState<LoginStepUpRequired | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const [otpRemaining, setOtpRemaining] = useState(0);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  // Maintenance mode: when the backend blocks a sign-in with code
  // MAINTENANCE_MODE, show the beautiful maintenance modal instead of a
  // plain error line.
  const [maintenanceNotice, setMaintenanceNotice] = useState<string | null>(null);

  // If maintenance is already ON, show the modal before the user even tries.
  useEffect(() => {
    let cancelled = false;
    fetch(`${config.apiUrl}/api/v1/platform/status`)
      .then((response) => response.json())
      .then((body: { maintenanceMode?: boolean; maintenanceMessage?: string }) => {
        if (!cancelled && body.maintenanceMode) setMaintenanceNotice(body.maintenanceMessage || "Velo is currently undergoing scheduled maintenance.");
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const verification = signupVerification ?? loginStepUp;
    if (!verification) return;
    const updateCountdown = () => {
      setOtpRemaining(Math.max(0, Math.ceil((new Date(verification.resendAvailableAt).getTime() - Date.now()) / 1000)));
    };
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 1000);
    return () => window.clearInterval(timer);
  }, [signupVerification, loginStepUp]);

  useEffect(() => {
    if (loading) {
      everLoadingRef.current = true;
      return;
    }
    if (!user) return;
    if (pickerOpenRef.current) return;
    // A ?redirect= target (e.g. /apply) always wins — the user was mid-flow.
    const redirect = searchParams.get("redirect");
    const singleDashboard = user.roles.includes("INVESTOR") ? "/investor" : "/borrower";
    if (redirect && redirect.startsWith("/") && !redirect.startsWith("//")) {
      navigate(redirect, { replace: true });
      return;
    }
    // Already signed in when this page rendered, or session restored from a
    // persisted token — go straight to the dashboard, no picker.
    if (userAtMountRef.current || everLoadingRef.current) {
      navigate(singleDashboard, { replace: true });
      return;
    }
    // Both roles → let the user choose their preferred dashboard. They can
    // always switch between borrower and investor later from the header.
    if (user.roles.includes("INVESTOR") && user.roles.includes("BORROWER")) {
      pickerOpenRef.current = true;
      setShowDashboardPicker(true);
      return;
    }
    navigate(singleDashboard, { replace: true });
  }, [user, loading, navigate, searchParams]);

  function enterDashboard(target: "investor" | "borrower") {
    pickerOpenRef.current = false;
    setShowDashboardPicker(false);
    navigate(target === "investor" ? "/investor" : "/borrower", { replace: true });
  }

  // Header "Sign in" links carry #signin (register: #register) — glide the
  // auth form into view automatically instead of leaving the user at the top
  // of the marketing panel.
  useEffect(() => {
    if (location.hash !== "#signin" && location.hash !== "#register") return;
    const target = document.getElementById("auth-panel");
    if (!target) return;
    const t = window.setTimeout(() => {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    return () => window.clearTimeout(t);
  }, [location.hash]);

  const passwordMatch = useMemo(
    () => !confirmPassword || password === confirmPassword,
    [password, confirmPassword]
  );

  const passwordStrong = useMemo(() => {
    if (!password) return true;
    return password.length >= 8 && /[A-Z]/.test(password) && /[0-9]/.test(password);
  }, [password]);

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    setSuccess("");
    setLoginOtpUser(null);
    setLoginStepUp(null);
    setSignupVerification(null);
    setOtpCode("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    const normalizedEmail = email.trim().toLowerCase();
    const emailRequired = mode === "login" || mode === "register" || (mode === "forgot" && !(resetId && resetToken));
    if (emailRequired && !isValidEmail(normalizedEmail)) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);

    try {
      if (mode === "login") {
        if (signupVerification) {
          // setUser inside AuthContext drives the post-login routing effect
          // (redirect → dashboard picker → single dashboard).
          await verifyRegistrationOtp({ userId: signupVerification.userId, challengeId: signupVerification.challengeId, code: otpCode });
          return;
        }
        if (loginStepUp) {
          await completeLoginOtp(loginStepUp.challengeId, otpCode);
          return;
        }
        const result = await login(normalizedEmail, password);
        if ("requiresOtp" in result && result.requiresOtp) {
          if (result.ok) {
            setLoginStepUp(result);
            setOtpRemaining(result.resendSecondsRemaining);
            setSuccess("Enter the 6-digit code sent through your preferred channel.");
          } else {
            setLoginOtpUser(result);
            setSuccess(result.error || "Your account needs verification. Choose how we send your one-time code.");
          }
          setError("");
          return;
        }
        // Post-login navigation (incl. the dashboard picker for dual-role
        // accounts) is handled by the user-routing effect above — `login()`
        // already stored the session via setUser in AuthContext.
      } else if (mode === "register") {
        if (signupVerification) {
          await verifyRegistrationOtp({ userId: signupVerification.userId, challengeId: signupVerification.challengeId, code: otpCode });
          return;
        }
        if (!passwordMatch) {
          throw new Error("Passwords do not match");
        }
        if (!passwordStrong) {
          throw new Error("Password must be 8+ chars with uppercase and a number");
        }
        const registration = await register({ email: normalizedEmail, phone, fullName, password, role, preferredOtpChannel });
        setSignupVerification(registration.verification);
        setOtpRemaining(registration.verification.resendSecondsRemaining);
        setSuccess(registration.message);
      } else if (mode === "forgot") {
        if (resetId && resetToken) {
          await confirmPasswordReset(resetId, resetToken, newPassword);
          setSuccess("Password reset successful! You can now log in.");
          setTimeout(() => switchMode("login"), 1500);
        } else {
          const result = await requestPasswordReset(normalizedEmail);
          setSuccess(result.message);
          if (result.resetId) {
            setResetId(result.resetId);
          }
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "MAINTENANCE_MODE") {
        setMaintenanceNotice(err.message);
        setError("");
      } else {
        setError(err instanceof Error ? err.message : "Unable to continue");
      }
    } finally {
      setBusy(false);
    }
  }

  async function resendSignupOtp() {
    if ((!signupVerification && !loginStepUp) || otpRemaining > 0) return;
    setBusy(true);
    setError("");
    try {
      const next = loginStepUp
        ? await loginStepUpResendOtp({ userId: loginStepUp.user.id, challengeId: loginStepUp.challengeId })
        : await resendRegistrationOtp(signupVerification!.userId);
      if (loginStepUp) setLoginStepUp({ ...loginStepUp, ...next });
      else setSignupVerification(next);
      setOtpRemaining(next.resendSecondsRemaining);
      setSuccess(`A new OTP was sent via ${next.channel.toLowerCase()}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to resend OTP");
    } finally {
      setBusy(false);
    }
  }

  async function chooseLoginOtpChannel(channel: OtpChannel) {
    if (!loginOtpUser) return;
    setBusy(true);
    setError("");
    try {
      const next = await resendRegistrationOtp(loginOtpUser.userId, channel);
      setSignupVerification(next);
      setOtpRemaining(next.resendSecondsRemaining);
      setSuccess(`We've sent a 6-digit code to you via ${channel.toLowerCase()}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to send OTP. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout>
      <div className="max-w-6xl mx-auto -mx-4 sm:mx-auto px-4 sm:px-6 -mt-6 sm:-mt-10 mb-10">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 lg:gap-8 items-stretch min-h-[calc(100vh-220px)]">
          {/* LEFT: Visual Panel */}
          <div className="lg:col-span-3 relative overflow-hidden rounded-3xl bg-gradient-to-br from-velo-900 via-velo-800 to-velo-700 dark:bg-velo-900 dark:from-velo-900 dark:via-velo-900 dark:to-velo-900 dark:animate-none p-8 sm:p-10 lg:p-12 text-white shadow-2xl">
            <div className="absolute inset-0 opacity-20 dark:opacity-10">
              <div className="absolute -top-20 -right-20 w-80 h-80 bg-velo-300 dark:bg-velo-700 rounded-full blur-3xl translate-x-1/4 animate-float" />
              <div className="absolute bottom-0 left-0 w-96 h-96 bg-emerald-400 dark:bg-emerald-800 rounded-full blur-3xl -translate-x-1/4 translate-y-1/4 animate-float-slow opacity-60 dark:opacity-20" />
              <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
            </div>

            <div className="relative z-10 flex flex-col h-full">
              {/* Brand header */}
              <div className="mb-8 sm:mb-10 animate-fade-in-down">
                <Link to="/" className="inline-flex items-center gap-2 text-white/70 hover:text-white text-sm font-medium transition-colors group">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="group-hover:-translate-x-0.5 transition-transform"><path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Back to home
                </Link>
              </div>

              {/* Hero content */}
              <div className="flex-1 flex flex-col justify-center space-y-6 sm:space-y-8 animate-fade-in-up">
                {mode === "register" && role === "INVESTOR" ? (
                  <>
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-gradient-to-r from-emerald-400/20 to-emerald-300/20 border border-emerald-300/30 text-emerald-200 text-xs font-semibold w-fit animate-pulse-glow">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      INVESTOR ONBOARDING
                    </div>
                    <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold leading-tight">
                      Grow your wealth
                      <br />
                      <span className="bg-gradient-to-r from-emerald-300 via-white to-emerald-200 bg-clip-text text-transparent">
                        with confidence.
                      </span>
                    </h1>
                    <p className="text-base sm:text-lg text-white/70 leading-relaxed max-w-md">
                      Join thousands of smart investors earning up to <strong className="text-emerald-300">18% annual returns</strong> on vetted, secured loans with KYC-verified borrowers.
                    </p>

                    <div className="grid grid-cols-2 gap-3 sm:gap-4 max-w-md">
                      {[
                        { label: "Max Returns", value: "18% p.a.", icon: <Icon name="chart" size={20} /> },
                        { label: "Flexible Tenor", value: "30–180 days", icon: <Icon name="clock" size={20} /> },
                        { label: "Auto-Payout", value: "Direct to bank", icon: <Icon name="bank" size={20} /> },
                        { label: "Early Exit", value: "Available", icon: <Icon name="wind" size={20} /> },
                      ].map((s, i) => (
                        <div
                          key={i}
                          className="rounded-2xl bg-white/5 backdrop-blur-sm border border-white/10 p-3 sm:p-4 hover:bg-white/10 hover:border-white/20 transition-all"
                          style={{ animationDelay: `${i * 80}ms` }}
                        >
                          <div className="mb-1 text-emerald-300">{s.icon}</div>
                          <div className="text-lg sm:text-xl font-bold text-white">{s.value}</div>
                          <div className="text-[11px] sm:text-xs text-white/60 font-medium">{s.label}</div>
                        </div>
                      ))}
                    </div>

                    <div className="space-y-2.5 max-w-md">
                      {[
                        "Fund verified loans with collateral backing",
                        "Track every investment in real-time dashboard",
                        "Same KYC works for investing and borrowing",
                      ].map((t, i) => (
                        <div key={i} className="flex items-center gap-2.5 text-sm text-white/80">
                          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-emerald-500/20 text-emerald-300">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          </span>
                          {t}
                        </div>
                      ))}
                    </div>
                  </>
                ) : mode === "register" && role === "BORROWER" ? (
                  <>
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-gradient-to-r from-velo-400/20 to-velo-300/20 border border-velo-300/30 text-velo-200 text-xs font-semibold w-fit animate-pulse-glow">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      BORROWER ONBOARDING
                    </div>
                    <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold leading-tight">
                      Funding for your
                      <br />
                      <span className="bg-gradient-to-r from-velo-300 via-white to-velo-200 bg-clip-text text-transparent">
                        next important move.
                      </span>
                    </h1>
                    <p className="text-base sm:text-lg text-white/70 leading-relaxed max-w-md">
                      {loanType === "PERSONAL"
                        ? "Personal loans for emergencies, projects, and life events — with transparent terms and no hidden fees."
                        : "Business loans to stock inventory, expand operations, or bridge cash flow gaps. Fast approval for SMEs."}
                    </p>

                    <div className="flex gap-3 flex-wrap">
                      <button
                        type="button"
                        onClick={() => setLoanType("PERSONAL")}
                        className={`px-4 py-3 rounded-2xl text-sm font-semibold transition-all flex items-center gap-2 border-2 ${
                          loanType === "PERSONAL"
                            ? "bg-white text-velo-800 border-white shadow-lg scale-[1.02]"
                            : "bg-white/5 text-white/70 border-white/10 hover:bg-white/10 hover:text-white"
                        }`}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><circle cx="12" cy="7" r="4" stroke="currentColor" strokeWidth="2"/></svg>
                        Personal Loan
                      </button>
                      <button
                        type="button"
                        onClick={() => setLoanType("BUSINESS")}
                        className={`px-4 py-3 rounded-2xl text-sm font-semibold transition-all flex items-center gap-2 border-2 ${
                          loanType === "BUSINESS"
                            ? "bg-white text-velo-800 border-white shadow-lg scale-[1.02]"
                            : "bg-white/5 text-white/70 border-white/10 hover:bg-white/10 hover:text-white"
                        }`}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 21h18M5 21V10M19 21V10M3 10l9-6 9 6M9 21v-5h6v5" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>
                        Business Loan
                      </button>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-lg">
                      {[
                        { value: "30m", label: "Avg. approval", icon: <Icon name="lightning" size={18} /> },
                        { value: "180d", label: "Max. tenor", icon: <Icon name="calendar" size={18} /> },
                        { value: "₦5M", label: "Max. loan", icon: <Icon name="money" size={18} /> },
                        { value: "0%", label: "Hidden fees", icon: <Icon name="sparkles" size={18} /> },
                      ].map((s, i) => (
                        <div
                          key={i}
                          className="rounded-2xl bg-white/5 backdrop-blur-sm border border-white/10 p-3 text-center hover:bg-white/10 hover:border-white/20 transition-all animate-bounce-subtle"
                          style={{ animationDelay: `${i * 120}ms` }}
                        >
                          <div className="mb-0.5 text-velo-200">{s.icon}</div>
                          <div className="text-base sm:text-lg font-bold text-white">{s.value}</div>
                          <div className="text-[10px] sm:text-[11px] text-white/60 font-medium">{s.label}</div>
                        </div>
                      ))}
                    </div>

                    <div className="rounded-2xl bg-emerald-500/10 border border-emerald-400/20 p-4 max-w-md">
                      <div className="flex items-start gap-3">
                        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-300 mt-0.5">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </span>
                        <div>
                          <div className="text-sm font-semibold text-emerald-200 mb-0.5">Trusted by 50,000+ Nigerians</div>
                          <div className="text-xs text-white/60">CBN regulated • NDIC insured • NDPR compliant</div>
                        </div>
                      </div>
                    </div>
                  </>
                ) : mode === "forgot" ? (
                  <>
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-gradient-to-r from-amber-400/20 to-amber-300/20 border border-amber-300/30 text-amber-200 text-xs font-semibold w-fit">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      PASSWORD RECOVERY
                    </div>
                    <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold leading-tight">
                      Can't log in?
                      <br />
                      <span className="bg-gradient-to-r from-velo-300 via-white to-velo-200 bg-clip-text text-transparent">
                        We'll help you.
                      </span>
                    </h1>
                    <p className="text-base sm:text-lg text-white/70 leading-relaxed max-w-md">
                      Enter your registered email and we'll send you a secure reset link. Your account safety is our top priority.
                    </p>

                    <div className="rounded-2xl bg-white/5 backdrop-blur-sm border border-white/10 p-5 max-w-md space-y-3">
                      {[
                        { t: "Check your email inbox (and spam folder) for reset instructions", n: 1 },
                        { t: "Use the reset code within 30 minutes of receiving it", n: 2 },
                        { t: "Create a strong, unique password you don't use elsewhere", n: 3 },
                      ].map((s) => (
                        <div key={s.n} className="flex items-start gap-3 text-sm text-white/80">
                          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-velo-500/30 text-velo-200 text-xs font-bold">
                            {s.n}
                          </span>
                          {s.t}
                        </div>
                      ))}
                    </div>

                    <div className="flex items-center gap-3 text-sm text-white/60">
                      <div className="flex -space-x-2">
                        {["#2196F3","#1E86DB","#1866A8","#123F6B"].map((c, i) => (
                          <div key={i} className="h-8 w-8 rounded-full border-2 border-velo-900 flex items-center justify-center text-white text-xs font-semibold shadow-sm" style={{ backgroundColor: c }}>
                            {["A","O","C","M"][i]}
                          </div>
                        ))}
                      </div>
                      Join 50,000+ customers who trust Velo with their finances.
                    </div>
                  </>
                ) : (
                  <>
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-gradient-to-r from-white/10 to-white/5 border border-white/15 text-white/80 text-xs font-semibold w-fit">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      WELCOME BACK
                    </div>
                    <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold leading-tight">
                      Good to see you
                      <br />
                      <span className="bg-gradient-to-r from-velo-300 via-white to-emerald-200 bg-clip-text text-transparent">
                        again.
                      </span>
                    </h1>
                    <p className="text-base sm:text-lg text-white/70 leading-relaxed max-w-md">
                      Sign in to access your dashboard — track loans, manage investments, view transactions, and pick up right where you left off.
                    </p>

                    <div className="grid grid-cols-2 gap-3 sm:gap-4 max-w-md">
                      <div className="rounded-2xl bg-gradient-to-br from-velo-500/20 to-velo-400/10 backdrop-blur-sm border border-velo-400/20 p-4 hover:scale-[1.02] transition-transform animate-float">
                        <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-velo-500/30 text-velo-200 mb-2">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 3v18h18M7 14l4-4 4 4 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </div>
                        <div className="text-sm font-bold text-white mb-0.5">Investor</div>
                        <div className="text-[11px] text-white/60">Portfolio & earnings</div>
                      </div>
                      <div className="rounded-2xl bg-gradient-to-br from-emerald-500/20 to-emerald-400/10 backdrop-blur-sm border border-emerald-400/20 p-4 hover:scale-[1.02] transition-transform animate-float-slow">
                        <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/30 text-emerald-200 mb-2">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </div>
                        <div className="text-sm font-bold text-white mb-0.5">Borrower</div>
                        <div className="text-[11px] text-white/60">Loans & repayments</div>
                      </div>
                    </div>

                    <div className="rounded-2xl bg-white/5 backdrop-blur-sm border border-white/10 p-4 max-w-md">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-0.5">
                          {[0,1,2,3,4].map((i) => (
                            <svg key={i} width="16" height="16" viewBox="0 0 24 24" fill="#fbbf24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                          ))}
                        </div>
                        <span className="text-sm font-bold text-white">4.9/5 Rating</span>
                      </div>
                      <p className="text-sm text-white/75 italic">
                        "Velo's platform made investing simple. I can see exactly where my money goes and the returns hit my account automatically."
                      </p>
                      <div className="mt-3 flex items-center gap-2">
                        <div className="h-7 w-7 rounded-full bg-gradient-to-br from-velo-400 to-velo-600 flex items-center justify-center text-white text-xs font-bold">AO</div>
                        <div>
                          <div className="text-xs font-semibold text-white">Amaka Okafor</div>
                          <div className="text-[10px] text-white/50">Investor • Lagos</div>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Bottom trust */}
              <div className="mt-8 pt-6 border-t border-white/10 flex flex-wrap items-center gap-3 sm:gap-4 text-xs text-white/50 animate-fade-in-up" style={{ animationDelay: "300ms" }}>
                <div className="flex items-center gap-1.5">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  NDPR Compliant
                </div>
                <span className="hidden sm:inline h-1 w-1 rounded-full bg-white/20" />
                <div className="flex items-center gap-1.5">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  CBN Regulated
                </div>
                <span className="hidden sm:inline h-1 w-1 rounded-full bg-white/20" />
                <div className="flex items-center gap-1.5">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  NDIC Insured
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT: Form Panel */}
          <div id="auth-panel" className="lg:col-span-2 flex items-center animate-fade-in-right scroll-mt-24">
            <div className="w-full max-w-md mx-auto lg:mx-0 space-y-5">
              {/* Top mode toggle (login/register) — hidden during forgot */}
              {mode !== "forgot" && (
                <div className="relative p-1.5 rounded-2xl bg-slate-100 dark:bg-slate-800 grid grid-cols-2">
                  <div
                    className={`absolute top-1.5 bottom-1.5 w-[calc(50%-6px)] rounded-xl bg-white dark:bg-slate-700 shadow-sm transition-transform duration-300 ease-out ${
                      mode === "login" ? "translate-x-0" : "translate-x-[calc(100%+6px)]"
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => switchMode("login")}
                    className={`relative z-10 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                      mode === "login" ? "text-velo-700 dark:text-velo-300" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                    }`}
                  >
                    Sign in
                  </button>
                  <button
                    type="button"
                    onClick={() => switchMode("register")}
                    className={`relative z-10 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                      mode === "register" ? "text-velo-700 dark:text-velo-300" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                    }`}
                  >
                    Create account
                  </button>
                </div>
              )}

              <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-xl shadow-slate-200/50 dark:shadow-slate-950/50 border border-slate-100 dark:border-slate-800 p-6 sm:p-7 overflow-hidden relative">
                {/* Decorative */}
                <div className="absolute -top-12 -right-12 w-36 h-36 rounded-full bg-gradient-to-br from-velo-100 to-emerald-50 dark:from-velo-900/30 dark:to-emerald-900/10 blur-2xl opacity-70" />

                <div className="relative">
                  <div className="mb-6">
                    <h2 className="text-2xl font-bold text-velo-900 dark:text-white">
                      {mode === "login" ? "Welcome back" : mode === "forgot" ? "Reset password" : "Create your account"}
                    </h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                      {mode === "login"
                        ? "Enter your credentials to access your dashboard."
                        : mode === "forgot"
                        ? resetId && resetToken
                          ? "Enter your new password below."
                          : "We'll email you a secure reset link."
                        : "One account — borrow, invest, and bank with Velo."}
                    </p>
                  </div>

                  {/* Register: Role selector */}
                  {mode === "register" && !signupVerification && (
                    <div className="mb-5">
                      <label className="velo-label mb-2 block">I want to…</label>
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="button"
                          onClick={() => setRole("BORROWER")}
                          className={`relative p-3.5 rounded-2xl border-2 text-left transition-all duration-200 ${
                            role === "BORROWER"
                              ? "border-velo-500 bg-velo-50 dark:bg-velo-900/30 ring-2 ring-velo-100 dark:ring-velo-800"
                              : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-velo-300 dark:hover:border-velo-600"
                          }`}
                        >
                          {role === "BORROWER" && (
                            <div className="absolute top-2 right-2 h-5 w-5 rounded-full bg-velo-500 text-white flex items-center justify-center animate-bounce-subtle">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            </div>
                          )}
                          <div className={`inline-flex h-8 w-8 items-center justify-center rounded-lg mb-2 ${role === "BORROWER" ? "bg-velo-500 text-white" : "bg-slate-100 dark:bg-slate-700 text-slate-500"}`}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          </div>
                          <div className={`text-sm font-bold ${role === "BORROWER" ? "text-velo-800 dark:text-velo-200" : "text-slate-700 dark:text-slate-300"}`}>Borrow</div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Personal & business loans</div>
                        </button>
                        <button
                          type="button"
                          onClick={() => setRole("INVESTOR")}
                          className={`relative p-3.5 rounded-2xl border-2 text-left transition-all duration-200 ${
                            role === "INVESTOR"
                              ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-900/30 ring-2 ring-emerald-100 dark:ring-emerald-800"
                              : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-emerald-300 dark:hover:border-emerald-600"
                          }`}
                        >
                          {role === "INVESTOR" && (
                            <div className="absolute top-2 right-2 h-5 w-5 rounded-full bg-emerald-500 text-white flex items-center justify-center animate-bounce-subtle">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            </div>
                          )}
                          <div className={`inline-flex h-8 w-8 items-center justify-center rounded-lg mb-2 ${role === "INVESTOR" ? "bg-emerald-500 text-white" : "bg-slate-100 dark:bg-slate-700 text-slate-500"}`}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 3v18h18M7 14l4-4 4 4 5-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          </div>
                          <div className={`text-sm font-bold ${role === "INVESTOR" ? "text-emerald-800 dark:text-emerald-200" : "text-slate-700 dark:text-slate-300"}`}>Invest</div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Earn up to 18% p.a.</div>
                        </button>
                      </div>
                    </div>
                  )}

                  <form onSubmit={submit} className="space-y-4">
                    {mode === "register" && !signupVerification && (
                      <>
                        <label className="block">
                          <span className="velo-label">Full name</span>
                          <input
                            className="velo-input"
                            value={fullName}
                            onChange={(e) => setFullName(e.target.value)}
                            placeholder="e.g. Chidera Okafor"
                            required
                          />
                        </label>
                        <label className="block">
                          <span className="velo-label">Nigerian phone number</span>
                          <input
                            className="velo-input"
                            type="tel"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            placeholder="0803 000 0000"
                            required
                          />
                        </label>
                      </>
                    )}

                    {(mode === "login" || (mode === "register" && !signupVerification) || mode === "forgot") && !(mode === "forgot" && resetId && resetToken) && (
                      <label className="block">
                        <span className="velo-label">Email address</span>
                        <input
                          className="velo-input"
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="you@example.com"
                          required
                        />
                      </label>
                    )}

                    {mode === "forgot" && resetId && resetToken && (
                      <>
                        <label className="block">
                          <span className="velo-label">Reset ID</span>
                          <input
                            className="velo-input font-mono text-sm"
                            value={resetId}
                            onChange={(e) => setResetId(e.target.value)}
                            required
                          />
                        </label>
                        <label className="block">
                          <span className="velo-label">Reset token</span>
                          <input
                            className="velo-input font-mono text-sm"
                            value={resetToken}
                            onChange={(e) => setResetToken(e.target.value)}
                            required
                          />
                        </label>
                        <label className="block">
                          <span className="velo-label">New password</span>
                          <PasswordInput
                            minLength={8}
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            required
                          />
                        </label>
                      </>
                    )}

                    {(mode === "login" || (mode === "register" && !signupVerification)) && (
                      <>
                        <label className="block">
                          <span className="velo-label flex items-center justify-between">
                            Password
                            {mode === "login" && (
                              <button
                                type="button"
                                onClick={() => switchMode("forgot")}
                                className="text-velo-600 hover:text-velo-700 text-xs font-semibold hover:underline"
                              >
                                Forgot password?
                              </button>
                            )}
                          </span>
                          <PasswordInput
                            minLength={8}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                          />
                          {mode === "register" && password && (
                            <div className="mt-2 space-y-1">
                              <div className={`text-xs flex items-center gap-1.5 ${password.length >= 8 ? "text-emerald-600" : "text-slate-400"}`}>
                                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: password.length >= 8 ? "#059669" : "#cbd5e1" }} />
                                At least 8 characters
                              </div>
                              <div className={`text-xs flex items-center gap-1.5 ${/[A-Z]/.test(password) ? "text-emerald-600" : "text-slate-400"}`}>
                                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: /[A-Z]/.test(password) ? "#059669" : "#cbd5e1" }} />
                                One uppercase letter
                              </div>
                              <div className={`text-xs flex items-center gap-1.5 ${/[0-9]/.test(password) ? "text-emerald-600" : "text-slate-400"}`}>
                                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: /[0-9]/.test(password) ? "#059669" : "#cbd5e1" }} />
                                One number
                              </div>
                            </div>
                          )}
                        </label>
                        {mode === "register" && !signupVerification && (
                          <label className="block">
                            <span className="velo-label">Confirm password</span>
                            <PasswordInput
                              minLength={8}
                              value={confirmPassword}
                              onChange={(e) => setConfirmPassword(e.target.value)}
                              className={confirmPassword && !passwordMatch ? "!border-red-300 !ring-red-100" : ""}
                              required
                            />
                            {confirmPassword && !passwordMatch && (
                              <p className="mt-1.5 text-xs font-medium text-red-600 flex items-center gap-1.5">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/><path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                                Passwords don't match
                              </p>
                            )}
                          </label>
                        )}
                      </>
                    )}

                    {mode === "register" && !signupVerification && (
                      <label className="flex items-start gap-2.5 cursor-pointer select-none group">
                        <input type="checkbox" required className="mt-0.5 h-4 w-4 rounded border-slate-300 text-velo-600 focus:ring-velo-500 cursor-pointer" />
                        <span className="text-xs text-slate-500 leading-relaxed group-hover:text-slate-700 transition-colors">
                          I agree to Velo's <Link to="/terms" className="text-velo-600 font-semibold hover:underline">Terms of Service</Link>, <Link to="/privacy" className="text-velo-600 font-semibold hover:underline">Privacy Policy</Link>, and consent to identity verification & electronic communications.
                        </span>
                      </label>
                    )}

                    {mode === "register" && !signupVerification && (
                      <label className="block">
                        <span className="velo-label">Send verification code by</span>
                        <select className="velo-input" value={preferredOtpChannel} onChange={(event) => setPreferredOtpChannel(event.target.value as OtpChannel)}>
                          <option value="EMAIL">Email</option>
                          <option value="SMS">Phone (SMS)</option>
                        </select>
                        <span className="mt-1 block text-xs text-slate-500">Resends will use this preferred option.</span>
                      </label>
                    )}

                    {mode === "login" && loginOtpUser && !signupVerification && (
                      <div className="space-y-3 rounded-2xl border border-velo-100 bg-velo-50/70 p-4 dark:border-velo-900/40 dark:bg-velo-900/20">
                        <div>
                          <p className="text-sm font-semibold text-velo-900 dark:text-white">Account not yet verified</p>
                          <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                            Your account needs a one-time verification code before you can sign in. How should we send your 6-digit code?
                          </p>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          {(loginOtpUser.channels).map((channel) => {
                          const label = channel === "SMS" ? { title: "Text message (SMS)", icon: <Icon name="message" size={24} /> } : { title: "Email", icon: <Icon name="email" size={24} /> };
                          return (
                            <button
                              key={channel}
                              type="button"
                              disabled={busy}
                              onClick={() => chooseLoginOtpChannel(channel)}
                              className="group flex flex-col items-center justify-center gap-2 py-4 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-velo-400 dark:hover:border-velo-500 hover:shadow-md transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                              <span className="text-velo-600 dark:text-velo-400">{label.icon}</span>
                              <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 group-hover:text-velo-700 dark:group-hover:text-velo-400">{label.title}</span>
                            </button>
                          );
                        })}
                        </div>
                      </div>
                    )}

                    {(signupVerification || loginStepUp) && (
                      <div className="space-y-4 rounded-2xl border border-velo-100 bg-velo-50/70 p-4 dark:border-velo-900/40 dark:bg-velo-900/20">
                        <div>
                          <p className="text-sm font-semibold text-velo-900 dark:text-white">Verify your account</p>
                          <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                            Enter the 6-digit code sent by {(signupVerification ?? loginStepUp)!.channel === "SMS" ? "SMS" : "email"}.
                          </p>
                        </div>
                        <label className="block">
                          <span className="velo-label">Verification code</span>
                          <input className="velo-input text-center text-lg tracking-[0.35em]" inputMode="numeric" maxLength={6} pattern="[0-9]{6}" value={otpCode} onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, ""))} placeholder="000000" required autoFocus />
                        </label>
                        <div className="flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
                          <span>{otpRemaining > 0 ? `Resend available in ${otpRemaining}s` : "You can resend the OTP now."}</span>
                          <button type="button" onClick={resendSignupOtp} disabled={busy || otpRemaining > 0} className="font-semibold text-velo-600 hover:text-velo-700 disabled:cursor-not-allowed disabled:opacity-50">Resend OTP</button>
                        </div>
                      </div>
                    )}

                    {error && (
                      <div className="rounded-xl border border-red-100 bg-red-50 dark:bg-red-900/20 dark:border-red-900/30 p-3.5 flex items-start gap-2.5 animate-shake">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-red-500 shrink-0 mt-0.5"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/><path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                        <span className="text-sm font-medium text-red-700 dark:text-red-400">{error}</span>
                      </div>
                    )}

                    {success && (
                      <div className="rounded-xl border border-emerald-100 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 p-3.5 flex items-start gap-2.5">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-emerald-500 shrink-0 mt-0.5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">{success}</span>
                      </div>
                    )}

                    <button
                      className={`w-full py-3.5 rounded-xl font-semibold text-white shadow-lg transition-all duration-200 hover:shadow-xl hover:scale-[1.01] active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100 ${
                        mode === "register" && role === "INVESTOR"
                          ? "bg-gradient-to-r from-emerald-600 to-emerald-500 shadow-emerald-500/25 hover:shadow-emerald-500/40"
                          : "bg-gradient-to-r from-velo-600 to-velo-500 shadow-velo-500/25 hover:shadow-velo-500/40"
                      }`}
                      disabled={
                        busy ||
                        (mode === "login" && (signupVerification || loginStepUp) ? otpCode.length !== 6 : false) ||
                        (mode === "register" && (signupVerification ? otpCode.length !== 6 : (!passwordMatch || !passwordStrong)))
                      }
                    >
                      {busy ? (
                        <span className="inline-flex items-center gap-2 justify-center">
                          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                          Please wait…
                        </span>
                      ) : mode === "login" ? (
                        (signupVerification || loginStepUp) ? "Verify code and sign in" : "Sign in"
                      ) : mode === "forgot" ? (
                        resetId && resetToken ? "Confirm new password" : "Send reset link"
                      ) : (
                        signupVerification ? "Verify and continue" : role === "INVESTOR" ? "Create investor account" : "Create borrower account"
                      )}
                    </button>

                    {mode !== "forgot" && (
                      <div className="relative flex items-center justify-center py-2">
                        <div className="absolute inset-x-0 top-1/2 h-px bg-slate-200 dark:bg-slate-700" />
                        <span className="relative bg-white dark:bg-slate-900 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">or</span>
                      </div>
                    )}
                  </form>

                  {/* Bottom links */}
                  <div className="mt-4 text-center space-y-2">
                    {mode === "forgot" && (
                      <button
                        type="button"
                        onClick={() => switchMode("login")}
                        className="text-sm text-slate-600 hover:text-velo-700 font-medium inline-flex items-center gap-1.5 group"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="group-hover:-translate-x-0.5 transition-transform"><path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        Back to sign in
                      </button>
                    )}
                    {mode === "login" && (
                      <p className="text-sm text-slate-500">
                        Don't have an account?{" "}
                        <button
                          type="button"
                          onClick={() => switchMode("register")}
                          className="text-velo-600 font-semibold hover:text-velo-700 hover:underline"
                        >
                          Create one
                        </button>
                      </p>
                    )}
                    {mode === "register" && (
                      <p className="text-sm text-slate-500">
                        Already registered?{" "}
                        <button
                          type="button"
                          onClick={() => switchMode("login")}
                          className="text-velo-600 font-semibold hover:text-velo-700 hover:underline"
                        >
                          Sign in
                        </button>
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <p className="text-center text-[11px] text-slate-400 leading-relaxed">
                By continuing you acknowledge that your data will be processed in accordance with our privacy policy and is protected with bank-level 256-bit encryption.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Maintenance mode — a beautiful blocking modal: sign-in is paused while
          the platform is under maintenance, and users are promised (and sent)
          an email the moment it is back up. */}
      {maintenanceNotice && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="maintenance-title"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/70 backdrop-blur-md px-4 animate-fade-in"
        >
          <div className="relative w-full max-w-md rounded-3xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 shadow-2xl overflow-hidden">
            <div className="relative bg-gradient-to-br from-amber-500 via-amber-600 to-orange-600 px-6 pt-8 pb-9 text-center text-white overflow-hidden">
              <div className="absolute -top-14 -right-14 w-44 h-44 rounded-full bg-white/15 blur-2xl" />
              <div className="absolute -bottom-16 -left-10 w-40 h-40 rounded-full bg-white/10 blur-3xl" />
              <div className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-white/20 border border-white/30 backdrop-blur-sm">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" className="animate-spin-slow">
                  <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <h2 id="maintenance-title" className="relative mt-4 text-2xl font-black leading-tight">
                We&apos;ll be right back
              </h2>
              <p className="relative mt-1 text-sm text-white/85">
                Scheduled maintenance in progress
              </p>
            </div>
            <div className="px-6 sm:px-8 py-6 text-center">
              <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">
                {maintenanceNotice}
              </p>
              <div className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0">
                  <path d="M3 8l9 6 9-6M3 8v10a2 2 0 002 2h14a2 2 0 002-2V8M3 8a2 2 0 012-2h14a2 2 0 012 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                We&apos;ll email you the moment the system is back up
              </div>
              <p className="mt-4 text-[11px] leading-5 text-slate-400">
                Your data and any pending transactions are safe. Thank you for your patience while we make Velo better.
              </p>
              <button
                type="button"
                onClick={() => setMaintenanceNotice(null)}
                className="mt-5 w-full rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 transition"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dashboard picker — dual-role accounts choose where to land after
          signing in. They can always switch between dashboards later. */}
      {showDashboardPicker && user && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="dashboard-picker-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-md px-4 animate-fade-in"
        >
          <div className="relative w-full max-w-xl rounded-3xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 shadow-2xl overflow-hidden animate-[slideInUp_280ms_cubic-bezier(0.22,1,0.36,1)]">
            {/* Decorative gradient header */}
            <div className="relative bg-gradient-to-br from-velo-900 via-velo-800 to-velo-700 dark:from-velo-900 dark:via-velo-900 dark:to-velo-900 px-6 sm:px-8 pt-7 pb-8 text-white overflow-hidden">
              <div className="absolute -top-16 -right-16 w-56 h-56 rounded-full bg-emerald-400/20 blur-3xl" />
              <div className="absolute -bottom-20 -left-10 w-48 h-48 rounded-full bg-velo-300/10 blur-3xl" />
              <div className="relative">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 border border-white/15 text-[11px] font-bold uppercase tracking-[0.16em] text-emerald-200">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Welcome back, {user.fullName?.split(" ")[0] || "there"}
                </div>
                <h2 id="dashboard-picker-title" className="mt-3 text-2xl sm:text-3xl font-black leading-tight">
                  Where would you like to go?
                </h2>
                <p className="mt-2 text-sm text-white/70 max-w-md">
                  Your account has both a borrower and an investor dashboard. Select your preferred dashboard to enter — you can always switch between your borrower and investor accounts anytime.
                </p>
              </div>
            </div>

            <div className="px-6 sm:px-8 py-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <button
                type="button"
                onClick={() => enterDashboard("investor")}
                className="group relative text-left p-5 rounded-2xl border-2 border-slate-200 dark:border-slate-700 bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-900/20 dark:to-slate-900 hover:border-emerald-400 dark:hover:border-emerald-500 hover:shadow-xl hover:shadow-emerald-500/10 hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200"
              >
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-400 text-white shadow-lg shadow-emerald-500/25 mb-3 group-hover:scale-110 transition-transform">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 3v18h18M7 14l4-4 4 4 5-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </div>
                <div className="text-lg font-black text-velo-900 dark:text-white">Investor</div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  Portfolio, earnings &amp; wallet — fund verified loans and track returns.
                </p>
                <div className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-emerald-600 dark:text-emerald-400">
                  Enter dashboard
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="group-hover:translate-x-0.5 transition-transform"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </div>
              </button>

              <button
                type="button"
                onClick={() => enterDashboard("borrower")}
                className="group relative text-left p-5 rounded-2xl border-2 border-slate-200 dark:border-slate-700 bg-gradient-to-br from-velo-50 to-white dark:from-velo-900/30 dark:to-slate-900 hover:border-velo-400 dark:hover:border-velo-500 hover:shadow-xl hover:shadow-velo-500/10 hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200"
              >
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-velo-600 to-velo-500 text-white shadow-lg shadow-velo-500/25 mb-3 group-hover:scale-110 transition-transform">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </div>
                <div className="text-lg font-black text-velo-900 dark:text-white">Borrower</div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  Loans, applications &amp; repayments — apply, track and repay with ease.
                </p>
                <div className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-velo-600 dark:text-velo-400">
                  Enter dashboard
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="group-hover:translate-x-0.5 transition-transform"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </div>
              </button>
            </div>

            <div className="px-6 sm:px-8 pb-6 flex items-center justify-between gap-3">
              <p className="text-[11px] text-slate-400 dark:text-slate-500 flex items-center gap-1.5">
                <Icon name="sparkles" size={13} className="text-emerald-500" />
                You can switch between your Borrower and Investor account at any time.
              </p>
              <button
                type="button"
                onClick={() => enterDashboard(user.roles.includes("BORROWER") ? "borrower" : "investor")}
                className="text-xs font-semibold text-slate-400 hover:text-velo-600 dark:hover:text-velo-400 transition-colors whitespace-nowrap"
              >
                Skip
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
