const fs = require('fs');
let content = fs.readFileSync('backend/server/routes.ts', 'utf8');

const investStart = content.indexOf('router.post("/investor/investments"');
const nextStart = content.indexOf('router.post("/investor/investments/:id/liquidity"');
const section = content.slice(investStart, nextStart);

const oldStr = `const annualRate = plan?.annualRatePercent ?? parsed.data.annualRatePercent;`;
const idx = section.indexOf(oldStr);
if (idx >= 0) {
  const newStr = `const planRate = plan?.annualRatePercent ?? parsed.data.annualRatePercent;
  const annualRate = getEffectiveInvestorRate(req.user!.id, planRate);`;
  const newSection = section.slice(0, idx) + newStr + section.slice(idx + oldStr.length);
  content = content.slice(0, investStart) + newSection + content.slice(nextStart);
  console.log("✅ Applied getEffectiveInvestorRate to investment creation");
  fs.writeFileSync('backend/server/routes.ts', content);
} else {
  console.log("❌ String not found");
}
