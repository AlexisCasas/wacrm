/**
 * The audio-guide catalog: products (a normalised key + a visible name) and, for each, an ordered list of verified OGG/Opus voice
 * notes. Server-side only; it takes the service-role client and ALWAYS the account id of the session, which every query repeats
 * (the service role bypasses RLS, so tenancy is enforced here and by the composite keys of migration 073).
 *
 * Writes that touch a product or its audios go through the database functions of migration 074, which lock the product, compare the
 * caller's `revision` and answer `revision_conflict` instead of overwriting a newer change. Nothing here deletes a stored file: files
 * are shared by hash, and removing an audio only removes the association (history keeps its hash snapshot).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { buildVoiceNotePublicUrl } from "@/lib/media/voice-note-path";
import { normalizeProductValue } from "./normalize";
import { promoteVoiceNote, verifyStoredVoiceNote } from "./voice-note-store";
import type { VoiceNoteRejection } from "@/lib/media/voice-note";
import type { AddItemInput } from "./input";

export type CatalogDb = Pick<SupabaseClient, "from" | "rpc" | "storage">;

export type CatalogFailureReason =
  | "not_found" | "revision_conflict" | "duplicate_key" | "invalid_value" | "limit_reached" | "invalid_order"
  | "file_not_stored" | "file_rejected" | "duplicate_audio" | "conflict" | "storage_error" | "db_error";

export type CatalogResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: CatalogFailureReason; revision?: number; voiceNoteReason?: VoiceNoteRejection };

const ok = <T>(value: T): CatalogResult<T> => ({ ok: true, value });
const refuse = <T = never>(reason: CatalogFailureReason, extra: { revision?: number; voiceNoteReason?: VoiceNoteRejection } = {}): CatalogResult<T> => ({ ok: false, reason, ...extra });

export interface CatalogProduct {
  id: string;
  productKey: string;
  displayName: string;
  active: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface CatalogProductSummary extends CatalogProduct { itemCount: number; activeItemCount: number }
export interface CatalogItem {
  id: string;
  position: number;
  sha256: string;
  url: string;
  label: string | null;
  bytes: number;
  durationMs: number;
  preDelaySeconds: number;
  status: "active" | "disabled";
}
export interface CatalogProductDetail extends CatalogProduct { items: CatalogItem[] }

export const MAX_PRODUCTS_LISTED = 500;

type Row = Record<string, unknown>;
const productOf = (r: Row): CatalogProduct => ({
  id: r.id as string, productKey: r.product_key as string, displayName: r.display_name as string, active: r.active === true,
  revision: Number(r.revision), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
});

export function storageOrigin(): string {
  const origin = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!origin) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not configured");
  return origin;
}

const PRODUCT_COLUMNS = "id, product_key, display_name, active, revision, created_at, updated_at";
const ITEM_COLUMNS = "id, product_id, position, voice_sha256, bytes, duration_ms, label, pre_delay_seconds, status";

function itemOf(r: Row, accountId: string, origin: string): CatalogItem {
  return {
    id: r.id as string, position: Number(r.position), sha256: r.voice_sha256 as string,
    url: buildVoiceNotePublicUrl(origin, accountId, r.voice_sha256 as string), label: (r.label as string | null) ?? null,
    bytes: Number(r.bytes), durationMs: Number(r.duration_ms), preDelaySeconds: Number(r.pre_delay_seconds), status: r.status === "disabled" ? "disabled" : "active",
  };
}

/** Products of the account, with how many audios each has. `q` is matched on the normalised key and the visible name. */
export async function listProducts(db: CatalogDb, accountId: string, q?: string): Promise<CatalogResult<CatalogProductSummary[]>> {
  const { data, error } = await db.from("audio_guide_products").select(PRODUCT_COLUMNS).eq("account_id", accountId).order("display_name", { ascending: true }).limit(MAX_PRODUCTS_LISTED);
  if (error) return refuse("db_error");
  let products = ((data as Row[] | null) ?? []).map(productOf);
  const needle = typeof q === "string" ? normalizeProductValue(q) : null;
  if (needle?.ok) {
    const key = needle.key;
    products = products.filter((p) => p.productKey.includes(key) || (normalizeProductValue(p.displayName).ok && (normalizeProductValue(p.displayName) as { key: string }).key.includes(key)));
  }
  if (products.length === 0) return ok([]);
  const { data: items, error: itemsError } = await db.from("audio_guide_items").select("product_id, status").eq("account_id", accountId).in("product_id", products.map((p) => p.id));
  if (itemsError) return refuse("db_error");
  const counts = new Map<string, { all: number; active: number }>();
  for (const i of (items as Row[] | null) ?? []) {
    const c = counts.get(i.product_id as string) ?? { all: 0, active: 0 };
    c.all++; if (i.status === "active") c.active++;
    counts.set(i.product_id as string, c);
  }
  return ok(products.map((p) => ({ ...p, itemCount: counts.get(p.id)?.all ?? 0, activeItemCount: counts.get(p.id)?.active ?? 0 })));
}

export async function getProduct(db: CatalogDb, accountId: string, productId: string, origin = storageOrigin()): Promise<CatalogResult<CatalogProductDetail>> {
  const { data, error } = await db.from("audio_guide_products").select(PRODUCT_COLUMNS).eq("id", productId).eq("account_id", accountId).maybeSingle();
  if (error) return refuse("db_error");
  if (!data) return refuse("not_found");
  const { data: items, error: itemsError } = await db.from("audio_guide_items").select(ITEM_COLUMNS).eq("product_id", productId).eq("account_id", accountId).order("position", { ascending: true });
  if (itemsError) return refuse("db_error");
  return ok({ ...productOf(data as Row), items: ((items as Row[] | null) ?? []).map((r) => itemOf(r, accountId, origin)) });
}

/** Creates a product. `productValue` is the text the contact's `Producto` field will hold; it becomes the lookup key. */
export async function createProduct(db: CatalogDb, accountId: string, input: { displayName: string; productValue: string }): Promise<CatalogResult<CatalogProductDetail>> {
  const key = normalizeProductValue(input.productValue);
  if (!key.ok) return refuse("invalid_value");
  const { data, error } = await db.from("audio_guide_products").insert({ account_id: accountId, product_key: key.key, display_name: input.displayName }).select(PRODUCT_COLUMNS).maybeSingle();
  if (error) return refuse(error.code === "23505" ? "duplicate_key" : error.code === "23514" ? "invalid_value" : "db_error");
  return ok({ ...productOf(data as Row), items: [] });
}

const KNOWN: ReadonlySet<string> = new Set(["not_found", "revision_conflict", "duplicate_key", "invalid_value", "limit_reached", "invalid_order", "file_not_stored", "conflict"]);

/** One atomic change through a migration-074 function. Anything the function does not recognise is a `db_error`, never a success. */
async function call<T>(db: CatalogDb, fn: string, args: Record<string, unknown>, pick: (r: Record<string, unknown>) => T): Promise<CatalogResult<T>> {
  const { data, error } = await db.rpc(fn, args);
  const r = data as Record<string, unknown> | null;
  if (error || !r || typeof r !== "object") return refuse("db_error");
  if (r.ok === true) return ok(pick(r));
  const reason = typeof r.reason === "string" && KNOWN.has(r.reason) ? (r.reason as CatalogFailureReason) : "db_error";
  return refuse(reason, typeof r.revision === "number" ? { revision: r.revision } : {});
}

export function saveProduct(db: CatalogDb, accountId: string, productId: string, input: { expectedRevision: number; displayName?: string; productValue?: string; active?: boolean }) {
  let productKey: string | undefined;
  if (input.productValue !== undefined) {
    const key = normalizeProductValue(input.productValue);
    if (!key.ok) return Promise.resolve(refuse<{ revision: number }>("invalid_value"));
    productKey = key.key;
  }
  return call(db, "audio_guide_save_product", {
    p_account: accountId, p_product: productId, p_expected: input.expectedRevision,
    p_display_name: input.displayName ?? null, p_product_key: productKey ?? null, p_active: input.active ?? null,
  }, (r) => ({ revision: Number(r.revision) }));
}

export const deleteProduct = (db: CatalogDb, accountId: string, productId: string, expectedRevision: number) =>
  call(db, "audio_guide_delete_product", { p_account: accountId, p_product: productId, p_expected: expectedRevision }, () => ({}));

export const removeItem = (db: CatalogDb, accountId: string, itemId: string, expectedRevision: number) =>
  call(db, "audio_guide_remove_item", { p_account: accountId, p_item: itemId, p_expected: expectedRevision }, (r) => ({ revision: Number(r.revision) }));

export const reorderItems = (db: CatalogDb, accountId: string, productId: string, expectedRevision: number, itemIds: string[]) =>
  call(db, "audio_guide_reorder_items", { p_account: accountId, p_product: productId, p_expected: expectedRevision, p_item_ids: itemIds }, (r) => ({ revision: Number(r.revision) }));

export const updateItem = (db: CatalogDb, accountId: string, itemId: string, input: { expectedRevision: number; status?: "active" | "disabled"; preDelaySeconds?: number; label?: string; clearLabel?: boolean }) =>
  call(db, "audio_guide_update_item", {
    p_account: accountId, p_item: itemId, p_expected: input.expectedRevision, p_status: input.status ?? null,
    p_pre_delay: input.preDelaySeconds ?? null, p_label: input.label ?? null, p_clear_label: input.clearLabel === true,
  }, (r) => ({ revision: Number(r.revision) }));

/** The display name of a staged upload (`<epoch>-<name>.ogg`) as a readable default label. */
export function defaultLabelFromStagedPath(path: string): string {
  const file = path.split("/").pop() ?? "";
  return file.replace(/^\d{13}-/, "").slice(0, 120) || "audio.ogg";
}

/**
 * Adds a verified voice note to a product. The file is either a staged upload of this account (verified and stored now, exactly as
 * POST /api/flows/voice-notes does) or a hash already stored for it (re-verified). Size, duration and channels come from the
 * verification, never from the caller. If the product refuses the audio (limit, stale revision), the stored file simply stays: it is
 * content-addressed, immutable and may already serve another product.
 */
export async function addItem(db: CatalogDb, accountId: string, productId: string, input: AddItemInput): Promise<CatalogResult<{ itemId: string; position: number; revision: number }>> {
  // The product must be this account's BEFORE anything is verified or stored: a foreign or unknown id is simply not_found, and no
  // file is promoted on its behalf.
  const { data: owned, error: ownedError } = await db.from("audio_guide_products").select("id").eq("id", productId).eq("account_id", accountId).maybeSingle();
  if (ownedError) return refuse("db_error");
  if (!owned) return refuse("not_found");
  let meta: { sha256: string; bytes: number; durationMs: number };
  let label = input.label;
  if (input.source.kind === "staged") {
    const promoted = await promoteVoiceNote({ admin: db as never, accountId, stagingPath: input.source.path });
    if (!promoted.ok) {
      return promoted.code === "rejected" ? refuse("file_rejected", { voiceNoteReason: promoted.reason })
        : promoted.code === "storage_error" ? refuse("storage_error") : refuse("file_not_stored");
    }
    meta = { sha256: promoted.sha256, bytes: promoted.bytes, durationMs: promoted.durationMs };
    label ??= defaultLabelFromStagedPath(input.source.path);
  } else {
    const stored = await verifyStoredVoiceNote({ admin: db as never, accountId, sha256: input.source.sha256 });
    if (!stored.ok) return stored.code === "rejected" ? refuse("file_rejected", { voiceNoteReason: stored.reason }) : refuse("file_not_stored");
    meta = stored;
  }
  // The same audio twice in one product is never intended: a retry whose first attempt actually succeeded, or an original and its
  // repaired copy (same bytes, same hash), must not add a second row. Checked per product and account; the stored file itself may
  // serve other products. Concurrent identical adds are still serialised by the product lock and its revision.
  const { data: same, error: sameError } = await db.from("audio_guide_items").select("id")
    .eq("account_id", accountId).eq("product_id", productId).eq("voice_sha256", meta.sha256).limit(1);
  if (sameError) return refuse("db_error");
  if (Array.isArray(same) && same.length > 0) return refuse("duplicate_audio");
  return call(db, "audio_guide_add_item", {
    p_account: accountId, p_product: productId, p_expected: input.expectedRevision, p_sha256: meta.sha256, p_bytes: meta.bytes,
    p_duration_ms: meta.durationMs, p_label: label ?? null, p_pre_delay: input.preDelaySeconds ?? 5,
  }, (r) => ({ itemId: String(r.item_id), position: Number(r.position), revision: Number(r.revision) }));
}
