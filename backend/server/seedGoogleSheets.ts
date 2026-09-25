import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { google } from "googleapis";
import { env, hasDatabase } from "./config.js";
import { sql } from "./db.js";
import {
  initializeStore,
  findUserByEmail,
  findOrCreateKycCase,
  createWallet,
  recordJobStart,
  recordJobComplete,
  reloadStoreFromRelationalTables,
  users,
  kycCases,
  loanApplications,
  loans,
  investments,
  wallets,
  loanProducts,
  loanSchedules,
  documents,
  applicationDrafts,
} from "./store.js";
import type {
  User,
  KycStatus,
  LoanApplication,
  LoanStatus,
  Role,
  Document as StoredDocument,
} from "./store.js";
import {
  listRecentJobRuns,
  decomposeRuntimeStateIntoTables,
} from "./store.js";

// ============================================================
// Column map: index (0..58) → field path used for readability only
// (actual code reads row[i] directly for speed).
// Matches the verbatim order of Code.gs COLUMNS list (68-declared, 59 populated)
// ============================================================
const COLUMN_TO_FIELD_MAP: Array<{ idx: number; label: string; path: string }> = [
  { idx: 0, label: "Application ID", path: "application.id" },
  { idx: 1, label: "Applicant Type", path: "application.applicantType" },
  { idx: 2, label: "Application Status", path: "application.status" },
  { idx: 3, label: "Date Created", path: "application.createdAt" },
  { idx: 4, label: "Date Last Updated", path: "application.updatedAt" },
  { idx: 5, label: "Date Submitted", path: "application.submittedAt" },
  { idx: 6, label: "Full Name", path: "user.fullName" },
  { idx: 7, label: "Date of Birth", path: "user.dateOfBirth" },
  { idx: 8, label: "Phone", path: "user.phone" },
  { idx: 9, label: "Email", path: "user.email" },
  { idx: 10, label: "Residential Address", path: "user.residentialAddress.full" },
  { idx: 11, label: "State", path: "user.residentialAddress.state" },
  { idx: 12, label: "LGA", path: "user.residentialAddress.lga" },
  { idx: 13, label: "Business Name", path: "borrowerProfile.businessName" },
  { idx: 14, label: "Business Registration Number", path: "borrowerProfile.registrationNumber" },
  { idx: 15, label: "Business Type", path: "borrowerProfile.businessType" },
  { idx: 16, label: "Business Address", path: "borrowerProfile.businessAddress" },
  { idx: 17, label: "Business Industry", path: "borrowerProfile.industry" },
  { idx: 18, label: "Years in Business", path: "borrowerProfile.yearsInBusiness" },
  { idx: 19, label: "Representative Name", path: "representative.fullName" },
  { idx: 20, label: "Representative Position", path: "representative.position" },
  { idx: 21, label: "Representative Phone", path: "representative.phone" },
  { idx: 22, label: "Representative Email", path: "representative.email" },
  { idx: 23, label: "Representative Address", path: "representative.address" },
  { idx: 24, label: "BVN", path: "kycCase.bvn" },
  { idx: 25, label: "NIN", path: "kycCase.nin" },
  { idx: 26, label: "ID Type", path: "document.kyc.idType" },
  { idx: 27, label: "ID Number", path: "document.kyc.idNumber" },
  { idx: 28, label: "Employment Status", path: "borrowerProfile.employmentStatus" },
  { idx: 29, label: "Employer/Business Name", path: "borrowerProfile.employerName" },
  { idx: 30, label: "Monthly Income", path: "borrowerProfile.monthlyIncome" },
  { idx: 31, label: "Monthly Expenses", path: "borrowerProfile.monthlyExpenses" },
  { idx: 32, label: "Business Revenue", path: "borrowerProfile.businessRevenue" },
  { idx: 33, label: "Business Expenses", path: "borrowerProfile.businessExpenses" },
  { idx: 34, label: "Existing Loan Obligations", path: "borrowerProfile.existingObligations" },
  { idx: 35, label: "Expected Repayment Source", path: "borrowerProfile.repaymentSource" },
  { idx: 36, label: "Loan Amount", path: "application.amountNaira" },
  { idx: 37, label: "Loan Tenure", path: "application.tenureDays" },
  { idx: 38, label: "Loan Purpose", path: "application.purpose" },
  { idx: 39, label: "Collateral Type", path: "application.collateral.type" },
  { idx: 40, label: "Collateral Description", path: "application.collateral.description" },
  { idx: 41, label: "Collateral Value", path: "application.collateral.valueNaira" },
  { idx: 42, label: "Collateral Ownership", path: "application.collateral.ownership" },
  { idx: 43, label: "Collateral Location", path: "application.collateral.location" },
  { idx: 44, label: "Collateral Reference", path: "application.collateral.reference" },
  { idx: 45, label: "Interest", path: "loan.interestNaira" },
  { idx: 46, label: "Service Fee", path: "loan.fees.serviceFeeNaira" },
  { idx: 47, label: "Processing Fee", path: "loan.fees.processingFeeNaira" },
  { idx: 48, label: "Other Fees", path: "loan.fees.otherFeesNaira" },
  { idx: 49, label: "Total Fees", path: "loan.fees.totalFeesNaira" },
  { idx: 50, label: "Total Repayment", path: "loan.totalReceivableNaira" },
  { idx: 51, label: "Disbursement Date", path: "loan.disbursementDate" },
  { idx: 52, label: "Repayment Date", path: "loan.maturityDate" },
  { idx: 53, label: "Google Drive Folder URL", path: "application.folderUrl" },
  { idx: 54, label: "ID Document URL", path: "documents.idDoc.storageUrl" },
  { idx: 55, label: "Proof of Address URL", path: "documents.addressDoc.storageUrl" },
  { idx: 56, label: "Collateral Media URL", path: "documents.collateralMedia.storageUrl" },
  { idx: 57, label: "Signed Agreement URL", path: "application.signedAgreementUrl" },
  { idx: 58, label: "Last Section Index", path: "draft.lastSectionIndex" },
];
void COLUMN_TO_FIELD_MAP;

type Row = string[];

const _hasColumns = (r: Row): boolean => Array.isArray(r) && r.length >= 59 && String(r[9] ?? "").length > 0;

const APPLICATION_STATUS_TO_LOAN_STATUS: Record<string, LoanStatus> = {
  DRAFT: "DRAFT",
  IN_PROGRESS: "IN_PROGRESS",
  SUBMITTED: "SUBMITTED",
  UNDER_REVIEW: "UNDER_REVIEW",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  DISBURSED: "DISBURSED",
  REPAID: "REPAID",
  PAID: "REPAID",
  ACTIVE: "ACTIVE",
  DEFAULTED: "DEFAULTED",
  CANCELLED: "CANCELLED",
  WRITTEN_OFF: "WRITTEN_OFF",
};

function normalizeEmail(v: string | undefined | null): string {
  return (v ?? "").trim().toLowerCase();
}

function last4(v: string | undefined | null): string {
  const s = (v ?? "").trim();
  if (s.length <= 4) return s;
  return `***${s.slice(-4)}`;
}

function parseNaira(v: string | undefined | null): number {
  const s = String(v ?? "0").replace(/[^0-9.-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseDays(v: string | undefined | null): number {
  const s = String(v ?? "0").trim().toLowerCase();
  if (/day/.test(s)) {
    const m = s.match(/(\d+(?:\.\d+)?)/);
    return m ? Math.round(Number(m[1])) : 30;
  }
  if (/month/.test(s)) {
    const m = s.match(/(\d+(?:\.\d+)?)/);
    return m ? Math.round(Number(m[1]) * 30) : 30;
  }
  if (/year/.test(s)) {
    const m = s.match(/(\d+(?:\.\d+)?)/);
    return m ? Math.round(Number(m[1]) * 365) : 365;
  }
  const n = Number(s.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? Math.max(1, Math.round(n)) : 30;
}

function safeDate(v: string | undefined | null): string | undefined {
  if (!v) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function randomBcryptPassword(): Promise<string> {
  return bcrypt.hash(randomUUID() + randomUUID() + randomUUID(), 10);
}

function extractGoogleDriveFileId(url: string): string {
  const fileMatch = url.match(/drive\.google\.com\/file\/d\/([^/?]+)/);
  if (fileMatch?.[1]) return fileMatch[1];
  try {
    return new URL(url).searchParams.get("id") ?? url;
  } catch {
    return url;
  }
}

function sheetsService(): ReturnType<typeof google.sheets> | null {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    console.warn("[seedGoogleSheets] GOOGLE_SERVICE_ACCOUNT_EMAIL/KEY not configured — skipping Sheets read.");
    return null;
  }
  const auth = new google.auth.JWT({
    email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

export async function getSheetRows(spreadsheetId: string, sheetName: string): Promise<Row[]> {
  const svc = sheetsService();
  if (!svc) return [];
  const res = await svc.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A1:ZZ`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const values = (res.data.values ?? []) as Row[];
  if (values.length <= 1) return [];
  return values.slice(1); // skip header row
}

type EntityStats = {
  users: number;
  kycCases: number;
  identityEvents: number;
  addresses: number;
  loanApplications: number;
  loans: number;
  loanSchedules: number;
  documents: number;
  applicationDrafts: number;
  bvnLast4Seen: Set<string>;
  ninLast4Seen: Set<string>;
  userEmails: Set<string>;
};

function newStats(): EntityStats {
  return {
    users: 0,
    kycCases: 0,
    identityEvents: 0,
    addresses: 0,
    loanApplications: 0,
    loans: 0,
    loanSchedules: 0,
    documents: 0,
    applicationDrafts: 0,
    bvnLast4Seen: new Set<string>(),
    ninLast4Seen: new Set<string>(),
    userEmails: new Set<string>(),
  };
}

function computeApplicationStageStatuses(statusVal: string): LoanApplication["stageStatuses"] {
  const base: Record<string, unknown> = {
    identity: statusVal === "DRAFT" ? "NOT_STARTED" : "COMPLETED",
    basicInfo: statusVal === "DRAFT" ? "NOT_STARTED" : "COMPLETED",
    employment: statusVal === "DRAFT" ? "NOT_STARTED" : "COMPLETED",
    financials: statusVal === "DRAFT" ? "NOT_STARTED" : "COMPLETED",
    kycDocs: statusVal === "DRAFT" ? "NOT_STARTED" : "COMPLETED",
    collateral: statusVal === "DRAFT" ? "NOT_STARTED" : "COMPLETED",
    review: statusVal === "UNDER_REVIEW" || statusVal === "APPROVED" || statusVal === "REJECTED" || statusVal === "DISBURSED" || statusVal === "REPAID" ? "COMPLETED" : "NOT_STARTED",
    agreement: statusVal === "APPROVED" || statusVal === "DISBURSED" || statusVal === "REPAID" ? "COMPLETED" : "NOT_STARTED",
  };
  return base as unknown as LoanApplication["stageStatuses"];
}

async function seedFallbackLoanProductIfEmpty(): Promise<void> {
  if (!sql) return;
  const rows = await sql.query("SELECT count(*)::int as c FROM loan_products") as Array<{ c: number }>;
  const count = rows[0]?.c ?? 0;
  if (count > 0) return;
  const now = new Date().toISOString();
  const failSafe: typeof loanProducts[number] = {
    id: "velo-personal-failsafe",
    name: "Velo Personal Loan",
    description: "Personal Loan backed by fail-safe catalog seed. 18% APR.",
    programType: "PERSONAL",
    minAmountNaira: 50_000,
    maxAmountNaira: 5_000_000,
    defaultTenureDays: 30,
    tenureDays: [30, 60, 90, 180],
    interestRatePercent: 18,
    interestType: "SIMPLE_FLAT",
    processingFeePercent: 3,
    serviceFeePercent: 0,
    lateFeePercent: 5,
    lateFeeType: "ONE_TIME",
    gracePeriodDays: 3,
    collateralEnabled: true,
    collateralRequired: false,
    isActive: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  loanProducts.push(failSafe);
}

export async function processRowsIntoStore(rows: Row[]): Promise<EntityStats> {
  const stats = newStats();
  await initializeStore();

  const now = new Date().toISOString();
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    for (const row of chunk) {
      if (!_hasColumns(row)) continue;
      const email = normalizeEmail(row[9]);
      if (!email) continue;

      // ================ User ================
      let user = findUserByEmail(email);
      const existingUser = Boolean(user);
      if (!existingUser) {
        const roles: Role[] = ["BORROWER"];
        const newUser: User = {
          id: randomUUID(),
          email,
          phone: (row[8] ?? "").trim(),
          fullName: (row[6] ?? "").trim() || email.split("@")[0] || "Unnamed Borrower",
          passwordHash: await randomBcryptPassword(),
          roles,
          kycStatus: (row[24] || row[25] ? "PARTIALLY_VERIFIED" : "NOT_STARTED") as KycStatus,
          createdAt: safeDate(row[3]) ?? now,
          updatedAt: safeDate(row[4]) ?? now,
          isActive: true,
          preferredOtpChannel: "EMAIL",
          otpLoginEnabled: false,
          dateOfBirth: safeDate(row[7])?.slice(0, 10),
          residentialAddress: {
            full: row[10] ?? "",
            state: row[11] ?? "",
            lga: row[12] ?? "",
          },
          occupation: (row[28] ?? "").trim() || undefined,
        };
        users.push(newUser);
        user = newUser;
        stats.users += 1;
        stats.userEmails.add(email);
      } else {
        stats.userEmails.add(email);
      }
      if (!user) continue;

      // Wallet (also ensures one exists; createWallet is idempotent by userId+walletsByUserId Map)
      createWallet(user.id);

      // ================ Address row (write to addresses table) ================
      const residential = row[10] || row[11] || row[12];
      if (residential && sql) {
        try {
          await sql.query(
            `INSERT INTO addresses (id, user_id, address_type, line1, state, lga, city, country, created_at, updated_at)
             VALUES ($1, $2, 'RESIDENTIAL', $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT DO NOTHING`,
            [
              `addr-res-${user.id}`,
              user.id,
              row[10] ?? null,
              row[11] ?? null,
              row[12] ?? null,
              null,
              "NG",
              now,
              now,
            ]
          );
          stats.addresses += 1;
        } catch { /* ignore duplicate */ }
      }
      if (row[16] && sql) {
        try {
          await sql.query(
            `INSERT INTO addresses (id, user_id, address_type, line1, city, country, created_at, updated_at)
             VALUES ($1, $2, 'BUSINESS', $3, $4, $5, $6, $7)
             ON CONFLICT DO NOTHING`,
            [
              `addr-biz-${user.id}`,
              user.id,
              row[16] ?? null,
              row[17] ?? null,
              "NG",
              now,
              now,
            ]
          );
        } catch { /* ignore */ }
      }

      // ================ KycCase ================
      const bvnRaw = (row[24] ?? "").trim();
      const ninRaw = (row[25] ?? "").trim();
      if (bvnRaw) stats.bvnLast4Seen.add(last4(bvnRaw));
      if (ninRaw) stats.ninLast4Seen.add(last4(ninRaw));

      const kycCase = findOrCreateKycCase(user.id);
      if (bvnRaw) {
        (kycCase as unknown as { bvn?: string }).bvn = bvnRaw;
        kycCase.status = ("PARTIALLY_VERIFIED" as KycStatus);
      }
      if (ninRaw) {
        (kycCase as unknown as { nin?: string }).nin = ninRaw;
        kycCase.status = ("PARTIALLY_VERIFIED" as KycStatus);
      }
      (kycCase as unknown as { checklist?: unknown }).checklist = {
        bvn: Boolean(bvnRaw),
        nin: Boolean(ninRaw),
        proofOfAddress: Boolean(row[55]),
        passport: Boolean(row[54]),
        signature: false,
        liveness: false,
      };
      stats.kycCases += 1;

      // Borrower profile upsert (SQL only — TS store stores in users.metadata already)
      const biz = row[13] || row[14] || row[15] || row[17] || row[18] || row[28] || row[29] || row[30] || row[31] || row[32] || row[33] || row[34] || row[35];
      if (biz && sql) {
        try {
          await sql.query(
            `INSERT INTO borrower_profiles (id, user_id, business_name, business_registration_number, business_type, business_industry, years_in_business, employment_status, employer_name, monthly_income_naira, monthly_expenses_naira, business_revenue_naira, business_expenses_naira, existing_loan_obligations, expected_repayment_source, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
             ON CONFLICT (user_id) DO UPDATE SET
               business_name = COALESCE(EXCLUDED.business_name, borrower_profiles.business_name),
               business_registration_number = COALESCE(EXCLUDED.business_registration_number, borrower_profiles.business_registration_number),
               business_type = COALESCE(EXCLUDED.business_type, borrower_profiles.business_type),
               business_industry = COALESCE(EXCLUDED.business_industry, borrower_profiles.business_industry),
               years_in_business = COALESCE(EXCLUDED.years_in_business, borrower_profiles.years_in_business),
               employment_status = COALESCE(EXCLUDED.employment_status, borrower_profiles.employment_status),
               employer_name = COALESCE(EXCLUDED.employer_name, borrower_profiles.employer_name),
               monthly_income_naira = COALESCE(EXCLUDED.monthly_income_naira, borrower_profiles.monthly_income_naira),
               monthly_expenses_naira = COALESCE(EXCLUDED.monthly_expenses_naira, borrower_profiles.monthly_expenses_naira),
               business_revenue_naira = COALESCE(EXCLUDED.business_revenue_naira, borrower_profiles.business_revenue_naira),
               business_expenses_naira = COALESCE(EXCLUDED.business_expenses_naira, borrower_profiles.business_expenses_naira),
               existing_loan_obligations = COALESCE(EXCLUDED.existing_loan_obligations, borrower_profiles.existing_loan_obligations),
               expected_repayment_source = COALESCE(EXCLUDED.expected_repayment_source, borrower_profiles.expected_repayment_source),
               updated_at = EXCLUDED.updated_at`,
            [
              `borrower-${user.id}`,
              user.id,
              row[13] ?? null,
              row[14] ?? null,
              row[15] ?? null,
              row[17] ?? null,
              row[18] ? Number(row[18]) : null,
              row[28] ?? null,
              row[29] ?? null,
              row[30] ? parseNaira(row[30]) : null,
              row[31] ? parseNaira(row[31]) : null,
              row[32] ? parseNaira(row[32]) : null,
              row[33] ? parseNaira(row[33]) : null,
              row[34] ?? null,
              row[35] ?? null,
              now,
              now,
            ]
          );
        } catch { /* ignore */ }
      }

      // ================ Loan Application ================
      const applicationIdRaw = (row[0] ?? "").trim() || randomUUID();
      const existingApp = loanApplications.find((a) => a.applicationId === applicationIdRaw || a.id === applicationIdRaw);
      const statusRaw = (row[2] ?? "DRAFT").trim().toUpperCase();
      const applicantTypeRaw = (row[1] ?? "PERSONAL").trim().toUpperCase();
      const loanAmountNaira = parseNaira(row[36]);
      const tenureDays = parseDays(row[37]);
      const totalFeesNaira = parseNaira(row[49]) || (parseNaira(row[46]) + parseNaira(row[47]) + parseNaira(row[48]));
      const interestNaira = parseNaira(row[45]);
      const totalRepayment = parseNaira(row[50]) || loanAmountNaira + interestNaira + totalFeesNaira;

      if (!existingApp && loanAmountNaira > 0) {
        const newApp: LoanApplication = {
          id: randomUUID(),
          applicationId: applicationIdRaw,
          borrowerId: user.id,
          applicantType: applicantTypeRaw === "BUSINESS" ? "BUSINESS" : "PERSONAL",
          status: APPLICATION_STATUS_TO_LOAN_STATUS[statusRaw] ?? "DRAFT",
          amountNaira: loanAmountNaira,
          tenureDays,
          stageStatuses: computeApplicationStageStatuses(statusRaw),
          stageRejectionNotes: {},
          submittedAt: safeDate(row[5]),
          createdAt: safeDate(row[3]) ?? now,
          updatedAt: safeDate(row[4]) ?? now,
          signedAgreementUrl: row[57]?.trim() || undefined,
          disbursementInstitution: "VELO",
          customerSnapshot: {
            fullName: user.fullName,
            email: user.email,
            purpose: row[38] ?? null,
            phone: user.phone,
            dateOfBirth: user.dateOfBirth ?? null,
            address: user.residentialAddress,
            occupation: user.occupation ?? null,
            sourceOfFunds: user.sourceOfFunds ?? null,
            bvn: bvnRaw ? last4(bvnRaw) : null,
            nin: ninRaw ? last4(ninRaw) : null,
            business: {
              name: row[13] ?? null,
              registrationNumber: row[14] ?? null,
              type: row[15] ?? null,
              address: row[16] ?? null,
              industry: row[17] ?? null,
              yearsInBusiness: row[18] ? Number(row[18]) : null,
            },
            representative: {
              name: row[19] ?? null,
              position: row[20] ?? null,
              phone: row[21] ?? null,
              email: row[22] ?? null,
              address: row[23] ?? null,
            },
            idType: row[26] ?? null,
            idNumber: row[27] ? last4(row[27]) : null,
            income: {
              employment: row[28] ?? null,
              employer: row[29] ?? null,
              monthlyNaira: row[30] ? parseNaira(row[30]) : null,
              expensesMonthlyNaira: row[31] ? parseNaira(row[31]) : null,
              businessRevenueNaira: row[32] ? parseNaira(row[32]) : null,
              businessExpensesNaira: row[33] ? parseNaira(row[33]) : null,
              existingObligations: row[34] ?? null,
              expectedRepaymentSource: row[35] ?? null,
            },
            collateral: {
              type: row[39] ?? null,
              description: row[40] ?? null,
              valueNaira: row[41] ? parseNaira(row[41]) : null,
              ownership: row[42] ?? null,
              location: row[43] ?? null,
              reference: row[44] ?? null,
            },
            driveFolderUrl: row[53] ?? null,
            fees: {
              interestNaira,
              serviceFeeNaira: parseNaira(row[46]),
              processingFeeNaira: parseNaira(row[47]),
              otherFeesNaira: parseNaira(row[48]),
              totalFeesNaira,
            },
            totalRepayment,
          },
        };
        loanApplications.push(newApp);
        stats.loanApplications += 1;

        // ================ Loan (auto-created if app status >= APPROVED or amount is real) ================
        const createLoanAnyway = statusRaw === "DISBURSED" || statusRaw === "REPAID" || statusRaw === "ACTIVE" || statusRaw === "PAST_DUE" || statusRaw === "DEFAULTED" || statusRaw === "APPROVED";
        if (createLoanAnyway) {
          const loanId = randomUUID();
          const disb = safeDate(row[51]);
          const matur = safeDate(row[52]);
          const loan: typeof loans[number] = {
            id: loanId,
            applicationId: newApp.id,
            borrowerId: user.id,
            status: statusRaw === "REPAID" ? "REPAID" : statusRaw === "DISBURSED" ? "ACTIVE" : "APPROVED",
            principalNaira: loanAmountNaira,
            totalInterestNaira: interestNaira,
            totalFeesNaira,
            totalRepaymentNaira: totalRepayment,
            outstandingNaira: statusRaw === "REPAID" ? 0 : totalRepayment,
            tenureDays,
            disbursedAt: disb,
            dueAt: matur,
            paidAt: statusRaw === "REPAID" ? matur : undefined,
            createdAt: newApp.createdAt,
            updatedAt: newApp.updatedAt,
          };
          loans.push(loan);
          stats.loans += 1;

          // Single loan schedule row for the bullet-style repayment (mirror Apps Script sheet)
          if (matur) {
            const sched: typeof loanSchedules[number] = {
              id: randomUUID(),
              loanId,
              installmentNumber: 1,
              dueDate: matur,
              principalNaira: loanAmountNaira,
              interestNaira,
              feesNaira: totalFeesNaira,
              totalDueNaira: totalRepayment,
              totalPaidNaira: statusRaw === "REPAID" ? totalRepayment : 0,
              status: statusRaw === "REPAID" ? "PAID" : "PENDING",
              createdAt: newApp.createdAt,
              updatedAt: newApp.updatedAt,
            };
            loanSchedules.push(sched);
            stats.loanSchedules += 1;
          }
        }

        // ================ Documents ================
        const docMeta: Array<{ documentType: StoredDocument["documentType"]; url: string }> = [];
        if (row[54]) docMeta.push({ documentType: row[26]?.toUpperCase().includes("CARD") ? "ID_CARD_FRONT" : "PASSPORT_PHOTO", url: row[54] });
        if (row[55]) docMeta.push({ documentType: "PROOF_OF_ADDRESS", url: row[55] });
        if (row[56]) docMeta.push({ documentType: "BUSINESS_REGISTRATION", url: row[56] });
        for (const dm of docMeta) {
          const doc: StoredDocument = {
            id: randomUUID(),
            userId: user.id,
            documentType: dm.documentType,
            provider: "google_drive",
            providerFileId: extractGoogleDriveFileId(dm.url),
            fileName: `${dm.documentType.toLowerCase()}-${user.id.slice(0, 8)}`,
            status: "VERIFIED",
            version: 1,
            createdAt: newApp.createdAt,
            updatedAt: newApp.updatedAt,
          };
          documents.push(doc);
          stats.documents += 1;
        }

        // ================ Application Draft ================
        const lastSection = Number(row[58] ?? 0);
        if (!Number.isNaN(lastSection) && lastSection > 0) {
          applicationDrafts.push({
            id: randomUUID(),
            userId: user.id,
            applicationId: applicationIdRaw,
            applicantType: newApp.applicantType,
            data: { _legacyRow: row, _source: "google-sheets-seed" },
            lastSectionIndex: Math.max(0, Math.min(20, Math.trunc(lastSection))),
            createdAt: newApp.createdAt,
            updatedAt: newApp.updatedAt ?? newApp.createdAt,
          });
          stats.applicationDrafts += 1;
        }
      } else if (existingApp) {
        stats.loanApplications += 0;
      }
    }
    // After each chunk: decompose + persist + reload
    try {
      await decomposeRuntimeStateIntoTables();
    } catch (e) {
      console.error("[seedGoogleSheets] chunk decompose error (i=" + i + "):", e);
    }
  }
  return stats;
}

export async function runSeedGoogleSheets(
  opts: { spreadsheetId?: string; sheetName?: string; maxRows?: number } = {}
): Promise<{ ok: boolean; jobId: string; stats?: EntityStats; error?: string }> {
  const spreadsheetId = opts.spreadsheetId ?? env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const sheetName = opts.sheetName ?? env.GOOGLE_SHEETS_SHEET_NAME;
  if (!hasDatabase() || !sql) {
    const jobId = await recordJobStart("seed_google_sheets", { spreadsheetId, sheetName, note: "skipped-no-db" });
    await recordJobComplete(jobId, "SKIPPED", 0, undefined, "DATABASE_URL not configured");
    return { ok: false, jobId, error: "DATABASE_URL not configured" };
  }

  const jobId = await recordJobStart("seed_google_sheets", { spreadsheetId, sheetName });
  let stats: EntityStats | undefined;
  try {
    const rows = await getSheetRows(spreadsheetId, sheetName);
    const limited = opts.maxRows && opts.maxRows > 0 ? rows.slice(0, opts.maxRows) : rows;
    stats = await processRowsIntoStore(limited);
    // Apply fallback loan product catalog (if loan_products is still empty)
    await seedFallbackLoanProductIfEmpty();
    // Final persist + final rebuild + reload
    await decomposeRuntimeStateIntoTables();
    const countsSummary: Record<string, unknown> = {
      users: stats.users,
      kycCases: stats.kycCases,
      identityEvents: stats.identityEvents,
      addresses: stats.addresses,
      loanApplications: stats.loanApplications,
      loans: stats.loans,
      loanSchedules: stats.loanSchedules,
      documents: stats.documents,
      applicationDrafts: stats.applicationDrafts,
      uniqueEmails: stats.userEmails.size,
      bvnLast4: [...stats.bvnLast4Seen].slice(0, 25),
      ninLast4: [...stats.ninLast4Seen].slice(0, 25),
      bvnDistinct: stats.bvnLast4Seen.size,
      ninDistinct: stats.ninLast4Seen.size,
      rowsSeeded: limited.length,
    };
    const recordCount =
      stats.users + stats.kycCases + stats.identityEvents + stats.addresses + stats.loanApplications +
      stats.loans + stats.loanSchedules + stats.documents + stats.applicationDrafts;
    await recordJobComplete(jobId, "COMPLETED", recordCount, countsSummary);
    console.log("[seedGoogleSheets] FINAL entityCounts:", JSON.stringify(countsSummary, null, 2));
    void (await reloadStoreFromRelationalTables());
    return { ok: true, jobId, stats };
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    await recordJobComplete(jobId, "FAILED", 0, undefined, msg.slice(0, 2000));
    console.error("[seedGoogleSheets] run FAILED:", err);
    return { ok: false, jobId, error: msg };
  }
}

async function main(): Promise<void> {
  const res = await runSeedGoogleSheets();
  if (!res.ok) {
    console.error("[seedGoogleSheets] Exit with error:", res.error);
    process.exitCode = 1;
  } else {
    void listRecentJobRuns(10);
  }
}

if (process.argv[1]?.endsWith("seedGoogleSheets.ts") || process.argv[1]?.endsWith("seedGoogleSheets.js")) {
  main().catch((e) => {
    console.error("[seedGoogleSheets] Unhandled exception:", e);
    process.exitCode = 1;
  });
}
