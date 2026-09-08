// ============================================================================
// src/utils/applicationId.ts
// Application ID generation. Two prefixes:
//   VEL-DRAFT-2026-000124  — draft stage (before submission)
//   VEL-LN-2026-000124     — final submitted application ID
// ============================================================================

function currentYear(): number {
  return new Date().getFullYear();
}

/**
 * Generate a 6-digit sequence, padded with zeros. The starting point uses
 * a per-day pseudo-sequence so concurrent drafts don't collide. Real
 * uniqueness is enforced by the Node API and database.
 */
function sixDigits(): string {
  const now = new Date();
  // Combine day-of-year + hours + minutes + a small random component
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now.getTime() - start.getTime()) / 86400000);
  const seq = (dayOfYear * 1000) + (now.getHours() * 60) + now.getMinutes() + Math.floor(Math.random() * 99);
  return String(seq).padStart(6, "0").slice(-6);
}

export function generateDraftId(): string {
  return `VEL-DRAFT-${currentYear()}-${sixDigits()}`;
}

export function generateFinalId(): string {
  return `VEL-LN-${currentYear()}-${sixDigits()}`;
}

/**
 * Convert an existing VEL-DRAFT-... ID into a final VEL-LN-... ID. Used at
 * submission time. Apps Script will confirm/replace this server-side.
 */
export function promoteDraftId(draftId: string): string {
  if (!draftId) return generateFinalId();
  const parts = draftId.split("-");
  // VEL-DRAFT-2026-000124 -> VEL-LN-2026-000124
  if (parts.length >= 4 && parts[0] === "VEL") {
    return `VEL-LN-${parts[2]}-${parts[3]}`;
  }
  return generateFinalId();
}

/** Filename like "VEL-LN-2026-000124-Loan-Agreement.pdf" */
export function buildAgreementFilename(applicationId: string): string {
  const safe = (applicationId || "VEL-LN-UNKNOWN").replace(/[^A-Za-z0-9-]/g, "");
  return `${safe}-Loan-Agreement.pdf`;
}
