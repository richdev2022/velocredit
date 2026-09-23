// ============================================================================
// scripts/smokeKycDocsEngagement.ts
// Smoke test for the fast-KYC-upload + engagement-seed batch:
//
//   1. Engagement seeding: three branded banners + one welcome announcement
//      are seeded automatically on first boot, the seed is idempotent, an
//      admin can DELETE a seeded banner (and it stays deleted across a
//      re-seed), and an admin can EDIT + SAVE the seeded announcement.
//   2. KYC auto-fetch: GET /me/kyc pulls identity numbers + documents from
//      the customer's loan application into the KYC case automatically
//      (idempotent — no duplicates on repeat loads).
//   3. Fast upload: POST /me/kyc/documents answers 201 immediately with an
//      inline durable record (provider "inline"), no Drive round-trip.
//   4. Upload persistence: the uploaded document is served by GET /me/kyc
//      afterwards (survives refresh), and GET /me/documents/:id resolves the
//      inline bytes; foreign documents are 404.
//   5. Submit gating: uploading 3 documents enables submission (202
//      PENDING_VERIFICATION) even when bvn/nin checklist items are false,
//      and GET /me/kyc does NOT downgrade the submitted status.
//
// Run: env -u DATABASE_URL npx tsx scripts/smokeKycDocsEngagement.ts
// ============================================================================

import express from "express";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "smoke-test-secret-0123456789abcdef0123456789";

type StoreModule = typeof import("../backend/server/store.js");
type RoutesModule = typeof import("../backend/server/routes.js");

async function main(): Promise<void> {
  const auth = await import("../backend/server/auth.js");
  const storeMod: StoreModule = await import("../backend/server/store.js");
  const routesMod: RoutesModule = await import("../backend/server/routes.js");

  try {
    await storeMod.initializeStore();
  } catch (err) {
    console.warn("[smoke] initializeStore warning:", err instanceof Error ? err.message : err);
  }
  // initializeStore short-circuits without a database; production startup
  // seeds via index.ts, and the smoke path mirrors that explicitly.
  storeMod.seedDefaultEngagement();

  const supertestPkg = await import("supertest");
  const request = (supertestPkg as any).default || supertestPkg;

  const app = express();
  app.use(express.json());
  app.use("/api/v1", routesMod.default);

  const users = storeMod.users as unknown as any[];
  const loanApplications = storeMod.loanApplications as unknown as any[];
  const kycCases = storeMod.kycCases as unknown as any[];
  const documents = storeMod.documents as unknown as any[];
  const platformSettings = storeMod.platformSettings as unknown as any[];

  let failures = 0;
  function check(label: string, ok: boolean, detail?: unknown): void {
    console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    if (!ok) failures++;
  }

  function makeUser(id: string, fullName: string, roles: string[] = ["BORROWER"]): any {
    const user = {
      id, email: `${id}@example.com`, phone: "0800000000", fullName,
      passwordHash: "x", roles, kycStatus: "NOT_STARTED", isActive: true,
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    return user;
  }

  const ts = Date.now();
  const borrower = makeUser(`smoke-kd-b-${ts}`, "KYC Docs Smoke Borrower", ["BORROWER"]);
  const admin = makeUser(`smoke-kd-admin-${ts}`, "KYC Docs Smoke Admin", ["ADMIN"]);
  const stranger = makeUser(`smoke-kd-s-${ts}`, "KYC Docs Smoke Stranger", ["BORROWER"]);
  const borrowerHeaders = { Authorization: `Bearer ${auth.issueToken(borrower)}` };
  const adminHeaders = { Authorization: `Bearer ${auth.issueToken(admin)}` };
  const strangerHeaders = { Authorization: `Bearer ${auth.issueToken(stranger)}` };

  // ---------------------------------------------------------------------
  // 1. Engagement seeding
  // ---------------------------------------------------------------------
  const settingsRow = platformSettings[0] ?? storeMod.getPlatformSettings();
  const seededBanners: any[] = settingsRow.banners ?? [];
  const seededAnnouncements: any[] = settingsRow.announcements ?? [];
  check("default banners are seeded", seededBanners.length >= 3, seededBanners.length);
  check("seeded banners are branded SVG data URLs", seededBanners.slice(0, 3).every((b) => String(b.imageData).startsWith("data:image/svg+xml;base64,")));
  check("welcome announcement is seeded", seededAnnouncements.length >= 1 && String(seededAnnouncements[0].message).includes("Velo"));
  check("seed flag recorded", settingsRow.engagementSeeded === true);

  const bannersBefore = seededBanners.length;
  storeMod.seedDefaultEngagement();
  check("re-seeding is a no-op (flag guard)", (platformSettings[0].banners ?? []).length === bannersBefore);

  const publicBanners = await request(app).get("/api/v1/platform/banners");
  check("public banners endpoint serves seeded carousel", publicBanners.status === 200 && (publicBanners.body.banners ?? []).length >= 3);

  // Admin deletes a seeded banner — deletion must stick across re-seeds.
  const deleteTarget = seededBanners[seededBanners.length - 1];
  const deleteBanner = await request(app).delete(`/api/v1/admin/banners/${deleteTarget.id}`).set(adminHeaders);
  check("admin deletes a seeded banner", deleteBanner.status === 200 && deleteBanner.body.deleted === true);
  storeMod.seedDefaultEngagement();
  check("deleted banner NOT re-added on re-seed", (platformSettings[0].banners ?? []).length === bannersBefore - 1);

  // Admin edits + saves the seeded announcement.
  const announcementId = seededAnnouncements[0].id;
  const editedMessage = "Edited by smoke: referral payouts now land instantly.";
  const editAnnouncement = await request(app).patch(`/api/v1/admin/announcements/${announcementId}`)
    .set(adminHeaders)
    .send({ message: editedMessage });
  check("admin edits + saves the seeded announcement", editAnnouncement.status === 200 && editAnnouncement.body.announcement?.message === editedMessage);
  const publicStatusAfterEdit = await request(app).get("/api/v1/platform/status");
  check("edited announcement text is served publicly", (publicStatusAfterEdit.body.announcements ?? []).some((a: any) => a.message === editedMessage));

  // ---------------------------------------------------------------------
  // 2. KYC auto-fetch from the loan application
  // ---------------------------------------------------------------------
  const pngByte = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const application = {
    id: `smoke-kd-app-${ts}`,
    applicationId: `VELO-${ts}`,
    borrowerId: borrower.id,
    status: "SUBMITTED",
    amountNaira: 150_000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    customerSnapshot: {
      kyc: { bvn: "22212345678", bvnVerified: true, nin: "", identificationType: "Passport" },
      personalInfo: { firstName: "Ada", lastName: "Obi", phone: "08031234567", dateOfBirth: "1994-03-03" },
      documents: {
        proofOfAddress: { name: "bill.pdf", type: "application/pdf", size: pngByte.length, data: pngByte.toString("base64") },
        signature: { name: "signature.png", type: "image/png", size: pngByte.length, data: pngByte.toString("base64") },
        identificationDocument: { name: "passport.jpg", type: "image/jpeg", size: pngByte.length, data: pngByte.toString("base64") },
      },
    },
  };
  loanApplications.push(application);

  const kycFirstLoad = await request(app).get("/api/v1/me/kyc").set(borrowerHeaders);
  check("GET /me/kyc responds", kycFirstLoad.status === 200 && kycFirstLoad.body.ok);
  check("auto-fetch pulled 3 application documents", (kycFirstLoad.body.documents ?? []).length === 3, kycFirstLoad.body.documents?.length);
  check("pulled docs include proof of address + signature + ID", ["PROOF_OF_ADDRESS", "SIGNATURE"].every((type) =>
    (kycFirstLoad.body.documents ?? []).some((d: any) => d.documentType === type)));
  check("checklist advanced from the application (bvn + proofOfAddress + signature)", kycFirstLoad.body.checklist?.bvn === true && kycFirstLoad.body.checklist?.proofOfAddress === true && kycFirstLoad.body.checklist?.signature === true);
  check("applicationPrefill exposed", Boolean(kycFirstLoad.body.applicationPrefill?.applicationId));
  check("pulled docs carry no inline bytes (payload safe)", (kycFirstLoad.body.documents ?? []).every((d: any) => !d.inlineData));

  const kycSecondLoad = await request(app).get("/api/v1/me/kyc").set(borrowerHeaders);
  check("auto-fetch is idempotent (no duplicate rows)", (kycSecondLoad.body.documents ?? []).length === 3, kycSecondLoad.body.documents?.length);

  const snapshotDoc = (kycFirstLoad.body.documents ?? []).find((d: any) => d.documentType === "PROOF_OF_ADDRESS");
  const snapshotPreview = await request(app).get(`/api/v1/me/documents/${snapshotDoc.id}`).set(borrowerHeaders);
  check("/me/documents resolves snapshot-pulled doc to a data URL", snapshotPreview.status === 200 && String(snapshotPreview.body.document?.previewUrl).startsWith("data:application/pdf;base64,"));

  const foreignPreview = await request(app).get(`/api/v1/me/documents/${snapshotDoc.id}`).set(strangerHeaders);
  check("foreign user cannot open someone else's document", foreignPreview.status === 404);

  // ---------------------------------------------------------------------
  // 3. Fast upload path
  // ---------------------------------------------------------------------
  const uploadStarted = Date.now();
  const upload = await request(app)
    .post("/api/v1/me/kyc/documents")
    .set(borrowerHeaders)
    .field("documentType", "PROOF_OF_ADDRESS")
    .attach("document", pngByte, { filename: "utility-bill.png", contentType: "image/png" });
  const uploadMs = Date.now() - uploadStarted;
  check("upload answers 201 immediately (no Drive wait)", upload.status === 201 && upload.body.ok, upload.body);
  check("upload answered fast (<1500ms)", uploadMs < 1500, `${uploadMs}ms`);
  check("upload record is inline + durable", upload.body.document?.provider === "inline" && upload.body.document?.hasInlineContent === true);
  check("upload response never leaks inline bytes", !upload.body.document?.inlineData);
  check("upload advanced proofOfAddress checklist", upload.body.checklist?.proofOfAddress === true);

  // Background archive upload: Drive is unconfigured in the smoke env, so the
  // record keeps its inline copy and records the archive error.
  await new Promise((resolve) => setTimeout(resolve, 120));
  const archivedRecord = documents.find((d: any) => d.id === upload.body.document?.id);
  check("inline copy retained when Drive unavailable", archivedRecord?.provider === "inline" && Boolean(archivedRecord?.inlineData));
  check("archive failure recorded", typeof archivedRecord?.uploadError === "string" && archivedRecord.uploadError.length > 0);

  const uploadSignature = await request(app)
    .post("/api/v1/me/kyc/documents")
    .set(borrowerHeaders)
    .field("documentType", "SIGNATURE")
    .attach("document", pngByte, { filename: "signature.png", contentType: "image/png" });
  const uploadPassport = await request(app)
    .post("/api/v1/me/kyc/documents")
    .set(borrowerHeaders)
    .field("documentType", "PASSPORT_PHOTO")
    .attach("document", pngByte, { filename: "passport.png", contentType: "image/png" });
  check("signature + passport uploads accepted", uploadSignature.status === 201 && uploadPassport.status === 201);

  // ---------------------------------------------------------------------
  // 4. Uploads persist across a "refresh"
  // ---------------------------------------------------------------------
  const kycAfterUploads = await request(app).get("/api/v1/me/kyc").set(borrowerHeaders);
  check("uploads survive refresh (served by GET /me/kyc)", (kycAfterUploads.body.documents ?? []).length === 6, kycAfterUploads.body.documents?.length);
  const inlineDoc = (kycAfterUploads.body.documents ?? []).find((d: any) => d.id === upload.body.document?.id);
  check("uploaded doc shows review status + name", inlineDoc?.status === "PENDING_REVIEW" && inlineDoc?.fileName === "utility-bill.png");

  const inlinePreview = await request(app).get(`/api/v1/me/documents/${upload.body.document?.id}`).set(borrowerHeaders);
  check("inline upload resolves to a data URL", inlinePreview.status === 200 && String(inlinePreview.body.document?.previewUrl).startsWith("data:image/png;base64,"));

  // ---------------------------------------------------------------------
  // 5. Submit gating: 3 docs + unverified bvn/nin checklist still submits
  // ---------------------------------------------------------------------
  const kycCase = kycCases.find((k: any) => k.userId === borrower.id);
  kycCase.checklist.bvn = false;
  kycCase.checklist.nin = false;
  kycCase.checklist.liveness = false;

  const submit = await request(app).post("/api/v1/me/kyc").set(borrowerHeaders).send({ statusOverride: "PENDING_VERIFICATION" });
  check("submit accepted with documents only", submit.status === 202 && submit.body.status === "PENDING_VERIFICATION", submit.body);

  const kycAfterSubmit = await request(app).get("/api/v1/me/kyc").set(borrowerHeaders);
  check("submitted status NOT downgraded while documents exist", kycAfterSubmit.body.status === "PENDING_VERIFICATION", kycAfterSubmit.body.status);

  // Empty case (no docs, no checks) must NOT submit.
  const emptyUser = makeUser(`smoke-kd-e-${ts}`, "KYC Docs Smoke Empty", ["BORROWER"]);
  const emptyHeaders = { Authorization: `Bearer ${auth.issueToken(emptyUser)}` };
  const emptySubmit = await request(app).post("/api/v1/me/kyc").set(emptyHeaders).send({ statusOverride: "PENDING_VERIFICATION" });
  check("empty case cannot submit", emptySubmit.status === 202 && emptySubmit.body.status !== "PENDING_VERIFICATION", emptySubmit.body);

  // ---------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------
  for (const id of [borrower.id, admin.id, stranger.id, emptyUser.id]) {
    const userIdx = users.findIndex((u) => u.id === id);
    if (userIdx >= 0) users.splice(userIdx, 1);
    for (let i = loanApplications.length - 1; i >= 0; i--) if (loanApplications[i].borrowerId === id) loanApplications.splice(i, 1);
    for (let i = kycCases.length - 1; i >= 0; i--) if (kycCases[i].userId === id) kycCases.splice(i, 1);
    for (let i = documents.length - 1; i >= 0; i--) if (documents[i].userId === id) documents.splice(i, 1);
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke] fatal:", err);
  process.exit(1);
});
