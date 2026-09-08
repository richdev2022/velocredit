import { Readable } from "node:stream";
import { google } from "googleapis";
import { env } from "../config.js";

function configured(): boolean {
  return Boolean(env.GOOGLE_DRIVE_PARENT_FOLDER_ID && env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
}

export function isGoogleDriveConfigured(): boolean { return configured(); }

export async function uploadPrivateDocument(input: { filename: string; mimeType: string; buffer: Buffer; userId: string; documentType: string }): Promise<{ provider: "google_drive"; fileId: string; filename: string }> {
  if (!configured()) throw new Error("Google Drive storage is not configured");
  const auth = new google.auth.JWT({ email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, key: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!.replace(/\\n/g, "\n"), scopes: ["https://www.googleapis.com/auth/drive.file"] });
  const drive = google.drive({ version: "v3", auth });
  const response = await drive.files.create({ requestBody: { name: `${input.userId}/${input.documentType}/${input.filename}`, parents: [env.GOOGLE_DRIVE_PARENT_FOLDER_ID!] }, media: { mimeType: input.mimeType, body: Readable.from(input.buffer) }, fields: "id,name" });
  if (!response.data.id) throw new Error("Google Drive did not return a file ID");
  return { provider: "google_drive", fileId: response.data.id, filename: response.data.name ?? input.filename };
}
