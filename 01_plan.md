# Velo Loan Platform — Comprehensive Implementation Plan

## Execution Order
All edits are implemented fully first, then verification commands run (per user preference).

---

## TASK 1: BVN/NIN Verification UI Cleanup + OTP Modal Flow

### Files:
- `frontend/src/sections/PersonalKycSection.tsx`
- `frontend/src/sections/BusinessKycSection.tsx`
- `frontend/src/pages/InvestorDashboard.tsx` (KYC view)

### Changes:
1. **Remove "Checking with Prembly…" branding** — Replace with generic neutral text:
   - PersonalKycSection.tsx L67: `"Verifying…"`
   - BusinessKycSection.tsx L67: `"Verifying…"`

2. **OTP selection modal after BVN/NIN verify click**:
   - On clicking "Verify BVN instantly" / "Verify NIN instantly":
     - Run the verifyIdentity() call
     - If backend returns `otpChallenge` (phone mismatch scenario) → open modal
     - Modal content: "Select OTP delivery method" with SMS + WhatsApp buttons
     - On method select: call the resend endpoint with the chosen channel, then show 6-digit OTP input
     - On confirm: call confirmKycOwnershipOtp(), on success mark verified
   - If backend returns SUCCESS directly (no otpChallenge) → mark verified (no modal)
   - Use existing `otpMethodPickerFor`, `activeOtpChallenge` state patterns from InvestorDashboard KYC section

3. **Remove selfie upload fallback COMPLETELY**:
   - PersonalKycSection.tsx: Delete lines 177-187 (the entire `<details>` block with file upload)
   - BusinessKycSection.tsx: Delete the file upload `<input>` (currently placed BEFORE widget) — keep only the PremblyKycWidgetButton
   - In BusinessKycSection, reorder to: Prembly widget FIRST (in emerald/amber box), no upload at all

4. **Remove Flutterwave/Prembly branding from user UI**:
   - InvestorDashboard.tsx: L931 "Make a deposit via Flutterwave." → Change to "Secure payment processing. Your deposit is protected."
   - PremblyKycWidgetButton.tsx L38: "Verify identity with Prembly camera" → "Verify with camera"

---

## TASK 2: Investor Dashboard Fixes

### Files:
- `frontend/src/pages/InvestorDashboard.tsx`
- `frontend/src/services/apiClient.ts` (if helpers needed)
- `frontend/src/components/ReceiptDownload.tsx` (NEW — for receipt PDFs)

### Changes:
1. **Wallet history shows funding**:
   - `InvestorTransactions` component (L1128-1170): Currently only renders `payouts` and `investments`. Add section for `walletTransactions` (DEPOSIT type) AND combine with `ledger` entries (FUNDING credits, INVESTMENT_LOCK debits, INVESTMENT_RETURN credits, PAYOUT debits, FEE debits, etc.) into a unified "All transactions" view with debit/credit indicators.

2. **Rename "Ledger" everywhere in Investor UI**:
   - L73 `hint: "Ledger & history"` → `hint: "Transactions"`
   - L1138 `"Ledger & history"` → `"Transaction history"`

3. **Invest CTA button on dashboard**:
   - In the plans list (L897 area) and also in the Investments view (L960-978 area), add a prominent "Invest" button per plan card.
   - On click: open amount input modal (min = plan.minAmountNaira, max = plan.maxAmountNaira)
   - On confirm: call `createInvestment(planId, amountNaira)` from apiClient
   - Success: refresh dashboard data, show success banner

4. **Fund wallet modal (not inline form)**:
   - Remove inline funding form (L896 area: `<form onSubmit={handleFundWallet}>`)
   - Replace with state: `[fundModalOpen, setFundModalOpen]`
   - Quick action "Fund wallet" button (L818-843) → onClick sets fundModalOpen=true
   - "Deposit to start investing" CTA in overview → same modal
   - Modal: heading "Fund your wallet", amount input with min=1000, "Continue to payment" submit
   - On success: close modal, redirect to Flutterwave checkout link

5. **Transaction history CTA navigates to transactions page**:
   - Quick action "Transaction history" (L870-894): onClick sets `view="transactions"` and `action=""`

6. **Investor transaction history: All debits/credits + detail + download receipt**:
   - Unified transaction list: Combine `ledger`, `walletTransactions`, `payouts`, `investments` into single sorted timeline
   - Each row: date, description, type badge, amount (+credit green / -debit red), balance after
   - Click row → open detail modal with:
     - Transaction ID / reference
     - Date & time
     - Type, description, metadata
     - Amount, currency, running balance
     - "Download receipt" button
   - Receipt PDF: Create `ReceiptDownload.tsx` (reuse AgreementDownload.tsx jspdf patterns):
     - Header: Velo logo + "Transaction Receipt"
     - Transaction details table (ID, date, type, reference, amount, status)
     - Wallet balance (before / after)
     - Footer: "Thank you for investing with Velo"
     - Use jsPDF library (already imported in AgreementDownload)
     - Save filename: `Velo_Receipt_${txId}_${date}.pdf`

7. **Auto-fetch investment plans on dashboard load**:
   - In initial load useEffect (L129 area), add `getInvestmentPlans()` to the Promise.all
   - Remove lazy-load from `openAction("plans")` — just set state
   - Also auto-load in the Investments view on first render

---

## TASK 3: Admin JSON Error Fixes

### Files:
- `frontend/src/components/admin/AdminAccountRequests.tsx`
- `frontend/src/components/admin/AdminWorkspace.tsx`
- `frontend/src/services/adminApi.ts`

### Changes:
1. **Account change requests JSON error**:
   - AdminAccountRequests.tsx L44-59: Replace raw `fetch().json()` with call to existing `adminListAccountRequests({ status })` helper from adminApi.

2. **Audit log JSON error + pagination**:
   - Add `adminListAuditLogs()` function to `adminApi.ts` using shared `request<T>()` helper
   - AdminWorkspace.tsx L199 Audit(): Replace raw fetch with `adminListAuditLogs()` call

---

## TASK 4: Admin Ledger Detail View

### Files:
- `frontend/src/components/admin/AdminSettings.tsx`

### Changes:
1. **Ledger entry click → detail modal**:
   - Add state: `[selectedLedgerEntry, setSelectedLedgerEntry]`
   - Each ledger row: `onClick={() => setSelectedLedgerEntry(entry)}` (pointer cursor)
   - Modal content:
     - Entry ID, Type badge, Direction (DEBIT/CREDIT)
     - Amount (formatted), Currency
     - Description, Reference ID link
     - Balance After (formatted)
     - Metadata JSON (pretty printed)
     - Created At (formatted date+time)
2. **Add pagination UI**: Replace `.slice(0, 40)` with proper page navigation using existing `meta` from backend (supports limit/offset already)

---

## TASK 5: Admin Users Page Complete Revamp

### Files:
- `frontend/src/components/admin/AdminWorkspace.tsx` (Users function)
- `backend/server/routes.ts` (add 3 new routes)
- `frontend/src/services/adminApi.ts` (add 4 new API helpers)

### Backend routes (routes.ts after L2071):
1. **POST /admin/users** — Create regular user (email, fullName, phone, password, roles array [INVESTOR/BORROWER])
2. **PATCH /admin/users/:id/roles** — Update user roles (add/remove INVESTOR, BORROWER)
3. **PATCH /admin/users/:id/status** — isActive toggle + record audit log

### Frontend (AdminWorkspace.tsx Users()):
1. **Remove inline create form** — Replace with CTA button `+ Create User` (top-right, btn-primary) that opens modal
2. **Modal**: Create user form (email, fullName, phone, password, role checkboxes [INVESTOR, BORROWER])
3. **Paginated table as default** (already exists, keep/enhance)
4. **Row actions column** (per user):
   - "Edit" → modal: edit fullName, phone, role checkboxes (save calls PATCH roles)
   - Status toggle: Green "Active" pill button → click → deactivate (confirm) | Gray "Inactive" pill → click → activate
   - Show user.id, email, fullName, phone, roles chips, status badge, createdAt

---

## TASK 6: Flutterwave Bank Selection — Fix "Unexpected token <"

### Files:
- `frontend/src/pages/InvestorDashboard.tsx` (InvestorPayoutSection)
- `frontend/src/components/BorrowerDisbursementSection.tsx`
- `frontend/src/services/apiClient.ts` (if adding helper wrappers)
- `vite.config.ts` (optional: add dev proxy for /api)

### Changes:
1. **InvestorPayoutSection (ALL fetch calls) — fix 4 bugs**:
   - **Fix token key**: `"velo:token"` → use `getAccessToken()` from apiClient (reads `"velo:access-token"`)
   - **Fix API URL prefix**: All `fetch("/api/v1/...")` → use `${config.apiUrl}/api/v1/...` (import config from utils/config)
   - **Add Authorization header** on bank list fetch (was completely missing on L1190)
   - Add error handling for non-JSON responses: `if (!r.ok || !r.headers.get("content-type")?.includes("json")) throw new Error(...)`

2. **BorrowerDisbursementSection (ALL fetch calls) — fix API URL prefix**:
   - All `fetch("/api/v1/...")` → `${config.apiUrl}/api/v1/...`
   - Auth header already correct, just URL prefix needed

3. **Alternative (cleaner)**: Convert all raw fetch calls in both components to use apiClient helper functions (add new helpers to apiClient.ts for payout-accounts CRUD, resolve, etc.) — this is more maintainable long-term

---

## TASK 7: Business Information "Save & Continue" Fix

### Files:
- `frontend/src/sections/BusinessInfoSection.tsx`

### Changes:
1. **Add missing `next()` call** (L53-56 onSubmit):
   ```ts
   function onSubmit(data: BusinessInfoForm) {
     patchBusinessInfo(data);
     markSectionStatus("info", "completed");
     next();   // <-- ADD THIS LINE
   }
   ```
2. Verify same pattern works for all sections by reviewing SectionShell.tsx: when onContinue is provided, it replaces the default next() entirely.

---

## TASK 8: Representative KYC — Prembly Parity + Prefill

### Files:
- `frontend/src/sections/BusinessKycSection.tsx`

### Changes:
1. **Reorder liveness UI to match Personal**:
   - Remove file upload `<input>` (the one currently above widget) — NO fallback at all (per TASK 1 requirement)
   - Keep only PremblyKycWidgetButton in the primary liveness box
   - Reorder to: Widget first (like PersonalKycSection), no upload anywhere
2. **Add BVN/NIN hints** (match Personal section):
   - BVN helper: "Dial *565*0# on your registered line to retrieve your BVN."
   - NIN helper: "Found on your National Identity Card or via the NIMC app."
3. **Verify identity info prefill**:
   - Existing code (L79) already does `patchBusinessRep(autofill)` — confirm the autofill object keys (fullName, phone, dateOfBirth) map correctly to businessRep schema fields
   - Add logging/debug if fields aren't pre-filling (compare key names against BusinessRepForm type)

---

## TASK 9: Borrower Disbursement — Velo Hint + Flutterwave Integration

### Files:
- `frontend/src/sections/PersonalInfoSection.tsx` (Velo Account card)
- `frontend/src/sections/BusinessRepSection.tsx` (Velo Account card)
- `frontend/src/types/application.ts` (DisbursementAccount type)
- `frontend/src/utils/validation.ts` (disbursementAccountSchema)

### Changes:
1. **Update Velo Account hint text**:
   - Add a banner/callout above the disbursement fields:
     ```
     💡 Highly recommended: Use your Velo account details for loan disbursement for the fastest loan processing.
     You can add or change your disbursement bank to any Nigerian bank later from your borrower dashboard.
     ```

2. **Replace plain text Bank Name input with Flutterwave bank dropdown + nameEnquiry**:
   - In both PersonalInfoSection.tsx (L114-124) AND BusinessRepSection.tsx (L124-134):
     - Import and mirror the pattern from BorrowerDisbursementSection.tsx:
       - `banks` state, `loadBanks()` on mount (fetch Flutterwave bank list)
       - Replace `FormInput label="Bank Name"` with a `<select>` / `SelectInput` dropdown showing bank names, value=bankCode
       - Account Number field: add `onBlur` → if 10 digits, call nameEnquiry resolve API
       - Show resolved Account Name below (read-only display)
       - Store resolved accountName in disbursementAccount

3. **Schema updates**:
   - `types/application.ts` DisbursementAccount: Add `bankCode?: string` field
   - `validation.ts` disbursementAccountSchema: Add `bankCode: z.string().min(1, "Select your bank")`

---

## Verification Steps (Run After All Code Changes):

1. **TypeScript build (frontend)**:
   ```
   cd frontend && npm run build
   ```
   Fix any type errors before continuing.

2. **Backend typecheck**:
   ```
   cd backend && npx tsc --noEmit
   ```

3. **Runtime smoke tests via browser**:
   - Investor login → verify BVN: should show OTP modal, no "Prembly" text visible
   - Investor Dashboard: plans should auto-load, Invest buttons work, Fund wallet opens modal
   - Investor Transactions: funding + debits+credits visible, click row for detail, download receipt opens PDF
   - Admin login → Account Requests page: no JSON error
   - Admin → Audit log: no JSON error
   - Admin → Users: table shows, Create User button opens modal, activate/deactivate works
   - Admin → Ledger: click row opens detail modal
   - Investor → Payout account: bank dropdown loads, no JSON error
   - Borrower → Apply (Business): Save & Continue on Business Info advances to next step
   - Borrower → Apply: Disbursement bank dropdown loads, name enquiry works

---

## Critical Files Summary

| File | Tasks |
|------|-------|
| `frontend/src/sections/PersonalKycSection.tsx` | T1 (remove Prembly text, OTP modal flow, remove selfie fallback) |
| `frontend/src/sections/BusinessKycSection.tsx` | T1 (remove Prembly text, remove selfie fallback, reorder UI) + T8 (parity) |
| `frontend/src/pages/InvestorDashboard.tsx` | T1 (KYC view) + T2 (wallet history, rename, invest CTA, fund modal, tx history, plans auto-load) + T6 (bank selection fix) |
| `frontend/src/components/admin/AdminAccountRequests.tsx` | T3 (fix JSON error) |
| `frontend/src/components/admin/AdminWorkspace.tsx` | T3 (audit log fix) + T5 (users revamp) |
| `frontend/src/components/admin/AdminSettings.tsx` | T4 (ledger detail + pagination) |
| `frontend/src/sections/BusinessInfoSection.tsx` | T7 (fix Save & Continue) |
| `frontend/src/sections/PersonalInfoSection.tsx` | T9 (velo hint + bank dropdown) |
| `frontend/src/sections/BusinessRepSection.tsx` | T9 (velo hint + bank dropdown) |
| `frontend/src/components/BorrowerDisbursementSection.tsx` | T6 (API URL prefix) |
| `frontend/src/services/adminApi.ts` | T3 (audit log helper) + T5 (users CRUD helpers) |
| `frontend/src/services/apiClient.ts` | T2 (new helpers if needed) + T6 (payout helpers) |
| `backend/server/routes.ts` | T5 (3 new admin/users routes) |
| `frontend/src/types/application.ts` | T9 (add bankCode to DisbursementAccount) |
| `frontend/src/utils/validation.ts` | T9 (add bankCode to schema) |
| `frontend/src/components/ReceiptDownload.tsx` | T2 (NEW - receipt PDF generation) |
| `frontend/src/components/PremblyKycWidgetButton.tsx` | T1 (remove Prembly branding) |
