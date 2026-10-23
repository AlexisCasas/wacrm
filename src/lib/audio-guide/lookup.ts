/**
 * Deterministic "which audios go with this Producto value?" for ONE account. This is the contract a Flow node `send_product_audios`
 * (AP-04) consumes; nothing here sends anything, reads a contact, or uses AI.
 *
 * The caller reads the contact's `Producto` custom field (its own responsibility, scoped to the same account) and passes the text.
 * The answer distinguishes every case the node has to branch on:
 *
 *   no_value         the contact has no Producto (null, empty, blank, or not text)            -> safe alternative path
 *   unknown_product  a value, but the account has no product with that normalised key          -> safe alternative path
 *   product_inactive the product exists but an admin switched it off                           -> same as unknown for sending
 *   no_audios        the product is active but has no ACTIVE audio (none added, or all disabled) -> safe alternative path
 *   ready            the active audios in playing order, each with its public URL, hash and the pause BEFORE it
 *
 * A database failure THROWS (CatalogLookupError): "could not look it up" must never be mistaken for "unknown product".
 * Only the account's own products are read; the account id is never taken from the product value.
 */

import { buildVoiceNotePublicUrl } from "@/lib/media/voice-note-path";
import { normalizeProductValue } from "./normalize";
import { storageOrigin, type CatalogDb } from "./catalog";

export class CatalogLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogLookupError";
  }
}

export interface ProductRef { id: string; productKey: string; displayName: string; revision: number }
export interface SequenceItem {
  itemId: string;
  position: number;
  sha256: string;
  url: string;
  bytes: number;
  durationMs: number;
  /** Seconds to wait BEFORE sending this audio (the first one included). */
  preDelaySeconds: number;
}

export type ProductAudioLookup =
  | { kind: "no_value" }
  | { kind: "unknown_product"; key: string | null; reason?: "too_long" }
  | { kind: "product_inactive"; product: ProductRef }
  | { kind: "no_audios"; product: ProductRef; disabledItems: number }
  | { kind: "ready"; product: ProductRef; items: SequenceItem[] };

/**
 * `productValue` is the text the contact stores (automatic mode); `productId` picks a catalog product of THIS account by id (manual mode)
 * and ignores any value. Either way only the account's own products are read.
 */
export async function lookupProductAudios(args: { db: CatalogDb; accountId: string; productValue?: unknown; productId?: string; origin?: string }): Promise<ProductAudioLookup> {
  const { db, accountId } = args;
  let row: Record<string, unknown> | null;
  if (args.productId !== undefined) {
    const { data, error } = await db.from("audio_guide_products").select("id, product_key, display_name, active, revision")
      .eq("account_id", accountId).eq("id", args.productId).maybeSingle();
    if (error) throw new CatalogLookupError("product lookup failed");
    if (!data) return { kind: "unknown_product", key: null };
    row = data as Record<string, unknown>;
  } else {
    const normalized = normalizeProductValue(args.productValue);
    if (!normalized.ok) {
      return normalized.reason === "too_long" ? { kind: "unknown_product", key: null, reason: "too_long" } : { kind: "no_value" };
    }
    const { data, error } = await db.from("audio_guide_products").select("id, product_key, display_name, active, revision")
      .eq("account_id", accountId).eq("product_key", normalized.key).maybeSingle();
    if (error) throw new CatalogLookupError("product lookup failed");
    if (!data) return { kind: "unknown_product", key: normalized.key };
    row = data as Record<string, unknown>;
  }
  const product: ProductRef = { id: row.id as string, productKey: row.product_key as string, displayName: row.display_name as string, revision: Number(row.revision) };
  if (row.active !== true) return { kind: "product_inactive", product };

  const { data: items, error: itemsError } = await db.from("audio_guide_items").select("id, position, voice_sha256, bytes, duration_ms, pre_delay_seconds, status")
    .eq("account_id", accountId).eq("product_id", product.id).order("position", { ascending: true });
  if (itemsError) throw new CatalogLookupError("audio lookup failed");
  const all = (items as Array<Record<string, unknown>> | null) ?? [];
  const active = all.filter((i) => i.status === "active");
  if (active.length === 0) return { kind: "no_audios", product, disabledItems: all.length };
  const origin = args.origin ?? storageOrigin();
  return {
    kind: "ready",
    product,
    items: active.map((i) => ({
      itemId: i.id as string, position: Number(i.position), sha256: i.voice_sha256 as string,
      url: buildVoiceNotePublicUrl(origin, accountId, i.voice_sha256 as string), bytes: Number(i.bytes), durationMs: Number(i.duration_ms),
      preDelaySeconds: Number(i.pre_delay_seconds),
    })),
  };
}
