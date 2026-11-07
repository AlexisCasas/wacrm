"use client";

import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

import { useContactFepWindow } from "@/hooks/use-contact-fep-window";
import { adDetailText, adPlatformFromUrl, displayAdText, safeAdUrl } from "@/lib/whatsapp/ad-referral";
import { formatRemaining } from "@/lib/whatsapp/fep-window";

interface ContactAdOriginProps {
  contactId: string;
}

/**
 * Inbox sidebar "ORIGEN DEL CLIENTE": the Meta ad the customer came from (first attribution, captured by the WhatsApp webhook). Read through RLS; only the
 * headline, the ad text (body) and the ad URL are selected, so technical ids (source_id, ctwa_clid) never reach the browser. No row = "Sin atribución de anuncio" (nothing is
 * assumed: not organic, not direct). The platform is shown only when the ad URL's host says so; "Ver anuncio" only for a real https Meta URL.
 * The free-entry-point window is shown ONLY with Meta's own evidence (status webhooks): "activa" with the exact time left when Meta sent the
 * expiration, "Meta confirmó envío sin costo" alone (no time, no "activa") when it confirmed a free message but sent no end, "finalizada" only after a real expiration passed, nothing otherwise; the length
 * of a window is never assumed. The clock runs in the browser from the stored expiration (once a minute and once at the expiry), with no further reads.
 * Keyed by contact id by the sidebar and the state remembers which contact it was loaded for, so a previous contact's origin is never shown.
 */
export function ContactAdOrigin({ contactId }: ContactAdOriginProps) {
  const t = useTranslations("Inbox.sidebar");
  const { state, fepWindow } = useContactFepWindow(contactId);

  if (!state) return null;

  const { ad } = state;
  const url = safeAdUrl(ad?.source_url);
  const platform = adPlatformFromUrl(url);
  const headline = displayAdText(ad?.headline);
  const detail = adDetailText(ad?.headline, ad?.body);

  return (
    <div className="mt-2 px-3" data-testid="contact-ad-origin">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("originTitle")}</p>
      {ad ? (
        <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">📣 {t("originMetaAd")}</p>
          {headline && <p className="break-words">{t("originAd")}: {headline}</p>}
          {detail && <p className="line-clamp-2 break-words" title={detail}>{t("originDetail")}: {detail}</p>}
          <p>{t("originEntry")}: {t("originEntryValue")}</p>
          {platform && <p>{t("originPlatform")}: {platform === "instagram" ? t("originInstagram") : t("originFacebook")}</p>}
          {fepWindow.kind === "free_confirmed" && <p className="font-medium text-foreground">{t("originFepConfirmed")}</p>}
          {fepWindow.kind === "countdown" && (
            <>
              <p className="font-medium text-foreground">{fepWindow.endingSoon ? "🟠" : "🟢"} {t("originFepWindow")}</p>
              <p>{t("originFepRemaining", { time: formatRemaining(fepWindow.remainingMs) })}</p>
            </>
          )}
          {fepWindow.kind === "ended" && <p>{t("originFepEnded")}</p>}
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              {t("originViewAd")}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">{t("originNone")}</p>
      )}
    </div>
  );
}
