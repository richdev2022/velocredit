# Velo Finance LTD — Loan Application Web Application

A complete, production-ready **multi-step Loan Application** for **Velo Finance LTD** built with **React + TypeScript + Vite + Tailwind CSS**, with **Google Apps Script** as the backend (Google Sheets + Google Drive).

- Personal loans and Business loans
- Save & resume functionality (local + cloud)
- Configurable loan amounts, fees, interest, tenures — all via `.env`
- Dynamic fee calculations (flat or percentage)
- Automatically generated, pre-filled Loan Agreement (downloadable PDF)
- Document uploads to Google Drive (per-applicant folder)
- Application records in Google Sheets
- **Admin dashboard** to review applications, view documents, and update statuses
- Modern, professional, mobile-first fintech UI

---

## Table of Contents

1. [Quick Start (Local Development)](#1-quick-start-local-development)
2. [Environment Configuration](#2-environment-configuration)
3. [Backend Deployment — Google Apps Script](#3-backend-deployment--google-apps-script)
4. [Frontend Deployment — User Site](#4-frontend-deployment--user-site)
5. [Admin Dashboard](#5-admin-dashboard)
6. [Application Flow](#6-application-flow)
7. [Fee Calculation](#7-fee-calculation)
8. [Agreement Generator](#8-agreement-generator)
9. [Project Structure](#9-project-structure)
10. [Security](#10-security)
11. [Customising](#11-customising)
12. [Troubleshooting](#12-troubleshooting)
13. [License & Disclaimer](#13-license--disclaimer)

---

## 1. Quick Start (Local Development)

### Prerequisites

- **Node.js 18+** and **npm** (download from <https://nodejs.org/>)
- A **Google account** (Gmail or Google Workspace) for the backend
- Optional: a code editor like VS Code

### Steps

```bash
# 1. Unzip the project
unzip velo-finance-loan-app.zip
cd velo-finance-loan-app

# 2. Install dependencies
npm install

# 3. Copy the example env and configure
cp .env.example .env
# (edit .env — see section 2)

# 4. Run the web and API dev servers
npm run dev
```

Open <http://localhost:5173/> in your browser.

The development command starts Vite on port 5173 and the Express API on port 4000. The API creates any missing PostgreSQL tables from `backend/database/001_initial_schema.sql` before it begins listening. To run either process separately, use `npm run dev:web` or `npm run dev:api`.

To build for production:

```bash
npm run build     # outputs to ./dist/
npm run preview   # serves the production build locally
```

---

## 2. Environment Configuration

All configuration is read from `.env`. Copy `.env.example` to `.env` and edit it:

```env
# Google Apps Script Web App URL (deployed from Code.gs + SecurityOverrides.gs + ZSecurityNotifications.gs)
VITE_GOOGLE_SCRIPT_URL=YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL

# Loan amount limits (Naira)
VITE_LOAN_MIN_AMOUNT=100000
VITE_LOAN_MAX_AMOUNT=30000000
VITE_LOAN_DEFAULT_AMOUNT=3000000

# Available tenures (days, comma-separated)
VITE_LOAN_TENURES=30,60,90,180

# Fee configuration — each fee supports "flat" or "percentage"
#   flat        => fee = VITE_<NAME>_VALUE
#   percentage  => fee = loanAmount * VITE_<NAME>_VALUE / 100
VITE_INTEREST_TYPE=flat
VITE_INTEREST_VALUE=500000

VITE_SERVICE_FEE_TYPE=percentage
VITE_SERVICE_FEE_VALUE=2

VITE_PROCESSING_FEE_TYPE=flat
VITE_PROCESSING_FEE_VALUE=5000

VITE_LATE_FEE_TYPE=percentage
VITE_LATE_FEE_VALUE=5
# Set to "true" to include late fees in the initial repayment total
VITE_INCLUDE_LATE_FEE_UPFRONT=false

# Branding
VITE_COMPANY_NAME=Velo Finance LTD
VITE_COMPANY_WEBSITE=www.velofinance.co
```

> **Security note**: Only `VITE_*` variables are exposed to the browser. Never put Google service-account credentials, OAuth client secrets, or other backend secrets in `.env`. Those belong solely in the Google Apps Script project.

### Configuration validation

The application validates the configuration at startup. If anything is invalid (e.g. min > max, percentage out of range), a clear notice is shown on the home screen and the issue is logged to the console.

---

## 3. Backend Deployment — Google Apps Script

The backend is the combined Apps Script project made from [`Code.gs`](./backend/google-apps-script/Code.gs), [`SecurityOverrides.gs`](./backend/google-apps-script/SecurityOverrides.gs), and [`ZSecurityNotifications.gs`](./backend/google-apps-script/ZSecurityNotifications.gs). Copy all three files into the same Apps Script project. The overlay files provide OTP admin login, secure resume, manager accounts, Brevo notifications, and the final `doPost` dispatcher.

### 3.1 Create the Apps Script project

1. Open <https://script.google.com> → click **New Project**.
2. Delete the default `Code.gs` content.
3. Copy the complete contents of `Code.gs` into the Apps Script `Code.gs` file.
4. Create two additional script files named `SecurityOverrides.gs` and `ZSecurityNotifications.gs`, then copy each matching file from this repo into it.
5. Save all three files. The files intentionally define the final dispatcher in load order; do not deploy only `Code.gs`.

### 3.2 Configure the backend

Open the `CONFIG` block at the top of `Code.gs` and review/edit these values:

```javascript
const CONFIG = {
  // Parent Drive folder that will hold all applicant folders.
  // Leave blank to create a new folder in your root Drive named "Velo Loan Applications".
  DRIVE_PARENT_FOLDER_ID: "",

  // Spreadsheet that will hold the Loan Applications sheet.
  // Leave blank to create a new spreadsheet named "Velo Loan Applications".
  SPREADSHEET_ID: "",

  SHEET_NAME: "Loan Applications",
  DRIVE_PARENT_FOLDER_NAME: "Velo Loan Applications",
  SPREADSHEET_NAME: "Velo Loan Applications",

  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024,
  ALLOWED_MIME: ["application/pdf", "image/jpeg", "image/jpg", "image/png"],
  COMPANY_NAME: "Velo Finance LTD",

  // Leave the admin password empty. Store it in Script Properties with setAdminPassword().
  ADMIN_PASSWORD: "",
};
```

### 3.3 Run setup

1. In the Apps Script editor, select the `setup` function from the function dropdown at the top.
2. Click **Run**.
3. Authorize the script when prompted:
   - Click **Review permissions**
   - Choose your Google account
   - Click **Advanced** → **Go to Velo Loan API (unsafe)** → **Allow**
4. After execution finishes, open **View → Logs** (or Ctrl/Cmd + Enter). You should see:
   ```
   Setup complete.
   Spreadsheet URL: https://docs.google.com/spreadsheets/d/.../edit
   Sheet name:      Loan Applications
   Drive folder:    Velo Loan Applications
   Drive folder URL: https://drive.google.com/drive/folders/...
   ```
   > ⚠️ Save these URLs — you'll need the spreadsheet to view raw application data and the Drive folder to view uploaded documents.

### 3.4 (Recommended) Set a strong admin password

For production, store a strong password in `PropertiesService` (the source fallback is empty):

1. In the Apps Script editor, paste this in the editor and run it once:

   ```javascript
   function setAdminPassword() {
     setAdminPassword_("YOUR_STRONG_PASSWORD_HERE");
   }
   ```

2. Replace `YOUR_STRONG_PASSWORD_HERE` with your actual password (≥ 6 characters).
3. Run it. You should see "Admin password updated." in the logs.
4. Run `setAdminEmail('admin@example.com')` once as well, unless administrator addresses are managed in the Admin Settings screen.

### 3.5 Deploy as a Web App

1. Click **Deploy → New deployment** (top right).
2. Click the gear icon ⚙️ next to **Select type** → choose **Web app**.
3. Fill in:
   - **Description**: `Velo Loan API v1`
   - **Execute as**: `Me (your-email@gmail.com)`
   - **Who has access**: `Anyone`
4. Click **Deploy**.
5. Authorize again if prompted.
6. **Copy the Web App URL** that looks like:
   ```
   https://script.google.com/macros/s/AKfyc.../exec
   ```
7. Paste it into your `.env` file as `VITE_GOOGLE_SCRIPT_URL`.

### 3.6 Verify the deployment

Open the Web App URL in your browser. You should see:

```json
{
  "ok": true,
  "message": "Velo Finance LTD — Loan Application API is running.",
  "time": "2026-09-05T..."
}
```

If you see an error, check the Apps Script **Executions** log at <https://script.google.com/home/executions>.

### 3.7 Updating the backend later

If you edit `Code.gs` after deploying:

1. Click **Deploy → Manage deployments**.
2. Select the existing deployment.
3. Click the pencil (edit) icon.
4. Under **Version**, select **New version** (so changes take effect immediately).
5. Click **Deploy**.

> ⚠️ The Web App URL stays the same across versions, so you don't need to update `.env` after re-deploying.

### 3.8 Endpoints

The frontend sends `POST` requests with `Content-Type: text/plain` (to avoid CORS pre-flight on Apps Script). The JSON body has the shape `{ action, payload }`:

| Action                  | Payload                                                    | Auth        | Description                                                                                                                                |
| ----------------------- | ---------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `saveDraft`             | `ApplicationData`                                          | None        | Create or update the draft row in the Sheet. Returns `{ ok, applicationId, status }`.                                                      |
| `submit`                | `ApplicationData`                                          | None        | Promote draft → final ID, create Drive folder, upload docs, mark SUBMITTED. Returns `{ ok, applicationId, driveFolderUrl, documentUrls }`. |
| `lookup`                | `{ email, phone }`                                         | None        | Look up a draft by email and/or phone. Returns `{ ok, found, application? }`.                                                              |
| `adminLogin`            | `{ password }`                                             | None        | Returns `{ ok, token, expiresIn }`. Token is valid for 24 hours.                                                                           |
| `adminListApplications` | `{ adminToken, status?, type?, search?, limit?, offset? }` | Admin token | Returns `{ ok, total, applications[] }` with slim summaries.                                                                               |
| `adminGetApplication`   | `{ adminToken, applicationId }`                            | Admin token | Returns `{ ok, application }` with full detail including BVN/NIN + Drive URLs.                                                             |
| `adminUpdateStatus`     | `{ adminToken, applicationId, status }`                    | Admin token | Updates status. Returns `{ ok, status }`.                                                                                                  |
| `adminListStats`        | `{ adminToken }`                                           | Admin token | Returns `{ ok, counts, total, totalLoanAmount }`.                                                                                          |

Responses are returned as `ContentService.MimeType.JSON` (Apps Script renders these as `text/plain`).

### 3.9 Folder structure in Google Drive

```
Velo Loan Applications (parent folder)
├── VEL-LN-2026-000124 - John Doe
│   ├── identificationDocument.pdf
│   ├── proofOfAddress.jpg
│   └── signedAgreement.pdf
└── VEL-LN-2026-000125 - ABC Trading Ltd
    ├── identificationDocument.pdf
    ├── proofOfAddress.jpg
    └── signedAgreement.pdf
```

> **BVN/NIN are NEVER included in folder names, URLs, or file names.** They are stored in the Sheet row only.

### 3.10 Sheet columns

The Sheet's first row is a header (auto-created by `setup()`):

```
Application ID, Applicant Type, Application Status,
Date Created, Date Last Updated, Date Submitted,
Full Name, Date of Birth, Phone, Email,
Residential Address, State, LGA,
Business Name, Business Registration Number, Business Type,
Business Address, Business Industry, Years in Business,
Representative Name, Representative Position,
Representative Phone, Representative Email, Representative Address,
BVN, NIN, ID Type, ID Number,
Employment Status, Employer/Business Name, Monthly Income, Monthly Expenses,
Business Revenue, Business Expenses, Existing Loan Obligations, Expected Repayment Source,
Loan Amount, Loan Tenure, Loan Purpose,
Interest, Service Fee, Processing Fee, Other Fees, Total Fees, Total Repayment,
Disbursement Date, Repayment Date,
Google Drive Folder URL, ID Document URL, Proof of Address URL, Signed Agreement URL
```

---

## 4. Frontend Deployment — User Site

The frontend is a static Vite build. Deploy it anywhere that serves static files.

### 4.1 Build the production bundle

```bash
npm run build
```

This creates a `dist/` folder with the compiled HTML, CSS, and JS.

### 4.2 Option A — Vercel (recommended)

1. Push this repo to GitHub (or GitLab/Bitbucket).
2. Go to <https://vercel.com> → **Add New → Project**.
3. Import your repo.
4. Vercel auto-detects Vite. Configure:
   - **Framework Preset**: Vite
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
   - **Environment Variables**: Add each `VITE_*` variable from your `.env`.
5. Click **Deploy**.

Vercel will give you a URL like `https://velo-finance-loan.vercel.app/`. Any future push to your main branch automatically redeploys.

### 4.3 Option B — Netlify

1. Push this repo to GitHub.
2. Go to <https://app.netlify.com> → **Add new site → Import an existing project**.
3. Connect your repo. Configure:
   - **Build command**: `npm run build`
   - **Publish directory**: `dist`
   - **Environment variables**: Add each `VITE_*` variable from your `.env`.
4. Click **Deploy site**.

### 4.4 Option C — Cloudflare Pages

1. Push this repo to GitHub.
2. Go to <https://pages.cloudflare.com> → **Create a project → Connect to Git**.
3. Pick the repo. Configure:
   - **Framework preset**: Vite
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - **Environment variables**: Add each `VITE_*` variable from your `.env`.
4. Click **Save and Deploy**.

### 4.5 Option D — Static file hosting (any S3-compatible / Nginx)

1. Build locally: `npm run build`.
2. Upload the entire `dist/` folder to your host's web root.
3. Configure the host to serve `index.html` for any path (SPA fallback), so `/apply`, `/resume`, `/admin` etc. all resolve to `index.html`.

For example, with Nginx:

```nginx
server {
  listen 80;
  server_name loans.velofinance.co;
  root /var/www/velo-finance/dist;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

For Apache (`.htaccess` in the `dist/` folder):

```apache
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule . /index.html [L]
</IfModule>
```

### 4.6 Option E — GitHub Pages

GitHub Pages serves from a fixed path, so you need to set a base path in `vite.config.ts`:

```ts
export default defineConfig({
  plugins: [react()],
  base: "/your-repo-name/", // ← add this
  // ...
});
```

Then:

1. `npm run build`
2. Push the contents of `dist/` to the `gh-pages` branch of your repo (or use the `gh-pages` npm package).
3. Enable Pages in your repo settings → **Pages → Source: gh-pages branch / root**.

### 4.7 Update the backend's CORS / origin allow-list

Apps Script Web Apps accept requests from any origin by default — no additional CORS configuration is needed. If your organisation restricts outbound requests via the Apps Script project's allowed origins, add your deployed frontend URL there.

---

## 5. Admin Dashboard

The admin dashboard lives at `/admin` on the deployed frontend (e.g. `https://loans.velofinance.co/admin`).

### 5.1 Access

1. Open `https://your-frontend-url/admin` in your browser.
2. Enter the admin password (default: `velo-admin-2026`, or whatever you set with `setAdminPassword_("...")` — see section 3.4).
3. Click **Log In**.

### 5.2 Features

- **Stats overview**: total applications, plus counts by status (Submitted, Under Review, Approved, Disbursed).
- **Filterable list**: filter by status, applicant type, or free-text search (matches Application ID, applicant name, business name, email, or phone).
- **Detail view**: full applicant + KYC + financial + loan details, with one-click links to the Drive folder and each uploaded document.
- **Status updates**: change an application's status (DRAFT → IN_PROGRESS → SUBMITTED → UNDER_REVIEW → APPROVED / REJECTED → DISBURSED → REPAID).

### 5.3 Authentication

- The admin password is verified by the Apps Script backend. On success, the backend issues a **session token** (UUID) stored in `PropertiesService`.
- The token is valid for **24 hours** and is sent with every admin request.
- The token is stored in `sessionStorage` (cleared when the browser tab closes).
- For production hardening, consider:
  - Replacing the simple password with a Google Sign-In flow (more work, but no shared password).
  - Restricting the Apps Script Web App URL to specific IPs via a Cloudflare proxy in front of it.

### 5.4 How to use the dashboard

1. After login, the list view shows all applications (most recent first).
2. Use the search box to find by ID, name, email, or phone.
3. Use the dropdowns to filter by status or applicant type.
4. Click a row to open the detail view.
5. In the detail view, scroll to **Documents** and click any link to open the file in Google Drive (the Drive file's sharing is set to "Anyone with the link can view" when the admin user uploaded it via the script — this is intentional, since the admin user authorised the script).
6. To change the status, scroll to the top of the detail view, pick a new status from the dropdown, and click **Update Status**. The Sheet row is updated immediately and the status badge refreshes.

---

## 6. Application Flow

```
Start
  ↓
Choose Personal / Business
  ↓
Personal/Business Information
  ↓
KYC (BVN, NIN, ID document, proof of address)
  ↓
Financial Information
  ↓
Loan Request (amount + tenure)
  ↓
Live fee calculation
  ↓
Generate Loan Agreement (auto-filled)
  ↓
Download pre-filled PDF
  ↓
Sign agreement (offline) + upload signed copy
  ↓
Review
  ↓
Submit → Application ID generated → Drive folder created → docs uploaded → Sheet row updated → SUBMITTED
  ↓
Success page with Application ID
  ↓
Admin reviews → Under Review → Approved/Rejected → Disbursed → Repaid
```

### Save & Resume

- The application is **auto-saved** (debounced ~1.5s after the user stops typing) to localStorage.
- "Save & Continue", "Save & Exit", and "Save Progress" buttons trigger an explicit save to both localStorage and (if configured) the Google Apps Script backend.
- The Resume screen (`/resume`) accepts email + phone and looks up the draft locally first, then on the backend if configured.
- Application IDs follow `VEL-DRAFT-2026-000124` until submission; the backend promotes them to `VEL-LN-2026-000124` on submit.

---

## 7. Fee Calculation

The calculation engine lives in `src/utils/loanCalculator.ts`. It's pure (no React, no DOM):

```ts
import { calculateLoan } from "./utils/loanCalculator";
const calc = calculateLoan(3_000_000, 30);
// => {
//   loanAmount: 3_000_000,
//   interest: 500_000,
//   serviceFee: 60_000,        // 2% of 3M
//   processingFee: 5_000,
//   lateFee: 150_000,           // shown separately, not in totalRepayment
//   totalFees: 565_000,
//   totalRepayment: 3_565_000,
//   tenure: 30,
//   tenureLabel: "30 Days",
//   repaymentDate: "2026-10-05T00:00:00.000Z",
//   ...
// }
```

Late fees are kept separate by default — they are shown as "applies only on default" in the UI and excluded from `totalRepayment`. Set `VITE_INCLUDE_LATE_FEE_UPFRONT=true` in `.env` to include them in the initial repayment total.

---

## 8. Agreement Generator

The agreement is generated by `src/services/agreementGenerator.ts` using a placeholder-based template engine. The same engine works for both Personal and Business loans:

```ts
import { generateLoanAgreement } from "./services/agreementGenerator";
const { text, html } = generateLoanAgreement(applicationData, calculation);
```

The template uses `{{PLACEHOLDER}}` tokens (e.g. `{{APPLICANT_NAME}}`, `{{LOAN_AMOUNT}}`, `{{REPAYMENT_DATE}}`) that are replaced with the applicant's actual information. BVN/NIN are intentionally **masked** in the agreement (e.g. `*****123`).

The PDF is generated client-side with `jsPDF` (no external rendering service required) and downloaded with a deterministic filename:

```
VEL-LN-2026-000124-Loan-Agreement.pdf
```

> **Legal review**: The agreement template is a starting point. Have it reviewed and approved by an appropriate legal professional before production use.

---

## 9. Project Structure

```
.
├── backend/
│   ├── database/                       # PostgreSQL schema and seed migration
│   ├── google-apps-script/             # Optional Google Apps Script backend
│   └── server/                         # Express API, providers, routes, and stores
├── frontend/
│   ├── public/
│   ├── favicon.svg
│   └── logo.svg                       # Velo Finance logo
│   └── src/
│   ├── components/
│   │   ├── admin/
│   │   │   ├── AdminDetail.tsx
│   │   │   ├── AdminList.tsx
│   │   │   └── AdminLogin.tsx
│   │   ├── AgreementDownload.tsx
│   │   ├── AgreementPreview.tsx
│   │   ├── ApplicantTypeSelector.tsx
│   │   ├── ApplicationDashboard.tsx
│   │   ├── FeeBreakdown.tsx
│   │   ├── FileUpload.tsx
│   │   ├── FormInput.tsx
│   │   ├── Layout.tsx
│   │   ├── LoanAmountSelector.tsx
│   │   ├── LoanSummary.tsx
│   │   ├── Logo.tsx
│   │   ├── ProgressSteps.tsx
│   │   ├── ReviewApplication.tsx
│   │   ├── SaveProgress.tsx
│   │   ├── SectionShell.tsx
│   │   └── SelectInput.tsx
│   ├── context/
│   │   └── ApplicationContext.tsx     # Central state + autosave + submit
│   ├── pages/
│   │   ├── Admin.tsx                  # Admin dashboard host
│   │   ├── LoanApplication.tsx        # Wizard host + dashboard route
│   │   ├── ResumeApplication.tsx
│   │   ├── StartApplication.tsx
│   │   └── Success.tsx
│   ├── sections/
│   │   ├── AgreementSection.tsx
│   │   ├── ApplicantTypeSection.tsx
│   │   ├── BusinessFinancialSection.tsx
│   │   ├── BusinessInfoSection.tsx
│   │   ├── BusinessKycSection.tsx
│   │   ├── BusinessRepSection.tsx
│   │   ├── LoanRequestSection.tsx
│   │   ├── PersonalFinancialSection.tsx
│   │   ├── PersonalInfoSection.tsx
│   │   ├── PersonalKycSection.tsx
│   │   └── ReviewSection.tsx
│   ├── services/
│   │   ├── adminApi.ts                # Admin API client (login, list, get, updateStatus)
│   │   ├── agreementGenerator.ts      # Loan Agreement template engine
│   │   └── googleAppsScript.ts        # User API client (save, submit, lookup)
│   ├── types/
│   │   ├── application.ts
│   │   ├── documents.ts
│   │   └── loan.ts
│   ├── utils/
│   │   ├── applicationId.ts
│   │   ├── config.ts                  # Centralised env config + validation
│   │   ├── feeCalculator.ts
│   │   ├── loanCalculator.ts          # Pure calculation engine
│   │   ├── nigerianStates.ts
│   │   ├── storage.ts                 # localStorage draft persistence
│   │   └── validation.ts              # Zod schemas
│   ├── App.tsx
│   ├── main.tsx
│   ├── index.css
│   └── vite-env.d.ts
├── .env.example
├── .gitignore
├── index.html
├── package.json
├── postcss.config.js
├── tailwind.config.js
├── tsconfig.json
├── tsconfig.node.json
└── vite.config.ts
```

---

## 10. Security

- **No Google Drive credentials** are exposed to the frontend. The frontend only sends file data (base64) to the Apps Script Web App, which then writes to Google Drive using the script's own authorisation.
- **BVN and NIN** are never placed in URLs, folder names, file names, or the agreement text. They are masked (`*****123`) wherever they would be displayed. They are stored in the Google Sheet row for verification purposes only — and shown in the **admin dashboard's detail view** (clearly marked "Sensitive").
- **Document uploads** are validated client-side (file type + size ≤ 10 MB) before being sent to the backend. The backend re-validates before writing to Drive.
- **Admin authentication** uses a server-issued token (UUID) stored in `PropertiesService`, valid for 24 hours. The default password should be replaced via `setAdminPassword_("...")` for production.
- The Apps Script Web App is deployed with **"Anyone"** access (because the frontend has no auth of its own) — pair this with Apps Script's daily quota limits and your organisation's throttling policy if needed. For production, consider requiring sign-in via Google Identity / OAuth and proxying through a proper backend.

---

## 11. Customising

### Branding

- Edit `tailwind.config.js` to change the primary colour (currently `#2196F3`).
- Replace `public/logo.svg` and `public/favicon.svg` with your own assets.
- Update `VITE_COMPANY_NAME` and `VITE_COMPANY_WEBSITE` in `.env`.

### Fees

All fees are configurable via `.env`. See section 2.

### Loan Agreement

Edit the template in `src/services/agreementGenerator.ts` (`AGREEMENT_TEMPLATE_TEXT`). The same placeholders work for both Personal and Business loans — irrelevant fields are simply rendered as `—` for the inactive applicant type.

### Sections

To add or modify a section, edit `src/sections/<Section>.tsx` and the relevant `SECTION` constant in `src/context/ApplicationContext.tsx` (`PERSONAL_SECTIONS` / `BUSINESS_SECTIONS`).

### Admin Dashboard

- The admin password can be changed via `setAdminPassword_("...")` in Apps Script — see section 3.4.
- The admin token TTL (24 hours) can be changed by editing `ADMIN_TOKEN_TTL_MS` in `Code.gs`.
- The admin UI lives at `/admin` and the code is in `src/pages/Admin.tsx` + `src/components/admin/`.

---

## 12. Troubleshooting

### "VITE_GOOGLE_SCRIPT_URL is not configured"

You haven't set `VITE_GOOGLE_SCRIPT_URL` in your `.env`. The app will still work for local drafts, but submission, resume, and the admin dashboard won't work until you deploy the Apps Script backend (see section 3).

### Apps Script returns "Unexpected response from server"

This usually means the Apps Script returned HTML (an error page) instead of JSON. Check the Apps Script executions log at <https://script.google.com/home/executions>.

### Document upload fails with "File too large"

The frontend enforces a 10 MB limit per file. Adjust `MAX_DOC_SIZE_BYTES` in `src/types/documents.ts` and `CONFIG.MAX_FILE_SIZE_BYTES` in `google-apps-script/Code.gs` (they must match).

### Resume screen doesn't find my draft

Drafts are stored locally in the browser. If you started the application on a different device, the local copy won't be there — the backend lookup will fetch it instead (if `VITE_GOOGLE_SCRIPT_URL` is configured).

### Admin dashboard shows "Unauthorized"

Your admin token has expired (after 24 hours) or was cleared. Log in again at `/admin`.

### Admin dashboard shows empty list

Make sure you've actually submitted at least one application. Drafts saved locally (not synced to the backend) won't appear in the admin list — only applications that have been submitted or saved to the backend are visible.

### After deploying the frontend, the `/admin` route returns 404

Your hosting provider needs SPA fallback to `index.html`. See section 4.5.

---

## 13. License & Disclaimer

© Velo Finance LTD. All rights reserved.

This Loan Agreement template is a configurable legal template. It should be reviewed and approved by an appropriate legal professional before production use.
