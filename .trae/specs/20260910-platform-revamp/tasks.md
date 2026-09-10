# Tasks: Velo Loan Platform Comprehensive Revamp

## Dependency Order Legend
`Task N` → depends on completion of Task N (or earlier)
Priority: `high` = critical, `medium` = important, `low` = nice

---

## Task 1: Fix Sidebar Navigation Links (Investor & Borrower)
**Priority**: high  
**Status**: pending  
**Parent AC**: Rule AC1

### Description
Fix the sidebar menus in both InvestorDashboard.tsx and BorrowerDashboard.tsx so clicking menu items actually switches views.

### Read-First Paths
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\pages\InvestorDashboard.tsx`
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\pages\BorrowerDashboard.tsx`

### Scope
1. In InvestorDashboard.tsx: Ensure `investorMenu` array `key` values correctly bind to the `currentView` state setter on click.
2. In BorrowerDashboard.tsx: Ensure `borrowerMenu` array `key` values correctly bind to `currentView` state setter on click.
3. Verify view rendering switch statement / conditional render matches every menu key.
4. Add active-state class on the selected sidebar item.

### Test Requirements (TR)
- **Rule TR1**: Click "Wallet" investor sidebar → must render wallet section (not crash, no-op.
- **Rule TR2**: Click "Repayments" sidebar → must render repayments section.

---

## Task 2: Create Reusable PasswordInput Component with Show/Hide Toggle
**Priority**: high  
**Status**: pending  
**Parent AC**: Rule AC2

### Description
Create a reusable password input component with eye-icon show/hide toggle. Replace all inline `<input type="password">` usages.

### Read-First Paths
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\components\FormInput.tsx`
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\pages\AccountAccess.tsx`
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\components\admin\AdminLogin.tsx`
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\components\admin\AdminAccounts.tsx`
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\pages\LoanManagerSetup.tsx`

### Scope
1. Create `frontend/src/components/PasswordInput.tsx` with:
   - label, error, helper props
   - Eye/eye-off SVG or unicode icon toggle button
   - type="text" vs type="password" switch
   - Dark mode compatible
   - Integrates with velo-input styling
2. Replace password inputs in AccountAccess.tsx (3 places: login, register, reset)
3. Replace password inputs in AdminLogin.tsx (all password fields + reset flows)
4. Replace AdminAccounts.tsx temp password field
5. Replace LoanManagerSetup.tsx password field

### Test Requirements (TR)
- **Rule TR1**: New PasswordInput renders with velo-input class.
- **Rule TR2**: Click toggle → input type flips.
- **Rule TR3**: All pages using old `<input type="password">` replaced.

---

## Task 3: Complete Admin Sidebar Redesign (Modern Professional)
**Priority**: high  
**Status**: pending  
**Parent AC**: Rubric AC10

### Description
Fully revamp the admin sidebar in Admin.tsx to a modern professional style with icons, section grouping, dark mode.

### Read-First Paths
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\pages\Admin.tsx`
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\pages\InvestorDashboard.tsx` (sidebar reference)

### Scope
1. Extract admin sidebar into a separate component (optional but recommended: `AdminSidebar.tsx`)
2. Add SVG icons (lucide-react or inline) to each menu item
3. Add section group headers (Workspace / Risk & Money / Financials / Insights / Administration)
4. Modernize: collapsed hover tooltip, active emerald highlight, rounded corners
5. Dark mode proper dark styling (slate backgrounds with proper accent)
6. Platform branding area at top, admin profile info at bottom

### Test Requirements (TR)
- **Rubric TR1 (0-2, threshold >=2)**: Sidebar modernized with icons, sections, proper spacing; matches professional fintech UI.
- **Rule TR2**: Every menu items navigates correctly after redesign.

---

## Task 4: Remove Default 100M Ledger Opening Balance
**Priority**: high  
**Status**: pending  
**Parent AC**: Rule AC3

### Description
Ensure the admin ledger has a 0 default balance by removing any seed of 100M.

### Read-First Paths
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\backend\server\store.ts` (look at `seedAdminLedgerOpeningBalance` and where called)
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\backend\server\index.ts` (check initialization)

### Scope
1. In store.ts: remove or don't auto-invoke seedAdminLedgerOpeningBalance(100_000_000 * 100 minor)
2. If called in index.ts or routes.ts, remove call (comment out per user preference)
3. Leave seed function available for manual use.
4. Verify getAdminLedgerBalanceMinor() returns 0 on first run.

### Test Requirements (TR)
- **Rule TR1**: Admin ledger balance on clean init = 0 (no 100M seed).

---

## Task 5: Restructure Ledger Flows (Funding / Disbursement / Repayment / Payout)
**Priority**: high  
**Status**: pending  
**Parent AC**: Rule AC4, Rubric AC11

### Description
Correct the double-entry flow for all 4 transaction types, ensuring:
- Funding: Admin ledger CREDIT first, then DEBIT admin ledger + CREDIT investor wallet
- Disbursement: Debit admin ledger, Flutterwave, then credit borrower via FW
- Repayment: Flutterwave, credit admin ledger, update loan
- Payout: Interval sweep auto-calculation

### Read-First Paths
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\backend\server\routes.ts` lines around funding (1201-1280), disbursement (2425-2480), repayment (1878-), payout (2747-)
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\backend\server\store.ts` appendAdminLedger, appendLedger
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\backend\server\index.ts` webhook handlers

### Scope
1. **Investor funding fix** (routes.ts wallet funding verify + webhook):
   - Step A: appendAdminLedger CREDIT (FUNDING_IN) for the amount
   - Step B: appendAdminLedger DEBIT (WALLET_CREDIT)
   - Step C: settleWalletDeposit / appendLedger CREDIT to investor wallet

2. **Loan disbursement restructure** (routes.ts admin disburse):
   - appendAdminLedger DEBIT (LOAN_DISBURSEMENT)
   - call createLoanDisbursement Flutterwave
   - On success → loan.status = DISBURSED via webhook + FW

3. **Borrower repayment webhook** (index.ts webhook section):
   - Verified repayment success → appendAdminLedger CREDIT (LOAN_REPAYMENT_IN)
   - → appendLedger (loan.principal/interest split)

4. **Payout flow** (runInvestmentMaturitySweep + webhook):
   - Sweep auto-calc on maturity: principal + earnings → credit investor wallet
   - Debit admin ledger on actual payout transfer execute

### Test Requirements (TR)
- **Rule TR1**: Investor funding produces 2 admin ledger entries (CREDIT then DEBIT) + 1 wallet CREDIT.
- **Rule TR2**: Disbursement produces 1 admin ledger DEBIT before FW call.
- **Rule TR3**: Repayment webhook credits admin ledger (LOAN_REPAYMENT_IN).
- **Rubric TR4 (0-2, >=2)**: All 4 flows standard double-entry structure correct.

---

## Task 6: Admin Transaction Tracking Dashboard (Disbursements + Payouts) with Retry
**Priority**: high  
**Status**: pending  
**Parent AC**: Rule AC5

### Description
Admin can list disbursements and payouts with status detail, provider response, and retry-failed button.

### Read-First Paths
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\components\admin\AdminWorkspace.tsx` (Payouts section)
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\services\adminApi.ts`
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\backend\server\routes.ts` admin routes for payouts/disbursements

### Scope
Frontend:
1. Admin Payouts view → table with: ID, investor, amount, type, status, date, provider response (collapsible detail for FAILED), Retry button
2. Admin Loans/Disbursements view → same table with: loan ID, borrower, amount, status, FW transfer reference, provider response, Retry button
3. Retry button calls adminRetryPayout / adminRetryDisbursement

Backend:
1. Ensure `POST /admin/payouts/:payoutId/retry` exists & calls createInvestorPayout
2. Create `POST /admin/disbursements/:disbursementId/retry` → re-calls createLoanDisbursement
3. Both endpoints populate providerTransfer with new txRef

### Test Requirements (TR)
- **Rule TR1**: FAILED payout row shows "Retry" button → click → status → PROCESSING
- **Rule TR2**: FAILED disbursement row shows "Retry" → re-initiates FW transfer
- **Rule TR3**: FAILED status rows expand to show provider response.

---

## Task 7: Borrower Loan Repayment via Flutterwave (Outstanding Card + Webhook)
**Priority**: high  
**Status**: pending  
**Parent AC**: Rule AC6

### Description
Add clear "Repay Loan" button/link on the borrower dashboard outstanding loan card. Click initializes Flutterwave checkout with the exact loan repayment amount. Webhook updates loan + credits admin ledger (partially covered in Task 5).

### Read-First Paths
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\pages\BorrowerDashboard.tsx` Overview / loans card
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\services\apiClient.ts` createRepayment / borrower repay endpoint
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\backend\server\routes.ts` POST /borrower/loans/:loanId/repayments
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\backend\server\providers\flutterwave.ts` initializeRepayment

### Scope
1. In BorrowerDashboard.tsx → outstanding/active loan card → prominent "Repay Now" CTA button (visible amount due)
2. Click calls initializeRepayment with loan repayment amount → redirect to Flutterwave checkout (as investor wallet funding does but initializeRepayment endpoint which already exists
3. Return URL from Flutterwave redirects back to borrower dashboard repayments view
4. Webhook → marks repayment SUCCESSFUL and admin ledger credited (Task 5 scope overlaps)

### Test Requirements (TR)
- **Rule TR1**: Active loan card shows "Repay Now" with the loan repayment amount.
- **Rule TR2**: Click Repay Now → Flutterwave checkout page opens/redirects with amount filled.

---

## Task 8: Automated Investor Payout on Interval/Maturity
**Priority**: medium  
**Status**: pending  
**Parent AC**: Rule AC7

### Description
Enhance `runInvestmentMaturitySweep` so when maturity interval hits → calculate principal + earned interest → auto-credit to investor wallet (internal wallet balance), optionally trigger external payout (via investor withdrawal flow).

### Read-First Paths
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\backend\server\investments.ts`
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\backend\server\store.ts` (Investment, appendLedger, appendAdminLedger)

### Scope
1. Sweep investments where (status === "ACTIVE" && now >= maturedAt)
2. Calc earnings = investment amount × rate × duration
3. Create payout record (payouts array) → payoutType = INVESTMENT_MATURITY
4. Credit investor wallet = principal + earnings via appendLedger
5. Then auto-initiate payout investor's payout account via createInvestorPayout() OR mark as PENDING_APPROVAL for admin review if required
6. setInterval invocation in index.ts (if not already)

### Test Requirements (TR)
- **Rule TR1**: Past-due ACTIVE investment on sweep → creates payout record + credits wallet
- **Rule TR2**: runInvestmentMaturitySweep does not double-process same investment.

---

## Task 9: Investor Bank Payout Account Linking (Flutterwave banks list + name resolve)
**Priority**: high  
**Status**: pending  
**Parent AC**: Rule AC8

### Description
Investor dashboard "Payout account" section: currently only "Velo"; add form to add Nigerian bank accounts via Flutterwave bank list. Call resolveBankAccount(accountNumber, bankCode) to query account name; set default payout account.

### Read-First Paths
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\pages\InvestorDashboard.tsx` → "payout" view section
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\services\apiClient.ts`
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\backend\server\routes.ts` payout account endpoints
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\backend\server\providers\flutterwave.ts` resolveBankAccount
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\backend\server\store.ts` PayoutAccount type

### Scope
Backend:
1. Add GET /providers/flutterwave/banks → list Nigerian banks from Flutterwave (list banks endpoint wrapper).
2. Add POST /investor/payout-accounts/resolve → calls resolveBankAccount and returns account name.
3. Add CRUD for payout accounts (POST /investor/payout-accounts, PUT /investor/payout-accounts/:id, DELETE, GET)
4. Add default flag on PayoutAccount

Frontend (InvestorDashboard payout view):
1. Dropdown select bank (list of banks)
2. Input account number → on blur → call resolve → display returned Account Name (readonly display)
3. Save → create the payout account
4. List all saved payout accounts; default selector

### Test Requirements (TR)
- **Rule TR1**: "Add bank account" has bank dropdown + account number; valid -> shows resolved account name.
- **Rule TR2**: Saved payout accounts list.

---

## Task 10: Admin Approval Flow for Payout/Disbursement Account Changes
**Priority**: high  
**Status**: pending  
**Parent AC**: Rule AC9

### Description
First-time account setup saves immediately. Any subsequent EDIT to investor payout account or borrower disbursement account goes through admin approval. Admin sees requests queue, can Approve or Reject with reason. Only on Approve is the actual account updated.

### Read-First Paths
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\backend\server\store.ts` (new AccountChangeRequest type)
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\backend\server\routes.ts` updateBorrowerDisbursementAccount, update investor payout account endpoints
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\components\admin\AdminWorkspace.tsx` → new "Account Requests" or rename section to include this
- `c:\Users\ADMIN\Documents\Velo Loan\veloloan\frontend\src\services\adminApi.ts`

### Scope
Backend:
1. Add `AccountChangeRequest` to store.ts (id, userId, accountType: PAYOUT | DISBURSEMENT, oldSnapshot, newSnapshot, status = PENDING_APPROVAL, reviewedBy, reviewedAt, reason)
2. Modify PUT /investor/payout-accounts/:id and PUT /borrower/disbursement-account:
   - If NO existing payout/disbursement account for user → save immediately (first-time setup)
   - If existing account → create AccountChangeRequest PENDING_APPROVAL; do NOT apply yet
3. Admin endpoints:
   - GET /admin/account-requests → list pending + history
   - PUT /admin/account-requests/:id/approve → apply change to actual account, mark APPROVED
   - PUT /admin/account-requests/:id/reject → mark REJECTED with reason

Frontend:
1. Admin Workspace → add "Account Requests" section (new AdminSection value)
2. Table: user email, type (PAYOUT/DISBURSEMENT), old vs new bank details, Approve + Reject buttons
3. Reject modal prompts for reason
4. Investor/Borrower account edit form shows toast "Awaiting admin approval" when PENDING

### Test Requirements (TR)
- **Rule TR1**: First-time setup saves account without approval.
- **Rule TR2**: Second edit of same user's payout account creates pending request (account unchanged).
- **Rule TR3**: Admin approves → account data updates + request status = APPROVED.
- **Rule TR4**: Admin rejects → account unchanged + status = REJECTED with reason.
