import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { config, getLoanProgram, validateConfig } from "../utils/config";
import { calculateMonthlyInterest, calculateLoan, formatNaira, formatDateLabel, getSuggestedLoanAmounts } from "../utils/loanCalculator";
import { resolveFeesForTenure } from "../utils/config";

const TESTIMONIALS = [
  { quote: "The application was simple, and the repayment terms were clear from the start. I received the funds I needed for my shop without unnecessary delays.", name: "Amaka Okafor", meta: "Lagos • Fashion Brand Owner", initials: "AO" },
  { quote: "Velo gave my business the working capital to restock quickly. The process was straightforward and the team kept me updated throughout.", name: "Chinedu Eze", meta: "Anambra • Retail Business Owner", initials: "CE" },
  { quote: "I used my personal loan to handle an urgent family expense. The digital application saved me time and I knew exactly what I would repay.", name: "Fatima Bello", meta: "Abuja • Customer", initials: "FB" },
  { quote: "The flexible tenure made the loan manageable for my business. I could plan my cash flow properly before accepting the offer.", name: "Tunde Adebayo", meta: "Ibadan • Logistics Operator", initials: "TA" },
  { quote: "I was impressed by how clearly every fee was explained. There were no surprises, and the funds arrived when my business needed them.", name: "Blessing Nwosu", meta: "Enugu • Catering Entrepreneur", initials: "BN" },
  { quote: "Velo helped me bridge a short-term cash flow gap without disrupting my business operations. The repayment estimate was easy to understand.", name: "Musa Ibrahim", meta: "Kano • Distributor", initials: "MI" },
  { quote: "From application to disbursement, the loan process felt organized and professional. I would gladly recommend Velo to other business owners.", name: "Kemi Adeyemi", meta: "Lagos • Beauty Entrepreneur", initials: "KA" },
  { quote: "The loan gave me room to expand my inventory at the right time. I appreciated being able to review the numbers before applying.", name: "David Uche", meta: "Port Harcourt • Electronics Retailer", initials: "DU" },
  { quote: "I needed funds for a time-sensitive project and Velo made the process easy to follow. Their support team answered my questions clearly.", name: "Zainab Sani", meta: "Kaduna • Consultant", initials: "ZS" },
  { quote: "Velo Finance helped me invest in new equipment and grow my monthly orders. The repayment plan matched the way my business earns.", name: "Emeka Okoro", meta: "Owerri • Food Business Owner", initials: "EO" },
];

export default function StartApplication() {
  const [testimonialIndex, setTestimonialIndex] = useState(0);
  const personalProgram = getLoanProgram("PERSONAL");

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTestimonialIndex((current) => (current + 1) % TESTIMONIALS.length);
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const errors = validateConfig();
  const hardErrors = errors.filter((e) => e.severity === "error");
  const warnings = errors.filter((e) => e.severity === "warning");

  const [loanAmount, setLoanAmount] = useState(personalProgram.loanLimits.defaultAmount);
  const [amountInput, setAmountInput] = useState(String(personalProgram.loanLimits.defaultAmount));
  const [amountError, setAmountError] = useState("");
  const [selectedTenure, setSelectedTenure] = useState(personalProgram.tenures[0]?.value || 30);

  const calculation = useMemo(() => {
    return calculateLoan(loanAmount, selectedTenure, { loanType: "PERSONAL" });
  }, [loanAmount, selectedTenure]);

  const { min, max } = personalProgram.loanLimits;
  const step = (max - min) <= 1_000_000 ? 5_000 : 10_000;
  const selectedFees = resolveFeesForTenure({ ...config, ...personalProgram }, selectedTenure);
  const quickAmounts = getSuggestedLoanAmounts(min, max);
  const monthlyInterest = calculateMonthlyInterest(calculation.loanAmount, selectedFees.interest);

  function validateAmount(value: number): string {
    if (!Number.isFinite(value) || value < min) return `Minimum loan amount is ${formatNaira(min)}.`;
    if (value > max) return `Maximum loan amount is ${formatNaira(max)}.`;
    return "";
  }

  function handleSlider(v: number) {
    setLoanAmount(v);
    setAmountInput(String(v));
    setAmountError("");
  }

  function handleAmountInput(v: string) {
    const numeric = v.replace(/[^0-9]/g, "");
    setAmountInput(numeric);
    if (!numeric) {
      setAmountError("Enter a loan amount.");
      return;
    }
    const n = Number(numeric);
    setLoanAmount(n);
    setAmountError(validateAmount(n));
  }

  function handleAmountBlur() {
    if (!amountInput) {
      setAmountError("Enter a loan amount.");
      return;
    }
    const n = Number(amountInput);
    const error = validateAmount(n);
    setAmountError(error);
    if (!error) setAmountInput(n.toLocaleString("en-NG"));
  }

  return (
    <Layout>
      {/* ===========================================================
          FRESH HERO — completely reimagined
          =========================================================== */}
      <section className="relative -mx-4 sm:-mx-6 -mt-6 sm:-mt-10 overflow-hidden">
        {/* Background */}
        <div className="absolute inset-0 bg-white dark:bg-slate-950" />
        <div className="absolute inset-0 opacity-[0.035] dark:opacity-[0.05]" style={{backgroundImage: 'radial-gradient(circle at 1px 1px, #0f172a 1px, transparent 0)', backgroundSize: '30px 30px'}} />
        {/* Floating gradient blobs — solid tint only in light mode */}
        <div className="absolute -top-32 -left-24 w-96 h-96 bg-velo-100/50 dark:bg-velo-900/20 rounded-full blur-3xl animate-float" />
        <div className="absolute top-1/3 -right-32 w-[28rem] h-[28rem] bg-velo-100/50 dark:bg-velo-800/15 rounded-full blur-3xl animate-float-slow" />
        <div className="absolute bottom-0 left-1/3 w-72 h-72 bg-velo-50 dark:bg-velo-900/10 rounded-full blur-3xl opacity-60 dark:opacity-40 animate-float" />

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 pt-10 sm:pt-14 pb-16 sm:pb-24">
          {/* Top: breadcrumb pills with trust strip */}
          <div className="flex flex-wrap items-center justify-between gap-4 mb-10 sm:mb-14 animate-fade-in-down">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <BadgePill accent="velo">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Live &amp; Ready
              </BadgePill>
              <BadgePill accent="velo">
                <StarIcon />
                4.9/5 Rating
              </BadgePill>
              <BadgePill accent="slate">
                <UsersIcon />
                50,000+ Customers
              </BadgePill>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <MiniTrust icon={<ShieldLockIcon />} label="NDPR Compliant" />
              <MiniTrust icon={<CbnIcon />} label="CBN Regulated" />
              <MiniTrust icon={<InsuredIcon />} label="NDIC Insured" />
            </div>
          </div>

          {/* Main content: 2 column split */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-start">
            {/* ============== LEFT: COPY ============== */}
            <div className="lg:col-span-5 xl:col-span-5 relative z-10">
              {/* Eyebrow */}
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-velo-50 border border-velo-100 text-velo-700 text-xs font-semibold mb-5 animate-fade-in-up animate-pulse-glow">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-velo-500 animate-pulse" />
                VELO FINANCE LTD — PERSONAL & BUSINESS LOANS
              </div>

              <h1 className="text-3xl sm:text-4xl md:text-5xl xl:text-[3.4rem] font-semibold text-velo-900 dark:text-white leading-[1.08] mb-5 text-balance animate-fade-in-up animate-delay-100">
                Funding for your
                <br />
                <span className="relative inline-block">
                  <span className="bg-gradient-to-r from-velo-700 via-velo-600 to-velo-500 bg-clip-text text-transparent dark:bg-none dark:!text-velo-400 dark:!bg-clip-border">
                    next important move
                  </span>
                  <svg className="absolute -bottom-1 left-0 w-full" viewBox="0 0 300 12" fill="none" preserveAspectRatio="none">
                    <path d="M2 9 Q 80 2, 150 7 T 298 5" stroke="#2196F3" strokeWidth="3" strokeLinecap="round"/>
                  </svg>
                </span>
              </h1>

              <p className="text-base sm:text-lg text-slate-600 leading-relaxed mb-7 max-w-xl animate-fade-in-up animate-delay-200">
                Access transparent personal and business loans with flexible tenors, clear repayment estimates, and a simple digital application — all from <strong>Velo Finance LTD</strong>.
              </p>

              {/* Feature bullets */}
              <ul className="space-y-3 mb-8 animate-fade-in-up animate-delay-300">
                {[
                  { t: "Personal & Business Loans", d: "Choose the amount and repayment tenor that suits your plans" },
                  { t: "Transparent Repayment", d: "See your interest and applicable fees before you apply" },
                  { t: "Fast Digital Application", d: "Apply online and keep track of your loan request with Velo" },
                  { t: "Beyond Lending", d: "Transfers, bills, global payments, gift cards, crypto and USD virtual cards" },
                ].map((f, i) => (
                  <li key={i} className="flex items-start gap-3 group">
                    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600 group-hover:scale-110 group-hover:bg-emerald-500 group-hover:text-white transition-all duration-200 mt-0.5">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </span>
                    <span className="text-sm leading-snug">
                      <span className="font-semibold text-velo-900">{f.t}.</span> <span className="text-slate-600">{f.d}.</span>
                    </span>
                  </li>
                ))}
              </ul>

              {/* CTA Buttons */}
              <div className="space-y-3 mb-10 animate-fade-in-up animate-delay-400">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Link
                    to="/account?mode=register&role=BORROWER"
                    className="inline-flex items-center justify-center gap-2 px-6 py-4 rounded-2xl bg-gradient-to-r from-velo-600 to-velo-500 dark:bg-velo-600 dark:from-velo-600 dark:to-velo-600 text-white font-semibold shadow-lg shadow-velo-500/25 transition-all duration-200 hover:shadow-xl hover:shadow-velo-500/40 hover:scale-[1.02] active:scale-[0.98] group animate-pulse-glow"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    Borrow Money
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="group-hover:translate-x-1 transition-transform">
                      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </Link>
                  <Link
                    to="/account?mode=register&role=INVESTOR"
                    className="inline-flex items-center justify-center gap-2 px-6 py-4 rounded-2xl bg-gradient-to-r from-emerald-600 to-emerald-500 dark:bg-emerald-600 dark:from-emerald-600 dark:to-emerald-600 text-white font-semibold shadow-lg shadow-emerald-500/25 transition-all duration-200 hover:shadow-xl hover:shadow-emerald-500/40 hover:scale-[1.02] active:scale-[0.98] group"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M3 3v18h18M7 14l4-4 4 4 5-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    Invest & Earn
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="group-hover:translate-x-1 transition-transform">
                      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </Link>
                </div>
                <div className="flex flex-wrap gap-3 pt-1">
                  <a href="#calculator" className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-white text-velo-700 font-semibold border-2 border-slate-200 hover:border-velo-300 hover:text-velo-800 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] group">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    Loan Calculator
                  </a>
                  <Link to="/account?mode=login" className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-slate-700 font-semibold hover:bg-slate-50 transition-all duration-200 group">
                    Already have an account?
                    <span className="text-velo-600 group-hover:underline">Sign in</span>
                  </Link>
                </div>
              </div>

              {/* Mini testimonials row */}
              <div className="flex flex-wrap items-center gap-4 sm:gap-5 animate-fade-in-up animate-delay-500">
                <div className="flex -space-x-2">
                  {["#2196F3","#1E86DB","#1866A8","#123F6B","#0C2947"].map((c, i) => (
                    <div key={i} className="h-8 w-8 rounded-full border-2 border-white shadow-sm flex items-center justify-center text-white text-xs font-semibold" style={{backgroundColor: c}}>
                      {["A","O","C","M","J"][i]}
                    </div>
                  ))}
                </div>
                <div className="leading-tight">
                  <div className="flex items-center gap-0.5">
                    {[0,1,2,3,4].map(i => <StarIcon key={i} />)}
                    <span className="text-xs font-semibold text-velo-900 ml-1">4.9</span>
                  </div>
                  <div className="text-[11px] text-slate-500">clear terms before you apply</div>
                </div>
                <div className="hidden sm:block h-8 w-px bg-slate-200" />
                <div className="leading-tight">
                  <div className="text-xs font-semibold text-velo-900">Loan-first service</div>
                  <div className="text-[11px] text-slate-500">with digital finance tools</div>
                </div>
              </div>
            </div>

            {/* ============== RIGHT: CALCULATOR CARD ============== */}
            <div id="calculator" className="lg:col-span-7 xl:col-span-7 animate-fade-in-right animate-delay-200">
              <div className="relative">
                {/* Glow — solid tint in dark mode */}
                <div className="absolute -inset-2 bg-gradient-to-br from-velo-200/60 via-white/0 to-velo-100/60 dark:bg-velo-700/20 dark:via-transparent dark:to-velo-800/20 rounded-3xl blur-2xl opacity-80 dark:opacity-60" />

                <div className="relative bg-white dark:bg-slate-900 border border-slate-200/70 dark:border-slate-700 rounded-3xl shadow-[0_20px_80px_-20px_rgba(15,23,42,0.2)] overflow-hidden">
                  {/* Calculator Header — solid color in dark mode */}
                  <div className="relative bg-gradient-to-br from-velo-900 via-velo-800 to-velo-700 dark:bg-velo-900 dark:from-velo-900 dark:via-velo-900 dark:to-velo-900 dark:animate-none px-6 sm:px-7 py-6 text-white overflow-hidden">
                    <div className="absolute -top-16 -right-16 w-48 h-48 bg-velo-300/20 dark:bg-velo-700/20 rounded-full blur-2xl animate-float" />
                    <div className="absolute -bottom-10 -left-10 w-40 h-40 bg-velo-400/20 dark:bg-velo-800/20 rounded-full blur-2xl animate-float-slow" />

                    <div className="relative flex flex-wrap items-start justify-between gap-4 mb-5">
                      <div>
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/15 backdrop-blur-sm text-[11px] font-semibold border border-white/20 mb-2.5 animate-pulse-glow">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          LIVE CALCULATOR
                        </div>
                        <h2 className="text-xl sm:text-2xl font-semibold">Loan Calculator</h2>
                        <p className="text-sm text-white/70 mt-0.5">Adjust amount & tenure — results update instantly</p>
                      </div>
                      {/* Live total preview */}
                      <div className="text-right shrink-0">
                        <div className="text-[11px] text-white/60 font-semibold uppercase tracking-wider mb-1">Total Repayment</div>
                        <div className="text-2xl sm:text-3xl font-semibold tracking-tight text-white transition-all duration-500 animate-bounce-subtle" key={calculation.totalRepayment}>
                          {formatNaira(calculation.totalRepayment)}
                        </div>
                      </div>
                    </div>

                    {/* Summary bar */}
                    <div className="relative grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
                      <MiniMetric label="Principal" value={formatNaira(calculation.loanAmount)} />
                      <MiniMetric label="Interest" value={formatNaira(calculation.interest)} />
                      <MiniMetric label="Fees" value={formatNaira(calculation.totalFees)} />
                      <MiniMetric label="Due Date" value={formatDateLabel(calculation.repaymentDate)} compact />
                    </div>
                  </div>

                  {/* Calculator Body */}
                  <div className="p-6 sm:p-7">
                    <div className="space-y-6">
                      {/* ===== Amount Section ===== */}
                      <div>
                        <div className="flex items-center justify-between mb-2.5">
                          <label className="text-sm font-semibold text-velo-900">How much do you need?</label>
                          <span className="text-xs text-slate-500 font-medium">
                            {formatNaira(min)} – {formatNaira(max)}
                          </span>
                        </div>

                        {/* Amount input */}
                        <div className="relative group mb-4">
                          <div className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none">
                            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-velo-100 to-velo-50 dark:bg-velo-900 dark:from-velo-900 dark:to-velo-900 dark:text-velo-400 text-velo-700 font-semibold text-sm border border-velo-100 dark:border-velo-800">
                              ₦
                            </span>
                          </div>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={amountInput}
                            onChange={(e) => handleAmountInput(e.target.value)}
                            onBlur={handleAmountBlur}
                            className={`w-full pl-14 pr-5 py-4 text-2xl sm:text-3xl font-semibold rounded-2xl border-2 ${amountError ? "border-red-300" : "border-slate-200"} bg-gradient-to-br from-white to-slate-50 dark:bg-slate-900 dark:from-slate-900 dark:to-slate-900 text-velo-900 dark:text-slate-100 placeholder:text-slate-400 transition-all duration-200 focus:border-velo-500 focus:ring-4 focus:ring-velo-100 focus:outline-none group-hover:border-velo-300 focus:bg-white dark:focus:bg-slate-900`}
                            placeholder="0"
                            autoComplete="off"
                          />
                          {amountError && <p className="mt-2 text-xs font-medium text-red-600">{amountError}</p>}
                        </div>

                        {/* Custom range slider with highlight */}
                        <div className="relative px-1 mb-3">
                          <div className="absolute top-2.5 left-0 right-0 h-2 rounded-full bg-slate-100" />
                          <div
                            className="absolute top-2.5 left-0 h-2 rounded-full bg-gradient-to-r from-velo-500 to-velo-400 dark:bg-velo-500 dark:from-velo-500 dark:to-velo-500 transition-all duration-200"
                            style={{ width: `${((loanAmount - min) / (max - min)) * 100}%` }}
                          />
                          <input
                            type="range"
                            className="relative w-full appearance-none bg-transparent h-7 cursor-pointer z-10
                              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-[3px] [&::-webkit-slider-thumb]:border-velo-500 [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:shadow-velo-500/30 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:duration-200 hover:[&::-webkit-slider-thumb]:scale-110
                              [&::-moz-range-thumb]:w-7 [&::-moz-range-thumb]:h-7 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-[3px] [&::-moz-range-thumb]:border-velo-500"
                            min={min}
                            max={max}
                            step={step}
                            value={loanAmount || min}
                            onChange={(e) => handleSlider(Number(e.target.value))}
                          />
                        </div>
                        <div className="flex justify-between text-[11px] font-semibold text-slate-400">
                          <span>{formatNaira(min)}</span>
                          <span>{formatNaira(max)}</span>
                        </div>

                        {/* Quick amounts */}
                        <div className="flex flex-wrap gap-2 mt-4">
                          {quickAmounts.map((amt, i) => {
                            if (amt < min || amt > max) return null;
                            const active = loanAmount === amt;
                            return (
                              <button
                                key={amt}
                                type="button"
                                onClick={() => handleSlider(amt)}
                                style={{ animationDelay: `${i * 40}ms` }}
                                className={`px-3.5 py-2 rounded-xl text-xs font-semibold border transition-all duration-200
                                  ${active
                                    ? "bg-velo-500 text-white border-velo-500 shadow-md shadow-velo-500/30 scale-105"
                                    : "bg-slate-50 dark:bg-slate-800 text-slate-700 border-slate-200 hover:border-velo-300 hover:text-velo-700 hover:bg-white dark:hover:bg-slate-700 hover:scale-105"
                                  }`}
                              >
                                {formatNaira(amt)}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Divider */}
                      <div className="flex items-center gap-3">
                        <div className="flex-1 h-px bg-slate-100" />
                        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"/><path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                          Repayment tenure
                        </div>
                        <div className="flex-1 h-px bg-slate-100" />
                      </div>

                      {/* ===== Tenure Section ===== */}
                      <div>
                        <div className={`grid gap-2.5 ${config.tenures.length <= 3 ? "grid-cols-3" : config.tenures.length <= 4 ? "grid-cols-2 sm:grid-cols-4" : config.tenures.length === 5 ? "grid-cols-5" : "grid-cols-2 sm:grid-cols-" + Math.min(config.tenures.length, 6)}`}>
                          {personalProgram.tenures.map((t, i) => {
                            const active = selectedTenure === t.value;
                            return (
                              <button
                                key={t.value}
                                type="button"
                                onClick={() => setSelectedTenure(t.value)}
                                style={{ animationDelay: `${i * 50}ms` }}
                                className={`relative px-2.5 sm:px-3 py-3 sm:py-3.5 rounded-2xl border-2 text-center transition-all duration-200 overflow-hidden
                                  ${active
                                    ? "border-velo-500 bg-gradient-to-br from-velo-50 to-white dark:bg-slate-800 dark:from-slate-800 dark:to-slate-800 dark:text-velo-400 text-velo-700 shadow-md shadow-velo-500/10 scale-[1.03] ring-2 ring-velo-100 dark:ring-velo-800"
                                    : "border-slate-200 bg-white dark:bg-slate-800 text-slate-600 hover:border-velo-300 hover:text-velo-700 hover:scale-[1.03]"
                                  }`}
                              >
                                {active && (
                                  <div className="absolute top-1.5 right-1.5 h-4 w-4 rounded-full bg-velo-500 text-white flex items-center justify-center">
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                  </div>
                                )}
                                <div className="text-base sm:text-lg font-semibold leading-none mb-1">{t.value}</div>
                                <div className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider opacity-75">Days</div>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* ===== Fee Breakdown card ===== */}
                      <div className="rounded-2xl bg-gradient-to-br from-slate-50 to-white dark:bg-slate-900 dark:from-slate-900 dark:to-slate-900 border border-slate-200/70 dark:border-slate-700 p-5 relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-velo-100 to-transparent dark:bg-velo-800/20 dark:to-transparent rounded-full blur-2xl opacity-60 dark:opacity-40" />
                        <div className="relative">
                          <div className="flex items-center justify-between mb-4">
                            <h3 className="text-sm font-semibold text-velo-900 flex items-center gap-1.5">
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 2a10 10 0 100 20 10 10 0 000-20z" stroke="currentColor" strokeWidth="2"/><path d="M12 6v12M8 10h6M10 14h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                              Transparent Fee Breakdown
                            </h3>
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[10px] font-semibold border border-emerald-100">
                              NO HIDDEN FEES
                            </span>
                          </div>

                          <div className="space-y-2.5">
                            <BreakdownRow
                              label="Principal (you receive)"
                              value={formatNaira(calculation.loanAmount)}
                              accent="velo"
                              bold
                            />
                            <BreakdownRow
                              label={`Interest (${selectedFees.interest.type === "percentage" ? `${selectedFees.interest.value.toFixed(2)}% per month` : "Flat"})`}
                              value={formatNaira(calculation.interest)}
                              tag={`${formatNaira(monthlyInterest)} per month × ${(selectedTenure / 30).toFixed(2)} months`}
                            />
                            <BreakdownRow
                              label="Service Fee"
                              value={formatNaira(calculation.serviceFee)}
                            />
                            <BreakdownRow
                              label="Processing Fee"
                              value={formatNaira(calculation.processingFee)}
                            />
                            {calculation.lateFee > 0 && (
                              <BreakdownRow
                                label={selectedFees.lateFee.includeUpfront ? "Default Fee (included upfront)" : "Default Fee (only on missed payment)"}
                                value={formatNaira(calculation.lateFee)}
                                muted
                                tag={selectedFees.lateFee.includeUpfront ? "Included in total repayment" : "Applies only if you default"}
                              />
                            )}
                          </div>

                          {/* Totals */}
                          <div className="mt-4 pt-4 border-t-2 border-slate-200/80 grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="rounded-xl p-3.5 bg-white dark:bg-slate-800 border border-slate-100">
                              <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider mb-0.5">Tenure</div>
                              <div className="text-lg font-semibold text-velo-900">{calculation.tenureLabel}</div>
                            </div>
                            <div className="rounded-xl p-3.5 bg-gradient-to-br from-velo-500 to-velo-600 dark:bg-velo-600 dark:from-velo-600 dark:to-velo-600 text-white relative overflow-hidden">
                              <div className="absolute top-0 right-0 w-20 h-20 bg-white/10 dark:bg-velo-800/30 rounded-full blur-xl" />
                              <div className="relative text-[10px] text-white/80 font-semibold uppercase tracking-wider mb-0.5">Total Repayment</div>
                              <div className="relative text-xl sm:text-2xl font-semibold tracking-tight animate-bounce-subtle" key={calculation.totalRepayment}>
                                {formatNaira(calculation.totalRepayment)}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* ===== Apply buttons ===== */}
                      <div className="space-y-3 pt-1">
                        <div className="text-center mb-4">
                          <p className="text-sm font-semibold text-velo-900 mb-1">Ready to get funded?</p>
                          <p className="text-xs text-slate-500">Create an account or sign in — your progress is always saved.</p>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <Link
                            to="/account?mode=register&role=BORROWER&type=PERSONAL"
                            className="inline-flex items-center justify-center gap-2 px-5 py-4 rounded-2xl bg-gradient-to-r from-velo-600 to-velo-500 dark:bg-velo-600 dark:from-velo-600 dark:to-velo-600 text-white font-semibold shadow-lg shadow-velo-500/25 transition-all duration-200 hover:shadow-xl hover:shadow-velo-500/40 hover:scale-[1.02] active:scale-[0.98] group animate-pulse-glow"
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><circle cx="12" cy="7" r="4" stroke="currentColor" strokeWidth="2"/></svg>
                            Personal Loan
                          </Link>
                          <Link
                            to="/account?mode=register&role=BORROWER&type=BUSINESS"
                            className="inline-flex items-center justify-center gap-2 px-5 py-4 rounded-2xl bg-gradient-to-r from-velo-800 to-velo-700 dark:bg-velo-800 dark:from-velo-800 dark:to-velo-800 text-white font-semibold shadow-lg shadow-velo-800/25 transition-all duration-200 hover:shadow-xl hover:shadow-velo-800/40 hover:scale-[1.02] active:scale-[0.98] group"
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 21h18M5 21V10M19 21V10M3 10l9-6 9 6M9 21v-5h6v5" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>
                            Business Loan
                          </Link>
                        </div>
                        <Link
                          to="/account?mode=login"
                          className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-2xl bg-white dark:bg-slate-800 border-2 border-slate-200 text-slate-700 font-semibold transition-all duration-200 hover:border-velo-300 hover:text-velo-700 hover:bg-slate-50 group"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="group-hover:rotate-12 transition-transform"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          Sign in to continue your application
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===========================================================
          4 QUICK BENEFITS
          =========================================================== */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-14 sm:mb-20">
        {[
          { icon: <SpeedIcon />, title: "Fast Approval", desc: "Applications reviewed in hours, not days", color: "from-velo-600 to-velo-500" },
          { icon: <CalcIcon />, title: "No Hidden Fees", desc: "Every charge is transparent upfront", color: "from-velo-500 to-velo-400" },
          { icon: <ShieldIcon />, title: "Bank-Level Security", desc: "256-bit encryption for all your data", color: "from-velo-700 to-velo-600" },
          { icon: <FlexIcon />, title: "Flexible Terms", desc: `Tenures from ${config.tenures[0]?.value || 30} to ${config.tenures[config.tenures.length - 1]?.value || 180} days`, color: "from-velo-800 to-velo-700" },
        ].map((f, i) => (
          <div
            key={i}
            className="group velo-card p-5 hover:shadow-elevated hover:-translate-y-1 transition-all duration-300 animate-fade-in-up"
            style={{ animationDelay: `${i * 100}ms` }}
          >
            <div className={`inline-flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br ${f.color} dark:bg-velo-600 dark:from-velo-600 dark:to-velo-600 text-white mb-3 shadow-lg group-hover:scale-110 transition-transform duration-300`}>
              {f.icon}
            </div>
            <h3 className="text-sm font-semibold text-velo-900 mb-1">{f.title}</h3>
            <p className="text-xs text-slate-500 leading-relaxed">{f.desc}</p>
          </div>
        ))}
      </div>

      {/* ===========================================================
          CHOOSE YOUR PATH: BORROWER OR INVESTOR
          =========================================================== */}
      <div className="mb-14 sm:mb-20">
        <div className="text-center mb-10 animate-fade-in-up">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-velo-50 border border-velo-100 text-velo-700 text-xs font-semibold mb-4">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-velo-500 animate-pulse" />
            ONE ACCOUNT • UNLIMITED POSSIBILITIES
          </div>
          <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-velo-900 mb-3">Choose how you want to grow</h2>
          <p className="text-sm sm:text-base text-slate-600 max-w-2xl mx-auto">
            Whether you need funds for your next move or want your money to work for you — Velo has you covered. Switch between roles anytime.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 sm:gap-6">
          {/* BORROWER CARD */}
          <div className="relative group velo-card overflow-hidden p-6 sm:p-8 hover:shadow-elevated hover:-translate-y-1 transition-all duration-500 animate-fade-in-up">
            <div className="absolute top-0 right-0 w-40 h-40 bg-gradient-to-br from-velo-100 to-transparent rounded-full blur-2xl opacity-60 -translate-y-1/2 translate-x-1/2 group-hover:scale-125 transition-transform duration-700" />
            <div className="relative">
              <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-velo-600 to-velo-500 text-white mb-5 shadow-lg shadow-velo-500/30 group-hover:scale-110 transition-transform duration-300">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-xl sm:text-2xl font-bold text-velo-900">I want to Borrow</h3>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-velo-100 text-velo-700 text-[10px] font-bold uppercase tracking-wider">Popular</span>
              </div>
              <p className="text-sm text-slate-600 mb-6 leading-relaxed">
                Access quick loans for personal needs or business expansion. Transparent fees, flexible tenors, and fast disbursements.
              </p>
              <ul className="space-y-3 mb-7">
                {[
                  "Personal loans up to ₦5,000,000",
                  "Business loans tailored to your revenue",
                  "Flexible tenors from 30 to 180 days",
                  "No hidden fees — see everything upfront",
                  "Fast approval & disbursement to your bank",
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-velo-100 text-velo-600 mt-0.5 group-hover:bg-velo-500 group-hover:text-white transition-colors">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </span>
                    <span className="text-sm text-slate-700">{item}</span>
                  </li>
                ))}
              </ul>
              <div className="grid grid-cols-2 gap-3 mb-7 p-4 rounded-2xl bg-gradient-to-br from-velo-50 to-white border border-velo-100">
                <div>
                  <div className="text-2xl font-bold text-velo-700">30m</div>
                  <div className="text-[11px] text-slate-500 font-medium">Avg. approval</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-velo-700">50K+</div>
                  <div className="text-[11px] text-slate-500 font-medium">Happy borrowers</div>
                </div>
              </div>
              <div className="space-y-2.5">
                <Link
                  to="/account?mode=register&role=BORROWER"
                  className="w-full inline-flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl bg-gradient-to-r from-velo-600 to-velo-500 text-white font-semibold shadow-lg shadow-velo-500/25 transition-all duration-200 hover:shadow-xl hover:shadow-velo-500/40 hover:scale-[1.02] active:scale-[0.98] group/btn"
                >
                  Apply for a Loan
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="group-hover/btn:translate-x-1 transition-transform">
                    <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </Link>
                <div className="grid grid-cols-2 gap-2.5">
                  <Link to="/account?mode=register&role=BORROWER&type=PERSONAL" className="text-center px-3 py-2.5 rounded-lg text-sm font-semibold text-velo-700 bg-velo-50 hover:bg-velo-100 transition-colors">Personal Loan</Link>
                  <Link to="/account?mode=register&role=BORROWER&type=BUSINESS" className="text-center px-3 py-2.5 rounded-lg text-sm font-semibold text-velo-700 bg-velo-50 hover:bg-velo-100 transition-colors">Business Loan</Link>
                </div>
              </div>
            </div>
          </div>

          {/* INVESTOR CARD */}
          <div className="relative group velo-card overflow-hidden p-6 sm:p-8 hover:shadow-elevated hover:-translate-y-1 transition-all duration-500 animate-fade-in-up border-2 border-emerald-100 dark:border-emerald-900/40" style={{ animationDelay: "100ms" }}>
            <div className="absolute top-0 right-0 w-40 h-40 bg-gradient-to-br from-emerald-100 to-transparent rounded-full blur-2xl opacity-60 -translate-y-1/2 translate-x-1/2 group-hover:scale-125 transition-transform duration-700" />
            <div className="absolute top-4 right-4 z-10">
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 text-white text-[10px] font-bold uppercase tracking-wider shadow-md shadow-emerald-500/30 animate-pulse-glow">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="5" fill="currentColor"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                Earn Up to 18%
              </div>
            </div>
            <div className="relative">
              <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-600 to-emerald-500 text-white mb-5 shadow-lg shadow-emerald-500/30 group-hover:scale-110 transition-transform duration-300">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M3 3v18h18M7 14l4-4 4 4 5-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <h3 className="text-xl sm:text-2xl font-bold text-velo-900 mb-2">I want to Invest</h3>
              <p className="text-sm text-slate-600 mb-6 leading-relaxed">
                Grow your wealth with competitive returns. Fund vetted loans and earn passive income with security.
              </p>
              <ul className="space-y-3 mb-7">
                {[
                  "Up to 18% annual returns on investments",
                  "Flexible tenors — 30, 60, 90, 180 days",
                  "KYC-verified borrowers & loan insurance",
                  "Auto-settlement direct to your bank account",
                  "Early liquidity available when you need it",
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-emerald-600 mt-0.5 group-hover:bg-emerald-500 group-hover:text-white transition-colors">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </span>
                    <span className="text-sm text-slate-700">{item}</span>
                  </li>
                ))}
              </ul>
              <div className="grid grid-cols-2 gap-3 mb-7 p-4 rounded-2xl bg-gradient-to-br from-emerald-50 to-white border border-emerald-100">
                <div>
                  <div className="text-2xl font-bold text-emerald-700">18%</div>
                  <div className="text-[11px] text-slate-500 font-medium">Max annual return</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-emerald-700">₦100K</div>
                  <div className="text-[11px] text-slate-500 font-medium">Minimum investment</div>
                </div>
              </div>
              <div className="space-y-2.5">
                <Link
                  to="/account?mode=register&role=INVESTOR"
                  className="w-full inline-flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold shadow-lg shadow-emerald-500/25 transition-all duration-200 hover:shadow-xl hover:shadow-emerald-500/40 hover:scale-[1.02] active:scale-[0.98] group/btn"
                >
                  Start Investing
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="group-hover/btn:translate-x-1 transition-transform">
                    <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </Link>
                <Link
                  to="/account?mode=login"
                  className="w-full text-center px-3 py-2.5 rounded-lg text-sm font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition-colors"
                >
                  Already an investor? Sign in
                </Link>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 text-center animate-fade-in-up" style={{ animationDelay: "200ms" }}>
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-slate-50 border border-slate-200 text-xs text-slate-600">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-velo-500"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            <span><strong className="text-velo-700">One KYC.</strong> Once you're verified, use both borrower and investor features seamlessly.</span>
          </div>
        </div>
      </div>

      {/* ===========================================================
          ALL-IN-ONE DIGITAL BANKING SECTION
          =========================================================== */}
      <div className="velo-card p-0 overflow-hidden mb-14 sm:mb-20 shadow-elevated rounded-3xl">
        <div className="grid grid-cols-1 lg:grid-cols-2">
          <div className="relative p-7 sm:p-10 bg-gradient-to-br from-velo-900 via-velo-800 to-velo-700 dark:bg-velo-900 dark:from-velo-900 dark:via-velo-900 dark:to-velo-900 dark:animate-none overflow-hidden">
            <div className="absolute inset-0 opacity-20 dark:opacity-10">
              <div className="absolute top-0 right-0 w-80 h-80 bg-velo-300 dark:bg-velo-800 rounded-full blur-3xl translate-x-1/3 -translate-y-1/3 animate-float" />
              <div className="absolute bottom-0 left-0 w-64 h-64 bg-violet-400 dark:bg-velo-900 rounded-full blur-3xl -translate-x-1/4 translate-y-1/4 animate-float-slow opacity-50 dark:opacity-30" />
            </div>
            <div className="relative">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-gradient-to-r from-velo-400/20 to-velo-300/20 dark:bg-velo-800/50 dark:from-velo-800/50 dark:to-velo-800/50 border border-velo-300/30 dark:border-velo-700 text-velo-100 text-xs font-semibold mb-5 animate-pulse-glow">
                <StarIcon />
                ALL-IN-ONE PLATFORM
              </div>
              <h2 className="text-2xl sm:text-3xl font-semibold text-white mb-4 leading-tight">
                More than just loans.
                <br />
                <span className="bg-gradient-to-r from-velo-200 via-white to-velo-100 dark:bg-none dark:!text-velo-200 bg-clip-text text-transparent dark:bg-clip-border">
                  A complete digital bank.
                </span>
              </h2>
              <p className="text-sm sm:text-base text-white/80 leading-relaxed mb-7 max-w-md">
                Loans are at the heart of Velo Finance LTD. Alongside lending, manage transfers, bill payments, gift cards, crypto, global payments, international collections, joint accounts, and USD virtual cards in one platform.
              </p>

              <div className="space-y-4 mb-8">
                <FeatureRow icon={<CryptoIcon />} title="Crypto Trading" desc="Buy, sell & swap BTC, ETH, USDT and 50+ cryptocurrencies at competitive rates" badge="Live Rates" badgeColor="sky" />
                <FeatureRow icon={<GiftCardIcon />} title="Gift Card Marketplace" desc="Buy & redeem Amazon, iTunes, Google Play, Steam, Nike and 100+ global gift cards" badge="Instant" badgeColor="emerald" />
                <FeatureRow icon={<GlobeIcon />} title="Global Payments & Collections" desc="Send globally and receive customer payments internationally with confidence" badge="Global" badgeColor="sky" />
                <FeatureRow icon={<SendIcon />} title="Transfers & Joint Accounts" desc="Move money, share financial access, and manage payments together" badge="24/7" badgeColor="sky" />
                <FeatureRow icon={<BillIcon />} title="Bill Payments & Airtime" desc="Pay electricity, cable, internet, water bills and buy airtime/data for any network" />
                <FeatureRow icon={<WalletIcon />} title="Secure Smart Wallet" desc="Multi-currency wallet with real-time transaction history and spending insights" />
                <FeatureRow icon={<CardIcon />} title="USD Virtual Cards" desc="Create secure virtual dollar cards for online subscriptions and global purchases" />
              </div>

              <a
                href={`https://${config.companyWebsite}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-6 py-3.5 rounded-xl bg-white text-velo-700 font-semibold shadow-lg transition-all duration-300 hover:shadow-xl hover:scale-[1.02] active:scale-[0.98] group animate-pulse-glow"
              >
                Visit Velo Banking
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="group-hover:rotate-45 transition-transform duration-300">
                  <path d="M14 3h7v7M21 3L10 14M21 14v7H3V3h7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </a>
            </div>
          </div>

          <div className="p-7 sm:p-10 bg-gradient-to-br from-slate-50 to-white dark:bg-slate-950 dark:from-slate-950 dark:to-slate-950 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-40 h-40 bg-gradient-to-br from-velo-100 to-velo-50 dark:bg-velo-900/30 dark:from-velo-900/30 dark:to-velo-900/30 rounded-full blur-3xl opacity-60 dark:opacity-30" />
            <div className="absolute bottom-0 left-0 w-48 h-48 bg-gradient-to-br from-velo-50 to-velo-100 dark:bg-velo-800/20 dark:from-velo-800/20 dark:to-velo-800/20 rounded-full blur-3xl opacity-60 dark:opacity-25" />

            <div className="relative mx-auto max-w-sm animate-float">
              <div className="absolute -inset-4 bg-gradient-to-br from-velo-100 via-velo-50 to-slate-100 dark:bg-velo-700/30 dark:from-velo-700/30 dark:via-transparent dark:to-transparent rounded-[2.5rem] blur-xl opacity-70 dark:opacity-50" />
              <div className="relative bg-gradient-to-br from-velo-900 via-velo-800 to-velo-700 dark:bg-velo-900 dark:from-velo-900 dark:via-velo-900 dark:to-velo-900 rounded-[2rem] p-5 shadow-elevated border border-white/10 dark:border-velo-800 overflow-hidden">
                <div className="absolute inset-0 opacity-[0.04]" style={{backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '20px 20px'}} />
                <div className="relative">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-2">
                      <div className="h-8 w-8 rounded-lg bg-white/15 flex items-center justify-center">
                        <LogoIconSmall />
                      </div>
                      <div>
                        <div className="text-white font-semibold text-sm">Velo Finance</div>
                        <div className="text-white/50 text-[10px]">Super App</div>
                      </div>
                    </div>
                    <div className="h-8 w-8 rounded-full bg-white/10 flex items-center justify-center">
                      <BellIcon />
                    </div>
                  </div>

                  <div className="mb-6">
                    <div className="text-white/60 text-xs mb-1">Total Balance (USD + NGN)</div>
                    <div className="text-white text-3xl font-semibold tracking-tight flex items-center gap-1">
                      <span>₦</span>
                      <span>2,847,500</span>
                      <span className="text-lg">.80</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-emerald-400 text-[10px] font-semibold">+₦3,240.50</span>
                      <span className="text-emerald-400/80 text-[10px] bg-emerald-400/10 px-1.5 py-0.5 rounded">▲ 2.4%</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-2 mb-5">
                    {[
                      { icon: <MiniSendIcon />, label: "Send" },
                      { icon: <MiniReceiveIcon />, label: "Receive" },
                      { icon: <MiniCryptoIcon />, label: "Crypto" },
                      { icon: <MiniGiftIcon />, label: "Cards" },
                    ].map((a, i) => (
                      <button key={i} className="flex flex-col items-center gap-1.5 p-2.5 rounded-xl bg-white/10 hover:bg-white/15 transition-all duration-200 border border-white/5 hover:scale-105">
                        <div className="text-white">{a.icon}</div>
                        <div className="text-white/80 text-[10px] font-semibold">{a.label}</div>
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-4 gap-2 mb-5">
                    {[
                      { icon: <MiniBillIcon />, label: "Bills" },
                      { icon: <MiniTopupIcon />, label: "Topup" },
                      { icon: <MiniGlobeIcon />, label: "FX" },
                      { icon: <MiniLoanIcon />, label: "Loans" },
                    ].map((a, i) => (
                      <button key={i} className="flex flex-col items-center gap-1.5 p-2.5 rounded-xl bg-white/10 hover:bg-white/15 transition-all duration-200 border border-white/5 hover:scale-105">
                        <div className="text-white">{a.icon}</div>
                        <div className="text-white/80 text-[10px] font-semibold">{a.label}</div>
                      </button>
                    ))}
                  </div>

                  <div className="space-y-2">
                    <div className="text-white/60 text-[10px] font-semibold uppercase tracking-wider mb-2">Recent Activity</div>
                    {[
                      { name: "BTC Purchase", desc: "Crypto Wallet", amount: "-₦450,000", pos: false, tag: "crypto" },
                      { name: "Bank Transfer", desc: "From John Doe", amount: "+₦250,000", pos: true, tag: "transfer" },
                      { name: "Amazon Gift Card", desc: "$100 USD Card", amount: "-₦98,500", pos: false, tag: "giftcard" },
                      { name: "Electricity Bill", desc: "Ikeja Electric", amount: "-₦28,500", pos: false, tag: "bill" },
                    ].map((t, i) => (
                      <div key={i} className="flex items-center gap-3 p-2.5 rounded-xl bg-white/5 hover:bg-white/10 transition-all duration-200 border border-white/5">
                        <div className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${t.pos ? "bg-emerald-500/15 text-emerald-400" : t.tag === "crypto" ? "bg-sky-500/15 text-sky-400" : t.tag === "giftcard" ? "bg-velo-500/15 text-velo-400" : "bg-rose-500/15 text-rose-400"}`}>
                          {t.pos ? <MiniInIcon /> : t.tag === "crypto" ? <MiniCryptoIcon /> : t.tag === "giftcard" ? <MiniGiftIcon /> : <MiniOutIcon />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-white text-xs font-semibold truncate">{t.name}</div>
                          <div className="text-white/50 text-[10px] truncate">{t.desc}</div>
                        </div>
                        <div className={`text-xs font-semibold ${t.pos ? "text-emerald-400" : "text-white"}`}>{t.amount}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ===========================================================
          TRUST + TESTIMONIALS
          =========================================================== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-14 sm:mb-20">
        <div className="lg:col-span-2 velo-card p-6 sm:p-7 relative overflow-hidden rounded-3xl">
          <div className="absolute -top-24 -right-20 h-64 w-64 rounded-full bg-velo-100/50 dark:bg-velo-800/20 blur-3xl" />
          <div className="relative flex items-start justify-between gap-4 mb-6">
            <div className="flex items-start gap-4">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-velo-600 to-velo-400 dark:bg-velo-600 dark:from-velo-600 dark:to-velo-600 text-white shadow-lg shadow-velo-500/20 shrink-0">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path d="M12 2l9 4v6c0 5-3.5 8.5-9 10-5.5-1.5-9-5-9-10V6l9-4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
                  <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] font-semibold text-velo-600 mb-1">Trusted lending partner</p>
                <h2 className="text-xl sm:text-2xl font-semibold text-velo-900 mb-1">Why choose Velo Finance?</h2>
                <p className="text-sm text-slate-500">Simple loans, clear terms, and support when it matters.</p>
              </div>
            </div>
            <div className="hidden sm:flex items-center gap-1 rounded-full bg-velo-50 px-3 py-1.5 text-xs font-semibold text-velo-700">
              <ShieldIcon /> Secure &amp; trusted
            </div>
          </div>

          <div className="relative grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { stat: "50,000+", label: "Happy Customers", icon: <UsersIcon /> },
              { stat: "₦1B+", label: "Loans Disbursed", icon: <NairaIcon /> },
              { stat: "24/7", label: "Support Available", icon: <ChatIcon /> },
              { stat: "4.9★", label: "Average Rating", icon: <StarIcon /> },
            ].map((s, i) => (
              <div key={i} className="group relative overflow-hidden rounded-2xl border border-slate-200/80 bg-gradient-to-br from-white to-slate-50/80 dark:bg-slate-900 dark:from-slate-900 dark:to-slate-900 p-4 sm:p-5 transition-all duration-300 hover:-translate-y-1 hover:border-velo-200 dark:hover:border-velo-700 hover:shadow-[0_12px_30px_-16px_rgba(33,150,243,0.45)] animate-fade-in-up" style={{ animationDelay: `${i * 80}ms` }}>
                <div className="absolute -right-5 -top-5 h-20 w-20 rounded-full bg-velo-100/50 dark:bg-velo-800/15 blur-2xl transition-transform duration-300 group-hover:scale-150" />
                <div className="relative flex items-center gap-3">
                  <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-velo-50 text-velo-600 shadow-sm ring-1 ring-velo-100 group-hover:bg-velo-500 group-hover:text-white transition-colors">
                    {s.icon}
                  </div>
                  <div>
                    <div className="mb-1 text-2xl font-semibold leading-none text-velo-700 sm:text-3xl">{s.stat}</div>
                    <div className="text-xs font-semibold text-slate-600">{s.label}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="relative mt-6 overflow-hidden rounded-2xl border border-velo-100 bg-gradient-to-br from-velo-50/80 to-white dark:bg-slate-900 dark:from-slate-900 dark:to-slate-900 dark:border-slate-700 p-5 sm:p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.16em] font-semibold text-velo-600">Borrower stories</p>
                <h3 className="text-base font-semibold text-velo-900">Real people. Real loan progress.</h3>
              </div>
              <div className="flex items-center gap-1.5" aria-label={`Testimonial ${testimonialIndex + 1} of ${TESTIMONIALS.length}`}>
                <button type="button" onClick={() => setTestimonialIndex((current) => (current - 1 + TESTIMONIALS.length) % TESTIMONIALS.length)} className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-velo-200 bg-white dark:bg-slate-800 text-velo-600 transition hover:bg-velo-500 hover:text-white" aria-label="Previous testimonial">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
                <button type="button" onClick={() => setTestimonialIndex((current) => (current + 1) % TESTIMONIALS.length)} className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-velo-200 bg-white dark:bg-slate-800 text-velo-600 transition hover:bg-velo-500 hover:text-white" aria-label="Next testimonial">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              </div>
            </div>
            <div className="overflow-hidden">
              <div className="flex transition-transform duration-500 ease-out" style={{ transform: `translateX(-${testimonialIndex * 100}%)` }}>
                {TESTIMONIALS.map((testimonial) => (
                  <article key={testimonial.name} className="w-full shrink-0 pr-1">
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-velo-500 to-velo-700 dark:bg-velo-600 dark:from-velo-600 dark:to-velo-600 text-xs font-semibold text-white shadow-md">{testimonial.initials}</div>
                      <div className="min-w-0">
                        <div className="mb-1 flex items-center gap-2"><span className="text-sm font-semibold text-velo-900">{testimonial.name}</span><span className="text-amber-500 text-xs tracking-tight">★★★★★</span></div>
                        <p className="text-sm leading-relaxed text-slate-700 italic">“{testimonial.quote}”</p>
                        <p className="mt-2 text-[11px] font-medium text-slate-500">{testimonial.meta}</p>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
            <div className="mt-4 flex gap-1.5" aria-hidden="true">
              {TESTIMONIALS.map((testimonial, index) => <span key={testimonial.name} className={`h-1.5 rounded-full transition-all duration-300 ${index === testimonialIndex ? "w-5 bg-velo-500" : "w-1.5 bg-velo-200"}`} />)}
            </div>
          </div>
        </div>

        <div className="relative velo-card p-6 sm:p-7 bg-gradient-to-br from-velo-50 to-white dark:bg-slate-900 dark:from-slate-900 dark:to-slate-900 overflow-hidden rounded-3xl">
          <div className="absolute top-0 right-0 w-32 h-32 bg-velo-200/40 dark:bg-velo-800/20 rounded-full blur-2xl" />
          <div className="relative">
            <h3 className="text-lg font-semibold text-velo-900 mb-3">Need assistance?</h3>
            <p className="text-sm text-slate-600 mb-5 leading-relaxed">
              Our dedicated loan officers are here to guide you through the process. Get answers to any questions you may have.
            </p>
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 rounded-xl bg-white dark:bg-slate-800 border border-slate-100 hover:border-velo-200 hover:shadow-sm transition-all duration-300 group">
                <div className="h-9 w-9 rounded-lg bg-velo-50 text-velo-600 flex items-center justify-center shrink-0 group-hover:bg-velo-500 group-hover:text-white transition-colors">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.37 1.9.72 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0122 16.92z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Call us</div>
                  <a href="tel:08080000440" className="text-sm font-semibold text-velo-900 hover:text-velo-600">08080000440</a>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-xl bg-white dark:bg-slate-800 border border-slate-100 hover:border-velo-200 hover:shadow-sm transition-all duration-300 group">
                <div className="h-9 w-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0 group-hover:bg-emerald-500 group-hover:text-white transition-colors">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M22 6l-10 7L2 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Email us</div>
                  <div className="text-sm font-semibold text-velo-900">loans@velofinance.co</div>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-xl bg-white dark:bg-slate-800 border border-slate-100 hover:border-velo-200 hover:shadow-sm transition-all duration-300 group">
                <div className="h-9 w-9 rounded-lg bg-sky-50 text-sky-600 flex items-center justify-center shrink-0 group-hover:bg-sky-500 group-hover:text-white transition-colors">
                  <ChatIcon />
                </div>
                <div>
                  <div className="text-xs text-slate-500">Live Chat</div>
                  <div className="text-sm font-semibold text-velo-900">Available 24/7</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ===========================================================
          FINAL CTA
          =========================================================== */}
      <div className="velo-card p-6 sm:p-8 mb-10 text-center bg-gradient-to-r from-velo-700 via-velo-600 to-velo-500 dark:bg-velo-700 dark:from-velo-700 dark:via-velo-700 dark:to-velo-700 dark:animate-none text-white relative overflow-hidden rounded-3xl">
        <div className="absolute inset-0 opacity-20 dark:opacity-10">
          <div className="absolute top-0 left-1/4 w-72 h-72 bg-white dark:bg-velo-600 rounded-full blur-3xl -translate-y-1/2 animate-float" />
          <div className="absolute bottom-0 right-1/4 w-72 h-72 bg-white dark:bg-velo-800 rounded-full blur-3xl translate-y-1/2 animate-float-slow" />
        </div>
        <div className="relative">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/15 backdrop-blur-sm border border-white/20 text-white text-xs font-semibold mb-4">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300 animate-pulse" />
            LIMITED TIME: Reduced processing fees this month
          </div>
          <h2 className="text-xl sm:text-3xl font-semibold mb-2">Ready to get funded?</h2>
          <p className="text-sm sm:text-base text-white/85 mb-6 max-w-xl mx-auto">
            Start your loan application today and get access to the funds you need to achieve your goals. Join thousands of happy customers.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link to="/apply" className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white text-velo-700 font-semibold shadow-lg transition-all duration-300 hover:shadow-xl hover:scale-[1.02] active:scale-[0.98] group animate-pulse-glow">
              Start New Application
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="group-hover:translate-x-1 transition-transform">
                <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </Link>
            <a href={`https://${config.companyWebsite}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white/10 backdrop-blur-sm text-white font-semibold border border-white/20 transition-all duration-300 hover:bg-white/20 hover:scale-[1.02]">
              Explore Velo Banking
            </a>
          </div>
        </div>
      </div>

      {(hardErrors.length > 0 || warnings.length > 0) && (
        <div className={`mt-10 rounded-xl border p-4 ${hardErrors.length > 0 ? "bg-red-50 border-red-200" : "bg-amber-50 border-amber-200"}`}>
          <h3 className={`text-sm font-semibold ${hardErrors.length > 0 ? "text-red-700" : "text-amber-800"}`}>
            Configuration Notice
          </h3>
          <ul className="mt-2 space-y-1 text-xs text-slate-700">
            {[...hardErrors, ...warnings].map((e, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="text-slate-400">•</span>
                <span><strong className="text-slate-800">{e.key}:</strong> {e.message}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500">
            Edit your <code className="bg-slate-100 px-1 py-0.5 rounded">.env</code> file or configure these via the Admin Dashboard &gt; Loan Settings.
          </p>
        </div>
      )}
    </Layout>
  );
}

/* =======================================================================
   Reusable helpers
   ======================================================================= */

function BadgePill({ children, accent = "velo" }: { children: React.ReactNode; accent?: "velo" | "amber" | "slate" }) {
  const colors: Record<string, string> = {
    velo: "bg-velo-50 text-velo-700 border-velo-100",
    amber: "bg-amber-50 text-amber-700 border-amber-100",
    slate: "bg-slate-50 text-slate-700 border-slate-200",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] font-semibold ${colors[accent]}`}>
      {children}
    </span>
  );
}

function MiniTrust({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-100 text-slate-600 text-[10px] font-semibold shadow-sm">
      <span className="text-emerald-500">{icon}</span>
      {label}
    </div>
  );
}

function MiniMetric({ label, value, compact }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className="rounded-xl bg-white/10 backdrop-blur-sm border border-white/15 px-3 py-2 hover:bg-white/15 transition">
      <div className="text-[9px] text-white/70 font-semibold uppercase tracking-wider mb-0.5">{label}</div>
      <div className={`font-semibold text-white ${compact ? "text-xs leading-tight" : "text-sm sm:text-base"}`}>
        {value}
      </div>
    </div>
  );
}

function BreakdownRow({
  label, value, tag, bold, accent, muted,
}: { label: string; value: string; tag?: string; bold?: boolean; accent?: "velo"; muted?: boolean }) {
  return (
    <div className={`flex items-start justify-between gap-3 py-1.5 ${muted ? "opacity-60" : ""}`}>
      <div className="flex-1 min-w-0">
        <div className={`text-xs ${bold ? "font-semibold text-velo-900" : "font-semibold text-slate-600"} ${accent === "velo" ? "text-velo-900" : ""}`}>
          {label}
        </div>
        {tag && <div className="text-[10px] text-slate-400 mt-0.5">{tag}</div>}
      </div>
      <div className={`text-xs font-semibold shrink-0 ${accent === "velo" ? "text-velo-700" : bold ? "text-velo-900" : "text-slate-700"}`}>
        {value}
      </div>
    </div>
  );
}

function FeatureRow({
  icon, title, desc, badge, badgeColor,
}: { icon: React.ReactNode; title: string; desc: string; badge?: string; badgeColor?: "amber" | "emerald" | "sky" | "violet" }) {
  const badgeStyles: Record<string, string> = {
    amber: "bg-amber-400/20 text-amber-200 border-amber-300/30",
    emerald: "bg-emerald-400/20 text-emerald-200 border-emerald-300/30",
    sky: "bg-sky-400/20 text-sky-200 border-sky-300/30",
    violet: "bg-violet-400/20 text-violet-200 border-violet-300/30",
  };
  return (
    <div className="flex items-start gap-3 group animate-fade-in-up">
      <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 text-white shrink-0 border border-white/10 group-hover:bg-white/15 group-hover:scale-110 transition-all duration-300">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-white font-semibold">{title}</span>
          {badge && (
            <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-full border ${badgeStyles[badgeColor || "amber"]}`}>
              {badge}
            </span>
          )}
        </div>
        <p className="text-xs text-white/70 mt-0.5 leading-relaxed">{desc}</p>
      </div>
    </div>
  );
}

/* =======================================================================
   Icon set
   ======================================================================= */

function SpeedIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M12 2a10 10 0 00-7 17l1.5-1.5M12 22a10 10 0 007-17L17.5 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M12 7l3 5H9l3-5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
    </svg>
  );
}
function CalcIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <rect x="4" y="2" width="16" height="20" rx="2" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M8 7h8M8 11h2M12 11h2M16 11h.01M8 15h2M12 15h2M16 15h.01M8 19h2M12 19h2M16 19h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M12 2l9 4v6c0 5-3.5 8.5-9 10-5.5-1.5-9-5-9-10V6l9-4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function FlexIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M3 10h18M8 4v16M16 4v16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
    </svg>
  );
}
function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function BillIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
      <path d="M14 2v6h6M9 13h7M9 17h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
}
function WalletIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M21 12V8a2 2 0 00-2-2H5a2 2 0 010-4h12v4M3 7h17a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V9a2 2 0 012-2z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="16" cy="14" r="1.5" fill="currentColor"/>
    </svg>
  );
}
function CardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M2 10h20M6 15h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
}
function CryptoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M12 2L3 7v10l9 5 9-5V7l-9-5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
      <path d="M12 2v20M3 7l9 5 9-5M3 17l9 5 9-5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" opacity="0.6"/>
      <circle cx="12" cy="12" r="2.5" fill="currentColor" opacity="0.8"/>
    </svg>
  );
}
function GiftCardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="8" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.6"/>
      <path d="M3 12h18M12 8v13" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
      <path d="M12 8c-1.5-3-4-3-4-1 0 1.5 4 3 4 3s4-1.5 4-3c0-2-2.5-2-4 1z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
    </svg>
  );
}
function GlobeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6"/>
      <path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
    </svg>
  );
}
function BellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function LogoIconSmall() {
  return (
    <svg width="16" height="16" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 16 H34 a14 14 0 0 1 0 28 H18 Z M18 22 V44 M28 22 V44" stroke="white" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="44" cy="42" r="3" fill="white"/>
    </svg>
  );
}
function MiniSendIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>); }
function MiniReceiveIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M19 12l-7 7-7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>); }
function MiniBillIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M14 2v6h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>); }
function MiniTopupIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>); }
function MiniInIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M19 12l-7 7-7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>); }
function MiniOutIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>); }
function MiniCryptoIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"/><path d="M9 8h5a2.5 2.5 0 010 5H9zM9 13h6a2.5 2.5 0 010 5H9z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>); }
function MiniGiftIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="8" width="18" height="4" rx="1" stroke="currentColor" strokeWidth="2"/><path d="M12 8v13M5 12v9h14v-9M12 8c-1.5-2.5-3.5-2.5-3.5-1 0 1.2 3.5 2.5 3.5 2.5s3.5-1.3 3.5-2.5c0-1.5-2-1.5-3.5 1z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>); }
function MiniGlobeIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"/><path d="M3 12h18M12 3c2 3 2 15 0 18M12 3c-2 3-2 15 0 18" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>); }
function MiniLoanIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>); }

/* Trust / stat icons */
function ShieldLockIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2l9 4v6c0 5-3.5 8.5-9 10-5.5-1.5-9-5-9-10V6l9-4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><rect x="9" y="11" width="6" height="5" rx="1" stroke="currentColor" strokeWidth="1.6"/><path d="M11 11V9a1 1 0 112 0v2" stroke="currentColor" strokeWidth="1.6"/></svg>); }
function CbnIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 21h18M5 21V10M19 21V10M3 10l9-6 9 6M9 21v-5h6v5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg>); }
function InsuredIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2l10 5v6c0 5-4 8.5-10 10-6-1.5-10-5-10-10V7l10-5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>); }
function PartnerDotIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4" fill="currentColor" opacity="0.5"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>); }
function UsersIcon() { return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="1.8"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>); }
function NairaIcon() { return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 20V4h2l10 16V4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><path d="M5 10h12M5 16h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>); }
function ChatIcon() { return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg>); }
function StarIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="#2196F3"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>); }
