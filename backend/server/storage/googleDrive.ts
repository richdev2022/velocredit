import { Readable } from "node:stream";
import { Readable } from "node:stream";
import { google } from "googleapis";
import { env } from "../config.js";

function configured(): boolean {
  if (env.GOOGLE_APPS_SCRIPT_UPLOAD_URL && env.GOOGLE_DRIVE_PARENT_FOLDER_ID) return true;
  return Boolean(env.GOOGLE_DRIVE_PARENT_FOLDER_ID && env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
}

export function isGoogleDriveConfigured(): boolean { return configured(); }

async function uploadViaAppsScript(input: { filename: string; mimeType: string; buffer: Buffer; userId: string; documentType: string }): Promise<{ provider: "google_drive"; fileId: string; filename: string }> {
  if (!env.GOOGLE_APPS_SCRIPT_UPLOAD_URL) throw new Error("Google Apps Script upload URL is not configured");
  const basePath = `${input.userId}/${input.documentType}`;
  const body = JSON.stringify({
    action: "uploadDocument",
    payload: {
      folderId: env.GOOGLE_DRIVE_PARENT_FOLDER_ID,
      path: basePath,
      filename: input.filename,
      mimeType: input.mimeType,
      userId: input.userId,
      documentType: input.documentType,
      data: input.buffer.toString("base64"),
    },
  });
  const response = await fetch(env.GOOGLE_APPS_SCRIPT_UPLOAD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text().catch(() => "");
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch (_parseErr) { parsed = { rawText: text }; }
  if (!response.ok) throw new Error(`Apps Script upload failed (${response.status}): ${String(parsed.error ?? parsed.message ?? text).slice(0, 200)}`);
  const fileId = String(parsed.fileId ?? parsed.id ?? parsed.file_id ?? "");
  if (!fileId) throw new Error("Apps Script did not return a file ID. Response: " + text.slice(0, 200));
  const returnedName = String(parsed.filename ?? parsed.name ?? input.filename);
  return { provider: "google_drive", fileId, filename: returnedName };
}

async function uploadViaServiceAccount(input: { filename: string; mimeType: string; buffer: Buffer; userId: string; documentType: string }): Promise<{ provider: "google_drive"; fileId: string; filename: string }> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) throw new Error("Google Drive service account credentials are not configured");
  const auth = new google.auth.JWT({ email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, key: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n"), scopes: ["https://www.googleapis.com/auth/drive.file"] });
  const drive = google.drive({ version: "v3", auth });
  const response = await drive.files.create({ requestBody: { name: `${input.userId}/${input.documentType}/${input.filename}`, parents: [env.GOOGLE_DRIVE_PARENT_FOLDER_ID!] }, media: { mimeType: input.mimeType, body: Readable.from(input.buffer) }, fields: "id,name" });
  if (!response.data.id) throw new Error("Google Drive did not return a file ID");
  return { provider: "google_drive", fileId: response.data.id, filename: response.data.name ?? input.filename };
}

export async function uploadPrivateDocument(input: { filename: string; mimeType: string; buffer: Buffer; userId: string; documentType: string }): Promise<{ provider: "google_drive"; fileId: string; filename: string }> {
  if (!configured()) throw new Error("Google Drive storage is not configured. Set GOOGLE_DRIVE_PARENT_FOLDER_ID plus either GOOGLE_APPS_SCRIPT_UPLOAD_URL (recommended) or service-account credentials.");
  if (env.GOOGLE_APPS_SCRIPT_UPLOAD_URL) {
    return uploadViaAppsScript(input);
  }
  return uploadViaServiceAccount(input);
}
