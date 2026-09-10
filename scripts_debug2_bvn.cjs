const fs = require('fs');
let content = fs.readFileSync('backend/server/routes.ts', 'utf8');

const bvnStart = content.indexOf('router.post("/me/kyc/bvn/verify"');
const livenessStart = content.indexOf('router.post("/me/kyc/liveness/verify"');
const bvnSection = content.slice(bvnStart, livenessStart);

// Get exact text from line 804 for 400 chars
console.log("EXACT TEXT from idx 790-1200:");
console.log(bvnSection.slice(790, 1200));
