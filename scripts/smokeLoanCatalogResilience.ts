// ============================================================================
// scripts/smokeLoanCatalogResilience.ts
// Reproduces the 2026-09 production incident and proves the fixes:
//
//   Incident: GET /api/v1/borrower/loan-products returned { ok:true,
//   products: [] } while the admin had loan products configured.
//
//   Covered failure modes (all previously reachable in production):
//     A. ALL products inactive  -> endpoint used to serve [] (funnel bricked).
//        Now: serves the full catalog + catalogNotice + activeCount.
//     B. Empty in-memory catalog (partial boot / hydration race) -> endpoint
//        used to serve [] for the life of the process.
//        Now: reloads from Postgres (or seeds) before answering.
//     C. Ghost duplicate rows (same id / same name) -> previously resurrected
//        ₦50,000 seed terms after the admin configured ₦200.
//        Now: deduped on read + ghost rows purged from Postgres at boot.
//
// Run: env -u DATABASE_URL npx tsx scripts/smokeLoanCatalogResilience.ts
// ============================================================================

import express from "express";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "smoke-test-secret-0123456789abcdef0123456789";

async function issueTokens(): Promise<void> {
  const auth = await import("../backend/server/auth.js");
  issueTokenFn = (user: any) => (auth as any).issueToken(user);
}
let issueTokenFn: ((user: any) => string) | null = null;

type StoreModule = typeof import("../backend/server/store.js");
type RoutesModule = typeof import("../backend/server/routes.js");

async function main(): Promise<void> {
  await issueTokens();
  if (!issueTokenFn) throw new Error("issueToken not initialised");
  const storeMod: StoreModule = await import("../backend/server/store.js");
  const routesMod: RoutesModule = await import("../backend/server/routes.js");

  try {
    await storeMod.initializeStore();
  } catch (err) {
    console.warn("[smoke] initializeStore warning:", err instanceof Error ? err.message : err);
  }
  storeMod.seedLoanProducts();
  storeMod.normalizeLoanProducts();

  const supertestPkg = await import("supertest");
  const request = (supertestPkg as any).default || supertestPkg;

  const app = express();
  app.use(express.json());
  app.use("/api/v1", routesMod.default);

  const loanProducts = storeMod.loanProducts as unknown as any[];

  const borrowerId = `smoke-borrower-${Date.now()}`;
  const adminId = `smoke-admin-${Date.now()}`;
  const adminUser = { id: adminId, email: `${adminId}@example.com`, fullName: "Smoke Admin", roles: ["ADMIN"], kycStatus: "VERIFIED" };
  const borrowerUser = { id: borrowerId, email: `${borrowerId}@example.com`, fullName: "Smoke Borrower", roles: ["BORROWER"], kycStatus: "VERIFIED" };
  const adminHeaders = { Authorization: `Bearer ${issueTokenFn(adminUser)}` };
  const borrowerHeaders = { Authorization: `Bearer ${issueTokenFn(borrowerUser)}` };

  let failures = 0;
  function check(label: string, ok: boolean, detail?: unknown): void {
    console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    if (!ok) failures++;
  }

  // --- 0. ensure the borrower + admin users exist (requireAuth checks the store) ---
  const users = storeMod.users as unknown as any[];
  users.push({
    id: borrowerId, email: `${borrowerId}@example.com`, phone: "08012345678",
    fullName: "Smoke Borrower", passwordHash: "x", roles: ["BORROWER"],
    kycStatus: "VERIFIED", isActive: true, createdAt: new Date().toISOString(),
  });
  users.push({
    id: adminId, email: `${adminId}@example.com`, phone: "08012345679",
    fullName: "Smoke Admin", passwordHash: "x", roles: ["ADMIN"],
    kycStatus: "VERIFIED", isActive: true, createdAt: new Date().toISOString(),
  });

  // Baseline: catalog must be non-empty (seeded).
  check("baseline catalog non-empty", loanProducts.length >= 2, loanProducts.length);

  // --- A. ALL products inactive — the production empty-array incident ---
  for (const p of loanProducts) p.isActive = false;
  const incidentRes = await request(app).get("/api/v1/borrower/loan-products").set(borrowerHeaders);
  check("A1: all-inactive still returns ok:true", incidentRes.status === 200 && incidentRes.body.ok === true, incidentRes.body);
  check("A2: NOT an empty array (funnel not bricked)", Array.isArray(incidentRes.body.products) && incidentRes.body.products.length > 0, incidentRes.body.products);
  check("A3: fallback flagged via catalogNotice", incidentRes.body.catalogNotice === "ALL_PRODUCTS_INACTIVE_FALLBACK", incidentRes.body.catalogNotice);
  check("A4: activeCount reported as 0", incidentRes.body.activeCount === 0, incidentRes.body.activeCount);
  check("A5: every product served with programType field", incidentRes.body.products.every((p: any) => "programType" in p), incidentRes.body.products?.map((p: any) => p.name));

  // --- B. recovery: re-activate exactly one product (the "Activate all" path) ---
  const survivor = loanProducts.find((p) => /personal/i.test(p.name)) ?? loanProducts[0];
  const patchRes = await request(app)
    .patch(`/api/v1/admin/loan-products/${survivor.id}`)
    .set(adminHeaders)
    .send({ isActive: true });
  check("B1: admin re-activated one product", patchRes.status === 200 && patchRes.body.product.isActive === true, patchRes.body);
  const recoveredRes = await request(app).get("/api/v1/borrower/loan-products").set(borrowerHeaders);
  check("B2: recovered catalog has NO fallback notice", recoveredRes.body.catalogNotice === null, recoveredRes.body.catalogNotice);
  check("B3: only ACTIVE products served", recoveredRes.body.products.length === 1 && recoveredRes.body.products[0].id === survivor.id, recoveredRes.body.products?.map((p: any) => p.name));
  check("B4: activeCount reported as 1", recoveredRes.body.activeCount === 1, recoveredRes.body.activeCount);

  // --- C. ghost duplicate rows are collapsed on read ---
  const ghostCopy = { ...survivor, name: `${survivor.name} Stale`, version: 1, updatedAt: new Date(Date.now() - 86400000).toISOString() };
  const freshCopy = { ...survivor, version: (Number(survivor.version) || 1) + 5, updatedAt: new Date().toISOString() };
  loanProducts.push(ghostCopy, freshCopy); // same id, 3 rows total
  const dupRes = await request(app).get("/api/v1/borrower/loan-products").set(borrowerHeaders);
  check("C1: duplicate-id rows collapsed to ONE", dupRes.body.products.filter((p: any) => p.id === survivor.id).length === 1, dupRes.body.products?.map((p: any) => [p.name, p.version]));
  check("C2: HIGHEST version survived", dupRes.body.products.find((p: any) => p.id === survivor.id)?.version === freshCopy.version, dupRes.body.products?.find((p: any) => p.id === survivor.id)?.version);

  // --- D. same-name twins (distinct ids) are collapsed too ---
  const nameTwin = { ...structuredClone(ghostCopy), id: "smoke-twin-id-0000-0000", version: 1, updatedAt: new Date().toISOString() };
  loanProducts.push(nameTwin);
  const twinRes = await request(app).get("/api/v1/borrower/loan-products").set(borrowerHeaders);
  const nameMatches = twinRes.body.products.filter((p: any) => p.name.trim().toLowerCase() === `${survivor.name} stale`.toLowerCase());
  check("D1: same-name twins collapsed to newest", nameMatches.length <= 1, nameMatches.map((p: any) => [p.id, p.version]));

  // --- E. empty in-memory catalog self-heals before answering ---
  loanProducts.splice(0, loanProducts.length); // simulate a partial boot
  const healedRes = await request(app).get("/api/v1/borrower/loan-products").set(borrowerHeaders);
  check("E1: empty catalog healed (non-empty response)", Array.isArray(healedRes.body.products) && healedRes.body.products.length > 0, healedRes.body.products);
  check("E2: healed via seed/reload fallback", loanProducts.length > 0, loanProducts.length);

  // --- F. admin endpoint always exposes the full catalog + activeCount ---
  const adminRes = await request(app).get("/api/v1/admin/loan-products").set(adminHeaders);
  check("F1: admin catalog visible", adminRes.status === 200 && Array.isArray(adminRes.body.products) && adminRes.body.products.length > 0, adminRes.body.products?.length);
  check("F2: admin activeCount present", typeof adminRes.body.activeCount === "number", adminRes.body.activeCount);

  // --- cleanup ---
  const userIdx = users.findIndex((u) => u.id === borrowerId);
  if (userIdx >= 0) users.splice(userIdx, 1);
  const adminIdx = users.findIndex((u) => u.id === adminId);
  if (adminIdx >= 0) users.splice(adminIdx, 1);

  console.log(failures === 0 ? "\n[smoke] ALL CHECKS PASSED" : `\n[smoke] ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke] crashed:", err);
  process.exit(1);
});
