import type { ReactNode, SVGProps } from "react";

type IconName =
  | "alert"
  | "arrowDown"
  | "arrowLeft"
  | "arrowRight"
  | "arrowUp"
  | "bank"
  | "briefcase"
  | "calendar"
  | "chart"
  | "check"
  | "clock"
  | "email"
  | "history"
  | "lightning"
  | "lock"
  | "message"
  | "money"
  | "save"
  | "shield"
  | "sparkles"
  | "target"
  | "wallet"
  | "wind"
  | "x";

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  name: IconName;
  size?: number;
}

export default function Icon({ name, size = 16, strokeWidth = 2, ...props }: IconProps) {
  const paths: Record<IconName, ReactNode> = {
    alert: <><path d="M12 9v4m0 4h.01"/><path d="m10.3 3.9-8.5 14A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-3.1l-8.5-14a2 2 0 0 0-3.4 0Z"/></>,
    arrowDown: <path d="m6 9 6 6 6-6"/>,
    arrowLeft: <path d="m15 18-6-6 6-6"/>,
    arrowRight: <path d="m9 18 6-6-6-6"/>,
    arrowUp: <path d="m18 15-6-6-6 6"/>,
    bank: <><path d="m3 10 9-6 9 6"/><path d="M5 10v8m4-8v8m6-8v8m4-8v8M3 20h18"/></>,
    briefcase: <><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-13 5h18M10 13h4"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></>,
    chart: <><path d="M4 19V5m0 14h16"/><path d="m7 15 4-4 3 2 5-7"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    email: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5M12 7v5l3 2"/></>,
    lightning: <path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>,
    lock: <><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    message: <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.7 9.7 0 0 1-4.2-1L3 20l1.3-4.1A8.2 8.2 0 0 1 3 11.5 8.5 8.5 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5Z"/>,
    money: <><circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.4-.8-1.5-1.5-3-1.5-1.7 0-3 1-3 2.2 0 1.4 1.3 2 3 2.3 1.7.4 3 1 3 2.4 0 1.2-1.3 2.1-3 2.1-1.5 0-2.6-.6-3-1.5M12 6v12"/></>,
    save: <><path d="M5 3h12l3 3v15H4V4a1 1 0 0 1 1-1Z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/></>,
    shield: <path d="M12 2 4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6l-8-4Z"/>,
    sparkles: <><path d="m12 3 .9 4.1L17 8l-4.1.9L12 13l-.9-4.1L7 8l4.1-.9L12 3Z"/><path d="m19 14 .5 2.5L22 17l-2.5.5L19 20l-.5-2.5L16 17l2.5-.5L19 14ZM5 14l.5 2.5L8 17l-2.5.5L5 20l-.5-2.5L2 17l2.5-.5L5 14Z"/></>,
    target: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2"/></>,
    wallet: <><path d="M4 7h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12"/><path d="M16 14h3"/></>,
    wind: <><path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h6"/></>,
    x: <path d="m6 6 12 12M18 6 6 18"/>,
  };

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {paths[name]}
    </svg>
  );
}
