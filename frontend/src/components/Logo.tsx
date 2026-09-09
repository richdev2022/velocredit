// ============================================================================
// src/components/Logo.tsx
// Velo Finance LTD logo. Uses an inline SVG (no external file required) so
// the app works offline and on any host. If /logo.svg is preferred, swap the
// JSX for <img src="/logo.svg" />.
// ============================================================================

interface LogoProps {
  className?: string;
  showWordmark?: boolean;
  size?: number;
}

export default function Logo({ className = "", showWordmark = true, size = 32 }: LogoProps) {
  return (
    <img
      src={showWordmark ? "/velo-logo.png" : "/velo-mark.webp"}
      alt="Velo Finance LTD"
      style={{ height: `${size}px` }}
      className={`block h-auto max-w-full max-h-full w-auto shrink-0 object-contain object-left ${className}`}
    />
  );
}
