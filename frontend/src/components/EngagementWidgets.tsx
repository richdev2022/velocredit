// ============================================================================
// src/components/EngagementWidgets.tsx
// Customer-facing engagement widgets fed from admin platform settings:
//   • AnnouncementSlider — smooth horizontal text marquee with an alert icon
//   • BannerCarousel     — auto-sliding horizontal banner image carousel
// Both fetch public platform endpoints and render nothing when there is no
// active content, so they can be dropped into any dashboard unconditionally.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import {
  getPlatformBanners,
  getPlatformStatus,
  type PlatformAnnouncement,
  type PlatformBanner,
} from "../services/apiClient";

function usePlatformAnnouncements(): PlatformAnnouncement[] {
  const [announcements, setAnnouncements] = useState<PlatformAnnouncement[]>([]);
  useEffect(() => {
    let cancelled = false;
    getPlatformStatus()
      .then((response) => { if (!cancelled) setAnnouncements(response.announcements ?? []); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return announcements;
}

const AlertIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="shrink-0" aria-hidden="true">
    <path
      d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Smooth horizontal announcement slider. Announcements scroll right-to-left
 * continuously; when there is only one message it still slides gently and
 * resets, drawing the eye without ever blocking the layout.
 */
export function AnnouncementSlider() {
  const announcements = usePlatformAnnouncements();
  const messages = useMemo(
    () => announcements.filter((item) => item.message?.trim()).map((item) => item.message.trim()),
    [announcements]
  );
  if (messages.length === 0) return null;
  // The marquee track is built as two IDENTICAL halves so the -50% keyframe
  // loops seamlessly. A single message gets 2 copies per half to keep the
  // glide continuous across wide viewports.
  const half = messages.length === 1 ? [messages[0], messages[0]] : messages;
  const track = [...half, ...half];
  return (
    <div
      className="relative overflow-hidden rounded-xl border border-amber-300/60 bg-gradient-to-r from-amber-50 via-white to-amber-50 dark:border-amber-900/50 dark:from-amber-950/30 dark:via-slate-900 dark:to-amber-950/30"
      role="status"
      aria-live="polite"
    >
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-amber-50 to-transparent dark:from-amber-950/40" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-amber-50 to-transparent dark:from-amber-950/40" />
      <div className="flex w-max animate-velo-marquee items-center gap-10 py-2.5">
        {track.map((message, index) => (
          <span
            key={`${index}-${message.slice(0, 16)}`}
            className="inline-flex items-center gap-2.5 whitespace-nowrap px-1 text-sm font-semibold text-amber-800 dark:text-amber-200"
          >
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-amber-100 text-amber-700 shadow-sm dark:bg-amber-900/60 dark:text-amber-200">
              <AlertIcon />
            </span>
            {message}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Auto-sliding banner carousel. Shows one banner at a time with a smooth
 * horizontal glide every 5 seconds, dot indicators, and pause on hover.
 */
export function BannerCarousel() {
  const [banners, setBanners] = useState<PlatformBanner[]>([]);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPlatformBanners()
      .then((response) => { if (!cancelled) setBanners(response.banners ?? []); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (banners.length <= 1 || paused) return;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % banners.length);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [banners.length, paused]);

  if (banners.length === 0) return null;

  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 shadow-sm dark:border-slate-700 dark:bg-slate-800"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div
        className="flex h-40 transition-transform duration-700 ease-out sm:h-52 lg:h-60"
        style={{ transform: `translateX(-${index * 100}%)` }}
      >
        {banners.map((banner) => {
          const content = (
            <img
              src={banner.imageData}
              alt={banner.name}
              className="h-full w-full shrink-0 object-cover"
              draggable={false}
            />
          );
          return banner.linkUrl ? (
            <a
              key={banner.id}
              href={banner.linkUrl}
              target="_blank"
              rel="noreferrer"
              className="block h-full w-full shrink-0"
            >
              {content}
            </a>
          ) : (
            <div key={banner.id} className="h-full w-full shrink-0">{content}</div>
          );
        })}
      </div>
      {banners.length > 1 && (
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/35 px-2.5 py-1.5 backdrop-blur-sm">
          {banners.map((banner, dot) => (
            <button
              key={banner.id}
              type="button"
              aria-label={`Go to banner ${dot + 1}`}
              onClick={() => setIndex(dot)}
              className={`h-1.5 rounded-full transition-all ${dot === index ? "w-5 bg-white" : "w-1.5 bg-white/60 hover:bg-white/90"}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
