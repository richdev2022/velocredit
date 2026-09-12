# Tasks: Loan Application, OTP Login & Withdrawal Enhancements

Parent spec: `spec.md` in this folder.
Every task maps one-to-many onto acceptance criteria; parent criterion type (`rule` or `rubric`) is preserved unless a narrower rule supplies evidence for a rubric.

---

## Task 1: Searchable bank dropdown in PersonalInfo + BusinessRep sections

**Status: pending**
**Priority: high**
**Parent AC: rule AC-1**

### Scope
Create a single reusable searchable-select combobox component (no external library — native DOM/datalist or a small combobox with filter list). Wire it into PersonalInfoSection and BusinessRepSection in place of the native `<select>`.

### Read-first paths
- `frontend/src/sections/PersonalInfoSection.tsx` (lines 52–233, banks state + select rendering)
- `frontend/src/sections/BusinessRepSection.tsx` (lines 54–244, same pattern)
- `frontend/src/components/FormInput.tsx` — input visual style reference (`.velo-input`)

### Implementation work
1. New file `frontend/src/components/SearchableSelect.tsx`
   - Props: `options: Array<{ value: string; label: string }>`, `value`, `onChange`, `placeholder`, `label`, `required`, `disabled`, `busy?`, `error?`.
   - Controlled input, shows a filtered dropdown positioned below; highlight match; keyboard nav (↑/↓, Enter, Esc); click outside closes.
   - Styling inherits `.velo-input` classes so it looks identical to other fields.
2. PersonalInfoSection replaces the inline `<label>+<select>+<option>` block with `<SearchableSelect>` feeding from the same `banks.map((b) => ({ value: b.code, label: b.name }))`.
3. Repeat the same replacement in BusinessRepSection.
4. All existing side effects (onChange → patchDisbursementAccount, clear resolved name on bank change, etc.) keep firing unchanged.

### Test Requirements
- **rule TR-1.1**: Selecting a bank by clicking sets `selectedBank` and calls `patchDisbursementAccount({ bankCode, bankName })` with the same values as before.
- **rule TR-1.2**: Typing "gtbank" (case-insensitive) keeps only options whose label contains that substring; clearing restores the full list.
- **rule TR-1.3**: Arrow keys move focus/highlight and Enter commits the currently highlighted option.
- **rule TR-1.4**: When `busy === "banks"` the component shows "Loading banks…" placeholder and is disabled.

### Completion Evidence
- Manual UI walkthrough recorded as: list open → filter by substring → select → bank code is saved → account resolve still works.

---

## Task 2: Auto trigger account-name resolve at 10 digits

**Status: pending**
**Priority: high**
**Parent AC: rule AC-2**

### Scope
In PersonalInfoSection and BusinessRepSection, auto-run `resolveAccount()` as soon as the cleaned `accountNumber` reaches exactly 10 digits.

### Read-first paths
- `frontend/src/sections/PersonalInfoSection.tsx` `resolveAccount()` (lines 87–116) and the `<FormInput accountNumber>` `onBlur` handler (lines 235–266).
- Same structure in `frontend/src/sections/BusinessRepSection.tsx` lines 89–266.

### Implementation work
1. Extract a shared effect/handler in each section: `useEffect(() => { if (selectedBank && accountNumber.length === 10) void resolveAccount(); }, [selectedBank, accountNumber])`. Use `accountForm.watch("accountNumber")` value and compare against the last auto-resolved pair in a ref to avoid duplicate calls when the user blurs afterwards.
2. Keep the existing `onBlur` call but add a guard: skip `resolveAccount` if a resolve for `(bankCode, accountNumber)` already ran this session (track via a `useRef` map `bankCode|accountNumber → resolved`).

### Test Requirements
- **rule TR-2.1**: Typing the 10th digit (not before) shows "Resolving account name…" and populates `accountName` within normal API latency; typing the 11th digit (unlikely but possible if they over-type before numeric filter) does NOT double-fire resolution until digits are back to exactly 10 again on a different number.
- **rule TR-2.2**: After auto-resolve succeeds, blurring the same (bank, account) pair does not cause a second network call.

### Completion Evidence
- Devtools network panel showing exactly 1 resolve call per distinct (bank, 10-digit number) pair.

---

## Task 3: Fix ₦/placeholder overlap in all amount inputs

**Status: pending**
**Priority: high**
**Parent AC: rubric AC-3**

### Scope
Increase left padding on every input that shows a `₦` prefix so the placeholder text starts to the right of the currency glyph.

### Read-first paths
- `frontend/src/components/FormInput.tsx` lines 33–46 — prefix span + `pl-9` class.
- `frontend/src/components/LoanAmountSelector.tsx` line 11 — absolute `₦` span + `pl-9`.
- `frontend/src/sections/CollateralSection.tsx` line 59 — estimated value input.
- `frontend/src/pages/InvestorDashboard.tsx` — fund/invest modal amount inputs (search for `₦` inline).

### Implementation work
1. `FormInput.tsx`: Change `pl-3` → `pl-4` on the prefix span, and change `pl-9` → `pl-10` on the input.
2. `LoanAmountSelector.tsx`: Increase the prefix span horizontal padding `pl-4` and input class `pl-9` → `pl-11`.
3. `CollateralSection.tsx` estimated value: convert it to use `FormInput` with `prefix="₦"` instead of a bare input, or add matching classes `pl-10` + absolute prefix span with `pl-4`.
4. Investor dashboard funding/investment inputs — apply same `pl-10` / prefix positioning wherever a `₦` character sits before the text.

### Test Requirements
- **rubric TR-3.1** (0–2, pass ≥ 2): Screenshot evidence showing LoanAmountSelector, PersonalFinancial monthly income, Collateral estimated value, and Investor fund-amount input all render the placeholder text "Enter amount" (or equivalent) without the first character being cut off or sitting behind the `₦` symbol; test on widths 375px, 768px, and 1200px.

### Completion Evidence
- Screenshot collage of the four input types at three breakpoints.

---

## Task 4: Collateral required for Personal loans (remove optional checkbox)

**Status: pending**
**Priority: high**
**Parent AC: rule AC-4**

### Scope
Update program defaults + UI so Personal loan collateral is always required and behaves identically to the Business path.

### Read-first paths
- `frontend/src/utils/config.ts` line 214: `baseProgram.collateral = { enabled: true, required: false }` and line 231–240 `basePrograms.PERSONAL` vs `BUSINESS`.
- `frontend/src/sections/CollateralSection.tsx` lines 11–16 `canContinue` logic + lines 49–54 optional checkbox block.

### Implementation work
1. `config.ts`: For `PERSONAL` program override, set `collateral: { enabled: true, required: true }` (mirror BUSINESS). Keep baseProgram as-is for clarity.
2. `CollateralSection.tsx`:
   - Remove the `{!rules.required && (...)}` optional checkbox block entirely.
   - Update `canContinue` formula so it only allows continue when `rules.enabled` → `detailsComplete && Boolean(media)` (the same branch currently used only when `rules.required` is true).
   - Update the `SectionShell` description so the Personal flow no longer shows "Add collateral details if you would like…" copy. You can key off `application.applicantType` or simply hard-code a single required description now that both programs require it.
   - The section status marking logic (`markSectionStatus("collateral", rules.enabled ? "completed" : "skipped")`) stays as-is but "skipped" will never be reached anymore since collateral is enabled+required for both; leave it in place defensively.

### Test Requirements
- **rule TR-4.1**: On a fresh Personal application draft, the collateral section blocks Continue until type + description + estimatedValue + ownership + location + media are all supplied.
- **rule TR-4.2**: The "I want to provide collateral" checkbox no longer appears in the DOM for any applicant type.

### Completion Evidence
- Manual run-through: Personal draft skips past collateral only when every required field + media upload present; Business unchanged apart from copy.

---

## Task 5: Fix loan application "Application not found" on submit (both flows)

**Status: pending**
**Priority: high**
**Parent AC: rule AC-5**

### Scope
Fix two root causes: (a) frontend `submitBorrowerApplication` adapter posts the wrong shape and (b) backend patch/submit lookups only match the DB row's `id` and ignore the client-provided `applicationId`.

### Read-first paths
- `frontend/src/services/apiClient.ts` lines 262–298 `LoanApplicationInput` + `submitBorrowerApplication`.
- `frontend/src/context/ApplicationContext.tsx` lines 431–460 `submit()` which calls `submitBorrowerApplication`.
- `backend/server/routes.ts` lines 175–190 `loanApplicationSchema`; POST `/borrower/applications` lines 1815–2005; PATCH line 2007–2078; SUBMIT line 2080–2095.
- `backend/server/routes.ts` lines 2008–2011 where lookup is `a.id === req.params.id` only.

### Implementation work
1. Backend routes:
   - For PATCH `/borrower/applications/:id` lookup replace:
     ```ts
     const application = loanApplications.find((a) =>
       (a.id === req.params.id || a.applicationId === req.params.id) &&
       a.borrowerId === req.user?.id
     );
     ```
   - Same change for SUBMIT `/borrower/applications/:id/submit`.
   - This dual-key lookup makes the endpoints resilient regardless of which ID the client holds.
2. Frontend `apiClient.ts` — rewrite `submitBorrowerApplication`:
   - Destructure the incoming `ApplicationData`-like input and map fields directly into `loanApplicationSchema`:
     ```
     {
       applicationId,
       applicantType,
       personalInfo,
       businessInfo,
       businessRep,
       personalFinancial,
       businessFinancial,
       kyc,
       disbursementAccount,
       loanRequest: { amount, tenure, purpose },
       collateral,
       documents,
     }
     ```
   - Strategy: first try `PATCH /borrower/applications/:applicationId` with the full mapped payload. If it returns 404 (not found), fall back to `POST /borrower/applications` with the full payload to create the record. Then, in either case, call `POST /borrower/applications/:id/submit` using the `application.id` the server returned.
   - Surface any backend `error` message from the PATCH/POST/SUBMIT response into the returned `{ ok, error }` shape so the UI can show it (today it silently swallows and throws a generic error).
3. ApplicationContext `submit()` already propagates `response.error` into `setSubmitError`; keep that wiring.

### Test Requirements
- **rule TR-5.1**: With a fresh draft that has never touched the backend, clicking Submit → backend writes one new `loanApplications` row with status SUBMITTED and returns `ok:true`; subsequent resubmit is idempotent.
- **rule TR-5.2**: Repeat TR-5.1 for both PERSONAL and BUSINESS applicant types and both succeed.
- **rule TR-5.3**: Using a manually corrupted/missing ID scenario, the PATCH-404 → POST-create-fallback succeeds instead of surfacing `"Application not found"`.

### Completion Evidence
- Network tab screenshot: submit sequence (either PATCH+SUBMIT or POST+SUBMIT) with 2xx responses, followed by a successful redirect to Success page.

---

## Task 6: OTP toggle + step-up verification on login (Borrower + Investor)

**Status: pending**
**Priority: high**
**Parent AC: rule AC-6**

### Scope
Add `otpLoginEnabled` to the User model, new settings endpoints, update the login flow, and expose the toggle in both dashboards.

### Read-first paths
- `backend/server/store.ts` User interface lines 16–35.
- `backend/server/routes.ts` login POST lines 269–306; OTP request lines 415–448; register verify-otp pattern lines 487–530 for reuse reference.
- `frontend/src/pages/AccountAccess.tsx` login submit flow, chooseLoginOtpChannel, and OTP input blocks (lines 76–170 + 692–737).
- `frontend/src/context/AuthContext.tsx` — `login()` implementation.
- `frontend/src/pages/InvestorDashboard.tsx` profile view area; `frontend/src/pages/BorrowerDashboard.tsx` corresponding profile/security area.

### Implementation work
1. Backend store: extend `interface User` with `otpLoginEnabled?: boolean`. (No migration script needed for in-memory; add to DB schema if used.)
2. New settings endpoints:
   - `GET /api/v1/user/settings` (requireAuth): return `{ preferredOtpChannel, otpLoginEnabled }`.
   - `PUT /api/v1/user/settings` (requireAuth): accept `{ preferredOtpChannel?, otpLoginEnabled? }` and assign to the user row; persist and respond with the merged values.
3. Update `POST /auth/login`: after password matches, additionally check `user.otpLoginEnabled === true`. If true, do NOT issue token. Instead call `createOtpChallenge(userId, "LOGIN_STEP_UP", user.phone, user.email, user.preferredOtpChannel)` and return `{ ok:true, requiresOtp:true, challengeId, expiresAt, channel, resendAvailableAt, resendSecondsRemaining, user: { id, email, fullName, roles } }`.
4. New endpoints supporting step-up:
   - `POST /auth/login/resend-otp`: zod schema `{ userId, challengeId?, channel? }`, create new challenge for `LOGIN_STEP_UP`, respond with the same fields.
   - `POST /auth/login/verify-otp`: zod schema `{ challengeId, code }`, verify via `verifyOtpChallenge`, then issue the token and return `{ ok:true, accessToken, user: {...} }`.
5. Frontend:
   - `services/apiClient.ts`: add `getUserSettings`, `updateUserSettings`, `loginStepUpResendOtp`, `loginStepUpVerifyOtp`.
   - `AuthContext.tsx` `login()` return value: if the response contains `requiresOtp:true` bubble that up to `AccountAccess`; add a new method `completeLoginOtp(challengeId, code)`.
   - `AccountAccess.tsx`: extend `chooseLoginOtpChannel` / OTP-input flow so both the existing `loginOtpUser` (unverified-account path) AND the new `requiresOtp` (otpLoginEnabled path) reuse the same OTP UI components but call different verify endpoints.
   - Investor dashboard `profile` view: add a "Two-step login (OTP)" card with toggle switch + channel selector; to switch ON, first require proof: perform OTP round trip → then PUT settings with `otpLoginEnabled:true`.
   - Borrower dashboard — same card added to its profile/settings view.

### Test Requirements
- **rule TR-6.1**: User with `otpLoginEnabled=false` logs in with only email+password and immediately receives a token.
- **rule TR-6.2**: After toggling ON and completing proof OTP, the next login returns `requiresOtp`; entering the wrong code fails; entering a valid code returns the token and navigates to the correct dashboard by role.
- **rule TR-6.3**: Investor and Borrower dashboard security sections both render toggle + channel selector and persist the change to `PUT /user/settings`; GET reflects it.

### Completion Evidence
- Recorded sequence: default (no OTP) login → toggle ON in profile → logout → login step-up OTP via email → dashboard. Repeat the same exercise on the opposite role dashboard.

---

## Task 7: OTP challenge before investor wallet withdrawal

**Status: pending**
**Priority: high**
**Parent AC: rule AC-7**

### Scope
Investor withdrawal flow: after entering amount + destination the user requests an OTP via selected channel, enters the 6-digit code, only then does the withdrawal post. Backend validates the challenge before touching wallet balances.

### Read-first paths
- `frontend/src/pages/InvestorDashboard.tsx` wallet/payout view and fund modal pattern.
- `backend/server/routes.ts` lines 3298–3433 `POST /investor/wallet/withdraw` — schema, validation, ledger entries.
- `backend/server/auth.ts` `createOtpChallenge` / `verifyOtpChallenge` (lines 142–200+).
- OTP request endpoint already exists: `POST /auth/otp/request` with action `"WITHDRAWAL"` (routes.ts lines 148–158, 415–448).

### Implementation work
1. Backend `POST /investor/wallet/withdraw`:
   - Extend zod schema with `otpChallengeId?: z.string().min(1).optional()` and `otpCode?: z.string().min(4).optional()`.
   - Add validation block: if `otpChallengeId || otpCode` then BOTH must be provided; call `verifyOtpChallenge(otpChallengeId, otpCode)`. If `result.ok` is false OR `result.action !== "WITHDRAWAL"` OR `result.userId !== req.user.id` → return `400 { ok:false, error:"Invalid or expired OTP" }` BEFORE any wallet modification.
   - Keep backwards compatibility: if neither OTP field is sent, the call still succeeds. This lets admin/reporting flows still work; only the investor UI will always send them.
2. Frontend InvestorDashboard:
   - In the wallet view, add a new withdrawal form section (or extend existing payout flow) with:
     - Amount input (same overlap-fix classes from Task 3).
     - Bank + account (reuse SearchableSelect component from Task 1).
     - "Send OTP via…" row: three option buttons `Email / SMS / WhatsApp`.
     - A "Request OTP" button (disabled until amount/bank valid).
     - On success of OTP request, show OTP digit input + countdown + resend link using the pattern from the existing KYC OTP blocks in the same file (lines 108–237).
     - A primary "Confirm withdrawal" button that is disabled until `activeWithdrawalOtpChallenge` exists and a 6-digit code entered.
   - Submitting calls `POST /investor/wallet/withdraw` with `{ amountNaira, bankCode, accountNumber, narration, otpChallengeId, otpCode }`. Handle errors ("Invalid or expired OTP", "Insufficient balance", "Could not verify bank account") inline.
   - Success message mirrors the existing banner pattern used after wallet funding success.

### Test Requirements
- **rule TR-7.1**: Submitting the withdrawal form WITHOUT a valid OTP pair returns 400 and no `investorWithdrawals` row is created.
- **rule TR-7.2**: Requesting a valid WITHDRAWAL OTP via any channel, entering the 6-digit code, and confirming → 200 response with `withdrawal: { id, status:"PENDING_APPROVAL" }`; ledger entries + notifications created as before.
- **rule TR-7.3**: Requesting OTP, waiting for expiry, then submitting → 400 error without any wallet mutation.

### Completion Evidence
- Devtools: WITHDRAWAL otp request → submit with correct code → 2xx response + withdrawal row appears in /admin/withdrawals list.

---

## Dependency order (must process topologically, can run concurrent siblings)

1. **Task 3** (overlap fix) and **Task 4** (collateral required) and **Task 1** (searchable bank select) are independent — can run concurrently.
2. **Task 2** depends on Task 1 only if we want to re-use the same section files; the code changes don't actually conflict so Task 2 can still run in parallel.
3. **Task 5** (application not found) fully independent from Tasks 1–4.
4. **Task 6** and **Task 7** both re-use the existing OTP provider stack but do not write to the same locations so they can run concurrently once Tasks 1–5 are complete (or concurrently from the start if agents are careful about no shared file overlap).

Tasks file ends here.
