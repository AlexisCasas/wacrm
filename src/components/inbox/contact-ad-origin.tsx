"use client";

import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

import { createClient } from "@/lib/supabase/client";
import { adPlatformFromUrl, safeAdUrl } from "@/lib/whatsapp/ad-referral";

interface ContactAdOriginProps {
  contactId: string;
}

interface AdOrigin {
  headline: string | null;
  source_url: string | null;
}

/**
 * Inbox sidebar "ORIGEN DEL CLIENTE": the Meta ad the customer came from (first attribution, captured by the WhatsApp webhook). Read through RLS; only the
 * headline and the ad URL are selected, so technical ids (source_id, ctwa_clid) never reach the browser. No row = "Sin atribución de anuncio" (nothing is
 * assumed: not organic, not direct). The platform is shown only when the ad URL's host says so; "Ver anuncio" only for a real https Meta URL.
 * Keyed by contact id by the sidebar and the state remembers which contact it was loaded for, so a previous contact's origin is never shown.
 */
export function ContactAdOrigin({ contactId }: ContactAdOriginProps) {
  const t = useTranslations("Inbox.sidebar");
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<{ contactId: string; ad: AdOrigin | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await supabase
          .from("contact_ad_attributions")
          .select("headline, source_url")
          .eq("contact_id", contactId)
          .maybeSingle();
        // A failed read says nothing about the origin: show nothing rather than claim there is none.
        if (cancelled || error) return;
        setState({ contactId, ad: (data as AdOrigin | null) ?? null });
      } catch {
        /* leave the section out */
      }
    })();
    return () => { cancelled = true; };
  }, [contactId, supabase]);

  if (!state || state.contactId !== contactId) return null;

  const { ad } = state;
  const url = safeAdUrl(ad?.source_url);
  const platform = adPlatformFromUrl(url);

  return (
    <div className="mt-2 px-3" data-testid="contact-ad-origin">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("originTitle")}</p>
      {ad ? (
        <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">📣 {t("originMetaAd")}</p>
          {ad.headline && <p className="break-words">{t("originAd")}: {ad.headline}</p>}
          <p>{t("originEntry")}: {t("originEntryValue")}</p>
          {platform && <p>{t("originPlatform")}: {platform === "instagram" ? t("originInstagram") : t("originFacebook")}</p>}
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
