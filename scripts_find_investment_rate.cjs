const fs = require('fs');
let content = fs.readFileSync('backend/server/routes.ts', 'utf8');

const investStart = content.indexOf('router.post("/investments"');
console.log("investStart:", investStart);

if (investStart > 0) {
  // Find a reasonable endpoint ending (next router.get or router.post after this with /investments)
  let nextIdx = -1;
  const candidates = [
    'router.get("/investments"',
    'router.post("/investor/wallet/funding"',
    'router.get("/me/kyc"',
    'router.post("/me/kyc"',
  ];
  for (const c of candidates) {
    const idx = content.indexOf(c, investStart + 10);
    if (idx > 0 && (nextIdx < 0 || idx < nextIdx)) nextIdx = idx;
  }
  console.log("nextIdx (end of section):", nextIdx);
  if (nextIdx > 0) {
    const section = content.slice(investStart, nextIdx);
    console.log("\nInvestment creation section - searching for annualRate or expectedEarnings...");
    
    // Find where plan rate is used
    const patterns = [
      "annualRatePercent",
      "plan.annualRatePercent",
      "expectedEarningsMinor",
      "expectedEarnings",
    ];
    for (const p of patterns) {
      const idx = section.indexOf(p);
      if (idx >= 0) {
        console.log(`\nFound "${p}" at offset ${idx}:`);
        console.log(section.slice(Math.max(0, idx - 120), idx + 200));
        console.log("---");
      }
    }
  }
}
