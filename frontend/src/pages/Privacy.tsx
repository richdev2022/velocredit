import { useEffect } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import SEO from "../components/SEO";

export default function Privacy() {
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
            <h1 className="mt-1 text-3xl sm:text-4xl font-extrabold text-velo-900 dark:text-white">Privacy Policy</h1>
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">Last updated: 20 September 2026</p>
          </div>

          <div className="space-y-8 max-w-none">
            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">1. Introduction</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                Velo Finance LTD ("Velo", "we", "us") is committed to protecting the privacy and security of your personal data. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use the Velo Finance platform (the "Platform"). We comply with the Nigeria Data Protection Act 2023 and the Nigeria Data Protection Regulation (NDPR) 2019. By using the Platform, you consent to the practices described in this policy.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                This policy applies to all users of the Platform, including borrowers, investors, administrators, and visitors. If you do not agree with the practices described in this policy, you should not use the Platform. We may update this policy from time to time, and we will notify you of material changes via email or a notice on the Platform.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">2. Data we collect</h2>
              <h3 className="text-sm font-bold text-velo-900 dark:text-white mt-4 mb-2">2.1 Information you provide</h3>
              <ul className="text-sm leading-relaxed text-slate-700 dark:text-slate-300 list-disc pl-5 space-y-1">
                <li>Account information: full name, email address, phone number, password.</li>
                <li>Identity verification: Bank Verification Number (BVN), National Identification Number (NIN), date of birth, residential address, state, LGA.</li>
                <li>Business information: business name, registration number, business type, address, industry, years in operation, representative details (for business loans).</li>
                <li>Financial information: employment status, monthly income, monthly expenses, existing loan obligations, expected repayment source.</li>
                <li>Bank account details: account name, bank name, account number, bank code (for disbursements and withdrawals).</li>
                <li>Loan application data: requested amount, tenure, purpose, collateral information, witness contact.</li>
              </ul>
              <h3 className="text-sm font-bold text-velo-900 dark:text-white mt-4 mb-2">2.2 Information we collect automatically</h3>
              <ul className="text-sm leading-relaxed text-slate-700 dark:text-slate-300 list-disc pl-5 space-y-1">
                <li>Device and browser information: IP address, browser type, operating system, device fingerprint.</li>
                <li>Usage data: pages visited, time spent, clicks, form submissions, transaction history.</li>
                <li>Cookies and similar technologies: session identifiers, authentication tokens, preferences.</li>
                <li>Communications: records of your interactions with our customer support team via email, SMS, or WhatsApp.</li>
              </ul>
              <h3 className="text-sm font-bold text-velo-900 dark:text-white mt-4 mb-2">2.3 Information from third parties</h3>
              <ul className="text-sm leading-relaxed text-slate-700 dark:text-slate-300 list-disc pl-5 space-y-1">
                <li>Prembly: identity verification results (BVN, NIN, liveness check, credit bureau reports).</li>
                <li>Flutterwave: transaction status, transfer references, webhook events for disbursements and repayments.</li>
                <li>Credit bureaus: credit scores, outstanding obligations, payment history.</li>
              </ul>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">3. How we use your data</h2>
              <ul className="text-sm leading-relaxed text-slate-700 dark:text-slate-300 list-disc pl-5 space-y-2">
                <li><strong>Service delivery:</strong> to process loan applications, disburse funds, calculate returns, process withdrawals, and manage your account.</li>
                <li><strong>Identity verification:</strong> to verify your identity against BVN, NIN, and liveness checks via Prembly.</li>
                <li><strong>Credit assessment:</strong> to evaluate your creditworthiness using credit bureau data and internal scoring models.</li>
                <li><strong>Communication:</strong> to send transactional notifications, OTP codes, repayment reminders, and policy updates via SMS (Kudi), email (Brevo), or WhatsApp (Meta).</li>
                <li><strong>Fraud prevention:</strong> to detect and prevent fraud, money laundering, and unauthorised access.</li>
                <li><strong>Compliance:</strong> to comply with regulatory requirements, including CBN anti-money laundering (AML) and know-your-customer (KYC) regulations.</li>
                <li><strong>Improvement:</strong> to analyse Platform usage and improve our products, services, and user experience.</li>
                <li><strong>Legal:</strong> to enforce our Terms &amp; Conditions, resolve disputes, and protect our rights.</li>
              </ul>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">4. Legal basis for processing</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                We process your personal data on the following legal bases: (a) <strong>contract</strong> — to fulfil our contractual obligations to you under the Terms &amp; Conditions; (b) <strong>legal obligation</strong> — to comply with CBN, NDPR, and other applicable laws; (c) <strong>legitimate interest</strong> — to operate, secure, and improve the Platform, and to prevent fraud; (d) <strong>consent</strong> — for marketing communications and optional features, which you may withdraw at any time.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">5. Data sharing</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                We share your personal data with the following categories of recipients, strictly on a need-to-know basis and under appropriate data protection agreements:
              </p>
              <ul className="text-sm leading-relaxed text-slate-700 dark:text-slate-300 list-disc pl-5 space-y-2 mt-3">
                <li><strong>Payment providers:</strong> Flutterwave for disbursements, repayments, and investor payouts.</li>
                <li><strong>Identity verification:</strong> Prembly for BVN, NIN, and liveness verification.</li>
                <li><strong>Communication providers:</strong> Kudi (SMS), Brevo (email), Meta (WhatsApp).</li>
                <li><strong>Credit bureaus:</strong> to retrieve and report credit information.</li>
                <li><strong>Cloud infrastructure:</strong> Neon (Postgres database), Google Drive (document storage), Vercel/Render (hosting).</li>
                <li><strong>Regulators:</strong> CBN, NIBSS, NDPC, and other competent authorities where legally required.</li>
                <li><strong>Professional advisors:</strong> auditors, lawyers, and accountants under confidentiality obligations.</li>
              </ul>
              <p className="mt-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                We do not sell your personal data to any third party. We do not share your data with any third party for their own marketing purposes.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">6. Data security</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                We implement industry-standard technical and organisational measures to protect your personal data, including: TLS encryption for data in transit, bcrypt password hashing (cost factor 12), JWT authentication with short-lived access tokens, role-based access control (RBAC) for admin endpoints, OTP step-up verification for sensitive admin actions, HMAC-SHA256 signature verification for Flutterwave and Meta webhooks, and an in-memory store reconciled to a managed Postgres database. Sensitive KYC fields (BVN, NIN) are accessible only to authorised administrators and are masked in logs.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                Despite our efforts, no system can be guaranteed 100% secure. In the event of a data breach affecting your rights, we will notify you and the Nigeria Data Protection Commission (NDPC) within 72 hours of becoming aware of the breach, in accordance with the NDPR.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">7. Data retention</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                We retain your personal data for as long as your account is active, and thereafter for a period determined by the following criteria: (a) loan records and credit data — 10 years from loan closure, in line with CBN record-keeping requirements; (b) KYC verification data — 5 years after account closure; (c) transaction records — 7 years; (d) marketing communication records — until you withdraw consent; (e) audit logs — 3 years. After the retention period, data is securely deleted or anonymised.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">8. Your rights</h2>
              <ul className="text-sm leading-relaxed text-slate-700 dark:text-slate-300 list-disc pl-5 space-y-2">
                <li><strong>Access:</strong> request a copy of the personal data we hold about you.</li>
                <li><strong>Rectification:</strong> request correction of inaccurate or incomplete data.</li>
                <li><strong>Erasure:</strong> request deletion of your data, subject to legal retention obligations.</li>
                <li><strong>Restriction:</strong> request that we limit processing of your data pending dispute resolution.</li>
                <li><strong>Portability:</strong> receive your data in a structured, machine-readable format.</li>
                <li><strong>Objection:</strong> object to processing based on legitimate interest or for direct marketing.</li>
                <li><strong>Withdrawal of consent:</strong> withdraw consent at any time without affecting the lawfulness of prior processing.</li>
              </ul>
              <p className="mt-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                To exercise any of these rights, contact us at <a href="mailto:privacy@velofinance.co" className="text-velo-600 dark:text-velo-400 font-semibold hover:underline">privacy@velofinance.co</a>. We will respond to your request within 30 days. If you are dissatisfied with our response, you may lodge a complaint with the Nigeria Data Protection Commission (NDPC).
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">9. Cookies</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                The Platform uses essential cookies to maintain your session and authentication state. We do not use third-party advertising or tracking cookies. You can configure your browser to refuse cookies, but this may affect your ability to use the Platform.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">10. Children's privacy</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                The Platform is not directed to individuals under the age of 18. We do not knowingly collect personal data from children. If we become aware that we have collected personal data from a child, we will take steps to delete such data as soon as possible.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">11. Changes to this policy</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                We may update this Privacy Policy from time to time to reflect changes in our practices, technology, legal requirements, or other factors. We will post the updated policy on the Platform and update the "Last updated" date. For material changes, we will notify you by email or a prominent notice on the Platform at least 30 days before the changes take effect.
              </p>
            </section>

            <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8">
              <h2 className="text-xl font-bold text-velo-900 dark:text-white mb-3">12. Contact</h2>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                For any questions, requests, or complaints regarding this Privacy Policy or your personal data, please contact our Data Protection Officer at <a href="mailto:privacy@velofinance.co" className="text-velo-600 dark:text-velo-400 font-semibold hover:underline">privacy@velofinance.co</a> or write to Velo Finance LTD, Lagos, Nigeria.
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
