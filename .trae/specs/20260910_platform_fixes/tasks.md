# Velo Loan Platform — Implementation Tasks (tasks.md)

**Spec:** `spec.md` in this folder
**Date:** 2026-09-10
**Natural Language:** English

---

## Legend

- **Status:** `pending` | `in_progress` | `blocked` | `completed` | `cancelled`
- **Priority:** `high` | `medium` | `low`
- **TR Type:** `rule` (objective pass/fail) or `rubric` (evaluative score ≥ threshold)
- **Parent AC:** References `AC1 … AC14` from `spec.md` §7

---

## Task 1: Login — OTP flow for unverified users

**Status:** pending
**Priority:** high
**Parent AC:** AC1 (rule)
**Reads first:**
- `frontend/src/pages/AccountAccess.tsx`
- `frontend/src/context/AuthContext.tsx`
- `frontend/src/services/apiClient.ts`
- `backend/server/auth.ts` — `issueToken`, `createOtpChallenge`
- `backend/server/routes.ts` — `POST /auth/login` (L252–283) and `POST /auth/register/verify-otp` (L463–496)

### Scope
- Modify `POST /auth/login` so that when user exists and password matches but
  `isActive === false` / `otpVerifiedAt == null`, the response includes a
  structured payload (instead of a plain 403) that the frontend can use to
  begin the OTP flow — e.g. `{ ok: false, code: "OTP_REQUIRED", userId, channels: ["SMS","WHATSAPP","EMAIL"] }`.
- In `AccountAccess.tsx`, inside the `submit` function's login branch, catch
  the OTP_REQUIRED case and switch the UI to an OTP-selection + OTP-entry
  flow (reuse the same pattern already used for registration's
  `signupVerification`). The flow should:
  1. show a channel selector (SMS / WhatsApp / Email)
  2. call a resend-style endpoint to create an OTP challenge with action
     `SIGNUP_VERIFY` for the user + selected channel (reuse
     `/auth/register/resend-otp` or add a new login-step-up endpoint if
     that feels cleaner)
  3. show the 6-digit input with countdown
  4. call `/auth/register/verify-otp` OR a unified
     `/auth/otp/verify` → then set the token, set the user, navigate
- Update `AuthContext.login` to either throw a structured error the page
  can detect, or return `{ requiresOtp?: true; userId?; ... }` instead of
  throwing so the page can orchestrate.
- Add `resendLoginOtp` helper to `apiClient.ts` if a new endpoint is added.

### Task-local Test Requirements

| ID | Type | Detail | Evidence |
|---|---|---|---|
| TR1.1 | rule | Call `POST /auth/login` with credentials for an `isActive:false` test user → response body contains `code: "OTP_REQUIRED"` and `userId` | Backend unit / manual curl + log |
| TR1.2 | rule | In the frontend login flow, after the OTP_REQUIRED response, the user is NOT redirected to `/investor` or `/borrower` until OTP is entered and verified | Browser devtools + manual test |
| TR1.3 | rule | After submitting the correct 6-digit OTP, `sessionStorage.getItem("velo:access-token")` is non-empty, `getCurrentUser()` succeeds, page navigates to the correct dashboard by role | Browser sessionStorage + navigation |
| TR1.4 | rule | Wrong OTP shows an inline error with remaining attempts; correct OTP after wrong one still works | Manual UI test |
| TR1.5 | rule | Resend button is disabled while cooldown > 0 and shows the countdown seconds | Visual UI check |

### Dependencies: none

---

## Task 2: Remove "Insufficient permissions" on user dashboards (dual-role access)

**Status:** pending
**Priority:** high
**Parent AC:** AC2 (rule)
**Reads first:**
- `backend/server/auth.ts` — `requireRole` (L95–106)
- `backend/server/routes.ts` — all `/api/v1/borrower/*` and `/api/v1/investor/*` guards
- `backend/server/store.ts` — `roles` field on User
- `frontend/src/pages/BorrowerDashboard.tsx` and `InvestorDashboard.tsx`

### Scope
- Backend: Relax `requireRole("BORROWER")` and `requireRole("INVESTOR")` on
  borrower / investor API endpoints so that ANY authenticated user with
  EITHER role (or both) can access them. Alternative: ensure the role
  `add` endpoint always grants both on registration or first login.
  Recommended: in `requireRole`, when checking `BORROWER`, treat presence of
  `INVESTOR` role as pass (and vice versa) because the product requirement
  says users should have access to all features once registered.
- Backend: in the `POST /auth/register` handler and/or in a "first login"
  pass, ensure the user's `roles` array contains BOTH `"INVESTOR"` and
  `"BORROWER"`. If user registered as INVESTOR → push BORROWER; if user
  registered as BORROWER → push INVESTOR. Set `isActive` tracking per role
  if needed, but KYC and wallet creation must happen: when adding INVESTOR
  role call `createWallet(userId)`.
- Backend: verify `/api/v1/me/roles/add` requires no additional permission
  beyond being logged in.
- Frontend: on dashboards, do not hide sections based on single-role
  membership. Keep the "Switch to Investor/Borrower" buttons but ensure the
  API-level permission error (403) never fires for any user-visible
  feature.
- Frontend: If any component catches a 403 and shows
  "Insufficient permissions", add a fallback that auto-adds the missing
  role and retries once, or shows a friendly action ("Enable borrower
  features?").

### Task-local Test Requirements

| ID | Type | Detail | Evidence |
|---|---|---|---|
| TR2.1 | rule | User registered as pure BORROWER calls `GET /api/v1/investor/dashboard` → 200 and receives data (not 403) | curl / browser network tab |
| TR2.2 | rule | User registered as pure INVESTOR calls `GET /api/v1/borrower/dashboard` → 200 | curl / browser network tab |
| TR2.3 | rule | `user.roles` for a freshly-registered user contains BOTH `"BORROWER"` and `"INVESTOR"` | `getCurrentUser()` response inspection |
| TR2.4 | rule | Investor wallet exists for any user who has ever accessed the investor page (wallet created on first add-role if missing) | wallets array in backend store |
| TR2.5 | rule | Navigate manually to `/borrower` and `/investor` as a single-role user → both dashboards render, no red banner | Browser UI screenshot |

### Dependencies: none (can run in parallel with Task 1)

---

## Task 3: BVN/NIN verify → OTP method selector (WhatsApp or SMS) then Prembly phone OTP

**Status:** pending
**Priority:** high
**Parent AC:** AC3 (rule)
**Reads first:**
- `frontend/src/pages/InvestorDashboard.tsx` — `verifyIdentity()` function (L73–94)
- `backend/server/routes.ts` — BVN/NIN verify routes (around L700–L780 area; search `kyc/bvn/verify`)
- `backend/server/providers/prembly.ts` — `verifyBvn`, `verifyNin`, `safeIdentityFields`
- `backend/server/auth.ts` — `createOtpChallenge`

### Scope
- Frontend: In `InvestorDashboard.tsx` (and any future BorrowerDashboard
  KYC section) extract the verify button click into a two-step flow:
  1. Show a modal "How should we send the verification OTP?" with two
     big options: WhatsApp icon + "WhatsApp" and SMS icon + "Text message
     (SMS)". No Email option for BVN/NIN per user request.
  2. On user choice, call a NEW backend endpoint:
     `POST /api/v1/me/kyc/bvn/verify-initiate` (and equivalent `/nin/`)
     that accepts `{ bvn, firstName, lastName, otpChannel: "SMS" | "WHATSAPP" }`.
- Backend: Create the two initiate endpoints. In each:
  1. Call `verifyBvn` / `verifyNin` Prembly APIs first.
  2. If Prembly FAILS → return the error, NO OTP sent.
  3. If Prembly SUCCEEDS, extract the user's phone from
     `result.normalizedFields` (keys `phone_number`, `phone`, `mobile`,
     `telephoneno`). If none, fall back to `user.phone` so the flow
     is not blocked.
  4. Call `createOtpChallenge(userId, "KYC_VERIFICATION", phone, user.email, channel)`.
  5. Return `{ ok: true, requiresOtp: true, challengeId, channel, phoneMasked, ...countdown }`.
- Frontend: After initiate returns requiresOtp, show 6-digit OTP input
  (reuse the AccountAccess OTP component style) with a Resend link that
  calls the same initiate again (or a resend endpoint).
- Backend: Create `POST /api/v1/me/kyc/bvn/verify-finalize` and
  `/nin/verify-finalize` that accept `{ bvn/nin, challengeId, code, firstName?, lastName? }`.
  Inside call `verifyOtpChallenge`. If verified:
  - set `kyc.bvn = bvn` and `kyc.checklist.bvn = true`,
    `kyc.bvnVerifiedAt = now` (or nin equivalents)
  - call `markKycChecklistComplete(userId)`
  - return `{ ok: true, status, checklist, ... }`
  If OTP bad → return error.
- Frontend: On finalize success → call `refreshUser()` and show the green
  "BVN verified" state already implemented in the checklist UI.

### Task-local Test Requirements

| ID | Type | Detail | Evidence |
|---|---|---|---|
| TR3.1 | rule | On "Verify BVN" click → modal with WhatsApp and SMS options only (no Email) | UI screenshot |
| TR3.2 | rule | Passing an invalid BVN format to the backend → Prembly error returned, no OTP sent, `otpChallenges` array in backend store unchanged | Backend log + `otpChallenges` length |
| TR3.3 | rule | Valid BVN/NIN + Prembly success → challenge created with channel the user selected, phone is the Prembly-returned phone (falls back to `user.phone` only if Prembly phone missing) | `otpChallenges[n].deliveryChannel` and masked recipient notification |
| TR3.4 | rule | Submitting correct OTP to finalize endpoint sets `checklist.bvn = true` (or .nin) and `bvnVerifiedAt` timestamp | `kycCases` array inspection |
| TR3.5 | rule | Wrong OTP on finalize returns 400 with attempts-remaining message, checklist unchanged | Response body + checklist inspection |

### Dependencies: Task 2 (so any user can reach the KYC UI without 403), otherwise independent

---

## Task 4: Liveness check — webhook endpoint + instant status updates

**Status:** pending
**Priority:** high
**Parent AC:** AC4 (rule)
**Reads first:**
- `backend/server/providers/prembly.ts` — `verifyLiveness` signature and HMAC notes
- `frontend/src/pages/InvestorDashboard.tsx` — `verifyLivenessFile` (L126–141) and `onPremblyLivenessResult` (L143–154)
- `backend/server/store.ts` — `IdentityVerificationEvent`, `KycCase`
- `backend/server/routes.ts` — existing `/me/kyc/liveness/verify`

### Scope
- Backend: Add `POST /api/v1/webhooks/prembly` route (no requireAuth, or
  allow public). In the handler:
  1. Validate signature if Prembly provides one (HMAC of body using
     PREMBLY_WEBHOOK_SECRET env). If not configured, skip validation but
     log a warning.
  2. Match the incoming event to a `KycCase` via `providerRequestId` or
     `IdentityVerificationEvent.providerReference`.
  3. For `LIVENESS` success → set `kyc.checklist.liveness = true`.
  4. For `BVN`/`NIN` success → set corresponding checklist flags if they
     aren't already set (belt + suspenders).
  5. Always call `markKycChecklistComplete(userId)` and update
     `user.kycStatus = kyc.status`.
  6. Return 200 quickly. Webhook handling must be idempotent on the
     provider's event ID.
- Backend: Ensure the file-upload liveness handler
  (`/me/kyc/liveness/verify`) on success also flips
  `checklist.liveness = true` and calls `markKycChecklistComplete` +
  updates `user.kycStatus` (currently it appears to only set the status
  through `response.status`; make it explicit).
- Frontend: In `onPremblyLivenessResult`, after the immediate `getMyKyc()`
  refresh, add a 5-second interval poller that keeps calling
  `getMyKyc()` + `refreshUser()` for up to 60 seconds while
  `checklist.liveness` is still false (only when the widget reported
  success but the backend is still pending — webhook race). Clear the
  interval once liveness shows true. Same pattern if the file-upload
  path returns PENDING.
- Backend route: make sure the existing `/me/kyc` response includes the
  `liveness` boolean in `checklist` (it already has `liveness` key in
  store type, make sure it's returned).

### Task-local Test Requirements

| ID | Type | Detail | Evidence |
|---|---|---|---|
| TR4.1 | rule | `POST /api/v1/webhooks/prembly` exists and returns 200 when given a shape-matching payload | curl |
| TR4.2 | rule | Posting a liveness SUCCESS webhook payload matching an existing KycCase.providerRequestId sets `checklist.liveness = true` and triggers `markKycChecklistComplete` | `kycCases` inspection + user.kycStatus changed |
| TR4.3 | rule | After Prembly widget reports success, the frontend shows "✓ Liveness verified" within 60 seconds even if the immediate `getMyKyc()` call did not yet have it | Manual UI test with simulated delay |
| TR4.4 | rule | Duplicate webhook calls for the same provider event ID do not double-create events or corrupt balances (idempotent) | Two calls, same result count in `identityVerificationEvents` |
| TR4.5 | rule | Upload-liveness success path also sets `checklist.liveness = true` on the backend store, not only on response status | `kycCases` inspection after upload |

### Dependencies: Task 5 touches `markKycChecklistComplete` so order Task5 → Task4 OR merge carefully.

---

## Task 5: BVN/NIN success → KYC "VERIFIED" overall status when checklist complete

**Status:** pending
**Priority:** high
**Parent AC:** AC5 (rule)
**Reads first:**
- `backend/server/auth.ts` — `markKycChecklistComplete` (L309–318)
- `backend/server/store.ts` — `KycCase.checklist` keys and `KycStatus` type
- `frontend/src/pages/InvestorDashboard.tsx` — user.kycStatus badge display (L329–L334)
- `frontend/src/pages/BorrowerDashboard.tsx` — KYC status (L324–L330)

### Scope
- Backend: Inspect the current `markKycChecklistComplete` function. It
  currently only sets status to `PENDING_VERIFICATION`. Change it so that
  when EVERY non-optional checklist key is truthy (`bvn && nin && proofOfAddress && liveness && passport && signature`
  — note: passport/signature may be optional depending on flow; treat
  proofOfAddress + bvn + nin + liveness as the required minimum):
  - immediately set `kyc.status = "VERIFIED"`
  - set `kyc.verifiedAt = now` new optional field
  - set `user.kycStatus = "VERIFIED"`
  - otherwise keep `PENDING_VERIFICATION` only when something remains
    incomplete OR if there's an explicit manual review flag.
- Backend: Every existing mutation path that sets checklist items
  (`bvn`, `nin`, `proofOfAddress`, `liveness`, widget-completion,
  webhook-handler) must end by calling `markKycChecklistComplete(userId)`.
  Audit: `/me/kyc/documents` upload handler (sets proofOfAddress?), the
  `/me/kyc/bvn/verify-finalize` from Task 3, Task 4 liveness path,
  `/me/kyc` PATCH submit.
- Frontend: On InvestorDashboard / BorrowerDashboard, the KYC badge text
  and color must immediately update once `user.kycStatus === "VERIFIED"`.
  If any component caches the value, call `refreshUser()` after each
  success.

### Task-local Test Requirements

| ID | Type | Detail | Evidence |
|---|---|---|---|
| TR5.1 | rule | Given a user whose KYC checklist has all required flags true, calling `markKycChecklistComplete` produces `kyc.status === "VERIFIED"` and `user.kycStatus === "VERIFIED"` | `users` + `kycCases` arrays inspection |
| TR5.2 | rule | If ANY required checklist flag is false, status goes to `PENDING_VERIFICATION` (not VERIFIED) | Same inspection with one flag toggled off |
| TR5.3 | rule | Badge on Investor Dashboard shows "KYC verified" with green variant when `user.kycStatus === "VERIFIED"` | UI screenshot |
| TR5.4 | rule | After finalizing BVN then NIN (via Task 3 flow) then liveness then proof-of-address upload, the very last step's response triggers a user refresh that shows VERIFIED | End-to-end manual test |
| TR5.5 | rule | Admin KYC review → admin approves manually → `kyc.status = VERIFIED` and user.kycStatus updates (existing admin-decide path must also call markKycChecklistComplete or equivalent) | Admin UI test |

### Dependencies: none; Task 3 and Task 4 consume this function, so best to implement Task 5 first.

---

## Task 6: Loan application per-stage status + per-stage admin approval

**Status:** pending
**Priority:** high
**Parent AC:** AC6 (rule)
**Reads first:**
- `backend/server/store.ts` — `LoanApplication` interface (L209–229)
- `frontend/src/types/application.ts` (if any) and `ApplicationContext.tsx`
- `frontend/src/pages/LoanApplication.tsx`
- `frontend/src/components/admin/AdminDetail.tsx` and `AdminApplicationsTable.tsx`
- `backend/server/routes.ts` — loan application submit/patch routes

### Scope
- Backend: Extend `LoanApplication` interface:
  - add `stageStatuses: Record<string, StageStatus>` where
    `StageStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "PENDING_REVIEW" | "APPROVED" | "REJECTED"`
  - add `stageRejectionNotes: Record<string, string>` optional
  - seed the map on application creation:
    `{ applicantType: "NOT_STARTED", personalInfo: "NOT_STARTED", businessInfo: "NOT_STARTED", businessRep: "NOT_STARTED", personalFinancial: "NOT_STARTED", businessFinancial: "NOT_STARTED", kyc: "NOT_STARTED", loanRequest: "NOT_STARTED", collateral: "NOT_STARTED", review: "NOT_STARTED", agreement: "NOT_STARTED" }`
- Backend: When a stage is saved (the existing patch endpoints in
  ApplicationContext), update the specific `stageStatuses[stageKey]` to
  `"COMPLETED"` or `"PENDING_REVIEW"` where appropriate. When the full
  application is submitted, set each already-completed stage to
  `"PENDING_REVIEW"` so admin sees stages that need review.
- Backend: New endpoints:
  - `PATCH /api/v1/admin/loans/:id/stages/:stageKey` with body
    `{ decision: "APPROVED" | "REJECTED", note?: string }`. Only admins /
    loan managers. Sets `stageStatuses[stageKey] = APPROVED|REJECTED` and
    stores the note.
  - Overall approve/reject endpoints remain (existing) and set overall
    `status`.
- Frontend: In `AdminDetail.tsx`, add a "Stages" accordion or table
  below the overall application card. One row per stage key, show stage
  name + current status badge + Approve / Reject buttons. On Reject,
  prompt for a note and submit both.
- Frontend: In `BorrowerDashboard` "Continue Application" flow, if any
  stage has status `"REJECTED"`, show the note inline above that section
  so the borrower knows what to fix.

### Task-local Test Requirements

| ID | Type | Detail | Evidence |
|---|---|---|---|
| TR6.1 | rule | New application's `stageStatuses` object has all 11 expected keys initialized, all NOT_STARTED | Backend store inspection |
| TR6.2 | rule | After borrower saves PersonalInfo section, `stageStatuses.personalInfo === "COMPLETED"` | Inspection after save |
| TR6.3 | rule | Admin detail page renders each stage with status + Approve/Reject buttons for stages not yet decided | UI screenshot |
| TR6.4 | rule | Admin PATCHing a stage status sets the field and the borrower, on reload, sees that stage's status and note | Admin + borrower side-by-side test |
| TR6.5 | rule | Overall Approve button still works and flips application.status to APPROVED in one click | Admin UI test |

### Dependencies: independent

---

## Task 7: Admin sidebar reorganization + Ledger as its own section

**Status:** pending
**Priority:** high
**Parent AC:** AC7 (rubric ≥ 1)
**Reads first:**
- `frontend/src/pages/Admin.tsx` — `menu` array (L15–17) and `titles` map
- `frontend/src/components/admin/AdminSettings.tsx` — ledger, withdrawal,
  investor-rate, credit-wallet sections (currently in the same giant page)
- `frontend/src/services/adminApi.ts` (if any) or `apiClient.ts` admin functions

### Scope
- Split `AdminSettings.tsx`: extract the "Ledger center" section (the
  part that calls `adminGetLedger` and renders ledger entries table) into
  a new component `AdminLedger.tsx` in the same folder. Extract the
  withdrawal management (list + approve/reject calls) into
  `AdminWithdrawals.tsx`. Extract "Set Custom Earning Rate per Investor"
  and "Credit Investor Wallet" into `AdminInvestorManagement.tsx` or
  leave them inside a slimmer `AdminInvestorManagement.tsx` if we already
  have an Investor tab in Workspace with a different shape (keep as
  operational tools vs. listing). What remains in `AdminSettings.tsx`
  should be ONLY configuration: loan programs, tenures, fees, branding,
  environment info, live preview, plus platform-wide settings
  (withdrawal fees, default earning rate) — these "platform settings"
  values are configuration so they can stay in Settings, but the
  operational action of crediting a wallet is a separate page.
- In `Admin.tsx`, extend `AdminSection` type and the `menu` array:
  - New group "Financials" with entries: `ledger` (Ledger),
    `withdrawals` (Withdrawal requests), `payouts` (already exists in
    AdminWorkspace → reuse).
  - Add `{ key: "ledger", label: "Ledger", group: "Financials" }` and
    `{ key: "withdrawals", label: "Withdrawal requests", group: "Financials" }`.
  - Route `ledger` → render new `AdminLedger` component; route
    `withdrawals` → render new `AdminWithdrawals` component.
  - Move the investor-management operational tools (credit wallet / set
    earning rate) out of Settings → either add a new `investor-tools`
    sidebar key under "Financials" or place them inside the existing
    "Investors" detail view. Best place: inside AdminWorkspace's
    `Investors` → on the investor detail.
  - The "Administration" sidebar group should only contain: `Admin & managers`,
    `Loan settings` (configuration).
- Make sure role-based visibility still works (non-admin loan managers
  should still see their sections; if a manager lacks "settings" perms,
  the Settings tab is already hidden — keep that behavior).

### Task-local Test Requirements (rubric TR plus rule guards)

| ID | Type | Detail | Evidence |
|---|---|---|---|
| TR7.1 | rule | Admin sidebar now contains a group labeled "Financials" (or equivalent) with at least "Ledger", "Withdrawal requests", and "Payouts" | UI screenshot |
| TR7.2 | rule | Clicking "Ledger" in the sidebar loads the ledger table view WITHOUT rendering the 1000-line Loan Settings config form below it | Page screenshot, no settings UI visible |
| TR7.3 | rule | Withdrawal requests can be approved/rejected from the new page without navigating to Settings | Test approve flow on new page works |
| TR7.4 | rubric (0–2, pass ≥1) | IA quality score: 2 = clean 5-group layout (Workspace / Financials / Risk & money / Insights / Administration), no operations nested in Settings; 1 = Ledger & Withdrawals now separate but 1+ operational item still lives in Settings; 0 = no change. | Auditor visual review + evidence screenshot |

### Dependencies: none

---

## Task 8: Dark mode fixes on Admin Settings and Admin screens

**Status:** pending
**Priority:** medium
**Parent AC:** AC8 (rubric ≥ 1)
**Reads first:**
- `tailwind.config.js` — darkMode setting (should be `class`-based)
- `frontend/src/context/ThemeContext.tsx`
- `frontend/src/components/admin/AdminSettings.tsx` — all Section/Field wrappers
- `frontend/src/components/admin/AdminWorkspace.tsx` — Panel / Table classes
- Global CSS (where `velo-card`, `velo-input`, etc. classes live)

### Scope
- Identify all hard-coded light-only classes in admin components. Common
  missing dark classes:
  - `bg-white` → `bg-white dark:bg-slate-900`
  - `text-slate-900 / text-gray-800` → `text-slate-900 dark:text-white`
  - `border-slate-200` → `border-slate-200 dark:border-slate-700`
  - `bg-slate-50` → `bg-slate-50 dark:bg-slate-800`
  - Section headers, card bodies, table rows, form labels (`velo-label`),
    inputs (`velo-input`), helper text.
- Audit `AdminSettings.tsx`:
  - `Section` custom component at the bottom: add dark variants.
  - `Field` / `NumberField` / `FeeField` / `ProgramEditor` children.
  - The right-column dark-themed "LIVE PREVIEW" card is already fine, but
    the "How this works" info card directly below might be missing dark.
- Audit `AdminWorkspace.tsx`:
  - `Panel` wrapper → dark body and border.
  - `Table` header rows → `bg-white dark:bg-slate-900`, body rows, badges.
- Audit `AdminDetail`, `AdminApplicationsTable`, `LoanManagerAdmin`,
  `AdminAccounts` similarly.
- If any global `.velo-card`, `.velo-label`, `.velo-input`, `.section-heading`,
  `.section-subheading` utility class lacks a dark variant, add it to the
  project's global CSS file (search the frontend for `@layer components`
  or index.css). Every class used inside Admin components MUST have a
  matching `dark:` variant either inline or in global CSS.

### Task-local Test Requirements

| ID | Type | Detail | Evidence |
|---|---|---|---|
| TR8.1 | rule | In dark mode, no text on AdminSettings main screen is black-on-black or invisible; every card background is a dark grey/slate, text is white/light | Screenshot + manual review |
| TR8.2 | rule | Tables in AdminWorkspace (overview, KYC, payouts, loans, reconciliation, audit) render with dark headers/rows correctly, borders not invisible | Dark-mode screenshot of each tab |
| TR8.3 | rule | Forms (inputs, selects, labels) on Settings page have readable dark-mode contrast and focus rings don't disappear | Interactive dark-mode check |
| TR8.4 | rubric (0–2, pass ≥1) | Dark-mode visual consistency: 2 = every screen, card, table, heading looks perfect in dark; 1 = 2–3 minor low-contrast spots found but pages usable; 0 = major sections still white-background or unreadable in dark | Auditor visual review, screenshots of 6 key panels |

### Dependencies: none (pure styling)

---

## Task 9: All 36 Nigerian states + FCT in state dropdown

**Status:** pending
**Priority:** medium
**Parent AC:** AC9 (rule)
**Reads first:**
- `frontend/src/utils/nigerianStates.ts`
- Any form in `sections/PersonalInfoSection.tsx` and
  `sections/BusinessInfoSection.tsx` that renders the state `<select>`

### Scope
- Replace the current `NIGERIAN_STATES` array (which has ~21 entries and a
  fake `"Other"` state) with the complete federation list (36 states +
  Abuja FCT = 37). Standard canonical list:
  Abia, Adamawa, Akwa Ibom, Anambra, Bauchi, Bayelsa, Benue, Borno,
  Cross River, Delta, Ebonyi, Edo, Ekiti, Enugu, Gombe, Imo, Jigawa,
  Kaduna, Kano, Katsina, Kebbi, Kogi, Kwara, Lagos, Nasarawa, Niger,
  Ogun, Ondo, Osun, Oyo, Plateau, Rivers, Sokoto, Taraba, Yobe, Zamfara,
  and Abuja (FCT).
- Keep `"Other"` as the **last LGA entry** for each state's `lgas` list
  (as a catch-all) — do NOT remove it from LGA lists, only from the
  state-level list.
- Each state needs a sensible LGA list. Keep the current abridged-LGA
  approach (production note says full dataset swapped in later) but ensure
  every state has at least a handful of real LGAs and a trailing
  `"Other"`.
- Remove the standalone entry `{ name: "Other", lgas: ["Other"] }` state.
- Re-export `STATE_NAMES` after the change.
- Check the forms that use this file: verify the `<select>` renders the
  new 37 entries in the correct alphabetical order.

### Task-local Test Requirements

| ID | Type | Detail | Evidence |
|---|---|---|---|
| TR9.1 | rule | `NIGERIAN_STATES.length === 37` | Unit / console log of length |
| TR9.2 | rule | No entry in `NIGERIAN_STATES` has `name === "Other"` | `.find()` returns undefined |
| TR9.3 | rule | States cover the canonical 36 + FCT names (case-sensitive spelling matches Nigeria's official list) | Diff against reference names via string comparison |
| TR9.4 | rule | Every state's `.lgas` array still contains `"Other"` as the last option for catch-all | Loop assertion |
| TR9.5 | rule | The state dropdown in Personal Info and Business Info sections renders 37 options without a top-level "Other" choice | Form screenshot counting options |

### Dependencies: none

---

## Task 10: Investor wallet funding — credit wallet on Flutterwave success (redirect + webhook)

**Status:** pending
**Priority:** high
**Parent AC:** AC10 (rule)
**Reads first:**
- `backend/server/routes.ts` — find `POST /investor/wallet/funding` current handler
- `backend/server/providers/flutterwave.ts` — `initializeWalletFunding`, `verifyTransaction`
- `backend/server/store.ts` — `Wallet`, `LedgerEntry`, `WalletTransaction` types; helper `appendLedger`; `wallets`, `walletTransactions` arrays
- `frontend/src/pages/InvestorDashboard.tsx` — `handleFundWallet` (L168–178)
- `backend/server/email.ts` — `investorWalletFundedEmail`

### Scope
- Backend: `POST /investor/wallet/funding` currently initializes Flutterwave
  checkout link. Make sure the handler also:
  - stores a `WalletTransaction` row with `status = PENDING`,
    `providerReference = txRef`, `metadata.flutterwaveTxRef = txRef`.
  - records a temporary pending ledger entry or (preferred) only does so
    on verification.
- Backend: Add Flutterwave redirect success handler. Choose ONE of:
  - (A) query-param route: new `GET /api/v1/investor/wallet/funding/verify?tx_ref=...&transaction_id=...`
    that calls `verifyTransaction(transaction_id)`; if status is success
    → credit wallet.
  - (B) on the client side, after redirect back from Flutterwave to the
    dashboard with `tx_ref` in the URL, call a client-side verification
    endpoint (POST `/api/v1/investor/wallet/funding/verify { txRef, transactionId }`)
    that triggers the same backend credit logic.
  - Regardless, the path MUST:
    1. call Flutterwave's `verifyTransaction(transactionId)`;
    2. check idempotency: if a matching WalletTransaction already has
       `status = SUCCESSFUL`, return 200 with the existing credited state
       without double-adding;
    3. find the investor's `Wallet` by `userId`, add the `amountMinor =
       flutterwaveAmount * 100` (or whatever the verified amount is,
       normalized to kobo) to `availableMinor` and `totalCreditedMinor`;
    4. call `appendLedger(walletId, { entryType: "FUNDING", amountMinor, direction: "CREDIT", balanceAfterMinor, description: "Wallet funding via Flutterwave tx:..." })`;
    5. set `WalletTransaction.status = "SUCCESSFUL"` and stamp
       `verifiedAt`, `providerReference` (flutterwave `id`);
    6. send `investorWalletFundedEmail(user.email, user.fullName, amountNaira)`.
- Backend: Add `POST /api/v1/webhooks/flutterwave` that validates the
  FLUTTERWAVE_WEBHOOK_SECRET (hash check of the payload using the secret),
  then runs the exact same credit logic keyed off `tx_ref` from the
  webhook body. Idempotent on provider transaction id.
- Frontend: In `InvestorDashboard.tsx`, when Flutterwave redirects back,
  the page should detect the query parameters and call the verify
  endpoint. Also, right after checkout link is generated, show an
  instructional banner "If you have just completed payment your wallet
  will be credited automatically — refresh if it doesn't appear within 2 minutes."
- Backend route check: ensure `findWallet(userId)` and credit are inside a
  try/finally and don't corrupt numbers.

### Task-local Test Requirements

| ID | Type | Detail | Evidence |
|---|---|---|---|
| TR10.1 | rule | After a mocked `verifyTransaction` returns success → `wallet.availableMinor` increases by the exact funded amount and `totalCreditedMinor` increases by same | `wallets` array before/after snapshot |
| TR10.2 | rule | Exactly one `LedgerEntry` (FUNDING CREDIT) and one `WalletTransaction` (SUCCESSFUL) exist per successful funding. Running the verify twice with same tx_ref does NOT add a second entry | Counts before/after |
| TR10.3 | rule | Flutterwave webhook endpoint exists, validates signature (or logs warning if unconfigured), and performs the same wallet credit | curl + mock signature |
| TR10.4 | rule | Frontend, on return from Flutterwave with a success query string, calls the verify endpoint, refreshes dashboard wallet balance, shows green "Wallet credited" message | UI test with mock |
| TR10.5 | rule | Failure / cancelled payment does not credit wallet, WalletTransaction status becomes FAILED/CANCELLED | Failure path test |

### Dependencies: none (can parallelize with UI tasks)

---

## Task 11: Investor Dashboard — sidebar layout with sub-pages

**Status:** pending
**Priority:** medium
**Parent AC:** AC11 (rubric ≥ 1), AC12 (rubric ≥ 1)
**Reads first:**
- `frontend/src/App.tsx` — route table
- `frontend/src/pages/InvestorDashboard.tsx` — current full-page implementation
- `frontend/src/components/Layout.tsx` — see if there is an existing sidebar
  wrapper the dashboard can reuse; if not, create one.

### Scope
- Create a `DashboardShell` or `InvestorLayout` component (in
  `frontend/src/components/investor/` folder) that provides a sticky left
  sidebar on desktop and a bottom-tab / hamburger on mobile. Sidebar
  navigation items:
  - **Overview** (route `/investor`) — keep the hero/metrics + performance
    chart from current page; remove the inline modals/panels for funding,
    plans, transactions, KYC.
  - **Wallet** (route `/investor/wallet`) — balance cards, Fund Wallet
    button/form, Withdraw button, recent wallet transactions list.
  - **Investments** (route `/investor/investments`) — tabs: "Browse plans"
    + "My investments".
  - **KYC verification** (route `/investor/kyc`) — the full KYC block
    currently nested in InvestorDashboard (BVN, NIN, liveness, proof of
    address).
  - **Transactions** (route `/investor/transactions`) — payout,
    investment, ledger entries tables combined.
  - **Payout account** (route `/investor/payout-account`) — bank account
    setup.
  - **Profile** (route `/investor/profile`) — personal info edit, enable
    borrower features, switch dashboard.
- Update `App.tsx` to add these routes, wrapping each in the new layout
  (or use nested routing with `<Outlet/>` if you prefer).
- Move code out of the single `InvestorDashboard.tsx` component into
  sub-components in `frontend/src/pages/investor/` folder, one file per
  page. Keep the old file as the `Overview` page or rename. Comment out
  (don't delete) any sections that you're unsure about re-placing to
  match the user's "comment out unused" preference.

### Task-local Test Requirements

| ID | Type | Detail | Evidence |
|---|---|---|---|
| TR11.1 | rule | App router resolves `/investor/wallet`, `/investor/kyc`, `/investor/investments`, `/investor/transactions`, `/investor/payout-account`, `/investor/profile` as valid routes (no 404) | Manual URL navigation |
| TR11.2 | rule | Investor sidebar/nav contains these 7 items; clicking each switches the content area without full page reload | Click-through video or sequence of screenshots |
| TR11.3 | rule | Overview page no longer contains BVN/NIN input forms, proof-of-address upload, investment plan listings, or the funding form inline — those now live on their dedicated pages | Overview page screenshot |
| TR11.4 | rubric (0–2, pass ≥1) | Navigation IA quality: 2 = sidebar clearly grouped, active state highlighted, mobile responsive tabs or burger; 1 = sidebar works on desktop but mobile nav has glitches; 0 = everything still on one page | Auditor review + screenshots desktop and mobile widths |
| TR11.5 | rubric (0–2, pass ≥1) | Visual design: 2 = gradient brand hero, metric cards with distinct icons, clean spacing consistent with the login page's polished look, charts + balance prominent; 1 = correct layout but typography/spacing underwhelming; 0 = same density as before | Auditor visual review screenshots 3 panels |

### Dependencies: Task 10 (wallet credit bug should be fixed BEFORE splitting wallet page, so you don't port broken logic across files)

---

## Task 12: Borrower Dashboard — sidebar layout with sub-pages

**Status:** pending
**Priority:** medium
**Parent AC:** AC13 (rubric ≥ 1), AC14 (rubric ≥ 1)
**Reads first:**
- `frontend/src/App.tsx`
- `frontend/src/pages/BorrowerDashboard.tsx` — current full page
- Pattern from Task 11's InvestorLayout for consistency

### Scope
- Create an analogous `BorrowerLayout` / shared `DashboardShell` (if you
  made it reusable in Task 11) with sidebar items:
  - **Overview** (`/borrower`) — metrics cards (application status,
    outstanding, credit score), repayment progress chart, credit score
    ring, CTA button to start / continue application.
  - **Loan Applications** (`/borrower/applications`) — list of past
    applications with per-stage status (Task 6 data) + "New Application"
    CTA.
  - **Repayments** (`/borrower/repayments`) — repayment schedule table,
    amount due, pay-now button for any missed / due installments.
  - **KYC verification** (`/borrower/kyc`) — equivalent of what is on
    Investor KYC page, shared component if possible (reuse the BVN/NIN
    modal + OTP flow from Task 3).
  - **Disbursement Account** (`/borrower/disbursement-account`) — bank
    account where loans are paid out.
  - **Credit Score** (`/borrower/credit-score`) — full credit score
    breakdown, factors, history chart.
  - **Profile** (`/borrower/profile`) — personal info + enable investor
    access switcher.
- Update `App.tsx` routes. Split `BorrowerDashboard.tsx` into sub-page
  components in `frontend/src/pages/borrower/` folder. Comment out
  instead of deleting any content that doesn't have an obvious new home.
- Apply the same design language as Task 11: gradient accents, metric
  cards, velo-tinted for borrower (instead of emerald-tinted for
  investor) so the two dashboards feel branded but consistent.

### Task-local Test Requirements

| ID | Type | Detail | Evidence |
|---|---|---|---|
| TR12.1 | rule | Routes `/borrower/applications`, `/borrower/repayments`, `/borrower/kyc`, `/borrower/disbursement-account`, `/borrower/credit-score`, `/borrower/profile` all resolve | URL browser test |
| TR12.2 | rule | Overview page no longer contains the full disbursement-account form, long quick-action KYC card, or repayments table as inline sections | Screenshot comparison before/after |
| TR12.3 | rule | Sidebar / top-nav items are clickable without full reload and active state is highlighted | Navigation video or screenshots |
| TR12.4 | rubric (0–2, pass ≥1) | Navigation IA quality: 2 = clean grouping, mobile works; 1 = sidebar on desktop only; 0 = unchanged single page | Auditor screenshots mobile + desktop |
| TR12.5 | rubric (0–2, pass ≥1) | Visual design: 2 = elegant borrower-theme (velo indigo/blue) metrics + charts, readable on all breakpoints; 1 = acceptable but lacking some polish; 0 = density unchanged | Auditor visual review 3 panels |

### Dependencies: Task 11 (reuse DashboardShell if built)

---

## Global / Cross-cutting notes

- Apply the "comment out instead of delete" preference from
  `user_profile.md` whenever removing a UI chunk or helper function that
  might be re-added.
- After every backend store type-shape change, re-run the typechecker:
  `pnpm lint` and `pnpm typecheck:api` per `package.json` scripts.
- After every frontend change, run `pnpm build` (or `pnpm dev` smoke
  test) to catch TS errors before marking a task complete.
- Admin detail and applications pages should be tested in both light and
  dark themes as part of Task 8 review.

---

## Task Status Summary (initial)

| Task | Title | Status | Priority |
|---|---|---|---|
| T1 | Login — OTP flow for unverified users | pending | high |
| T2 | Remove "Insufficient permissions" on user dashboards | pending | high |
| T3 | BVN/NIN verify → OTP method selector | pending | high |
| T4 | Liveness check — webhook + instant status | pending | high |
| T5 | BVN/NIN success → KYC VERIFIED | pending | high |
| T6 | Loan per-stage status + admin approval | pending | high |
| T7 | Admin sidebar reorganization | pending | high |
| T8 | Dark mode fixes on Admin screens | pending | medium |
| T9 | 36 states + FCT in State dropdown | pending | medium |
| T10 | Investor wallet funding credit on Flutterwave success | pending | high |
| T11 | Investor Dashboard sidebar sub-pages | pending | medium |
| T12 | Borrower Dashboard sidebar sub-pages | pending | medium |

## Suggested execution order (dependency-aware)

1. **T5 (markKycChecklistComplete)** → foundational for KYC status logic.
2. **T2 (dual-role permissions)** + **T9 (states)** + **T8 (dark mode)** → independent parallel.
3. **T1 (login OTP)** + **T3 (BVN/NIN OTP)** → together they close the verification
   flows; T5 should be done first.
4. **T4 (liveness webhook)** right after T5.
5. **T10 (wallet funding credit bug)** — high priority, independent.
6. **T6 (loan stages)** + **T7 (admin sidebar)** — parallel admin-focused work.
7. **T11 (investor layout)** and **T12 (borrower layout)** last, once
   underlying flows are stable so you don't have to re-split pages later.
