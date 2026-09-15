import { Link } from "react-router-dom";
import Layout from "../components/Layout";

const personalRequirements = [
  "Completed personal loan application",
  "BVN and NIN verification",
  "Government-issued identification document",
  "Recent passport photograph and live selfie verification",
  "Proof of residential address",
  "Valid phone number and email address",
  "Signature and acceptance of the loan agreement",
];

const businessRequirements = [
  "Completed business loan application",
  "Business registration or incorporation documents",
  "BVN and NIN verification for the business representative",
  "Government-issued identification for the representative",
  "Proof of business address and operating activity",
  "Recent passport photograph and live selfie verification",
  "Business bank or account details for disbursement",
  "Signature and acceptance of the loan agreement",
];

function RequirementCard({ title, description, items }: { title: string; description: string; items: string[] }) {
  return (
    <section className="velo-card p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-velo-50 text-velo-600">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div>
          <h2 className="text-lg font-bold text-velo-900 dark:text-white">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">{description}</p>
        </div>
      </div>
      <ul className="mt-5 space-y-3">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2.5 text-sm text-slate-700 dark:text-slate-300">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-velo-500" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function LoanRequirements() {
  return (
    <Layout>
      <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
          <Link to="/borrower" className="btn-ghost px-0 text-sm">← Back to dashboard</Link>
          <Link to="/apply" className="btn-primary">Start an application</Link>
        </div>
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-velo-600">Before you apply</p>
          <h1 className="mt-2 text-2xl font-bold text-velo-900 dark:text-white sm:text-3xl">Loan application requirements</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-400">
            Prepare the details and documents below to make your application smooth. We may request additional information during review.
          </p>
        </div>
        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          <RequirementCard title="Personal loan" description="For an individual applying in their own name." items={personalRequirements} />
          <RequirementCard title="Business loan" description="For a registered business applying through an authorised representative." items={businessRequirements} />
        </div>
        <div className="mt-5 rounded-2xl border border-blue-100 bg-blue-50/70 p-5 text-sm leading-6 text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200">
          Keep your information accurate and ensure uploaded documents are clear, current, and readable. Verification must be completed before an application can move to final review.
        </div>
      </main>
    </Layout>
  );
}
