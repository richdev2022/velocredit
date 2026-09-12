import { describe, expect, it } from "vitest";
import { compactApplicationForTransport } from "./apiClient";
import { isValidWithdrawalDestination } from "../components/InvestorWithdrawalForm";

const baseApplication = (applicantType: "PERSONAL" | "BUSINESS") => ({
  applicationId: `${applicantType}-draft`,
  applicantType,
  personalInfo: applicantType === "PERSONAL" ? { fullName: "Ada Borrower", email: "ada@example.com" } : {},
  businessInfo: applicantType === "BUSINESS" ? { businessName: "Ada Trading Ltd" } : {},
  businessRep: applicantType === "BUSINESS" ? { fullName: "Ada Representative" } : {},
  loanRequest: { amount: 250000, tenure: 90, purpose: "Working capital" },
  kyc: { bvn: "12345678901", selfieImageData: "data:image/jpeg;base64,large-image" },
  documents: {
    collateralMedia: { name: "title.jpg", type: "image/jpeg", data: "large-binary-payload", status: "uploaded" },
    witnessPassport: { name: "passport.jpg", type: "image/jpeg", data: "large-binary-payload", status: "uploaded" },
  },
  collateral: { type: "Vehicle", description: "A vehicle", estimatedValue: "5000000" },
  witness: { fullName: "Witness", phone: "08000000000" },
  agreement: { generatedHtml: '<img src="data:image/jpeg;base64,large-binary-payload" />', signedAgreementAccepted: true },
});

describe("loan application transport", () => {
  it.each(["PERSONAL", "BUSINESS"] as const)("compacts %s applications without binary payloads", (applicantType) => {
    const compact = compactApplicationForTransport(baseApplication(applicantType));
    const documents = compact.documents as Record<string, Record<string, unknown>>;
    const kyc = compact.kyc as Record<string, unknown>;
    const agreement = compact.agreement as Record<string, unknown>;

    expect(compact.applicantType).toBe(applicantType);
    expect(documents.collateralMedia).toEqual({ name: "title.jpg", type: "image/jpeg", status: "uploaded" });
    expect(documents.witnessPassport).toEqual({ name: "passport.jpg", type: "image/jpeg", status: "uploaded" });
    expect(kyc.selfieImageData).toBeUndefined();
    expect(agreement.generatedHtml).toBeNull();
    expect((compact.collateral as Record<string, unknown>).description).toBe("A vehicle");
    expect((compact.witness as Record<string, unknown>).fullName).toBe("Witness");
    expect(JSON.stringify(compact)).not.toContain("large-binary-payload");
  });
});

describe("withdrawal destination validation", () => {
  it("accepts a verified ten-digit destination within the available balance", () => {
    expect(isValidWithdrawalDestination("50000", 100000, "058", "0123456789", "Ada Borrower")).toBe(true);
  });

  it("rejects an unverified, malformed, or over-limit destination", () => {
    expect(isValidWithdrawalDestination("50000", 100000, "058", "0123456789", "")).toBe(false);
    expect(isValidWithdrawalDestination("50000", 100000, "058", "123", "Ada Borrower")).toBe(false);
    expect(isValidWithdrawalDestination("150000", 100000, "058", "0123456789", "Ada Borrower")).toBe(false);
  });
});
