/**
 * Click-to-WhatsApp ad attribution carried by `messages[].referral` of the WhatsApp webhook (the first message of a conversation opened from a Meta ad).
 *
 * Documented fields (all optional, none is assumed): source_url, source_id, source_type ("ad" | "post"), body, headline, media_type, image_url,
 * video_url, thumbnail_url, ctwa_clid. Meta does NOT say which platform (Facebook / Instagram) the click came from, so the platform is only inferred from
 * the host of `source_url` when that host is unambiguous (see adPlatformFromUrl).
 */

export interface AdReferral {
  source_url?: unknown;
  source_id?: unknown;
  source_type?: unknown;
  body?: unknown;
  headline?: unknown;
  media_type?: unknown;
  image_url?: unknown;
  video_url?: unknown;
  thumbnail_url?: unknown;
  ctwa_clid?: unknown;
}

/** The columns of contact_ad_attributions the webhook fills (everything except contact_id / account_id / captured_at). */
export interface NormalizedAdReferral {
  source_type: "ad";
  source_id: string | null;
  source_url: string | null;
  headline: string | null;
  body: string | null;
  media_type: string | null;
  image_url: string | null;
  video_url: string | null;
  thumbnail_url: string | null;
  ctwa_clid: string | null;
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

/** Meta-owned hosts a "Ver anuncio" link may point to (the host itself or any subdomain). */
const META_HOSTS = ["facebook.com", "fb.com", "fb.me", "instagram.com"];

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

const hostIs = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** The URL only when it is a real https link on a Meta host; anything else (other host, http, javascript:, garbage) is not shown or opened. */
export function safeAdUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const host = hostOf(url);
  return host && META_HOSTS.some((d) => hostIs(host, d)) ? url : null;
}

/** "instagram" / "facebook" only when the ad URL's host says so unambiguously; the fb.me shortener and everything else is unknown (null). */
export function adPlatformFromUrl(url: string | null | undefined): "instagram" | "facebook" | null {
  const host = url ? hostOf(url) : null;
  if (!host) return null;
  if (hostIs(host, "instagram.com")) return "instagram";
  if (hostIs(host, "facebook.com")) return "facebook";
  return null;
}

/**
 * Normalizes a webhook referral. Returns null unless it describes an AD click (source_type "ad") with something worth keeping: a "post" referral is an
 * organic post, not advertising, and a referral with no ad identity at all is noise.
 */
export function normalizeAdReferral(referral: unknown): NormalizedAdReferral | null {
  if (!referral || typeof referral !== "object") return null;
  const r = referral as AdReferral;
  if (r.source_type !== "ad") return null;
  const out: NormalizedAdReferral = {
    source_type: "ad",
    source_id: str(r.source_id, 128),
    source_url: str(r.source_url, 2048),
    headline: str(r.headline, 300),
    body: str(r.body, 1000),
    media_type: str(r.media_type, 32),
    image_url: str(r.image_url, 2048),
    video_url: str(r.video_url, 2048),
    thumbnail_url: str(r.thumbnail_url, 2048),
    ctwa_clid: str(r.ctwa_clid, 512),
  };
  return out.source_id || out.source_url || out.headline || out.ctwa_clid ? out : null;
}

/**
 * Text of an ad as shown in the UI. Meta ad copy often uses "mathematical" bold letters (U+1D5D4…); NFKC maps them to plain letters, whitespace is collapsed.
 * Display only: the stored text is never changed.
 */
export function displayAdText(value: string | null | undefined): string {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
}

const compareKey = (s: string) => s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const DETAIL_MAX = 200;

/**
 * The "Detalle" line of an ad: its body (the ad's own text, which usually names the product) as real text from the referral, compact. Null when there is
 * no body or it adds nothing over the headline (equal, or one is practically the other).
 */
export function adDetailText(headline: string | null | undefined, body: string | null | undefined): string | null {
  const detail = displayAdText(body);
  if (!detail) return null;
  const a = compareKey(detail);
  const b = compareKey(displayAdText(headline));
  if (!a) return null;
  if (b) {
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (short === long || (long.includes(short) && short.length / long.length >= 0.8)) return null;
  }
  return detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX).trimEnd()}…` : detail;
}
