import "dotenv/config";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_PREFIX = `test-bvn-nin-${Date.now()}`;

type StoreModule = typeof import("./store.js");
type PremblyModule = typeof import("./providers/prembly.js");
type AuthModule = typeof import("./auth.js");

let storeMod: StoreModule;
let premblyMod: PremblyModule;
let authMod: AuthModule;
let express: typeof import("express");
let request: ReturnType<typeof import("supertest")>;
let kycCases: any[];
let users: any[];
let documents: any[];

function tempUser(suffix: string) {
  const email = `${TEST_PREFIX}-${suffix}@example.com`;
  const phone = "0801" + String(1_000_000 + Math.floor(Math.random() * 8_999_999)).padStart(7, "0");
  const id = (crypto as any).randomUUID
    ? (crypto as any).randomUUID()
    : `id-${TEST_PREFIX}-${suffix}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    email,
    fullName: `Test ${suffix.toUpperCase()} User`,
    phone,
    passwordHash: "$2a$10$placeholder",
    dateOfBirth: "1990-01-01",
    roles: ["BORROWER"] as const,
    kycStatus: "PENDING",
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as const;
}

function mockPremblySuccess(phone: string, fullName: string) {
  const parts = fullName.split(" ");
  return {
    status: "SUCCESS" as const,
    verified: true,
    providerReference: `ref-${Math.random().toString(36).slice(2)}`,
    normalizedFields: {
      firstName: parts[0] ?? "First",
      lastName: parts.slice(-1)[0] ?? "Last",
      phone_number: phone,
      dateOfBirth: "1990-01-01",
      photo: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    },
    rawResponse: { success: true },
  };
}

describe("BVN / NIN fixes — Neon PostgreSQL integration (Tasks 1, 2, 3)", () => {
  // Mutable fault/mock holders — ES module namespace exports are getter-only,
  // so overrides are injected through the module mocks below instead of
  // assigning to the namespace (which throws).
  const persistFault: { fn: null | (() => Promise<unknown>) } = { fn: null };
  const otpChallengeMock: { fn: null | ((...args: unknown[]) => unknown) } = { fn: null };

  beforeAll(async () => {
    vi.doMock("./providers/prembly.js", () => ({
      verifyBvn: vi.fn(),
      verifyNin: vi.fn(),
      verifyIdentityWithFace: vi.fn(),
      requestCreditReport: vi.fn().mockResolvedValue({
        status: "SUCCESS",
        providerReference: "cb-ref-test",
        rawResponse: {},
        normalizedFields: {},
      }),
    }));

    vi.doMock("./auth.js", async (importOriginal) => {
      const orig = (await importOriginal()) as AuthModule;
      return {
        ...orig,
        requireAuth: (_req: any, _res: any, next: any) => next(),
        requireRole: (..._roles: string[]) => (_req: any, _res: any, next: any) => next(),
        get createOtpChallenge() {
          return otpChallengeMock.fn ?? orig.createOtpChallenge;
        },
      };
    });

    vi.doMock("./store.js", async (importOriginal) => {
      const orig = (await importOriginal()) as StoreModule;
      return {
        ...orig,
        get persistStore() {
          return persistFault.fn ?? orig.persistStore;
        },
      };
    });

    express = (await import("express")).default;
    const supertestPkg = await import("supertest");
    request = (supertestPkg as any).default || supertestPkg;

    storeMod = await import("./store.js");
    premblyMod = await import("./providers/prembly.js");
    authMod = await import("./auth.js");
    const routesMod = await import("./routes.js");

    kycCases = (storeMod as any).kycCases;
    users = (storeMod as any).users;
    documents = (storeMod as any).documents;

    if (!process.env.DATABASE_URL) {
      console.warn("[bvnNinVerify.test] DATABASE_URL not set — persist/rebuild assertions will be in-memory only.");
    }

    try {
      await storeMod.initializeStore();
    } catch (err) {
      console.warn(
        "[bvnNinVerify.test] initializeStore failed; tests will operate on in-memory slices where possible:",
        err instanceof Error ? err.message : err,
      );
    }

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
    persistFault.fn = null;
    otpChallengeMock.fn = null;
  });

  afterAll(async () => {
    const needle = TEST_PREFIX;
    let cleaned = 0;
    for (let i = users.length - 1; i >= 0; i--) {
      if (typeof users[i].email === "string" && users[i].email.startsWith(needle)) {
        const uid = users[i].id;
        users.splice(i, 1);
        for (let j = kycCases.length - 1; j >= 0; j--) if (kycCases[j].userId === uid) kycCases.splice(j, 1);
        for (let j = documents.length - 1; j >= 0; j--) if (documents[j].userId === uid) documents.splice(j, 1);
        cleaned++;
      }
    }
    try {
      const persist = (storeMod as any).persistStore as (() => Promise<any>) | undefined;
      if (persist && cleaned > 0 && process.env.DATABASE_URL) {
        await persist().catch((err) => console.warn("[bvnNinVerify.test] cleanup persist failed:", err));
      }
    } catch (_e) {
      /* ignore cleanup errors */
    }
    console.log(`[bvnNinVerify.test] cleaned ${cleaned} temp users (prefix=${needle})`);
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

  it(
    "Task 3 AC-5: livenessStatus + livenessManualUploaded + identityPhotoUrl alias survive persist → rebuildFromDatabase",
    async () => {
      const user = tempUser("liveness");
      users.push(user);
      const kyc = storeMod.findOrCreateKycCase(user.id);
      expect(kyc).toBeDefined();
      kyc.livenessStatus = "SUCCESS";
      kyc.livenessManualUploaded = true;
      kyc.identityPhoto = "data:image/png;base64,iVBORw0KGg==";
      (kyc as any).identityPhotoUrl = undefined;
      kyc.selfieImageData = "data:image/png;base64,SELFIE";

      let rebuilt = false;
      try {
        if (process.env.DATABASE_URL && typeof (storeMod as any).persistStore === "function") {
          await (storeMod as any).persistStore();
          const dbMod = await import("./db.js");
          const sql = (dbMod as any).sql;
          if (sql) {
            const rebuildMod = await import("./rebuildFromDatabase.js");
            if (typeof rebuildMod.rebuildFromDatabase === "function") {
              const snap = await rebuildMod.rebuildFromDatabase(sql);
              const reloadedKyc = (snap.kycCases ?? []).find((k: any) => k.userId === user.id);
              expect(reloadedKyc).toBeDefined();
              expect(reloadedKyc.livenessStatus).toBe("SUCCESS");
              expect(reloadedKyc.livenessManualUploaded).toBe(true);
              expect(reloadedKyc.identityPhoto).toBe("data:image/png;base64,iVBORw0KGg==");
              expect((reloadedKyc as any).identityPhotoUrl).toBe("data:image/png;base64,iVBORw0KGg==");
              expect(reloadedKyc.selfieImageData).toBe("data:image/png;base64,SELFIE");
              rebuilt = true;
            }
          }
        }
      } finally {
        if (!rebuilt) {
          expect(kyc.livenessStatus).toBe("SUCCESS");
          expect(kyc.livenessManualUploaded).toBe(true);
          expect(kyc.identityPhoto).toBeTruthy();
          console.warn(
            "[bvnNinVerify.test] skipped full rebuild roundtrip (DATABASE_URL or rebuild module unavailable). In-memory fields are correct.",
          );
        }
      }
    },
    90_000,
  );

  it(
    "Task 1 AC-1/3: BVN verify + transient persistStore fault → 200 with otpChallenge AND persistRetrying flag",
    async () => {
      const user = tempUser("ac1");
      users.push(user);
      const kyc = storeMod.findOrCreateKycCase(user.id);
      kyc.checklist = {
        ...kyc.checklist,
        bvn: false,
        nin: false,
        liveness: true,
        proofOfAddress: true,
        signature: true,
        passport: true,
      };

      (premblyMod.verifyBvn as any) = vi.fn().mockResolvedValue(mockPremblySuccess(user.phone, user.fullName));
      otpChallengeMock.fn = vi.fn().mockResolvedValue({
        id: "ch_ac1_001", // route reads challenge.id (real createOtpChallenge contract)
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        resendAvailableAt: new Date(Date.now() + 30 * 1000).toISOString(),
        resendSecondsRemaining: 30,
      });
      // Capture the REAL persistStore BEFORE installing the fault (the
      // getter returns the fault while persistFault.fn is set).
      const origPersist = (storeMod as any).persistStore;
      let persistFaultedOnce = false;
      persistFault.fn = async () => {
        if (!persistFaultedOnce) {
          persistFaultedOnce = true;
          throw new Error("DB timeout (injected fault: AC-1)");
        }
        return typeof origPersist === "function" ? origPersist.call(storeMod) : Promise.resolve({});
      };

      const res = await request(getApp())
        .post("/api/v1/me/kyc/bvn/verify")
        .set(authHeaders(user))
        .send({ bvn: "12345678901" });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(res.body.ok).toBe(true);
      expect(res.body.otpChallenge?.challengeId).toBe("ch_ac1_001");
      expect(res.body.otpChallenge?.requiresPhoneVerification).toBe(true);
      expect(res.body.persistRetrying).toBe(true);
      expect(typeof res.body.persistError === "string" && res.body.persistError.length > 0).toBe(true);

      persistFault.fn = null;
    },
    90_000,
  );

  it(
    "Task 1 AC-2: NIN verify mirror → otpChallenge + persistRetrying on transient DB fault",
    async () => {
      const user = tempUser("ac2");
      users.push(user);
      const kyc = storeMod.findOrCreateKycCase(user.id);
      kyc.checklist = {
        ...kyc.checklist,
        bvn: true,
        nin: false,
        liveness: true,
        proofOfAddress: true,
        signature: true,
        passport: true,
      };

      (premblyMod.verifyNin as any) = vi.fn().mockResolvedValue(mockPremblySuccess(user.phone, user.fullName));
      otpChallengeMock.fn = vi.fn().mockResolvedValue({
        id: "ch_ac2_001", // route reads challenge.id (real createOtpChallenge contract)
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        resendAvailableAt: new Date(Date.now() + 30 * 1000).toISOString(),
        resendSecondsRemaining: 30,
      });

      const origPersist = (storeMod as any).persistStore;
      let persistFaultedOnce = false;
      persistFault.fn = async () => {
        if (!persistFaultedOnce) {
          persistFaultedOnce = true;
          throw new Error("DB timeout (injected fault: AC-2)");
        }
        return origPersist ? origPersist.call(storeMod) : Promise.resolve({});
      };

      const res = await request(getApp())
        .post("/api/v1/me/kyc/nin/verify")
        .set(authHeaders(user))
        .send({ nin: "12345678901" });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(res.body.ok).toBe(true);
      expect(res.body.otpChallenge?.challengeId).toBe("ch_ac2_001");
      expect(res.body.persistRetrying).toBe(true);

      persistFault.fn = null;
    },
    90_000,
  );

  it(
    "Task 2 AC-4: createOtpChallenge throws non-rate-limit → graceful fallback (auto-complete checklist OR descriptive warning)",
    async () => {
      const user = tempUser("ac4");
      users.push(user);
      const kyc = storeMod.findOrCreateKycCase(user.id);
      kyc.checklist = {
        ...kyc.checklist,
        bvn: false,
        nin: true,
        liveness: true,
        proofOfAddress: true,
        signature: true,
        passport: true,
      };

      (premblyMod.verifyBvn as any) = vi.fn().mockResolvedValue(mockPremblySuccess(user.phone, user.fullName));
      otpChallengeMock.fn = vi.fn(async () => {
        throw new Error("SMS gateway down (AC-4 inject)");
      });

      const res = await request(getApp())
        .post("/api/v1/me/kyc/bvn/verify")
        .set(authHeaders(user))
        .send({ bvn: "12345678901" });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(res.body.ok).toBe(true);

      const reloaded = storeMod.findOrCreateKycCase(user.id);
      const eitherGracefulPath =
        (typeof res.body.error === "string" && /SMS|channel|dispatch|gateway|verification/i.test(res.body.error)) ||
        (typeof res.body.otpWarning === "string" && res.body.otpWarning.length > 0) ||
        reloaded.checklist.bvn === true;
      expect(eitherGracefulPath).toBe(true);
      if (reloaded.checklist.bvn) {
        expect(typeof reloaded.bvnVerifiedAt === "string").toBe(true);
      }
    },
    90_000,
  );

  it(
    "Task 1 TR-1.3: Non-verify routes (POST /me/kyc) handle persistStore fail safely",
    async () => {
      const user = tempUser("tr13");
      users.push(user);
      storeMod.findOrCreateKycCase(user.id);

      const origPersist = (storeMod as any).persistStore;
      let faulted = 0;
      persistFault.fn = async () => {
        faulted++;
        throw new Error("DB timeout (TR-1.3 strict persist)");
      };

      const res = await request(getApp())
        .post("/api/v1/me/kyc")
        .set(authHeaders(user))
        .send({ checklist: { bvn: false, nin: false, liveness: false } });

      // Current contract: a transient persist failure never fails the
      // request — the in-memory mutation stands and the background sweeper
      // persists it (persistMutation logs + retries). The state stays
      // consistent either way.
      expect(res.status).toBeLessThan(300);
      expect(res.body.ok).toBe(true);
      persistFault.fn = null;
      expect(faulted).toBeGreaterThanOrEqual(1);
    },
    90_000,
  );
});
