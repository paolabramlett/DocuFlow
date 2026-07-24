/* Shared line-icon set for the DocuFlow interface. */
export type IconProps = { className?: string };

const s = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const IconCases = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></svg>
);
export const IconBlueprints = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><path d="M12 3 3 7.5 12 12l9-4.5L12 3Z" /><path d="m3 12 9 4.5L21 12M3 16.5 12 21l9-4.5" /></svg>
);
export const IconClients = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 6a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.66" /></svg>
);
export const IconMembers = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><circle cx="12" cy="8" r="3.2" /><path d="M5 20a7 7 0 0 1 14 0" /></svg>
);
export const IconSettings = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></svg>
);
export const IconSearch = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
export const IconPlus = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconCheck = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><path d="m4 12 5 5L20 6" /></svg>
);
export const IconClock = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const IconEye = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="2.5" /></svg>
);
export const IconX = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const IconDot = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><circle cx="12" cy="12" r="7" /></svg>
);
export const IconArrowLeft = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
);
export const IconArrowRight = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const IconTrash = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /></svg>
);
export const IconMail = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
);
export const IconDocument = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v5h5" /></svg>
);
