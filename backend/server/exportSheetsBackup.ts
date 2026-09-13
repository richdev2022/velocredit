import { google } from "googleapis";
import { env } from "./config.js";
import { sql } from "./db.js";
import {
  initializeStore,
  recordJobStart,
  recordJobComplete,
  listRecentJobRuns,
  users,
  kycCases,
  wallets,
  investments,
  loans,
  repayments,
  payouts,
  loanApplications,
  loanSchedules,
  documents,
  applicationDrafts,
} from "./store.js";
import type {
  User,
  KycCase,
  Wallet,
  Investment,
  Loan,
  Repayment,
  Payout,
  LoanApplication,
} from "./store.js";

const LOAN_APP_COLUMN_LABELS: string[] = [
  "Application ID",
  "Applicant Type",
  "Application Status",
  "Date Created",
  "Date Last Updated",
  "Date Submitted",
  "Full Name",
  "Date of Birth",
  "Phone",
  "Email",
  "Residential Address",
  "State",
  "LGA",
  "Business Name",
  "Business Registration Number",
  "Business Type",
  "Business Address",
  "Business Industry",
  "Years in Business",
  "Representative Name",
  "Representative Position",
  "Representative Phone",
  "Representative Email",
  "Representative Address",
  "BVN",
  "NIN",
  "ID Type",
  "ID Number",
  "Employment Status",
  "Employer/Business Name",
  "Monthly Income",
  "Monthly Expenses",
  "Business Revenue",
  "Business Expenses",
  "Existing Loan Obligations",
  "Expected Repayment Source",
  "Loan Amount",
  "Loan Tenure",
  "Loan Purpose",
  "Collateral Type",
  "Collateral Description",
  "Collateral Value",
  "Collateral Ownership",
  "Collateral Location",
  "Collateral Reference",
  "Interest",
  "Service Fee",
  "Processing Fee",
  "Other Fees",
  "Total Fees",
  "Total Repayment",
  "Disbursement Date",
  "Repayment Date",
  "Google Drive Folder URL",
  "ID Document URL",
  "Proof of Address URL",
  "Collateral Media URL",
  "Signed Agreement URL",
  "Last Section Index",
];

function sheetsWriteService(): ReturnType<typeof google.sheets> | null {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    return null;
  }
  const auth = new google.auth.JWT({
    email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function ensureSheetTab(
  svc: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tabName: string,
  headerRow: string[]
): Promise<void> {
  const nowIso = new Date().toISOString();
  const timestampCell = `_Last Exported At (UTC): ${nowIso}`;
  const numCols = Math.max(headerRow.length, 1);

  let sheetId: number | undefined;
  try {
    const meta = await svc.spreadsheets.get({ spreadsheetId });
    const found = (meta.data.sheets ?? []).find(
      (s) => s.properties?.title === tabName
    );
    sheetId = found?.properties?.sheetId;
  } catch (_e) {
    sheetId = undefined;
  }

  if (sheetId === undefined) {
    try {
      await svc.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: tabName,
                  gridProperties: {
                    rowCount: 1000,
                    columnCount: Math.max(26, numCols),
                  },
                },
              },
            },
          ],
        },
      });
    } catch (_e) {
      // tab may have been created concurrently; continue
    }
  }

  const rangePrefix = `'${tabName}'`;
  try {
    if (numCols > 1) {
      const endColLetter = columnLetter(numCols - 1);
      await svc.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              mergeCells: {
                range: {
                  sheetId: sheetId ?? 0,
                  startRowIndex: 0,
                  endRowIndex: 1,
                  startColumnIndex: 0,
                  endColumnIndex: numCols,
                },
                mergeType: "MERGE_ALL",
              },
            },
          ],
        },
      });
    }
  } catch (_e) {
    // ignore merge errors
  }

  try {
    await svc.spreadsheets.values.update({
      spreadsheetId,
      range: `${rangePrefix}!A1:${columnLetter(numCols - 1)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [[timestampCell]] },
    });
  } catch (_e) {
    // ignore
  }

  try {
    await svc.spreadsheets.values.update({
      spreadsheetId,
      range: `${rangePrefix}!A2:${columnLetter(numCols - 1)}2`,
      valueInputOption: "RAW",
      requestBody: { values: [headerRow] },
    });
  } catch (_e) {
    // ignore
  }
}

function columnLetter(idxZeroBased: number): string {
  let n = idxZeroBased;
  let s = "";
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s || "A";
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch (_e) {
    return String(v);
  }
}

function findUserById(userId: string): User | undefined {
  return users.find((u) => u.id === userId);
}

function findUserByEmail(email: string): User | undefined {
  const e = email.trim().toLowerCase();
  return users.find((u) => u.email.trim().toLowerCase() === e);
}

function findKycCaseByUserId(userId: string): KycCase | undefined {
  return kycCases.find((k) => k.userId === userId);
}

function findWalletByUserId(userId: string): Wallet | undefined {
  return wallets.find((w) => w.userId === userId);
}

function findLoanByApplicationId(applicationId: string): Loan | undefined {
  return loans.find((l) => l.applicationId === applicationId);
}

function findRepaymentByLoanId(loanId: string): Repayment | undefined {
  return repayments.find((r) => r.loanId === loanId);
}

function findPayoutByInvestmentId(investmentId: string): Payout | undefined {
  return payouts.find((p) => p.investmentId === investmentId);
}

function snapshotPlanName(inv: Investment): string {
  const snap = (inv.planSnapshot ?? {}) as Record<string, unknown>;
  const name = snap.name;
  return typeof name === "string" ? name : "";
}

function buildUsersRows(): { header: string[]; rows: string[][] } {
  const header = [
    "id",
    "email",
    "full_name",
    "phone",
    "roles",
    "kyc_status",
    "created_at",
    "last_login_at",
  ];
  const rows: string[][] = [];
  for (const u of users) {
    rows.push([
      str(u.id),
      str(u.email),
      str(u.fullName),
      str(u.phone),
      Array.isArray(u.roles) ? u.roles.join(",") : "",
      str(u.kycStatus),
      str(u.createdAt),
      str(u.lastLoginAt),
    ]);
  }
  return { header, rows };
}

function buildKycRows(): { header: string[]; rows: string[][] } {
  const header = [
    "kyc_case_id",
    "user_email",
    "bvn_last4",
    "nin_last4",
    "status",
    "bvn_verified_at",
    "nin_verified_at",
    "liveness_verified_at",
    "verified_at",
    "rejection_reason",
  ];
  const rows: string[][] = [];
  for (const k of kycCases) {
    const u = findUserById(k.userId);
    const bvn = (k.bvn ?? "").trim();
    const nin = (k.nin ?? "").trim();
    const bvnL4 = bvn.length > 4 ? bvn.slice(-4) : bvn;
    const ninL4 = nin.length > 4 ? nin.slice(-4) : nin;
    const livenessAt = k.categoryResults?.LIVENESS?.updatedAt;
    rows.push([
      str(k.id),
      str(u?.email),
      str(bvnL4),
      str(ninL4),
      str(k.status),
      str(k.bvnVerifiedAt),
      str(k.ninVerifiedAt),
      str(livenessAt ?? k.livenessVerifiedAt),
      str(k.verifiedAt),
      str(k.rejectionReason),
    ]);
  }
  return { header, rows };
}

function buildWalletsRows(): { header: string[]; rows: string[][] } {
  const header = [
    "user_email",
    "available_minor",
    "held_minor",
    "pending_deposit_minor",
    "pending_payout_minor",
    "total_credited_minor",
    "total_debited_minor",
    "currency",
  ];
  const rows: string[][] = [];
  for (const w of wallets) {
    const u = findUserById(w.userId);
    rows.push([
      str(u?.email),
      str(w.availableMinor),
      str(w.heldMinor),
      str(w.pendingDepositMinor),
      str(w.pendingPayoutMinor),
      str(w.totalCreditedMinor),
      str(w.totalDebitedMinor),
      str(w.currency),
    ]);
  }
  return { header, rows };
}

function buildInvestmentsRows(): { header: string[]; rows: string[][] } {
  const header = [
    "user_email",
    "plan_name",
    "amount_naira",
    "expected_earnings",
    "tenure_days",
    "annual_rate_pct",
    "status",
    "starts_at",
    "matures_at",
    "net_payout_naira",
  ];
  const rows: string[][] = [];
  for (const inv of investments) {
    const u = findUserById(inv.investorId);
    rows.push([
      str(u?.email),
      str(snapshotPlanName(inv)),
      str(inv.amountNaira),
      str(inv.expectedEarningsNaira),
      str(inv.tenureDays),
      str(inv.annualRatePercent),
      str(inv.status),
      str(inv.startsAt),
      str(inv.maturesAt),
      str(inv.netPayoutNaira),
    ]);
  }
  return { header, rows };
}

function buildLoansRows(): { header: string[]; rows: string[][] } {
  const header = [
    "user_email",
    "application_id",
    "principal_naira",
    "total_interest_naira",
    "total_fees_naira",
    "total_repayment_naira",
    "outstanding_naira",
    "tenure_days",
    "status",
    "disbursed_at",
    "due_at",
    "paid_at",
  ];
  const rows: string[][] = [];
  for (const l of loans) {
    const u = findUserById(l.borrowerId);
    rows.push([
      str(u?.email),
      str(l.applicationId),
      str(l.principalNaira),
      str(l.totalInterestNaira),
      str(l.totalFeesNaira),
      str(l.totalRepaymentNaira),
      str(l.outstandingNaira),
      str(l.tenureDays),
      str(l.status),
      str(l.disbursedAt),
      str(l.dueAt),
      str(l.paidAt),
    ]);
  }
  return { header, rows };
}

function buildRepaymentsRows(): { header: string[]; rows: string[][] } {
  const header = [
    "user_email",
    "loan_id",
    "amount_naira",
    "principal_naira",
    "interest_naira",
    "late_fees_naira",
    "status",
    "provider",
    "tx_ref",
    "created_at",
    "verified_at_or_settled_at",
  ];
  const rows: string[][] = [];
  for (const r of repayments) {
    const u = findUserById(r.borrowerId);
    rows.push([
      str(u?.email),
      str(r.loanId),
      str(r.amountNaira),
      str(r.principalNaira),
      str(r.interestNaira),
      str(r.lateFeeNaira),
      str(r.status),
      str(r.provider),
      str(r.txRef),
      str(r.createdAt),
      str(r.verifiedAt),
    ]);
  }
  return { header, rows };
}

function buildPayoutsRows(): { header: string[]; rows: string[][] } {
  const header = [
    "user_email",
    "investment_id",
    "payout_type",
    "amount_naira",
    "status",
    "created_at",
    "provider_reference",
    "error",
  ];
  const rows: string[][] = [];
  for (const p of payouts) {
    const u = findUserById(p.userId);
    rows.push([
      str(u?.email),
      str(p.investmentId),
      str(p.payoutType),
      str(p.amountNaira),
      str(p.status),
      str(p.createdAt),
      str(p.providerReference),
      str(p.error),
    ]);
  }
  return { header, rows };
}

function getSnapshotField(snap: Record<string, unknown> | undefined, path: string): unknown {
  if (!snap) return undefined;
  const parts = path.split(".");
  let cur: unknown = snap;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function buildLoanApplicationsRows(): { header: string[]; rows: string[][] } {
  const header = LOAN_APP_COLUMN_LABELS.slice();
  const rows: string[][] = [];
  for (const app of loanApplications) {
    const row: string[] = new Array(59).fill("");
    const borrower = findUserById(app.borrowerId);
    const snap = (app.customerSnapshot ?? {}) as Record<string, unknown>;
    const kyc = borrower ? findKycCaseByUserId(borrower.id) : (null as KycCase | null);
    const relatedLoan = findLoanByApplicationId(app.id);
    const draft = applicationDrafts.find((d) => d.applicationId === app.applicationId);

    const idDocs = borrower
      ? documents.filter(
          (d) =>
            d.userId === borrower.id &&
            (d.type === "PASSPORT" ||
              d.type === "PASSPORT_PHOTO" ||
              d.documentType === "PASSPORT_PHOTO" ||
              d.documentType === "ID_CARD_FRONT")
        )
      : [];
    const addrDocs = borrower
      ? documents.filter(
          (d) =>
            d.userId === borrower.id &&
            (d.type === "PROOF_OF_ADDRESS" || d.documentType === "PROOF_OF_ADDRESS")
        )
      : [];
    const collatDocs = borrower
      ? documents.filter(
          (d) =>
            d.userId === borrower.id &&
            (d.type === "COLLATERAL" || d.documentType === "BUSINESS_REGISTRATION")
        )
      : [];

    row[0] = str(app.applicationId ?? app.id);
    row[1] = str(app.applicantType);
    row[2] = str(app.status);
    row[3] = str(app.createdAt);
    row[4] = str(app.updatedAt);
    row[5] = str(app.submittedAt);
    row[6] = str(
      borrower?.fullName ?? getSnapshotField(snap, "fullName")
    );
    row[7] = str(borrower?.dateOfBirth ?? getSnapshotField(snap, "dateOfBirth"));
    row[8] = str(borrower?.phone ?? getSnapshotField(snap, "phone"));
    row[9] = str(borrower?.email ?? getSnapshotField(snap, "email"));

    const address =
      (borrower?.residentialAddress as Record<string, unknown> | undefined) ??
      (getSnapshotField(snap, "address") as Record<string, unknown> | undefined);
    row[10] = str(address?.full);
    row[11] = str(address?.state);
    row[12] = str(address?.lga);

    const business = getSnapshotField(snap, "business") as Record<string, unknown> | undefined;
    row[13] = str(business?.name);
    row[14] = str(business?.registrationNumber);
    row[15] = str(business?.type);
    row[16] = str(business?.address);
    row[17] = str(business?.industry);
    row[18] = str(business?.yearsInBusiness);

    const rep = getSnapshotField(snap, "representative") as Record<string, unknown> | undefined;
    row[19] = str(rep?.name);
    row[20] = str(rep?.position);
    row[21] = str(rep?.phone);
    row[22] = str(rep?.email);
    row[23] = str(rep?.address);

    row[24] = str(kyc?.bvn);
    row[25] = str(kyc?.nin);
    row[26] = str(getSnapshotField(snap, "idType"));
    row[27] = str(getSnapshotField(snap, "idNumber"));

    const income = getSnapshotField(snap, "income") as Record<string, unknown> | undefined;
    row[28] = str(income?.employment);
    row[29] = str(income?.employer);
    row[30] = str(income?.monthlyNaira);
    row[31] = str(income?.expensesMonthlyNaira);
    row[32] = str(income?.businessRevenueNaira);
    row[33] = str(income?.businessExpensesNaira);
    row[34] = str(income?.existingObligations);
    row[35] = str(income?.expectedRepaymentSource);

    row[36] = str(app.amountNaira);
    row[37] = str(app.tenureDays);
    const purpose = getSnapshotField(snap, "purpose");
    row[38] = str(purpose);

    const collateral =
      getSnapshotField(snap, "collateral") as Record<string, unknown> | undefined;
    row[39] = str(collateral?.type);
    row[40] = str(collateral?.description);
    row[41] = str(collateral?.valueNaira);
    row[42] = str(collateral?.ownership);
    row[43] = str(collateral?.location);
    row[44] = str(collateral?.reference);

    const fees = getSnapshotField(snap, "fees") as Record<string, unknown> | undefined;
    row[45] = str(
      relatedLoan?.totalInterestNaira ??
        fees?.interestNaira
    );
    row[46] = str(fees?.serviceFeeNaira);
    row[47] = str(fees?.processingFeeNaira);
    row[48] = str(fees?.otherFeesNaira);
    row[49] = str(
      relatedLoan?.totalFeesNaira ??
        fees?.totalFeesNaira
    );
    row[50] = str(
      relatedLoan?.totalRepaymentNaira ??
        getSnapshotField(snap, "totalRepayment")
    );

    row[51] = str(relatedLoan?.disbursedAt);
    row[52] = str(relatedLoan?.dueAt);

    row[53] = str(getSnapshotField(snap, "driveFolderUrl"));
    row[54] = str(idDocs[0]?.storageUrl);
    row[55] = str(addrDocs[0]?.storageUrl);
    row[56] = str(collatDocs[0]?.storageUrl);
    row[57] = str(app.signedAgreementUrl);
    row[58] = str(draft?.lastSectionIndex);

    rows.push(row);
  }
  return { header, rows };
}

type TabBuildResult = { header: string[]; rows: string[][] };

const TAB_BUILDERS: Array<{ tabName: string; build: () => TabBuildResult }> = [
  { tabName: "Users", build: buildUsersRows },
  { tabName: "Loan Applications", build: buildLoanApplicationsRows },
  { tabName: "KYC", build: buildKycRows },
  { tabName: "Wallets", build: buildWalletsRows },
  { tabName: "Investments", build: buildInvestmentsRows },
  { tabName: "Loans", build: buildLoansRows },
  { tabName: "Repayments", build: buildRepaymentsRows },
  { tabName: "Payouts", build: buildPayoutsRows },
];

export async function runExportSheetsBackup(): Promise<{
  ok: boolean;
  jobId: string;
  totalRows: number;
  error?: string;
}> {
  const svc = sheetsWriteService();
  const spreadsheetId =
    env.GOOGLE_SHEETS_BACKUP_SPREADSHEET_ID ?? env.GOOGLE_SHEETS_SPREADSHEET_ID;

  if (!svc) {
    const jobId = await recordJobStart(
      `sheets_backup_export:${new Date().toISOString()}`,
      { skipped: true, reason: "no-service-account" }
    );
    await recordJobComplete(
      jobId,
      "SKIPPED",
      0,
      { skipped: true, reason: "no-service-account" },
      "backup skipped: Google Sheets backup is not configured"
    );
    console.log("[exportSheetsBackup] backup skipped: Google Sheets backup is not configured");
    return { ok: true, jobId, totalRows: 0 };
  }

  if (
    !env.GOOGLE_SHEETS_BACKUP_SPREADSHEET_ID &&
    env.GOOGLE_SHEETS_SPREADSHEET_ID
  ) {
    console.warn(
      "[exportSheetsBackup] GOOGLE_SHEETS_BACKUP_SPREADSHEET_ID not set; falling back to shared GOOGLE_SHEETS_SPREADSHEET_ID."
    );
  }

  const jobName = `sheets_backup_export:${new Date().toISOString()}`;
  const jobId = await recordJobStart(jobName, { spreadsheetId });
  let totalRows = 0;
  const perTabCounts: Record<string, number> = {};

  try {
    await initializeStore();

    for (const { tabName, build } of TAB_BUILDERS) {
      const { header, rows } = build();
      await ensureSheetTab(svc, spreadsheetId, tabName, header);

      const endCol = columnLetter(Math.max(header.length, 1) - 1);
      const range = `'${tabName}'!A3:${endCol}${2 + Math.max(rows.length, 1)}`;
      const clearRange = `'${tabName}'!A3:${endCol}100000`;

      try {
        await svc.spreadsheets.values.clear({
          spreadsheetId,
          range: clearRange,
        });
      } catch (_e) {
        // ignore clear errors
      }

      if (rows.length > 0) {
        await svc.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: {
            valueInputOption: "RAW",
            data: [
              {
                range,
                majorDimension: "ROWS",
                values: rows,
              },
            ],
          },
        });
      }

      perTabCounts[tabName] = rows.length;
      totalRows += rows.length;
    }

    await recordJobComplete(jobId, "COMPLETED", totalRows, {
      perTabCounts,
      spreadsheetId,
    });
    console.log(
      `[exportSheetsBackup] COMPLETED totalRows=${totalRows} perTab=${JSON.stringify(
        perTabCounts
      )}`
    );
    return { ok: true, jobId, totalRows };
  } catch (err) {
    const msg =
      err instanceof Error ? err.stack ?? err.message : String(err);
    await recordJobComplete(
      jobId,
      "FAILED",
      totalRows,
      { perTabCounts, spreadsheetId },
      msg.slice(0, 2000)
    );
    console.error("[exportSheetsBackup] run FAILED:", err);
    return { ok: false, jobId, totalRows, error: msg };
  }
}

async function main(): Promise<void> {
  const res = await runExportSheetsBackup();
  if (!res.ok) {
    console.error("[exportSheetsBackup] Exit with error:", res.error);
    process.exitCode = 1;
  } else {
    void (await listRecentJobRuns(10));
  }
}

if (
  process.argv[1]?.endsWith("exportSheetsBackup.ts") ||
  process.argv[1]?.endsWith("exportSheetsBackup.js")
) {
  main().catch((e) => {
    console.error("[exportSheetsBackup] Unhandled exception:", e);
    process.exitCode = 1;
  });
}

void loanSchedules;
void sql;
void findPayoutByInvestmentId;
void findRepaymentByLoanId;
void findUserByEmail;
