import { describe, expect, it } from "vitest";
import { compactApplicationForTransport, saveApplicationDraft, setAccessToken } from "./apiClient";
import { afterEach, vi } from "vitest";
import { isValidWithdrawalDestination } from "../components/InvestorWithdrawalForm";
import { paginateRepayments, repaymentProgressValues, sortRepaymentsRecentFirst } from "../pages/BorrowerDashboard";

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

describe("loan application draft persistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the current in-memory draft to the authenticated backend endpoint", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    vi.stubGlobal("window", { setTimeout, clearTimeout, dispatchEvent: vi.fn() });
    setAccessToken("borrower-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, draft: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const updatedAt = "2026-01-02T03:04:05.000Z";

    await saveApplicationDraft({ applicationId: "draft-1", applicantType: "PERSONAL", data: { personalInfo: { fullName: "Ada Borrower" } }, lastSectionIndex: 2, updatedAt });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/v1/borrower/application-draft"), expect.objectContaining({ method: "PUT" }));
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual(expect.objectContaining({ applicationId: "draft-1", lastSectionIndex: 2, updatedAt }));
    expect(options.headers.get("Authorization")).toBe("Bearer borrower-token");
  });
});

describe("repayment progress and history", () => {
  it("uses the full loan schedule as the denominator and only successful payments as paid", () => {
    const result = repaymentProgressValues(
      [
        { amountNaira: 100, status: "PENDING_PROVIDER_CONFIRMATION" },
        { amountNaira: 100, status: "SUCCESSFUL" },
      ],
      [{ totalRepaymentNaira: 517697.26, schedule: [{ totalDueNaira: 517697.26 }] }],
    );

    expect(result.scheduled).toBe(517697.26);
    expect(result.paid).toBe(100);
    expect(result.progress).toBe(0);
  });

  it("sorts records newest first and paginates them", () => {
    const records = [
      { id: "old", createdAt: "2026-09-12T20:00:00Z" },
      { id: "new", createdAt: "2026-09-12T23:00:00Z" },
      { id: "middle", createdAt: "2026-09-12T21:00:00Z" },
    ];
    expect(sortRepaymentsRecentFirst(records).map((record) => record.id)).toEqual(["new", "middle", "old"]);
    expect(paginateRepayments(records, 2, 2).records.map((record) => record.id)).toEqual(["old"]);
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
