// ============================================================================
// src/types/documents.ts
// Uploaded-document types and helpers.
// ============================================================================

export type DocumentSlot =
  | "identificationDocument"
  | "proofOfAddress"
  | "signature"
  | "collateralMedia"
  | "signedAgreement";

export type DocumentKind = "id" | "address" | "signature" | "collateral" | "agreement";

export interface UploadedDocument {
  /** Slot key, e.g. "identificationDocument" */
  slot: DocumentSlot;
  /** Original file name */
  name: string;
  /** MIME type, e.g. "application/pdf" */
  type: string;
  /** File size in bytes */
  size: number;
  /** base64-encoded data, without the data: URI prefix */
  data: string;
  /** Upload status */
  status: "queued" | "uploading" | "uploaded" | "error";
  /** Drive file URL returned by the backend, once uploaded */
  driveUrl?: string;
  /** Error message, if any */
  error?: string;
  /** When the document was added */
  addedAt: string;
}

export type DocumentMap = Partial<Record<DocumentSlot, UploadedDocument>>;

export const ALLOWED_DOC_EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "mp4", "mov", "webm"] as const;
export const ALLOWED_DOC_MIME = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "video/mp4",
  "video/quicktime",
  "video/webm",
] as const;

export const MAX_DOC_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface FileValidationResult {
  valid: boolean;
  error?: string;
}
