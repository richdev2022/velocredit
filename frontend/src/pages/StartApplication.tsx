import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { config, getLoanProgram, validateConfig } from "../utils/config";
import { calculateMonthlyInterest, calculateLoan, formatNaira, formatDateLabel, getSuggestedLoanAmounts } from "../utils/loanCalculator";
import { resolveFeesForTenure } from "../utils/config";

/* =======================================================================
   Real corporate photography — verified reachable CDN assets.
   Watermarked stock frames are cropped via object-position (top).
   ======================================================================= */
const IMG = {
  heroMain: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/9cf57c9c8780.jpg",
  heroSecondary: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/1aa84691eff3.jpg",
  boardroom: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/cc828a1e4901.jpg",
  shopKiosk: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/30320be523de.jpg",
  shopOwner: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/d6a725a11f4a.jpg",
  support: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/96e732cafbb2.jpg",
  handshake: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/15c46d8ff651.jpg",
  professional: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/aa827b9398af.jpg",
};

const TESTIMONIALS = [
  { quote: "The application was simple, and the repayment terms were clear from the start. I received the funds I needed for my shop without unnecessary delays.", name: "Amaka Okafor", meta: "Lagos • Fashion Brand Owner", photo: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/84dd7c29b4d6.jpg" },
  { quote: "Velo gave my business the working capital to restock quickly. The process was straightforward and the team kept me updated throughout.", name: "Chinedu Eze", meta: "Anambra • Retail Business Owner", photo: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/21511fc2ebe8.jpg" },
  { quote: "I used my personal loan to handle an urgent family expense. The digital application saved me time and I knew exactly what I would repay.", name: "Fatima Bello", meta: "Abuja • Customer", photo: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/019d52fe2212.jpg" },
  { quote: "The flexible tenure made the loan manageable for my business. I could plan my cash flow properly before accepting the offer.", name: "Tunde Adebayo", meta: "Ibadan • Logistics Operator", photo: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/036bbfda6798.jpg" },
  { quote: "I was impressed by how clearly every fee was explained. There were no surprises, and the funds arrived when my business needed them.", name: "Blessing Nwosu", meta: "Enugu • Catering Entrepreneur", photo: "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/d96e6274a201.jpg" },
];

const FAQS = [
  { q: "Who can apply for a Velo loan?", a: "Any Nigerian adult with a valid BVN/NIN, a bank account and a verifiable source of income can apply. We serve salaried professionals, self-employed traders, SMEs and business owners across personal and business loan products." },
  { q: "How fast will I receive the money?", a: "Most applications receive a decision within 30 minutes during business hours. Once your loan is approved and you accept the offer, funds are disbursed directly to your bank account — often within the same hour." },
  { q: "What documents do I need?", a: "A government-issued ID (NIN, driver's licence or passport), your BVN, a proof of address, and for business loans your business registration or financial statements. Everything is uploaded digitally — no branch visits required." },
  { q: "Are there any hidden charges?", a: "None. Every fee — interest, service fee and processing fee — is shown in the transparent breakdown before you accept your offer. What you see on the calculator is what you repay." },
  { q: "How is my data protected?", a: "We are NDPR-compliant and use bank-grade 256-bit encryption for all data in transit and at rest. Your information is only used for credit assessment and is never sold to third parties." },
  { q: "Can I invest as well as borrow?", a: "Yes — one verified account unlocks both. Fund vetted loans as an investor and earn up to 18% annually, or apply for a loan whenever you need working capital." },
];

const TRUST_ITEMS = [
  { icon: <CbnIcon />, label: "CBN-Licensed Partner" },
  { icon: <ShieldLockIcon />, label: "NDPR Compliant" },
  { icon: <InsuredIcon />, label: "Loans Insured" },
  { icon: <LockIcon />, label: "256-bit Encryption" },
  { icon: <DocCheckIcon />, label: "KYC-Verified Borrowers" },
  { icon: <StarIcon />, label: "4.9/5 Customer Rating" },
  { icon: <ClockIcon />, label: "30-Min Avg. Decision" },
  { icon: <NairaIcon />, label: "₦1B+ Disbursed" },
];

export default function StartApplication() {
  const [testimonialIndex, setTestimonialIndex] = useState(0);
  const [openFaq, setOpenFaq] = useState(0);
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

  /* Explicit responsive grids for tenures (JIT-safe, no dynamic class names) */
  const tenureGridClass =
    personalProgram.tenures.length <= 3 ? "grid-cols-3"
    : personalProgram.tenures.length <= 4 ? "grid-cols-2 sm:grid-cols-4"
    : personalProgram.tenures.length === 5 ? "grid-cols-3 sm:grid-cols-5"
    : "grid-cols-3 sm:grid-cols-6";

  return (
    <Layout>
      {/* ===========================================================
          1. HERO — dark corporate cinema, real photography
          =========================================================== */}
      <section className="relative -mx-4 sm:-mx-6 -mt-6 sm:-mt-10 overflow-hidden bg-velo-900">
        {/* Layered navy gradient */}
        <div className="absolute inset-0 bg-gradient-to-br from-[#101B33] via-velo-900 to-[#16233E]" />
        {/* Dot grid texture */}
        <div className="absolute inset-0 opacity-[0.05]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #FFFFFF 1px, transparent 0)", backgroundSize: "32px 32px" }} />
        {/* Cinematic ambient video — muted looping fintech network, blended into
            the navy gradient (screen blend: black pixels vanish, teal lines glow).
            Hidden for users who prefer reduced motion. */}
        <video
          className="absolute inset-0 w-full h-full object-cover opacity-20 sm:opacity-25 mix-blend-screen pointer-events-none motion-reduce:hidden"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-hidden="true"
          tabIndex={-1}
        >
          <source src="https://videos.pexels.com/video-files/3129671/3129671-hd_1280_720_30fps.mp4" type="video/mp4" />
        </video>
        {/* Ambient orbs */}
        <div className="absolute -top-40 -left-32 w-[30rem] h-[30rem] bg-velo-500/20 rounded-full blur-3xl animate-float" />
        <div className="absolute -bottom-48 -right-24 w-[34rem] h-[34rem] bg-emerald-500/10 rounded-full blur-3xl animate-float-slow" />
        <div className="absolute top-1/3 left-1/2 w-96 h-96 bg-velo-400/10 rounded-full blur-3xl animate-float-slow" />

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 pt-10 sm:pt-16 pb-16 sm:pb-24">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-center">
            {/* ============ LEFT: copy ============ */}
            <div className="lg:col-span-6 relative z-10">
              <div className="inline-flex items-center gap-2 px-3.5 py-2 rounded-full bg-white/[0.07] border border-white/15 backdrop-blur-sm text-white text-[11px] font-semibold tracking-wide mb-6 animate-fade-in-down">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                LICENSED LENDING • PERSONAL &amp; BUSINESS LOANS
              </div>

              <h1 className="text-4xl sm:text-5xl xl:text-[3.6rem] font-bold text-white leading-[1.06] tracking-tight mb-6 animate-fade-in-up animate-delay-100">
                Smarter loans for
                <br />
                <span className="relative inline-block">
                  <span className="bg-gradient-to-r from-velo-300 via-velo-400 to-velo-200 bg-clip-text text-transparent">
                    ambitious Nigerians
                  </span>
                  <svg className="absolute -bottom-2 left-0 w-full" viewBox="0 0 320 14" fill="none" preserveAspectRatio="none" aria-hidden="true">
                    <path d="M3 10 Q 90 3, 170 8 T 317 6" stroke="#4DB0F7" strokeWidth="4" strokeLinecap="round" opacity="0.9" />
                  </svg>
                </span>
              </h1>

              <p className="text-base sm:text-lg text-slate-300 leading-relaxed mb-8 max-w-xl animate-fade-in-up animate-delay-200">
                Transparent personal and business loans with clear repayment estimates, fast digital decisions and support that answers — from <strong className="text-white font-semibold">Velo Finance LTD</strong>.
              </p>

              {/* CTAs */}
              <div className="flex flex-col sm:flex-row gap-3 mb-8 animate-fade-in-up animate-delay-300">
                <Link
                  to="/account?mode=register&role=BORROWER"
                  className="group inline-flex items-center justify-center gap-2 px-7 py-4 rounded-2xl bg-gradient-to-r from-velo-500 to-velo-400 text-white font-semibold shadow-xl shadow-velo-500/30 transition-all duration-200 hover:shadow-2xl hover:shadow-velo-400/40 hover:scale-[1.02] active:scale-[0.98] animate-pulse-glow"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Apply for a Loan
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="group-hover:translate-x-1 transition-transform"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </Link>
                <Link
                  to="/account?mode=register&role=INVESTOR"
                  className="group inline-flex items-center justify-center gap-2 px-7 py-4 rounded-2xl bg-white/[0.06] text-white font-semibold border border-white/20 backdrop-blur-sm transition-all duration-200 hover:bg-white/[0.12] hover:scale-[1.02] active:scale-[0.98]"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M3 3v18h18M7 14l4-4 4 4 5-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Invest &amp; Earn
                  <span className="text-emerald-300 text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-400/15 border border-emerald-300/30">Up to 18%</span>
                </Link>
              </div>

              {/* Trust chips */}
              <div className="flex flex-wrap gap-2 mb-9 animate-fade-in-up animate-delay-400">
                {[
                  { icon: <ShieldLockIcon />, label: "NDPR Compliant" },
                  { icon: <CbnIcon />, label: "CBN-Licensed Partner" },
                  { icon: <InsuredIcon />, label: "NDIC-Insured Deposits" },
                ].map((t) => (
                  <div key={t.label} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] border border-white/10 text-slate-200 text-[11px] font-semibold backdrop-blur-sm hover:bg-white/[0.1] hover:border-white/20 transition-all">
                    <span className="text-emerald-400">{t.icon}</span>
                    {t.label}
                  </div>
                ))}
              </div>

              {/* Social proof with real avatars */}
              <div className="flex flex-wrap items-center gap-4 animate-fade-in-up animate-delay-500">
                <div className="flex -space-x-3">
                  {[
                    "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/84dd7c29b4d6.jpg",
                    "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/21511fc2ebe8.jpg",
                    "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/019d52fe2212.jpg",
                    "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/036bbfda6798.jpg",
                    "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/d96e6274a201.jpg",
                  ].map((src, i) => (
                    <img
                      key={i}
                      src={src}
                      alt="Velo customer"
                      loading="lazy"
                      className="h-10 w-10 rounded-full border-2 border-velo-900 object-cover object-center shadow-md"
                      style={{ backgroundColor: "#1E3A5F" }}
                    />
                  ))}
                </div>
                <div className="leading-tight">
                  <div className="flex items-center gap-0.5">
                    {[0, 1, 2, 3, 4].map((i) => <StarIcon key={i} />)}
                    <span className="text-xs font-bold text-white ml-1.5">4.9/5</span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">from <strong className="text-slate-200">50,000+</strong> customers across Nigeria</div>
                </div>
              </div>
            </div>

            {/* ============ RIGHT: cinematic image stage ============ */}
            <div className="lg:col-span-6 relative animate-fade-in-right animate-delay-200">
              <div className="relative max-w-xl mx-auto lg:max-w-none">
                {/* Decorative rotating ring */}
                <div className="absolute -top-8 -right-8 w-24 h-24 rounded-full border border-dashed border-white/15 animate-spin-slower hidden sm:block" aria-hidden="true" />

                {/* Main image frame with Ken Burns motion */}
                <div className="relative rounded-[2rem] overflow-hidden border border-white/10 shadow-[0_40px_120px_-30px_rgba(0,0,0,0.7)] h-[380px] sm:h-[460px]">
                  <img
                    src={IMG.heroMain}
                    alt="Confident Nigerian business professional in a modern office"
                    className="absolute inset-0 w-full h-full object-cover object-top animate-kenburns"
                    style={{ backgroundColor: "#1E3A5F" }}
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-velo-900/90 via-velo-900/10 to-transparent" />
                  {/* Shimmer sweep */}
                  <div className="absolute inset-0 overflow-hidden pointer-events-none">
                    <div className="absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-shimmer" style={{ backgroundSize: "200% 100%" }} />
                  </div>

                  {/* Floating approval toast */}
                  <div className="absolute bottom-4 left-4 right-4 sm:right-auto animate-float">
                    <div className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-white/[0.12] border border-white/20 backdrop-blur-md shadow-xl">
                      <div className="relative shrink-0">
                        <div className="h-10 w-10 rounded-xl bg-emerald-400/20 border border-emerald-300/30 flex items-center justify-center text-emerald-300">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </div>
                        <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse ring-2 ring-velo-900/60" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-white text-xs font-bold">Loan Approved — ₦500,000</div>
                        <div className="text-slate-300 text-[10px]">Disbursed to Access Bank • just now</div>
                      </div>
                    </div>
                  </div>

                  {/* Floating investor return chip */}
                  <div className="absolute top-4 right-4 hidden sm:block animate-float-slow">
                    <div className="px-4 py-2.5 rounded-2xl bg-white/[0.12] border border-white/20 backdrop-blur-md shadow-xl text-right">
                      <div className="text-emerald-300 text-lg font-bold leading-none">18%</div>
                      <div className="text-slate-300 text-[9px] font-semibold uppercase tracking-wider mt-0.5">p.a. investor returns</div>
                    </div>
                  </div>
                </div>

                {/* Secondary floating portrait card */}
                <div className="absolute -bottom-8 -left-2 sm:-left-8 hidden sm:block animate-float" style={{ animationDelay: "1.2s" }}>
                  <div className="relative w-36 h-28 rounded-2xl overflow-hidden border-2 border-white/20 shadow-2xl rotate-[-4deg] hover:rotate-0 transition-transform duration-500">
                    <img
                      src={IMG.heroSecondary}
                      alt="Velo customer smiling"
                      loading="lazy"
                      className="absolute inset-0 w-full h-full object-cover object-top"
                      style={{ backgroundColor: "#1E3A5F" }}
                    />
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2.5 pt-4 pb-1.5">
                      <div className="text-white text-[9px] font-bold">Verified Borrower</div>
                    </div>
                  </div>
                </div>

                {/* Loan calculator quick-jump pill */}
                <a
                  href="#calculator"
                  className="absolute -bottom-7 right-2 sm:right-6 inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-white dark:bg-white text-velo-800 text-xs font-bold shadow-2xl hover:scale-105 active:scale-95 transition-transform"
                >
                  <CalcIcon />
                  Try the loan calculator
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-velo-600"><path d="M12 5v14M19 12l-7 7-7-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom fade into next section */}
        <div className="absolute bottom-0 inset-x-0 h-10 bg-gradient-to-t from-slate-50 dark:from-slate-950 to-transparent" />
      </section>

      {/* ===========================================================
          2. TRUST MARQUEE — compliance & security strip
          =========================================================== */}
      <div className="relative -mx-4 sm:-mx-6 border-y border-slate-200/70 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm py-4 overflow-hidden">
        <div className="flex w-max animate-marquee gap-3 hover:[animation-play-state:paused]">
          {[...TRUST_ITEMS, ...TRUST_ITEMS].map((item, i) => (
            <div key={i} className="flex items-center gap-2 px-5 py-2 rounded-full border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold whitespace-nowrap shadow-sm">
              <span className="text-velo-500">{item.icon}</span>
              {item.label}
              <span className="ml-3 h-1 w-1 rounded-full bg-velo-200" aria-hidden="true" />
            </div>
          ))}
        </div>
        {/* Edge fades */}
        <div className="absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-slate-50 dark:from-slate-950 to-transparent pointer-events-none" />
        <div className="absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-slate-50 dark:from-slate-950 to-transparent pointer-events-none" />
      </div>

      {/* ===========================================================
          3. STATS BAND — animated counters over photography
          =========================================================== */}
      <section className="relative -mx-4 sm:-mx-6 mt-10 sm:mt-14 overflow-hidden">
        <div className="absolute inset-0">
          <img src={IMG.boardroom} alt="Velo Finance team in a strategy meeting" loading="lazy" className="w-full h-full object-cover object-top" style={{ backgroundColor: "#1E3A5F" }} />
          <div className="absolute inset-0 bg-gradient-to-r from-velo-900/95 via-velo-900/85 to-velo-800/80" />
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #FFFFFF 1px, transparent 0)", backgroundSize: "28px 28px" }} />
        </div>
        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
          <Reveal className="text-center mb-10">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 border border-white/15 backdrop-blur-sm text-velo-200 text-[11px] font-bold tracking-widest uppercase mb-4">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Proven at scale
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">Numbers that build trust</h2>
          </Reveal>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            {[
              { render: () => <><CountUp end={1} prefix="₦" suffix="B+" className="text-3xl sm:text-4xl" /></>, label: "Loans Disbursed", sub: "across personal & business" },
              { render: () => <><CountUp end={50000} format={(n) => n.toLocaleString("en-NG")} suffix="+" className="text-3xl sm:text-4xl" /></>, label: "Happy Customers", sub: "in 36 states + FCT" },
              { render: () => <><CountUp end={30} suffix=" min" className="text-3xl sm:text-4xl" /></>, label: "Avg. Approval Time", sub: "during business hours" },
              { render: () => <><CountUp end={4.9} decimals={1} suffix="/5" className="text-3xl sm:text-4xl" /></>, label: "Customer Rating", sub: "verified reviews" },
            ].map((s, i) => (
              <Reveal key={i} delay={i * 90} variant="scale">
                <div className="group h-full rounded-2xl bg-white/[0.07] border border-white/10 backdrop-blur-md p-5 sm:p-6 text-center transition-all duration-300 hover:bg-white/[0.12] hover:border-white/25 hover:-translate-y-1">
                  <div className="font-extrabold text-white tracking-tight flex items-baseline justify-center gap-0.5">
                    {s.render()}
                  </div>
                  <div className="mt-2 text-xs sm:text-sm font-bold text-velo-200">{s.label}</div>
                  <div className="mt-0.5 text-[10px] sm:text-[11px] text-slate-400">{s.sub}</div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ===========================================================
          4. HOW IT WORKS — three photographed steps
          =========================================================== */}
      <section className="max-w-6xl mx-auto mt-14 sm:mt-20 mb-14 sm:mb-20">
        <Reveal className="text-center mb-10 sm:mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-velo-50 dark:bg-velo-900/40 border border-velo-100 dark:border-velo-800 text-velo-700 dark:text-velo-300 text-xs font-bold tracking-widest uppercase mb-4">
            <span className="h-1.5 w-1.5 rounded-full bg-velo-500 animate-pulse" />
            How it works
          </div>
          <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-velo-900 dark:text-white tracking-tight mb-3">From application to funded — in three steps</h2>
          <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
            No branch visits, no paperwork piles. A fully digital journey designed to respect your time and keep you informed at every stage.
          </p>
        </Reveal>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 sm:gap-6">
          {[
            {
              step: "01",
              title: "Apply in minutes",
              desc: "Create your free account, verify your identity with BVN/NIN, and tell us how much you need. The smart form saves your progress as you go.",
              img: IMG.shopOwner,
              alt: "Nigerian shop owner applying for a loan on his phone",
              accent: "from-velo-600 to-velo-500",
            },
            {
              step: "02",
              title: "Get reviewed fast",
              desc: "Our credit team reviews your application — most decisions arrive within 30 minutes. Every fee is disclosed before you accept, so there are zero surprises.",
              img: IMG.boardroom,
              alt: "Velo credit team reviewing a loan application",
              accent: "from-velo-500 to-velo-400",
            },
            {
              step: "03",
              title: "Funds & grow",
              desc: "Accept your offer and money lands directly in your bank account. Repay on your schedule and unlock higher limits with every on-time repayment.",
              img: IMG.handshake,
              alt: "Business handshake sealing a funded loan",
              accent: "from-emerald-600 to-emerald-500",
            },
          ].map((s, i) => (
            <Reveal key={s.step} delay={i * 120} variant={i === 0 ? "left" : i === 2 ? "right" : undefined}>
              <div className="group relative h-full velo-card overflow-hidden rounded-3xl shadow-soft hover:shadow-elevated hover:-translate-y-1.5 transition-all duration-500">
                <div className="relative h-44 overflow-hidden">
                  <img src={s.img} alt={s.alt} loading="lazy" className="absolute inset-0 w-full h-full object-cover object-top transition-transform duration-700 group-hover:scale-110" style={{ backgroundColor: "#1E3A5F" }} />
                  <div className="absolute inset-0 bg-gradient-to-t from-velo-900/70 via-velo-900/10 to-transparent" />
                  <div className={`absolute top-3 left-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r ${s.accent} text-white text-xs font-extrabold shadow-lg`}>
                    STEP {s.step}
                  </div>
                  {i < 2 && (
                    <div className="absolute top-1/2 -right-4 hidden md:flex h-8 w-8 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-md items-center justify-center text-velo-500 z-10" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </div>
                  )}
                </div>
                <div className="p-6">
                  <h3 className="text-lg font-bold text-velo-900 dark:text-white mb-2">{s.title}</h3>
                  <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">{s.desc}</p>
                </div>
                <div className={`absolute bottom-0 inset-x-0 h-1 bg-gradient-to-r ${s.accent} opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ===========================================================
          5. LOAN CALCULATOR — live, transparent, restyled
          =========================================================== */}
      <section className="max-w-6xl mx-auto mb-14 sm:mb-20 scroll-mt-20" id="calculator">
        <Reveal className="text-center mb-8 sm:mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-velo-50 dark:bg-velo-900/40 border border-velo-100 dark:border-velo-800 text-velo-700 dark:text-velo-300 text-xs font-bold tracking-widest uppercase mb-4">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Live calculator
          </div>
          <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-velo-900 dark:text-white tracking-tight mb-3">Know exactly what you repay — before you apply</h2>
          <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
            Move the sliders and watch your full repayment schedule update instantly. The number you see is the number you pay.
          </p>
        </Reveal>

        <Reveal variant="scale">
          <div className="relative max-w-3xl mx-auto">
            <div className="absolute -inset-3 bg-gradient-to-br from-velo-200/50 via-transparent to-velo-100/50 dark:from-velo-800/30 dark:via-transparent dark:to-velo-800/30 rounded-[2.5rem] blur-2xl" aria-hidden="true" />
            <div className="relative bg-white dark:bg-slate-900 border border-slate-200/70 dark:border-slate-700 rounded-[2rem] shadow-elevated overflow-hidden">
              {/* Header */}
              <div className="relative bg-gradient-to-br from-[#101B33] via-velo-900 to-velo-800 px-6 sm:px-8 py-6 text-white overflow-hidden">
                <div className="absolute -top-16 -right-16 w-48 h-48 bg-velo-400/15 rounded-full blur-2xl animate-float" />
                <div className="absolute -bottom-12 -left-12 w-40 h-40 bg-emerald-400/10 rounded-full blur-2xl animate-float-slow" />
                <div className="relative flex flex-wrap items-start justify-between gap-4 mb-5">
                  <div>
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/10 backdrop-blur-sm text-[10px] font-bold border border-white/15 mb-2.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      LIVE ESTIMATE
                    </div>
                    <h3 className="text-xl sm:text-2xl font-bold">Your repayment estimate</h3>
                    <p className="text-sm text-white/60 mt-0.5">Adjust amount &amp; tenure — results update instantly</p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] text-white/50 font-bold uppercase tracking-widest mb-1">Total Repayment</div>
                    <div className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white transition-all duration-500 animate-bounce-subtle" key={calculation.totalRepayment}>
                      {formatNaira(calculation.totalRepayment)}
                    </div>
                  </div>
                </div>
                <div className="relative grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
                  <MiniMetric label="Principal" value={formatNaira(calculation.loanAmount)} />
                  <MiniMetric label="Interest" value={formatNaira(calculation.interest)} />
                  <MiniMetric label="Fees" value={formatNaira(calculation.totalFees)} />
                  <MiniMetric label="Due Date" value={formatDateLabel(calculation.repaymentDate)} compact />
                </div>
              </div>

              {/* Body */}
              <div className="p-6 sm:p-8 space-y-6">
                {/* Amount */}
                <div>
                  <div className="flex items-center justify-between mb-2.5">
                    <label htmlFor="loan-amount" className="text-sm font-bold text-velo-900 dark:text-white">How much do you need?</label>
                    <span className="text-xs text-slate-500 font-semibold">{formatNaira(min)} – {formatNaira(max)}</span>
                  </div>
                  <div className="relative group mb-4">
                    <div className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-velo-500 to-velo-600 text-white font-bold text-sm shadow-md shadow-velo-500/25">₦</span>
                    </div>
                    <input
                      id="loan-amount"
                      type="text"
                      inputMode="numeric"
                      value={amountInput}
                      onChange={(e) => handleAmountInput(e.target.value)}
                      onBlur={handleAmountBlur}
                      className={`w-full pl-14 pr-5 py-4 text-2xl sm:text-3xl font-bold rounded-2xl border-2 ${amountError ? "border-red-300 dark:border-red-500/50" : "border-slate-200 dark:border-slate-700"} bg-white dark:bg-slate-800 text-velo-900 dark:text-white placeholder:text-slate-400 transition-all duration-200 focus:border-velo-500 focus:ring-4 focus:ring-velo-100 dark:focus:ring-velo-900 focus:outline-none`}
                      placeholder="0"
                      autoComplete="off"
                    />
                    {amountError && <p className="mt-2 text-xs font-semibold text-red-600 dark:text-red-400">{amountError}</p>}
                  </div>

                  <div className="relative px-1 mb-2">
                    <div className="absolute top-2.5 left-0 right-0 h-2 rounded-full bg-slate-100 dark:bg-slate-800" />
                    <div
                      className="absolute top-2.5 left-0 h-2 rounded-full bg-gradient-to-r from-velo-600 to-velo-400 transition-all duration-200"
                      style={{ width: `${((loanAmount - min) / (max - min)) * 100}%` }}
                    />
                    <input
                      type="range"
                      aria-label="Loan amount"
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
                  <div className="flex justify-between text-[11px] font-bold text-slate-400">
                    <span>{formatNaira(min)}</span>
                    <span>{formatNaira(max)}</span>
                  </div>

                  <div className="flex flex-wrap gap-2 mt-4">
                    {quickAmounts.map((amt) => {
                      if (amt < min || amt > max) return null;
                      const active = loanAmount === amt;
                      return (
                        <button
                          key={amt}
                          type="button"
                          onClick={() => handleSlider(amt)}
                          className={`px-3.5 py-2 rounded-xl text-xs font-bold border transition-all duration-200
                            ${active
                              ? "bg-velo-500 text-white border-velo-500 shadow-md shadow-velo-500/30 scale-105"
                              : "bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700 hover:border-velo-300 hover:text-velo-700 dark:hover:text-velo-300 hover:bg-white dark:hover:bg-slate-700 hover:scale-105"
                            }`}
                        >
                          {formatNaira(amt)}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Tenure */}
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-px bg-slate-100 dark:bg-slate-800" />
                  <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                    <ClockIcon />
                    Repayment tenure
                  </div>
                  <div className="flex-1 h-px bg-slate-100 dark:bg-slate-800" />
                </div>
                <div className={`grid gap-2.5 ${tenureGridClass}`}>
                  {personalProgram.tenures.map((t) => {
                    const active = selectedTenure === t.value;
                    return (
                      <button
                        key={t.value}
                        type="button"
                        onClick={() => setSelectedTenure(t.value)}
                        className={`relative px-2.5 sm:px-3 py-3 sm:py-3.5 rounded-2xl border-2 text-center transition-all duration-200 overflow-hidden
                          ${active
                            ? "border-velo-500 bg-gradient-to-br from-velo-50 to-white dark:from-velo-900/40 dark:to-slate-800 text-velo-700 dark:text-velo-300 shadow-md shadow-velo-500/10 scale-[1.03] ring-2 ring-velo-100 dark:ring-velo-800"
                            : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:border-velo-300 hover:text-velo-700 hover:scale-[1.03]"
                          }`}
                      >
                        {active && (
                          <div className="absolute top-1.5 right-1.5 h-4 w-4 rounded-full bg-velo-500 text-white flex items-center justify-center">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          </div>
                        )}
                        <div className="text-base sm:text-lg font-bold leading-none mb-1">{t.value}</div>
                        <div className="text-[10px] sm:text-[11px] font-bold uppercase tracking-wider opacity-75">Days</div>
                      </button>
                    );
                  })}
                </div>

                {/* Fee breakdown */}
                <div className="rounded-2xl bg-gradient-to-br from-slate-50 to-white dark:from-slate-800/60 dark:to-slate-800/60 border border-slate-200/70 dark:border-slate-700 p-5 relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-velo-100 to-transparent rounded-full blur-2xl opacity-60 dark:opacity-40" aria-hidden="true" />
                  <div className="relative">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-bold text-velo-900 dark:text-white flex items-center gap-1.5">
                        <DocCheckIcon />
                        Transparent fee breakdown
                      </h3>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold border border-emerald-100 dark:border-emerald-800">
                        NO HIDDEN FEES
                      </span>
                    </div>
                    <div className="space-y-2.5">
                      <BreakdownRow label="Principal (you receive)" value={formatNaira(calculation.loanAmount)} accent="velo" bold />
                      <BreakdownRow
                        label={`Interest (${selectedFees.interest.type === "percentage" ? `${selectedFees.interest.value.toFixed(2)}% per month` : "Flat"})`}
                        value={formatNaira(calculation.interest)}
                        tag={`${formatNaira(monthlyInterest)} per month × ${(selectedTenure / 30).toFixed(2)} months`}
                      />
                      <BreakdownRow label="Service Fee" value={formatNaira(calculation.serviceFee)} />
                      <BreakdownRow label="Processing Fee" value={formatNaira(calculation.processingFee)} />
                      {calculation.lateFee > 0 && (
                        <BreakdownRow
                          label={selectedFees.lateFee.includeUpfront ? "Default Fee (included upfront)" : "Default Fee (only on missed payment)"}
                          value={formatNaira(calculation.lateFee)}
                          muted
                          tag={selectedFees.lateFee.includeUpfront ? "Included in total repayment" : "Applies only if you default"}
                        />
                      )}
                    </div>
                    <div className="mt-4 pt-4 border-t-2 border-slate-200/80 dark:border-slate-700 grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="rounded-xl p-3.5 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-700">
                        <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-0.5">Tenure</div>
                        <div className="text-lg font-bold text-velo-900 dark:text-white">{calculation.tenureLabel}</div>
                      </div>
                      <div className="rounded-xl p-3.5 bg-gradient-to-br from-velo-500 to-velo-600 dark:from-velo-600 dark:to-velo-700 text-white relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-20 h-20 bg-white/10 rounded-full blur-xl" aria-hidden="true" />
                        <div className="relative text-[10px] text-white/80 font-bold uppercase tracking-widest mb-0.5">Total Repayment</div>
                        <div className="relative text-xl sm:text-2xl font-extrabold tracking-tight" key={calculation.totalRepayment}>
                          {formatNaira(calculation.totalRepayment)}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Apply CTAs */}
                <div className="space-y-3 pt-1">
                  <div className="text-center mb-3">
                    <p className="text-sm font-bold text-velo-900 dark:text-white mb-1">Ready to get funded?</p>
                    <p className="text-xs text-slate-500">Create an account or sign in — your progress is always saved.</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Link
                      to="/account?mode=register&role=BORROWER&type=PERSONAL"
                      className="group inline-flex items-center justify-center gap-2 px-5 py-4 rounded-2xl bg-gradient-to-r from-velo-600 to-velo-500 dark:from-velo-500 dark:to-velo-400 text-white font-bold shadow-lg shadow-velo-500/25 transition-all duration-200 hover:shadow-xl hover:shadow-velo-500/40 hover:scale-[1.02] active:scale-[0.98]"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><circle cx="12" cy="7" r="4" stroke="currentColor" strokeWidth="2"/></svg>
                      Personal Loan
                    </Link>
                    <Link
                      to="/account?mode=register&role=BORROWER&type=BUSINESS"
                      className="group inline-flex items-center justify-center gap-2 px-5 py-4 rounded-2xl bg-gradient-to-r from-velo-900 to-velo-800 dark:from-slate-700 dark:to-slate-600 text-white font-bold shadow-lg shadow-velo-900/25 transition-all duration-200 hover:shadow-xl hover:scale-[1.02] active:scale-[0.98]"
                    >
                      <CbnIcon />
                      Business Loan
                    </Link>
                  </div>
                  <Link
                    to="/account?mode=login"
                    className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-2xl bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 font-semibold transition-all duration-200 hover:border-velo-300 hover:text-velo-700 dark:hover:text-velo-300 hover:bg-slate-50 dark:hover:bg-slate-700 group"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="group-hover:rotate-12 transition-transform"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    Sign in to continue your application
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ===========================================================
          6. CHOOSE YOUR PATH — borrower & investor (real imagery)
          =========================================================== */}
      <section className="max-w-6xl mx-auto mb-14 sm:mb-20">
        <Reveal className="text-center mb-10 sm:mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-velo-50 dark:bg-velo-900/40 border border-velo-100 dark:border-velo-800 text-velo-700 dark:text-velo-300 text-xs font-bold tracking-widest uppercase mb-4">
            <span className="h-1.5 w-1.5 rounded-full bg-velo-500 animate-pulse" />
            One account • unlimited possibilities
          </div>
          <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-velo-900 dark:text-white tracking-tight mb-3">Choose how you want to grow</h2>
          <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
            Whether you need funds for your next move or want your money to work for you — Velo has you covered. Switch between roles anytime.
          </p>
        </Reveal>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 sm:gap-6">
          {/* BORROWER CARD */}
          <Reveal variant="left">
            <div className="relative group velo-card overflow-hidden rounded-3xl shadow-soft hover:shadow-elevated hover:-translate-y-1.5 transition-all duration-500 h-full flex flex-col">
              <div className="relative h-48 sm:h-56 overflow-hidden">
                <img src={IMG.shopKiosk} alt="Nigerian small business owner serving a customer at his shop" loading="lazy" className="absolute inset-0 w-full h-full object-cover object-center transition-transform duration-700 group-hover:scale-110" style={{ backgroundColor: "#1E3A5F" }} />
                <div className="absolute inset-0 bg-gradient-to-t from-velo-900/85 via-velo-900/25 to-transparent" />
                <div className="absolute top-4 left-4 inline-flex items-center px-2.5 py-1 rounded-full bg-velo-500 text-white text-[10px] font-extrabold uppercase tracking-wider shadow-lg shadow-velo-500/40">Popular</div>
                <div className="absolute bottom-4 left-4 right-4 flex items-end justify-between gap-3">
                  <div>
                    <h3 className="text-xl sm:text-2xl font-bold text-white">I want to Borrow</h3>
                    <p className="text-xs text-slate-200 mt-1">Working capital for personal needs &amp; business growth</p>
                  </div>
                  <div className="shrink-0 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15 border border-white/25 backdrop-blur-md text-white">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                </div>
              </div>
              <div className="p-6 sm:p-7 flex-1 flex flex-col">
                <ul className="space-y-2.5 mb-6">
                  {[
                    "Personal loans up to ₦5,000,000",
                    "Business loans tailored to your revenue",
                    `Flexible tenors from ${personalProgram.tenures[0]?.value || 30} to ${personalProgram.tenures[personalProgram.tenures.length - 1]?.value || 180} days`,
                    "No hidden fees — see everything upfront",
                    "Fast approval & disbursement to your bank",
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-2.5">
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-velo-100 dark:bg-velo-900/60 text-velo-600 dark:text-velo-300 mt-0.5">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      </span>
                      <span className="text-sm text-slate-700 dark:text-slate-300">{item}</span>
                    </li>
                  ))}
                </ul>
                <div className="grid grid-cols-2 gap-3 mb-6 p-4 rounded-2xl bg-gradient-to-br from-velo-50 to-white dark:from-velo-900/40 dark:to-slate-800/60 border border-velo-100 dark:border-velo-800">
                  <div>
                    <div className="text-2xl font-extrabold text-velo-700 dark:text-velo-300">30m</div>
                    <div className="text-[11px] text-slate-500 font-semibold">Avg. approval</div>
                  </div>
                  <div>
                    <div className="text-2xl font-extrabold text-velo-700 dark:text-velo-300">50K+</div>
                    <div className="text-[11px] text-slate-500 font-semibold">Happy borrowers</div>
                  </div>
                </div>
                <div className="mt-auto space-y-2.5">
                  <Link
                    to="/account?mode=register&role=BORROWER"
                    className="w-full inline-flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl bg-gradient-to-r from-velo-600 to-velo-500 dark:from-velo-500 dark:to-velo-400 text-white font-bold shadow-lg shadow-velo-500/25 transition-all duration-200 hover:shadow-xl hover:shadow-velo-500/40 hover:scale-[1.02] active:scale-[0.98] group/btn"
                  >
                    Apply for a Loan
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="group-hover/btn:translate-x-1 transition-transform"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </Link>
                  <div className="grid grid-cols-2 gap-2.5">
                    <Link to="/account?mode=register&role=BORROWER&type=PERSONAL" className="text-center px-3 py-2.5 rounded-lg text-sm font-bold text-velo-700 dark:text-velo-300 bg-velo-50 dark:bg-velo-900/40 hover:bg-velo-100 dark:hover:bg-velo-900/60 transition-colors">Personal</Link>
                    <Link to="/account?mode=register&role=BORROWER&type=BUSINESS" className="text-center px-3 py-2.5 rounded-lg text-sm font-bold text-velo-700 dark:text-velo-300 bg-velo-50 dark:bg-velo-900/40 hover:bg-velo-100 dark:hover:bg-velo-900/60 transition-colors">Business</Link>
                  </div>
                </div>
              </div>
            </div>
          </Reveal>

          {/* INVESTOR CARD */}
          <Reveal variant="right">
            <div className="relative group velo-card overflow-hidden rounded-3xl shadow-soft hover:shadow-elevated hover:-translate-y-1.5 transition-all duration-500 h-full flex flex-col border-2 border-emerald-100 dark:border-emerald-900/40">
              <div className="relative h-48 sm:h-56 overflow-hidden">
                <img src={IMG.boardroom} alt="Investors reviewing portfolio performance in a boardroom" loading="lazy" className="absolute inset-0 w-full h-full object-cover object-center transition-transform duration-700 group-hover:scale-110" style={{ backgroundColor: "#1E3A5F" }} />
                <div className="absolute inset-0 bg-gradient-to-t from-emerald-950/85 via-emerald-950/25 to-transparent" />
                <div className="absolute top-4 right-4 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 text-white text-[10px] font-extrabold uppercase tracking-wider shadow-lg shadow-emerald-500/40 animate-pulse-glow">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="5" fill="currentColor"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  Earn up to 18%
                </div>
                <div className="absolute bottom-4 left-4 right-4 flex items-end justify-between gap-3">
                  <div>
                    <h3 className="text-xl sm:text-2xl font-bold text-white">I want to Invest</h3>
                    <p className="text-xs text-slate-200 mt-1">Fund vetted loans. Earn passive income with security.</p>
                  </div>
                  <div className="shrink-0 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15 border border-white/25 backdrop-blur-md text-white">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M3 3v18h18M7 14l4-4 4 4 5-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                </div>
              </div>
              <div className="p-6 sm:p-7 flex-1 flex flex-col">
                <ul className="space-y-2.5 mb-6">
                  {[
                    "Up to 18% annual returns on investments",
                    "Flexible tenors — 30, 60, 90, 180 days",
                    "KYC-verified borrowers & loan insurance",
                    "Auto-settlement direct to your bank account",
                    "Early liquidity available when you need it",
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-2.5">
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-300 mt-0.5">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      </span>
                      <span className="text-sm text-slate-700 dark:text-slate-300">{item}</span>
                    </li>
                  ))}
                </ul>
                <div className="grid grid-cols-2 gap-3 mb-6 p-4 rounded-2xl bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-900/30 dark:to-slate-800/60 border border-emerald-100 dark:border-emerald-900/50">
                  <div>
                    <div className="text-2xl font-extrabold text-emerald-700 dark:text-emerald-300">18%</div>
                    <div className="text-[11px] text-slate-500 font-semibold">Max annual return</div>
                  </div>
                  <div>
                    <div className="text-2xl font-extrabold text-emerald-700 dark:text-emerald-300">₦100K</div>
                    <div className="text-[11px] text-slate-500 font-semibold">Minimum investment</div>
                  </div>
                </div>
                <div className="mt-auto space-y-2.5">
                  <Link
                    to="/account?mode=register&role=INVESTOR"
                    className="w-full inline-flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-bold shadow-lg shadow-emerald-500/25 transition-all duration-200 hover:shadow-xl hover:shadow-emerald-500/40 hover:scale-[1.02] active:scale-[0.98] group/btn"
                  >
                    Start Investing
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="group-hover/btn:translate-x-1 transition-transform"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </Link>
                  <Link
                    to="/account?mode=login"
                    className="w-full text-center px-3 py-2.5 rounded-lg text-sm font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/40 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 transition-colors"
                  >
                    Already an investor? Sign in
                  </Link>
                </div>
              </div>
            </div>
          </Reveal>
        </div>

        <Reveal className="mt-8 text-center" delay={150}>
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-velo-500 shrink-0"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            <span><strong className="text-velo-700 dark:text-velo-300">One KYC.</strong> Once you're verified, use both borrower and investor features seamlessly.</span>
          </div>
        </Reveal>
      </section>

      {/* ===========================================================
          7. ALL-IN-ONE DIGITAL BANKING — features + phone
          =========================================================== */}
      <section className="max-w-6xl mx-auto mb-14 sm:mb-20">
        <Reveal variant="scale">
          <div className="velo-card rounded-[2rem] shadow-elevated overflow-hidden">
            <div className="grid grid-cols-1 lg:grid-cols-2">
              {/* Left: feature list on navy */}
              <div className="relative p-7 sm:p-10 bg-gradient-to-br from-[#101B33] via-velo-900 to-velo-800 overflow-hidden">
                <div className="absolute inset-0 opacity-20">
                  <div className="absolute top-0 right-0 w-80 h-80 bg-velo-400 rounded-full blur-3xl translate-x-1/3 -translate-y-1/3 animate-float" />
                  <div className="absolute bottom-0 left-0 w-64 h-64 bg-violet-400 rounded-full blur-3xl -translate-x-1/4 translate-y-1/4 animate-float-slow opacity-50" />
                </div>
                <div className="relative">
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 border border-white/15 text-velo-100 text-xs font-bold mb-5">
                    <StarIcon />
                    ALL-IN-ONE PLATFORM
                  </div>
                  <h2 className="text-2xl sm:text-3xl font-bold text-white mb-4 leading-tight">
                    More than just loans.
                    <br />
                    <span className="bg-gradient-to-r from-velo-300 via-white to-velo-200 bg-clip-text text-transparent">
                      A complete digital bank.
                    </span>
                  </h2>
                  <p className="text-sm sm:text-base text-white/75 leading-relaxed mb-7 max-w-md">
                    Loans are at the heart of Velo Finance LTD. Alongside lending, manage transfers, bill payments, gift cards, crypto, global payments, joint accounts, and USD virtual cards in one platform.
                  </p>

                  <div className="space-y-4 mb-8">
                    <FeatureRow icon={<CryptoIcon />} title="Crypto Trading" desc="Buy, sell & swap BTC, ETH, USDT and 50+ cryptocurrencies at competitive rates" badge="Live Rates" badgeColor="sky" />
                    <FeatureRow icon={<GiftCardIcon />} title="Gift Card Marketplace" desc="Buy & redeem Amazon, iTunes, Google Play, Steam, Nike and 100+ global gift cards" badge="Instant" badgeColor="emerald" />
                    <FeatureRow icon={<GlobeIcon />} title="Global Payments & Collections" desc="Send globally and receive customer payments internationally with confidence" badge="Global" badgeColor="sky" />
                    <FeatureRow icon={<SendIcon />} title="Transfers & Joint Accounts" desc="Move money, share financial access, and manage payments together" badge="24/7" badgeColor="sky" />
                    <FeatureRow icon={<BillIcon />} title="Bill Payments & Airtime" desc="Pay electricity, cable, internet, water bills and buy airtime/data for any network" />
                    <FeatureRow icon={<CardIcon />} title="USD Virtual Cards" desc="Create secure virtual dollar cards for online subscriptions and global purchases" />
                  </div>

                  <a
                    href={`https://${config.companyWebsite}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-6 py-3.5 rounded-xl bg-white dark:bg-white text-velo-800 font-bold shadow-lg transition-all duration-300 hover:shadow-xl hover:scale-[1.02] active:scale-[0.98] group"
                  >
                    Visit Velo Banking
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="group-hover:rotate-45 transition-transform duration-300"><path d="M14 3h7v7M21 3L10 14M21 14v7H3V3h7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </a>
                </div>
              </div>

              {/* Right: phone mockup */}
              <div className="p-7 sm:p-10 bg-gradient-to-br from-slate-50 to-white dark:from-slate-950 dark:to-slate-900 relative overflow-hidden flex items-center justify-center">
                <div className="absolute top-0 right-0 w-40 h-40 bg-gradient-to-br from-velo-100 to-velo-50 dark:from-velo-900/40 dark:to-velo-900/20 rounded-full blur-3xl opacity-60" />
                <div className="absolute bottom-0 left-0 w-48 h-48 bg-gradient-to-br from-velo-50 to-velo-100 dark:from-velo-800/25 dark:to-velo-800/10 rounded-full blur-3xl opacity-60" />
                <PhoneMockup />
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ===========================================================
          7b. SEE VELO IN MOTION — cinematic product video
          =========================================================== */}
      <section className="max-w-6xl mx-auto mb-14 sm:mb-20">
        <Reveal className="text-center mb-8 sm:mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-velo-50 dark:bg-velo-900/40 border border-velo-100 dark:border-velo-800 text-velo-700 dark:text-velo-300 text-xs font-bold tracking-widest uppercase mb-4">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-velo-500 animate-pulse" />
            Digital-first lending
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold text-velo-900 dark:text-white mb-3 tracking-tight">
            From application to disbursement —
            <span className="bg-gradient-to-r from-velo-600 to-emerald-600 dark:from-velo-400 dark:to-emerald-400 bg-clip-text text-transparent"> entirely online.</span>
          </h2>
          <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400 max-w-2xl mx-auto leading-relaxed">
            No branch visits, no paperwork queues. Complete your KYC, get a decision and receive funds — all from your phone or laptop, in minutes.
          </p>
        </Reveal>
        <Reveal variant="scale">
          <div className="group relative rounded-[2rem] overflow-hidden shadow-elevated border border-slate-200 dark:border-slate-800">
            <div className="relative aspect-[4/3] sm:aspect-[16/7] bg-velo-900">
              {/* Product video — cropped top-weighted so the frame stays clean */}
              <video
                className="absolute inset-0 w-full h-full object-cover object-[center_18%] scale-[1.28] origin-top transition-transform duration-[2000ms] ease-out group-hover:scale-[1.36] motion-reduce:transform-none"
                autoPlay
                muted
                loop
                playsInline
                preload="none"
                poster="https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/aa827b9398af.jpg"
                aria-label="A Velo customer completing a loan application on a laptop"
              >
                <source src="https://videos.pexels.com/video-files/852421/852421-hd_1280_720_30fps.mp4" type="video/mp4" />
              </video>
              {/* Legibility gradients */}
              <div className="absolute inset-0 bg-gradient-to-t from-velo-900/85 via-velo-900/20 to-transparent" />
              <div className="absolute inset-0 bg-gradient-to-r from-velo-900/50 via-transparent to-transparent" />
              {/* Live badge */}
              <div className="absolute top-4 left-4 sm:top-5 sm:left-5 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.12] border border-white/20 backdrop-blur-md text-white text-[10px] font-bold tracking-widest uppercase">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
                </span>
                Live on Velo
              </div>
              {/* Floating stat chips */}
              <div className="absolute top-4 right-4 sm:top-5 sm:right-5 hidden sm:flex flex-col gap-2">
                {[
                  { label: "KYC verified", tone: "text-emerald-300" },
                  { label: "Decision in ~30 min", tone: "text-velo-200" },
                  { label: "Funds same day", tone: "text-white" },
                ].map((chip) => (
                  <div key={chip.label} className="px-3 py-1.5 rounded-xl bg-velo-900/55 border border-white/15 backdrop-blur-md text-[10px] font-bold text-white/90 animate-float">
                    <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current align-middle ${chip.tone}`} />
                    {chip.label}
                  </div>
                ))}
              </div>
              {/* Bottom copy + CTA */}
              <div className="absolute bottom-0 left-0 right-0 p-5 sm:p-8 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
                <div>
                  <div className="text-lg sm:text-2xl font-bold text-white mb-1.5 leading-snug">
                    Apply in minutes. <span className="text-velo-300">Money in hours.</span>
                  </div>
                  <div className="text-[11px] sm:text-xs text-slate-300 max-w-md leading-relaxed">
                    Every step — identity check, offer review, e-signature and disbursement — happens on one secure platform.
                  </div>
                </div>
                <Link
                  to="/account?mode=register&role=BORROWER"
                  className="shrink-0 inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-2xl bg-white dark:bg-white text-velo-800 font-bold shadow-xl transition-all duration-200 hover:scale-[1.03] active:scale-[0.98] group/cta"
                >
                  Start your application
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" className="group-hover/cta:translate-x-1 transition-transform"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </Link>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ===========================================================
          8. SECURITY & TRUST — dark section with photography
          =========================================================== */}
      <section className="max-w-6xl mx-auto mb-14 sm:mb-20">
        <Reveal>
          <div className="relative rounded-[2rem] overflow-hidden bg-gradient-to-br from-[#101B33] via-velo-900 to-velo-800 shadow-elevated">
            <div className="absolute inset-0 opacity-[0.05]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #FFFFFF 1px, transparent 0)", backgroundSize: "30px 30px" }} />
            <div className="absolute -top-32 -right-32 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl animate-float" />
            <div className="absolute -bottom-32 -left-32 w-96 h-96 bg-velo-500/15 rounded-full blur-3xl animate-float-slow" />

            <div className="relative grid grid-cols-1 lg:grid-cols-2 gap-8 items-center p-7 sm:p-10 lg:p-12">
              {/* Image side */}
              <div className="relative">
                <div className="relative rounded-3xl overflow-hidden border border-white/10 shadow-2xl h-72 sm:h-80">
                  <img src={IMG.support} alt="Velo support specialist assisting a customer over video call" loading="lazy" className="absolute inset-0 w-full h-full object-cover object-center animate-kenburns-fast" style={{ backgroundColor: "#1E3A5F" }} />
                  <div className="absolute inset-0 bg-gradient-to-t from-velo-900/80 via-transparent to-transparent" />
                  <div className="absolute bottom-4 left-4 flex items-center gap-3 px-4 py-3 rounded-2xl bg-white/[0.12] border border-white/20 backdrop-blur-md">
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400" />
                    </span>
                    <div>
                      <div className="text-white text-xs font-bold">Human support, 24/7</div>
                      <div className="text-slate-300 text-[10px]">Real loan officers — not bots</div>
                    </div>
                  </div>
                </div>
                {/* Shield ring decoration */}
                <div className="absolute -top-5 -right-5 hidden sm:flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400/20 to-velo-400/20 border border-white/15 backdrop-blur-md animate-float">
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" className="text-emerald-300"><path d="M12 2l9 4v6c0 5-3.5 8.5-9 10-5.5-1.5-9-5-9-10V6l9-4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </div>
              </div>

              {/* Copy side */}
              <div>
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 border border-white/15 text-velo-100 text-xs font-bold mb-5">
                  <LockIcon />
                  SECURITY FIRST
                </div>
                <h2 className="text-2xl sm:text-3xl font-bold text-white mb-4 leading-tight">
                  Your money and your data —
                  <span className="text-velo-300"> protected like a bank. Because we are one.</span>
                </h2>
                <p className="text-sm sm:text-base text-white/70 leading-relaxed mb-7">
                  Every application, document and naira that moves through Velo is guarded by the same standards Nigeria's top financial institutions rely on.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 mb-8">
                  {[
                    { icon: <LockIcon />, title: "Bank-grade encryption", desc: "256-bit TLS in transit, encrypted at rest" },
                    { icon: <ShieldLockIcon />, title: "NDPR compliant", desc: "Your data is never sold or shared" },
                    { icon: <DocCheckIcon />, title: "Full KYC on everyone", desc: "BVN/NIN verification for all parties" },
                    { icon: <InsuredIcon />, title: "Insured lending", desc: "Credit life & loan protection cover" },
                  ].map((f, i) => (
                    <Reveal key={f.title} delay={i * 80} variant="scale">
                      <div className="h-full rounded-2xl bg-white/[0.06] border border-white/10 p-4 hover:bg-white/[0.1] hover:border-white/20 transition-all duration-300">
                        <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-velo-500/20 text-velo-300 border border-velo-400/20 mb-2.5">
                          {f.icon}
                        </div>
                        <div className="text-sm font-bold text-white mb-1">{f.title}</div>
                        <div className="text-[11px] text-slate-400 leading-relaxed">{f.desc}</div>
                      </div>
                    </Reveal>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Link
                    to="/account?mode=register&role=BORROWER"
                    className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-white dark:bg-white text-velo-800 font-bold shadow-lg transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] group"
                  >
                    Start securely
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="group-hover:translate-x-1 transition-transform"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </Link>
                  <a href="tel:08080000440" className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-white/90 text-sm font-semibold hover:bg-white/10 transition-colors">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.37 1.9.72 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0122 16.92z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    0808 000 0440
                  </a>
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ===========================================================
          9. TESTIMONIALS — real customers, real stories
          =========================================================== */}
      <section className="max-w-6xl mx-auto mb-14 sm:mb-20">
        <Reveal className="text-center mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-velo-50 dark:bg-velo-900/40 border border-velo-100 dark:border-velo-800 text-velo-700 dark:text-velo-300 text-xs font-bold tracking-widest uppercase mb-4">
            <StarIcon />
            Borrower stories
          </div>
          <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-velo-900 dark:text-white tracking-tight mb-3">Real people. Real loan progress.</h2>
          <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
            From fashion brands in Lagos to logistics operators in Ibadan — thousands of Nigerians trust Velo with their next important move.
          </p>
        </Reveal>

        <Reveal variant="scale">
          <div className="relative max-w-3xl mx-auto">
            <div className="absolute -inset-2 bg-gradient-to-r from-velo-100/60 via-transparent to-emerald-100/50 dark:from-velo-900/30 dark:via-transparent dark:to-emerald-900/20 rounded-[2.5rem] blur-xl opacity-70" aria-hidden="true" />
            <div className="relative velo-card rounded-[2rem] shadow-elevated p-6 sm:p-9 overflow-hidden">
              <QuoteIcon />
              <div className="overflow-hidden" aria-live="polite">
                <div className="flex transition-transform duration-500 ease-out" style={{ transform: `translateX(-${testimonialIndex * 100}%)` }}>
                  {TESTIMONIALS.map((t) => (
                    <figure key={t.name} className="w-full shrink-0 pr-1">
                      <div className="flex items-center gap-0.5 mb-4">{[0, 1, 2, 3, 4].map((i) => <StarIcon key={i} />)}</div>
                      <blockquote className="text-base sm:text-lg text-slate-700 dark:text-slate-200 leading-relaxed font-medium mb-6">
                        “{t.quote}”
                      </blockquote>
                      <figcaption className="flex items-center gap-3.5">
                        <img
                          src={t.photo}
                          alt={`${t.name}, Velo customer`}
                          loading="lazy"
                          className="h-12 w-12 rounded-full object-cover object-center ring-2 ring-velo-100 dark:ring-velo-800 shadow-md"
                          style={{ backgroundColor: "#1E3A5F" }}
                        />
                        <div>
                          <div className="text-sm font-bold text-velo-900 dark:text-white">{t.name}</div>
                          <div className="text-xs text-slate-500">{t.meta}</div>
                        </div>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </div>

              <div className="mt-7 flex items-center justify-between gap-4">
                <div className="flex gap-1.5" aria-hidden="true">
                  {TESTIMONIALS.map((t, index) => (
                    <button
                      key={t.name}
                      type="button"
                      onClick={() => setTestimonialIndex(index)}
                      aria-label={`Go to testimonial ${index + 1}`}
                      className={`h-1.5 rounded-full transition-all duration-300 ${index === testimonialIndex ? "w-7 bg-velo-500" : "w-1.5 bg-velo-200 dark:bg-slate-700 hover:bg-velo-300"}`}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={() => setTestimonialIndex((current) => (current - 1 + TESTIMONIALS.length) % TESTIMONIALS.length)} className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-velo-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-velo-600 dark:text-velo-300 transition hover:bg-velo-500 hover:border-velo-500 hover:text-white" aria-label="Previous testimonial">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                  <button type="button" onClick={() => setTestimonialIndex((current) => (current + 1) % TESTIMONIALS.length)} className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-velo-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-velo-600 dark:text-velo-300 transition hover:bg-velo-500 hover:border-velo-500 hover:text-white" aria-label="Next testimonial">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ===========================================================
          10. FAQ — accordion
          =========================================================== */}
      <section className="max-w-3xl mx-auto mb-14 sm:mb-20">
        <Reveal className="text-center mb-9">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-velo-50 dark:bg-velo-900/40 border border-velo-100 dark:border-velo-800 text-velo-700 dark:text-velo-300 text-xs font-bold tracking-widest uppercase mb-4">
            <ChatIcon />
            Questions, answered
          </div>
          <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-velo-900 dark:text-white tracking-tight mb-3">Everything you need to know</h2>
        </Reveal>

        <div className="space-y-3">
          {FAQS.map((f, i) => (
            <Reveal key={f.q} delay={i * 60}>
              <div className={`velo-card rounded-2xl overflow-hidden transition-all duration-300 ${openFaq === i ? "shadow-elevated ring-1 ring-velo-200 dark:ring-velo-800" : "hover:shadow-card"}`}>
                <button
                  type="button"
                  onClick={() => setOpenFaq(openFaq === i ? -1 : i)}
                  className="w-full flex items-center justify-between gap-4 px-5 sm:px-6 py-4 sm:py-5 text-left"
                  aria-expanded={openFaq === i}
                >
                  <span className="text-sm sm:text-base font-bold text-velo-900 dark:text-white">{f.q}</span>
                  <span className={`shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-full transition-all duration-300 ${openFaq === i ? "bg-velo-500 text-white rotate-180" : "bg-slate-100 dark:bg-slate-800 text-slate-500"}`}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </span>
                </button>
                <div className={`accordion-panel ${openFaq === i ? "open" : ""}`}>
                  <div>
                    <p className="px-5 sm:px-6 pb-5 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">{f.a}</p>
                  </div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal className="mt-7 text-center" delay={200}>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Still have questions? Call{" "}
            <a href="tel:08080000440" className="font-bold text-velo-600 dark:text-velo-300 hover:underline">0808 000 0440</a>
            {" "}or email{" "}
            <a href="mailto:support@velocredit.ng" className="font-bold text-velo-600 dark:text-velo-300 hover:underline">support@velocredit.ng</a>
          </p>
        </Reveal>
      </section>

      {/* ===========================================================
          11. FINAL CTA — partnership imagery, dual action
          =========================================================== */}
      <section className="max-w-6xl mx-auto mb-14">
        <Reveal variant="scale">
          <div className="relative rounded-[2rem] overflow-hidden shadow-elevated">
            <div className="absolute inset-0">
              <img src={IMG.handshake} alt="Velo Finance partnering with a customer" loading="lazy" className="w-full h-full object-cover object-center" style={{ backgroundColor: "#1E3A5F" }} />
              <div className="absolute inset-0 bg-gradient-to-r from-velo-900/97 via-velo-900/88 to-velo-800/70" />
              <div className="absolute inset-0 opacity-[0.05]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #FFFFFF 1px, transparent 0)", backgroundSize: "26px 26px" }} />
            </div>
            <div className="relative grid grid-cols-1 lg:grid-cols-12 gap-6 items-center p-7 sm:p-12">
              <div className="lg:col-span-7">
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 border border-white/20 backdrop-blur-sm text-white text-xs font-bold mb-5">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Reduced processing fees this month
                </div>
                <h2 className="text-2xl sm:text-4xl font-bold text-white mb-3 leading-tight tracking-tight">
                  Ready to move forward?
                </h2>
                <p className="text-sm sm:text-lg text-slate-300 mb-8 max-w-xl leading-relaxed">
                  Start your application today and join over 50,000 Nigerians who fund their goals with Velo. Clear terms, fast decisions, support that answers.
                </p>
                <div className="flex flex-col sm:flex-row gap-3">
                  <Link
                    to="/account?mode=register&role=BORROWER"
                    className="group inline-flex items-center justify-center gap-2 px-7 py-4 rounded-2xl bg-white dark:bg-white text-velo-800 font-bold shadow-xl transition-all duration-200 hover:shadow-2xl hover:scale-[1.02] active:scale-[0.98] animate-pulse-glow"
                  >
                    Start New Application
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="group-hover:translate-x-1 transition-transform"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </Link>
                  <a
                    href={`https://${config.companyWebsite}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 px-7 py-4 rounded-2xl bg-white/10 backdrop-blur-sm text-white font-bold border border-white/25 transition-all duration-200 hover:bg-white/20 hover:scale-[1.02]"
                  >
                    Explore Velo Banking
                  </a>
                </div>
              </div>
              <div className="lg:col-span-5 hidden lg:block">
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { icon: <NairaIcon />, stat: "₦1B+", label: "Disbursed" },
                    { icon: <UsersIcon />, stat: "50K+", label: "Customers" },
                    { icon: <ClockIcon />, stat: "30 min", label: "Avg. decision" },
                    { icon: <StarIcon />, stat: "4.9/5", label: "Rating" },
                  ].map((s, i) => (
                    <div key={i} className="rounded-2xl bg-white/[0.08] border border-white/15 backdrop-blur-md p-4 hover:bg-white/[0.14] transition-colors">
                      <span className="text-velo-300 inline-block mb-2">{s.icon}</span>
                      <div className="text-xl font-extrabold text-white">{s.stat}</div>
                      <div className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {(hardErrors.length > 0 || warnings.length > 0) && (
        <div className={`max-w-6xl mx-auto mb-10 rounded-xl border p-4 ${hardErrors.length > 0 ? "bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900" : "bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900"}`}>
          <h3 className={`text-sm font-semibold ${hardErrors.length > 0 ? "text-red-700 dark:text-red-300" : "text-amber-800 dark:text-amber-300"}`}>
            Configuration Notice
          </h3>
          <ul className="mt-2 space-y-1 text-xs text-slate-700 dark:text-slate-300">
            {[...hardErrors, ...warnings].map((e, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="text-slate-400 dark:text-slate-500">•</span>
                <span><strong className="text-slate-800 dark:text-slate-100">{e.key}:</strong> {e.message}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Edit your <code className="bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded">.env</code> file or configure these via the Admin Dashboard &gt; Loan Settings.
          </p>
        </div>
      )}
    </Layout>
  );
}

/* =======================================================================
   Scroll-reveal wrapper (IntersectionObserver, zero dependencies)
   ======================================================================= */
function Reveal({
  children,
  className = "",
  delay = 0,
  variant,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  variant?: "left" | "right" | "scale";
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      el.classList.add("reveal-visible");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            el.classList.add("reveal-visible");
            io.disconnect();
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const variantClass =
    variant === "left" ? "reveal-left" : variant === "right" ? "reveal-right" : variant === "scale" ? "reveal-scale" : "";

  return (
    <div ref={ref} className={`reveal ${variantClass} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

/* =======================================================================
   Animated counter (counts up when scrolled into view)
   ======================================================================= */
function CountUp({
  end,
  prefix = "",
  suffix = "",
  decimals,
  format,
  duration = 1600,
  className = "",
}: {
  end: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  format?: (n: number) => string;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;

    const run = () => {
      const t0 = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        setValue(end * eased);
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };

    if (typeof IntersectionObserver === "undefined") {
      run();
      return () => cancelAnimationFrame(raf);
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            io.disconnect();
            run();
          }
        });
      },
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [end, duration]);

  const display = format ? format(value) : value.toFixed(decimals ?? 0);

  return (
    <span ref={ref} className={className}>
      {prefix}
      {display}
      {suffix}
    </span>
  );
}

/* =======================================================================
   Phone mockup — animated super-app showcase
   ======================================================================= */
function PhoneMockup() {
  return (
    <div className="relative mx-auto max-w-[300px] animate-float">
      <div className="absolute -inset-4 bg-gradient-to-br from-velo-200 via-velo-50 to-slate-100 dark:from-velo-800/40 dark:via-transparent dark:to-velo-800/20 rounded-[3rem] blur-xl opacity-70" aria-hidden="true" />
      <div className="relative bg-gradient-to-br from-[#101B33] via-velo-900 to-velo-800 rounded-[2.4rem] p-5 shadow-elevated border border-white/10 overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, white 1px, transparent 0)", backgroundSize: "20px 20px" }} aria-hidden="true" />
        <div className="relative">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-white/15 flex items-center justify-center">
                <LogoIconSmall />
              </div>
              <div>
                <div className="text-white font-bold text-sm">Velo Finance</div>
                <div className="text-white/50 text-[10px]">Super App</div>
              </div>
            </div>
            <div className="h-8 w-8 rounded-full bg-white/10 flex items-center justify-center text-white">
              <BellIcon />
            </div>
          </div>

          <div className="mb-6">
            <div className="text-white/60 text-xs mb-1">Total Balance (USD + NGN)</div>
            <div className="text-white text-3xl font-extrabold tracking-tight flex items-center gap-1">
              <span>₦</span>
              <span>2,847,500</span>
              <span className="text-lg">.80</span>
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-emerald-400 text-[10px] font-bold">+₦3,240.50</span>
              <span className="text-emerald-400 text-[10px] font-bold bg-emerald-400/10 px-1.5 py-0.5 rounded">▲ 2.4%</span>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2 mb-2.5">
            {[
              { icon: <MiniSendIcon />, label: "Send" },
              { icon: <MiniReceiveIcon />, label: "Receive" },
              { icon: <MiniCryptoIcon />, label: "Crypto" },
              { icon: <MiniGiftIcon />, label: "Cards" },
            ].map((a) => (
              <button key={a.label} className="flex flex-col items-center gap-1.5 p-2.5 rounded-xl bg-white/10 hover:bg-white/15 transition-all duration-200 border border-white/5 hover:scale-105">
                <div className="text-white">{a.icon}</div>
                <div className="text-white/80 text-[10px] font-bold">{a.label}</div>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-4 gap-2 mb-5">
            {[
              { icon: <MiniBillIcon />, label: "Bills" },
              { icon: <MiniTopupIcon />, label: "Topup" },
              { icon: <MiniGlobeIcon />, label: "FX" },
              { icon: <MiniLoanIcon />, label: "Loans" },
            ].map((a) => (
              <button key={a.label} className="flex flex-col items-center gap-1.5 p-2.5 rounded-xl bg-white/10 hover:bg-white/15 transition-all duration-200 border border-white/5 hover:scale-105">
                <div className="text-white">{a.icon}</div>
                <div className="text-white/80 text-[10px] font-bold">{a.label}</div>
              </button>
            ))}
          </div>

          <div className="space-y-2">
            <div className="text-white/60 text-[10px] font-bold uppercase tracking-wider mb-2">Recent Activity</div>
            {[
              { name: "Bank Transfer", desc: "From John Doe", amount: "+₦250,000", pos: true, tag: "transfer" },
              { name: "BTC Purchase", desc: "Crypto Wallet", amount: "-₦450,000", pos: false, tag: "crypto" },
              { name: "Amazon Gift Card", desc: "$100 USD Card", amount: "-₦98,500", pos: false, tag: "giftcard" },
              { name: "Electricity Bill", desc: "Ikeja Electric", amount: "-₦28,500", pos: false, tag: "bill" },
            ].map((t) => (
              <div key={t.name} className="flex items-center gap-3 p-2.5 rounded-xl bg-white/5 hover:bg-white/10 transition-all duration-200 border border-white/5">
                <div className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${t.pos ? "bg-emerald-500/15 text-emerald-400" : t.tag === "crypto" ? "bg-sky-500/15 text-sky-400" : t.tag === "giftcard" ? "bg-velo-500/15 text-velo-400" : "bg-rose-500/15 text-rose-400"}`}>
                  {t.pos ? <MiniInIcon /> : t.tag === "crypto" ? <MiniCryptoIcon /> : t.tag === "giftcard" ? <MiniGiftIcon /> : <MiniOutIcon />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-white text-xs font-bold truncate">{t.name}</div>
                  <div className="text-white/50 text-[10px] truncate">{t.desc}</div>
                </div>
                <div className={`text-xs font-bold ${t.pos ? "text-emerald-400" : "text-white"}`}>{t.amount}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* Floating notification */}
      <div className="absolute -right-6 top-24 px-3.5 py-2.5 rounded-2xl bg-white dark:bg-slate-800 shadow-elevated border border-slate-100 dark:border-slate-700 animate-float-slow hidden sm:block" style={{ animationDelay: "0.8s" }}>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          <div>
            <div className="text-[10px] font-bold text-velo-900 dark:text-white">Loan offer ready</div>
            <div className="text-[9px] text-slate-500">₦500,000 • 90 days</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =======================================================================
   Shared mini components
   ======================================================================= */
function MiniMetric({ label, value, compact }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className="rounded-xl bg-white/10 backdrop-blur-sm border border-white/15 px-3 py-2 hover:bg-white/15 transition">
      <div className="text-[9px] text-white/70 font-bold uppercase tracking-wider mb-0.5">{label}</div>
      <div className={`font-bold text-white ${compact ? "text-xs leading-tight" : "text-sm sm:text-base"}`}>
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
        <div className={`text-xs ${bold ? "font-bold text-velo-900 dark:text-white" : "font-semibold text-slate-600 dark:text-slate-300"} ${accent === "velo" ? "text-velo-900 dark:text-white" : ""}`}>
          {label}
        </div>
        {tag && <div className="text-[10px] text-slate-400 mt-0.5">{tag}</div>}
      </div>
      <div className={`text-xs font-bold shrink-0 ${accent === "velo" ? "text-velo-700 dark:text-velo-300" : bold ? "text-velo-900 dark:text-white" : "text-slate-700 dark:text-slate-200"}`}>
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
    <div className="flex items-start gap-3 group">
      <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 text-white shrink-0 border border-white/10 group-hover:bg-white/15 group-hover:scale-110 transition-all duration-300">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-white font-bold">{title}</span>
          {badge && (
            <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border ${badgeStyles[badgeColor || "amber"]}`}>
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
function StarIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="#F59E0B"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>;
}

function ShieldLockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2l9 4v6c0 5-3.5 8.5-9 10-5.5-1.5-9-5-9-10V6l9-4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><rect x="9" y="11" width="6" height="5" rx="1" stroke="currentColor" strokeWidth="1.6"/><path d="M11 11V9a1 1 0 112 0v2" stroke="currentColor" strokeWidth="1.6"/></svg>
  );
}

function CbnIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 21h18M5 21V10M19 21V10M3 10l9-6 9 6M9 21v-5h6v5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg>
  );
}

function InsuredIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2l10 5v6c0 5-4 8.5-10 10-6-1.5-10-5-10-10V7l10-5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
  );
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="4" y="11" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.8"/><path d="M8 11V7a4 4 0 018 0v4" stroke="currentColor" strokeWidth="1.8"/><circle cx="12" cy="16" r="1.5" fill="currentColor"/></svg>
  );
}

function DocCheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><path d="M14 2v6h6M9 15l2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
  );
}

function ClockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"/><path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
  );
}

function UsersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="1.8"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
  );
}

function NairaIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 20V4h2l10 16V4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><path d="M5 10h12M5 16h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
  );
}

function ChatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg>
  );
}

function CalcIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
  );
}

function QuoteIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" className="text-velo-100 dark:text-velo-800/60 absolute top-5 right-6" aria-hidden="true">
      <path d="M10 8c-3 0-5 2.2-5 5.2 0 2.6 1.9 4.8 4.4 4.8.4 0 .8-.05 1.1-.16C9.9 20 8.4 21 6.5 21.4l.6 1.6c3.9-1 6.4-4 6.4-8.4C13.5 10.6 12.2 8 10 8zm9 0c-3 0-5 2.2-5 5.2 0 2.6 1.9 4.8 4.4 4.8.4 0 .8-.05 1.1-.16-.6 2.16-2.1 3.16-4 3.56l.6 1.6c3.9-1 6.4-4 6.4-8.4C22.5 10.6 21.2 8 19 8z" fill="currentColor" opacity="0.6"/>
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
  );
}

function BillIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
  );
}

function CardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="1.8"/><path d="M2 10h20" stroke="currentColor" strokeWidth="1.8"/></svg>
  );
}

function CryptoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8"/><path d="M9 8h5a2.5 2.5 0 010 5H9zM9 13h6a2.5 2.5 0 010 5H9z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg>
  );
}

function GiftCardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="8" width="18" height="4" rx="1" stroke="currentColor" strokeWidth="1.8"/><path d="M12 8v13M5 12v9h14v-9M12 8c-1.5-2.5-3.5-2.5-3.5-1 0 1.2 3.5 2.5 3.5 2.5s3.5-1.3 3.5-2.5c0-1.5-2-1.5-3.5 1z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8"/><path d="M3 12h18M12 3c2 3 2 15 0 18M12 3c-2 3-2 15 0 18" stroke="currentColor" strokeWidth="1.8"/></svg>
  );
}

function BellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
  );
}

function LogoIconSmall() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
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
