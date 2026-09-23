import "dotenv/config";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BVN pooling pipeline tests (2026-09):
 *   1. providerRaw MERGES — both the BVN and NIN raw blocks survive no matter
 *      which verification ran last (the old code overwrote the whole object,
 *      destroying the other identifier's raw data).
 *   2. Cross-harvest — the NIBSS BVN response can carry the linked NIN and
 *      the NIMC NIN response can carry the linked BVN; both are captured.
 *   3. resolveFullBvn unmasks — masked display values ("***-***-1234") are
 *      rejected; the full 11-digit BVN is recovered from the raw store and
 *      backfilled onto the KYC case.
 *   4. The consumer credit bureau check ALWAYS passes the full BVN and NEVER
 *      the NIN (Prembly's bureau API is strictly BVN-driven); a borrower with
 *      no recoverable BVN gets NO_IDENTITY with a "BVN is mandatory" message.
 *   5. Reapply-prefill pools the UNMASKED BVN and strips masked snapshot
 *      leftovers.
 *   6. Loan submission gate requires a full 11-digit BVN on file.
 */

const TEST_PREFIX = `test-bvnpool-${Date.now()}`;

type StoreModule = typeof import("./store.js");
type PremblyModule = typeof import("./providers/prembly.js");
type CreditBureauModule = typeof import("./creditBureau.js");
type AuthModule = typeof import("./auth.js");

let storeMod: StoreModule;
let premblyMod: PremblyModule;
let creditBureauMod: CreditBureauModule;
let authMod: AuthModule;
let express: typeof import("express");
let request: ReturnType<typeof import("supertest")>;
let kycCases: any[];
let users: any[];
let loanApplications: any[];
let identityVerificationEvents: any[];

const FULL_BVN = "22098765432";
const FULL_NIN = "10987654321";
const MASKED_BVN = "***-***-5432";

function tempUser(suffix: string) {
  const email = `${TEST_PREFIX}-${suffix}@example.com`;
  const phone = "0802" + String(1_000_000 + Math.floor(Math.random() * 8_999_999)).padStart(7, "0");
  const id = (crypto as any).randomUUID
    ? (crypto as any).randomUUID()
    : `id-${TEST_PREFIX}-${suffix}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    email,
    fullName: `Pool ${suffix}`,
    phone,
    passwordHash: "$2a$10$placeholder",
    dateOfBirth: "1990-01-01",
    roles: ["BORROWER"] as const,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as const;
}

function bvnSuccessRaw(bvn: string, extra: Record<string, unknown> = {}) {
  return {
    status: "SUCCESS" as const,
    providerReference: `bvn-ref-${Math.random().toString(36).slice(2)}`,
    normalizedFields: { bvn, firstName: "Pool", lastName: "Tester", dateOfBirth: "1990-01-01", ...extra },
    rawResponse: { bvn: { status: true, response_code: "00", data: { bvn, firstName: "Pool", lastName: "Tester", ...extra } } },
  };
}

function ninSuccessRaw(nin: string, extra: Record<string, unknown> = {}) {
  return {
    status: "SUCCESS" as const,
    providerReference: `nin-ref-${Math.random().toString(36).slice(2)}`,
    normalizedFields: { nin, firstName: "Pool", lastName: "Tester", dateOfBirth: "01-01-1990", ...extra },
    rawResponse: { nin: { status: true, response_code: "00", nin_data: { nin, firstname: "Pool", surname: "Tester", ...extra } } },
  };
}

describe("BVN pooling — raw store keeps BOTH identifiers, unmasked BVN flows to Prembly", () => {
  beforeAll(async () => {
    vi.doMock("./providers/prembly.js", () => ({
      verifyBvn: vi.fn(),
      verifyNin: vi.fn(),
      verifyIdentityWithFace: vi.fn(),
      verifyLiveness: vi.fn(),
      requestCreditReport: vi.fn(),
      requestCommercialCreditReport: vi.fn(),
      verifyPremblyWebhook: vi.fn(() => true),
      isTimeoutError: vi.fn(() => false),
    }));

    vi.doMock("./auth.js", async (importOriginal) => {
      const orig = (await importOriginal()) as AuthModule;
      return {
        ...orig,
        requireAuth: (_req: any, _res: any, next: any) => next(),
        requireRole: (..._roles: string[]) => (_req: any, _res: any, next: any) => next(),
        createOtpChallenge: vi.fn(),
      };
    });

    // Keep tests hermetic: the real store module is used in-memory only —
    // DB init and persistence are stubbed out.
    vi.doMock("./store.js", async (importOriginal) => {
      const orig = (await importOriginal()) as StoreModule;
      return {
        ...orig,
        initializeStore: vi.fn(async () => ({})),
        persistStore: vi.fn(async () => ({})),
      };
    });

    express = (await import("express")).default;
    const supertestPkg = await import("supertest");
    request = (supertestPkg as any).default || supertestPkg;

    storeMod = await import("./store.js");
    premblyMod = await import("./providers/prembly.js");
    creditBureauMod = await import("./creditBureau.js");
    authMod = await import("./auth.js");
    const routesMod = await import("./routes.js");

    kycCases = (storeMod as any).kycCases;
    users = (storeMod as any).users;
    loanApplications = (storeMod as any).loanApplications;
    identityVerificationEvents = (storeMod as any).identityVerificationEvents;

    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      if (req.headers["x-test-user-id"]) {
        req.user = {
          id: req.headers["x-test-user-id"],
          roles: JSON.parse(req.headers["x-test-roles"] || '["BORROWER"]'),
        };
      }
      next();
    });
    app.use("/api/v1", routesMod.default);
    (globalThis as any).__testApp = app;
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    const needle = TEST_PREFIX;
    let cleaned = 0;
    for (let i = users.length - 1; i >= 0; i--) {
      if (typeof users[i].email === "string" && users[i].email.startsWith(needle)) {
        const uid = users[i].id;
        const ownedKycIds = new Set(kycCases.filter((k: any) => k.userId === uid).map((k: any) => k.id));
        users.splice(i, 1);
        for (let j = kycCases.length - 1; j >= 0; j--) if (kycCases[j].userId === uid) kycCases.splice(j, 1);
        for (let j = loanApplications.length - 1; j >= 0; j--) if (loanApplications[j].borrowerId === uid) loanApplications.splice(j, 1);
        for (let j = identityVerificationEvents.length - 1; j >= 0; j--) {
          if (ownedKycIds.has(identityVerificationEvents[j].kycCaseId)) identityVerificationEvents.splice(j, 1);
        }
        cleaned++;
      }
    }
    console.log(`[bvnPooling.test] cleaned ${cleaned} temp users (prefix=${needle})`);
  }, 30_000);

  function authHeaders(user: any) {
    return {
      "x-test-user-id": user.id,
      "x-test-roles": JSON.stringify(user.roles ?? ["BORROWER"]),
    };
  }

  function getApp() {
    return (globalThis as any).__testApp;
  }

  it("providerRaw MERGES: BVN verify then NIN verify keeps BOTH raw blocks", async () => {
    const user = tempUser("merge-seq");
    users.push(user);

    (premblyMod.verifyBvn as any) = vi.fn().mockResolvedValue(bvnSuccessRaw("12345678901"));
    // No identity phone → no OTP branch → checklist completes directly.
    const resBvn = await request(getApp()).post("/api/v1/me/kyc/bvn/verify").set(authHeaders(user)).send({ bvn: "12345678901" });
    expect(resBvn.status).toBeLessThan(300);
    expect(resBvn.body.ok).toBe(true);

    const kyc = storeMod.findOrCreateKycCase(user.id);
    expect((kyc.providerRaw as any)?.bvn).toBeDefined();

    (premblyMod.verifyNin as any) = vi.fn().mockResolvedValue(ninSuccessRaw("10987654321"));
    const resNin = await request(getApp()).post("/api/v1/me/kyc/nin/verify").set(authHeaders(user)).send({ nin: "10987654321" });
    expect(resNin.status).toBeLessThan(300);

    // THE regression: NIN last must NOT destroy the BVN raw block.
    expect((kyc.providerRaw as any)?.bvn).toBeDefined();
    expect((kyc.providerRaw as any)?.nin).toBeDefined();
    expect((kyc.providerRaw as any)?.bvn?.data?.bvn).toBe("12345678901");
    expect(kyc.bvn).toBe("12345678901");
    expect(kyc.nin).toBe("10987654321");
  }, 60_000);

  it("cross-harvest: NIN response carrying the linked BVN backfills kyc.bvn (BVN is mandatory)", async () => {
    const user = tempUser("cross-bvn");
    users.push(user);
    const kyc = storeMod.findOrCreateKycCase(user.id);
    expect(kyc.bvn ?? "").toBe("");

    (premblyMod.verifyNin as any) = vi.fn().mockResolvedValue(ninSuccessRaw(FULL_NIN, { bvn: FULL_BVN }));
    const res = await request(getApp()).post("/api/v1/me/kyc/nin/verify").set(authHeaders(user)).send({ nin: FULL_NIN });
    expect(res.status).toBeLessThan(300);

    expect(kyc.bvn).toBe(FULL_BVN); // harvested from the NIMC raw response
    expect(kyc.nin).toBe(FULL_NIN);
  }, 60_000);

  it("cross-harvest: BVN response carrying the linked NIN backfills kyc.nin", async () => {
    const user = tempUser("cross-nin");
    users.push(user);
    const kyc = storeMod.findOrCreateKycCase(user.id);
    expect(kyc.nin ?? "").toBe("");

    (premblyMod.verifyBvn as any) = vi.fn().mockResolvedValue(bvnSuccessRaw(FULL_BVN, { nin: FULL_NIN }));
    const res = await request(getApp()).post("/api/v1/me/kyc/bvn/verify").set(authHeaders(user)).send({ bvn: FULL_BVN });
    expect(res.status).toBeLessThan(300);

    expect(kyc.nin).toBe(FULL_NIN); // harvested from the NIBSS raw response
    expect(kyc.bvn).toBe(FULL_BVN);
  }, 60_000);

  it("resolveFullBvn unmasks: masked kyc.bvn is repaired from the raw store by backfillIdentityNumbers", () => {
    const user = tempUser("unmask");
    users.push(user);
    const kyc = storeMod.findOrCreateKycCase(user.id);
    kyc.bvn = MASKED_BVN; // legacy masked display value
    kyc.nin = FULL_NIN;
    kyc.providerRaw = { nin: { status: true, nin_data: { nin: FULL_NIN, bvn: FULL_BVN } } };

    // Before backfill: the column is masked garbage.
    expect(kyc.bvn).toBe(MASKED_BVN);
    const resolved = creditBureauMod.resolveFullBvn(user.id);
    expect(resolved).toBe(FULL_BVN); // recovered from the NIMC raw block

    creditBureauMod.backfillIdentityNumbers(user.id);
    expect(kyc.bvn).toBe(FULL_BVN); // column repaired in place
  });

  it("consumer bureau check passes the FULL BVN and NEVER the NIN", async () => {
    const user = tempUser("bureau-bvn");
    users.push(user);
    const kyc = storeMod.findOrCreateKycCase(user.id);
    kyc.bvn = MASKED_BVN; // masked display value — must be unmasked first
    kyc.nin = FULL_NIN; // NIN on file — must NOT be sent to the bureau
    kyc.providerRaw = { bvn: { status: true, data: { bvn: FULL_BVN } } };

    const reportResult = {
      status: "SUCCESS" as const,
      providerReference: "cb-ref-1",
      normalizedFields: { score: 640 },
      rawResponse: { response_code: "00" },
    };
    (premblyMod.requestCreditReport as any) = vi.fn().mockResolvedValue(reportResult);

    const outcome = await creditBureauMod.runCreditBureauCheck(user.id, { source: "TEST" });
    expect(outcome.ok).toBe(true);
    const call = (premblyMod.requestCreditReport as any).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.number).toBe(FULL_BVN); // full unmasked BVN
    expect(call.number).not.toBe(FULL_NIN); // never the NIN
    expect(call.mode).toBe("ID");

    if (outcome.ok) {
      const masked = (outcome.report.normalizedFields as any)?.bvnMasked;
      expect(masked).toBe("***-***-5432");
      // The NIN must never appear as the number actually queried.
      expect((outcome.report.normalizedFields as any)?.ninMasked).toBe("***-***-4321");
    }
  }, 60_000);

  it("consumer bureau check without any recoverable BVN → NO_IDENTITY with 'BVN is mandatory'", async () => {
    const user = tempUser("bureau-ninonly");
    users.push(user);
    const kyc = storeMod.findOrCreateKycCase(user.id);
    kyc.nin = FULL_NIN; // NIN only — Prembly's bureau API is strictly BVN
    kyc.providerRaw = { nin: { status: true, nin_data: { nin: FULL_NIN } } };

    const outcome = await creditBureauMod.startCreditBureauCheck(user.id, { source: "TEST" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("NO_IDENTITY");
      expect(outcome.message).toMatch(/BVN is mandatory/i);
      expect(outcome.message).toMatch(/does not accept a NIN/i);
    }
    expect(premblyMod.requestCreditReport).not.toHaveBeenCalled();
  }, 60_000);

  it("reapply-prefill pools the UNMASKED BVN and strips masked snapshot leftovers", async () => {
    const user = tempUser("prefill");
    users.push(user);
    const kyc = storeMod.findOrCreateKycCase(user.id);
    kyc.bvn = MASKED_BVN; // masked column
    kyc.nin = FULL_NIN;
    kyc.checklist = { ...kyc.checklist, bvn: true, nin: true, liveness: true };
    kyc.providerRaw = { bvn: { status: true, data: { bvn: FULL_BVN } } };

    const appId = `app-${Math.random().toString(36).slice(2, 10)}`;
    loanApplications.push({
      id: appId,
      applicationId: appId,
      borrowerId: user.id,
      status: "REPAID",
      submittedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      customerSnapshot: {
        kyc: { bvn: MASKED_BVN, nin: "***-***-4321", bvnVerified: true, ninVerified: true },
        personalInfo: { fullName: user.fullName, phone: user.phone },
      },
    });

    const res = await request(getApp()).get("/api/v1/borrower/applications/reapply-prefill").set(authHeaders(user));
    expect(res.status).toBeLessThan(300);
    expect(res.body.ok).toBe(true);
    expect(res.body.prefill?.kyc).toBeTruthy();
    // The unmasked FULL BVN wins — masked display leftovers are stripped.
    expect(res.body.prefill.kyc.bvn).toBe(FULL_BVN);
    expect(String(res.body.prefill.kyc.bvn)).not.toContain("*");
    expect(res.body.prefill.kyc.nin).toBe(FULL_NIN);
    expect(res.body.prefill.kyc.bvnVerified).toBe(true);

    // Self-heal: the KYC-case column was repaired by the pooling read.
    expect(kyc.bvn).toBe(FULL_BVN);
  }, 60_000);

  it("submission gate: a borrower with NO recoverable full BVN cannot submit (BVN mandatory)", async () => {
    const user = tempUser("gate-blocked");
    users.push(user);
    const kyc = storeMod.findOrCreateKycCase(user.id);
    kyc.bvn = MASKED_BVN; // masked, and NO raw source to recover from
    kyc.nin = FULL_NIN;
    kyc.checklist = { ...kyc.checklist, bvn: true, nin: true, liveness: true };

    const appId = `app-gate-${Math.random().toString(36).slice(2, 10)}`;
    loanApplications.push({
      id: appId,
      applicationId: appId,
      borrowerId: user.id,
      status: "IN_PROGRESS",
      createdAt: new Date().toISOString(),
    });

    const res = await request(getApp()).post(`/api/v1/borrower/applications/${appId}/submit`).set(authHeaders(user)).send({});
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/BVN/i);
    expect(String(res.body.error)).toMatch(/mandatory/i);
  }, 60_000);
});
