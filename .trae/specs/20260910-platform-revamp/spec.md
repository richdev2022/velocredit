# Specification: Velo Loan Platform Comprehensive Revamp

## Problem
The Velo Loan platform currently has several broken features, unprofessional UI, incomplete payment infrastructure issues that prevent smooth operations:
1. Dashboard sidebar navigation links are non-functional (Investor dashboards)
2. No show/hide password functionality on password fields
3. Admin sidebar has unprofessional styling
4. Admin ledger seeded with 100M instead of 0 default
5. Ledger reconciliation flow is incorrect (must mirror Flutterwave, investor funding must credit ledger first)
6. No admin ability retry for failed transfers
7. Borrower loan repayment Flutterwave checkout
8. No automated investor payout maturity
9. No bank account linking
10. No admin approval flow for account changes

## Users and Goals
| User | Goals |
|---|---|
| **Borrower** | Login, sidebar, repay loans via Flutterwave, update disbursement account with approval |
| **Investor** | Functional sidebar, fund wallet (credits admin ledger then wallet, link payout bank accounts, automated payout |
| **Admin** | Professional sidebar, track disbursements and track all payments, retry failed transfers |

## Non-Goals
- Rewriting the entire backend framework
- Adding new identity KYC provider integrations
- Rebuilding the frontend from scratch
- Adding crypto or loan application flow

## Functional Requirements

### FR1: Fixed Sidebar Navigation
- All sidebar menu items in InvestorDashboard sidebar items must navigate to corresponding views
- All sidebar menu items in BorrowerDashboard sidebar items must navigate to corresponding views
- Active state must be visually indicated for the selected view

### FR2: Show/Hide Password Toggle
- All password fields across all pages must have an eye icon toggle to show/hide the password
- Affected screens:
  - Login & Registration (AccountAccess.tsx: 3 fields
  - Admin Login & Reset (AdminLogin.tsx): password fields
  - Admin create account password (AdminAccounts.tsx)
  - Loan Manager Setup (LoanManagerSetup.tsx)
  - Password reset flows

### FR3: Professional Admin Sidebar Redesign
- Modern sidebar with:
  - Clean grouped navigation with icons for each menu item
  - Collapsible sidebar (optional collapse on mobile responsive collapse on smaller screens
  - Professional color scheme with emerald accent
  - Dark mode support
  - Active item highlight and proper spacing and proper section headers
  - Platform branding area and user profile in sidebar

### FR4: Admin Ledger Default to 0
- Remove default 100M opening balance
- Ledger starts at 0 balance
- Seed opening balance initialization only on explicit action

### FR5: Correct Ledger Flow Restructure Ledger Reconciliation Flows
#### Investor Wallet Funding Flow:
1. Investor initiates funding Flutterwave payment
2. Flutterwave success → credit ADMIN LEDGER CREDITED FIRST
3. Then → Debit Admin Ledger & Credit Investor Wallet
4. Record both transactions recorded in wallet transactions recorded

#### Loan Disbursement Flow:
1. Admin approves disburses loan:
2. Debit Admin Ledger (loan amount)
3. Call Flutterwave disbursement transfer API
4. On Flutterwave success
5. Credit Borrower's disbursement account (update loan.status = DISBURSED

#### Investor Payout Flow:
1. On interval reach maturity → calculate payout
2. Credit investor's wallet → investor wallet

### FR6: Admin Transaction Tracking & Retry
- Admin can view all disbursed loan transactions list with:
  - Transaction ID, amount, borrower, status, provider response, provider transfer details
- Admin can view all investor payout transactions:
  - Payout ID, amount, investor, status, provider response
- Status indicators: SUCCESSFUL, FAILED, PROCESSING
- For FAILED transactions: show provider's full response
- Retry button to re-initiate the failed transfer (both disbursement and payout retry

### FR7: Borrower Loan Repayment via Flutterwave
- Outstanding loan card show "Repay" button/link on the outstanding loan card
- Click → Flutterwave checkout with the loan repayment amount
- Flutterwave webhook → verify payment success
- Update loan outstanding, update → update ledger credited (repayment record
- Admin ledger CREDIT for the repayment amount

### FR8: Automated Investor Payout
- Run investment maturity sweep at configured intervals
- Calculate: principal + earnings
- Auto credit investor wallet automatically
- Update: payout record with status

### FR9: Investor Bank Account Linking for Payout Accounts
- Add payout bank account selection from Flutterwave bank list
- Flutterwave banks list
- Account name account number, Flutterwave resolve (resolveBankAccount resolve
- Resolve account name query endpoint
- Verify account matches
- Set default payout account
- First-time setup: NO admin approval needed
- Subsequent changes: require ADMIN APPROVAL required

### FR10: Admin Approval for Payout/Disbursement Account Changes
- First-time setup (no existing account changes flow:
  - Payout/disbursement accounts
- Admin section to list all account change requests
- Approve / Reject actions with reason
- Only execute actual account update only after APPROVE
- Notify user of status changes (email/SMS)

## Non-Functional Requirements
- NFR1: All changes fully dark mode compatible
- NFR2: All flows must have audit trails
- NFR3: All transactions idempotency on retries
- NFR4: Webhook verified signatures verified

## Constraints
- Flutterwave-only payment gateway only
- Existing data structures preserved where usable
- Backwards compatible with existing data

## Assumptions
- Flutterwave API keys already configured
- Bank list API available
- Webhook endpoints already set up

## Open Questions
- None at this time

## Acceptance Criteria

### Rule AC1: Sidebar links navigate on click
- **Evidence** : InvestorDashboard on any sidebar item → view updates without error

### Rule AC2: Password fields toggle visibility
- **Evidence**: Every password field in App has show/hide toggle that switches type between text/password

### Rule AC3: Admin ledger balance 0
- **Evidence**: Fresh seeded balanceMinor returns 0 on a clean initialization

### Rule AC4: Ledger funding flow admin ledger credited before wallet

### Rule AC5: Failed transaction retry available
- **Evidence**: Admin failed transaction list has working Retry button on FAILED disbursement or payout record list view

### Rule AC6: Loan repayment Flutterwave checkout
- **Evidence**: Borrower clicks Repay → redirects flutterwave payment initialized with loan amount

### Rule AC7: Investment maturity auto payout
- **Evidence**: runInvestmentMaturitySweep() credit investors wallet after date passed date

### Rule AC8: Bank account resolve name
- **Evidence**: resolveBankAccount() called with Flutterwave resolves correctly updates account name

### Rule AC9: Account changes require admin approval
- **Evidence**: Subsequent disbursement changes update submitted creates PENDING_APPROVAL request in admin list

### Rubric AC10: Admin sidebar professional
- Scale 0-2:
  0: worse than before
  1: improved but basic icons missing
  2: professional modern with all proper spacing & icons

### Rubric AC11: Overall ledger flow standard structure
- Scale 0-2:
  0: flows flows correct order
  2: standard standard reconciliation structure for all 4 flows funding/disbursement/repayment/payout flows ordered
