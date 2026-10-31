"use client";

import { useTranslations } from "next-intl";
import { hasPhone, type DisplayableContact } from "@/lib/contacts/display";

/**
 * The phone of a contact, or an honest "number not available" for a WhatsApp user who hides it (identified by a
 * business-scoped user id). Never shows a made-up number and never shows the technical id.
 */
export function ContactPhoneLine({ contact, className }: { contact: DisplayableContact; className?: string }) {
  const t = useTranslations("ContactIdentity");
  if (hasPhone(contact)) return <span className={className}>{contact.phone}</span>;
  return (
    <span className={className} title={t("phoneUnavailableHint")} data-testid="phone-unavailable">
      {contact.wa_username ? `@${contact.wa_username} · ` : ""}
      {t("phoneUnavailable")}
    </span>
  );
}
