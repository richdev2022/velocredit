# Specification: Loan Application UX, Collateral Rules, Submission Fix, OTP Login & Withdrawals

## Problem
Users encounter several friction points and bugs across the loan application flow, authentication, and investor withdrawals:
1. Bank selection is a plain native dropdown with no search in a long list.
2. Account name resolution only triggers on blur — it should auto-run once a 10-digit number is entered.
3. Naira (₦) prefix visually overlaps the placeholder text in all amount inputs.
4. Personal loan collateral is marked optional; business is required. Per product requirement, collateral is required for both.
5. Submitting a loan application fails with `"Application not found"` for both Personal and Business flows — the frontend adapter posts fields that the backend create/patch/submit endpoints do not recognise and the lookup keys do not align.
6. There is no two-factor OTP gate on login (Email / SMS / WhatsApp) and no per-user toggle in either dashboard.
7. Investor withdrawals do not require an OTP challenge; the flow must ask the user for a delivery channel, send a code, then verify it before the withdrawal is accepted.

## Users
- Loan applicants (Personal + Business borrowers) completing the application wizard.
- Investors funding and withdrawing from the investor wallet.
- Platform admins and loan managers who depend on correct application submission records.

## Goals
- Remove UX friction in bank selection and account-name verification.
- Eliminate the ₦/placeholder overlap in every amount field.
- Make collateral a required section for both PERSONAL and BUSINESS loan programs.
- Fix the loan application submission pipeline end-to-end (create / patch / submit) so it no longer returns `"Application not found"` for either flow.
- Enforce OTP validation at login (channels: EMAIL / SMS / WHATSAPP) when the user has the flag enabled, and expose an ON/OFF toggle on both Borrower and Investor dashboards.
- Integrate OTP challenge + verification into the investor withdrawal flow before the withdrawal is persisted.

## Non-Goals
- Re-architecting the OTP provider stack (keep Kudi SMS, Meta WhatsApp, Brevo Email).
- Redesigning the section wizard host itself.
- Changing KYC pre-submission rules (BVN/NIN/liveness remain required).

---

## Functional Requirements

### FR-1 Bank searchable dropdown
- In PersonalInfoSection and BusinessRepSection the bank `<select>` is replaced with a searchable combobox that:
  - shows all loaded Nigerian banks;
  - filters as the user types by name (case-insensitive contains);
  - returns to the list view when the input is cleared;
  - keeps the existing auto-save/patch to disbursementAccount and selectedBank state;
  - preserves keyboard accessibility (arrow keys, Enter to pick, Escape to close).

### FR-2 Auto name resolution at 10 digits
- In PersonalInfoSection and BusinessRepSection the account number input triggers `resolveAccount()` automatically the moment the cleaned value reaches exactly 10 digits.
- Blur-triggered resolution remains as a fallback but does not double-fire if auto-trigger already resolved.

### FR-3 Amount field ₦/placeholder overlap fix
- All amount inputs that render a `₦` prefix must have sufficient left padding so the placeholder and typed values do not sit under the glyph.
- Affected components/locations:
  - `FormInput` when `prefix="₦"` is supplied.
  - `LoanAmountSelector` input (it currently uses inline `pl-9` plus an absolute ₦ span).
  - `CollateralSection` estimated value input (inline with `₦` text sibling).
  - Collateral estimated value, PersonalFinancial monthly income/expenses/obligations, BusinessFinancial revenue/expenses/obligations, Investor dashboard fund/invest modals.

### FR-4 Collateral required for both loan types
- `config.ts` base program PERSONAL sets `collateral.required = true`.
- `CollateralSection` removes the "I want to provide collateral" optional checkbox entirely; details + media are always required when the program has collateral enabled.
- Section copy, helper, and canContinue logic are updated so both loan types present the same required behaviour.

### FR-5 Loan application submission fix (both flows)
- The frontend `submitBorrowerApplication` adapter must stop sending the legacy `LoanApplicationInput` shape (productId/principalNaira/tenureDays/financial/references) which does not match the backend `loanApplicationSchema`.
- Instead, the adapter should:
  1. First ensure a backend `loanApplications` row exists by `POST /borrower/applications` using the full ApplicationData mapped to `loanApplicationSchema` fields (`applicantType`, `personalInfo`, `businessInfo`, `businessRep`, `personalFinancial`, `businessFinancial`, `kyc`, `disbursementAccount`, `loanRequest: { amount, tenure, purpose }`, `collateral`, `documents`, `applicationId`).
  2. On subsequent retries, upsert via `PATCH /borrower/applications/:id`. Lookup must use the server-issued `application.id` returned from step 1, and additionally fall back to matching `applicationId === draftId` if the first PATCH returns 404.
  3. Finalize with `POST /borrower/applications/:id/submit`.
- Backend `PATCH /borrower/applications/:id` and `POST .../submit` routes are updated to also accept a lookup via the application-level `applicationId` field (i.e. match either `a.id === id || a.applicationId === id`). This is the root cause of `"Application not found"` for apps created with a client-provided `applicationId`.
- The same fix applies transparently to both PERSONAL and BUSINESS applicant types since both flow through the same ApplicationContext.submit.

### FR-6 OTP login toggle + step-up verification
- **User model (store.ts + DB schema)**: Add optional boolean `otpLoginEnabled?: boolean` (default false). Keep `preferredOtpChannel`.
- **Settings routes**:
  - `GET /api/v1/user/settings` returns `{ preferredOtpChannel, otpLoginEnabled }` for the authenticated user.
  - `PUT /api/v1/user/settings` accepts `{ preferredOtpChannel?: 'SMS'|'WHATSAPP'|'EMAIL', otpLoginEnabled?: boolean }` and persists the changes to the `users` row. Requires authentication.
- **Login flow**:
  - `POST /auth/login` after validating the password returns a new response shape `{ requiresOtp: true, challengeId, expiresAt, channel, resendAvailableAt, resendSecondsRemaining, user: {...} }` when `otpLoginEnabled === true`. The token is NOT issued in this response.
  - `POST /auth/login/verify-otp` validates `{ challengeId, code }`, on success issues the access token using the existing `issueToken` helper.
  - A resend endpoint `POST /auth/login/resend-otp` accepts `{ challengeId, userId, channel }` and issues a fresh challenge with rate limits.
- **Borrower dashboard** and **Investor dashboard** each gain a Security / Profile subsection that includes:
  - Current OTP login status (ON/OFF toggle switch).
  - Preferred channel selector (Email / SMS / WhatsApp) — mirrors the register screen selector.
  - Changes are posted to `PUT /user/settings`.
  - When toggling ON, the UI performs a one-time OTP verification to prove the channel works before persisting `otpLoginEnabled = true`.
- AuthContext login function and AccountAccess page are updated to handle the `requiresOtp` branch the same way the unverified-signup path works today (channel picker → OTP input → verify-otp → token → navigate).

### FR-7 Investor withdrawal OTP
- **Frontend (InvestorDashboard wallet/payout view)**:
  - The withdrawal form adds a channel selection row after amount + bank fields: "Send OTP via (Email / SMS / WhatsApp)".
  - Clicking "Request OTP" posts `POST /auth/otp/request` with `{ action: "WITHDRAWAL", channel }` and shows a 6-digit input + resend + countdown.
  - Once the code is entered, the "Confirm withdrawal" button posts to the withdraw endpoint with fields `{ amountNaira, bankCode, accountNumber, narration?, otpChallengeId, otpCode }`.
  - Error messaging surfaces invalid/expired OTP.
- **Backend withdrawal route (`POST /investor/wallet/withdraw`)**:
  - Schema extended with optional `otpChallengeId` and `otpCode`.
  - When either is provided, both are required and the challenge is verified via `verifyOtpChallenge()`. Action must equal `"WITHDRAWAL"` and `challenge.userId === req.user.id`.
  - On invalid OTP: return `400 { ok:false, error:"Invalid or expired OTP" }`.
  - The wallet ledger entries and investorWithdrawals record are only created if the OTP passes.
  - For backwards compatibility, if admin posts without OTP fields the call still succeeds (only the investor-facing UI must always require OTP).

---

## Non-Functional Requirements

- **Backward compatibility**: Existing unverified-investor sessions, current admin flows, and direct API calls that worked before remain functional. The OTP-required paths are opt-in or explicitly gated by `otpLoginEnabled` or explicit `otpChallengeId` payload.
- **Performance**: Search dropdown filtering over ≤ 200 banks runs in <16 ms. No new blocking network calls on every keystroke except the existing single `loadBanks()` fetch.
- **Security**: OTP challenges continue to use the existing rate-limit, max-attempts, and TTL settings (env OTP_*). All new endpoints require authentication (except the login verify/resend paths which are scoped to a specific challenge/user).
- **Accessibility**: New combobox must be focusable, use appropriate aria attributes, and announce statuses ("X results found").
- **Visual consistency**: Follow the existing `velo-input`, `velo-label`, button, and card design tokens; no third-party UI branding.

## Constraints, Dependencies, Assumptions
- Existing providers for OTP delivery (Kudi SMS, Meta WhatsApp, Brevo Email) are already integrated; re-use `createOtpChallenge` / `verifyOtpChallenge` from `auth.ts`.
- Bank list + account name resolve continue to use the Flutterwave provider endpoints already mounted.
- Zod validation continues to be the single source of truth for request shapes.
- Auth token remains JWT with the current secret/expiry.
- All text and placeholders remain in English; no i18n changes.

## Open Questions
None — all scope was confirmed explicitly in the request (collateral required for both loans, OTP delivery channels = Email + SMS + WhatsApp for login toggle + withdrawal, 10-digit auto resolve, etc.).

---

## Acceptance Criteria

### rule AC-1 Search dropdown
Typing "Access" in the bank field narrows the visible options to banks whose name contains "Access" and selecting one populates `bankCode`/`bankName` identically to the previous `<select>` behavior.

### rule AC-2 Auto resolve at 10 digits
Entering exactly 10 digits (no blur required) triggers the resolving indicator and populates Account Name once the endpoint returns; deleting back below 10 and re-entering 10 triggers again.

### rubric AC-3 No ₦/placeholder overlap
Score 0–2. `2` = all amount inputs show placeholder starting at least 4px clear of the ₦ glyph in Chrome + responsive widths, both with and without user-entered text. `1` = overlap is fixed in the primary screens (Financial sections + LoanRequest) but one or two secondary screens still show minor clipping. `0` = overlap remains visible anywhere. Pass threshold: ≥ 2.

### rule AC-4 Collateral required for both
Starting a Personal application, the collateral section no longer shows the optional checkbox; skipping the section via Continue is blocked until all fields and the media upload are present. Business path is unchanged (still required).

### rule AC-5 Submission success for both applicant types
After completing all sections (incl. KYC) for a PERSONAL draft, clicking Submit returns `{ ok:true }` and the application appears in `/borrower/dashboard` `applications[]`; repeat with a BUSINESS draft — same outcome, no `"Application not found"` at any step.

### rule AC-6 OTP login enforcement + toggle
With `otpLoginEnabled=false` a password login issues a token directly. After a user toggles it ON (completing proof OTP), the next password login returns `requiresOtp:true`, channel + OTP input are shown, only a valid 6-digit code exchanges for the token, and the dashboard reflects the new status. Toggling OFF works without a proof OTP.

### rule AC-7 Investor withdrawal OTP
In the investor withdrawal UI the "Confirm withdrawal" button stays disabled until an OTP is both requested and verified; submitting the withdrawal with an invalid/expired/absent `otpChallengeId`+code pair returns `400` and no `investorWithdrawals` row is created. With a valid OTP, the withdrawal record + ledger entries are persisted and the withdrawal email fires.
