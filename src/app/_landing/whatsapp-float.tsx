import { WhatsAppLink } from "./whatsapp-link";
import { WhatsAppIcon } from "./whatsapp-icon";
import { WHATSAPP_MESSAGES } from "./constants";

export function WhatsAppFloatButton() {
  return (
    <div className="fixed bottom-6 right-6 z-50">
      <WhatsAppLink
        message={WHATSAPP_MESSAGES.floating}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] text-white shadow-lg transition-transform hover:scale-105"
      >
        <span className="sr-only">Escríbenos por WhatsApp</span>
        <WhatsAppIcon className="h-7 w-7" />
      </WhatsAppLink>
    </div>
  );
}
