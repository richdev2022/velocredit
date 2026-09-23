# Velo Finance LTD — Lending & Investment Platform

Production-ready Nigerian digital-lending and investment platform: **borrowers** apply for personal or business loans, **investors** fund their wallets and earn returns on investment plans, and an **admin/loan-manager workspace** operates the whole pipeline — KYC review, staged loan approval, Flutterwave disbursement, repayments, payouts, ledger, reports and content — from one place.

- **Customer site:** <https://www.velocredit.ng>
- **API:** <https://api.velocredit.ng> · Swagger UI: <https://api.velocredit.ng/docs> · OpenAPI JSON: <https://api.velocredit.ng/openapi.json>

## What the platform does

| Area | Capabilities |
|---|---|
| **Borrower** | Multi-step loan application wizard (personal & business), cloud save-and-resume drafts, auto-prefill for returning customers, a **fresh application ID for every new loan request**, loan products with configurable limits/fees/tenures, disbursement-account verification, Flutterwave repayments, credit score & history, A4 printable loan agreement |
| **Investor** | Wallet funding via Flutterwave, investment plans with configurable rates/tenures/liquidity rules, early-liquidity requests, withdrawals protected by OTP + idempotency keys, multiple payout accounts with admin-approved change requests, unified (deduplicated) transaction history, CSV exports |
| **Wallet integrity** | Every balance is **derived ledger truth**: held amounts are reconciled on read (phantom holds self-heal with refund + audit row), `available = credited − debited` invariant, double-entry admin ledger with platform balance |
| **KYC** | BVN & NIN verification via Prembly, face liveness check, document uploads to Google Drive, KYC reuse of loan-application documents, embedded Prembly widget flow, OTP-confirmed verification, admin case review per requirement, KYC gates on investing/withdrawing/applying |
| **Admin & Loan managers** | Unified workspace: dashboard, loan management (search/filter/paginate), staged application review with approve-all, decisions, disbursement + retry, payout and withdrawal management with detail view & retry, account-change approval queue, KYC cases, users/roles, loan managers, administrators, investment plans, loan products, platform settings, announcements, banner carousel, maintenance mode, audit log, business reports, reconciliation view |
| **Platform** | JWT auth with OTP login (WhatsApp/SMS/email), two-step admin login, password reset, role-based access, notifications, consent receipts, rate products resilient to misconfiguration, full CSV export coverage with date ranges, idempotent provider webhooks |

## Architecture

```
┌─────────────────────────┐         ┌──────────────────────────────────────┐
│  Frontend (SPA)          │  HTTPS  │  Backend API (Node 20+, Express 5)    │
│  www.velocredit.ng       │────────▶│  api.velocredit.ng                    │
│  React 18 + TypeScript   │         │  /api/v1/*  (JWT + role gates)        │
│  Vite + Tailwind CSS     │         │  /docs (Swagger UI)  /openapi.json    │
│  Vercel (SPA rewrite)    │         └───────┬──────────────────────────────┘
└─────────────────────────┘                 │
                                            │ server-side only, webhook-confirmed
                     ┌──────────────────────┼───────────────────────────────┐
                     ▼                      ▼                               ▼
        ┌────────────────────┐   ┌────────────────────┐        ┌────────────────────┐
        │ PostgreSQL (Neon)   │   │ Flutterwave         │        │ Prembly             │
        │ source of truth +   │   │ payments, payouts,  │        │ BVN/NIN/liveness/   │
        │ 7 SQL migrations    │   │ transfers, webhooks │        │ credit bureau       │
        └────────────────────┘   └────────────────────┘        └────────────────────┘
                     │
        ┌────────────┼─────────────────────────────┬──────────────────────────┐
        ▼            ▼                             ▼                          ▼
  Google Drive   Google Sheets                 Meta WhatsApp              Brevo email
  (KYC/private   (backup + export,             OTP delivery +             (transactional
   documents)     Apps Script ingest)           notifications              mail + OTP)
```

**Money movement rule:** every provider settlement (deposit, payout, disbursement, repayment) is initiated server-side with idempotency, verified against the provider API, and reconciled by background sweeps + signature-checked webhooks. The client never talks to providers directly.

**Tech stack:** React 18, TypeScript, Vite, Tailwind CSS, react-hook-form · Express 5, Zod, jsonwebtoken, bcrypt, Multer, swagger-ui-express · PostgreSQL via `@neondatabase/serverless` · Google Drive/Sheets via `googleapis` · jsPDF agreement generation · Vitest + supertest.

## Table of Contents

1. [Quick Start (Local Development)](#1-quick-start-local-development)
2. [Environment Configuration](#2-environment-configuration)
3. [API Documentation (Swagger)](#3-api-documentation-swagger)
4. [Roles & Key Flows](#4-roles--key-flows)
5. [Loan Application Lifecycle](#5-loan-application-lifecycle)
6. [KYC & Identity Verification](#6-kyc--identity-verification)
7. [Wallet & Money Movement](#7-wallet--money-movement)
8. [Admin Operations](#8-admin-operations)
9. [CSV Exports](#9-csv-exports)
10. [Notifications & Platform Content](#10-notifications--platform-content)
11. [Database & Persistence](#11-database--persistence)
12. [Project Structure](#12-project-structure)
13. [Testing & Verification](#13-testing--verification)
14. [Security](#14-security)
15. [Deployment](#15-deployment)
16. [Troubleshooting](#16-troubleshooting)
17. [Related Docs](#17-related-docs)
18. [License & Disclaimer](#18-license--disclaimer)

---

## 1. Quick Start (Local Development)

### Prerequisites

- **Node.js 18+** (Node 20+ recommended) and npm or pnpm (`packageManager: pnpm@9`)
- A PostgreSQL database (e.g. a free [Neon](https://neon.tech) database) — the API degrades to in-memory mode without `DATABASE_URL` for local experiments

### Install & run

```bash
# from the repository root (frontend + backend share one package.json)
npm install            # or: pnpm install

# terminal 1 — API on http://localhost:4000 (Swagger UI at /docs)
npm run dev:api

# terminal 2 — frontend on http://localhost:5173 (proxies config via VITE_API_URL)
npm run dev:web

# or run both together
npm run dev
```

Useful scripts:

| Script | Purpose |
|---|---|
| `npm run dev:api` / `dev:web` / `dev` | Watch-mode API / frontend / both |
| `npm run build` | Type-check then production build (frontend dist) |
| `npm run lint` | TypeScript project check (`tsc --noEmit`) |
| `npm run typecheck:api` | Backend type-check (`tsconfig.server.json`) |
| `npm test` | Full Vitest suite (unit + API integration) |
| `npm run seed:sheets` / `export:sheets` | Google Sheets seeding / backup export |

### First run checklist

1. Copy `.env.example` (or create `.env`) with at least `DATABASE_URL`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` — see [Environment Configuration](#2-environment-configuration).
2. Start the API; it applies the SQL migrations in `backend/database/` automatically on boot.
3. Open `http://localhost:4000/health` — should answer `{ ok: true }`.
4. Open `http://localhost:5173`, register a borrower or investor account and walk the flow. The admin workspace lives at `/admin` (login with the `ADMIN_EMAIL` credentials).

---

## 2. Environment Configuration

All backend configuration is validated at boot with Zod (`backend/server/config.ts`) — the process **fails loudly** on invalid/missing values instead of half-starting. In production, `DATABASE_URL`, `JWT_SECRET`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_SECRET`, `ADMIN_EMAIL` + `ADMIN_PASSWORD` (or `ADMIN_PASSWORD_HASH`) and `PREMBLY_WEBHOOK_SECRET` are **required**.

### Core

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | |
| `API_PORT` / `PORT` | `4000` | Render-style hosts set `PORT` |
| `API_HOST` | `0.0.0.0` | |
| `API_PUBLIC_URL` | `http://localhost:4000` | Advertised in health/docs output |
| `API_ORIGIN` | `http://localhost:5173` | Allowed CORS origin |
| `DATABASE_URL` | — | PostgreSQL connection string (Neon serverless driver) |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | — / `2h` | `JWT_SECRET` min 32 chars |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` / `ADMIN_PASSWORD_HASH` | — | Bootstrap administrator credentials (password min 12 chars) |

### Providers & integrations

| Group | Variables |
|---|---|
| **Flutterwave** | `FLUTTERWAVE_BASE_URL`, `FLUTTERWAVE_PUBLIC_KEY`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_ENCRYPTION_KEY`, `FLUTTERWAVE_WEBHOOK_SECRET` |
| **Prembly (KYC)** | `PREMBLY_BASE_URL`, `PREMBLY_API_KEY`, `PREMBLY_WEBHOOK_SECRET`, endpoint path overrides (`PREMBLY_BVN_PATH`, `PREMBLY_NIN_PATH`, `PREMBLY_BVN_FACE_PATH`, `PREMBLY_NIN_FACE_PATH`, `PREMBLY_ID_SCAN_PATH`, `PREMBLY_FACE_LIVENESS_PATH`, `PREMBLY_CREDIT_REPORT_PATH`, `PREMBLY_CREDIT_BUREAU_COMMERCIAL_PATH`, `PREMBLY_CREDIT_DATA_MODE`, `PREMBLY_LIVENESS_PATH`) |
| **Kudi SMS** | `KUDI_BASE_URL`, `KUDI_API_KEY`, `KUDI_SENDER_ID`, `KUDI_WEBHOOK_SECRET` |
| **Meta WhatsApp** | `META_WHATSAPP_ACCESS_TOKEN`, `META_WHATSAPP_APP_SECRET`, `META_WHATSAPP_VERIFY_TOKEN`, `META_WHATSAPP_BUSINESS_ACCOUNT_ID`, `META_WHATSAPP_PHONE_NUMBER_ID`, `META_GRAPH_API_VERSION` |
| **Brevo email** | `BREVO_API_URL`, `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME` |
| **Google (docs/sheets)** | `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `GOOGLE_DRIVE_PARENT_FOLDER_ID`, `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SHEETS_SHEET_NAME`, `GOOGLE_SHEETS_BACKUP_SPREADSHEET_ID`, `GOOGLE_SHEETS_BACKUP_ENABLED`, `GOOGLE_SHEETS_INGEST_AS_BACKUP_ONLY` |
| **Document storage (S3-compatible optional)** | `DOCUMENT_STORAGE_BUCKET`, `DOCUMENT_STORAGE_ENDPOINT`, `DOCUMENT_STORAGE_ACCESS_KEY`, `DOCUMENT_STORAGE_SECRET_KEY`, `DOCUMENT_MAX_SIZE_BYTES`, `DOCUMENT_ALLOWED_MIME_TYPES` |

### Platform behaviour

| Variable | Default | Notes |
|---|---|---|
| `OTP_TTL_SECONDS` / `OTP_RESEND_COOLDOWN_SECONDS` / `OTP_MAX_ATTEMPTS` | `300` / `60` / `5` | OTP hardening |
| `LOAN_AUTO_ELIGIBLE_SCORE_MIN` | `650` | Credit score ≥ → auto-approve path |
| `LOAN_AUTO_REVIEW_SCORE_MIN` | `550` | Score ≥ → fast manual review |
| `LOAN_REMINDER_DAYS` | `7,3,0` | Repayment reminder schedule |

### Frontend (`VITE_*`)

| Variable | Default | Notes |
|---|---|---|
| `VITE_API_URL` | `http://localhost:4000` | Absolute API origin. **Must** be `https://api.velocredit.ng` in production — all calls go through `apiClient`, which prefixes this origin |

The frontend also supports **admin runtime overrides** (localStorage `velo:admin-config`) for demo/staging tweaks — loan limits, fees, tenures, branding — see `frontend/src/utils/config.ts`. Production data always wins on the server side.

---

## 3. API Documentation (Swagger)

The API is self-documenting. The OpenAPI 3.0.3 spec lives in **`backend/server/openapi.ts`** and is served by the same process:

| Artifact | URL |
|---|---|
| Swagger UI | `https://api.velocredit.ng/docs` |
| OpenAPI JSON | `https://api.velocredit.ng/openapi.json` |

The spec documents **every route the server exposes** (162 operations across 107 paths): auth + OTP, profile/consents/notifications, all KYC endpoints, the full investor surface (wallet, funding, investments, early liquidity, withdrawals, payout accounts, exports), the full borrower surface (dashboard, products, drafts, applications, loans, credit, disbursement account, exports), the complete admin workspace (users, loan managers, administrators, KYC cases, application drafts, loans with staged review and disbursement, investment plans, loan products, platform settings, announcements, banners, ledger, withdrawals, payouts, disbursements, account-change requests, reports, reconciliation, audit logs, CSV exports), provider reference data and all webhook receivers (Flutterwave, Prembly, Kudi, Meta WhatsApp).

Authenticated routes use **Bearer JWT** (`Authorize` button in Swagger UI). Admin routes additionally require the ADMIN role — that token is only issued through the two-step admin login.

> Keep the spec in sync: when you add a route in `backend/server/routes.ts` or `index.ts`, add the matching entry to `openapi.ts`. A quick audit script pattern: extract `router.<method>("...")` registrations from `routes.ts` and diff them against `Object.keys(openapi.paths)`.

---

## 4. Roles & Key Flows

### Borrower
1. **Register → verify** (OTP via WhatsApp/SMS/email when enforced).
2. **KYC** — BVN/NIN verification, liveness, document uploads (see §6). Borrowing is gated on verified identity.
3. **Application wizard** — choose personal or business, fill sections (personal/business info, finances, KYC docs, disbursement account, loan request, collateral, agreement). Progress auto-saves as a cloud draft; returning customers get **auto-prefill** of previously entered data.
4. **Submit → review** — credit snapshot at submit; admin stages the application (§8). Statuses: `UNDER_REVIEW → APPROVED/REJECTED/MORE_INFORMATION_REQUIRED`, then on approval the loan record is created and **disbursed** to the verified disbursement account via Flutterwave.
5. **Repay** — Flutterwave checkout per repayment (minimum ₦50, capped at outstanding). Repayments update the schedule, credit history and credit score.

### Investor
1. **Register → KYC** — same verification pipeline; investing/withdrawing is gated on it.
2. **Fund wallet** — Flutterwave checkout; deposit is pending until provider-verified (webhook or client-side verify).
3. **Invest** — pick an active plan; principal is locked (held) until maturity, earnings accrue daily and appear in the analytics.
4. **Withdraw** — available balance only, OTP challenge + idempotency key, Flutterwave transfer with background status polling (stuck transfers fail-and-reverse after 15 min).
5. **Early liquidity** — request early exit on plans that allow it (fee rules per plan; forfeit-interest flag honoured).

### Admin / Loan manager
- Log in at `/admin` with **two-step authentication** (password → OTP). Loan managers are the same workspace with scoped permissions.
- Operate everything from one workspace (§8). Every sensitive action lands in the audit log.

---

## 5. Loan Application Lifecycle

### Every new loan request gets a fresh application ID

This is a hard API rule: `POST /borrower/applications` **creates a new application record with a new ID** whenever the referenced application is in a terminal status (`REPAID`, `CANCELLED`, `WRITTEN_OFF`). Re-sending a terminal application's ID falls through to creation (`input.applicationId = randomUUID()`) — the historical loan is never overwritten or re-used. Only non-terminal duplicate submissions (same in-flight ID) return the existing record as `duplicate: true`, and a foreign borrower's ID is rejected with `409`. The frontend mirrors this: drafts belonging to terminal applications are **purged locally and remotely**, the dashboard CTA becomes "Apply Again" (never "Continue Application"), and a stale wizard success screen self-resets.

### Statuses & gates

| Status | Meaning | Customer sees |
|---|---|---|
| `UNDER_REVIEW` | Submitted, awaiting decision | "Under review" banner, read-only application |
| `APPROVED` | Approved, awaiting disbursement | Approval notice |
| `DISBURSED` / `ACTIVE` | Money paid out, loan running | Repayment schedule + pay CTA |
| `REPAID` | Fully repaid (terminal) | History + **Apply Again** |
| `REJECTED` / `CANCELLED` / `WRITTEN_OFF` | Terminal | Reason + **Apply Again** |
| `MORE_INFORMATION_REQUIRED` | Admin needs input | Note with what to provide |

### Drafts, prefill & resume

- Drafts are saved locally and cloud-side (`GET/PUT/DELETE /borrower/application-draft…`) with one in-flight draft per borrower.
- `GET /borrower/application-draft` **self-heals**: if the draft points at a terminal application it is purged (DB + store) and the API answers `draft: null`.
- Auto-prefill **copies** previous personal/business/financial data into a brand-new application — it never re-uses the old application record.
- **Server-side reapply prefill** (`GET /borrower/applications/reapply-prefill`): merges EVERY previous application snapshot (oldest → newest, newest wins) with the account profile, the verified KYC case and the saved disbursement account, so even a customer whose last snapshot is incomplete gets every wizard section pre-filled. The wizard shows a "Your previous details are already filled in" banner; documents and the signed agreement are always re-provided.

### Staged review (admin)

Applications are reviewed stage-by-stage (applicant, business, financials, KYC, collateral, agreement). Admins approve/reject each stage (`PATCH /admin/loans/:loanId/stages/:stageKey`), approve all outstanding stages at once, record the overall decision, and disburse. If a disbursement account change is pending, disbursal is blocked until the borrower's new account is verified/approved (admin can trigger "request account update").

### Credit bureau (Prembly)

- **Commercial (Business) Advance** is the primary bureau product: when the customer's identity/profile holds a business RC number + registered name (`businessInfo` in the application snapshot), the platform calls `POST /verification/credit_bureau/commercial/advance` with `{ rc_number, company_name, data_mode }` and derives a bureau-equivalent score (300–850) from delinquency rating, facility performance, judgements/dishonoured cheques and monthly payment history.
- **Consumer advance fallback**: borrowers without an RC number are checked via their verified BVN (`/verification/credit_bureau/consumer/advance`).
- **Admin trigger** (`POST /admin/loan-applications/:applicationId/credit-bureau`, exposed as "Run credit bureau check" on every loan application's detail page): pulls a fresh report, stores a `creditReports` row, refreshes the application's `creditReportSnapshot` (external + recomputed internal score) and writes an audit log. Bureau codes map deterministically: `00` received, `01` record-not-found → FAILED, `02` → PENDING, `03` wallet balance → FAILED.
- Reports left **PENDING** are retried by the reconciliation cron every 10 minutes (commercial reports retry with their stored RC/company, consumer reports re-resolve BVN/name/DOB).

---

## 6. KYC & Identity Verification

- **BVN / NIN verification** via Prembly (`POST /me/kyc/bvn/verify`, `POST /me/kyc/nin/verify`) with name/DOB matching; OTP-confirm flows (`verify-confirm-otp` / `verify-resend-otp`) for supported verification types.
- **Face liveness** (`POST /me/kyc/liveness/verify`) and the **embedded Prembly widget** flow (`prembly-widget/complete`) with a signature-checked webhook (`/webhooks/prembly/kyc`).
- **Documents** upload to a private Google Drive folder (`POST /me/kyc/documents`); customers can **reuse documents** already uploaded with a loan application (`POST /me/kyc/reuse-application-documents`) instead of re-uploading.
- **Checklist model**: bvn, nin, liveness, proof of address, passport, signature. Admins decide per requirement (`POST /admin/kyc-cases/:id/requirement`) or issue an overall decision (`POST /admin/kyc-cases/:id/decision`) — the user is notified either way.
- **KYC gates** are enforced server-side on: creating investments, requesting early liquidity, withdrawing, submitting loan applications and payout actions. Blocked attempts are reported (`/me/kyc/action-blocked`) and drive in-app + email reminders.
- Admins can **reset** a user's KYC (`POST /admin/users/:id/kyc-reset`) to force re-verification.

---

## 7. Wallet & Money Movement

### Derived ledger truth (hold reconciliation)

Wallet balances are not trusted incrementally. `reconcileWalletHolds()` recomputes the **true held amount** from backing records (active investments, payouts awaiting account setup, KYC-gated pending approvals, in-flight withdrawals) and repairs any drift **in both directions** with compensating ledger rows:

- Phantom hold → `HOLD_RELEASE` credit refunds the investor (with an audit row).
- Under-held → `HOLD_RESTORE` debit restores the hold.

Reconciliation runs on dashboard/wallet reads, at boot, and after every maturity sweep. The investor dashboard therefore shows **Total credited**, **Total debited**, **Pending deposits/payouts** and the provable invariant `available = credited − debited`. The admin reconciliation view (`GET /admin/reconciliation`) surfaces wallet invariants and provider pending items.

### Funding & investments

1. `POST /investor/wallet/funding` creates a pending deposit + Flutterwave checkout link.
2. Credit happens after provider verification — signature-checked webhook (`/webhooks/flutterwave`) or explicit client verify (`/investor/wallet/funding/verify`, 3-retry verification, amount+currency+owner matching). Duplicate events are idempotent.
3. `POST /investor/investments` locks the principal (held balance), computes maturity + expected earnings from the plan (rate types: `ANNUALIZED`, `FLAT`, `TENURE_SPECIFIC`; optional early-liquidity fee, gateway fee, forfeit-interest flags, capacity cap).
4. Maturity sweeps release principal (`INVESTMENT_RELEASE`) and pay earnings (`INVESTMENT_RETURN`) as separate ledger semantics — earnings never touch holds.

### Withdrawals & payouts

- `POST /investor/wallet/withdraw` requires an **OTP challenge** (`POST /auth/otp/request`) and a client-generated **idempotency key**; replays return the original outcome instead of double-paying.
- Background verification polls Flutterwave; transfers without a provider reference that stay unconfirmed > 15 min are **failed and reversed** automatically (no eternal PROCESSING).
- Payout-account changes queue an **admin approval request** (`/admin/account-requests`) with an existing/new snapshot; the first account is auto-verified as default.
- Failed withdrawals/disbursements/payouts can be retried by admin (`/admin/withdrawals/:id/retry`, `/admin/disbursements/:id/retry`, `/admin/payouts/:id/retry`).

### Loan disbursement & repayment

- Admin disbursement (`POST /admin/loans/:loanId/disburse`) transfers to the borrower's **verified** disbursement account, records the double-entry ledger `DEBIT`, is idempotent per loan, and retries safely on failure.
- Borrower repayments open a Flutterwave checkout; confirmed repayments post to the schedule, ledger and credit history.

### Transaction history (deduplicated)

Investor/borrower history is built by `frontend/src/utils/unifiedTxs.ts` from ledger + wallet + first-class records with strict dedup rules (a funding appears once, an investment appears once, withdrawals show live status). The backend CSV export mirrors the same rules so downloads match the UI.

---

## 8. Admin Operations

The unified workspace (`frontend/src/components/admin/AdminWorkspace.tsx`) covers:

| Panel | Highlights |
|---|---|
| Dashboard / summary | Platform KPIs, charts, maintenance-mode gate |
| Loan management | List with **status filter, search, pagination** (`limit/offset/status/borrowerId/search`), detail with documents + credit snapshots, **staged review** (per-stage approve/reject, approve-all), decision recording, disbursement + retry, "request account update" |
| KYC cases | Queue, per-requirement decisions, overall decisions, KYC reset |
| Users | Create/edit/roles/suspend, KYC reset, investor earning-rate override, manual wallet credit (ledgered + audited) |
| Loan managers / Administrators | Create, permission scoping, activate/suspend, delete |
| Investments & plans | All investments; plan CRUD with liquidity rules and rate types |
| Withdrawal history | Filters (status, date range), search, pagination, detail with ledger trail + timeline, retry |
| Disbursements | All transfers (self-healing status read), per-borrower history, retry |
| Payouts | Attempt list, manual approval gate, retry |
| Account requests | Approve/reject bank-account change requests (payout + disbursement) |
| Ledger & reports | Double-entry ledger with platform balance; date-range business reports |
| Content | Announcements (max 280 chars), banner carousel (base64 upload, links, activation), platform settings (fees, rates, maintenance mode/message) |
| Audit log | Every sensitive action with actor/target enrichment, CSV export |

Loan products are created/edited with cross-field guards (e.g. `minAmountNaira` must be less than `maxAmountNaira` — rejected at the API boundary) and late-fee semantics (`ONE_TIME`, `COMPOUNDING_DAILY`, `COMPOUNDING_MONTHLY`).

---

## 9. CSV Exports

Every dataset is downloadable as CSV with optional `from`/`to` date range:

- **Admin** (`GET /admin/export/:dataset`): withdrawals, loans, payouts, ledger, kyc, investors, audit-logs, investments, disbursements, applications… unknown datasets return `400` with a hint listing valid ones.
- **Investor** (`GET /investor/export/:dataset`): transactions, investments, repayments, loans, schedule.
- **Borrower** (`GET /borrower/export/:dataset`): same dataset family.

Export rows use correct naira formatting (no ×100 minor-unit errors) and mirror the app's dedup rules for transactions.

---

## 10. Notifications & Platform Content

- **WhatsApp OTP** (Meta Cloud API, signature-verified webhook) with SMS (Kudi) and email (Brevo) channels; OTPs are TTL/cooldown/attempt-hardened. See `WHATSAPP_OTP_SETUP.md`.
- **Brevo** sends transactional email (verification, KYC outcomes, reminders, password reset).
- **Repayment reminders** scheduled by `LOAN_REMINDER_DAYS` (default 7/3/0 days before due).
- **In-app notifications** (`/me/notifications`) for KYC outcomes, disbursements, payouts, announcements.
- **Announcements + banner carousel** are admin-managed and served publicly via `/platform/status` and `/platform/banners`; **maintenance mode** can disable customer actions with a custom message.

---

## 11. Database & Persistence

- **PostgreSQL is the source of truth** (`DATABASE_URL`, Neon serverless driver). Migrations live in `backend/database/001…007*.sql` and are applied automatically on boot; they include hardening defaults, unique loan application references, and withdrawal/disbursement idempotency keys.
- Without `DATABASE_URL` (local experiments) the API runs on an in-memory store so the full test suite works offline.
- **Google Drive** stores private KYC/application documents (per-applicant folders, private sharing).
- **Google Sheets** remains as a backup/export channel (Apps Script ingest, backup spreadsheet, `seedGoogleSheets` / `exportSheetsBackup` scripts) — it is *backup only*, never the live store.
- Boot sequence also runs wallet-hold reconciliation and maturity sweeps before accepting traffic.

---

## 12. Project Structure

```
velocredit/
├─ frontend/
│  ├─ src/
│  │  ├─ components/            # shared UI + admin/ workspace panels
│  │  ├─ pages/                 # dashboards, wizard, KYC, admin entry, legal
│  │  ├─ sections/              # loan application wizard sections
│  │  ├─ services/              # apiClient (all API calls), adminApi, agreement generator
│  │  ├─ context/               # Auth, Application, Theme
│  │  ├─ types/ utils/          # loan types, config loader, unifiedTxs (dedup), calculators
│  │  └─ index.css
│  └─ index.html
├─ backend/
│  ├─ server/
│  │  ├─ index.ts               # Express app, webhooks, /docs, /openapi.json, boot checks
│  │  ├─ routes.ts              # the /api/v1 router (150+ endpoints)
│  │  ├─ openapi.ts             # OpenAPI 3.0.3 spec (Swagger UI source)
│  │  ├─ store.ts               # domain store + PostgreSQL persistence
│  │  ├─ auth.ts                # JWT, OTP challenges, password reset
│  │  ├─ investments.ts         # investment lifecycle, maturity sweeps
│  │  ├─ credit.ts creditReconciliation.ts loanDecision.ts
│  │  ├─ providers/             # flutterwave, prembly, kudi, meta
│  │  ├─ reconciliation.ts      # provider + wallet reconciliation sweeps
│  │  ├─ email.ts reminders.ts  # Brevo mail, repayment reminders
│  │  ├─ db.ts migrate.ts       # Neon connection, migration runner
│  │  └─ storage/googleDrive.ts
│  └─ database/                 # 001–007 SQL migrations
├─ scripts/                     # smoke + e2e test harnesses (ts, run with tsx)
├─ vercel.json                  # frontend deployment (SPA rewrite)
└─ WHATSAPP_OTP_SETUP.md, BREVO_AND_ADMIN_SETUP.md, INVESTOR_AND_PLATFORM_REQUIREMENTS.md
```

**Frontend API discipline:** every network call goes through `frontend/src/services/apiClient.ts` / `adminApi.ts`, which prefix the absolute `VITE_API_URL` origin and pick the right token (admin token for `/api/v1/admin/*`). Raw relative `fetch()` calls are forbidden — in production they hit the frontend host and receive the SPA's `index.html` (this caused the infamous `Unexpected token '<'` error; see Troubleshooting).

---

## 13. Testing & Verification

```bash
npm test                     # Vitest: unit + in-process API integration suites
npx tsc --noEmit             # frontend type check
npm run typecheck:api        # backend type check
npm run build                # production build
```

Notable suites & harnesses (in `scripts/`, run with `npx tsx scripts/<file>.ts`):

| Harness | Covers |
|---|---|
| `e2eExportTest.ts` | Boots the real API in-process, seeds data with real JWTs, asserts 21 checks across all CSV export datasets (dedup, amounts, headers, date filters) |
| `e2eWalletReconcileTest.ts` | Replicates corrupted wallets (phantom holds, over-releases, stuck withdrawals) and asserts self-healing in both directions — 16 checks |
| `e2eStaleDraftTest.ts` | Terminal-application drafts purge; re-application after REPAID creates a **fresh application ID** while history stays untouched — 5 scenarios |
| `smoke*.ts` | Loan end-to-end, approval/disbursement, product resolution, disbursement account, KYC docs, transaction history, rejection-reopen |

Full verification before every push: both type checks + `npm test` (56 tests) + `npm run build` must pass.

---

## 14. Security

- **JWT auth** (2h expiry, refresh endpoint) with role gates (`INVESTOR`, `BORROWER`, `ADMIN`, `LOAN_MANAGER`) enforced server-side on every route.
- **Two-step admin login** (password → OTP) with admin-token separation from customer tokens.
- **OTP hardening**: TTL, resend cooldown, max attempts, single-use challenges; withdrawal-grade OTP for money movement.
- **Idempotency** on all money paths (withdrawals, disbursements) plus unique DB constraints (migrations 005–007).
- **Webhook signature verification** for Flutterwave, Prembly (HMAC-SHA512) and Meta; raw-body capture then constant-time compare.
- **Helmet**, CORS restricted to `API_ORIGIN`, bcrypt(12) password hashing, Zod validation at every boundary, documents in a private Drive bucket with per-user authorization on download.
- **Audit log** (`recordAdminAudit`) on every sensitive admin action, exportable.

---

## 15. Deployment

### Frontend (Vercel)

- `vercel.json` builds the SPA (`outputDirectory: frontend/dist`) with an index rewrite.
- Set **`VITE_API_URL=https://api.velocredit.ng`** at build time.
- **Redeploy after every frontend-affecting merge** — UI fixes only go live with a new bundle. This has bitten us before (e.g. admin Loan management fix `55fbdf8` required a redeploy to take effect).

### Backend (any Node host — current production runs on Render)

- Start command: `npm run dev:api` equivalent for production (`tsx backend/server/index.ts` behind a process manager or a compiled build).
- Render-style hosts set `PORT`; the app listens on `0.0.0.0:$PORT` immediately (deploy guard fails loudly on bad env rather than timing out the port scan).
- Production env must include: `DATABASE_URL`, `JWT_SECRET`, `ADMIN_EMAIL` + password/hash, `FLUTTERWAVE_*` (incl. webhook secret), `PREMBLY_API_KEY` + `PREMBLY_WEBHOOK_SECRET`, and the notification/Drive/Sheets credentials you use.
- Provider webhooks must point at `https://api.velocredit.ng/api/v1/webhooks/…` (flutterwave, prembly/kyc, meta-whatsapp).
- **Restart the backend after every backend-affecting merge** — routes and migrations apply at boot (e.g. the CSV export routes 404'd in production until a deploy pulled them).

### Production checklist

1. `npm run build` + both type checks + `npm test` green locally.
2. Push → deploy backend → check `/health`, `/openapi.json`, `/docs`.
3. Deploy frontend → verify www.velocredit.ng actually loads the new bundle (hard refresh).
4. Confirm provider webhooks still answer 202 and the audit log records a test action.

---

## 16. Troubleshooting

| Symptom | Cause & fix |
|---|---|
| Frontend error `Unexpected token '<', "<!doctype "... is not valid JSON` | A request hit the **frontend host** instead of the API (SPA fallback returned HTML). All calls must use `apiClient`/`adminApi` with absolute `VITE_API_URL`. Check for raw relative `fetch()` calls; redeploy the frontend after fixing. |
| Admin list shows `0 applications` but data exists | Same root cause as above (HTML parsed as JSON) or a stale bundle — fix the fetch path and **redeploy the frontend**. |
| `route not found` on export/detail endpoints in production | Production backend is older than the repo. **Deploy/restart the backend** — the routes exist in code. |
| Balances look wrong (held ≠ reality, credited/debited mismatch) | Reconciliation is derived on read; a stale wallet self-heals on next dashboard/wallet load or boot. If it persists, check `GET /admin/reconciliation` and the `HOLD_RELEASE`/`HOLD_RESTORE` audit rows. |
| Withdrawal stuck in PROCESSING | Background verification fails-and-reverses after 15 min without a provider transfer; admin can also inspect `/admin/withdrawals/:id/detail` and retry manually. |
| `Port scan timeout reached` on deploy | Env validation failed at boot — the log prints the exact Zod field errors (`[FATAL] Environment configuration validation failed`). Fix the listed variables. |
| Loan re-application reuses an old application ID | Fixed at the API level (terminal-status IDs never reused; new record always created). Ensure production backend is on `1ae81eb` or later and the frontend bundle is redeployed. |

---

## 17. Related Docs

- [`WHATSAPP_OTP_SETUP.md`](./WHATSAPP_OTP_SETUP.md) — Meta WhatsApp OTP production setup
- [`BREVO_AND_ADMIN_SETUP.md`](./BREVO_AND_ADMIN_SETUP.md) — Brevo email + administrator bootstrap
- [`INVESTOR_AND_PLATFORM_REQUIREMENTS.md`](./INVESTOR_AND_PLATFORM_REQUIREMENTS.md) — original investor/platform requirements
- [`backend/server/openapi.ts`](./backend/server/openapi.ts) — source of the Swagger spec
- Legacy Google Apps Script backend notes: `backend/google-apps-script/` (superseded by the Node API; Sheets ingest remains as backup)

---

## 18. License & Disclaimer

© Velo Finance LTD. All rights reserved.

This repository is proprietary production software. The loan agreement template generated by the app is a configurable legal template and must be reviewed and approved by an appropriate legal professional before production use.


