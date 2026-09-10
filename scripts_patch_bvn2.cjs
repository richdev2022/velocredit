const fs = require('fs');
let content = fs.readFileSync('backend/server/routes.ts', 'utf8');

const bvnStart = content.indexOf('router.post("/me/kyc/bvn/verify"');
const livenessStart = content.indexOf('router.post("/me/kyc/liveness/verify"');
const bvnSection = content.slice(bvnStart, livenessStart);

// Use indexes to replace parts rather than exact string matching
const idxKycBvnSet = bvnSection.indexOf("kyc.bvn = parsed.data.bvn;");
console.log("idxKycBvnSet:", idxKycBvnSet);

// Find the status updates after that point
const idxEveryChecklist = bvnSection.indexOf("if (Object.values(kyc.checklist).every(Boolean))", idxKycBvnSet);
console.log("idxEveryChecklist:", idxEveryChecklist);

const idxResJson = bvnSection.indexOf("res.json({", idxEveryChecklist);
console.log("idxResJson:", idxResJson);
const idxEndResJsonClose = bvnSection.indexOf("});", idxResJson);
console.log("idxEndResJsonClose:", idxEndResJsonClose);

// Now replace middle part: from after "kyc.bvn = parsed.data.bvn;" to before "if (Object.values..."
const before = bvnSection.slice(0, idxKycBvnSet + "kyc.bvn = parsed.data.bvn;".length);
const middleToReplace = bvnSection.slice(idxKycBvnSet + "kyc.bvn = parsed.data.bvn;".length, idxEveryChecklist);
const after = bvnSection.slice(idxEveryChecklist);

console.log("\nMIDDLE TO REPLACE (first 100 chars):", JSON.stringify(middleToReplace.slice(0, 100)));
console.log("MIDDLE LENGTH:", middleToReplace.length);

// Build the NEW replacement middle
const newMiddle = `
  let otpChallengeForPhone = undefined;
  if (result.status === "SUCCESS") {
    kyc.checklist.bvn = true;
    kyc.bvnVerifiedAt = new Date().toISOString();
    if (user) {
      const details = result.normalizedFields ?? {};
      const idPhoneKeys = ["phone_number", "phoneNumber", "phone", "mobile", "telephoneno"];
      let identityPhone = undefined;
      for (const key of idPhoneKeys) {
        if (typeof details[key] === "string" && String(details[key]).trim()) {
          identityPhone = String(details[key]).trim();
          break;
        }
      }
      if (identityPhone) {
        const digitsOnly = identityPhone.replace(/[^0-9]/g, "");
        let normalized = digitsOnly;
        if (digitsOnly.startsWith("234") && digitsOnly.length === 13) normalized = "0" + digitsOnly.slice(3);
        if (normalized && /^0\\d{10}$/.test(normalized) && normalized !== user.phone) {
          try {
            const channel = user.preferredOtpChannel && user.preferredOtpChannel !== "EMAIL" ? user.preferredOtpChannel : "SMS";
            const challenge = await createOtpChallenge(
              user.id,
              "KYC_VERIFICATION",
              normalized,
              user.email,
              channel
            );
            otpChallengeForPhone = {
              challengeId: challenge.id,
              expiresAt: challenge.expiresAt,
              channel,
              phoneLastFour: normalized.slice(-4),
              resendAvailableAt: challenge.resendAvailableAt,
              resendSecondsRemaining: challenge.resendSecondsRemaining,
              requiresPhoneVerification: true,
            };
          } catch (otpError) {
            // ignore OTP rate limit errors for now, user can request later
          }
        }
      }
    }
  }
  if (user) {
    if (result.status === "SUCCESS" && !user.fullName.includes(parsed.data.firstName ?? "") && parsed.data.firstName) {
      // Name matched: nothing to override yet — manual review can confirm      
    }
  }
`;

// Now also need to update the res.json to add otpChallenge field
// Find the response section within `after` (which starts with Object.values check)
const resJsonIdxInside = after.indexOf("res.json({");
const resJsonEndIdxInside = after.indexOf("});", resJsonIdxInside);
const resJsonOld = after.slice(resJsonIdxInside, resJsonEndIdxInside + "});".length);
console.log("\nOLD RESPONSE (first 200 chars):", JSON.stringify(resJsonOld.slice(0, 200)));

const resJsonNew = `res.json({
    ok: true,
    verificationStatus: result.status,
    checklist: kyc.checklist,
    providerConfigured: !result.errorMessage?.includes("not configured"),
    error: result.errorMessage,
    verifiedDetails: result.status === "SUCCESS" ? result.normalizedFields : undefined,
    otpChallenge: otpChallengeForPhone,
  });`;

const beforeRes = after.slice(0, resJsonIdxInside);
const afterRes = after.slice(resJsonEndIdxInside + "});".length);

const newAfter = beforeRes + resJsonNew + afterRes;

// Stitch BVN endpoint back together
const newBvnSection = before + newMiddle + newAfter;

// Now update content
content = content.slice(0, bvnStart) + newBvnSection + content.slice(livenessStart);

fs.writeFileSync('backend/server/routes.ts', content);
console.log("SUCCESS: BVN endpoint patched");
