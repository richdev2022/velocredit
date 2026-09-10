const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/InvestorDashboard.tsx', 'utf8');

// Find all occurrences of "Proof of address"
let searchStart = 0;
let idx = -1;
let count = 0;
while ((idx = content.indexOf("Proof of address", searchStart)) !== -1) {
  count++;
  console.log(`\n=== Occurrence ${count} at idx ${idx} ===`);
  const before = content.slice(Math.max(0, idx - 200), idx + 100);
  console.log(JSON.stringify(before));
  searchStart = idx + 1;
}
console.log("\nTotal occurrences:", count);
