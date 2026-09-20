import { useEffect } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import SEO from "../components/SEO";

export default function Terms() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <Layout>
      <SEO />
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 py-12 sm:py-16">
          <div className="mb-10">
            <p className="text-xs font-bold uppercase tracking-wider text-velo-600 dark:text-velo-400">Legal</p>
            <h1 className="mt-1 text-3xl sm:text-4xl font-extrabold text-velo-900 dark:text-white">Terms &amp; Conditions</h1>
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">Last updated: 20 September 2026</p>
          </div>

          <div className="space-y-8 prose prose-slate dark:prose-invert max-w-none">
            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">1. Acceptance of terms</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                By accessing or using the Velo Finance platform (the "Platform"), operated by Velo Finance LTD ("Velo", "we", "us"), you agree to be bound by these Terms &amp; Conditions (these "Terms"). If you do not agree to these Terms, you must not access or use the Platform. These Terms form a legally binding agreement between you and Velo Finance LTD. You acknowledge that you have read, understood, and agree to be bound by all of the Terms set out herein, including any policies, guidelines, or supplemental terms referenced herein and incorporated by reference.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                If you are entering into these Terms on behalf of a business entity, you represent that you have the authority to bind that entity to these Terms, in which case "you" will refer to that entity. If you do not have such authority, you may not accept these Terms or use the Platform.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">2. Eligibility</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                To use the Platform, you must be at least eighteen (18) years old, a resident of the Federal Republic of Nigeria, and legally capable of entering into binding contracts. By registering an account, you represent and warrant that you meet these eligibility requirements and that the information you provide during registration is accurate, complete, and current. You agree to update your information promptly if it changes.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                You must provide a valid Bank Verification Number (BVN) and National Identification Number (NIN) as part of the identity verification process. Velo uses Prembly, a third-party identity verification provider, to validate the information you provide. Your use of the Platform is contingent on successful identity verification.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">3. Borrower loans</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                As a borrower, you may apply for personal or business loans through the Platform. Loan amounts, tenures, interest rates, processing fees, service fees, and late fees are set by Velo and displayed to you prior to acceptance. All loan offers are subject to credit assessment and Velo's sole discretion. Velo may decline an application or offer different terms based on credit history, income, KYC verification, and other factors.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                By accepting a loan offer, you agree to repay the principal, interest, and any applicable fees according to the agreed schedule. Late payments may attract a default/late fee as disclosed in your loan agreement. Velo reserves the right to report non-payment to credit bureaus, engage collection agents, and pursue legal remedies. Disbursement is processed via Flutterwave to your verified bank account.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">4. Investor investments</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                As an investor, you may fund your Velo wallet and place funds into investment plans offered on the Platform. Investment returns accrue daily based on the annual rate disclosed for each plan. Investments are subject to a fixed tenure, and early withdrawal may incur fees or be subject to liquidity constraints. Returns are credited to your Velo wallet at the end of the tenure and can be withdrawn to your verified bank account.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                Investments are not deposits and are not insured by the Nigeria Deposit Insurance Corporation (NDIC) or any other deposit insurance scheme. Investment returns are not guaranteed and depend on the performance of the underlying loans funded by Velo. You should carefully consider your investment objectives and risk tolerance before committing funds.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">5. Fees &amp; charges</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                Velo charges fees for its services, including processing fees, service fees, late fees, and wallet withdrawal fees. The current fee schedule is published on the Platform and may be updated from time to time. We will notify you of any material fee changes at least thirty (30) days before they take effect. Continued use of the Platform after the effective date of any fee change constitutes acceptance of the new fees.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                All fees are quoted in Nigerian Naira (₦) and exclusive of any applicable taxes unless stated otherwise. Taxes, where applicable, are added at the prevailing rate. You are responsible for paying any bank charges, network charges, or other third-party charges that may apply to transactions initiated through the Platform.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">6. User responsibilities</h2>
              <ul className="text-sm leading-relaxed text-slate-700 dark:text-slate-300 list-disc pl-5 space-y-2">
                <li>You must provide accurate, current, and complete information during registration and loan application.</li>
                <li>You must safeguard your account credentials and not share them with any third party.</li>
                <li>You must not use the Platform for any illegal, fraudulent, or unauthorised purpose.</li>
                <li>You must not attempt to disrupt, overload, or reverse-engineer the Platform or its systems.</li>
                <li>You must not create multiple accounts to circumvent Platform restrictions or credit limits.</li>
                <li>You must notify Velo immediately of any unauthorised access to your account or any security breach.</li>
              </ul>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">7. Privacy</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                Our handling of your personal data is described in our <Link to="/privacy" className="text-velo-600 dark:text-velo-400 font-semibold hover:underline">Privacy Policy</Link>, which is incorporated into these Terms by reference. By using the Platform, you consent to the collection, use, and disclosure of your personal data as described in the Privacy Policy.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">8. Limitation of liability</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                To the maximum extent permitted by law, Velo shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of profits or revenues, arising from your use of the Platform. Velo's total liability for any claim arising out of or relating to these Terms or the Platform shall not exceed the total fees you have paid to Velo in the three (3) months preceding the event giving rise to the claim.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                Velo does not warrant that the Platform will be uninterrupted, error-free, or secure. The Platform is provided on an "as is" and "as available" basis. Velo disclaims all warranties, express or implied, including merchantability, fitness for a particular purpose, and non-infringement.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">9. Termination</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                Velo may suspend or terminate your account at any time, with or without cause, and with or without notice. Upon termination, all licences granted to you under these Terms will immediately cease. You remain liable for any outstanding obligations, including loan repayments, accrued fees, and pending investments, even after termination. Sections that by their nature should survive termination shall continue in effect, including the limitation of liability, indemnification, and dispute resolution provisions.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">10. Governing law &amp; disputes</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                These Terms are governed by the laws of the Federal Republic of Nigeria. Any dispute arising out of or relating to these Terms or the Platform shall be resolved exclusively in the competent courts of Lagos State, Nigeria, without regard to conflict of laws principles. You and Velo agree to attempt in good faith to resolve any dispute informally before initiating litigation.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">11. Contact</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                For any questions about these Terms, please contact us at <a href="mailto:support@velofinance.co" className="text-velo-600 dark:text-velo-400 font-semibold hover:underline">support@velofinance.co</a> or write to Velo Finance LTD, Lagos, Nigeria.
              </p>
            </section>
          </div>

          <div className="mt-10 text-center">
            <Link to="/" className="inline-flex items-center gap-2 text-sm font-semibold text-velo-600 dark:text-velo-400 hover:underline">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Back to home
            </Link>
          </div>
        </div>
      </div>
    </Layout>
  );
}
