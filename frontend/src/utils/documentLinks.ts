export function documentPreviewUrl(document: { provider?: string; providerFileId?: string; previewUrl?: string; driveUrl?: string; url?: string }) {
  const source = document.previewUrl || document.url || document.driveUrl || document.providerFileId;
  if (!source) return "";
  // Inline payloads (data-URIs re-hydrated from the application snapshot or
  // fast-path uploads) are directly renderable — pass them through as-is.
  if (/^data:/i.test(source)) return source;
  if (/^https?:\/\//i.test(source)) return source;
  return document.provider === "google_drive" ? `https://drive.google.com/uc?export=view&id=${encodeURIComponent(source)}` : "";
}

export function documentDownloadUrl(document: { provider?: string; providerFileId?: string; downloadUrl?: string; driveUrl?: string; url?: string }) {
  const source = document.downloadUrl || document.driveUrl || document.url || document.providerFileId;
  if (!source) return "";
  if (/^data:/i.test(source)) return source;
  if (/^https?:\/\//i.test(source)) return source;
  return document.provider === "google_drive" ? `https://drive.google.com/uc?export=download&id=${encodeURIComponent(source)}` : "";
}
