// ============================================================================
// src/components/FileUpload.tsx
// Drag-and-drop / click-to-browse file uploader with client-side validation.
// File data is read locally for validation before authenticated API upload.
// ============================================================================

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ALLOWED_DOC_EXTENSIONS,
  MAX_DOC_SIZE_BYTES,
  type UploadedDocument,
} from "../types/documents";
import { validateDocumentFile } from "../utils/validation";

interface FileUploadProps {
  label: string;
  helper?: string;
  required?: boolean;
  /** Current uploaded document (or undefined) */
  document?: UploadedDocument;
  /** Called when a valid file has been read */
  onFile: (doc: UploadedDocument) => void;
  /** Called when the user clicks "Remove" */
  onRemove?: () => void;
  /** Optional icon slot */
  icon?: ReactNode;
  media?: boolean;
}

export default function FileUpload({
  label,
  helper,
  required,
  document,
  onFile,
  onRemove,
  icon,
  media = false,
}: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const accept = (media ? ALLOWED_DOC_EXTENSIONS : ALLOWED_DOC_EXTENSIONS.filter((e) => !["mp4", "mov", "webm"].includes(e))).map((e) => `.${e}`).join(",");
  const docName = document?.name;
  const previewSource = document?.type?.startsWith("image/") && document.data ? `data:${document.type};base64,${document.data}` : document?.previewUrl;

  function readFile(file: File) {
    setLocalError(null);
    const result = validateDocumentFile(file, media);
    if (!result.valid) {
      setLocalError(result.error || "Invalid file.");
      return;
    }
    setReading(true);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // Strip the data URI prefix, store only base64 payload
      const base64 = dataUrl.split(",")[1] || "";
      onFile({
        slot: document?.slot || "identificationDocument", // set by parent
        name: file.name,
        type: file.type,
        size: file.size,
        data: base64,
        status: "uploaded",
        addedAt: new Date().toISOString(),
      });
      setReading(false);
    };
    reader.onerror = () => {
      setLocalError("Could not read the file. Please try a different file.");
      setReading(false);
    };
    reader.readAsDataURL(file);
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) readFile(f);
    // reset value so picking the same file again triggers onChange
    if (inputRef.current) inputRef.current.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) readFile(f);
  }

  return (
    <div className="w-full">
      <label className="velo-label">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>

      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`relative cursor-pointer rounded-xl border-2 border-dashed px-4 py-6 text-center transition
          ${dragOver ? "border-velo-500 bg-velo-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          onChange={handleInputChange}
          className="sr-only"
          aria-label={label}
        />
        {docName ? (
          <div className="flex items-center justify-center gap-3">
            {previewSource ? <img src={previewSource} alt={`${label} preview`} className="h-12 w-12 rounded-lg border border-slate-200 object-cover" /> : <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
              <CheckIcon />
            </span>}
            <div className="text-left">
              <div className="text-sm font-medium text-velo-900 max-w-[260px] truncate" title={docName}>
                {docName}
              </div>
              <div className="text-xs text-slate-500">
                {(document!.size / 1024 / 1024).toFixed(2)} MB • Uploaded
              </div>
            </div>
            {onRemove && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRemove(); }}
                className="ml-2 text-xs font-semibold text-red-600 hover:text-red-700"
              >
                Remove
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-2">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-velo-50 text-velo-600">
              {icon || <UploadIcon />}
            </span>
            <div className="text-sm font-medium text-velo-900">
              {reading ? "Reading file…" : "Click to upload or drag & drop"}
            </div>
            <div className="text-xs text-slate-500">
              {media ? "JPG, PNG, MP4, MOV, WEBM" : "PDF, JPG, JPEG, PNG"} • max 10 MB
            </div>
          </div>
        )}
      </div>

      {localError && <p className="velo-error-text">{localError}</p>}
      {!localError && helper && <p className="velo-helper">{helper}</p>}
    </div>
  );
}

function UploadIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M12 16V4M12 4l-4 4M12 4l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
