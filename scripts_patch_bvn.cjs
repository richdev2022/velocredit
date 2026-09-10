const fs = require('fs');
let content = fs.readFileSync('backend/server/routes.ts', 'utf8');

const bvnStart = content.indexOf('router.post("/me/kyc/bvn/verify"');
const livenessStart = content.indexOf('router.post("/me/kyc/liveness/verify"');

const oldBvnSection = content.slice(bvnStart, livenessStart);

// Build the new BVN endpoint content
const oldChecklistSection = `  if (result.status === "SUCCESS") {
    kyc.checklist.bvn = true;
    kyc.bvnVerifiedAt = new Date().toISOString();
  }
  if (user) {
    if (result.status === "SUCCESS" && !user.fullName.includes(parsed.data.firstName ?? "") && parsed.data.firstName) {
      // Name matched: nothing to override yet — manual review can confirm      
    }
  }`;

const newChecklistSection = `  let otpChallengeForPhone = undefined;
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
  }`;

let newBvnSection = oldBvnSection;
if (newBvnSection.includes(oldChecklistSection)) {
  newBvnSection = newBvnSection.replace(oldChecklistSection, newChecklistSection);
  console.log("1. Replaced BVN checklist section");
} else {
  console.log("WARNING: Could not find BVN checklist section to replace");
}

// Update the response to include otpChallenge
const oldResponse = `  res.json({
    ok: true,
    verificationStatus: result.status,
    checklist: kyc.checklist,
    providerConfigured: !result.errorMessage?.includes("not configured"),       
    error: result.errorMessage,
    verifiedDetails: result.status === "SUCCESS" ? result.normalizedFields : undefined,
  });`;

const newResponse = `  res.json({
    ok: true,
    verificationStatus: result.status,
    checklist: kyc.checklist,
    providerConfigured: !result.errorMessage?.includes("not configured"),
    error: result.errorMessage,
    verifiedDetails: result.status === "SUCCESS" ? result.normalizedFields : undefined,
    otpChallenge: otpChallengeForPhone,
  });`;

if (newBvnSection.includes(oldResponse)) {
  newBvnSection = newBvnSection.replace(oldResponse, newResponse);
  console.log("2. Replaced BVN response section");
} else {
  console.log("WARNING: Could not find BVN response section to replace");
}

// Now stitch back together
content = content.slice(0, bvnStart) + newBvnSection + content.slice(livenessStart);

fs.writeFileSync('backend/server/routes.ts', content);
console.log("File saved");
