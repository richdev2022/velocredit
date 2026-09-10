const fs = require('fs');
let content = fs.readFileSync('backend/server/routes.ts', 'utf8');

const bvnStart = content.indexOf('router.post("/me/kyc/bvn/verify"');
const livenessStart = content.indexOf('router.post("/me/kyc/liveness/verify"');

const bvnSection = content.slice(bvnStart, livenessStart);

// Find specific sections
const idx1 = bvnSection.indexOf("if (result.status === \"SUCCESS\") {");
console.log("idx of 'if result.status SUCCESS':", idx1);
console.log("Around it (200 chars):");
console.log(JSON.stringify(bvnSection.slice(idx1 - 20, idx1 + 300)));

const idx2 = bvnSection.indexOf("verifiedDetails");
console.log("\nidx of 'verifiedDetails':", idx2);
console.log("Around it (300 chars):");
console.log(JSON.stringify(bvnSection.slice(idx2 - 100, idx2 + 200)));
