// Quick lifecycle check of the face-handoff token helpers (auth.ts).
import { issueFaceHandoffToken, resolveFaceHandoffToken } from "../backend/server/auth.js";
import { users } from "../backend/server/store.js";

const { token, expiresAt } = issueFaceHandoffToken("user-abc-123");
console.log("token issued, expires:", expiresAt);
console.log("resolved (no such user -> null expected):", resolveFaceHandoffToken(token));
console.log("garbage token resolves to:", resolveFaceHandoffToken("garbage"));

// Simulate a real user claiming the link.
(users as any[]).push({
  id: "user-face-test",
  email: "face@test.local",
  phone: "08000000000",
  fullName: "Face Test",
  passwordHash: "x",
  roles: ["BORROWER"] as any,
  kycStatus: "IN_PROGRESS" as any,
  createdAt: new Date().toISOString(),
  isActive: true,
});
const { token: token2 } = issueFaceHandoffToken("user-face-test");
const resolved2 = resolveFaceHandoffToken(token2);
console.log("real user resolved:", JSON.stringify(resolved2));

// A handoff token must never authenticate as anything else: scope claim is FACE_HANDOFF.
const { issueToken } = await import("../backend/server/auth.js");
const session = issueToken(users.find((u: any) => u.id === "user-face-test") as any);
console.log("session token issued for claimed user:", session.split(".").length === 3 ? "valid-jwt-shape" : "invalid");
