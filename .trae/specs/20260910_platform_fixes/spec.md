# Velo Loan Platform — Specification (Spec)

**Date:** 2026-09-10
**Scope:** Frontend (React + TSX) and Backend (Express + TS) monorepo
**Natural Language:** English

---

## 1. Problem

The Velo Loan platform has multiple critical issues across authentication,
verification flows, admin UI, dashboard UX, data completeness, and wallet
funding that prevent users from completing onboarding, using features, and
administering the platform effectively.

## 2. Users & Goals

| User type | Goals |
|---|---|
| **New / Existing Borrower & Investor** | Register once, log in, complete OTP verification, complete BVN/NIN + liveness KYC, see correct verification status, access ALL features without permission errors, use an elegant dashboard with navigation. |
| **Platform Admin / Loan Manager** | Navigate a well-organised admin sidebar (ledger, KYC, loans, etc. on their own pages), approve/reject individual loan stages AND the overall loan, see dark mode applied consistently. |

## 3. Functional Requirements

### 3.1 Login — Unverified user OTP flow

- **R1 (rule):** When a user submits valid email + password on the login page,
  if the backend returns `403` with `code: "OTP_REQUIRED"` (or equivalent
  signal indicating the user has `isActive === false` / OTP not verified), the
  frontend MUST NOT navigate to the dashboard. Instead it MUST show an
  "Account not yet verified" prompt (modal or inline panel) that lets the user
  select an OTP delivery channel (**SMS**, **WhatsApp**, or **Email**), send
  the OTP via that channel, present a 6-digit OTP input, and call
  `/auth/register/verify-otp` (or an equivalent login OTP endpoint) to
  activate the account and proceed to issue a token + navigate the user to
  the correct dashboard (Investor if `roles.includes("INVESTOR")`, otherwise
  Borrower).
- **R2 (rule):** The OTP panel MUST include a resend button that respects the
  server-side resend cooldown and shows a countdown.
- **R3 (rule):** If login credentials are invalid, the usual error text is
  shown without triggering the OTP flow.

### 3.2 No "Insufficient permissions" on user dashboards

- **R4 (rule):** After a user registers or logs in, regardless of whether
  their initial role is `"BORROWER"` or `"INVESTOR"`, the frontend MUST NOT
  block any borrower- or investor-facing feature with an "Insufficient
  permission" message. All pages under `/borrower/*` and `/investor/*` (KYC,
  wallet funding, investment, loan application, etc.) MUST be reachable for
  any authenticated user.
- **R5 (rule):** Backend routes under `/api/v1/borrower/...` and
  `/api/v1/investor/...` MUST accept a token from ANY user whose role list
  contains the corresponding role. In addition, whenever a user registers
  with one role, the backend SHOULD (as part of login or role-add flow)
  ensure the opposite role is also added (dual-role by default), OR the
  frontend role-enable buttons (currently "Enable Investor Access" /
  "Enable Borrower Access") must be shown and work for ALL users.
- **R6 (rule):** Any authenticated user MUST be able to call the
  `/api/v1/me/roles/add` endpoint for both `"INVESTOR"` and `"BORROWER"`
  without a 403.

### 3.3 BVN / NIN verification — Phone OTP via WhatsApp or SMS

- **R7 (rule):** When the user clicks "Verify" next to BVN (or NIN) in the
  KYC sections of both dashboards, BEFORE calling the Prembly identity API
  the frontend MUST show a modal asking the user to choose an OTP delivery
  method: **WhatsApp** or **SMS**.
- **R8 (rule):** After BVN/NIN lookup succeeds and Prembly returns a phone
  number in the normalized fields (e.g. `normalizedFields.phone_number` /
  `phone` / `mobile`), the backend MUST use THAT phone number (not the
  user's self-declared registration phone) to send an OTP with action
  `"KYC_VERIFICATION"` via the channel the user chose.
- **R9 (rule):** The frontend MUST then show a 6-digit OTP input. Only after
  the OTP is verified successfully (via `/auth/otp/verify`) will the KYC
  checklist be updated (`checklist.bvn = true` / `checklist.nin = true`) and
  the `bvnVerifiedAt` / `ninVerifiedAt` timestamps recorded.
- **R10 (rule):** If Prembly lookup itself fails (bad BVN/NIN), show the
  error and DO NOT send an OTP.

### 3.4 Liveness check — Instant webhook-driven status update

- **R11 (rule):** The Prembly widget result handler (`onPremblyLivenessResult`)
  and the file-upload liveness handler MUST, after success, call a backend
  endpoint that marks `checklist.liveness = true` and updates the overall
  `kyc.status` on the user object if needed.
- **R12 (rule):** The backend MUST expose a Prembly webhook endpoint
  (e.g. `POST /api/v1/webhooks/prembly`) that validates the request and, for
  any liveness/identity event whose reference matches a stored
  `IdentityVerificationEvent` or `KycCase.providerRequestId`, updates the
  relevant KycCase checklist/liveness/status instantly and updates
  `user.kycStatus` accordingly.
- **R13 (rule):** The frontend InvestorDashboard (and Borrower dashboard, if
  applicable) MUST refresh KYC + user state (`refreshUser()`) after any
  liveness result and poll or use a refresh loop while KYC is not final to
  pick up webhook-driven changes.

### 3.5 BVN/NIN success updates overall KYC "verified" status

- **R14 (rule):** When all of `checklist.bvn`, `checklist.nin`,
  `checklist.liveness`, `checklist.proofOfAddress` (plus any other required
  checklist items) are true, the `KycCase.status` MUST transition to
  `"VERIFIED"` and the linked `User.kycStatus` MUST also become
  `"VERIFIED"` so that the badge on every dashboard shows "KYC verified".
- **R15 (rule):** The `markKycChecklistComplete` helper in
  `backend/server/auth.ts` (or equivalent) MUST be called after every
  successful checklist mutation and MUST set `status = "VERIFIED"` (not
  only `"PENDING_VERIFICATION"`) when everything is complete and no manual
  review is required. Manual KYC review by admin can still override.

### 3.6 Loan application — Per-stage status + per-stage admin approval

- **R16 (rule):** `LoanApplication` (backend model) MUST track per-stage
  statuses in addition to the overall `status`. Introduce a new field
  `stageStatuses` (or a JSON column / inline structure) with entries for
  each stage the app supports, e.g.:
  `{ applicantType: "COMPLETED", personalInfo: "COMPLETED", businessInfo: "NOT_STARTED", personalFinancial: "PENDING_REVIEW", businessFinancial: "PENDING_REVIEW", kyc: "APPROVED", loanRequest: "REJECTED", collateral: "NOT_STARTED", review: "NOT_STARTED" }`.
  Each stage status MUST be one of:
  `NOT_STARTED | IN_PROGRESS | COMPLETED | PENDING_REVIEW | APPROVED | REJECTED`.
- **R17 (rule):** When the user completes (saves) a section during the loan
  application flow, the corresponding entry in `stageStatuses` MUST flip to
  `COMPLETED` (or `PENDING_REVIEW` if it requires admin review), and the
  overall `status` may update accordingly.
- **R18 (rule):** Admin UI (`AdminDetail` application detail page) MUST show
  a list of stages with their current status and, for each stage, provide
  **Approve** and **Reject** buttons that call new endpoints to flip only
  that stage's status.
- **R19 (rule):** Admin UI MUST retain a single "Approve overall" and
  "Reject overall" action that updates the top-level `LoanApplication.status`
  in one click (current behavior).
- **R20 (rule):** Rejecting a stage MUST record an optional rejection note
  that the borrower can see when resuming their application.

### 3.7 Admin interface — Sidebar reorganization + ledger on its own page

- **R21 (rule):** The Admin sidebar (`pages/Admin.tsx` menu) MUST be
  restructured so that **Ledger**, **Investor Management**, **Withdrawal
  Approvals**, **Platform Settings**, and any other feature currently
  nested inside `AdminSettings` are **first-class sidebar entries** with
  their own routes/views. Settings (loan programs, tenures, fees, branding)
  should remain but be called "Platform Configuration" and contain ONLY
  configuration — not operational views (ledger, withdrawals, etc.).
- **R22 (rule):** A new sidebar group (e.g. "Financials") MUST include:
  *Ledger*, *Withdrawals*, *Payouts*. The existing "Ledger" section currently
  embedded inside `AdminSettings` MUST move to its own view
  (`AdminSection = "ledger"`) and be reachable from the sidebar directly.
- **R23 (rubric, 0-2, pass >= 1):** Admin sidebar information architecture
  quality. 2 = logical grouping (Workspace / Financials / Risk / Insights /
  Administration), no feature hidden inside settings. 1 = all operational
  pages are accessible from the sidebar but group labels are inconsistent.
  0 = ledger/withdrawals still only reachable via Settings.

### 3.8 Dark mode fully applied on Settings / Admin screens

- **R24 (rule):** ALL cards (`velo-card`), headings, labels, inputs, tables,
  and Section components used inside `AdminSettings`, `AdminWorkspace`,
  `AdminDetail`, and `LoanManagerAdmin` MUST have matching Tailwind `dark:`
  classes so that text remains legible and backgrounds are not white in
  dark mode.
- **R25 (rubric, 0-2, pass >= 1):** Dark mode visual consistency on admin
  pages. 2 = every screen inspected looks correct in both themes, no white
  cards, no unreadable text. 1 = a small number of elements still need
  dark classes but main content is readable. 0 = significant sections are
  broken in dark mode (white on white, black on black, etc.).

### 3.9 Loan application — All 36 Nigerian states + FCT in State dropdown

- **R26 (rule):** `frontend/src/utils/nigerianStates.ts` `NIGERIAN_STATES`
  array MUST include all 36 states of Nigeria plus the Federal Capital
  Territory (Abuja FCT) for exactly **37** entries. The current
  placeholder entry `"Other"` MUST be removed from the state list (LGAs may
  still end with `"Other"` as a fallback).
- **R27 (rule):** `STATE_NAMES` exported from the same file MUST reflect the
  complete 37-entry list and the PersonalInfo / BusinessInfo forms MUST
  render all 37 entries in their state `<select>`.

### 3.10 Investor wallet funding — Wallet credited after payment

- **R28 (rule):** When Flutterwave returns from checkout with a successful
  transaction, the Flutterwave `verifyTransaction` MUST be called on the
  backend and, on success, `wallets[].availableMinor` +
  `wallets[].totalCreditedMinor` MUST be increased by the funded amount, a
  matching `LedgerEntry` (type = `FUNDING`, direction = `CREDIT`) and
  `WalletTransaction` (type = `DEPOSIT`, status = `SUCCESSFUL`) MUST be
  written, and `investorWalletFundedEmail` (or equivalent) email SHOULD be
  sent.
- **R29 (rule):** The platform MUST expose a Flutterwave webhook endpoint
  (e.g. `POST /api/v1/webhooks/flutterwave`) to catch async payment
  confirmations; webhook-credited transactions produce the same ledger +
  wallet mutations described above and MUST be idempotent on
  `providerReference` / `txRef`.
- **R30 (rule):** The redirect page after wallet funding (currently handled
  by `window.location.assign`) MUST carry the tx reference and trigger the
  verify-then-credit flow if the webhook has not already done so.

### 3.11 Investor Dashboard — Sidebar-based layout, beautiful UI

- **R31 (rubric, 0-2, pass >= 1):** Investor dashboard navigation. 2 =
  InvestorDashboard has its own left sidebar (or top nav) with dedicated
  pages/routes for: Overview, Wallet (Fund / Withdraw), Investments (Browse
  plans, My investments), KYC, Transactions, Payout Account, Profile.
  Dashboard landing is an Overview only. 1 = quick-action modals are used
  instead of routes, but the dashboard is split and not jampacked.
  0 = everything is still on one long scrolling page.
- **R32 (rubric, 0-2, pass >= 1):** Investor dashboard visual design.
  2 = modern gradient hero, metric cards with subtle shadows/hover, clear
  portfolio chart, consistent color language (emerald for investor, velo
  for borrower), responsive on mobile and desktop. 1 = looks acceptable
  but one of typography, spacing, or mobile layout still rough. 0 = still
  looks "jampacked" as described by user.

### 3.12 Borrower Dashboard — Sidebar-based layout, beautiful UI

- **R33 (rubric, 0-2, pass >= 1):** Borrower dashboard navigation. 2 =
  BorrowerDashboard sidebar (or top nav) with dedicated pages/routes for:
  Overview, Loan Applications, Repayments, KYC, Disbursement Account,
  Credit Score, Profile. Landing = Overview only. 1 = actions in modals
  but dashboard split. 0 = single page jampack.
- **R34 (rubric, 0-2, pass >= 1):** Borrower dashboard visual design.
  2 = metric cards, repayment progress visualization, application status
  timeline, velo color language, responsive. 1 = acceptable but polish
  issues remain. 0 = unchanged single-page density.

## 4. Non-functional requirements

- **NFR1:** Backend endpoint changes MUST be backward compatible for
  existing frontends (existing endpoints keep same response shape, new
  fields are added, new endpoints are additive).
- **NFR2:** OTP rate limiting, TTL, and attempt counts enforced by
  `createOtpChallenge` MUST continue to apply for ALL new OTP-initiating
  flows (login step-up for unverified, BVN/NIN, etc.).
- **NFR3:** All new webhook endpoints MUST perform provider signature /
  secret validation where available (Prembly HMAC, Flutterwave hash check)
  and MUST be idempotent.
- **NFR4:** No secrets (API keys, HMAC secrets) are logged or sent to the
  frontend.
- **NFR5:** Prefer commenting out unused / unfinished UI sections rather
  than deleting them, consistent with user preference.

## 5. Constraints, Dependencies & Assumptions

- **Stack constraints:** React 18 + TSX, Tailwind CSS, Express 5, Neon
  Postgres (via `backend/server/db.ts` / `store.ts` in-memory fallbacks),
  Prembly KYC, Flutterwave payments, KUDI SMS, Meta WhatsApp, Brevo Email.
- **Data layer:** `backend/server/store.ts` hosts the in-memory data model
  arrays and typed interfaces. SQL migration `001_initial_schema.sql` is
  present; schema changes should be documented and (where feasible) also
  applied as a new in-memory field / interface extension.
- **Assumption 1:** Flutterwave and Prembly keys are already configured via
  `.env` (per `config.ts`). If not, webhooks still have to be defined with
  safe no-op validation.
- **Assumption 2:** Routes for the new sidebar pages (investor sub-pages,
  borrower sub-pages, admin ledger, etc.) will be added inside
  `frontend/src/App.tsx` using `react-router-dom` v6.
- **Assumption 3:** "All 36 states" requirement means the 36 states +
  Abuja FCT (total 37), matching the standard Nigerian federation list.

## 6. Open Questions (resolved by assumptions above; re-raise if user disagrees)

1. **Does "per-stage approval" require storing rejection reasons per stage?**
   Assumption: yes, optional `rejectionNotes` per stage key.
2. **Does BVN/NIN OTP go to the Prembly-returned phone only or also allow the
   user to fall back to their declared phone if Prembly phone is missing?**
   Assumption: if Prembly phone is missing, fall back to `user.phone` so
   the flow is not blocked.
3. **Are new dashboard sub-pages true routes or just client-state tabs?**
   Assumption: true routes (`/investor/wallet`, `/investor/kyc`, etc.) so
   deep-linking works, but implementation may start with client-state tabs
   if route plumbing is too much.

---

## 7. Acceptance Criteria (AC)

Every AC below is either `rule` (objectively pass/fail) or `rubric`
(evaluative, with numeric score and threshold).

| ID | Type | Description |
|---|---|---|
| AC1 | rule | Login with correct credentials for an `isActive:false` user → shows OTP channel selector → send OTP via chosen channel → OTP input → verify → token issued → navigates to dashboard (R1–R3). |
| AC2 | rule | An authenticated user (INVESTOR-only after register) can open the Borrower dashboard KYC, apply for a loan, etc. without seeing "Insufficient permissions" (R4–R6). |
| AC3 | rule | BVN Verify button → OTP method modal (SMS/WhatsApp) → OTP sent to Prembly-returned phone → OTP input → on success checklist.bvn=true & bvnVerifiedAt set; same for NIN (R7–R10). |
| AC4 | rule | Prembly liveness webhook payload updates the matching KycCase.liveness + user.kycStatus; frontend shows updated status without manual refresh (R11–R13). |
| AC5 | rule | When all KYC checklist items true → KycCase.status = VERIFIED, User.kycStatus = VERIFIED, dashboards show "KYC verified" badge (R14–R15). |
| AC6 | rule | LoanApplication.stageStatuses populated; per-stage Approve/Reject in AdminDetail; overall Approve/Reject still works; stage rejections carry notes (R16–R20). |
| AC7 | rubric (>=1) | Admin sidebar IA: Ledger, Withdrawals, Payouts, InvestorMgmt accessible from sidebar, not only inside Settings (R21–R23). |
| AC8 | rubric (>=1) | Dark mode on AdminSettings / Admin screens readable, no broken contrast across major sections (R24–R25). |
| AC9 | rule | State dropdown in loan application contains exactly 37 entries (36 states + FCT), "Other" removed from state list (R26–R27). |
| AC10 | rule | Successful Flutterwave wallet funding (redirect + webhook) increases wallet.availableMinor, writes LedgerEntry + WalletTransaction, is idempotent (R28–R30). |
| AC11 | rubric (>=1) | Investor dashboard navigated via sidebar/top-nav with distinct sub-pages; Overview not jampacked (R31). |
| AC12 | rubric (>=1) | Investor dashboard visual quality (gradients, metrics, charts, spacing, responsive) (R32). |
| AC13 | rubric (>=1) | Borrower dashboard navigated via sidebar/top-nav with distinct sub-pages; Overview not jampacked (R33). |
| AC14 | rubric (>=1) | Borrower dashboard visual quality (R34). |
