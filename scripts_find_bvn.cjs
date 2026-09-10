const fs = require('fs');
let content = fs.readFileSync('backend/server/routes.ts', 'utf8');

// Find BVN endpoint more carefully
const bvnStart = content.indexOf('router.post("/me/kyc/bvn/verify"');
const livenessStart = content.indexOf('router.post("/me/kyc/liveness/verify"');
console.log("BVN starts at:", bvnStart);
console.log("Liveness starts at:", livenessStart);

const bvnSection = content.slice(bvnStart, livenessStart);
console.log("BVN section length:", bvnSection.length);
console.log("\nLast 600 chars of BVN section:");
console.log(bvnSection.slice(-600));
