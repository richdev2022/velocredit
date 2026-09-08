import { useState } from "react";
import jsPDF from "jspdf";
import { buildAgreementFilename } from "../utils/applicationId";
import { formatDateLabel, formatNaira } from "../utils/loanCalculator";
import { config } from "../utils/config";
import type { ApplicationData } from "../types/application";
import type { LoanCalculation } from "../types/loan";

interface AgreementDownloadProps {
  application: ApplicationData;
  calculation: LoanCalculation;
  disabled?: boolean;
}

export default function AgreementDownload({ application, calculation, disabled }: AgreementDownloadProps) {
  const [generating, setGenerating] = useState(false);

  async function handleDownload() {
    setGenerating(true);
    try {
      const document = await buildPdf(application, calculation);
      document.save(buildAgreementFilename(application.applicationId));
    } catch (error) {
      console.error("[agreement] PDF generation failed", error);
      alert("Could not generate the PDF. Please try again.");
    } finally {
      setGenerating(false);
    }
  }

  return <button type="button" onClick={handleDownload} disabled={disabled || generating} className="btn-primary w-full sm:w-auto">{generating ? "Generating…" : "Download Loan Agreement"}</button>;
}

async function buildPdf(app: ApplicationData, calc: LoanCalculation): Promise<jsPDF> {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 54;
  const contentWidth = pageWidth - margin * 2;
  const bottom = pageHeight - 66;
  const blue = "#1976D2";
  const navy = "#0C2947";
  const slate = "#475569";
  let y = 58;

  const borrowerName = app.applicantType === "PERSONAL" ? app.personalInfo?.fullName || "—" : app.businessInfo?.businessName || "—";
  const address = app.applicantType === "PERSONAL" ? app.personalInfo?.residentialAddress || "—" : app.businessRep?.residentialAddress || app.businessInfo?.businessAddress || "—";
  const phone = app.applicantType === "PERSONAL" ? app.personalInfo?.phone || "—" : app.businessRep?.phone || "—";
  const email = app.applicantType === "PERSONAL" ? app.personalInfo?.email || "—" : app.businessRep?.email || "—";
  const identification = `${app.kyc?.identificationType || "—"} — ${app.kyc?.identificationNumber || "—"}`;
  const purpose = app.loanRequest?.purpose || "Working capital / personal need.";
  const collateral = app.collateral;
  const collateralMedia = app.documents?.collateralMedia;
  const account = app.disbursementAccount || { accountName: "—", bankName: "—", accountNumber: "—" };

  function addPage() {
    doc.addPage();
    y = 58;
  }

  function requireSpace(height: number) {
    if (y + height > bottom) addPage();
  }

  function setText(size: number, bold = false, color = slate) {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(color);
  }

  function paragraph(text: string, options: { bold?: boolean; size?: number; after?: number } = {}) {
    const size = options.size ?? 9.5;
    const lineHeight = size * 1.52;
    setText(size, options.bold, slate);
    const lines = doc.splitTextToSize(text, contentWidth) as string[];
    requireSpace(lines.length * lineHeight + (options.after ?? 7));
    lines.forEach((line) => {
      doc.text(line, margin, y);
      y += lineHeight;
    });
    y += options.after ?? 7;
  }

  function heading(text: string) {
    requireSpace(31);
    doc.setFillColor(blue);
    doc.rect(margin, y - 10, 3, 16, "F");
    setText(12, true, navy);
    doc.text(text, margin + 12, y + 1);
    y += 10;
    doc.setDrawColor("#D7E0EA");
    doc.setLineWidth(0.5);
    doc.line(margin, y, pageWidth - margin, y);
    y += 16;
  }

  function subheading(text: string) {
    requireSpace(20);
    setText(10.5, true, blue);
    doc.text(text, margin, y);
    y += 17;
  }

  function detail(label: string, value: string) {
    const size = 9.5;
    setText(size, true, navy);
    const labelWidth = doc.getTextWidth(label);
    setText(size, false, slate);
    const lines = doc.splitTextToSize(value, contentWidth - labelWidth - 4) as string[];
    requireSpace(Math.max(1, lines.length) * 15);
    setText(size, true, navy);
    doc.text(label, margin, y);
    setText(size, false, slate);
    lines.forEach((line, index) => doc.text(line, margin + labelWidth + 4, y + index * 15));
    y += Math.max(1, lines.length) * 15;
  }

  function summaryTable() {
    const rows: [string, string][] = [
      ["Principal Amount", formatNaira(calc.loanAmount)], ["Interest", formatNaira(calc.interest)],
      ["Service Fee", formatNaira(calc.serviceFee)], ["Processing Fee", formatNaira(calc.processingFee)],
      ["Total Fees", formatNaira(calc.totalFees)], ["Total Repayment (Due at Maturity)", formatNaira(calc.totalRepayment)],
      ["Tenure", calc.tenureLabel], ["Disbursement Date", formatDateLabel(calc.disbursementDate)],
      ["Repayment Date", calc.repaymentDateLabel], ["Purpose", purpose],
      ["Velo Disbursement Account", `${account.accountName} — ${account.bankName} (${account.accountNumber})`],
    ];
    const height = rows.length * 22 + 18;
    requireSpace(height);
    doc.setFillColor("#EAF5FF");
    doc.roundedRect(margin, y, contentWidth, height, 7, 7, "F");
    y += 17;
    rows.forEach(([label, value], index) => {
      setText(9.5, true, "#334155");
      doc.text(label, margin + 12, y);
      setText(10, true, index === 5 ? "#B91C1C" : navy);
      const valueLines = doc.splitTextToSize(value, contentWidth * 0.46) as string[];
      doc.text(valueLines, pageWidth - margin - 12, y, { align: "right" });
      if (index < rows.length - 1) {
        doc.setDrawColor("#C8E4F9");
        doc.setLineWidth(0.4);
        doc.line(margin + 10, y + 7, pageWidth - margin - 10, y + 7);
      }
      y += 22;
    });
    y += 4;
  }

  function signature(label: string, supportingText: string) {
    requireSpace(58);
    doc.setDrawColor("#64748B");
    doc.line(margin, y, margin + 225, y);
    y += 16;
    setText(10, true, navy);
    doc.text(label, margin, y);
    y += 13;
    setText(9, false, slate);
    doc.text(supportingText, margin, y);
    y += 15;
    doc.text("Date: ____________________", margin, y);
    y += 18;
  }

  const logo = await loadLogoDataUrl("/velo-logo.png");
  doc.setFillColor(blue);
  doc.rect(0, 0, pageWidth, 4, "F");
  doc.setFillColor("#EAF5FF");
  doc.roundedRect(margin, 25, contentWidth, 57, 8, 8, "F");
  if (logo) doc.addImage(logo, "PNG", margin + 12, 34, 124, 50, undefined, "FAST");
  setText(17, true, navy);
  doc.text(config.companyName, margin + 148, 48);
  setText(8.5, true, blue);
  doc.text("Personal & Business Loans | CBN Regulated | NDIC Insured", margin + 148, 62);
  setText(8.5, false, slate);
  doc.text(config.companyWebsite, margin + 148, 74);
  setText(8.5, false, slate);
  doc.text("Agreement Ref:", pageWidth - margin - 12, 47, { align: "right" });
  setText(10.5, true, navy);
  doc.text(app.applicationId || "—", pageWidth - margin - 12, 60, { align: "right" });
  setText(8.5, false, slate);
  doc.text(`Date: ${formatDateLabel(new Date().toISOString())}`, pageWidth - margin - 12, 73, { align: "right" });
  y = 108;
  setText(22, true, navy);
  doc.text("LOAN AGREEMENT", pageWidth / 2, y, { align: "center" });
  y += 16;
  setText(10, false, slate);
  doc.text(`Between ${config.companyName} (Lender) and the Borrower`, pageWidth / 2, y, { align: "center" });
  y += 18;

  heading("1. PARTIES TO THE AGREEMENT");
  subheading("PARTY A — LENDER");
  detail("Name:", config.companyName);
  detail("Website:", config.companyWebsite);
  paragraph('Registered and operating under Nigerian law. (Hereinafter the "Lender" or "Velo Finance".)', { after: 10 });
  subheading("PARTY B — BORROWER");
  detail("Name:", borrowerName);
  detail("Residential Address:", address);
  detail("Phone:", `${phone}  |  Email: ${email}`);
  detail("Identification:", identification);
  paragraph('(Hereinafter the "Borrower") The Lender and Borrower are collectively the "Parties".', { after: 10 });
  heading("2. LOAN TERMS SUMMARY");
  summaryTable();
  heading("COLLATERAL INFORMATION");
  if (collateral?.provided || collateral?.type) {
    detail("Type:", collateral.type || "—");
    detail("Estimated Value:", collateral.estimatedValue ? `₦${collateral.estimatedValue}` : "—");
    detail("Ownership:", collateral.ownership || "—");
    detail("Location:", collateral.location || "—");
    detail("Description:", collateral.description || "—");
    detail("Title / Registration:", collateral.documentReference || "—");
    detail("Supporting Evidence:", collateralMedia?.name || "Not uploaded");
  } else {
    paragraph("No collateral was provided for this application.");
  }
  heading("3. VELO DISBURSEMENT ACCOUNT");
  paragraph("The Lender shall disburse any approved loan proceeds to the Borrower's nominated account below.");
  detail("Account Name:", account.accountName || "—");
  detail("Bank Name:", account.bankName || "—");
  detail("Account Number:", account.accountNumber || "—");
  heading("4. PURPOSE AND USE OF FUNDS");
  paragraph(`The Borrower shall use the Facility solely for: ${purpose}`);
  paragraph("The Facility must NOT be used for unlawful purposes including gambling, speculation, pyramid schemes, money laundering, or terrorist financing.");
  heading("5. PRINCIPAL, INTEREST AND FEES");
  detail("5.1  Principal Amount:", formatNaira(calc.loanAmount));
  detail("5.2  Interest Payable:", formatNaira(calc.interest));
  detail("5.3  Service Fee:", `${formatNaira(calc.serviceFee)} (admin & servicing)`);
  detail("5.4  Processing Fee:", `${formatNaira(calc.processingFee)} (verification & underwriting)`);
  detail("5.5  Total Fees:", formatNaira(calc.totalFees));
  detail("5.6  Total Repayment Due:", formatNaira(calc.totalRepayment));
  paragraph("5.7  All fees may be deducted from the Principal at disbursement. The Borrower's obligation to repay the full Principal amount remains unaffected.");
  heading("6. TENURE, DISBURSEMENT AND REPAYMENT");
  detail("6.1  Tenure:", calc.tenureLabel);
  detail("6.2  Disbursement On:", formatDateLabel(calc.disbursementDate));
  detail("6.3  Repayment Date:", calc.repaymentDateLabel);
  paragraph("6.4  Repayment Method: The Borrower authorises the Lender to debit the nominated account, card, or wallet on the Repayment Date via direct debit, transfer, or such other channel as the Lender designates.");
  paragraph("6.5  Time is of the essence. If the Repayment Date falls on a non-business day, payment is due on the preceding Business Day.");
  paragraph("6.6  Application of Payments: Recovery costs, Late Fees, Interest, then Principal.");
  heading("7. EARLY REPAYMENT");
  paragraph("The Borrower may prepay the Facility in whole or in part at any time without penalty. Partial prepayments reduce the outstanding Principal. Full prepayment entitles the Borrower to a proportionate rebate of unearned upfront fees where applicable.");
  heading("8. LATE PAYMENT AND DEFAULT");
  detail("8.1  Late Fee on Default:", formatNaira(calc.lateFee));
  paragraph("8.2  In addition, the outstanding balance shall continue to bear interest at the contractual rate from the date of default until paid in full.");
  paragraph("8.3  Events of Default include failure to pay when due, misrepresentation, breach of covenant, insolvency, permanent incapacity, adverse change in circumstances, or cross-default on other debts.");
  paragraph("8.4  On Default, the Lender may declare the entire balance immediately due, report to credit bureaus, set-off against accounts, and pursue all legal remedies available.");
  heading("9. BORROWER REPRESENTATIONS");
  paragraph("The Borrower confirms that all information provided is true, complete, and accurate; the Borrower has full legal capacity to enter this Agreement; the Borrower is solvent and able to repay; no material litigation or insolvency is pending; and the Borrower is not in default on any other debt.");
  heading("10. CREDIT BUREAU, PRIVACY AND DATA");
  paragraph("9.1  The Borrower irrevocably consents to the Lender reporting this Facility, its conduct, and any default to licensed credit bureaus in Nigeria, including the CBN CRMS. Late payment or default may adversely affect the Borrower's credit score.");
  paragraph("9.2  The Borrower consents to the collection, storage, and processing of personal data for loan assessment, administration, recovery, and compliance with AML/CTF and regulatory obligations.");
  heading("11. RECOVERY COSTS AND INDEMNITY");
  paragraph("The Borrower is liable for all reasonable recovery costs incurred in enforcing this Agreement and indemnifies the Lender against losses arising from misrepresentation, fraud, or wilful misconduct.");
  heading("12. GOVERNING LAW, DISPUTE RESOLUTION AND GENERAL");
  paragraph("11.1  This Agreement is governed by the laws of the Federal Republic of Nigeria. The parties submit to the exclusive jurisdiction of the Courts of Lagos State, except where arbitration is elected.");
  paragraph("11.2  The parties shall first attempt amicable resolution within 30 days. Unresolved disputes may be referred to binding arbitration in Lagos or to the competent courts.");
  paragraph("11.3  This document, including the Loan Summary and Borrower's Application Form, constitutes the entire agreement. If any provision is unenforceable, it is severed without affecting the remaining provisions. No delay in exercising a right is a waiver. The Lender may assign its rights; the Borrower may not assign without prior written consent. Electronic execution and checkbox acceptance are valid and binding.");

  addPage();
  heading("13. EXECUTION BY THE PARTIES");
  paragraph("The Parties have each caused this Agreement to be duly executed by their duly authorised representatives as of the date first written above.", { after: 20 });
  subheading("SIGNED FOR AND ON BEHALF OF THE LENDER");
  paragraph(`(${config.companyName})`, { bold: true, after: 12 });
  if (logo) doc.addImage(logo, "PNG", margin, y, 135, 55, undefined, "FAST");
  y += 66;
  signature("AUTHORISED SIGNATORY", `${config.companyName} — Name & Position below`);
  detail("Full Name (Print):", "____________________________________________");
  detail("Position:", "____________________________________________");
  y += 12;
  subheading("SIGNED FOR AND ON BEHALF OF THE BORROWER");
  paragraph(borrowerName, { bold: true, after: 12 });
  signature("BORROWER'S SIGNATURE", app.applicantType === "BUSINESS" ? `Representative: ${app.businessRep?.fullName || "—"}` : "Capacity: Borrower");
  subheading("WITNESS (OPTIONAL)");
  paragraph("If a witness is required for the Borrower's signature, please complete below.", { after: 12 });
  signature("WITNESS'S SIGNATURE", "Witness to the Borrower's signature");
  detail("Witness Full Name (Print):", "__________________________________");
  detail("Witness Phone Number:", "____________________________________");
  requireSpace(72);
  doc.setFillColor("#EAF5FF");
  doc.roundedRect(margin, y + 10, contentWidth, 57, 7, 7, "F");
  setText(12, true, navy);
  doc.text("— END OF LOAN AGREEMENT —", pageWidth / 2, y + 33, { align: "center" });
  setText(8.5, true, slate);
  doc.text(`This document forms the complete Agreement. ${config.companyName} | ${config.companyWebsite} | Ref: ${app.applicationId || "—"}`, pageWidth / 2, y + 50, { align: "center" });

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setDrawColor("#CBD5E1");
    doc.setLineWidth(0.5);
    doc.line(margin, pageHeight - 45, pageWidth - margin, pageHeight - 45);
    setText(8.5, true, "#334155");
    doc.text(`${config.companyName} — Loan Agreement ${app.applicationId || "—"}`, margin, pageHeight - 29);
    setText(9, true, navy);
    doc.text(`Page ${page} of ${pages}`, pageWidth - margin, pageHeight - 29, { align: "right" });
  }

  return doc;
}

async function loadLogoDataUrl(src: string): Promise<string | null> {
  try {
    const response = await fetch(src);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Invalid image"));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
