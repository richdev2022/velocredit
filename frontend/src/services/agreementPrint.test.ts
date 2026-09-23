// ============================================================================
// src/services/agreementPrint.test.ts
// Loan agreement generation + A4 print document tests.
//
// Generates a REAL test loan agreement (personal borrower, all sections
// populated, signature images embedded) and asserts that the standalone A4
// print document is structurally perfect:
//   • exact A4 @page geometry (size + margins)
//   • page width locked to the printable area (186mm = 210 - 2×12)
//   • every critical section present (header, parties, summary, clauses,
//     execution/signature block, end note)
//   • no unresolved placeholders, no blank-page-causing print tricks
//   • images constrained to page width
// The rendered document is written to scripts/output/test-loan-agreement.html
// so scripts/testAgreementPrint.mjs can render it with headless Chromium and
// verify the actual printed page output.
// ============================================================================

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateLoanAgreement } from "./agreementGenerator";
import { buildAgreementPrintDocument } from "../components/AgreementPreview";
import { calculateLoan } from "../utils/loanCalculator";
import type { ApplicationData } from "../types/application";

// 1×1 transparent PNG (smallest valid image) used for the signature slots.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function buildTestApplication(): ApplicationData {
  const now = new Date().toISOString();
  const app: ApplicationData = {
    applicationId: "VEL-LN-2026-000451",
    applicantType: "PERSONAL",
    status: "ACTIVE",
    personalInfo: {
      fullName: "Adaeze Chiamaka Okafor",
      phone: "+2348031234567",
      email: "adaeze.okafor@example.com",
      dateOfBirth: "1994-06-21",
      residentialAddress: "14B Adeola Odeku Street, Victoria Island",
      state: "Lagos",
      lga: "Eti-Osa",
    },
    disbursementAccount: {
      accountName: "ADAEZE CHIAMAKA OKAFOR",
      bankName: "Guaranty Trust Bank",
      bankCode: "058",
      accountNumber: "0123456789",
    },
    personalFinancial: {
      employmentStatus: "Employed",
      employerBusinessName: "Zenith Analytics Ltd",
      monthlyIncome: "850000",
      monthlyExpenses: "320000",
      existingLoanObligations: "None",
      expectedRepaymentSource: "Monthly salary",
    },
    businessInfo: {
      businessName: "",
      businessRegistrationNumber: "",
      businessType: "",
      businessAddress: "",
      businessIndustry: "",
      yearsInBusiness: "",
    },
    businessRep: {
      fullName: "",
      dateOfBirth: "",
      position: "",
      phone: "",
      email: "",
      residentialAddress: "",
    },
    businessFinancial: {
      averageMonthlyRevenue: "",
      averageMonthlyExpenses: "",
      existingLoanObligations: "",
      expectedRepaymentSource: "",
    },
    kyc: {
      bvn: "22212345678",
      nin: "12345678901",
      identificationType: "BVN",
      identificationNumber: "22212345678",
      bvnVerified: true,
      ninVerified: true,
      livenessVerified: true,
    },
    loanRequest: { amount: 500000, tenure: 180, purpose: "Business inventory restocking" },
    collateral: {
      provided: false,
      type: "",
      description: "",
      estimatedValue: "",
      ownership: "",
      location: "",
      documentReference: "",
    },
    calculation: null,
    documents: {
      identificationDocument: {
        slot: "identificationDocument",
        name: "national-id.png",
        type: "image/png",
        size: 1024,
        data: TINY_PNG_BASE64,
        status: "uploaded",
        addedAt: now,
      },
      signature: {
        slot: "signature",
        name: "signature.png",
        type: "image/png",
        size: 1024,
        data: TINY_PNG_BASE64,
        status: "uploaded",
        addedAt: now,
      },
      witnessPassport: {
        slot: "witnessPassport",
        name: "witness-passport.png",
        type: "image/png",
        size: 1024,
        data: TINY_PNG_BASE64,
        status: "uploaded",
        addedAt: now,
      },
      witnessSignature: {
        slot: "witnessSignature",
        name: "witness-signature.png",
        type: "image/png",
        size: 1024,
        data: TINY_PNG_BASE64,
        status: "uploaded",
        addedAt: now,
      },
    },
    witness: { fullName: "Chukwuemeka Nwosu", phone: "+2348067654321" },
    agreement: {
      generatedAt: now,
      executionDate: now,
      generatedHtml: null,
      signedAgreementAccepted: true,
    },
    createdAt: now,
    updatedAt: now,
    submittedAt: now,
  };
  app.calculation = calculateLoan(app.loanRequest.amount, app.loanRequest.tenure, { loanType: "PERSONAL" });
  return app;
}

describe("loan agreement generation", () => {
  const application = buildTestApplication();
  const calculation = calculateLoan(500000, 180, { loanType: "PERSONAL" });
  const { html, text } = generateLoanAgreement(application, calculation);

  it("generates non-empty agreement markup and text", () => {
    expect(html.length).toBeGreaterThan(1000);
    expect(text.length).toBeGreaterThan(200);
  });

  it("renders the borrower's details into the agreement", () => {
    expect(html).toContain("Adaeze Chiamaka Okafor");
    expect(html).toContain("VEL-LN-2026-000451");
    expect(html).toContain("Chukwuemeka Nwosu");
  });

  it("leaves no unresolved {{PLACEHOLDER}} tokens", () => {
    expect(html).not.toMatch(/\{\{\s*[A-Z_]+\s*\}\}/);
  });

  it("embeds the signature images as data URLs", () => {
    expect(html).toMatch(/data:image\/png;base64,/);
  });

  it("contains every critical section", () => {
    expect(html).toContain("agreement-doc");
    expect(html).toContain("agr-header");
    expect(html).toContain("party-borrower");
    expect(html).toContain("summary");
    expect(html).toContain("sign-block");
    expect(html).toContain("end-note");
  });

  describe("standalone A4 print document", () => {
    const doc = buildAgreementPrintDocument(html, "Loan Agreement VEL-LN-2026-000451");

    it("declares exact A4 page geometry", () => {
      expect(doc).toContain("size: A4 portrait");
      expect(doc).toMatch(/margin:\s*14mm 12mm 16mm 12mm/);
    });

    it("locks the body width to the A4 printable area (186mm)", () => {
      expect(doc).toContain("width: 186mm");
    });

    it("is a complete standalone document", () => {
      expect(doc).toContain("<!DOCTYPE html>");
      expect(doc).toContain("</html>");
      expect(doc).toContain('id="print-root"');
      expect(doc.indexOf("agreement-doc")).toBeLessThan(doc.indexOf("</html>"));
    });

    it("does NOT use the blank-page-causing visibility print hack", () => {
      expect(doc).not.toContain("visibility: hidden !important");
      expect(doc).not.toContain("body.printing-agreement #root");
    });

    it("keeps images inside the printable width", () => {
      expect(doc).toContain("img { max-width: 100% !important;");
      expect(doc).toContain(".agreement-media { max-width: 100% !important;");
    });

    it("prevents elements from being cut across pages", () => {
      expect(doc).toContain("page-break-inside: avoid");
      expect(doc).toContain("page-break-after: avoid");
    });

    it("preserves print colors for brand panels", () => {
      expect(doc).toContain("print-color-adjust: exact");
    });

    it("writes the document to disk for the headless print test", () => {
      const outDir = resolve(__dirname, "../../../scripts/output");
      mkdirSync(outDir, { recursive: true });
      const outFile = resolve(outDir, "test-loan-agreement.html");
      writeFileSync(outFile, doc, "utf8");
      expect(outFile).toBeTruthy();
    });
  });
});
