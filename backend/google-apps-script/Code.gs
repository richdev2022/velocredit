/**
 * ============================================================================
 * Velo Finance LTD — Loan Application Backend
 * Google Apps Script / Code.gs
 * ============================================================================
 *
 * PURPOSE
 * - Save loan application drafts to Google Sheets
 * - Submit final loan applications
 * - Upload supporting documents to Google Drive
 * - Resume/lookup unfinished applications
 * - Provide admin login, listing, details, statistics and status updates
 *
 * DEPLOYMENT
 * 1. Open https://script.google.com and create/open your project.
 * 2. Replace the entire Code.gs contents with this file.
 * 3. Review CONFIG below.
 * 4. Select `setup` from the function dropdown and click Run.
 * 5. Approve Google permissions when prompted.
 * 6. Open Executions and inspect the execution log, or run `setupAndReturnResult`.
 * 7. Deploy → New deployment → Web app.
 *      Execute as: Me
 *      Who has access: Anyone
 * 8. Put the Web App URL in your frontend as VITE_GOOGLE_SCRIPT_URL.
 *
 * EXPECTED SETUP LOG
 * Setup complete.
 * Spreadsheet URL: https://docs.google.com/spreadsheets/d/.../edit
 * Sheet name:      Loan Applications
 * Drive folder:    Velo Loan Applications
 * Drive folder URL: https://drive.google.com/drive/folders/...
 * ============================================================================
 */

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = Object.freeze({
  COMPANY_NAME: "Velo Finance LTD",

  // Existing resources may be supplied here. If either value is blank, setup()
  // creates the missing resource and stores its ID in Script Properties.
  DRIVE_PARENT_FOLDER_ID: '1HrgChZTIBxRQfWQayraCgSId26Uqy9A5',
  SPREADSHEET_ID: '1VelRf1cdCOWkf0jk6rLyQrkWK8GOaa9e9C6eblR9bdc',

  DRIVE_PARENT_FOLDER_NAME: "Velo Loan Applications",
  SPREADSHEET_NAME: "Velo Loan Applications",
  SHEET_NAME: "Loan Applications",

  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024,
  ALLOWED_MIME: [
    "application/pdf",
    "image/jpeg",
    "image/jpg",
    "image/png",
    "video/mp4",
    "video/quicktime",
    "video/webm",
  ],

  // Recommended: run setAdminEmail('admin@example.com') once, then
  // replace this fallback with an empty string.
  ADMIN_PASSWORD: "",

  ADMIN_TOKEN_TTL_MS: 24 * 60 * 60 * 1000,
  LOCK_TIMEOUT_MS: 30000,
});

const PROP_KEYS = Object.freeze({
  SPREADSHEET_ID: "VELO_SPREADSHEET_ID",
  DRIVE_FOLDER_ID: "VELO_DRIVE_FOLDER_ID",
  ADMIN_PASSWORD: "VELO_ADMIN_PASSWORD",
  APPLICATION_SEQUENCE: "VELO_APPLICATION_SEQUENCE",
  ADMIN_CONFIG: "VELO_ADMIN_CONFIG",
});

const ADMIN_STATUSES = Object.freeze([
  "DRAFT",
  "IN_PROGRESS",
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "DISBURSED",
  "REPAID",
]);

const COLUMNS = Object.freeze([
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
]);

// ============================================================================
// WEB APP ENTRY POINTS
// ============================================================================

function doGet() {
  return jsonOut_({
    ok: true,
    service: "Velo Finance LTD — Loan Application API",
    message: "API is running.",
    time: new Date().toISOString(),
  });
}

// NOTE: doPost is intentionally NOT defined here.
// It is defined in ZSecurityNotifications.gs to handle notifications and route to SecurityOverrides.gs.

// ============================================================================
// ONE-TIME SETUP / DIAGNOSTICS
// ============================================================================

function setup() {
  try {
    const result = initializeResources_();
    logSetupResult_(result);
    return result;
  } catch (err) {
    const message = "SETUP FAILED: " + safeErrorMessage_(err);
    Logger.log(message);
    console.error(message);
    if (err && err.stack) console.error(err.stack);
    throw err;
  }
}

/**
 * Run this if the Apps Script UI shows delayed/no logs.
 * The return value appears directly in the execution details.
 */
function setupAndReturnResult() {
  const result = setup();
  return JSON.stringify(result, null, 2);
}

/**
 * Safe diagnostic function. It verifies access without changing application data.
 */
function testSetup() {
  try {
    const ss = getSpreadsheet_();
    const sheet = getSheet_(ss);
    const folder = getDriveRootFolder_();

    const result = {
      ok: true,
      message: "Setup test passed.",
      spreadsheetId: ss.getId(),
      spreadsheetUrl: ss.getUrl(),
      sheetName: sheet.getName(),
      driveFolderId: folder.getId(),
      driveFolderName: folder.getName(),
      driveFolderUrl: folder.getUrl(),
      time: new Date().toISOString(),
    };

    Logger.log(JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    Logger.log("testSetup failed: " + safeErrorMessage_(err));
    console.error(err && err.stack ? err.stack : err);
    throw err;
  }
}

function initializeResources_() {
  const ss = getSpreadsheet_();
  const sheet = getSheet_(ss);
  ensureHeaderRow_(sheet);
  formatSheet_(sheet);

  const folder = getDriveRootFolder_();

  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_KEYS.SPREADSHEET_ID, ss.getId());
  props.setProperty(PROP_KEYS.DRIVE_FOLDER_ID, folder.getId());

  return {
    ok: true,
    message: "Setup complete.",
    spreadsheetId: ss.getId(),
    spreadsheetUrl: ss.getUrl(),
    sheetName: sheet.getName(),
    driveFolderId: folder.getId(),
    driveFolderName: folder.getName(),
    driveFolderUrl: folder.getUrl(),
    time: new Date().toISOString(),
  };
}

function logSetupResult_(result) {
  const lines = [
    "Setup complete.",
    "Spreadsheet URL: " + result.spreadsheetUrl,
    "Sheet name:      " + result.sheetName,
    "Drive folder:    " + result.driveFolderName,
    "Drive folder URL: " + result.driveFolderUrl,
  ];

  lines.forEach(function (line) {
    Logger.log(line);
    console.log(line);
  });
}

// ============================================================================
// APPLICATION ACTIONS
// ============================================================================

function handleSaveDraft(payload) {
  return withScriptLock_(function () {
    const app = validatePayload_(payload);
    normalizeApplication_(app);
    validateLoanTerms_(app, false);

    if (!app.applicationId) {
      app.applicationId = generateDraftId_();
    }

    const ss = getSpreadsheet_();
    const sheet = getSheet_(ss);
    const nowIso = new Date().toISOString();

    if (!app.createdAt) app.createdAt = nowIso;
    app.updatedAt = nowIso;

    const status =
      app.status === "DRAFT" || app.status === "IN_PROGRESS"
        ? app.status
        : "IN_PROGRESS";

    const parentFolder = getDriveRootFolder_();
    const applicantName = getApplicantDisplayName_(app);
    const applicantEmail = getApplicantEmail_(app);
    const hasDocuments = Object.keys(app.documents || {}).some(function (key) {
      return app.documents[key] && app.documents[key].data;
    });
    const applicantFolder =
      applicantEmail || hasDocuments
        ? getOrCreateApplicantFolder_(
            parentFolder,
            app.applicationId,
            applicantName,
            applicantEmail,
          )
        : null;
    const docUrls = applicantFolder
      ? uploadDocuments_(applicantFolder, app)
      : {};

    const rowData = buildRowData_(app, status, {
      lastSectionIndex:
        payload && payload.lastSectionIndex != null
          ? payload.lastSectionIndex
          : app.lastSectionIndex != null
            ? app.lastSectionIndex
            : "",
      driveFolderUrl: applicantFolder ? applicantFolder.getUrl() : "",
      documentUrls: docUrls,
    });
    const rowIdx = findRowByApplicationId_(sheet, app.applicationId);
    assertDraftOwnership_(sheet, rowIdx, app);

    if (rowIdx === -1) {
      sheet.appendRow(rowData);
    } else {
      sheet.getRange(rowIdx, 1, 1, COLUMNS.length).setValues([rowData]);
    }

    SpreadsheetApp.flush();

    return {
      ok: true,
      applicationId: app.applicationId,
      status: status,
      driveFolderUrl: applicantFolder ? applicantFolder.getUrl() : "",
      documentUrls: docUrls,
      message: "Draft saved.",
    };
  });
}

function handleSubmit(payload) {
  return withScriptLock_(function () {
    const app = validatePayload_(payload);
    normalizeApplication_(app);
    validateLoanTerms_(app, true);

    const missing = validateForSubmission_(app);
    if (missing.length) {
      return {
        ok: false,
        error: "Missing required fields: " + missing.join(", "),
        missingFields: missing,
      };
    }

    const ss = getSpreadsheet_();
    const sheet = getSheet_(ss);
    const originalId = app.applicationId;

    // If the application was already submitted, return the existing record rather
    // than creating duplicate Drive folders/files.
    const existingOriginalRow = findRowByApplicationId_(sheet, originalId);
    assertDraftOwnership_(sheet, existingOriginalRow, app);
    if (existingOriginalRow !== -1) {
      const existing = getRowObject_(sheet, existingOriginalRow);
      const existingStatus = String(existing["Application Status"] || "");
      if (
        [
          "SUBMITTED",
          "UNDER_REVIEW",
          "APPROVED",
          "REJECTED",
          "DISBURSED",
          "REPAID",
        ].indexOf(existingStatus) !== -1
      ) {
        return {
          ok: true,
          applicationId: existing["Application ID"],
          status: existingStatus,
          driveFolderUrl: existing["Google Drive Folder URL"] || "",
          documentUrls: {
            identificationDocument: existing["ID Document URL"] || "",
            proofOfAddress: existing["Proof of Address URL"] || "",
            signedAgreement: existing["Signed Agreement URL"] || "",
          },
          message: "Application was already submitted.",
        };
      }
    }

    const finalId = promoteDraftId_(originalId);
    app.applicationId = finalId;
    app.status = "SUBMITTED";
    app.updatedAt = new Date().toISOString();
    app.submittedAt = app.updatedAt;

    const parentFolder = getDriveRootFolder_();
    const applicantName = getApplicantDisplayName_(app);
    const applicantEmail = getApplicantEmail_(app);
    const applicantFolder = getOrCreateApplicantFolder_(
      parentFolder,
      finalId,
      applicantName,
      applicantEmail,
    );

    const docUrls = uploadDocuments_(applicantFolder, app);

    const rowData = buildRowData_(app, "SUBMITTED", {
      driveFolderUrl: applicantFolder.getUrl(),
      documentUrls: docUrls,
    });

    let rowIdx = findRowByApplicationId_(sheet, finalId);
    if (rowIdx === -1 && originalId) {
      rowIdx = findRowByApplicationId_(sheet, originalId);
    }

    if (rowIdx === -1) {
      sheet.appendRow(rowData);
    } else {
      sheet.getRange(rowIdx, 1, 1, COLUMNS.length).setValues([rowData]);
    }

    SpreadsheetApp.flush();

    return {
      ok: true,
      applicationId: finalId,
      status: "SUBMITTED",
      driveFolderUrl: applicantFolder.getUrl(),
      documentUrls: docUrls,
      message: "Application submitted successfully.",
    };
  });
}

function handleLookup(payload) {
  payload = payload || {};

  const email = normalizeEmail_(payload.email);
  const phone = normalizePhone_(payload.phone);

  if (!email && !phone) {
    return { ok: false, found: false, error: "Email or phone required." };
  }

  const sheet = getSheet_(getSpreadsheet_());
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { ok: true, found: false };

  const headers = data[0];
  const indexes = headerIndexes_(headers);

  for (let i = data.length - 1; i >= 1; i--) {
    const row = data[i];

    const rowEmail = normalizeEmail_(valueAt_(row, indexes.email));
    const rowRepEmail = normalizeEmail_(valueAt_(row, indexes.repEmail));
    const rowPhone = normalizePhone_(valueAt_(row, indexes.phone));
    const rowRepPhone = normalizePhone_(valueAt_(row, indexes.repPhone));

    const emailMatch = email && (rowEmail === email || rowRepEmail === email);
    const phoneMatch = phone && (rowPhone === phone || rowRepPhone === phone);

    if (!emailMatch && !phoneMatch) continue;

    const status = String(valueAt_(row, indexes.status) || "DRAFT");
    const id = String(valueAt_(row, indexes.id) || "");

    if (
      [
        "SUBMITTED",
        "UNDER_REVIEW",
        "APPROVED",
        "REJECTED",
        "DISBURSED",
        "REPAID",
      ].indexOf(status) !== -1
    ) {
      return {
        ok: true,
        found: true,
        alreadySubmitted: true,
        applicationId: id,
        status: status,
        message:
          "An application with these details has already been submitted. Reference: " +
          id,
      };
    }

    const applicantTypeRaw = String(
      valueAt_(row, indexes.type) || "PERSONAL",
    ).toUpperCase();
    const applicantType =
      applicantTypeRaw === "BUSINESS" ? "BUSINESS" : "PERSONAL";

    const loanAmount = numberOrZero_(valueAt_(row, indexes.loanAmount));
    const loanTenureRaw = valueAt_(row, indexes.loanTenure);
    const loanTenure =
      loanTenureRaw === "" || loanTenureRaw == null
        ? 30
        : Number(loanTenureRaw) || 30;
    const lastSectionRaw = valueAt_(row, indexes.lastSectionIndex);
    const lastSectionIndex =
      lastSectionRaw === "" || lastSectionRaw == null
        ? null
        : Number(lastSectionRaw) || 0;

    const application = {
      applicationId: id,
      applicantType: applicantType,
      status: status,
      lastSectionIndex: lastSectionIndex,

      personalInfo: {
        fullName: String(valueAt_(row, indexes.name) || ""),
        dateOfBirth: toIsoString_(valueAt_(row, indexes.dob)),
        phone: String(valueAt_(row, indexes.phone) || ""),
        email: String(valueAt_(row, indexes.email) || ""),
        residentialAddress: String(valueAt_(row, indexes.address) || ""),
        state: String(valueAt_(row, indexes.state) || ""),
        lga: String(valueAt_(row, indexes.lga) || ""),
      },
      personalFinancial: {
        employmentStatus: String(valueAt_(row, indexes.employmentStatus) || ""),
        employerBusinessName: String(valueAt_(row, indexes.employerName) || ""),
        monthlyIncome: String(valueAt_(row, indexes.monthlyIncome) || ""),
        monthlyExpenses: String(valueAt_(row, indexes.monthlyExpenses) || ""),
        existingLoanObligations: String(
          valueAt_(row, indexes.existingLoans) || "",
        ),
        expectedRepaymentSource: String(
          valueAt_(row, indexes.repaymentSource) || "",
        ),
      },

      businessInfo: {
        businessName: String(valueAt_(row, indexes.businessName) || ""),
        businessRegistrationNumber: String(
          valueAt_(row, indexes.businessRegNo) || "",
        ),
        businessType: String(valueAt_(row, indexes.businessType) || ""),
        businessAddress: String(valueAt_(row, indexes.businessAddress) || ""),
        businessIndustry: String(valueAt_(row, indexes.businessIndustry) || ""),
        yearsInBusiness: String(valueAt_(row, indexes.yearsInBusiness) || ""),
      },
      businessRep: {
        fullName: String(valueAt_(row, indexes.repName) || ""),
        position: String(valueAt_(row, indexes.repPosition) || ""),
        phone: String(valueAt_(row, indexes.repPhone) || ""),
        email: String(valueAt_(row, indexes.repEmail) || ""),
        residentialAddress: String(valueAt_(row, indexes.repAddress) || ""),
      },
      businessFinancial: {
        averageMonthlyRevenue: String(
          valueAt_(row, indexes.businessRevenue) || "",
        ),
        averageMonthlyExpenses: String(
          valueAt_(row, indexes.businessExpenses) || "",
        ),
        existingLoanObligations: String(
          valueAt_(row, indexes.existingLoans) || "",
        ),
        expectedRepaymentSource: String(
          valueAt_(row, indexes.repaymentSource) || "",
        ),
      },

      kyc: {
        bvn: String(valueAt_(row, indexes.bvn) || ""),
        nin: String(valueAt_(row, indexes.nin) || ""),
        identificationType: String(valueAt_(row, indexes.idType) || ""),
        identificationNumber: String(valueAt_(row, indexes.idNumber) || ""),
      },

      loanRequest: {
        amount: loanAmount,
        tenure: loanTenure,
        purpose: String(valueAt_(row, indexes.loanPurpose) || ""),
      },
      collateral: {
        provided: Boolean(valueAt_(row, indexes.collateralType)),
        type: String(valueAt_(row, indexes.collateralType) || ""),
        description: String(valueAt_(row, indexes.collateralDescription) || ""),
        estimatedValue: String(valueAt_(row, indexes.collateralValue) || ""),
        ownership: String(valueAt_(row, indexes.collateralOwnership) || ""),
        location: String(valueAt_(row, indexes.collateralLocation) || ""),
        documentReference: String(
          valueAt_(row, indexes.collateralReference) || "",
        ),
      },
      calculation: {
        loanAmount: loanAmount,
        tenure: loanTenure,
        interest: numberOrZero_(valueAt_(row, indexes.interest)),
        serviceFee: numberOrZero_(valueAt_(row, indexes.serviceFee)),
        processingFee: numberOrZero_(valueAt_(row, indexes.processingFee)),
        otherFees: numberOrZero_(valueAt_(row, indexes.otherFees)),
        lateFee: numberOrZero_(valueAt_(row, indexes.otherFees)),
        totalFees: numberOrZero_(valueAt_(row, indexes.totalFees)),
        totalRepayment: numberOrZero_(valueAt_(row, indexes.totalRepayment)),
        disbursementDate: toIsoString_(valueAt_(row, indexes.disbursementDate)),
        repaymentDate: toIsoString_(valueAt_(row, indexes.repaymentDate)),
      },
      documents: valueAt_(row, indexes.collateralMediaUrl)
        ? {
            collateralMedia: {
              slot: "collateralMedia",
              name: "Collateral evidence",
              type: "",
              size: 0,
              data: "",
              status: "uploaded",
              driveUrl: String(valueAt_(row, indexes.collateralMediaUrl)),
            },
          }
        : {},
      agreement: {
        generatedAt: null,
        generatedHtml: null,
        signedAgreementAccepted: !!valueAt_(row, indexes.signedAgreeUrl),
      },
      createdAt: toIsoString_(valueAt_(row, indexes.createdAt)),
      updatedAt: toIsoString_(valueAt_(row, indexes.updatedAt)),
      submittedAt: toIsoString_(valueAt_(row, indexes.submittedAt)) || null,
    };

    return {
      ok: true,
      found: true,
      alreadySubmitted: false,
      lastSectionIndex: lastSectionIndex,
      application: application,
      message: "Draft found — restoring your full saved progress.",
    };
  }

  return { ok: true, found: false, message: "No draft application found." };
}

// ============================================================================
// SPREADSHEET / DRIVE HELPERS
// ============================================================================

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const candidates = uniqueNonEmpty_([
    props.getProperty(PROP_KEYS.SPREADSHEET_ID),
    CONFIG.SPREADSHEET_ID,
  ]);

  for (let i = 0; i < candidates.length; i++) {
    try {
      const ss = SpreadsheetApp.openById(candidates[i]);
      props.setProperty(PROP_KEYS.SPREADSHEET_ID, ss.getId());
      return ss;
    } catch (err) {
      console.warn(
        "Unable to open configured spreadsheet ID: " + candidates[i],
      );
    }
  }

  // Reuse an existing spreadsheet with the configured name if available.
  const files = DriveApp.getFilesByName(CONFIG.SPREADSHEET_NAME);
  while (files.hasNext()) {
    const file = files.next();
    if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
      try {
        const ss = SpreadsheetApp.openById(file.getId());
        props.setProperty(PROP_KEYS.SPREADSHEET_ID, ss.getId());
        return ss;
      } catch (ignored) {}
    }
  }

  const ss = SpreadsheetApp.create(CONFIG.SPREADSHEET_NAME);
  props.setProperty(PROP_KEYS.SPREADSHEET_ID, ss.getId());
  return ss;
}

function getSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    // Reuse the default empty sheet where possible so setup does not leave an
    // unnecessary Sheet1 tab.
    const sheets = ss.getSheets();
    if (
      sheets.length === 1 &&
      sheets[0].getLastRow() === 0 &&
      sheets[0].getLastColumn() === 0
    ) {
      sheet = sheets[0];
      sheet.setName(CONFIG.SHEET_NAME);
    } else {
      sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    }
  }
  ensureHeaderRow_(sheet);
  return sheet;
}

function ensureHeaderRow_(sheet) {
  const currentLastColumn = Math.max(sheet.getLastColumn(), COLUMNS.length);
  const firstRow = sheet.getRange(1, 1, 1, currentLastColumn).getValues()[0];
  const hasAnyHeader = firstRow.some(function (v) {
    return String(v || "").trim() !== "";
  });

  if (!hasAnyHeader) {
    sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS.slice()]);
    return;
  }

  // Add newly introduced columns to the right without destroying existing data.
  const existingHeaders = firstRow.map(function (v) {
    return String(v || "").trim();
  });
  const missingColumns = COLUMNS.filter(function (column) {
    return existingHeaders.indexOf(column) === -1;
  });

  if (missingColumns.length) {
    const startCol = sheet.getLastColumn() + 1;
    sheet
      .getRange(1, startCol, 1, missingColumns.length)
      .setValues([missingColumns]);
  }
}

function formatSheet_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), COLUMNS.length);
  sheet.setFrozenRows(1);
  sheet
    .getRange(1, 1, 1, lastCol)
    .setFontWeight("bold")
    .setBackground("#2196F3")
    .setFontColor("#FFFFFF");

  sheet
    .getRange(1, 1, Math.max(sheet.getLastRow(), 1), lastCol)
    .setVerticalAlignment("middle");
  sheet.autoResizeColumns(1, lastCol);
}

function getDriveRootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const candidates = uniqueNonEmpty_([
    props.getProperty(PROP_KEYS.DRIVE_FOLDER_ID),
    CONFIG.DRIVE_PARENT_FOLDER_ID,
  ]);

  for (let i = 0; i < candidates.length; i++) {
    try {
      const folder = DriveApp.getFolderById(candidates[i]);
      // Force a permission/access check.
      folder.getName();
      props.setProperty(PROP_KEYS.DRIVE_FOLDER_ID, folder.getId());
      return folder;
    } catch (err) {
      console.warn(
        "Unable to open configured Drive folder ID: " + candidates[i],
      );
    }
  }

  const folders = DriveApp.getFoldersByName(CONFIG.DRIVE_PARENT_FOLDER_NAME);
  if (folders.hasNext()) {
    const folder = folders.next();
    props.setProperty(PROP_KEYS.DRIVE_FOLDER_ID, folder.getId());
    return folder;
  }

  const folder = DriveApp.createFolder(CONFIG.DRIVE_PARENT_FOLDER_NAME);
  props.setProperty(PROP_KEYS.DRIVE_FOLDER_ID, folder.getId());
  return folder;
}

function findRowByApplicationId_(sheet, id) {
  if (!id || sheet.getLastRow() < 2) return -1;

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === String(id).trim()) return i + 2;
  }
  return -1;
}

function getRowObject_(sheet, rowNumber) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = sheet
    .getRange(rowNumber, 1, 1, sheet.getLastColumn())
    .getValues()[0];
  return rowToObject_(row, headers);
}

// ============================================================================
// ROW MAPPING
// ============================================================================

function buildRowData_(app, status, opts) {
  opts = opts || {};
  const nowIso = new Date().toISOString();

  const calc = app.calculation || {};
  const personalInfo = app.personalInfo || {};
  const personalFinancial = app.personalFinancial || {};
  const businessInfo = app.businessInfo || {};
  const businessRep = app.businessRep || {};
  const businessFinancial = app.businessFinancial || {};
  const kyc = app.kyc || {};
  const loanRequest = app.loanRequest || {};
  const docUrls = opts.documentUrls || {};

  const row = {};

  row["Application ID"] = app.applicationId || "";
  row["Applicant Type"] = app.applicantType || "";
  row["Application Status"] = status || app.status || "IN_PROGRESS";
  row["Date Created"] = app.createdAt || nowIso;
  row["Date Last Updated"] = app.updatedAt || nowIso;
  row["Date Submitted"] =
    status === "SUBMITTED" ? app.submittedAt || nowIso : app.submittedAt || "";

  row["Full Name"] = personalInfo.fullName || "";
  row["Date of Birth"] = firstNonEmpty_(
    personalInfo.dateOfBirth,
    businessRep.dateOfBirth,
  );
  row["Phone"] = personalInfo.phone || "";
  row["Email"] = personalInfo.email || "";
  row["Residential Address"] = personalInfo.residentialAddress || "";
  row["State"] = personalInfo.state || "";
  row["LGA"] = personalInfo.lga || "";

  row["Business Name"] = businessInfo.businessName || "";
  row["Business Registration Number"] =
    businessInfo.businessRegistrationNumber || "";
  row["Business Type"] = businessInfo.businessType || "";
  row["Business Address"] = businessInfo.businessAddress || "";
  row["Business Industry"] = businessInfo.businessIndustry || "";
  row["Years in Business"] = businessInfo.yearsInBusiness || "";

  row["Representative Name"] = businessRep.fullName || "";
  row["Representative Position"] = businessRep.position || "";
  row["Representative Phone"] = businessRep.phone || "";
  row["Representative Email"] = businessRep.email || "";
  row["Representative Address"] = businessRep.residentialAddress || "";

  row["BVN"] = kyc.bvn || "";
  row["NIN"] = kyc.nin || "";
  row["ID Type"] = kyc.identificationType || "";
  row["ID Number"] = kyc.identificationNumber || "";

  row["Employment Status"] = personalFinancial.employmentStatus || "";
  row["Employer/Business Name"] = personalFinancial.employerBusinessName || "";
  row["Monthly Income"] = numberOrBlank_(personalFinancial.monthlyIncome);
  row["Monthly Expenses"] = numberOrBlank_(personalFinancial.monthlyExpenses);
  row["Business Revenue"] = numberOrBlank_(
    businessFinancial.averageMonthlyRevenue,
  );
  row["Business Expenses"] = numberOrBlank_(
    businessFinancial.averageMonthlyExpenses,
  );
  row["Existing Loan Obligations"] = firstNonEmpty_(
    personalFinancial.existingLoanObligations,
    businessFinancial.existingLoanObligations,
  );
  row["Expected Repayment Source"] = firstNonEmpty_(
    personalFinancial.expectedRepaymentSource,
    businessFinancial.expectedRepaymentSource,
  );

  row["Loan Amount"] = numberOrZero_(
    calc.loanAmount != null ? calc.loanAmount : loanRequest.amount,
  );
  row["Loan Tenure"] = calc.tenure || loanRequest.tenure || "";
  row["Loan Purpose"] = loanRequest.purpose || "";
  const collateral = app.collateral || {};
  row["Collateral Type"] = collateral.type || "";
  row["Collateral Description"] = collateral.description || "";
  row["Collateral Value"] = collateral.estimatedValue || "";
  row["Collateral Ownership"] = collateral.ownership || "";
  row["Collateral Location"] = collateral.location || "";
  row["Collateral Reference"] = collateral.documentReference || "";
  row["Interest"] = numberOrZero_(calc.interest);
  row["Service Fee"] = numberOrZero_(calc.serviceFee);
  row["Processing Fee"] = numberOrZero_(calc.processingFee);
  row["Other Fees"] = numberOrZero_(
    calc.otherFees != null ? calc.otherFees : calc.lateFee,
  );
  row["Total Fees"] = numberOrZero_(calc.totalFees);
  row["Total Repayment"] = numberOrZero_(calc.totalRepayment);
  row["Disbursement Date"] = calc.disbursementDate || "";
  row["Repayment Date"] = calc.repaymentDate || "";

  row["Google Drive Folder URL"] = opts.driveFolderUrl || "";
  row["ID Document URL"] = docUrls.identificationDocument || "";
  row["Proof of Address URL"] = docUrls.proofOfAddress || "";
  row["Collateral Media URL"] = docUrls.collateralMedia || "";
  row["Signed Agreement URL"] = docUrls.signedAgreement || "";

  row["Last Section Index"] =
    opts.lastSectionIndex != null ? opts.lastSectionIndex : "";

  return COLUMNS.map(function (column) {
    return Object.prototype.hasOwnProperty.call(row, column) ? row[column] : "";
  });
}

// ============================================================================
// DOCUMENT UPLOAD
// ============================================================================

function handleUploadDocument_(payload) {
  const mime = normalizeMime_(payload.mimeType);
  if (CONFIG.ALLOWED_MIME.indexOf(mime) === -1)
    throw new Error("Disallowed file type: " + (payload.mimeType || "unknown"));
  const data = stripDataUrlPrefix_(String(payload.data || ""));
  if (!data) throw new Error("Empty document received.");
  const bytes = Utilities.base64Decode(data);
  if (!bytes || !bytes.length) throw new Error("Empty document received.");
  if (bytes.length > CONFIG.MAX_FILE_SIZE_BYTES)
    throw new Error("File exceeds the 10 MB upload limit.");
  const root = getDriveRootFolder_();
  const segments = String(payload.path || "")
    .split("/")
    .map(sanitizeDriveName_)
    .filter(Boolean);
  let folder = root;
  segments.forEach(function (segment) {
    const matches = folder.getFoldersByName(segment);
    folder = matches.hasNext() ? matches.next() : folder.createFolder(segment);
  });
  const filename = sanitizeDriveName_(String(payload.filename || "document"));
  trashFilesByName_(folder, filename);
  const file = folder.createFile(Utilities.newBlob(bytes, mime, filename));
  file.setDescription(
    "Velo Finance " +
      String(payload.documentType || "document") +
      " for user " +
      String(payload.userId || ""),
  );
  return { ok: true, fileId: file.getId(), filename: file.getName() };
}

function uploadDocuments_(folder, app) {
  const docs = app.documents || {};
  const urls = {};

  const slots = [
    { key: "identificationDocument", baseName: "Identification Document" },
    { key: "proofOfAddress", baseName: "Proof of Address" },
    { key: "collateralMedia", baseName: "Collateral Evidence" },
    { key: "signedAgreement", baseName: "Signed Agreement" },
  ];

  slots.forEach(function (slot) {
    const doc = docs[slot.key];
    if (!doc || !doc.data) return;

    const mime = normalizeMime_(doc.type);
    if (CONFIG.ALLOWED_MIME.indexOf(mime) === -1) {
      throw new Error(
        "Disallowed file type for " + slot.key + ": " + (doc.type || "unknown"),
      );
    }

    let bytes;
    try {
      bytes = Utilities.base64Decode(stripDataUrlPrefix_(doc.data));
    } catch (err) {
      throw new Error("Invalid base64 data for " + slot.key + ".");
    }

    if (!bytes || !bytes.length) {
      throw new Error("Empty document received for " + slot.key + ".");
    }

    if (bytes.length > CONFIG.MAX_FILE_SIZE_BYTES) {
      throw new Error(
        "File too large for " +
          slot.key +
          ": " +
          (bytes.length / 1024 / 1024).toFixed(1) +
          " MB. Maximum is 10 MB.",
      );
    }

    const extension = extensionForMime_(mime, doc.name);
    const safeName = slot.baseName + extension;

    // Replace a previous file with the same logical name to keep retries idempotent.
    trashFilesByName_(folder, safeName);

    const blob = Utilities.newBlob(bytes, mime, safeName);
    const file = folder.createFile(blob);
    file.setDescription(
      "Velo Finance loan application " + app.applicationId + " — " + slot.key,
    );

    // IMPORTANT: intentionally do NOT call setSharing(ANYONE_WITH_LINK).
    // KYC/loan documents remain private to users who already have Drive access.
    urls[slot.key] = file.getUrl();
  });

  return urls;
}

function getOrCreateApplicantFolder_(
  parentFolder,
  applicationId,
  applicantName,
  applicantEmail,
) {
  const safeApplicantName = sanitizeDriveName_(applicantName || "Applicant");
  const safeApplicantEmail = sanitizeDriveName_(applicantEmail || "");
  const folderName = sanitizeDriveName_(
    safeApplicantName +
      (safeApplicantEmail ? " - " + safeApplicantEmail : " - " + applicationId),
  );

  const folders = parentFolder.getFoldersByName(folderName);
  if (folders.hasNext()) return folders.next();

  return parentFolder.createFolder(folderName);
}

function trashFilesByName_(folder, name) {
  const files = folder.getFilesByName(name);
  while (files.hasNext()) {
    try {
      files.next().setTrashed(true);
    } catch (ignored) {}
  }
}

// ============================================================================
// VALIDATION / NORMALIZATION
// ============================================================================

function getLoanRules_(applicantType) {
  const overrides = getAdminConfig_();
  const program =
    overrides.loanPrograms &&
    overrides.loanPrograms[String(applicantType || "PERSONAL").toUpperCase()];
  const source = program || overrides;
  const limits = Object.assign(
    { min: 100000, max: 30000000, defaultAmount: 3000000 },
    source.loanLimits || {},
  );
  const tenures = (
    source.tenures ||
    [30, 60, 90, 180].map(function (value) {
      return { value: value, label: value + " Days" };
    })
  )
    .map(function (item) {
      return Number(item.value);
    })
    .filter(function (value) {
      return Number.isFinite(value) && value > 0;
    });
  const defaults = {
    interest: { type: "percentage", value: 5, includeUpfront: true },
    serviceFee: { type: "percentage", value: 2, includeUpfront: true },
    processingFee: { type: "flat", value: 5000, includeUpfront: true },
    lateFee: { type: "percentage", value: 5, includeUpfront: false },
  };
  const fees = Object.assign({}, defaults, source.fees || {});
  return {
    limits: limits,
    tenures: tenures,
    fees: fees,
    tenureFees: source.tenureFees || {},
  };
}

function backendFee_(amount, fee) {
  if (!fee) return 0;
  return Math.round(
    fee.type === "percentage"
      ? (amount * Number(fee.value || 0)) / 100
      : Number(fee.value || 0),
  );
}

function calculateBackendLoan_(amount, tenure, now, applicantType) {
  const rules = getLoanRules_(applicantType);
  const safeAmount = Math.round(Number(amount));
  const safeTenure = Number(tenure);
  const override = rules.tenureFees[safeTenure] || {};
  const fees = Object.assign({}, rules.fees, override);
  const interest =
    fees.interest && fees.interest.type === "percentage"
      ? Math.round(backendFee_(safeAmount, fees.interest) * safeTenure)
      : backendFee_(safeAmount, fees.interest);
  const serviceFee = backendFee_(safeAmount, fees.serviceFee);
  const processingFee = backendFee_(safeAmount, fees.processingFee);
  const lateFee = backendFee_(safeAmount, fees.lateFee);
  const totalFees =
    (fees.interest.includeUpfront ? interest : 0) +
    (fees.serviceFee.includeUpfront ? serviceFee : 0) +
    (fees.processingFee.includeUpfront ? processingFee : 0) +
    (fees.lateFee.includeUpfront ? lateFee : 0);
  const disbursement = now || new Date();
  const repayment = new Date(disbursement.getTime());
  repayment.setDate(repayment.getDate() + safeTenure);
  return {
    loanAmount: safeAmount,
    interest: interest,
    serviceFee: serviceFee,
    processingFee: processingFee,
    lateFee: lateFee,
    totalFees: totalFees,
    totalRepayment: safeAmount + totalFees,
    upfrontFees: totalFees,
    loanCost: interest,
    defaultFee: lateFee,
    tenure: safeTenure,
    tenureLabel: safeTenure + " Days",
    disbursementDate: disbursement.toISOString(),
    repaymentDate: repayment.toISOString(),
  };
}

function validateLoanTerms_(app, requirePurpose) {
  const request = app.loanRequest || {};
  const rules = getLoanRules_(app.applicantType);
  const amount = Number(request.amount);
  const tenure = Number(request.tenure);
  if (
    !Number.isFinite(amount) ||
    amount < Number(rules.limits.min) ||
    amount > Number(rules.limits.max)
  )
    throw new Error(
      "Loan amount must be between " +
        Number(rules.limits.min).toLocaleString() +
        " and " +
        Number(rules.limits.max).toLocaleString() +
        ".",
    );
  if (
    !rules.tenures.some(function (value) {
      return value === tenure;
    })
  )
    throw new Error("Selected loan tenure is not available.");
  if (requirePurpose && String(request.purpose || "").trim().length < 10)
    throw new Error("Loan purpose must be at least 10 characters.");
  const adminConfig = getAdminConfig_();
  const program =
    adminConfig.loanPrograms &&
    adminConfig.loanPrograms[
      String(app.applicantType || "PERSONAL").toUpperCase()
    ];
  const collateralRules = program && program.collateral;
  const collateral = app.collateral || {};
  if (collateralRules && collateralRules.enabled && collateralRules.required) {
    if (
      !collateral.type ||
      !collateral.description ||
      !collateral.estimatedValue ||
      !collateral.ownership ||
      !collateral.location ||
      !app.documents ||
      !app.documents.collateralMedia ||
      !app.documents.collateralMedia.data
    )
      throw new Error(
        "Collateral details and supporting media are required for this loan type.",
      );
  }
  app.loanRequest.amount = Math.round(amount);
  app.loanRequest.tenure = tenure;
  app.calculation = calculateBackendLoan_(
    amount,
    tenure,
    new Date(),
    app.applicantType,
  );
}

function validatePayload_(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid payload: expected an application object.");
  }

  // saveDraft may generate an ID, but submit must have a source ID. To preserve
  // frontend compatibility, allow empty ID here and validate at submission time.
  return payload;
}

function assertDraftOwnership_(sheet, rowIdx, app) {
  if (rowIdx === -1) return;
  const existing = getRowObject_(sheet, rowIdx);
  const existingStatus = String(
    existing["Application Status"] || "",
  ).toUpperCase();
  if (
    [
      "SUBMITTED",
      "UNDER_REVIEW",
      "APPROVED",
      "REJECTED",
      "DISBURSED",
      "REPAID",
    ].indexOf(existingStatus) !== -1
  )
    throw new Error("This application can no longer be changed.");
  const personal = app.personalInfo || {};
  const representative = app.businessRep || {};
  const incomingEmail = normalizeEmail_(personal.email || representative.email);
  const incomingPhone = normalizePhone_(personal.phone || representative.phone);
  const storedEmail = normalizeEmail_(
    existing["Email"] || existing["Representative Email"],
  );
  const storedPhone = normalizePhone_(
    existing["Phone"] || existing["Representative Phone"],
  );
  const storedDob = String(existing["Date of Birth"] || "").slice(0, 10);
  const incomingDob = String(
    personal.dateOfBirth || representative.dateOfBirth || "",
  ).slice(0, 10);
  if (
    (storedEmail && incomingEmail !== storedEmail) ||
    (storedPhone && incomingPhone !== storedPhone) ||
    (storedDob && incomingDob && incomingDob !== storedDob)
  )
    throw new Error("Application ownership could not be verified.");
}

function validateForSubmission_(app) {
  const missing = [];

  if (!app.applicationId) missing.push("applicationId");
  if (!app.applicantType) missing.push("applicantType");

  if (app.applicantType === "PERSONAL") {
    requireField_(missing, app.personalInfo, "fullName", "fullName");
    requireField_(missing, app.personalInfo, "phone", "phone");
    requireField_(missing, app.personalInfo, "email", "email");
  } else if (app.applicantType === "BUSINESS") {
    requireField_(missing, app.businessInfo, "businessName", "businessName");
    requireField_(missing, app.businessRep, "fullName", "rep.fullName");
    requireField_(missing, app.businessRep, "phone", "rep.phone");
    requireField_(missing, app.businessRep, "email", "rep.email");
  } else if (app.applicantType) {
    missing.push("valid applicantType (PERSONAL or BUSINESS)");
  }

  requireField_(missing, app.kyc, "bvn", "bvn");
  requireField_(missing, app.kyc, "nin", "nin");
  requireField_(missing, app.loanRequest, "amount", "loanAmount");
  requireField_(missing, app.loanRequest, "tenure", "tenure");

  requireDocument_(
    missing,
    app.documents,
    "identificationDocument",
    "identificationDocument",
  );
  requireDocument_(missing, app.documents, "proofOfAddress", "proofOfAddress");
  requireDocument_(
    missing,
    app.documents,
    "signedAgreement",
    "signedAgreement",
  );

  if (!app.agreement || app.agreement.signedAgreementAccepted !== true) {
    missing.push("agreementConsent");
  }

  return missing;
}

function normalizeApplication_(app) {
  if (app.applicantType)
    app.applicantType = String(app.applicantType).trim().toUpperCase();
  if (app.status) app.status = String(app.status).trim().toUpperCase();

  if (app.personalInfo) {
    if (app.personalInfo.email)
      app.personalInfo.email = normalizeEmail_(app.personalInfo.email);
    if (app.personalInfo.phone)
      app.personalInfo.phone = String(app.personalInfo.phone).trim();
  }

  if (app.businessRep) {
    if (app.businessRep.email)
      app.businessRep.email = normalizeEmail_(app.businessRep.email);
    if (app.businessRep.phone)
      app.businessRep.phone = String(app.businessRep.phone).trim();
  }

  return app;
}

function requireField_(missing, obj, key, label) {
  if (
    !obj ||
    obj[key] === undefined ||
    obj[key] === null ||
    String(obj[key]).trim() === ""
  ) {
    missing.push(label);
  }
}

function requireDocument_(missing, docs, key, label) {
  if (!docs || !docs[key] || !docs[key].data) missing.push(label);
}

// ============================================================================
// APPLICATION ID GENERATION
// ============================================================================

function generateDraftId_() {
  return generateApplicationId_("DRAFT");
}

function generateFinalId_() {
  return generateApplicationId_("LN");
}

function promoteDraftId_(draftId) {
  const value = String(draftId || "").trim();
  if (!value) return generateFinalId_();

  const draftMatch = /^VEL-DRAFT-(\d{4})-(\d{6,})$/i.exec(value);
  if (draftMatch) {
    return "VEL-LN-" + draftMatch[1] + "-" + draftMatch[2];
  }

  if (/^VEL-LN-\d{4}-\d{6,}$/i.test(value)) {
    return value.toUpperCase();
  }

  return generateFinalId_();
}

function generateApplicationId_(type) {
  // Callers that persist applications already hold the script lock. Keeping the
  // sequence update itself lock-free avoids trying to acquire the same script
  // lock recursively.
  const now = new Date();
  const year = now.getFullYear();
  const props = PropertiesService.getScriptProperties();
  const key = PROP_KEYS.APPLICATION_SEQUENCE + "_" + year;
  const current = parseInt(props.getProperty(key) || "0", 10) || 0;
  const next = current + 1;
  props.setProperty(key, String(next));

  const seq = String(next).padStart(6, "0");
  return "VEL-" + type + "-" + year + "-" + seq;
}

// ============================================================================
// ADMIN AUTHENTICATION
// ============================================================================

/**
 * Run manually from the Apps Script editor, e.g.
 *   setAdminPassword('a-strong-password-here')
 */
function setAdminPassword(newPassword) {
  if (!newPassword || String(newPassword).length < 10) {
    throw new Error("Admin password must be at least 10 characters.");
  }

  PropertiesService.getScriptProperties().setProperty(
    PROP_KEYS.ADMIN_PASSWORD,
    String(newPassword),
  );

  Logger.log("Admin password updated successfully.");
  console.log("Admin password updated successfully.");
  return true;
}

// Backward-compatible alias for your previous helper name.
function setAdminPassword_(newPassword) {
  return setAdminPassword(newPassword);
}

function setAdminEmail(email) {
  const value = String(email || "")
    .trim()
    .toLowerCase();
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value))
    throw new Error("A valid administrator email is required.");
  PropertiesService.getScriptProperties().setProperty(
    "VELO_ADMIN_EMAIL",
    value,
  );
  return true;
}

function getAdminPassword_() {
  return (
    PropertiesService.getScriptProperties().getProperty(
      PROP_KEYS.ADMIN_PASSWORD,
    ) || CONFIG.ADMIN_PASSWORD
  );
}

function handleAdminLogin(payload) {
  const password = String((payload && payload.password) || "");
  const expected = String(getAdminPassword_() || "");

  if (!password) return { ok: false, error: "Password required." };
  if (!expected)
    return { ok: false, error: "Admin password has not been configured." };

  if (!constantTimeEquals_(password, expected)) {
    Utilities.sleep(350);
    return { ok: false, error: "Invalid password." };
  }

  const token = issueAdminToken_();
  return {
    ok: true,
    token: token,
    expiresIn: CONFIG.ADMIN_TOKEN_TTL_MS,
    message: "Logged in.",
  };
}

function issueAdminToken_() {
  const token = Utilities.getUuid() + "-" + Utilities.getUuid();
  const key = "VELO_ADMIN_TOKEN_" + token;

  PropertiesService.getScriptProperties().setProperty(
    key,
    JSON.stringify({
      issuedAt: Date.now(),
    }),
  );

  return token;
}

function isValidAdminToken_(token) {
  if (!token) return false;

  const key = "VELO_ADMIN_TOKEN_" + token;
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(key);
  if (!raw) return false;

  try {
    const data = JSON.parse(raw);
    if (
      !data.issuedAt ||
      Date.now() - Number(data.issuedAt) > CONFIG.ADMIN_TOKEN_TTL_MS
    ) {
      props.deleteProperty(key);
      return false;
    }
    return true;
  } catch (err) {
    props.deleteProperty(key);
    return false;
  }
}

function requireAdmin_(payload, handler) {
  if (!payload || !isValidAdminToken_(payload.adminToken)) {
    return {
      ok: false,
      error: "Unauthorized. Please log in again.",
      code: "UNAUTHORIZED",
    };
  }

  const clean = Object.assign({}, payload);
  delete clean.adminToken;
  return handler(clean);
}

// ============================================================================
// ADMIN ACTIONS
// ============================================================================

function handleGetConfig() {
  return { ok: true, config: getAdminConfig_() };
}

function handleAdminSaveConfig(payload) {
  const previous = getAdminConfig_();
  const config = normalizeAdminConfig_(payload && payload.config);
  ["adminEmails", "loanManagerEmails", "loanManagers"].forEach(function (key) {
    if (config[key] === undefined && previous[key] !== undefined)
      config[key] = previous[key];
  });
  PropertiesService.getScriptProperties().setProperty(
    PROP_KEYS.ADMIN_CONFIG,
    JSON.stringify(config),
  );
  return { ok: true, config: config };
}

function handleAdminResetConfig() {
  const previous = getAdminConfig_();
  const preserved = {};
  ["adminEmails", "loanManagerEmails", "loanManagers"].forEach(function (key) {
    if (previous[key] !== undefined) preserved[key] = previous[key];
  });
  if (Object.keys(preserved).length)
    PropertiesService.getScriptProperties().setProperty(
      PROP_KEYS.ADMIN_CONFIG,
      JSON.stringify(preserved),
    );
  else
    PropertiesService.getScriptProperties().deleteProperty(
      PROP_KEYS.ADMIN_CONFIG,
    );
  return { ok: true };
}

function getAdminConfig_() {
  const raw = PropertiesService.getScriptProperties().getProperty(
    PROP_KEYS.ADMIN_CONFIG,
  );
  if (!raw) return {};
  try {
    return normalizeAdminConfig_(JSON.parse(raw));
  } catch (err) {
    return {};
  }
}

function normalizeAdminConfig_(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const result = {};
  const limits = input.loanLimits;
  if (limits && typeof limits === "object" && !Array.isArray(limits)) {
    const loanLimits = {};
    ["min", "max", "defaultAmount"].forEach(function (key) {
      const value = Number(limits[key]);
      if (Number.isFinite(value) && value >= 0 && value <= 1000000000)
        loanLimits[key] = Math.round(value);
    });
    if (Object.keys(loanLimits).length) result.loanLimits = loanLimits;
  }
  if (Array.isArray(input.tenures)) {
    const tenures = input.tenures
      .map(function (item) {
        const value = Number(item && item.value);
        return Number.isFinite(value) && value > 0 && value <= 3650
          ? { value: Math.round(value), label: Math.round(value) + " Days" }
          : null;
      })
      .filter(function (item) {
        return item !== null;
      });
    if (tenures.length) result.tenures = tenures;
  }
  const feeKeys = ["interest", "serviceFee", "processingFee", "lateFee"];
  function normalizeFee(fee) {
    if (!fee || typeof fee !== "object" || Array.isArray(fee)) return null;
    const type =
      fee.type === "flat" || fee.type === "percentage" ? fee.type : null;
    const value = Number(fee.value);
    if (
      !type ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > (type === "percentage" ? 100 : 1000000000)
    )
      return null;
    return {
      type: type,
      value: value,
      includeUpfront: fee.includeUpfront === true,
    };
  }
  if (
    input.fees &&
    typeof input.fees === "object" &&
    !Array.isArray(input.fees)
  ) {
    const fees = {};
    feeKeys.forEach(function (key) {
      const fee = normalizeFee(input.fees[key]);
      if (fee) fees[key] = fee;
    });
    if (Object.keys(fees).length) result.fees = fees;
  }
  if (
    input.tenureFees &&
    typeof input.tenureFees === "object" &&
    !Array.isArray(input.tenureFees)
  ) {
    const tenureFees = {};
    Object.keys(input.tenureFees).forEach(function (days) {
      const tenure = Number(days);
      const candidate = input.tenureFees[days];
      if (
        !Number.isFinite(tenure) ||
        tenure <= 0 ||
        tenure > 3650 ||
        !candidate ||
        typeof candidate !== "object"
      )
        return;
      const fees = {};
      feeKeys.forEach(function (key) {
        const fee = normalizeFee(candidate[key]);
        if (fee) fees[key] = fee;
      });
      if (Object.keys(fees).length) tenureFees[Math.round(tenure)] = fees;
    });
    if (Object.keys(tenureFees).length) result.tenureFees = tenureFees;
  }
  if (
    input.loanPrograms &&
    typeof input.loanPrograms === "object" &&
    !Array.isArray(input.loanPrograms)
  ) {
    const programs = {};
    ["PERSONAL", "BUSINESS"].forEach(function (type) {
      const candidate = input.loanPrograms[type];
      if (!candidate || typeof candidate !== "object") return;
      const program = {};
      if (candidate.loanLimits && typeof candidate.loanLimits === "object") {
        const limits = {};
        ["min", "max", "defaultAmount"].forEach(function (key) {
          const value = Number(candidate.loanLimits[key]);
          if (Number.isFinite(value) && value >= 0 && value <= 1000000000)
            limits[key] = Math.round(value);
        });
        if (Object.keys(limits).length) program.loanLimits = limits;
      }
      if (Array.isArray(candidate.tenures)) {
        const tenures = candidate.tenures
          .map(function (item) {
            const value = Number(item && item.value);
            return Number.isFinite(value) && value > 0 && value <= 3650
              ? { value: Math.round(value), label: Math.round(value) + " Days" }
              : null;
          })
          .filter(function (item) {
            return item !== null;
          });
        if (tenures.length) program.tenures = tenures;
      }
      const fees = {};
      feeKeys.forEach(function (key) {
        const fee = normalizeFee(candidate.fees && candidate.fees[key]);
        if (fee) fees[key] = fee;
      });
      if (Object.keys(fees).length) program.fees = fees;
      if (candidate.collateral && typeof candidate.collateral === "object")
        program.collateral = {
          enabled: candidate.collateral.enabled === true,
          required: candidate.collateral.required === true,
        };
      if (Object.keys(program).length) programs[type] = program;
    });
    if (Object.keys(programs).length) result.loanPrograms = programs;
  }
  if (
    typeof input.companyName === "string" &&
    input.companyName.trim().length <= 100
  )
    result.companyName = input.companyName.trim();
  if (
    typeof input.companyWebsite === "string" &&
    input.companyWebsite.trim().length <= 200
  )
    result.companyWebsite = input.companyWebsite.trim();
  if (
    typeof input.googleScriptUrl === "string" &&
    input.googleScriptUrl.trim().length <= 500
  )
    result.googleScriptUrl = input.googleScriptUrl.trim();
  ["adminEmails", "loanManagerEmails"].forEach(function (key) {
    if (Array.isArray(input[key])) {
      const values = input[key]
        .map(function (value) {
          return String(value || "")
            .trim()
            .toLowerCase();
        })
        .filter(function (value) {
          return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value);
        });
      if (values.length)
        result[key] = values.filter(function (value, index) {
          return values.indexOf(value) === index;
        });
    }
  });
  if (Array.isArray(input.loanManagers))
    result.loanManagers = input.loanManagers;
  return result;
}

function handleAdminListApplications(payload) {
  payload = payload || {};

  const status = String(payload.status || "")
    .trim()
    .toUpperCase();
  const type = String(payload.type || "")
    .trim()
    .toUpperCase();
  const search = String(payload.search || "")
    .trim()
    .toLowerCase();
  const limit = clamp_(parseInt(payload.limit, 10) || 100, 1, 500);
  const offset = Math.max(parseInt(payload.offset, 10) || 0, 0);

  const sheet = getSheet_(getSpreadsheet_());
  const data = sheet.getDataRange().getValues();

  if (data.length < 2) {
    return {
      ok: true,
      total: 0,
      offset: offset,
      limit: limit,
      applications: [],
    };
  }

  const headers = data[0];
  let rows = data.slice(1).map(function (row) {
    return rowToObject_(row, headers);
  });

  rows = rows.filter(function (row) {
    if (
      status &&
      String(row["Application Status"] || "").toUpperCase() !== status
    )
      return false;
    if (type && String(row["Applicant Type"] || "").toUpperCase() !== type)
      return false;

    if (search) {
      const haystack = [
        row["Application ID"],
        row["Full Name"],
        row["Business Name"],
        row["Email"],
        row["Phone"],
        row["Representative Name"],
        row["Representative Phone"],
        row["Representative Email"],
      ]
        .map(function (v) {
          return String(v || "").toLowerCase();
        })
        .join(" ");

      if (haystack.indexOf(search) === -1) return false;
    }

    return true;
  });

  rows.sort(function (a, b) {
    return (
      dateValue_(b["Date Last Updated"] || b["Date Created"]) -
      dateValue_(a["Date Last Updated"] || a["Date Created"])
    );
  });

  const total = rows.length;
  const page = rows.slice(offset, offset + limit);

  const applications = page.map(function (r) {
    return {
      applicationId: r["Application ID"],
      applicantType: r["Applicant Type"],
      status: r["Application Status"],
      applicantName:
        r["Applicant Type"] === "PERSONAL"
          ? r["Full Name"]
          : r["Business Name"],
      email: r["Email"] || r["Representative Email"],
      phone: r["Phone"] || r["Representative Phone"],
      loanAmount: numberOrZero_(r["Loan Amount"]),
      totalRepayment: numberOrZero_(r["Total Repayment"]),
      tenure: r["Loan Tenure"],
      repaymentDate: serializeSheetValue_(r["Repayment Date"]),
      dateCreated: serializeSheetValue_(r["Date Created"]),
      dateSubmitted: serializeSheetValue_(r["Date Submitted"]),
      dateUpdated: serializeSheetValue_(r["Date Last Updated"]),
      driveFolderUrl: r["Google Drive Folder URL"] || "",
    };
  });

  return {
    ok: true,
    total: total,
    offset: offset,
    limit: limit,
    applications: applications,
  };
}

function handleAdminGetApplication(payload) {
  const id = String((payload && payload.applicationId) || "").trim();
  if (!id) return { ok: false, error: "applicationId required." };

  const sheet = getSheet_(getSpreadsheet_());
  const rowNumber = findRowByApplicationId_(sheet, id);
  if (rowNumber === -1) return { ok: false, error: "Application not found." };

  const obj = getRowObject_(sheet, rowNumber);

  return {
    ok: true,
    application: {
      applicationId: obj["Application ID"],
      applicantType: obj["Applicant Type"],
      status: obj["Application Status"],
      createdAt: serializeSheetValue_(obj["Date Created"]),
      updatedAt: serializeSheetValue_(obj["Date Last Updated"]),
      submittedAt: serializeSheetValue_(obj["Date Submitted"]),

      personalInfo: {
        fullName: obj["Full Name"],
        dateOfBirth: serializeSheetValue_(obj["Date of Birth"]),
        phone: obj["Phone"],
        email: obj["Email"],
        residentialAddress: obj["Residential Address"],
        state: obj["State"],
        lga: obj["LGA"],
      },

      businessInfo: {
        businessName: obj["Business Name"],
        businessRegistrationNumber: obj["Business Registration Number"],
        businessType: obj["Business Type"],
        businessAddress: obj["Business Address"],
        businessIndustry: obj["Business Industry"],
        yearsInBusiness: obj["Years in Business"],
      },

      businessRep: {
        fullName: obj["Representative Name"],
        position: obj["Representative Position"],
        phone: obj["Representative Phone"],
        email: obj["Representative Email"],
        residentialAddress: obj["Representative Address"],
      },

      kyc: {
        bvn: obj["BVN"],
        nin: obj["NIN"],
        identificationType: obj["ID Type"],
        identificationNumber: obj["ID Number"],
      },

      financial: {
        employmentStatus: obj["Employment Status"],
        employerBusinessName: obj["Employer/Business Name"],
        monthlyIncome: obj["Monthly Income"],
        monthlyExpenses: obj["Monthly Expenses"],
        businessRevenue: obj["Business Revenue"],
        businessExpenses: obj["Business Expenses"],
        existingLoanObligations: obj["Existing Loan Obligations"],
        expectedRepaymentSource: obj["Expected Repayment Source"],
      },

      loan: {
        amount: numberOrZero_(obj["Loan Amount"]),
        tenure: obj["Loan Tenure"],
        purpose: obj["Loan Purpose"],
        interest: numberOrZero_(obj["Interest"]),
        serviceFee: numberOrZero_(obj["Service Fee"]),
        processingFee: numberOrZero_(obj["Processing Fee"]),
        otherFees: numberOrZero_(obj["Other Fees"]),
        totalFees: numberOrZero_(obj["Total Fees"]),
        totalRepayment: numberOrZero_(obj["Total Repayment"]),
        disbursementDate: serializeSheetValue_(obj["Disbursement Date"]),
        repaymentDate: serializeSheetValue_(obj["Repayment Date"]),
      },

      documents: {
        driveFolderUrl: obj["Google Drive Folder URL"] || "",
        identificationDocumentUrl: obj["ID Document URL"] || "",
        proofOfAddressUrl: obj["Proof of Address URL"] || "",
        signedAgreementUrl: obj["Signed Agreement URL"] || "",
      },
    },
  };
}

function handleAdminUpdateStatus(payload) {
  return withScriptLock_(function () {
    const id = String((payload && payload.applicationId) || "").trim();
    const newStatus = String((payload && payload.status) || "")
      .trim()
      .toUpperCase();

    if (!id || !newStatus) {
      return { ok: false, error: "applicationId + status required." };
    }

    if (ADMIN_STATUSES.indexOf(newStatus) === -1) {
      return { ok: false, error: "Invalid status: " + newStatus };
    }

    const sheet = getSheet_(getSpreadsheet_());
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return { ok: false, error: "Application not found." };

    const headers = data[0];
    const idIdx = headers.indexOf("Application ID");
    const statusIdx = headers.indexOf("Application Status");
    const updatedIdx = headers.indexOf("Date Last Updated");
    const submittedIdx = headers.indexOf("Date Submitted");

    if (
      [idIdx, statusIdx, updatedIdx, submittedIdx].some(function (v) {
        return v === -1;
      })
    ) {
      throw new Error("Spreadsheet headers are incomplete. Run setup() again.");
    }

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idIdx]).trim() !== id) continue;

      const nowIso = new Date().toISOString();
      sheet.getRange(i + 1, statusIdx + 1).setValue(newStatus);
      sheet.getRange(i + 1, updatedIdx + 1).setValue(nowIso);

      if (newStatus === "SUBMITTED" && !data[i][submittedIdx]) {
        sheet.getRange(i + 1, submittedIdx + 1).setValue(nowIso);
      }

      SpreadsheetApp.flush();

      return {
        ok: true,
        applicationId: id,
        status: newStatus,
        message: "Status updated to " + newStatus,
      };
    }

    return { ok: false, error: "Application not found." };
  });
}

function handleAdminListStats() {
  const sheet = getSheet_(getSpreadsheet_());
  const data = sheet.getDataRange().getValues();

  if (data.length < 2) {
    return {
      ok: true,
      counts: {},
      total: 0,
      totalLoanAmount: 0,
      totalRepayment: 0,
      totalLoanDisbursed: 0,
      realizedRevenue: 0,
      awaitingRevenue: 0,
    };
  }

  const headers = data[0];
  const statusIdx = headers.indexOf("Application Status");
  const loanAmountIdx = headers.indexOf("Loan Amount");
  const repaymentIdx = headers.indexOf("Total Repayment");

  const counts = {};
  let totalLoanAmount = 0;
  let totalRepayment = 0;
  let totalLoanDisbursed = 0;
  let realizedRevenue = 0;
  let awaitingRevenue = 0;

  for (let i = 1; i < data.length; i++) {
    const status = String(
      valueAt_(data[i], statusIdx) || "DRAFT",
    ).toUpperCase();
    const principal = numberOrZero_(valueAt_(data[i], loanAmountIdx));
    const repayment = numberOrZero_(valueAt_(data[i], repaymentIdx));
    counts[status] = (counts[status] || 0) + 1;
    totalLoanAmount += principal;
    totalRepayment += repayment;
    const revenue = Math.max(0, repayment - principal);
    if (status === "DISBURSED" || status === "REPAID")
      totalLoanDisbursed += principal;
    if (status === "REPAID") realizedRevenue += revenue;
    if (status === "DISBURSED") awaitingRevenue += revenue;
  }

  return {
    ok: true,
    counts: counts,
    total: data.length - 1,
    totalLoanAmount: totalLoanAmount,
    totalRepayment: totalRepayment,
    totalLoanDisbursed: totalLoanDisbursed,
    realizedRevenue: realizedRevenue,
    awaitingRevenue: awaitingRevenue,
  };
}

// ============================================================================
// OPTIONAL MAINTENANCE
// ============================================================================

function cleanupExpiredAdminTokens() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const prefix = "VELO_ADMIN_TOKEN_";
  let deleted = 0;

  Object.keys(all).forEach(function (key) {
    if (key.indexOf(prefix) !== 0) return;

    try {
      const data = JSON.parse(all[key]);
      if (
        !data.issuedAt ||
        Date.now() - Number(data.issuedAt) > CONFIG.ADMIN_TOKEN_TTL_MS
      ) {
        props.deleteProperty(key);
        deleted++;
      }
    } catch (err) {
      props.deleteProperty(key);
      deleted++;
    }
  });

  console.log("Expired admin tokens deleted: " + deleted);
  return deleted;
}

function syncDriveUrls_() {
  // Reserved for future use. URLs are already written during submission.
  return { ok: true, message: "No sync required." };
}

// ============================================================================
// GENERIC HELPERS
// ============================================================================

function jsonOut_(obj) {
  return ContentService.createTextOutput(
    JSON.stringify(obj, jsonReplacer_),
  ).setMimeType(ContentService.MimeType.JSON);
}

// Backward-compatible name used by the original script.
function jsonOut(obj) {
  return jsonOut_(obj);
}

function jsonReplacer_(key, value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function withScriptLock_(callback) {
  const lock = LockService.getScriptLock();
  let acquired = false;

  try {
    acquired = lock.tryLock(CONFIG.LOCK_TIMEOUT_MS);
    if (!acquired) {
      throw new Error(
        "The system is busy processing another request. Please retry.",
      );
    }
    return callback();
  } finally {
    if (acquired) lock.releaseLock();
  }
}

function rowToObject_(row, headers) {
  const obj = {};
  for (let i = 0; i < headers.length; i++) {
    obj[String(headers[i] || "")] = serializeSheetValue_(row[i]);
  }
  return obj;
}

function headerIndexes_(headers) {
  return {
    id: headers.indexOf("Application ID"),
    type: headers.indexOf("Applicant Type"),
    status: headers.indexOf("Application Status"),
    createdAt: headers.indexOf("Date Created"),
    updatedAt: headers.indexOf("Date Last Updated"),
    submittedAt: headers.indexOf("Date Submitted"),
    name: headers.indexOf("Full Name"),
    dob: headers.indexOf("Date of Birth"),
    phone: headers.indexOf("Phone"),
    email: headers.indexOf("Email"),
    address: headers.indexOf("Residential Address"),
    state: headers.indexOf("State"),
    lga: headers.indexOf("LGA"),
    businessName: headers.indexOf("Business Name"),
    businessRegNo: headers.indexOf("Business Registration Number"),
    businessType: headers.indexOf("Business Type"),
    businessAddress: headers.indexOf("Business Address"),
    businessIndustry: headers.indexOf("Business Industry"),
    yearsInBusiness: headers.indexOf("Years in Business"),
    repName: headers.indexOf("Representative Name"),
    repPosition: headers.indexOf("Representative Position"),
    repPhone: headers.indexOf("Representative Phone"),
    repEmail: headers.indexOf("Representative Email"),
    repAddress: headers.indexOf("Representative Address"),
    bvn: headers.indexOf("BVN"),
    nin: headers.indexOf("NIN"),
    idType: headers.indexOf("ID Type"),
    idNumber: headers.indexOf("ID Number"),
    employmentStatus: headers.indexOf("Employment Status"),
    employerName: headers.indexOf("Employer/Business Name"),
    monthlyIncome: headers.indexOf("Monthly Income"),
    monthlyExpenses: headers.indexOf("Monthly Expenses"),
    businessRevenue: headers.indexOf("Business Revenue"),
    businessExpenses: headers.indexOf("Business Expenses"),
    existingLoans: headers.indexOf("Existing Loan Obligations"),
    repaymentSource: headers.indexOf("Expected Repayment Source"),
    loanAmount: headers.indexOf("Loan Amount"),
    loanTenure: headers.indexOf("Loan Tenure"),
    loanPurpose: headers.indexOf("Loan Purpose"),
    interest: headers.indexOf("Interest"),
    serviceFee: headers.indexOf("Service Fee"),
    processingFee: headers.indexOf("Processing Fee"),
    otherFees: headers.indexOf("Other Fees"),
    totalFees: headers.indexOf("Total Fees"),
    totalRepayment: headers.indexOf("Total Repayment"),
    disbursementDate: headers.indexOf("Disbursement Date"),
    repaymentDate: headers.indexOf("Repayment Date"),
    driveFolder: headers.indexOf("Google Drive Folder URL"),
    idDocUrl: headers.indexOf("ID Document URL"),
    proofAddrUrl: headers.indexOf("Proof of Address URL"),
    signedAgreeUrl: headers.indexOf("Signed Agreement URL"),
    collateralMediaUrl: headers.indexOf("Collateral Media URL"),
    collateralType: headers.indexOf("Collateral Type"),
    collateralDescription: headers.indexOf("Collateral Description"),
    collateralValue: headers.indexOf("Collateral Value"),
    collateralOwnership: headers.indexOf("Collateral Ownership"),
    collateralLocation: headers.indexOf("Collateral Location"),
    collateralReference: headers.indexOf("Collateral Reference"),
    lastSectionIndex: headers.indexOf("Last Section Index"),
  };
}

function valueAt_(row, index) {
  return index >= 0 && index < row.length ? row[index] : "";
}

function serializeSheetValue_(value) {
  if (value instanceof Date && !isNaN(value.getTime()))
    return value.toISOString();
  return value == null ? "" : value;
}

function toIsoString_(value) {
  if (!value) return "";
  if (value instanceof Date && !isNaN(value.getTime()))
    return value.toISOString();

  const d = new Date(value);
  return isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function dateValue_(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const d = new Date(value);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function numberOrZero_(value) {
  if (value === "" || value === null || value === undefined) return 0;
  const n = Number(String(value).replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
}

function numberOrBlank_(value) {
  if (value === "" || value === null || value === undefined) return "";
  const n = Number(String(value).replace(/,/g, ""));
  return isNaN(n) ? value : n;
}

function firstNonEmpty_() {
  for (let i = 0; i < arguments.length; i++) {
    const value = arguments[i];
    if (value !== undefined && value !== null && String(value).trim() !== "")
      return value;
  }
  return "";
}

function normalizeEmail_(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizePhone_(value) {
  return String(value || "").replace(/[^0-9+]/g, "");
}

function normalizeMime_(value) {
  const mime = String(value || "")
    .trim()
    .toLowerCase();
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

function stripDataUrlPrefix_(data) {
  const value = String(data || "");
  const commaIndex = value.indexOf(",");
  if (value.indexOf("data:") === 0 && commaIndex !== -1)
    return value.substring(commaIndex + 1);
  return value;
}

function extensionForMime_(mime, originalName) {
  if (mime === "application/pdf") return ".pdf";
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";

  const name = String(originalName || "");
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.substring(dot).toLowerCase() : "";
}

function sanitizeDriveName_(value) {
  return (
    String(value || "")
      .replace(/[\\/:*?"<>|#%{}~]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 160) || "Applicant"
  );
}

function getApplicantDisplayName_(app) {
  if (app.applicantType === "BUSINESS") {
    return (
      (app.businessInfo && app.businessInfo.businessName) ||
      (app.businessRep && app.businessRep.fullName) ||
      "Business Applicant"
    );
  }

  return (
    (app.personalInfo && app.personalInfo.fullName) || "Personal Applicant"
  );
}

function getApplicantEmail_(app) {
  if (app.applicantType === "BUSINESS") {
    return (app.businessRep && app.businessRep.email) || "";
  }
  return (app.personalInfo && app.personalInfo.email) || "";
}

function uniqueNonEmpty_(values) {
  const seen = {};
  return values.filter(function (value) {
    value = String(value || "").trim();
    if (!value || seen[value]) return false;
    seen[value] = true;
    return true;
  });
}

function clamp_(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function safeErrorMessage_(err) {
  if (!err) return "Unknown error.";
  return String(err.message || err);
}

function constantTimeEquals_(a, b) {
  a = String(a || "");
  b = String(b || "");

  let diff = a.length ^ b.length;
  const maxLen = Math.max(a.length, b.length);

  for (let i = 0; i < maxLen; i++) {
    diff |=
      (a.charCodeAt(i % Math.max(a.length, 1)) || 0) ^
      (b.charCodeAt(i % Math.max(b.length, 1)) || 0);
  }

  return diff === 0;
}
