import { useEffect, useRef } from "react";
import { encodeQr } from "../utils/qrcode";

interface Props {
  value: string;
  /** Rendered size in px (the canvas is scaled by devicePixelRatio for crispness). */
  size?: number;
  className?: string;
}

/**
 * Renders a scannable QR code onto a canvas. Uses the in-house encoder
 * (frontend/src/utils/qrcode.ts) — no external dependency — at error
 * correction level M so phone cameras scan it reliably.
 */
export default function QRCode({ value, size = 180, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !value) return;
    let cancelled = false;
    try {
      const matrix = encodeQr(value, "M");
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
      // Payload too long or canvas unavailable — leave the canvas blank; the
      // copyable URL beside the QR is always available as a fallback.
    }
    return () => { cancelled = true; };
  }, [value, size]);

  return <canvas ref={canvasRef} className={className} aria-label="QR code" role="img" />;
}
