// ============================================================================
// src/services/agreementGenerator.ts
// Reusable Loan Agreement template engine.
//
//   generateLoanAgreement(applicationData, loanCalculation) -> { html, text }
//
// The same engine is used for both Personal and Business loans — it picks the
// relevant party block based on applicantType.
//
// Sensitive data (full BVN/NIN) is intentionally omitted from the agreement
// body by default. They are stored in the backend (Sheets + Drive) only and
// never echoed back to the user's screen or printed PDF.
// ============================================================================

import type { ApplicationData } from "../types/application";
import type { LoanCalculation } from "../types/loan";
import { config } from "../utils/config";
import { formatDateLabel, formatNaira } from "../utils/loanCalculator";

// ---------------------------------------------------------------------------
// Placeholder engine (kept for backwards compat)
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Z_]+)\s*\}\}/g;

export interface PlaceholderMap {
  [key: string]: string;
}

export function replacePlaceholders(template: string, map: PlaceholderMap): string {
  return template.replace(PLACEHOLDER_PATTERN, (full, name: string) => {
    const key = name.toUpperCase();
    return map[key] !== undefined && map[key] !== null ? map[key] : full;
  });
}

export function buildPlaceholderMap(
  app: ApplicationData,
  calc: LoanCalculation
): PlaceholderMap {
  const map: PlaceholderMap = {
    APPLICATION_ID:        app.applicationId || "—",
    APPLICANT_NAME:        "—",
    BUSINESS_NAME:         "—",
    BUSINESS_ADDRESS:      "—",
    RESIDENTIAL_ADDRESS:   "—",
    PHONE:                 "—",
    EMAIL:                 "—",
    BVN_MASKED:            maskBvn(app.kyc?.bvn),
    NIN_MASKED:            maskNin(app.kyc?.nin),
    ID_TYPE:               app.kyc?.identificationType || "—",
    ID_NUMBER:             app.kyc?.identificationNumber || "—",
    LOAN_AMOUNT:           formatNaira(calc.loanAmount),
    INTEREST:              formatNaira(calc.interest),
    SERVICE_FEE:           formatNaira(calc.serviceFee),
    PROCESSING_FEE:        formatNaira(calc.processingFee),
    LATE_FEE:              formatNaira(calc.lateFee),
    TOTAL_FEES:            formatNaira(calc.totalFees),
    TOTAL_REPAYMENT:       formatNaira(calc.totalRepayment),
    TENURE:                calc.tenureLabel,
    DISBURSEMENT_DATE:     formatDateLabel(calc.disbursementDate),
    REPAYMENT_DATE:        calc.repaymentDateLabel,
    LOAN_PURPOSE:          app.loanRequest?.purpose || "—",
    COMPANY_NAME:          config.companyName,
    COMPANY_WEBSITE:       config.companyWebsite,
    TODAY:                 formatDateLabel(new Date().toISOString()),
    SIGNATORY_NAME:        "—",
    REPRESENTATIVE_NAME:   "—",
    REPRESENTATIVE_POSITION: "—",
    ACCOUNT_NAME:           escapeHtml(app.disbursementAccount?.accountName || "—"),
    BANK_NAME:              escapeHtml(app.disbursementAccount?.bankName || "—"),
    ACCOUNT_NUMBER:         escapeHtml(app.disbursementAccount?.accountNumber || "—"),
  };

  if (app.applicantType === "PERSONAL") {
    const p = app.personalInfo || ({} as any);
    map.APPLICANT_NAME       = p.fullName || "—";
    map.RESIDENTIAL_ADDRESS  = p.residentialAddress || "—";
    map.PHONE                = p.phone || "—";
    map.EMAIL                = p.email || "—";
    map.SIGNATORY_NAME       = p.fullName || "—";
  } else {
    const b = app.businessInfo || ({} as any);
    const r = app.businessRep || ({} as any);
    map.APPLICANT_NAME           = b.businessName || "—";
    map.BUSINESS_NAME            = b.businessName || "—";
    map.BUSINESS_ADDRESS         = b.businessAddress || "—";
    map.RESIDENTIAL_ADDRESS      = r.residentialAddress || "—";
    map.PHONE                    = r.phone || "—";
    map.EMAIL                    = r.email || "—";
    map.SIGNATORY_NAME           = r.fullName || "—";
    map.REPRESENTATIVE_NAME      = r.fullName || "—";
    map.REPRESENTATIVE_POSITION  = r.position || "—";
  }

  return map;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
}

function documentImage(document: { data?: string; type?: string } | undefined, label: string): string {
  if (!document?.data) return `<div class="media-placeholder">${escapeHtml(label)} not uploaded</div>`;
  const type = document.type?.startsWith("image/") ? document.type : "image/png";
  return `<img class="agreement-media" src="data:${type};base64,${document.data}" alt="${escapeHtml(label)}" />`;
}

function maskBvn(bvn?: string): string {
  if (!bvn || bvn.length < 11) return "—";
  return `*******${bvn.slice(-4)}`;
}

function maskNin(nin?: string): string {
  if (!nin || nin.length < 11) return "—";
  return `*******${nin.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GeneratedAgreement {
  text: string;
  html: string;
}

export function generateLoanAgreement(
  app: ApplicationData,
  calc: LoanCalculation
): GeneratedAgreement {
  const map = buildPlaceholderMap(app, calc);
  const agreementDate = formatDateLabel(new Date().toISOString());
  const lenderSignature = config.lenderSignatorySignatureUrl
    ? `<img class="agreement-media" src="${escapeHtml(config.lenderSignatorySignatureUrl)}" alt="Lender authorised signatory signature" />`
    : `<div class="media-placeholder">Lender signature not configured</div>`;

  const borrowerName = map.APPLICANT_NAME;
  const residentialAddress = map.RESIDENTIAL_ADDRESS;
  const phone = map.PHONE;
  const email = map.EMAIL;
  const idType = map.ID_TYPE;
  const idNumber = map.ID_NUMBER;
  const businessName = map.BUSINESS_NAME;
  const businessAddress = map.BUSINESS_ADDRESS;
  const repPosition = map.REPRESENTATIVE_POSITION;
  const signatoryName = map.SIGNATORY_NAME;
  const accountName = map.ACCOUNT_NAME;
  const bankName = map.BANK_NAME;
  const accountNumber = map.ACCOUNT_NUMBER;
  const signatoryRoleLine =
    app.applicantType === "BUSINESS" && repPosition !== "—"
      ? `Signatory Position: ${repPosition}`
      : "Capacity: Borrower";
  const borrowerPassport = app.documents?.identificationDocument;
  const borrowerSignature = app.documents?.signature;
  const witness = app.witness || { fullName: "", phone: "" };
  const witnessPassport = app.documents?.witnessPassport;
  const witnessSignature = app.documents?.witnessSignature;

  const bold = (v: string, cls = "val") => `<strong class="${cls}">${v}</strong>`;

  const summaryRows: [string, string][] = [
    ["Principal Amount", formatNaira(calc.loanAmount)],
    ["Interest", formatNaira(calc.interest)],
    ["Service Fee", `${formatNaira(calc.serviceFee)} (admin &amp; servicing)`],
    ["Processing Fee", `${formatNaira(calc.processingFee)} (verification &amp; underwriting)`],
    ["Total Fees", formatNaira(calc.totalFees)],
    ["Total Repayment (Due at Maturity)", `<span class="val-emph">${formatNaira(calc.totalRepayment)}</span>`],
    ["Tenure", calc.tenureLabel],
    ["Disbursement Date", formatDateLabel(calc.disbursementDate)],
    ["Repayment Date", calc.repaymentDateLabel],
    ["Purpose", app.loanRequest?.purpose || "—"],
    ["Velo Disbursement Account", `${accountName} — ${bankName} (${accountNumber})`],
  ];

  const summaryHtml = summaryRows
    .map(([k, v]) => `<div class="sr-row"><div class="sr-key">${k}</div><div class="sr-val">${v}</div></div>`)
    .join("");

  const purpose = app.loanRequest?.purpose || "Working capital / personal need.";
  const collateral = app.collateral;
  const collateralDocument = app.documents?.collateralMedia;
  const collateralHtml = collateral?.provided || collateral?.type
    ? `<h2 class="agr-h2"><span class="bar"></span>COLLATERAL INFORMATION</h2>
      <div class="collateral-card"><div class="collateral-grid"><div><span>Type</span><strong>${collateral.type || "—"}</strong></div><div><span>Estimated Value</span><strong>${collateral.estimatedValue ? `₦${collateral.estimatedValue}` : "—"}</strong></div><div><span>Ownership</span><strong>${collateral.ownership || "—"}</strong></div><div><span>Location</span><strong>${collateral.location || "—"}</strong></div></div><p class="agr-p"><b>Description:</b> ${collateral.description || "—"}</p><p class="agr-p"><b>Title / Registration Reference:</b> ${collateral.documentReference || "—"}</p><p class="agr-p"><b>Supporting Evidence:</b> ${collateralDocument?.name || "Not uploaded"}${collateralDocument?.type ? ` (${collateralDocument.type})` : ""}</p></div>`
    : `<h2 class="agr-h2"><span class="bar"></span>COLLATERAL INFORMATION</h2><p class="agr-p">No collateral was provided for this application.</p>`;

  const html = `
<div class="agreement-doc" id="agreement-doc">
  <div class="agr-header">
    <div class="agr-brand">
      <img src="${config.brandLogoUrl}" alt="${config.companyName}" class="agr-logo" />
    </div>
    <div class="agr-meta">
      <div>Agreement Ref: ${bold(app.applicationId || "—")}</div>
      <div>Date: ${bold(agreementDate)}</div>
    </div>
  </div>

  <div class="agr-title-block">
    <h1 class="agr-h1">LOAN AGREEMENT</h1>
    <p class="agr-sub-title">Between ${config.companyName} (Lender) and the Borrower</p>
    <hr class="agr-hr" />
  </div>

  <h2 class="agr-h2"><span class="bar"></span>1. PARTIES TO THE AGREEMENT</h2>

  <div class="parties">
    <div class="party-lender">
      <h3 class="agr-h3">PARTY A — LENDER</h3>
      <div class="pn-name">${bold(config.companyName)}</div>
      <div class="pn-url">${config.companyWebsite}</div>
      <div class="pn-desc">Registered and operating under Nigerian law. (Hereinafter the "Lender" or "Velo Finance".)</div>
    </div>

    <div class="party-borrower">
      <h3 class="agr-h3">PARTY B — BORROWER</h3>
      <div class="pn-name">${bold(borrowerName)}</div>
      <div class="pn-line">Residential Address: ${bold(residentialAddress)}</div>
      <div class="pn-line">Phone: ${bold(phone)} &nbsp;&nbsp;|&nbsp;&nbsp; Email: ${bold(email)}</div>
      ${
        app.applicantType === "BUSINESS" && businessAddress !== "—"
          ? `<div class="pn-line">Business Address: ${bold(businessAddress)}</div>`
          : ""
      }
      <div class="pn-line">Identification: ${bold(idType + " — " + idNumber)}</div>
      ${repPosition !== "—" ? `<div class="pn-line">Authorised Rep Position: ${bold(repPosition)}</div>` : ""}
      <div class="pn-line"><b>Passport / ID:</b></div>
      ${documentImage(borrowerPassport, "Borrower passport or identification")}
      <div class="pn-desc">(Hereinafter the "Borrower")</div>
    </div>
  </div>

  <p class="agr-p">The Lender and Borrower are collectively the "Parties".</p>

  <h2 class="agr-h2"><span class="bar"></span>2. LOAN TERMS SUMMARY</h2>
  <div class="summary">
    ${summaryHtml}
  </div>

  ${collateralHtml}

  <h2 class="agr-h2"><span class="bar"></span>3. VELO DISBURSEMENT ACCOUNT</h2>
  <p class="agr-p">The Lender shall disburse any approved loan proceeds to the Borrower's nominated account below.</p>
  <p class="agr-p vline"><b>Account Name:</b> ${bold(accountName)}</p>
  <p class="agr-p vline"><b>Bank Name:</b> ${bold(bankName)}</p>
  <p class="agr-p vline"><b>Account Number:</b> ${bold(accountNumber)}</p>

  <h2 class="agr-h2"><span class="bar"></span>4. PURPOSE AND USE OF FUNDS</h2>
  <p class="agr-p">The Borrower shall use the Facility solely for: ${bold(purpose)}</p>
  <p class="agr-p">The Facility must NOT be used for unlawful purposes including gambling, speculation, pyramid schemes, money laundering, or terrorist financing.</p>

  <h2 class="agr-h2"><span class="bar"></span>5. PRINCIPAL, INTEREST AND FEES</h2>
  <p class="agr-p vline"><b>5.1 &nbsp; Principal Amount:</b> ${bold(formatNaira(calc.loanAmount))}</p>
  <p class="agr-p vline"><b>5.2 &nbsp; Interest Payable:</b> ${bold(formatNaira(calc.interest))}</p>
  <p class="agr-p vline"><b>5.3 &nbsp; Service Fee:</b> ${bold(formatNaira(calc.serviceFee) + " (admin & servicing)")}</p>
  <p class="agr-p vline"><b>5.4 &nbsp; Processing Fee:</b> ${bold(formatNaira(calc.processingFee) + " (verification & underwriting)")}</p>
  <p class="agr-p vline"><b>5.5 &nbsp; Total Fees:</b> ${bold(formatNaira(calc.totalFees))}</p>
  <p class="agr-p vline"><b>5.6 &nbsp; Total Repayment Due:</b> ${bold(formatNaira(calc.totalRepayment), "val-emph")}</p>
  <p class="agr-p">5.7 &nbsp; All fees may be deducted from the Principal at disbursement. The Borrower's obligation to repay the full Principal amount remains unaffected.</p>

  <h2 class="agr-h2"><span class="bar"></span>6. TENURE, DISBURSEMENT AND REPAYMENT</h2>
  <p class="agr-p vline"><b>6.1 &nbsp; Tenure:</b> ${bold(calc.tenureLabel)}</p>
  <p class="agr-p vline"><b>6.2 &nbsp; Disbursement On:</b> ${bold(formatDateLabel(calc.disbursementDate))}</p>
  <p class="agr-p vline"><b>6.3 &nbsp; Repayment Date:</b> ${bold(calc.repaymentDateLabel)}</p>
  <p class="agr-p">6.4 &nbsp; Repayment Method: The Borrower authorises the Lender to debit the nominated account, card, or wallet on the Repayment Date via direct debit, transfer, or such other channel as the Lender designates.</p>
  <p class="agr-p">6.5 &nbsp; Time is of the essence. If the Repayment Date falls on a non-business day, payment is due on the preceding Business Day.</p>
  <p class="agr-p">6.6 &nbsp; Application of Payments: Recovery costs → Late Fees → Interest → Principal.</p>

  <h2 class="agr-h2"><span class="bar"></span>7. EARLY REPAYMENT</h2>
  <p class="agr-p">The Borrower may prepay the Facility in whole or in part at any time without penalty. Partial prepayments reduce the outstanding Principal. Full prepayment entitles the Borrower to a proportionate rebate of unearned upfront fees where applicable.</p>

  <h2 class="agr-h2"><span class="bar"></span>8. LATE PAYMENT AND DEFAULT</h2>
  <p class="agr-p vline"><b>8.1 &nbsp; Late Fee on Default:</b> ${bold(formatNaira(calc.lateFee))}</p>
  <p class="agr-p">8.2 &nbsp; In addition, the outstanding balance shall continue to bear interest at the contractual rate from the date of default until paid in full.</p>
  <p class="agr-p">8.3 &nbsp; Events of Default include: (a) failure to pay when due; (b) misrepresentation or false information; (c) breach of any covenant; (d) insolvency or winding-up; (e) death or permanent incapacity (individual); (f) adverse change in circumstances impairing ability to repay; (g) cross-default on other debts.</p>
  <p class="agr-p">8.4 &nbsp; On Default, the Lender may declare the entire balance immediately due, report to credit bureaus, set-off against accounts, and pursue all legal remedies available.</p>

  <h2 class="agr-h2"><span class="bar"></span>9. BORROWER REPRESENTATIONS</h2>
  <p class="agr-p">The Borrower confirms that: (a) all information provided is true, complete, and accurate; (b) the Borrower has full legal capacity to enter this Agreement; (c) the Borrower is solvent and able to repay; (d) no material litigation or insolvency is pending; (e) the Borrower is not in default on any other debt.</p>

  <h2 class="agr-h2"><span class="bar"></span>10. CREDIT BUREAU, PRIVACY AND DATA</h2>
  <p class="agr-p">9.1 &nbsp; The Borrower irrevocably consents to the Lender reporting this Facility, its conduct, and any default to all licensed credit bureaus in Nigeria (including the CBN CRMS). Late payment or default may adversely affect the Borrower's credit score.</p>
  <p class="agr-p">9.2 &nbsp; The Borrower consents to the collection, storage, and processing of personal data for the purposes of loan assessment, administration, recovery, and compliance with AML/CTF and regulatory obligations. The Borrower may access, correct, or request deletion of their data (subject to legal retention).</p>

  <h2 class="agr-h2"><span class="bar"></span>11. RECOVERY COSTS AND INDEMNITY</h2>
  <p class="agr-p">The Borrower is liable for all reasonable recovery costs (legal fees, agent commissions, court fees, skip-tracing, bailiffs, etc.) incurred in enforcing this Agreement. The Borrower also indemnifies the Lender against losses arising from misrepresentation, fraud, or wilful misconduct.</p>

  <h2 class="agr-h2"><span class="bar"></span>12. GOVERNING LAW, DISPUTE RESOLUTION AND GENERAL</h2>
  <p class="agr-p">11.1 &nbsp; Governing Law: This Agreement is governed by the laws of the Federal Republic of Nigeria. The parties submit to the exclusive jurisdiction of the Courts of Lagos State, except where arbitration is elected.</p>
  <p class="agr-p">11.2 &nbsp; Dispute Resolution: The parties shall first attempt amicable resolution within 30 days. Unresolved disputes may be referred to binding arbitration under the Arbitration and Conciliation Act (Lagos seat) or to the competent courts.</p>
  <p class="agr-p">11.3 &nbsp; Entire Agreement: This document (including the Loan Summary above, and the Borrower's Application Form) constitutes the entire agreement and supersedes all prior discussions, representations, or understandings relating to the Facility.</p>
  <p class="agr-p">11.4 &nbsp; Severability: If any provision is found unenforceable, it shall be severed without affecting the validity of the remaining provisions.</p>
  <p class="agr-p">11.5 &nbsp; No Waiver: No delay or omission in exercising any right shall operate as a waiver. Rights are cumulative.</p>
  <p class="agr-p">11.6 &nbsp; Assignment: The Lender may assign its rights without consent. The Borrower may not assign without prior written consent.</p>
  <p class="agr-p">11.7 &nbsp; Electronic Execution: This Agreement, consents, and signatures exchanged electronically (including checkbox acceptance) are valid and binding as if handwritten.</p>

  <div class="page-break"></div>
  <h2 class="agr-h2"><span class="bar"></span>13. EXECUTION BY THE PARTIES</h2>
  <p class="agr-p">The Parties have each caused this Agreement to be duly executed by their duly authorised representatives as of the date first written above.</p>

  <div class="exec-grid">
    <div class="exec-lender">
      <h3 class="agr-h3">SIGNED FOR AND ON BEHALF OF THE LENDER</h3>
      <p class="pn-name">(${config.companyName})</p>
      <div class="lender-brand-panel">
        <img src="${config.brandLogoUrl}" alt="${config.companyName}" class="exec-logo" />
        <div class="lender-brand-name">${config.companyName}</div>
        <div class="lender-brand-line">CBN Regulated | NDIC Insured</div>
        <div class="lender-brand-url">${config.companyWebsite}</div>
      </div>
      <div class="sign-block">
        ${lenderSignature}
        <div class="sign-line"></div>
        <div class="sign-label">AUTHORISED SIGNATORY</div>
        <div class="sign-sub">${escapeHtml(config.lenderSignatoryName || "Not configured")} — ${escapeHtml(config.lenderSignatoryPosition || "Position not configured")}</div>
        <div class="sign-date">Date: ${agreementDate}</div>
      </div>
    </div>

    <div class="exec-borrower">
      <hr class="agr-hr" />
      <h3 class="agr-h3">SIGNED FOR AND ON BEHALF OF THE BORROWER</h3>
      <p class="pn-name">${borrowerName}</p>
      <div class="sign-block">
        ${documentImage(borrowerSignature, "Borrower signature")}
        <div class="sign-line"></div>
        <div class="sign-label">BORROWER'S SIGNATURE</div>
        <div class="sign-sub">${signatoryRoleLine}</div>
        <div class="sign-date">Date: ${agreementDate}</div>
      </div>
      ${app.applicantType === "BUSINESS" ? `<p class="pn-sub">Representative: ${signatoryName}</p>` : ""}
    </div>

    <div class="exec-witness">
      <hr class="agr-hr" />
      <h3 class="agr-h3">WITNESS</h3>
      <p class="pn-sub">Witness details supplied with this application.</p>
      <div class="pn-line"><b>Full Name:</b> ${bold(escapeHtml(witness.fullName || "—"))}</div>
      <div class="pn-line"><b>Phone Number:</b> ${bold(escapeHtml(witness.phone || "—"))}</div>
      <div class="pn-line"><b>Passport:</b></div>
      ${documentImage(witnessPassport, "Witness passport")}
      <div class="sign-block">
        ${documentImage(witnessSignature, "Witness signature")}
        <div class="sign-line"></div>
        <div class="sign-label">WITNESS'S SIGNATURE</div>
        <div class="sign-sub">Witness to the Borrower's signature</div>
        <div class="sign-date">Date: ${agreementDate}</div>
      </div>
    </div>
  </div>

  <div class="end-note">
    <div class="en-title">— END OF LOAN AGREEMENT —</div>
    <div class="en-desc">This document, comprising the Loan Terms Summary, Key Conditions, and Execution pages, forms the complete Agreement.</div>
    <div class="en-foot">${config.companyName} | ${config.companyWebsite} | Ref: ${app.applicationId || "—"}</div>
  </div>
</div>`;

  // Keep a plain-text version for legacy consumers (simplified)
  const text = `LOAN AGREEMENT
Ref: ${app.applicationId || "—"}
Date: ${agreementDate}

1. PARTIES
Lender: ${config.companyName} (${config.companyWebsite})
Borrower: ${borrowerName}
Address: ${residentialAddress}
Phone: ${phone} | Email: ${email}
ID: ${idType} — ${idNumber}

2. LOAN SUMMARY
Principal: ${formatNaira(calc.loanAmount)}
Interest: ${formatNaira(calc.interest)}
Fees: ${formatNaira(calc.totalFees)} (Service: ${formatNaira(calc.serviceFee)}, Processing: ${formatNaira(calc.processingFee)})
Total Repayment: ${formatNaira(calc.totalRepayment)}
Tenure: ${calc.tenureLabel}
Disbursement: ${formatDateLabel(calc.disbursementDate)}
Repayment Due: ${calc.repaymentDateLabel}
Purpose: ${purpose}
Late Fee: ${formatNaira(calc.lateFee)}

3.-12. This electronic agreement includes the complete Terms & Conditions (Purpose, Interest, Fees, Repayment, Default, Credit Bureau, Privacy, Governing Law, Execution).

END OF LOAN AGREEMENT
`;

  return { text, html };
}
