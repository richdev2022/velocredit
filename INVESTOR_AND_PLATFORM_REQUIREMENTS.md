# Velo Finance Platform
## Investor, Borrower, KYC, Payments, Credit, and Backend Migration Requirements

**Document status:** Pre-implementation specification for approval  
**Scope:** Nigeria-only lending and investment platform  
**Current product:** React + TypeScript + Vite frontend with Google Apps Script, Google Sheets, and Google Drive  
**Target product:** React frontend with Node.js + Express backend and Neon PostgreSQL database

---

## 1. Purpose and understanding

Velo Finance currently operates primarily as a digital loan application product. The existing frontend supports personal and business loan applications, document collection, application drafts, loan calculations, agreement generation, and an Apps Script-powered admin workflow. The current backend stores operational data in Google Sheets and documents in Google Drive.

The requested product expands Velo into a role-based Nigerian fintech platform with three primary user categories:

1. **Investor** — signs up, completes identity and address verification, funds a wallet, selects investment plans, locks funds for a predefined tenure, tracks returns, and receives capital plus interest at maturity.
2. **Borrower** — the correct product term for “loaner”; applies for a loan, completes KYC, receives disbursement through Velo, repays, and views loan and credit history.
3. **Admin** — manages investors, borrowers, KYC decisions, loan applications, investment plans, wallets, repayments, payouts, fees, credit rules, and operational records.

The system must support automated verification and financial workflows while keeping all sensitive credentials and provider secrets on the backend. It must be designed for Nigeria, use Nigerian Naira (NGN) as the base currency, and maintain auditable records for regulated financial operations.

This document defines the intended scope, user journeys, architecture, data model, integrations, security requirements, operational rules, and implementation phases. It is not an authorization to begin implementation; implementation starts after approval and resolution of the decisions listed in Section 20.

---

## 2. Product principles and boundaries

### 2.1 Product principles

- **Nigeria first:** Nigerian phone numbers, NGN, BVN, NIN, Nigerian addresses, Nigerian banks, and Nigerian compliance requirements are the initial scope.
- **Server-authoritative money:** Wallet balances, investments, repayments, fees, and payouts are calculated and persisted by the backend. The browser must never be trusted to determine balances or transaction outcomes.
- **Provider callbacks are not automatically trusted:** Flutterwave, Prembly, and KUDI responses must be validated, recorded, made idempotent, and reconciled.
- **Every financial action is auditable:** State transitions, approvals, provider references, fees, and operator actions must be retained.
- **No premature disbursement:** A borrower or investor must not receive funds until required KYC, approval, account setup, and payment conditions have been satisfied.
- **Configurable operational policy:** Admin-configured investment plans, loan products, tenures, fees, credit rules, and limits must be stored in the database with effective dates and an audit trail.

### 2.2 Initial boundaries

- The base currency is NGN. Multi-currency wallets are out of scope for the first release.
- Nigeria is the only supported country and market for the first release.
- Borrower loan disbursement initially exposes **Velo** as the only available disbursement institution/product, as requested. The final bank-account transfer mechanism must be confirmed before production launch.
- Investments are internal Velo investment products, not a public securities marketplace.
- Provider API keys, webhook secrets, encryption keys, database credentials, and job credentials are backend-only secrets.
- The platform must not claim regulatory approval or legal compliance automatically; legal/compliance review is required before production use.

---

## 3. Roles and permissions

### 3.1 Investor

Investors can:

- Register, log in, log out, reset a password, and complete step-up verification where required.
- Complete and monitor KYC status.
- Submit BVN, NIN, proof of address, current passport photograph, signature, and supporting information.
- Request BVN/NIN OTP verification through SMS or WhatsApp where supported and permitted by the provider flow.
- View wallet balance, available balance, held balance, pending deposits, pending payouts, and transaction history.
- Fund a wallet through Flutterwave card/payment checkout or an approved bank-transfer flow.
- View available investment plans and their terms before committing.
- Select a plan, choose an amount, review expected maturity value, and confirm an investment.
- View active, maturing, matured, liquidated, cancelled, and failed investments.
- Configure and verify an investment payout account.
- Receive capital and interest at maturity through the configured investment payout account.
- Request early liquidity subject to plan rules, liquidity fees, gateway/provider fees, and approval controls.
- View statements, receipts, transaction references, notifications, and support/contact options.
- Update permitted profile and payout-account information, subject to re-verification requirements.

Investors cannot:

- Invest while required KYC is incomplete or failed.
- Spend locked investment funds as ordinary wallet balance.
- Change a settled transaction or provider reference.
- Withdraw more than the server-calculated available balance.

### 3.2 Borrower

“Borrower” is the preferred term for a customer who receives a loan.

Borrowers can:

- Register, log in, resume an application, and manage their account.
- Complete personal or business loan application details.
- Submit BVN and NIN information and complete automated verification, including OTP when required.
- Upload a current passport photograph, identity evidence, proof of address, signature, and other required loan documents.
- Configure or update a disbursement account, with Velo shown as the only available disbursement institution in the initial release.
- View application status, approved amount, fees, repayment schedule, outstanding balance, due dates, and loan documents.
- Repay through supported payment methods.
- View payment receipts, repayment history, late status, fees, and credit-history events.
- View the internally calculated credit score and understandable reasons or factors, subject to policy and privacy constraints.
- Update permitted settings and contact details.
- Receive account, KYC, repayment, due-date, and status notifications.

Borrowers cannot:

- Submit an application without required identity and contact information.
- Receive disbursement before approval, KYC clearance, and account checks.
- Mark a repayment as successful from the client; provider confirmation is required.

### 3.3 Admin

Admins can:

- View and search all investors, borrowers, users, KYC records, applications, loans, investments, wallets, transactions, repayments, payouts, and provider events.
- Review, approve, reject, suspend, or request more information for KYC records.
- Review, approve, reject, and update loan applications within permission boundaries.
- Create and manage investment plans, loan products, tenures, rates, limits, fees, liquidity rules, and credit-score policies.
- View investment records and maturity schedules.
- Approve or reject exceptional early-liquidity requests and manual payout actions.
- Initiate or retry supported payouts only with required authorization and audit logging.
- View reconciliation exceptions and resolve them without deleting financial history.
- Configure notification templates and provider settings that are safe to expose through the admin interface.
- Manage admin users, roles, permissions, session revocation, and MFA/OTP policy.
- Export operational reports with access controls and redaction where appropriate.

Admin access should be permission-based rather than one shared password. Recommended permissions include `users.read`, `kyc.review`, `loans.review`, `investments.manage`, `payments.reconcile`, `payouts.approve`, `reports.export`, and `settings.manage`.

---

## 4. Authentication and account lifecycle

### 4.1 Registration

Registration must collect, at minimum:

- Full legal name.
- Email address.
- Nigerian phone number.
- Password.
- Intended account type: Investor or Borrower.
- Consent to terms, privacy policy, identity verification, and electronic communications.

The backend must normalize email and phone values, prevent duplicate accounts, hash passwords with a modern password-hashing algorithm, and issue short-lived access tokens with refresh-token rotation or an equivalent secure session strategy.

### 4.2 Login and recovery

- Email/phone plus password login.
- OTP or MFA step-up for sensitive actions such as changing payout accounts, initiating early liquidity, or changing security settings.
- Password reset through a time-limited, single-use token.
- Session listing and revocation for users and admins.
- Rate limits and progressive delays for login, OTP, and password-reset attempts.
- No sensitive identity numbers or OTP values in logs.

### 4.3 Role handling

A user may have one or more role memberships, but the interface should make the active role clear. Authorization must be enforced by the backend on every protected request; hiding a frontend route is not authorization.

---

## 5. Investor onboarding and KYC

### 5.1 Required investor KYC data

The investor onboarding flow must support:

- Legal name and date of birth.
- Residential address, state, and LGA.
- Phone number and email.
- BVN.
- NIN.
- Current passport photograph.
- Proof of address.
- Electronic signature.
- Optional occupation/source-of-funds information if required by compliance policy.

### 5.2 KYC states

Each KYC case should have explicit states such as:

`NOT_STARTED`, `IN_PROGRESS`, `PENDING_VERIFICATION`, `ACTION_REQUIRED`, `VERIFIED`, `PARTIALLY_VERIFIED`, `REJECTED`, `EXPIRED`, and `SUSPENDED`.

The user must see what remains incomplete without exposing provider secrets or unnecessary provider payloads. Admins must see provider references, verification timestamps, failure reasons, and the evidence used for the decision.

### 5.3 BVN and NIN verification

- Use Prembly APIs from the backend only.
- Submit the minimum data required by the selected Prembly verification product.
- Store a provider request ID, result status, timestamps, normalized match fields, and a redacted raw response where justified.
- Support OTP challenge creation and verification if Prembly requires it for the selected BVN/NIN flow.
- Permit SMS delivery through KUDI SMS where the selected provider workflow requires an application-generated OTP.
- Offer WhatsApp delivery only if a confirmed KUDI or approved messaging provider API supports it for the exact flow and has been configured and approved.
- Never assume that a number is WhatsApp-enabled without a provider-confirmed result.
- Do not store plaintext OTP values after verification. Store a hash or provider challenge reference and an expiry time.
- Do not use BVN or NIN as a password, public identifier, URL parameter, or client-side log value.

### 5.4 Documents and signature

- Accept current passport photograph, proof-of-address document, and signature in approved file formats.
- Validate file type, size, and content at the API boundary.
- Store documents in private object storage or an equivalent protected store, not publicly readable URLs.
- Use short-lived signed URLs for authorized viewing.
- Scan uploads for malware where possible.
- Preserve document version, upload time, verification status, reviewer, and rejection reason.
- Require re-verification when an identity or payout-account change is material.

### 5.5 Proof of address

The product must define accepted Nigerian documents, age limits, and matching rules. Examples may include a recent utility bill, bank statement, tenancy evidence, or other compliance-approved document. Exact accepted documents are a compliance decision and must be configurable or documented before implementation.

---

## 6. Borrower loan onboarding and verification

The existing personal and business loan wizard should be retained and migrated from Apps Script to the new API. It must gain the same core identity-verification controls as investor onboarding.

### 6.1 Borrower verification requirements

- BVN and NIN capture and automated verification through Prembly.
- OTP challenge and verification when required by the provider flow.
- Current passport photograph, proof of address, signature, and required loan documents.
- De-duplication checks so one identity cannot create unauthorized duplicate borrower accounts.
- Verification results attached to the borrower/KYC case and relevant loan application.
- Clear blocking states when verification fails or requires manual review.

### 6.2 Loan application lifecycle

Recommended states:

`DRAFT`, `IN_PROGRESS`, `SUBMITTED`, `KYC_PENDING`, `UNDER_REVIEW`, `MORE_INFORMATION_REQUIRED`, `APPROVED`, `REJECTED`, `DISBURSEMENT_PENDING`, `DISBURSED`, `ACTIVE`, `PAST_DUE`, `DEFAULTED`, `REPAID`, `CANCELLED`, and `WRITTEN_OFF`.

State transitions must be explicit, permission-controlled, auditable, and idempotent.

### 6.3 Borrower dashboard

The borrower dashboard should include:

- Application summary and current status.
- Active loan summary.
- Principal, interest, fees, total repayment, amount paid, outstanding amount, and next due date.
- Repayment schedule and payment history.
- KYC checklist and verification status.
- Credit score and major factors, when policy allows disclosure.
- Disbursement-account settings, initially showing Velo as the only available option.
- Profile, password, notification, and consent settings.
- Downloadable agreement, statements, and receipts.
- Support and issue-reporting entry points.

---

## 7. Investor wallet and Flutterwave funding

### 7.1 Wallet model

Each investor should have a server-side NGN wallet with at least:

- Available balance.
- Held/locked balance.
- Pending balance.
- Total credited.
- Total debited.
- Ledger transaction history.

A double-entry or ledger-first design is strongly recommended. The displayed balance should be derived from immutable ledger entries or maintained through transactional database updates with reconciliation safeguards.

### 7.2 Card and checkout funding

Flutterwave should be integrated from the backend using the official API flow selected for the account and Nigeria use case.

Expected flow:

1. Investor starts a funding request with an amount.
2. Backend creates a pending wallet funding transaction with a unique internal reference.
3. Backend initializes Flutterwave checkout/payment.
4. Frontend completes the hosted or approved Flutterwave payment experience.
5. Flutterwave redirects the user and/or sends a webhook.
6. Backend verifies the transaction server-to-server using the provider reference and expected amount/currency/customer.
7. Backend credits the wallet once, inside a database transaction.
8. Investor sees a receipt and updated balance.

The redirect result alone must never credit the wallet. Duplicate webhooks, retries, delayed webhooks, and mismatched amounts must be handled safely.

### 7.3 Bank transfer funding

The requirements mention funding by transfer. The exact Flutterwave product must be selected during implementation, such as a virtual-account/dedicated-account flow or another supported Nigerian collection method.

The eventual flow must:

- Create or associate a unique transfer reference/account where supported.
- Identify the investor and pending funding transaction.
- Accept provider webhook notification.
- Verify the provider event and amount.
- Credit exactly once.
- Handle underpayments, overpayments, unknown deposits, reversals, and manual reconciliation.

### 7.4 Fees and reversals

Flutterwave gateway fees must be represented separately from investment liquidity fees and platform fees. The system must define who bears each fee and display it before confirmation. A provider reversal must create a compensating ledger entry; it must not delete or mutate the original credit.

---

## 8. Investment plans and investment lifecycle

### 8.1 Admin-managed plan configuration

Admins must be able to define:

- Plan name and description.
- Minimum and maximum investment amount.
- Currency.
- Tenure and exact maturity calculation rule.
- Interest or return rate and whether it is flat, percentage-based, annualized, or tenure-specific.
- Early-liquidity eligibility.
- Liquidity fee rule.
- Gateway/provider fee rule.
- Tax or withholding treatment if applicable.
- Capacity or total plan limit, if applicable.
- Start date, end date, active status, and version.
- Whether new investments are allowed after a plan is closed.

Published plan terms must be versioned. An existing investment must keep the terms that applied at confirmation even if the admin later changes the plan.

### 8.2 Investment creation

1. Investor selects an active plan.
2. Backend validates KYC, account status, amount, available wallet balance, plan availability, and any risk limits.
3. Frontend displays principal, expected return, maturity date, fees, and payout destination.
4. Investor confirms terms and authorizes locking funds.
5. Backend creates the investment and ledger entries in one transaction.
6. Funds move from available wallet balance to held/locked balance.
7. Investor receives a confirmation and investment reference.

### 8.3 Investment states

Recommended states:

`PENDING`, `ACTIVE`, `LIQUIDITY_REQUESTED`, `LIQUIDITY_APPROVED`, `MATURITY_PENDING`, `MATURED`, `PAYOUT_PENDING`, `PAID_OUT`, `CANCELLED`, `REJECTED`, and `PAYOUT_FAILED`.

### 8.4 Early liquidity

If an investor withdraws before maturity:

- The backend calculates eligible principal, accrued/contractual interest treatment, liquidity fee, gateway/provider fee, and net payout.
- The investor must see the full breakdown and confirm.
- The system may require additional OTP/MFA and/or admin approval depending on policy.
- Locked balance is released only when the liquidity decision is committed.
- Capital and applicable interest are credited to the configured investment payout account, not blindly to an unverified destination.
- Failed payout remains traceable and retryable without duplicating funds.

The exact early-liquidity formula is a product decision. The system should not infer whether interest is forfeited, prorated, or retained until approved terms are provided.

---

## 9. Payout accounts and maturity payouts

### 9.1 Payout-account setup

Investors must set up an investment payout account before maturity payout or early liquidity. Required fields should include:

- Bank name and bank code.
- Account number.
- Account name returned by account-name enquiry where available.
- Verification status and verification timestamp.
- User confirmation and change history.

Changing a payout account should trigger step-up authentication, a cooling-off period or manual review where appropriate, and notifications to the existing contact channels.

### 9.2 Flutterwave payout workflow

At maturity, a scheduled backend worker must:

1. Find investments whose maturity time has passed and whose terms permit payout.
2. Confirm the investment has not already been paid, cancelled, or placed on hold.
3. Calculate principal, interest, fees, taxes, and net amount using the stored plan version.
4. Create a payout instruction and an idempotency key.
5. Submit the payout through the approved Flutterwave transfer/payout API.
6. Store the provider transfer reference and initial status.
7. Process asynchronous webhook status updates.
8. Mark the investment paid only after a verified successful provider status.
9. Add the corresponding wallet/ledger settlement entries and notify the investor.

The phrase “auto debit our Flutterwave account” must be implemented as an approved provider payout/transfer operation using the relevant Flutterwave product, not as an unsupported direct debit assumption. Account balance, limits, fees, beneficiary validation, and provider settlement timing must be confirmed against the active Flutterwave account and documentation.

### 9.3 Payout failure and reconciliation

- Payout failures must not silently retry without a bounded policy.
- Retries require the same logical payout idempotency key or a controlled replacement process.
- Admins must see provider response, retry count, last attempt, and next action.
- Payouts and provider events must be reconciled periodically against provider reports where available.

---

## 10. Loan disbursement and repayment

### 10.1 Disbursement account

For the initial borrower release:

- The borrower dashboard must show Velo as the only available disbursement institution/product.
- The UI may collect the required destination details, but no alternative banks should be presented until that product decision changes.
- Account ownership and KYC matching rules must be defined before real disbursements.

### 10.2 Loan disbursement

A disbursement must require:

- Approved loan.
- Completed required KYC.
- Valid signed agreement.
- Verified disbursement account.
- Sufficient operational/provider balance.
- No active fraud, sanctions, or account hold.

The disbursement instruction must have an internal reference, provider reference, amount, fees, status, and audit trail. A callback or verified provider response must control final status.

### 10.3 Repayments

Borrowers must be able to repay through supported Flutterwave collection methods. Each repayment must record:

- Loan and borrower IDs.
- Internal payment reference.
- Provider transaction/reference.
- Amount and currency.
- Principal, interest, late fee, and other fee allocation.
- Payment channel.
- Initiated, verified, settled, failed, reversed, or disputed status.
- Timestamps and reconciliation information.

Repayment processing must be idempotent. Duplicate provider notifications must not create duplicate credits. The loan balance and repayment schedule must be updated in a database transaction.

### 10.4 Late repayment handling

The system must calculate late status based on configured due dates and grace periods. Admin-configured rules should define:

- Grace period.
- Late fee formula.
- Whether late fees compound or remain one-time.
- Notification schedule.
- Escalation and collections status.
- When a loan becomes defaulted or written off.

---

## 11. Credit scoring and Prembly credit-bureau integration

### 11.1 Internal credit score

Velo should maintain an internal score based on approved policy inputs, such as:

- Repayment timeliness.
- Percentage of instalments paid on time.
- Days past due and frequency of late payments.
- Previous completed loans and repayment outcomes.
- Current outstanding obligations.
- Application consistency and verified income/financial information.
- KYC and identity-verification status.
- Credit-bureau result where lawfully available.
- Fraud, dispute, or chargeback indicators.

The score must be versioned. Every score result should record the rules/model version, input snapshot or feature references, calculation time, decision band, and reason codes.

### 11.2 Repayment-to-credit-history automation

When a repayment is verified and settled:

1. Record the immutable payment event.
2. Allocate the payment to the loan schedule.
3. Recalculate outstanding balance and delinquency status.
4. Update the borrower’s internal credit-history events.
5. Recalculate the internal credit score using the active version.
6. Trigger any required credit-bureau reporting workflow.
7. Notify the borrower where appropriate.

Reversals, chargebacks, corrections, and manual adjustments must create compensating events and recalculate affected history rather than overwriting the original record.

### 11.3 Prembly credit-bureau reporting

The exact Prembly credit-bureau product, bureau coverage, consent requirements, report fields, pricing, and reporting obligations must be confirmed. The integration should support:

- Explicit borrower consent and consent timestamp.
- Credit report request and provider reference.
- Redacted report storage or normalized fields as legally permitted.
- Report status, expiry, and retrieval audit.
- Error and manual-review handling.
- Dispute/correction workflow for inaccurate borrower information.

No score should be marketed as an official bureau score unless that is exactly what the provider and legal framework permit.

---

## 12. KUDI SMS and WhatsApp notifications

### 12.1 Notification channels

The notification service should support:

- KUDI SMS for OTP, KYC status, payment confirmation, due-date reminders, maturity, and payout notifications.
- WhatsApp OTP only if the configured provider/account supports the approved use case.
- Email for receipts, statements, account alerts, and longer notices.
- In-app notifications for dashboard events.

### 12.2 KUDI SMS integration

KUDI SMS is the proposed SMS provider for Nigerian phone notifications and OTP delivery.

- Documentation: [KUDI SMS API documentation](https://www.kudisms.net/docs/)
- Integrate KUDI from the Node/Express backend only.
- Keep the KUDI API key, sender ID, callback credentials, and other provider secrets in backend environment configuration.
- Create a provider adapter that supports message submission, provider response parsing, delivery status where available, timeout handling, retry policy, and message ID storage.
- Confirm the approved sender ID, Nigerian route availability, delivery-report mechanism, rate limits, pricing, and whether KUDI supports the required OTP use case before production activation.
- Store only the minimum notification metadata needed for auditing: recipient hash/masked number, template/version, provider message ID, status, timestamps, and related entity.
- Do not place BVN, NIN, full account numbers, passwords, or sensitive financial data in SMS content.

### 12.3 Direct Meta WhatsApp Cloud API integration

WhatsApp should be integrated directly through Meta’s WhatsApp Business Platform / Cloud API, not through KUDI, when the user explicitly chooses WhatsApp and the account is eligible for the requested message type.

- Documentation: [Meta WhatsApp Cloud API documentation](https://developers.facebook.com/docs/whatsapp/cloud-api/)
- Use a Meta app, WhatsApp Business Account, business phone number, permanent/system-user access token, and webhook configuration managed by the backend team.
- Keep the Meta access token, app secret, verify token, phone-number ID, business-account ID, and webhook secrets outside the frontend and source repository.
- Use approved WhatsApp message templates for business-initiated OTP, authentication, repayment, KYC, maturity, and payout notifications. Template category, language, variables, and approval status must be configured in Meta before production use.
- Implement Meta webhook verification during setup and validate webhook authenticity according to Meta’s current signature requirements.
- Persist Meta message IDs, delivery/read/failed events, error codes, timestamps, template name/version, and related internal notification ID.
- Treat a WhatsApp send request as pending until the provider result or webhook confirms its state. Do not treat an HTTP acceptance response alone as delivered.
- Apply Meta’s messaging-window, template, consent, opt-in, quality, rate, and user-blocking rules. Do not send unsolicited WhatsApp messages.
- Do not assume a phone number is WhatsApp-enabled. Use provider response/status to determine whether delivery is possible.
- For OTP, use a short-lived, single-use challenge owned by Velo or the approved Meta authentication-template flow. Never log or persist plaintext OTP values.

The notification service should expose a common internal interface such as `sendSms`, `sendWhatsAppTemplate`, `sendEmail`, and `createInAppNotification`, while keeping KUDI and Meta payload formats inside their provider adapters. WhatsApp must not be treated as a fallback automatically unless the user explicitly requests it, the user has opted in, and Meta confirms delivery capability.

### 12.4 Notification architecture

Notifications should be queued rather than sent synchronously inside a financial transaction. Each notification must include a template/version, recipient, channel, related entity, provider message ID, status, retry count, and timestamps.

OTP messages must:

- Expire quickly.
- Be single-use.
- Have attempt limits.
- Be rate limited per user, phone, IP, and action.
- Avoid including full BVN, NIN, account numbers, or sensitive financial details.

---

## 13. Proposed technical architecture

### 13.1 Frontend

Keep the existing React + TypeScript + Vite + Tailwind stack and add:

- Authenticated application shell.
- Investor dashboard and onboarding routes.
- Borrower account/dashboard routes.
- Admin dashboard routes with permission-aware navigation.
- API client with typed responses, auth/session handling, and consistent error states.
- Upload flow using backend-issued upload permissions or signed URLs.
- Payment redirect/checkout return pages that display status but do not settle transactions directly.

### 13.2 Backend

Create a separate Node.js + Express application, preferably TypeScript, with modules for:

- Auth and role-based access control.
- Users and profiles.
- KYC and documents.
- BVN/NIN verification.
- Borrower applications and loans.
- Investment plans and investments.
- Wallets and ledger transactions.
- Flutterwave collections, transfers, webhooks, and reconciliation.
- Prembly verification and credit services.
- KUDI SMS/WhatsApp notifications.
- Admin operations and audit logs.
- Background jobs and scheduled maturity/repayment processes.

All provider integrations should be isolated behind service modules so provider-specific payloads do not leak throughout the domain logic.

### 13.3 Database

Use Neon PostgreSQL as the system of record. Use a migration tool and a typed database access layer/ORM. Database credentials remain backend-only.

Suggested high-level entities:

- `users`
- `roles`, `user_roles`, `permissions`, `role_permissions`
- `sessions`, `refresh_tokens`, `otp_challenges`
- `investor_profiles`, `borrower_profiles`, `admin_profiles`
- `kyc_cases`, `kyc_verifications`, `identity_verification_events`
- `documents`, `document_versions`
- `addresses`, `payout_accounts`, `bank_account_verifications`
- `loan_products`, `loan_applications`, `loans`, `loan_schedules`
- `investment_plans`, `investment_plan_versions`, `investments`
- `wallets`, `ledger_accounts`, `ledger_entries`, `wallet_transactions`
- `payment_intents`, `payments`, `payment_events`, `provider_webhook_events`
- `disbursements`, `payouts`, `beneficiaries`
- `repayments`, `repayment_allocations`, `credit_history_events`
- `credit_scores`, `credit_score_versions`, `credit_reports`, `consents`
- `notifications`, `notification_deliveries`
- `admin_actions`, `audit_logs`, `reconciliation_items`
- `system_settings`, `fee_rules`, `job_runs`

Financial amounts should use integer minor units where appropriate or PostgreSQL `numeric` with strict currency handling. Never use JavaScript floating-point arithmetic for money settlement.

### 13.4 Background processing

Use a durable job mechanism suitable for the deployment environment. Jobs should cover:

- Investment maturity detection.
- Payout initiation and status polling/retry.
- Due-date and late-payment notifications.
- Credit-score recalculation.
- Provider webhook reconciliation.
- KYC/document expiry checks.
- Report generation.

Every job needs idempotency, retry policy, dead-letter/manual-review visibility, and execution logging.

---

## 14. API surface (initial proposal)

The exact routes may change during implementation, but the API should be organized around authenticated resources rather than the current Apps Script `action` dispatcher.

### Authentication

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/password-reset/request`
- `POST /api/v1/auth/password-reset/confirm`
- `POST /api/v1/auth/otp/request`
- `POST /api/v1/auth/otp/verify`

### User and KYC

- `GET /api/v1/me`
- `PATCH /api/v1/me`
- `GET /api/v1/me/kyc`
- `POST /api/v1/me/kyc`
- `POST /api/v1/me/kyc/bvn/verify`
- `POST /api/v1/me/kyc/nin/verify`
- `POST /api/v1/me/kyc/documents`
- `POST /api/v1/me/payout-accounts`
- `POST /api/v1/me/payout-accounts/:id/verify`

### Investor

- `GET /api/v1/investor/dashboard`
- `GET /api/v1/investor/wallet`
- `POST /api/v1/investor/wallet/funding`
- `GET /api/v1/investor/investment-plans`
- `POST /api/v1/investor/investments`
- `GET /api/v1/investor/investments`
- `POST /api/v1/investor/investments/:id/liquidity`
- `GET /api/v1/investor/transactions`

### Borrower

- `GET /api/v1/borrower/dashboard`
- `POST /api/v1/borrower/applications`
- `PATCH /api/v1/borrower/applications/:id`
- `POST /api/v1/borrower/applications/:id/submit`
- `GET /api/v1/borrower/loans`
- `GET /api/v1/borrower/loans/:id`
- `POST /api/v1/borrower/loans/:id/repayments`
- `GET /api/v1/borrower/credit-history`

### Admin

- `GET /api/v1/admin/users`
- `GET /api/v1/admin/kyc-cases`
- `POST /api/v1/admin/kyc-cases/:id/decision`
- `GET /api/v1/admin/loans`
- `POST /api/v1/admin/loans/:id/decision`
- `GET /api/v1/admin/investments`
- `POST /api/v1/admin/investment-plans`
- `PATCH /api/v1/admin/investment-plans/:id`
- `GET /api/v1/admin/reconciliation`
- `POST /api/v1/admin/payouts/:id/retry`
- `GET /api/v1/admin/reports`

### Webhooks

- `POST /api/v1/webhooks/flutterwave`
- `POST /api/v1/webhooks/prembly`
- `POST /api/v1/webhooks/kudi`

Webhook endpoints must authenticate provider signatures/secrets according to the provider’s supported mechanism, persist the event before processing, and return quickly after safe acceptance.

---

## 15. Security, privacy, and compliance requirements

- Use HTTPS in all non-local environments.
- Store provider secrets in deployment secrets management, never in `VITE_*` variables.
- Hash passwords with Argon2id or an approved equivalent.
- Encrypt sensitive data at rest where practical, especially identity numbers and provider payloads.
- Mask BVN, NIN, account numbers, and tokens in UI, logs, error reports, and analytics.
- Apply strict server-side authorization and object-level access checks.
- Validate and sanitize all user input and uploaded files.
- Use CSRF protection if cookie-based authentication is used; otherwise use a carefully designed token strategy.
- Apply CORS allowlisting, security headers, request size limits, rate limits, and abuse monitoring.
- Use idempotency keys for funding, investment creation, repayment, disbursement, and payout operations.
- Maintain immutable or append-only audit records for financial state changes and admin decisions.
- Define retention, deletion, export, correction, and consent policies for personal data.
- Obtain legal/compliance review for NDPR, CBN-related obligations, AML/KYC, lending, credit reporting, consumer disclosures, investment products, taxes, and provider contracts before production.

---

## 16. Migration from Google Apps Script and Google Sheets

### 16.1 What changes

The current frontend uses `src/services/googleAppsScript.ts` and `src/services/adminApi.ts` to send an `action` plus payload to a Google Apps Script web app. The new frontend will call typed REST API endpoints on the Node/Express backend.

Google Sheets becomes a migration source or export/reporting destination, not the primary operational database. Google Drive document links must be migrated or replaced with protected object storage and signed access.

### 16.2 Migration strategy

1. Inventory all existing spreadsheet columns, Apps Script actions, statuses, admin settings, and document references.
2. Design PostgreSQL schema and status mappings.
3. Build an import script with dry-run mode, row-level validation, duplicate detection, and an import report.
4. Import users/applications/loan data and preserve original IDs as external references.
5. Migrate or securely relink existing documents.
6. Run parallel read-only reconciliation against Sheets before cutover.
7. Freeze or clearly limit writes to the old Apps Script during cutover.
8. Switch frontend API configuration to the Express backend.
9. Keep a rollback/export plan and preserve the original source data.
10. Retire Apps Script write paths only after financial and record reconciliation is signed off.

### 16.3 Existing functionality to preserve

- Personal and business loan applications.
- Save and resume behavior.
- Loan calculations and configurable fees.
- Agreement generation/download.
- Document collection.
- Admin application list, detail, statistics, status updates, and loan configuration.

Existing local-storage draft behavior should be reviewed for privacy. Sensitive applicant data should not remain indefinitely in browser storage.

---

## 17. Admin reporting and operational controls

The admin area should provide:

- Investor and borrower counts by status.
- KYC pending/action-required/verified counts.
- Wallet funding totals and exceptions.
- Active investment principal, expected returns, upcoming maturities, and payout failures.
- Loan applications by status, disbursed principal, outstanding principal, repayment totals, delinquency, and defaults.
- Provider transaction success/failure/reversal rates.
- Reconciliation queue.
- Credit-score distribution and decision outcomes.
- Audit log search and export.

Reports must define timezone, date range semantics, currency, inclusion of pending/failed transactions, and whether amounts are gross or net of fees.

---

## 18. Testing and acceptance criteria

### 18.1 Automated tests

- Unit tests for fee, interest, maturity, liquidity, repayment allocation, late-fee, and credit-score calculations.
- API tests for authorization, validation, idempotency, and state transitions.
- Integration tests using provider sandboxes or mocks for Flutterwave, Prembly, and KUDI.
- Database migration and rollback checks.
- Webhook signature, duplicate-event, out-of-order-event, and retry tests.
- Security tests for object-level authorization and sensitive-data leakage.

### 18.2 End-to-end acceptance scenarios

At minimum, test:

1. Investor registration through verified KYC.
2. Failed BVN/NIN match and action-required recovery.
3. Investor funding by card and duplicate webhook delivery.
4. Investor funding by transfer and unknown/underpaid deposit.
5. Investment creation with insufficient balance.
6. Investment maturity and successful payout.
7. Failed payout and safe retry.
8. Early liquidity with a complete fee breakdown.
9. Borrower application, verification, approval, disbursement, repayment, and receipt.
10. Late repayment, fee application, and credit-history update.
11. Reversed repayment and compensating ledger entries.
12. Admin permission boundaries and audit trail.
13. Session revocation, password reset, and OTP rate limiting.
14. Migration of existing Apps Script records and documents.

### 18.3 UI acceptance

The implemented UI must be tested in the live preview for:

- Investor onboarding and dashboard golden path.
- Borrower dashboard and repayment path.
- Admin review and plan-management path.
- Mobile layout and Nigerian Naira formatting.
- Loading, pending, failure, retry, empty, and action-required states.

---

## 19. Suggested phased delivery

### Phase 0 — Confirmation and compliance discovery

- Approve this requirements document.
- Confirm legal/compliance requirements and provider accounts.
- Confirm exact Flutterwave collection, transfer, payout, and webhook products.
- Confirm Prembly BVN/NIN and credit-bureau products.
- Confirm KUDI SMS and WhatsApp capabilities.
- Confirm document storage and deployment environments.

### Phase 1 — Backend foundation and migration

- Create Node/Express TypeScript service.
- Configure Neon PostgreSQL migrations.
- Implement auth, roles, users, audit logging, and API error conventions.
- Import existing loan applications and admin configuration.
- Replace basic borrower Apps Script calls with backend APIs.

### Phase 2 — Borrower account and loan operations

- Borrower authentication and dashboard.
- KYC/document workflows.
- Prembly identity verification.
- Loan application, approval, disbursement, repayment, and credit-history records.
- Flutterwave repayment integration.

### Phase 3 — Investor product

- Investor onboarding and KYC.
- Wallet ledger and Flutterwave funding.
- Admin investment plans.
- Investment creation and statements.
- Payout-account setup.

### Phase 4 — Automation and credit

- Maturity worker and Flutterwave payouts.
- Early-liquidity workflow.
- KUDI SMS/email/in-app notifications.
- Internal credit scoring.
- Prembly credit-bureau integration and consent/reporting workflow.

### Phase 5 — Hardening and launch readiness

- Reconciliation tooling.
- Security, load, failure-recovery, and data-retention review.
- Production monitoring and alerting.
- Migration reconciliation and cutover.
- Compliance/legal sign-off and operational runbooks.

---

## 20. Decisions required before implementation

The following items are intentionally not guessed and require confirmation:

1. **Flutterwave products:** Which exact Nigerian products should be used for card checkout, bank transfer funding, borrower repayment, bank-account verification, and payouts/transfers?
2. **Flutterwave account:** Is the business account fully enabled for collections and transfers, and which webhook/signature mechanism is configured?
3. **Investment economics:** What are the available plans, minimum/maximum amounts, rates, tenure units, maturity calculation, and whether returns are simple, fixed, or prorated?
4. **Early liquidity:** Is interest forfeited, prorated, or retained? Who pays liquidity and gateway fees? Is admin approval required?
5. **Payout timing:** Should maturity payout occur immediately after maturity, on a business-day schedule, or after manual review?
6. **Prembly products:** Which BVN/NIN verification endpoints and OTP flow are enabled? Which credit-bureau product and bureau(s) should be used?
7. **OTP delivery:** Confirm the KUDI SMS account, sender ID, delivery reports, and OTP limits. Confirm the Meta WhatsApp Business Account, Cloud API phone-number ID, approved authentication templates, opt-in process, webhook setup, and whether direct Meta delivery is available for the Nigerian numbers in scope.
8. **KYC policy:** Which proof-of-address documents, document age limits, name/address matching rules, and re-verification rules apply?
9. **Disbursement model:** What exactly does “Velo as the only available bank” mean technically—an internal Velo account, a fixed payout route, or a branded bank partner?
10. **Loan rules:** What are the authoritative loan products, rates, fees, tenures, grace periods, late fees, and write-off rules?
11. **Credit scoring:** What score range, score bands, approval thresholds, weights, and borrower-facing explanations should be used?
12. **Roles:** Which staff roles besides Admin are required, such as KYC reviewer, loan officer, finance officer, support agent, or super admin?
13. **Storage:** Should documents use S3-compatible storage, Cloudinary, Supabase Storage, or another private object-storage provider?
14. **Deployment:** Where should the Express API, worker, database, and frontend be deployed, and what monitoring provider is preferred?
15. **Existing data:** How many Google Sheet applications and Drive documents must be migrated, and are there known duplicate or incomplete records?
16. **Compliance:** Who will approve NDPR, AML/KYC, lending, credit reporting, investment, tax, consumer-disclosure, and record-retention requirements?
17. **Business timezone and calendar:** Should all maturity and due-date calculations use Africa/Lagos time and calendar days or business days?
18. **Terms and consent:** What legal terms, privacy notice, investment agreement, loan agreement, electronic-signature wording, and consent records are required?

---

## 21. Approval gate

Implementation should begin only after this document is approved and the decisions in Section 20 are either answered or explicitly deferred with an agreed temporary rule. Once approved, the first implementation deliverable should be the backend foundation, database schema/migrations, provider configuration contract, and a migration plan—not direct production payment or payout activation.

**Reference documentation supplied for implementation:**

- [Flutterwave API documentation](https://developer.flutterwave.com/docs/introduction)
- [Prembly API documentation](https://docs.prembly.com/reference/introduction)
- [KUDI SMS API documentation](https://www.kudisms.net/docs/)
- [Meta WhatsApp Cloud API documentation](https://developers.facebook.com/docs/whatsapp/cloud-api/)
