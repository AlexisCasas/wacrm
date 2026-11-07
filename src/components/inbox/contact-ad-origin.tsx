"use client";

import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

import { createClient } from "@/lib/supabase/client";
import { adDetailText, adPlatformFromUrl, displayAdText, safeAdUrl } from "@/lib/whatsapp/ad-referral";
import { FEP_PRICING_TYPE, fepWindowState, formatRemaining } from "@/lib/whatsapp/fep-window";

interface ContactAdOriginProps {
  contactId: string;
}

interface AdOrigin {
  headline: string | null;
  body?: string | null;
  source_url: string | null;
}

/** The contact's Meta free-entry-point evidence (whatsapp_message_pricing), or null when Meta never confirmed one. */
interface FepRow {
  expiration_at: string | null;
}

const MINUTE_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Inbox sidebar "ORIGEN DEL CLIENTE": the Meta ad the customer came from (first attribution, captured by the WhatsApp webhook). Read through RLS; only the
 * headline, the ad text (body) and the ad URL are selected, so technical ids (source_id, ctwa_clid) never reach the browser. No row = "Sin atribución de anuncio" (nothing is
 * assumed: not organic, not direct). The platform is shown only when the ad URL's host says so; "Ver anuncio" only for a real https Meta URL.
 * The free-entry-point window is shown ONLY with Meta's own evidence (status webhooks): "activa" with the exact time left when Meta sent the
 * expiration, "activa" alone when it confirmed the window but sent no end, "finalizada" only after a real expiration passed, nothing otherwise; the length
 * of a window is never assumed. The clock runs in the browser from the stored expiration (once a minute and once at the expiry), with no further reads.
 * Keyed by contact id by the sidebar and the state remembers which contact it was loaded for, so a previous contact's origin is never shown.
 */
export function ContactAdOrigin({ contactId }: ContactAdOriginProps) {
  const t = useTranslations("Inbox.sidebar");
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<{ contactId: string; ad: AdOrigin | null; fep: FepRow | null } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await supabase
          .from("contact_ad_attributions")
          .select("headline, body, source_url")
          .eq("contact_id", contactId)
          .maybeSingle();
        // A failed read says nothing about the origin: show nothing rather than claim there is none.
        if (cancelled || error) return;
        const ad = (data as AdOrigin | null) ?? null;
        let fep: FepRow | null = null;
        if (ad) {
          // Meta-confirmed window of this contact: the latest real expiration (rows without one come last); never summed or merged. A failed read just
          // leaves the window line out.
          try {
            const res = await supabase
              .from("whatsapp_message_pricing")
              .select("expiration_at")
              .eq("contact_id", contactId)
              .eq("pricing_type", FEP_PRICING_TYPE)
              .order("expiration_at", { ascending: false, nullsFirst: false })
              .limit(1);
            if (!res.error && Array.isArray(res.data) && res.data[0]) fep = { expiration_at: (res.data[0] as FepRow).expiration_at ?? null };
          } catch {
            /* no window line */
          }
        }
        if (cancelled) return;
        setState({ contactId, ad, fep });
      } catch {
        /* leave the section out */
      }
    })();
    return () => { cancelled = true; };
  }, [contactId, supabase]);

  // Clock of the countdown: once a minute, and exactly when the window ends; nothing runs without an expiration still in the future.
  const expirationMs = state?.contactId === contactId && state.fep?.expiration_at ? Date.parse(state.fep.expiration_at) : NaN;
  useEffect(() => {
    if (Number.isNaN(expirationMs)) return;
    // The first refresh lands right after the read (the state was loaded later than `now` was taken); then once a minute and at the expiry.
    const first = setTimeout(() => setNow(Date.now()), 0);
    if (expirationMs <= Date.now()) return () => clearTimeout(first);
    const tick = setInterval(() => setNow(Date.now()), MINUTE_MS);
    const end = setTimeout(() => setNow(Date.now()), Math.min(expirationMs - Date.now() + 50, MAX_TIMEOUT_MS));
    return () => { clearTimeout(first); clearInterval(tick); clearTimeout(end); };
  }, [expirationMs]);

  if (!state || state.contactId !== contactId) return null;

  const { ad } = state;
  const url = safeAdUrl(ad?.source_url);
  const platform = adPlatformFromUrl(url);
  const headline = displayAdText(ad?.headline);
  const detail = adDetailText(ad?.headline, ad?.body);
  const fepWindow = ad ? fepWindowState(state.fep, now) : { kind: "none" as const };

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
          {fepWindow.kind === "active_unknown_end" && <p className="font-medium text-foreground">🟢 {t("originFepActive")}</p>}
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
