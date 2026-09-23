// ============================================================================
// scripts/testAgreementPrint.mjs
// Renders the generated test loan agreement (scripts/output/test-loan-agreement.html)
// with headless Chromium under PRINT media emulation and prints it to a real
// A4 PDF — exactly what the browser produces when the user hits "Print full
// agreement".
//
// Verifies:
//   1. The print CSS resolves to a sane number of A4 pages (1–30).
//   2. NO page is blank (per-page text extraction via pdftotext + ink check).
//   3. No content overflows the A4 width (elements wider than the printable
//      area would be clipped in print).
//
// Usage: node scripts/testAgreementPrint.mjs
// ============================================================================

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("/home/z/.npm-global/lib/node_modules/playwright");

const INPUT = resolve("scripts/output/test-loan-agreement.html");
const OUTPUT_PDF = resolve("scripts/output/test-loan-agreement-print.pdf");

if (!existsSync(INPUT)) {
  console.error("FAIL: test agreement not found — run the vitest suite first (agreementPrint.test.ts).");
  process.exit(1);
}

const failures = [];

// ---------------------------------------------------------------------------
// 1. Render to PDF with A4 print emulation
// ---------------------------------------------------------------------------
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.emulateMedia({ media: "print" });
  await page.goto(`file://${INPUT}`, { waitUntil: "load", timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: OUTPUT_PDF,
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true, // honor @page { size: A4 }
    margin: { top: "14mm", bottom: "16mm", left: "12mm", right: "12mm" },
  });

  // ---------------------------------------------------------------------------
  // 2. Page count + geometry via pdfinfo
  // ---------------------------------------------------------------------------
  const info = execFileSync("pdfinfo", [OUTPUT_PDF], { encoding: "utf8" });
  const pageSizeLine = info.split("\n").find((line) => line.startsWith("Page size:"));
  const pageCount = Number((info.match(/Pages:\s+(\d+)/) ?? [])[1] ?? 0);
  console.log(`PDF generated: ${OUTPUT_PDF}`);
  console.log(`Pages: ${pageCount}`);
  console.log(`${pageSizeLine}`);

  if (pageCount < 1 || pageCount > 30) failures.push(`Unreasonable page count: ${pageCount}`);
  if (!pageSizeLine || !/Page size:\s+59[3-7](\.\d+)? x 84[0-4](\.\d+)? pts \(A4\)/.test(pageSizeLine)) {
    failures.push(`Page size is not A4 (expected ~595 x 842 pts): ${pageSizeLine}`);
  }

  // ---------------------------------------------------------------------------
  // 3. NO blank pages — extract text per page; every page must have content.
  //    (A blank page = the classic symptom of the old visibility hack.)
  // ---------------------------------------------------------------------------
  const blankPages = [];
  for (let p = 1; p <= pageCount; p += 1) {
    const text = execFileSync("pdftotext", ["-f", String(p), "-l", String(p), OUTPUT_PDF, "-"], { encoding: "utf8" });
    const meaningful = text.replace(/\s+/g, " ").trim();
    if (meaningful.length < 20) blankPages.push(p);
  }
  console.log(`Blank pages: ${blankPages.length === 0 ? "none ✓" : blankPages.join(", ")}`);
  if (blankPages.length > 0) failures.push(`Blank pages detected: ${blankPages.join(", ")}`);

  // Content must actually be spread across the document (not one stray word).
  const fullText = execFileSync("pdftotext", [OUTPUT_PDF, "-"], { encoding: "utf8" });
  for (const needle of ["Adaeze Chiamaka Okafor", "VEL-LN-2026-000451", "Chukwuemeka Nwosu"]) {
    if (!fullText.includes(needle)) failures.push(`Expected content missing from printed PDF: ${needle}`);
  }
  console.log(`Printed text length: ${fullText.replace(/\s+/g, " ").trim().length} chars`);

  // ---------------------------------------------------------------------------
  // 4. A4 responsiveness — no element wider than the printable area (186mm ≈
  //    703 CSS px). Overflowing elements would be clipped in print.
  // ---------------------------------------------------------------------------
  await page.emulateMedia({ media: "print" });
  const overflowing = await page.evaluate(() => {
    const LIMIT = 704; // 186mm at 96dpi = 702.99px
    const bad = [];
    document.querySelectorAll("#print-root, #print-root *").forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width > LIMIT + 1) {
        bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} width=${Math.round(rect.width)}px`);
      }
    });
    return bad.slice(0, 10);
  });
  console.log(`Elements overflowing A4 printable width: ${overflowing.length === 0 ? "none ✓" : overflowing.join(" | ")}`);
  if (overflowing.length > 0) failures.push(`Content overflows printable width: ${overflowing.join(" | ")}`);
} finally {
  await browser.close();
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error("\nPRINT TEST FAILED:");
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log("\nPRINT TEST PASSED — agreement prints as a clean A4 document with no blank pages.");
