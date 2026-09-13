# Tasks: PostgreSQL-First Data Migration & Google Sheets Backup-Only Mode

Every task maps to at least one AC in [spec.md](./spec.md). Statuses follow Spec Mode vocabulary: pending → in_progress → blocked/completed/cancelled. Every completed task records completion evidence and self-verified per-task TRs.

---

## Task 1: Infrastructure & Shared Decomposition Adapter in `store.ts`

**Priority:** high
**Status:** pending
**Maps to:** FR-1, FR-3, AC-R1, AC-R8
**Depends on:** (none — pure backend)
**Relevant paths:** `backend/server/store.ts`, `backend/server/db.ts`, `backend/database/001_initial_schema.sql`

### What to implement
1. **Add dirty-key tracking** to the Proxy layer. Currently any mutation calls `requestPersist()` blindly; extend it to `requestPersist(changedKey: StoreKey)` and maintain a `Set<StoreKey>` `dirtyKeys` that is cleared at the top of `persistStore()`.
2. **Create a shared decomposition adapter** function `decomposeAndUpsertAll(sql, changedKeys?: StoreKey[])` in `store.ts`. For every `StoreKey`, write an `INSERT ... ON CONFLICT (id) DO UPDATE` statement mapping each TS interface field to its corresponding PostgreSQL table and column. Use `snake_case` column names per the existing 41-table schema.
3. **Upsert each entity type** with correct foreign-key order (parents before children):
   - Group A (no FKs, run first): `roles`, `permissions`, `role_permissions`, `loan_products`, `investment_plans`, `platform_settings` → `system_settings`
   - Group B (user FK): `users` → `user_roles` → `investor_profiles`, `borrower_profiles`, `admin_profiles`, `addresses`, `wallets` → `payout_accounts`, `disbursement_accounts`, `kyc_cases` → `identity_verification_events`, `documents`, `consents`, `otp_challenges`, `password_reset_tokens`, `sessions`
   - Group C (application FKs): `loan_applications` → `loans` → `loan_schedules` → `repayments` → `repayment_allocations`, `credit_history_events`, `credit_scores`, `credit_reports`, `disbursements`, `application_drafts`
   - Group D (investment FKs): `investments` → `payouts`, `investor_withdrawals`
   - Group E (wallet / accounting): `wallet_transactions`, `ledger_entries` → `payment_intents`
   - Group F (admin / audit): `notifications`, `provider_webhook_events`, `admin_actions`, `audit_logs`, `reconciliation_items`, `fee_rules`
   - Group G (cross-cutting): `account_change_requests`
4. **Hook decomposition into two places:**
   - Inside `initializeStore()` immediately after `rebuildIndexes()` (call with all store keys to backfill any rows missing after `runtime_state` load).
   - Inside `persistStore()` (call with `dirtyKeys` only for the optimized path, falling back to all keys if dirty-set is empty on first write of old data).
5. **Ensure idempotency** via stable `ON CONFLICT (id)` clauses; for `users` also ON CONFLICT (email) DO UPDATE when matching by email is stronger for seeded rows.
6. **Add missing schema columns** if any TS interface fields have no SQL column (compare each TS interface field against the 41-table CREATE TABLE; if missing add an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in migrate.001 or append to a new 002_add_missing_cols.sql migration. Do not drop or rename any existing columns; only additive.)

### Test Requirements (task-local TRs)
- **TR T1.1 (rule):** `tsc -b` in the backend passes with zero new TS errors.
- **TR T1.2 (rule):** Calling `decomposeAndUpsertAll(sql)` with a fully populated in-memory store (create 2 test users + 1 KYC case + 1 wallet + 1 loan application + 1 investment in a unit-invocation inside `index.ts` test boot path or `migrate.ts` post-hook) produces ≥ 1 row in each of `users`, `kyc_cases`, `wallets`, `loan_applications`, `investments` tables verifiable via `SELECT count(*) FROM <table>`.
- **TR T1.3 (rule):** Running `persistStore()` after a single mutation (e.g. `users[0].fullName = 'Updated'`) results in an upsert for only the `users` table (verified by dirty-set logging or conditional SQL skip of non-dirty entity types).
- **TR T1.4 (rubric):** Entity-insertion correctness score 0-2 (2 = FK-order correct, all non-nullable fields set, snake_case consistent, no `.toISOString()` date drift). Pass threshold ≥ 2.

---

## Task 2: `seedGoogleSheets.ts` Script + Package Script Entry

**Priority:** high
**Status:** pending
**Maps to:** FR-2, FR-7, AC-R1, AC-R2, NFR-5
**Depends on:** Task 1 (decomposition adapter usable for cross-entity upserts)
**Relevant paths:** `backend/server/seedGoogleSheets.ts`, `backend/server/storage/googleDrive.ts` (for auth pattern), `backend/server/config.ts` (new env var types), `package.json`

### What to implement
1. **Authorize with Google Sheets API** using the existing service account credentials from env:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
   - Add Sheets readonly scope: `https://www.googleapis.com/auth/spreadsheets.readonly` to existing auth.
   - Add optional env var types in `config.ts`:
     - `GOOGLE_SHEETS_SPREADSHEET_ID: z.string().optional()` (default fallback = `1VelRf1cdCOWkf0jk6rLyQrkWK8GOaa9e9C6eblR9bdc` from Code.gs CONFIG, but allow override for staging)
     - `GOOGLE_SHEETS_SHEET_NAME: z.string().optional()` (default = `Loan Applications`)
2. **Implement `getSheetRows(range)`** helper that calls `sheets.spreadsheets.values.get()` with correct spreadsheetId + range and returns `{ header: string[], rows: any[][] }` (auto-map row arrays to objects by header index).
3. **Implement the 68-column mapping** per the table in spec FR-2. For each row:
   - **Step 1 — user upsert:** Email → findOrCreate `users` via decomposition user upsert (reuse the adapter from Task 1 but call directly); add BORROWER role; bcrypt random password hash; preserve DOB to `borrower_profiles.date_of_birth`; write primary address to `addresses`.
   - **Step 2 — KYC:** If BVN/NIN present → `findOrCreateKycCase(userId)`, set `bvn`, `nin`, `checklist.bvn/nin = true`, `categoryResults.BVN/NIN.status = VERIFIED`, upsert via adapter.
   - **Step 3 — loan application:** Build `LoanApplication` shape; `customerSnapshot` JSONB preserves personalInfo, businessInfo, businessRep, personalFinancial, businessFinancial, kyc, documents, witness, collateral from columns; `amountNaira`, `tenureDays` from loan columns; `stageStatuses` seeded via `seedLoanStageStatuses()`; `status` mapped per sheet; `submittedAt`, `approvedAt`, etc. set from date columns where applicable. Upsert via adapter.
   - **Step 4 — loan (if DISBURSED or later):** If status ≥ DISBURSED create `loans` row with principal, interest, fees, repayment totals; disbursedAt/dueAt; compute `loan_schedules` rows dividing total_repayment by tenure in 30-day chunks (or simple amortization); upsert via adapter.
   - **Step 5 — documents:** Parse file IDs from Drive URLs (pattern `https://drive.google.com/file/d/<FILE_ID>/view` → extract `<FILE_ID>`; folder URLs stored as-is in metadata JSONB). Insert `documents` rows per documentType mapped: ID Doc URL→PASSPORT_PHOTO (or ID_CARD_FRONT if IDType in sheet), Proof of Address→PROOF_OF_ADDRESS, Collateral Media→BUSINESS_REGISTRATION (best-effort classification), Signed Agreement URL → `loan_applications.signed_agreement_url`. Provider = `google_drive`.
   - **Step 6 — application draft:** Create `application_drafts` row with `lastSectionIndex`, full `data` snapshot reconstructed from row (mirror ApplicationData shape).
4. **Chunking:** Sheets API reads in batches of 10,000 cells; for large sheets split the range into row-block chunks of 500 and stream.
5. **Logging / counts:** Maintain `entityCounts` object with per-type `{ inserts, updates, skipped, errors }`. On completion write a `migration_jobs` row `job_name='seed_google_sheets'` with counts in metadata JSONB.
6. **Package scripts in `package.json`:**
   - `"seed:sheets": "tsx backend/server/seedGoogleSheets.ts"` (or node + tsc depending on existing build pattern — match existing scripts in the project `scripts` block).
   - `"migration:decompose": "tsx -e 'import(\"./backend/server/store.js\").then(s => s.initializeStore()).then(() => console.log(\"decompose done\"))'"`
7. **FR-7 default catalog seed:** At the end of seedGoogleSheets (and server startup as a safety net), if `loan_products` is empty upsert Personal Loan starter; if `investment_plans` empty upsert Short/Medium/Long Term plans. All idempotent.

### Test Requirements
- **TR T2.1 (rule):** Running `seedGoogleSheets` against a spreadsheet with 0 application rows (only header) logs `entityCounts.loan_applications.inserts = 0` and completes in ≤ 30s.
- **TR T2.2 (rule):** Run against the production sheet 1VelRf1cdCOWkf0jk6rLyQrkWK8GOaa9e9C6eblR9bdc (or a test copy) — every sheet row maps to 1 user row, 1 loan_applications row, optional kyc/documents correctly.
- **TR T2.3 (rule):** BVN/NIN values are logged only as last-4 in stdout / metadata JSONB; full values are never printed.
- **TR T2.4 (rubric):** Mapping quality 0-2. 2 = every 68 column has a destination (entity.field or JSONB key) and the mapping is in a single exported `COLUMN_TO_FIELD_MAP` object (so future column changes are one-line). Pass threshold ≥ 2.

---

## Task 3: PostgreSQL-Backed Validation Queries (replace in-memory hot-paths for constraint checks)

**Priority:** high
**Status:** pending
**Maps to:** FR-4, AC-R4, AC-R6, NFR-1
**Depends on:** Task 1 (relational rows exist to query against)
**Relevant paths:** `backend/server/auth.ts`, `backend/server/routes.ts`, `backend/server/store.ts`

### What to implement
1. **Email uniqueness on registration (`/api/v1/auth/register`):** Currently `findUserByEmail(email)` is O(1) in-memory Map lookup (fine for hot cache). Add a **DB-backed truth check** right before `users.push(newUser)`: `SELECT count(*) FROM users WHERE email ILIKE $1` (ILIKE for case-insensitive per existing `usersByEmail.set(email.toLowerCase())` convention). If count > 0 return 409 "Email already registered". If count === 0 but in-mem already has it → trust in-mem (both must agree; log a `store_reconciliation_warning` audit_log if they diverge and overwrite in-mem with DB value).
2. **`hasUnresolvedBorrowing(userId)` before new submit:** Replace array-scan with SQL:
   ```sql
   SELECT EXISTS (
     SELECT 1 FROM loan_applications WHERE borrower_id=$1 AND status IN ('SUBMITTED','KYC_PENDING','UNDER_REVIEW','MORE_INFORMATION_REQUIRED')
     UNION ALL
     SELECT 1 FROM loans WHERE borrower_id=$1 AND status NOT IN ('REPAID','CANCELLED','WRITTEN_OFF')
     LIMIT 1
   )
   ```
   Keep in-memory fallback if SQL fails (but log the error).
3. **BVN/NIN cross-user KYC check (before marking BV/N VERIFIED):** Add SQL:
   ```sql
   SELECT user_id FROM kyc_cases
   WHERE (bvn=$1 OR nin=$2) AND status='VERIFIED' AND id != COALESCE($3,'none')
   LIMIT 1
   ```
   If a row is returned, KYC decision cannot mark VERIFIED → return 409 with "This BVN/NIN is already linked to another verified account" instead of overwriting.
4. **OTP rate limit check (auth.ts createOtpChallenge):** Replace array scan with:
   ```sql
   SELECT count(*) FROM otp_challenges WHERE user_id=$1 AND action=$2 AND created_at > now() - interval '15 minutes'
   ```
   Cap at 5 per 15 min (match existing `max_attempts=5` intent from schema).
5. **Wallet balance truth check (investments, withdraw endpoints):** Before each lock/credit/debit action:
   ```sql
   SELECT available_minor FROM wallets WHERE user_id=$1 FOR UPDATE -- (skip FOR UPDATE if Neon tx doesn't support; fall back to plain SELECT + compare in mem)
   ```
   If DB balance !== in-mem `findWallet(userId).availableMinor`, overwrite in-mem wallet with DB (source of truth = DB now) then retry the operation. Log the reconciliation via `audit_logs` action `wallet_reconciliation`.
6. **Index rebuilding from DB:** After every upsert batch that touches the DB outside the Proxy mutation path (e.g. from seed scripts called externally), add a `rebuildFromDatabase(): Promise<void>` function in store.ts that SELECTs all rows and rehydrates the in-memory arrays from DB. Call it at end of Task 1's `initializeStore()` (prefer DB source of truth; merge with runtime_state JSONB preferring DB on conflict by updated_at timestamp).

### Test Requirements
- **TR T3.1 (rule):** All 5 validation categories above have a DB query path that executes (add `EXPLAIN` logs when `process.env.DEBUG_SQL='true'`); the original in-memory index path remains as fallback-only (not primary).
- **TR T3.2 (rule):** Registering 2 users with identical email via the API returns exactly the same 409 status + message shape as today (only difference: internal source of check is DB now).
- **TR T3.3 (rule):** Wallet balance in-mem mismatch forced test (manually edit DB wallets.available_minor via SQL, then call `/investor/dashboard`) → API response reflects DB value, in-mem arrays are reconciled, 1 audit_log row created.
- **TR T3.4 (rubric):** Fallback resilience 0-2 (2 = every new SQL query has a try/catch returning in-mem index path, so transient Neon connection issues do not break frontend UX). Pass ≥ 2.

---

## Task 4: PostgreSQL → Google Sheets Backup Export (`exportSheetsBackup.ts`) + Schedule Hook

**Priority:** medium
**Status:** pending
**Maps to:** FR-5, NFR-2, AC-R7
**Depends on:** Tasks 1, 2 (DB has data rows to export)
**Relevant paths:** `backend/server/exportSheetsBackup.ts`, `backend/server/index.ts`, `backend/server/config.ts`, `package.json`

### What to implement
1. **Add new env vars** in config.ts (all optional):
   - `GOOGLE_SHEETS_BACKUP_SPREADSHEET_ID: z.string().optional()` — if not supplied, use `GOOGLE_SHEETS_SPREADSHEET_ID`; log warning if shared with ingest sheet.
   - `GOOGLE_SHEETS_BACKUP_ENABLED: z.enum(['true','false']).optional()` — default `true` if BACKUP SPREADSHEET ID present
2. **Connect to Sheets** with same Google service account auth as Task 2, WRITE scope: `https://www.googleapis.com/auth/spreadsheets`.
3. **Per-tab export logic** — implement 9 tabs per spec FR-5:
   - Tab creation helper: `ensureSheetTab(spreadsheetId, tabName, headerRow)` → if tab doesn't exist create it; set column widths for readability; write `_Last Exported At (UTC): ${new Date().toISOString()}` in A1 (merged A1:Z1), header row in row 2, data rows row 3+.
   - Each tab `SELECT`s from the corresponding PostgreSQL table, joins user email where tab requires human-readable user attribution, and writes via `sheets.spreadsheets.values.batchUpdate` with `valueInputOption='RAW'` and `insertDataOption='OVERWRITE'`.
   - Export mapping per spec FR-5 table.
4. **Chunk data exports** to 5000-row batches; Sheets API batch limits.
5. **Schedule in `index.ts`**:
   - Run `exportSheetsBackup()` once immediately after `ensureDatabaseSchema()` + `initializeStore()` complete (await completion).
   - Then every 6 hours via `setInterval(exportSheetsBackup, 6 * 60 * 60 * 1000)` with a guard that only one run executes at a time (skip if previous still running — implement via in-mem `let exportRunning` boolean).
6. **Package script entry:** Add `"export:sheets": "tsx backend/server/exportSheetsBackup.ts"` (or Node built equiv matching existing scripts).
7. **`migration_jobs` tracking:** Every completed (or failed) export writes row with `job_name='sheets_backup_export:<iso>'`, `records_processed = sum(tab rows)`, metadata JSONB with counts per tab.

### Test Requirements
- **TR T4.1 (rule):** `exportSheetsBackup()` runs to completion, writes 9 tabs (or available tabs), each with A1 populated with a valid ISO8601 timestamp, and `migration_jobs` row has status `COMPLETED` with `records_processed > 0` when DB has data.
- **TR T4.2 (rule):** Running export twice produces identical data (idempotent — overwrite mode no duplicate rows).
- **TR T4.3 (rule):** If Sheets service account is not configured, `exportSheetsBackup()` exits gracefully with a clear "backup skipped: Google Sheets backup is not configured" log and no exception (never breaks server startup).
- **TR T4.4 (rubric):** Operator clarity 0-2 (2 = all 9 tabs have headers matching the 68-column COLUMNS ordering for Loan Applications tab, date columns formatted ISO8601, currency columns formatted with thousand separators). Pass ≥ 1.

---

## Task 5: Admin Migration Control Endpoints

**Priority:** medium
**Status:** pending
**Maps to:** FR-8, AC-R7, NFR-4
**Depends on:** Tasks 1, 2, 4
**Relevant paths:** `backend/server/routes.ts`

### What to implement
1. **`GET /api/v1/admin/migrations`** — protected by `requireRole('ADMIN')` + `requireAuth`:
   - SELECT last 50 rows from `migration_jobs ORDER BY started_at DESC LIMIT 50`.
   - Response: `{ ok: true, jobs: Array<{id, job_name, status, started_at, completed_at, records_processed, error, metadata}> }`.
2. **`POST /api/v1/admin/migrations/:jobName/run`** — protected by `ADMIN` or `LOAN_MANAGER` with `settings.manage`:
   - Valid `jobName` enum: `'decompose_runtime_state' | 'seed_google_sheets' | 'export_sheets_backup'`.
   - Execute corresponding function (Task 1 decompose, Task 2 seed, Task 4 export).
   - Response: `{ ok: true, job: migration_jobs_row, stats: entityCounts }`
   - If job fails: HTTP 500 with `{ ok: false, error: string, job: migration_jobs_row_with_error_populated }`.
3. **Rate limit per jobName:** Allow max 1 run every 60 seconds per job. Use `provider_webhook_events` pattern or small in-mem rate limit map.

### Test Requirements
- **TR T5.1 (rule):** Admin auth token without `settings.manage` permission (a LOAN_MANAGER with only `['loans.review']`) gets 403 when calling `POST /run`.
- **TR T5.2 (rule):** All 3 valid jobNames complete in < 120s each on a fresh DB.
- **TR T5.3 (rule):** GET `/migrations` returns a list descending by started_at, each row has non-null started_at, non-null status, metadata JSONB parses to object.

---

## Task 6: Build Verification + End-to-End Smoke Tests

**Priority:** high
**Status:** pending
**Maps to:** AC-R1, AC-R3, AC-R5, AC-R6, NFR-3
**Depends on:** Tasks 1-5 all completed
**Relevant paths:** (entire repo)

### What to implement
1. **Run full TS builds:**
   - `pnpm install --frozen-lockfile; pnpm run build` (the exact Render build command) → exit 0, no TS errors, no Vite build errors.
2. **End-to-end server smoke test script:** Create a short shell script or Node runner that:
   - Starts the server with fresh DB env vars.
   - Waits for `/health` → 200.
   - Registers 1 user via `/api/v1/auth/register` (INVESTOR role), verifies 1 row in `users`.
   - Registers 1 user (BORROWER), submits a loan application, verifies 1 row in `loan_applications` + `application_drafts`.
   - Investor funds wallet, creates investment, verifies wallet_transactions row + investments row.
   - Admin login, calls GET `/api/v1/admin/migrations`, POST `/run/decompose_runtime_state`, check jobs list.
3. **Frontend route smoke:** Cypress or manual checklist — load `/app`, `/investor/dashboard`, `/borrower/dashboard`, login flows render without data-drilling crashes.
4. **Manual DB inspection counts:**
   - `SELECT count(*) FROM users;`
   - `SELECT count(*) FROM loan_applications;`
   - `SELECT count(*) FROM runtime_state;` — should be 1 (JSONB still kept as secondary)
   - Verify counts > 0 after seed+startup.
5. **Fix any regressions** found; no code style changes outside fixes.

### Test Requirements
- **TR T6.1 (rule):** Render build command matches what failed on Render, now passes exit code 0.
- **TR T6.2 (rule):** Every entity category (users, KYC, wallets, loan_apps, loans, investments, documents, loan_schedules, repayments, payouts, audit_logs, notifications) has ≥ 1 row after a full `seed:sheets` + server startup + 1 new registration.
- **TR T6.3 (rule):** Admin summary endpoint returns correct totals (e.g. `totals.users == SELECT count(*) FROM users`) within 1 of tolerance for race conditions.
- **TR T6.4 (rubric):** Smoke test coverage score 0-2 (2 = 8+ distinct routes hit, both investor and borrower flows complete without 500). Pass ≥ 2.

---

## Task 7: Documentation & Operator Guide Inline Comments (in code, no new markdown docs)

**Priority:** low
**Status:** pending
**Maps to:** AC-R7, AC-R8, NFR-4
**Depends on:** Tasks 1-6 (final, to add comments reflecting true behavior)
**Relevant paths:** `backend/server/store.ts`, `backend/server/seedGoogleSheets.ts`, `backend/server/exportSheetsBackup.ts`, `README.md` (only update inline comments, add NOT new files)

### What to implement
1. **In `store.ts` top-of-file comments** — add a brief comment block describing:
   - The dual-write architecture (in-mem Proxy arrays ↔ PostgreSQL relational tables via `decomposeAndUpsertAll`).
   - `runtime_state` JSONB is now a **hot cache only**; source of truth for constraint checks = PostgreSQL tables.
   - How `dirtyKeys` optimization works.
   - How `rebuildFromDatabase()` reconciles in-memory arrays back to DB values on startup.
2. **In `seedGoogleSheets.ts`** — single comment block describing:
   - Column mapping enumeration reference (68 COLUMNS order).
   - Idempotency keys (application_id, users.email).
   - Password handling for seeded users (random bcrypt hash → must reset).
3. **In `exportSheetsBackup.ts`** — comment block listing 9 tabs + export frequencies.
4. **In `package.json` `scripts`** block — short `//`-style comments beside the 3 new script keys describing purpose (package.json doesn't allow comments; alternatively put brief descriptions in the `README.md` Scripts section if the repo already documents scripts there — follow existing README conventions, do not invent new structure).

### Test Requirements
- **TR T7.1 (rule):** `tsc -b` still passes after comment-only changes.
- **TR T7.2 (rubric):** Comment usefulness 0-2 (2 = a new contributor reading store.ts top comment understands PostgreSQL-first, JSONB-secondary architecture in 2 minutes). Pass ≥ 1.
