const fs = require('fs');
let content = fs.readFileSync('backend/server/routes.ts', 'utf8');

const investStart = content.indexOf('router.post("/investor/investments"');
const nextStart = content.indexOf('router.post("/investor/investments/:id/liquidity"');
console.log("investStart:", investStart);
console.log("nextStart (liquidity):", nextStart);

if (investStart > 0 && nextStart > 0) {
  const section = content.slice(investStart, nextStart);
  console.log("\n=== Investment section (first 2500 chars) ===");
  console.log(section.slice(0, 2500));
}
