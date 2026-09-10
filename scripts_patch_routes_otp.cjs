const fs = require('fs');
let content = fs.readFileSync('backend/server/routes.ts', 'utf8');

// 1. Modify BVN endpoint - when SUCCESS, extract phone from normalizedFields
//    and send OTP via user's preferred channel to THAT phone number
const oldBvnSuccess = `  identityVerificationEvents.push(event);
  kyc.bvn = parsed.data.bvn;
  if (result.status === "SUCCESS") {
    kyc.checklist.bvn = true;
    kyc.bvnVerifiedAt = new Date().toISOString();
  }
  if (user) {
    if (result.status === "SUCCESS" && !user.fullName.includes(parsed.data.firstName ?? "") && parsed.data.firstName) {
      // Name matched: nothing to override yet — manual review can confirm      
    }
  }
  if (Object.values(kyc.checklist).every(Boolean)) {
    kyc.status = "PENDING_VERIFICATION";
    kyc.submittedAt = kyc.submittedAt ?? new Date().toISOString();
  } else if (kyc.status === "NOT_STARTED") {
    kyc.status = "IN_PROGRESS";
  }
  kyc.updatedAt = new Date().toISOString();
  if (user) user.kycStatus = kyc.status;
  markKycChecklistComplete(req.user!.id);
  res.json({
    ok: true,
    verificationStatus: result.status,
    checklist: kyc.checklist,
    providerConfigured: !result.errorMessage?.includes("not configured"),
    error: result.errorMessage,
    verifiedDetails: result.status === "SUCCESS" ? result.normalizedFields : undefined,
  });
});

router.post("/me/kyc/liveness/verify"`;

const newBvnSuccess = `  identityVerificationEvents.push(event);
  kyc.bvn = parsed.data.bvn;
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
  if (Object.values(kyc.checklist).every(Boolean)) {
    kyc.status = "PENDING_VERIFICATION";
    kyc.submittedAt = kyc.submittedAt ?? new Date().toISOString();
  } else if (kyc.status === "NOT_STARTED") {
    kyc.status = "IN_PROGRESS";
  }
  kyc.updatedAt = new Date().toISOString();
  if (user) user.kycStatus = kyc.status;
  markKycChecklistComplete(req.user!.id);
  res.json({
    ok: true,
    verificationStatus: result.status,
    checklist: kyc.checklist,
    providerConfigured: !result.errorMessage?.includes("not configured"),
    error: result.errorMessage,
    verifiedDetails: result.status === "SUCCESS" ? result.normalizedFields : undefined,
    otpChallenge: otpChallengeForPhone,
  });
});

router.post("/me/kyc/liveness/verify"`;

if (content.includes(oldBvnSuccess)) {
  content = content.replace(oldBvnSuccess, newBvnSuccess);
  console.log("SUCCESS: BVN endpoint updated");
} else {
  console.log("WARNING: Could not find exact BVN block to replace");
}

// 2. Do the same for NIN endpoint
const oldNinSection = `  identityVerificationEvents.push(event);
  kyc.nin = parsed.data.nin;
  if (result.status === "SUCCESS") {
    kyc.checklist.nin = true;
    kyc.ninVerifiedAt = new Date().toISOString();
  }
  if (Object.values(kyc.checklist).every(Boolean)) {
    kyc.status = "PENDING_VERIFICATION";
    kyc.submittedAt = kyc.submittedAt ?? new Date().toISOString();
  } else if (kyc.status === "NOT_STARTED") {
    kyc.status = "IN_PROGRESS";
  }
  kyc.updatedAt = new Date().toISOString();
  if (user) user.kycStatus = kyc.status;
  markKycChecklistComplete(req.user!.id);
  res.json({
    ok: true,
    verificationStatus: result.status,
    checklist: kyc.checklist,
    providerConfigured: !result.errorMessage?.includes("not configured"),
    error: result.errorMessage,
  });
});

router.post("/me/kyc/documents"`;

const newNinSection = `  identityVerificationEvents.push(event);
  kyc.nin = parsed.data.nin;
  let ninOtpChallenge = undefined;
  if (result.status === "SUCCESS") {
    kyc.checklist.nin = true;
    kyc.ninVerifiedAt = new Date().toISOString();
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
            ninOtpChallenge = {
              challengeId: challenge.id,
              expiresAt: challenge.expiresAt,
              channel,
              phoneLastFour: normalized.slice(-4),
              resendAvailableAt: challenge.resendAvailableAt,
              resendSecondsRemaining: challenge.resendSecondsRemaining,
              requiresPhoneVerification: true,
            };
          } catch (otpError) {
            // ignore
          }
        }
      }
    }
  }
  if (Object.values(kyc.checklist).every(Boolean)) {
    kyc.status = "PENDING_VERIFICATION";
    kyc.submittedAt = kyc.submittedAt ?? new Date().toISOString();
  } else if (kyc.status === "NOT_STARTED") {
    kyc.status = "IN_PROGRESS";
  }
  kyc.updatedAt = new Date().toISOString();
  if (user) user.kycStatus = kyc.status;
  markKycChecklistComplete(req.user!.id);
  res.json({
    ok: true,
    verificationStatus: result.status,
    checklist: kyc.checklist,
    providerConfigured: !result.errorMessage?.includes("not configured"),
    error: result.errorMessage,
    verifiedDetails: result.status === "SUCCESS" ? result.normalizedFields : undefined,
    otpChallenge: ninOtpChallenge,
  });
});

router.post("/me/kyc/documents"`;

if (content.includes(oldNinSection)) {
  content = content.replace(oldNinSection, newNinSection);
  console.log("SUCCESS: NIN endpoint updated");
} else {
  console.log("WARNING: Could not find exact NIN block to replace");
}

fs.writeFileSync('backend/server/routes.ts', content);
console.log("\nRoutes file saved");
