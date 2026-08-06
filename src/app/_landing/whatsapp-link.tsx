import type { ReactNode } from "react";
import { buildWhatsAppUrl } from "./constants";

export function WhatsAppLink({
  message,
  className,
  children,
}: {
  message: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a href={buildWhatsAppUrl(message)} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}
