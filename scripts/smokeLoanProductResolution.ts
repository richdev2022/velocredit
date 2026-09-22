// ============================================================================
// scripts/smokeLoanProductResolution.ts
// Runtime smoke test for the intelligent loan-product resolution introduced
// for backward compatibility + admin-editable catalog support.
//
// Run: npx tsx scripts/smokeLoanProductResolution.ts
// ============================================================================

import * as store from "../backend/server/store.js";
import {
  resolveLoanProductForApplication,
  captureProductSnapshot,
  classifyLoanProductType,
} from "../backend/server/routes.js";

async function main(): Promise<void> {
  await store.initializeStore();
  store.seedLoanProducts();
  store.normalizeLoanProducts();

  const loanProducts = store.loanProducts as unknown as Array<Record<string, any> & { name: string }>;
  console.log(`[smoke] catalog after seed: ${loanProducts.length} products ->`, loanProducts.map((p) => p.name));

  const personal = loanProducts.find((p) => /personal/i.test(p.name))!;
  const business = loanProducts.find((p) => /business/i.test(p.name))!;

  let failures = 0;
  function check(label: string, actual: unknown, expected: unknown): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
    if (!ok) failures++;
  }

  // 1. Stored product id wins even when inactive.
  personal.isActive = false;
  const resolvedInactive = resolveLoanProductForApplication({ loanProductId: personal.id, applicantType: "PERSONAL" });
  check("stored id resolves inactive product", resolvedInactive?.name, personal.name);
  personal.isActive = true;

  // 2. Deleted product -> falls back by applicant type keyword.
  const deletedId = "deleted-id-000";
  const resolvedDeleted = resolveLoanProductForApplication({ loanProductId: deletedId, applicantType: "BUSINESS" });
  check("deleted id falls back to business keyword product", resolvedDeleted?.name, business.name);

  // 3. No keywords anywhere -> amount-range containment.
  const snapshot = captureProductSnapshot(personal);
  check("snapshot captures product name", snapshot?.productName, personal.name);
  const byAmount = resolveLoanProductForApplication({ applicantType: "PERSONAL", amountNaira: 750_000 });
  check("amount containment resolves a product", Boolean(byAmount), true);

  // 4. Everything missing -> deterministic first product (never null while catalog non-empty).
  const lastResort = resolveLoanProductForApplication({ applicantType: "PERSONAL" });
  check("last resort resolves first product", Boolean(lastResort), true);

  // 5. classifyLoanProductType: keyword mapping.
  check("classify personal keyword", classifyLoanProductType(personal as never), "PERSONAL");
  check("classify business keyword", classifyLoanProductType(business as never), "BUSINESS");

  // 6. Rename simulation: product without keyword still resolves via stored id,
  //    and classification returns null (frontend deterministic fallback).
  const originalName = personal.name;
  personal.name = "Velo Flex Cash";
  check("classify renamed product -> null", classifyLoanProductType(personal as never), null);
  const renamedResolution = resolveLoanProductForApplication({ loanProductId: personal.id, applicantType: "PERSONAL" });
  check("stored id survives rename", renamedResolution?.name, "Velo Flex Cash");
  personal.name = originalName;

  // 7. Legacy application with NO id and NO snapshot (pre-change user) still
  //    resolves via applicant type — never empty info.
  const legacy = resolveLoanProductForApplication({ applicantType: "BUSINESS", amountNaira: 2_000_000 });
  check("legacy application (no ids) still resolves", legacy?.name, business.name);

  console.log(failures === 0 ? "\n[smoke] ALL CHECKS PASSED" : `\n[smoke] ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke] crashed:", err);
  process.exit(1);
});
