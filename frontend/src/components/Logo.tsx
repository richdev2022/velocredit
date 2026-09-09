// ============================================================================
// src/components/Logo.tsx
// Velo Finance LTD logo. Uses an inline SVG (no external file required) so
// The URL is editable from Admin Settings and falls back to the local assets.
// ============================================================================

import { config } from "../utils/config";

interface LogoProps {
  className?: string;
  showWordmark?: boolean;
  size?: number;
}

export default function Logo({ className = "", showWordmark = true, size = 32 }: LogoProps) {
  return (
    <img
      src={showWordmark ? config.brandLogoUrl : "/velo-mark.webp"}
      alt="Velo Finance LTD"
      style={{ height: `${size}px` }}
      className={`block h-auto max-w-full max-h-full w-auto shrink-0 object-contain object-left ${className}`}
    />
  );
}
