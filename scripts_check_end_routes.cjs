const fs = require('fs');
let content = fs.readFileSync('backend/server/routes.ts', 'utf8');

// Find the end - look for the last export default router
const exportIdx = content.lastIndexOf("export default router;");
console.log("export default router at index:", exportIdx);

// Also check current imports from store to see what's missing
const importsSection = content.slice(0, 20000);
const storeImports = [];
const needed = [
  "getAdminLedgerBalanceMinor",
  "adminLedger",
  "getPlatformSettings",
  "updatePlatformSettings",
  "setInvestorEarningRateOverride",
  "getEffectiveInvestorRate",
  "investorWithdrawals",
  "appendAdminLedger",
  "notifications",
];
for (const n of needed) {
  if (importsSection.includes(`"${n}"`) || importsSection.includes(`, ${n},`) || importsSection.includes(` ${n}\n`) || importsSection.includes(`${n} from`)) {
    console.log(`✅ ${n} already imported`);
  } else {
    console.log(`❌ ${n} NOT imported`);
  }
}

console.log("\nLast 400 chars before export:");
console.log(content.slice(exportIdx - 400, exportIdx));
