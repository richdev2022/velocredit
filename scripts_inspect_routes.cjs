const fs = require('fs');
let content = fs.readFileSync('backend/server/routes.ts', 'utf8');

// First check the imports - need to add createOtpChallenge to imports
console.log("Checking imports for createOtpChallenge...");
const importCheck = content.includes("createOtpChallenge");
console.log("createOtpChallenge in imports:", importCheck);

// Now look at the BVN verify endpoint
const bvnEndpointIdx = content.indexOf('router.post("/me/kyc/bvn/verify"');
console.log("BVN endpoint index:", bvnEndpointIdx);

if (bvnEndpointIdx > 0) {
  // Extract the endpoint
  const sectionStart = bvnEndpointIdx;
  // Find the next router.post or router.get after this endpoint
  const sectionEndSearch = content.indexOf('router.post("/me/kyc/liveness/verify"', bvnEndpointIdx);
  console.log("Next endpoint (liveness) index:", sectionEndSearch);
  
  if (sectionEndSearch > 0) {
    const section = content.slice(sectionStart, sectionEndSearch);
    console.log("\n=== CURRENT BVN ENDPOINT (first 1500 chars) ===");
    console.log(section.slice(0, 1500));
  }
}

const ninEndpointIdx = content.indexOf('router.post("/me/kyc/nin/verify"');
console.log("\nNIN endpoint index:", ninEndpointIdx);
if (ninEndpointIdx > 0) {
  const sectionEndSearch = content.indexOf('router.post("/me/kyc/documents"', ninEndpointIdx);
  console.log("Next endpoint (documents) index:", sectionEndSearch);
  if (sectionEndSearch > 0) {
    const section = content.slice(ninEndpointIdx, sectionEndSearch);
    console.log("\n=== CURRENT NIN ENDPOINT (first 1500 chars) ===");
    console.log(section.slice(0, 1500));
  }
}
