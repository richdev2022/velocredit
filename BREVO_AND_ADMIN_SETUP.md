# Brevo and secure admin setup

## Brevo

Configure these values as **Apps Script Script Properties**, not Vite/frontend environment variables:

- `BREVO_API_KEY` = your Brevo API key
- `BREVO_BASE_URL` = `https://api.brevo.com`
- `BREVO_SENDER_EMAIL` = verified sender email, for example `noreply@quantigrate.com`
- `BREVO_SENDER_NAME` = `Velo Finance LTD`
- `BREVO_TIMEOUT_SECONDS` = `30` (informational; Apps Script request limits still apply)
- `VELO_ADMIN_EMAIL` = primary administrator email
- `VELO_ADMIN_PASSWORD` = primary administrator password (10+ characters)

The sender is `noreply@quantigrate.com` / `Velo Finance LTD` and must be verified in Brevo.

The integration uses Brevo `POST /v3/smtp/email` with the `api-key` request header. See the official Brevo API documentation: https://developers.brevo.com/docs/send-a-transactional-email

## Admin login

The admin portal now requires:

1. Administrator/loan-manager email
2. Password
3. Six-digit email OTP

OTP expires after 10 minutes and is limited to five attempts. Browser admin sessions are cleared after five minutes of inactivity.

Copy `Code.gs`, `SecurityOverrides.gs`, and `ZSecurityNotifications.gs` into the same Apps Script project before deploying. The security and notification files intentionally replace the legacy `doPost` dispatcher, so deploying only `Code.gs` will not support OTP login, secure resume, manager accounts, or notifications.

For the first administrator, run these functions once from the Apps Script editor:

```text
setAdminEmail('admin@example.com')
setAdminPassword('use-a-strong-password')
```

Do not put the production password or Brevo API key in Git.

## Loan managers

An administrator can open **Admin → Loan Managers**, enter the manager name and email, and create the account. The manager receives an account-created email containing a tokenized password setup link. The invitation expires after 24 hours and is single-use. After setting a password, the manager uses the same admin login screen and receives an OTP on every login.

Only administrators can create manager accounts or change loan configuration. Loan managers can access the loan application workflow and update application status.

## Admin password reset

Use **Forgot admin password?** on the admin login page. The reset code is sent only when the email is present in `adminEmails` or the `VELO_ADMIN_EMAIL` Script Property. After resetting, existing sessions should be signed out and the new password is used for subsequent logins.

## Applicant resume security

Resume accepts email or phone plus date of birth as the identifier, but no application details are returned at lookup time. A one-time code is sent to the email stored on the matching unfinished application. Only the correct OTP unlocks the saved application. An unfinished `DRAFT` / `IN_PROGRESS` application expires after 24 hours since its last save.

Unfinished `DRAFT` / `IN_PROGRESS` applications expire after 24 hours since the last saved update. Submitted and other terminal applications are not removed by this expiry process.
