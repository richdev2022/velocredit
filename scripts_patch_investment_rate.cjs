const fs = require('fs');
let content = fs.readFileSync('backend/server/routes.ts', 'utf8');

const investStart = content.indexOf('router.post("/investor/investments"');
const nextStart = content.indexOf('router.post("/investor/investments/:id/liquidity"');
const section = content.slice(investStart, nextStart);

// Find the line: const annualRate = plan?.annualRatePercent ?? parsed.data.annualRatePercent;  
const oldAnnualRate = /const annualRate = plan\?\.annualRatePercent \?\? parsed\.data\.annualRatePercent; {2}/;
const match = section.match(oldAnnualRate);
if (match) {
  console.log("Found annualRate declaration, replacing...");
  const newAnnualRate = `const planRate = plan?.annualRatePercent ?? parsed.data.annualRatePercent;
  const annualRate = getEffectiveInvestorRate(req.user!.id, planRate);`;
  
  const idxInSection = section.indexOf(match[0]);
  const len = match[0].length;
  const newSection = section.slice(0, idxInSection) + newAnnualRate + section.slice(idxInSection + len);
  content = content.slice(0, investStart) + newSection + content.slice(nextStart);
  console.log("✅ Applied getEffectiveInvestorRate to investment creation");
  
  fs.writeFileSync('backend/server/routes.ts', content);
  console.log("File saved");
} else {
  console.log("ERROR: Pattern not found. Context around line:");
  const idx = section.indexOf("const annualRate = plan");
  console.log("idx:", idx);
  if (idx >= 0) {
    console.log(JSON.stringify(section.slice(idx - 20, idx + 100)));
  }
}
