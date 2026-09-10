const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/InvestorDashboard.tsx', 'utf8');

const proofIdx = content.indexOf("Proof of address");
console.log("Proof of address at:", proofIdx);

// Get exact surrounding text
console.log("\nExact surrounding bytes (100 chars before and 100 after):");
console.log(JSON.stringify(content.slice(proofIdx - 100, proofIdx + 100)));

// Also check for line ending style
const beforeProof = content.slice(0, proofIdx);
const lastNewline = beforeProof.lastIndexOf("\n");
console.log("\nLast newline before proof at:", lastNewline);
console.log("Full line before Proof of address:");
console.log(JSON.stringify(content.slice(lastNewline, proofIdx + 50)));
