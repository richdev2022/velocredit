import { useEffect, useRef, useState } from "react";
import { encodeQr } from "../utils/qrcode";

interface Props {
  value: string;
  /** Rendered size in px (the canvas is scaled by devicePixelRatio for crispness). */
  size?: number;
  className?: string;
}

/**
 * Renders a scannable QR code onto a canvas. Uses the in-house encoder
 * (frontend/src/utils/qrcode.ts) — no external dependency.
 *
 * Robustness: encoding is tried at error-correction M first, then L (more
 * capacity). If BOTH fail the component renders a visible placeholder that
 * points the customer at the copyable link next to it — never a silent,
 * blank canvas (that exact bug previously hid the hand-off QR for long URLs).
 */
export default function QRCode({ value, size = 180, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !value) return;
    let cancelled = false;
    setFailed(false);
    try {
      let matrix;
      try {
        matrix = encodeQr(value, "M");
      } catch {
        matrix = encodeQr(value, "L"); // larger capacity, slightly weaker EC
      }
      if (cancelled) return;
      const quietZone = 4; // modules of white border — required by scanners
      const total = matrix.size + quietZone * 2;
      const scale = Math.max(2, Math.floor(size / total));
      const pixelSize = total * scale;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      canvas.width = pixelSize * dpr;
      canvas.height = pixelSize * dpr;
      canvas.style.width = `${pixelSize}px`;
      canvas.style.height = `${pixelSize}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, pixelSize, pixelSize);
      ctx.fillStyle = "#17243d";
      for (let row = 0; row < matrix.size; row++) {
        for (let col = 0; col < matrix.size; col++) {
          if (matrix.modules[row][col]) {
            ctx.fillRect((quietZone + col) * scale, (quietZone + row) * scale, scale, scale);
          }
        }
      }
    } catch {
      // Payload beyond every supported version, or canvas unavailable — show
      // the visible fallback so the customer knows to use the link instead.
      if (!cancelled) setFailed(true);
    }
    return () => { cancelled = true; };
  }, [value, size]);

  if (failed) {
    return (
      <div
        className={`flex items-center justify-center rounded-lg bg-slate-100 p-3 text-center text-[11px] font-semibold leading-snug text-slate-500 dark:bg-slate-800 dark:text-slate-400 ${className ?? ""}`}
        style={{ width: size, height: size }}
        role="img"
        aria-label="QR code unavailable — use the copyable link below instead"
      >
        QR unavailable — type or copy the link below on your phone
      </div>
    );
  }

  return <canvas ref={canvasRef} className={className} aria-label="QR code" role="img" />;
}
