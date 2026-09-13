# Spec: PostgreSQL-First Data Migration & Google Sheets Backup-Only Mode

## Problem

The Velo Loan platform currently has **three disjoint data stores**, none of which correctly populate the 41 relational PostgreSQL tables that were designed as the system of record:

1. **Google Sheets (actual production data):** All real loan applications, applicant details (name, DOB, phone, email, BVN/NIN, financials, collateral, documents, drive URLs), and application lifecycles are saved exclusively to the `Velo Loan Applications` Google Sheet (spreadsheet `1VelRf1cdCOWkf0jk6rLyQrkWK8GOaa9e9C6eblR9bdc`, sheet `Loan Applications`) via `backend/google-apps-script/Code.gs`. These 68 columns map cleanly to the PostgreSQL relational schema — but **zero rows have ever been written there**.
2. **PostgreSQL JSONB document store (`runtime_state`):** The Node/Express backend (`backend/server/store.ts`) uses 34 typed in-memory JS arrays wrapped in Proxies, debounced 2-second writes to a single JSONB blob in `runtime_state.id = 'default'`. This layer services all API routes (auth, KYC, loans, investments, admin) but the 41 dedicated relational tables (users, loans, kyc_cases, loan_applications, documents, wallets, etc.) exist **only as empty schema** — they are never INSERTed into, never SELECTed from, and never validated against.
3. **Frontend LocalStorage:** `frontend/src/utils/storage.ts` persists loan application drafts (keyed `velo:applications:*`, index `velo:draft-index`) as a third fallback for the unauthenticated loan wizard flow.

**User-visible symptom reported 2026-09-13:** "I just check now no data at all, whereas there's some users already and KYC submission and different data basically." — Querying PostgreSQL shows empty tables; all real data remains only in Google Sheets.

## Users / Stakeholders

- **Borrowers & Investors:** Registrations, KYC verification events, wallets, investments, loans, repayments must survive server restarts and be queryable by ID/email/phone immediately.
- **Admins & Loan Managers:** Admin listing/decision endpoints (`/api/v1/admin/loans`, `/api/v1/admin/kyc-cases`, `/api/v1/admin/summary`, reports) must return data that matches the Google Sheet ground truth — not an empty in-memory store.
- **Operations / Finance:** Data validation (duplicate BVN/NIN checks, KYC ownership matching, credit history aggregation, wallet reconciliation) must run against typed relational columns, not ad-hoc searches inside a JSONB blob or Google Sheet formulas.
- **Audit & Compliance:** Nigeria-facing fintech (CBN expectations) — system-of-record must be a database, not Google Sheets. Sheets are acceptable only as point-in-time backup/export.

## Goals (what we must achieve)

1. **PostgreSQL is the single source of truth for every write.** All API routes, validation, queries, and webhook-processing must ultimately write to and read from the 41 relational tables (users, kyc_cases, loan_applications, loans, wallets, ledger_entries, investments, documents, payout_accounts, notifications, consents, audit_logs, provider_webhook_events, etc.).
2. **Backward compatibility with NO data loss.** Existing data in Google Sheets must be 100% seeded into PostgreSQL. Existing data in the `runtime_state` JSONB blob must be 100% decomposed into relational rows. No existing user registration, KYC case, loan application, wallet balance, or document is dropped.
3. **Google Sheets becomes backup/export only.** Apps Script continues to receive writes (so old clients don't break) but: (a) the Node backend no longer treats Sheets as authoritative, (b) we add a scheduled PostgreSQL → Sheets export job so Sheets always mirrors DB, (c) no API endpoint ever *reads* from Sheets for decisioning.
4. **Validation runs against PostgreSQL.** Checks currently done against in-memory indexes or Sheets lookups (email uniqueness, BVN ownership, duplicate phone for KYC, open-loan-per-borrower rule, wallet balance for investments/withdrawals, OTP rate limiting) must be backed by proper SQL constraints and queries.
5. **Zero breaking changes to the public API.** The frontend `apiClient.ts` interface (`/api/v1/auth/register`, `/api/v1/me/kyc`, `/api/v1/borrower/applications`, `/api/v1/admin/*`, etc.) stays byte-for-byte identical; response shapes and error codes do not change.

## Non-Goals (what we explicitly do NOT do in this spec)

- **Do NOT** rewrite `store.ts` to eliminate the in-memory Proxy layer (that would be a multi-month full ORM migration). Instead we add a **decomposition/dual-write adapter** that syncs the existing in-memory layer ↔ relational tables on every write and every server startup.
- **Do NOT** remove Google Apps Script or tear down the Apps Script spreadsheet/Drive infrastructure. It stays as backup, export destination, and compatibility shim for any legacy Apps Script callers.
- **Do NOT** add a new ORM (Prisma, Drizzle, Knex). Keep raw `@neondatabase/serverless` tagged-template SQL per project conventions.
- **Do NOT** change the frontend's localStorage draft persistence or the application wizard UX.
- **Do NOT** re-verify Prembly/Flutterwave transactions or re-send OTP/emails for already-processed records during seed/backfill.

## Functional Requirements

### FR-1 Decompose `runtime_state` JSONB into relational tables (idempotent, server-startup hook)
- On every `initializeStore()` call in `backend/server/store.ts`, after hydrating in-memory arrays from `runtime_state`, run a decomposition pass:
  - Iterate `users[]` → `INSERT ... ON CONFLICT (email) DO UPDATE` into `users` + `user_roles` + `investor_profiles` / `borrower_profiles` / `admin_profiles` child tables.
  - Iterate `wallets[]` → upsert `wallets`.
  - Iterate `ledger_entries[]` → upsert `ledger_entries`.
  - Iterate `wallet_transactions[]` → upsert `wallet_transactions`.
  - Iterate `kyc_cases[]` → upsert `kyc_cases`; for each category result / checklist sync column booleans as defined.
  - Iterate `identity_verification_events[]` → upsert `identity_verification_events`.
  - Iterate `documents[]` → upsert `documents`.
  - Iterate `payout_accounts[]` → upsert `payout_accounts`.
  - Iterate `investment_plans[]` → upsert `investment_plans`.
  - Iterate `investments[]` → upsert `investments`.
  - Iterate `loan_applications[]` → upsert `loan_applications`.
  - Iterate `loans[]` → upsert `loans` + `loan_schedules` (child).
  - Iterate `repayments[]` → upsert `repayments` + `repayment_allocations`.
  - Iterate `payouts[]` → upsert `payouts`.
  - Iterate `credit_history[]` → upsert `credit_history_events`.
  - Iterate `credit_scores[]` → upsert `credit_scores`.
  - Iterate `credit_reports[]` → upsert `credit_reports`.
  - Iterate `otp_challenges[]` → upsert `otp_challenges`.
  - Iterate `password_reset_tokens[]` → upsert `password_reset_tokens`.
  - Iterate `notifications[]` → upsert `notifications`.
  - Iterate `provider_events[]` → upsert `provider_webhook_events`.
  - Iterate `consents[]` → upsert `consents`.
  - Iterate `loan_products[]` → upsert `loan_products`.
  - Iterate `audit_logs[]` → upsert `audit_logs`.
  - Iterate `admin_ledger[]` → upsert `admin_ledger` (reuse `ledger_entries` table or create `admin_ledger_entries` mirror — whichever matches existing schema intent in `001_initial_schema.sql`).
  - Iterate `platform_settings[]` → upsert `system_settings`.
  - Iterate `investor_withdrawals[]` → upsert `investor_withdrawals` (or `payouts` with correct type).
  - Iterate `disbursement_accounts[]` → upsert `disbursement_accounts` (mirror child table if separate from `payout_accounts`).
  - Iterate `loan_disbursements[]` → upsert `disbursements`.
  - Iterate `account_change_requests[]` → upsert corresponding account-change table.
  - Iterate `application_drafts[]` → upsert `application_drafts`.
- Track completion in `migration_jobs` table (already exists) with `job_name = 'decompose_runtime_state'`, `started_at`, `records_processed`.
- Idempotency: every upsert keyed by entity `.id` and unique column constraints (email, user_id + unique per table).

### FR-2 Seed Google Sheets `Loan Applications` sheet into PostgreSQL (run-once + rerunnable script)
- Create `backend/server/seedGoogleSheets.ts` + add `package.json` script `seed:sheets`.
- Connect via existing Google service-account credentials already in env: `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (already used by `storage/googleDrive.ts` — use same auth scopes, add Sheets `https://www.googleapis.com/auth/spreadsheets.readonly` scope).
- Read the full sheet `1VelRf1cdCOWkf0jk6rLyQrkWK8GOaa9e9C6eblR9bdc` → range `Loan Applications!A2:BP` (68 columns per `COLUMNS` const in Code.gs).
- For each non-empty row (skip header), build entities following this deterministic column→table mapping:

| Sheet Column Block | → PostgreSQL Entity / Columns |
|---|---|
| Application ID, Applicant Type, Application Status, Date Created, Updated, Submitted | `loan_applications` (`application_id`, `applicant_type`, `status`, `created_at`, `updated_at`, `submitted_at`), `loans` if status ≥ DISBURSED |
| Full Name, DOB, Phone, Email | `users` (find-or-create by email upsert → `full_name`, `date_of_birth`, `phone`, `email`), `user_roles` → BORROWER, `borrower_profiles` (DOB) |
| Residential Address, State, LGA | `addresses` → `line1` = Residential Address, `state`, `lga`, `is_primary=true` |
| Business Name, Reg #, Type, Address, Industry, Years in Biz | `loan_applications.customer_snapshot.businessInfo` (JSONB, preserve full shape); if BUSINESS type also flag applicantType |
| Representative Name/Position/Phone/Email/Address | `loan_applications.customer_snapshot.businessRep` (JSONB) |
| BVN, NIN, ID Type, ID Number | `kyc_cases` (`bvn`, `nin`), `kyc_cases.categoryResults` BV/N = VERIFIED if non-empty, `kyc_cases.checklist.{bvn,nin}=true` |
| Employment Status, Employer, Monthly Income/Expenses, Business Revenue/Expenses, Loan Obligations, Repayment Source | `loan_applications.customer_snapshot.personalFinancial / businessFinancial` (JSONB), `credit_history_events` if obligations populated |
| Loan Amount, Tenure, Purpose, Collateral Type/Desc/Value/Ownership/Location/Ref | `loan_applications.amount_naira`, `tenure_days`, `loanRequest` snapshot JSONB; `loans.principal_naira` if disbursed |
| Interest, Service Fee, Processing, Other, Total Fees, Total Repayment, Disbursement Date, Repayment Date | `loans.total_interest_naira`, `total_fees_naira`, `total_repayment_naira`, `disbursed_at`, `due_at` if status allows; compute `loan_schedules` rows per tenure |
| Google Drive Folder URL, ID Doc URL, Proof of Address URL, Collateral Media URL, Signed Agreement URL | `documents` rows (provider=`google_drive`, provider_file_id=file ID extracted from URL, documentType mapped: PASSPORT_PHOTO / PROOF_OF_ADDRESS / BUSINESS_REGISTRATION / ID_CARD_FRONT + `signedAgreementUrl` → `loan_applications.signed_agreement_url`) |
| Last Section Index | `application_drafts.last_section_index` + `data` snapshot of full row for resume |

- Status mapping (Sheet statuses per `ADMIN_STATUSES` in Code.gs → `LoanStatus` enum):
  DRAFT → DRAFT, IN_PROGRESS → IN_PROGRESS, SUBMITTED → SUBMITTED, UNDER_REVIEW → UNDER_REVIEW, APPROVED → APPROVED, REJECTED → REJECTED, DISBURSED → DISBURSED (then set `loans.status=ACTIVE`), REPAID → REPAID.
- For upserts, match users first by email, then by phone, falling back to create new; mark seeded `users.created_at` with the row's "Date Created" sheet column to preserve audit.
- Seed script **must** be rerunnable (idempotent upserts by stable keys): for `loan_applications` use `application_id` as key; for `users` use email; report count of INSERT vs UPDATE on completion.
- Record `migration_jobs.job_name = 'seed_google_sheets'` with `records_processed` = sheet rows imported.
- Add `frontend`/apps-script compatible password field handling: seeded users get a random bcrypt hash stored in `users.password_hash` (because we never have original passwords from Sheets). Seeded users MUST reset password via `/api/v1/auth/password-reset/request` or admin reset, matching any existing Google-Sheet-side admin passwords via config override if provided.

### FR-3 Dual-write: on every `persistStore()`, also upsert relational rows
- Modify `backend/server/store.ts → persistStore()` to run the **same** decomposition upsert logic as FR-1 after (or as part of) the JSONB write. The existing 2s debounce continues to apply (so relational writes are batched with the same batching, no extra DB pressure).
- Add a helper `decomposeAndUpsertAll(sql)` that the startup hook AND `persistStore()` both call (DRY — one implementation, two call sites).
- Add a `dirty-set` optimization: Proxy mutation already sets `requestPersist()` — extend it to mark which `StoreKey` changed, so `decomposeAndUpsertAll(sql, changedKeys)` only upserts the affected entity types instead of re-scanning 34 arrays on every keystroke.
- Order: relational upserts first, then JSONB write, inside a single transaction where possible (Neon serverless has limited tx support; fall back to sequential if needed, both must succeed or fail the persist pair within 30s via Promise.all).

### FR-4 Validation queries run against PostgreSQL columns
- In `backend/server/auth.ts` and `routes.ts`, migrate the following checks from in-memory `.find()/filter()/some()` to `sql` queries where unique/constraint semantics matter:
  - User-email uniqueness (already backed by `users.email UNIQUE` — keep in-mem cache, but trust DB constraint first; convert in-memory duplicate push failures to graceful `409 Conflict` with DB-backed message).
  - `hasUnresolvedBorrowing(userId)` → `SELECT EXISTS (SELECT 1 FROM loan_applications WHERE borrower_id=$1 AND status IN ...) UNION SELECT EXISTS (SELECT 1 FROM loans WHERE borrower_id=$1 AND status NOT IN ...)`.
  - KYC "this BVN/NIN already verified by another user" check → SQL `SELECT COUNT(*) FROM kyc_cases WHERE bvn=$1 AND id != $current_case_id AND status = 'VERIFIED'`.
  - OTP rate limits → `SELECT COUNT(*) FROM otp_challenges WHERE user_id=$1 AND created_at > now() - interval 'X'`.
  - Wallet sufficient-balance for investments/withdrawals → compare via `wallets.available_minor` column alongside the in-memory index value (use in-memory as hot-path but validate via DB SELECT before a credit/lock, and reconcile mismatch by overwriting in-memory with DB authoritative value).
- **Rule:** where relational columns exist + there is a uniqueness / foreign-key / consistency concern, the DB query wins; in-memory arrays are reconciled to DB value after write. In-memory indexes remain for listing page O(1) lookups, never for truth.

### FR-5 PostgreSQL → Google Sheets backup export (scheduled, backup only)
- Create `backend/server/exportSheetsBackup.ts` + add `package.json` script `export:sheets`.
- Connect via same Google service account, scope `https://www.googleapis.com/auth/spreadsheets`.
- Designate a **separate** backup sheet ID (add new env var `GOOGLE_SHEETS_BACKUP_SPREADSHEET_ID`; default fallback = `GOOGLE_SHEETS_SPREADSHEET_ID` for shared-config deployments but **never write to the Apps Script production writer sheet** — clearly separate the two in config).
- Export rows:
  - Tab `Users`: id, email, full_name, phone, roles, kyc_status, created_at, last_login_at
  - Tab `Loan Applications`: columns mirror `COLUMNS` from Code.gs (68 cols, identical order) so the backup sheet is operationally equivalent to current ground-truth sheet
  - Tab `KYC`: kyc_case_id, user_email, bvn_last4, nin_last4, status, bvn_verified_at, nin_verified_at, liveness_verified_at, verified_at, rejection_reason
  - Tab `Wallets`: user_email, available_minor, held_minor, pending_deposit_minor, pending_payout_minor, total_credited, total_debited, currency
  - Tab `Investments`: user_email, plan_name, amount_naira, expected_earnings, tenure_days, annual_rate_pct, status, starts_at, matures_at, net_payout_naira
  - Tab `Loans`: user_email, application_id, principal_naira, total_interest_naira, total_fees_naira, total_repayment_naira, outstanding_naira, tenure_days, status, disbursed_at, due_at, paid_at
  - Tab `Repayments`: user_email, loan_id, amount_naira, principal, interest, late_fee, status, provider, tx_ref, created_at, verified_at
  - Tab `Payouts`: user_email, investment_id, payout_type, amount_naira, status, created_at, provider_reference, error
- Export uses clearvalues → setValues batches, writes a header row then data rows; append a `_Last Exported At (UTC)` note in A1 of each tab so operators can verify freshness.
- Schedule: call `exportSheetsBackup()` from server index sweep (run once at startup then every 6 hours via `setInterval` guarded by `migration_jobs` status). Each successful export writes row `migration_jobs.job_name = 'sheets_backup_export:<iso>'` with `records_processed` = total rows exported.

### FR-6 Apps Script legacy writes remain (dual-ingest compatibility)
- Do NOT remove `Code.gs` appendRow / setValues logic. It continues to write to the Apps Script "live" Google Sheet. But add a **new optional env toggle** `GOOGLE_SHEETS_INGEST_AS_BACKUP_ONLY=false` (default false = Apps Script remains live as before). When toggled to true in a future second deploy, Apps Script writes still succeed, they just write to the *backup sheet* destination only; out of scope for this spec — leave the hook.
- In `frontend/src/utils/storage.ts` and `frontend/src/context/ApplicationContext.tsx`, the localStorage + Apps Script draft-save paths remain fully intact for backward compatibility. But the server-side `/api/v1/borrower/application-draft` GET/PUT (already hitting `applicationDrafts[]` in store.ts + now decomposition upserting to DB) is authoritative.

### FR-7 Seed default catalogs (loan products, investment plans)
- If `loan_products` table is empty after seed, upsert one starter product "Personal Loan" (₦50,000 – ₦5,000,000, tenure 30–365 days, interest_rate_percent=18 SIMPLE_FLAT, processing_fee_percent=3, late_fee_percent=5 ONE_TIME, grace_period_days=3) idempotently keyed by name.
- If `investment_plans` empty, upsert three starter plans:
  - "Short Term Fixed" — min ₦50,000 / max ₦10,000,000, tenure 90 days, rate 12% ANNUALIZED, earlyLiquidityAllowed=true, earlyLiquidityFeePercent=2
  - "Medium Term Fixed" — tenure 180 days, rate 14%
  - "Long Term Fixed" — tenure 365 days, rate 16%
- Existing in-memory catalog entries win over defaults (never overwrite what's already in DB or JSONB); do seed only if truly empty.

### FR-8 Runtime reconciliation API & operator endpoint
- Add a protected admin endpoint `POST /api/v1/admin/migrations/:jobName/run` (requires `ADMIN` role or `settings.manage` permission):
  - `jobName = decompose_runtime_state` → re-run FR-1 decomposition now
  - `jobName = seed_google_sheets` → re-run FR-2 seeding now
  - `jobName = export_sheets_backup` → run FR-5 export now
- Response: `{ ok: true, job: migration_jobs row, stats: { inserts: N, updates: N, skipped: N, errors: [row] } }`
- Also add: `GET /api/v1/admin/migrations` → list last 50 rows of `migration_jobs` with status/records_processed/time.

## Non-Functional Requirements

### NFR-1 Data integrity / backward compatibility
- **Rule (data loss zero-tolerance):** After `seed:sheets` + server startup run, for every non-empty data row in the Apps Script `Loan Applications` sheet (columns Application ID, Full Name, Email, Phone, Loan Amount, Application Status, BVN-last-4, NIN-last-4, Drive URLs) the following hold:
  1. PostgreSQL `users` has a row with matching email/phone → `SELECT id FROM users WHERE email = ?` returns exactly one user, and a borrower profile + user_role BORROWER attached.
  2. PostgreSQL `loan_applications` has exactly one row keyed by `application_id` (or legacy App ID from sheet column A) with the same applicant type, status, borrower_id FK pointing to user, amountNaira ≥ 0, and customerSnapshot JSONB containing the full non-nullable columns of the row.
  3. If status = DISBURSED/REPAID → `loans` row exists with matching principal and repayment totals.
  4. If BVN/NIN non-empty → `kyc_cases` row exists with checklist booleans true.
  5. If document URLs present → `documents` rows with provider=google_drive, providerFileId parseable from URL.
- **Rubric (migration fidelity 0-5):** Spot check 20 random sheet rows via admin migration stats; 5 = all 20 rows map to all 5 entity types (users / loan_apps / loans-if-disbursed / kyc-if-applicable / docs-if-applicable) with zero data drift in numeric fields (amounts, dates, IDs last-4), statuses, and column booleans. Pass threshold: ≥ 4.

### NFR-2 Performance (server startup)
- **Rule:** Decomposition + apps-script seed combined complete in ≤ 120 seconds for a 10,000-row sheet and ≤ 30 seconds for an empty sheet (measured via `migration_jobs.started_at → completed_at`). If sheet exceeds limits, we chunk rows into Sheets API batches of 1,000, with progress logging per chunk.
- **Rule:** Dual-write `persistStore()` (with dirty-key optimization) for a 34-array store totalling 100,000 entities adds ≤ 150ms median wall time to the existing JSONB write on a warm Neon connection, sampled over 20 consecutive saves.

### NFR-3 API contract stability
- **Rule:** The following endpoints return `200 OK` with response shapes **byte-for-byte compatible** (same top-level keys, same array types, same enum values) to the current in-memory-only store, verified by running `npm run build` (TypeScript strict) plus the existing OpenAPI schema match:
  - `/api/v1/auth/register`, `/api/v1/auth/login`, `/api/v1/auth/otp/*`, `/api/v1/auth/password-reset/*`
  - `/api/v1/me`, `/api/v1/me/settings`, `/api/v1/me/profile-update/*`, `/api/v1/me/roles/add`
  - `/api/v1/me/kyc`, `/api/v1/me/kyc/bvn/verify`, `/api/v1/me/kyc/nin/verify`, `/api/v1/me/kyc/liveness/verify`, `/api/v1/me/kyc/documents`
  - `/api/v1/investor/dashboard`, `/api/v1/investor/wallet`, `/api/v1/investor/investment-plans`, `/api/v1/investor/investments`, `/api/v1/investor/payout-accounts`, `/api/v1/investor/wallet/funding`, `/api/v1/investor/wallet/withdraw`
  - `/api/v1/borrower/dashboard`, `/api/v1/borrower/loan-products`, `/api/v1/borrower/applications`, `/api/v1/borrower/application-draft`, `/api/v1/borrower/loans`, `/api/v1/borrower/credit-history`, `/api/v1/borrower/credit-score`
  - `/api/v1/admin/summary`, `/api/v1/admin/users`, `/api/v1/admin/investors`, `/api/v1/admin/kyc-cases`, `/api/v1/admin/loans`, `/api/v1/admin/payouts`, `/api/v1/admin/reports`, `/api/v1/admin/settings/platform`, `/api/v1/admin/investment-plans`, `/api/v1/admin/loan-products`

### NFR-4 Audit & operator visibility
- **Rule:** Every migration job (decompose / seed / export) produces a `migration_jobs` row on success AND failure (failure writes `error` column with full message + partial metadata JSONB of rows processed before failure). No silent failures.
- **Rule:** Seed script prints, and admin migrations endpoint returns, per-entity INSERT vs UPDATE vs SKIPPED counts: `{ users: {ins,upd,skip}, loan_applications: {...}, loans: {...}, kyc_cases: {...}, documents: {...}, loan_schedules: {...}, addresses: {...}, application_drafts: {...} }`.

### NFR-5 Security (Secrets & Sheets scope)
- **Rule:** Sheets API client uses only the existing `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` env vars; no new secret introduced, no hardcoded keys, no keys logged.
- **Rule:** Seed/export scripts **never** log BVN/NIN in full. Logs and admin endpoints show only last-4 (e.g. `12345***6789`). Raw BVN/NIN values transit only inside the seed process memory and are written only to the `kyc_cases.bvn` / `kyc_cases.nin` encrypted-at-rest PostgreSQL columns (Neon default).

## Constraints & Dependencies

- **Hard constraint:** The project uses `@neondatabase/serverless` v1.1.0 (HTTP / WebSocket proxy Postgres), so `BEGIN/COMMIT` multi-statement transactions are limited. Where transactions are unsupported, use idempotent upserts + deterministic retry order rather than partial rollbacks.
- **Hard constraint:** Google Sheets spreadsheet IDs and Google Apps Script deployment URLs referenced in `Code.gs` (CONFIG) and env must remain the authoritative input for seeding; do not ask the user to re-provision credentials — reuse service account already configured for Drive.
- **Hard constraint:** Password hashes for users created via Google Sheet seeding must use bcryptjs (same as auth.ts `10` rounds) with a cryptographically random bcrypt-compatible placeholder; original passwords cannot be recovered and operators must not bypass password-reset.
- **Dependency:** Prembly verification events and Flutterwave payment intents that exist only in Apps Script custom properties or runtime_state are considered secondary — seed their references where possible (e.g., `kyc_cases.provider_request_id` from any stored IDs), but do not call Prembly/Flutterwave live endpoints during seed/backfill.
- **Assumption:** `runtime_state` JSONB blob exists with current API user data (registrations done via /auth/register after Node API went live). If it is also empty, decomposition simply produces 0 rows from that source and all ground truth comes from Sheets.
- **Open Question (for user, non-blocking for implementation):** Should migrated apps-script users be marked with a `metadata.origin='google_sheets_seed'` in JSONB for future operator filtering? The implementation will add this by default; if the user prefers no tagging, it is a one-line removal.

## Acceptance Criteria

- **AC-R1 (rule):** `tsc -b && vite build` (frontend) + `tsc -b` (backend shared) compile with zero TS errors, and the new `seed:sheets` / `export:sheets` scripts, plus server startup, run via `pnpm`/`npm run` to completion without exceptions on a fresh `DATABASE_URL` + Sheets-enabled environment.
- **AC-R2 (rule):** Running `pnpm seed:sheets` with configured service-account + spreadsheet produces a `migration_jobs` row with status `status='COMPLETED'`, and per `migration_jobs.metadata.entityCounts`, at minimum `users.count ≥ 1 ∨ loan_applications.count ≥ 1` for any production sheet with 1+ application rows, else 0 counts logged for empty.
- **AC-R3 (rule):** Server startup, after initial DB schema bootstrap + migration jobs complete, responds to `GET /api/v1/admin/loans` with admin auth returning the same count of loan applications as the Google Sheet (excluding the header row).
- **AC-R4 (rule):** After server startup, each of these endpoint families performs at least one read from the corresponding PostgreSQL relational table (verified via `EXPLAIN` query instrumentation logs OR `pg_stat_statements` row-count delta > 0 from baseline): `/api/v1/admin/users` → `users`; `/api/v1/admin/kyc-cases` → `kyc_cases`; `/api/v1/admin/loans` → `loan_applications` + `loans`; `/api/v1/admin/investors` → `users` + `investments`; `/api/v1/admin/summary` → `wallets` + `ledger_entries` + `investments` + `loans` + `repayments`.
- **AC-R5 (rule):** Submitting a new loan application end-to-end via the frontend (StartApplication → fill → submit) produces: 1 new `loan_applications` row, 1 linked `applicationDrafts[]` decompose row, user row unchanged or created, signed_agreement_url propagated, and the PostgreSQL → Sheets backup export running on the next 6h cycle appends the new row to the backup sheet tab with correct Loan Amount / Status / Applicant Name / Email.
- **AC-R6 (rule):** No existing API endpoint returns new 500 errors for any in-spec request. Any request that previously returned a 2xx/4xx with a body returns the same class with the same shape.
- **AC-R7 (rubric):** Operator experience quality 0-2. Score 2 = admin migrations endpoint is reachable, last-50 list renders, running a job returns stats with per-entity counts, and 6h backup export produces a sheet tab with a clearly visible last-exported-at marker in A1. Pass threshold ≥ 2.
- **AC-R8 (rubric):** Code quality / maintainability 0-2. Score 2 = decomposition upsert logic is one shared function (no copy-paste between startup hook and persistStore), mapping tables Sheet→Postgres clearly enumerated, dirty-keys optimization present, no new console.log leaks in production paths, TS strict passes on all new files. Pass threshold ≥ 2.
