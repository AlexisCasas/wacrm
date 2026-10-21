/**
 * Server-side validation of what the catalog API accepts. Everything arrives as `unknown` JSON; nothing is trusted. A failed check names
 * the field so the UI can point at it. No account id is ever read from a body: the API uses the session's.
 */

import { isSafeStagingPath } from "@/lib/media/voice-note-path";

export type Parsed<T> = { ok: true; value: T } | { ok: false; field: string; error: string };
const fail = (field: string, error: string): { ok: false; field: string; error: string } => ({ ok: false, field, error });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export const DISPLAY_NAME_MAX = 120;
export const LABEL_MAX = 120;
export const PAUSE_MIN_SECONDS = 5;
export const PAUSE_MAX_SECONDS = 30;
export const MAX_ITEMS_PER_PRODUCT = 6;

type Body = Record<string, unknown>;
const asBody = (raw: unknown): Body | null => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Body) : null);
const has = (b: Body, k: string) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;

export function parseRevision(raw: unknown, field = "expected_revision"): Parsed<number> {
  const n = typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 2_000_000_000) return fail(field, "expected_revision_required");
  return { ok: true, value: n };
}

export function parseDisplayName(raw: unknown, field = "display_name"): Parsed<string> {
  if (typeof raw !== "string") return fail(field, "display_name_required");
  const v = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (v === "") return fail(field, "display_name_required");
  if (v.length > DISPLAY_NAME_MAX) return fail(field, "display_name_too_long");
  return { ok: true, value: v };
}

export function parseLabel(raw: unknown, field = "label"): Parsed<string> {
  if (typeof raw !== "string") return fail(field, "label_invalid");
  const v = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (v === "") return fail(field, "label_invalid");
  if (v.length > LABEL_MAX) return fail(field, "label_too_long");
  return { ok: true, value: v };
}

export function parsePause(raw: unknown, field = "pre_delay_seconds"): Parsed<number> {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < PAUSE_MIN_SECONDS || raw > PAUSE_MAX_SECONDS) return fail(field, "pause_out_of_range");
  return { ok: true, value: raw };
}

export interface CreateProductInput { displayName: string; productValue: string }
export function parseCreateProduct(raw: unknown): Parsed<CreateProductInput> {
  const b = asBody(raw);
  if (!b) return fail("body", "invalid_body");
  const name = parseDisplayName(b.display_name);
  if (!name.ok) return name;
  // The text the contact's `Producto` field holds. Defaults to the visible name; it is what gets normalised into the lookup key.
  const value = has(b, "product_value") ? b.product_value : name.value;
  if (typeof value !== "string") return fail("product_value", "product_value_invalid");
  return { ok: true, value: { displayName: name.value, productValue: value } };
}

export interface SaveProductInput { expectedRevision: number; displayName?: string; productValue?: string; active?: boolean }
export function parseSaveProduct(raw: unknown): Parsed<SaveProductInput> {
  const b = asBody(raw);
  if (!b) return fail("body", "invalid_body");
  const rev = parseRevision(b.expected_revision);
  if (!rev.ok) return rev;
  const out: SaveProductInput = { expectedRevision: rev.value };
  if (has(b, "display_name")) { const n = parseDisplayName(b.display_name); if (!n.ok) return n; out.displayName = n.value; }
  if (has(b, "product_value")) { if (typeof b.product_value !== "string") return fail("product_value", "product_value_invalid"); out.productValue = b.product_value; }
  if (has(b, "active")) { if (typeof b.active !== "boolean") return fail("active", "active_invalid"); out.active = b.active; }
  if (out.displayName === undefined && out.productValue === undefined && out.active === undefined) return fail("body", "nothing_to_change");
  return { ok: true, value: out };
}

export type AddItemSource = { kind: "staged"; path: string } | { kind: "stored"; sha256: string };
export interface AddItemInput { expectedRevision: number; source: AddItemSource; label?: string; preDelaySeconds?: number }
export function parseAddItem(raw: unknown, accountId: string): Parsed<AddItemInput> {
  const b = asBody(raw);
  if (!b) return fail("body", "invalid_body");
  const rev = parseRevision(b.expected_revision);
  if (!rev.ok) return rev;
  // Only a file the SERVER verified can become an audio: a staged upload of this account, or a hash already stored for it. A URL is never accepted.
  for (const forbidden of ["url", "media_url", "voice_path", "path_url"]) if (has(b, forbidden)) return fail(forbidden, "url_not_accepted");
  const hasPath = has(b, "path"), hasSha = has(b, "sha256");
  if (hasPath === hasSha) return fail("path", "exactly_one_of_path_or_sha256");
  let source: AddItemSource;
  if (hasPath) {
    if (!isSafeStagingPath(accountId, b.path)) return fail("path", "invalid_path");
    source = { kind: "staged", path: b.path };
  } else {
    if (typeof b.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.sha256)) return fail("sha256", "invalid_hash");
    source = { kind: "stored", sha256: b.sha256 };
  }
  const out: AddItemInput = { expectedRevision: rev.value, source };
  if (has(b, "label")) { const l = parseLabel(b.label); if (!l.ok) return l; out.label = l.value; }
  if (has(b, "pre_delay_seconds")) { const p = parsePause(b.pre_delay_seconds); if (!p.ok) return p; out.preDelaySeconds = p.value; }
  return { ok: true, value: out };
}

export interface UpdateItemInput { expectedRevision: number; status?: "active" | "disabled"; preDelaySeconds?: number; label?: string; clearLabel?: boolean }
export function parseUpdateItem(raw: unknown): Parsed<UpdateItemInput> {
  const b = asBody(raw);
  if (!b) return fail("body", "invalid_body");
  const rev = parseRevision(b.expected_revision);
  if (!rev.ok) return rev;
  // The file of an item can never be changed; say so instead of ignoring it silently.
  for (const immutable of ["sha256", "voice_sha256", "voice_path", "url", "media_url", "path", "bytes", "duration_ms", "position"]) {
    if (has(b, immutable)) return fail(immutable, "field_not_editable");
  }
  const out: UpdateItemInput = { expectedRevision: rev.value };
  if (has(b, "status")) { if (b.status !== "active" && b.status !== "disabled") return fail("status", "status_invalid"); out.status = b.status; }
  if (has(b, "pre_delay_seconds")) { const p = parsePause(b.pre_delay_seconds); if (!p.ok) return p; out.preDelaySeconds = p.value; }
  if (has(b, "label")) { if (b.label === null) out.clearLabel = true; else { const l = parseLabel(b.label); if (!l.ok) return l; out.label = l.value; } }
  if (out.status === undefined && out.preDelaySeconds === undefined && out.label === undefined && !out.clearLabel) return fail("body", "nothing_to_change");
  return { ok: true, value: out };
}

export interface ReorderInput { expectedRevision: number; itemIds: string[] }
export function parseReorder(raw: unknown): Parsed<ReorderInput> {
  const b = asBody(raw);
  if (!b) return fail("body", "invalid_body");
  const rev = parseRevision(b.expected_revision);
  if (!rev.ok) return rev;
  const ids = b.item_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_ITEMS_PER_PRODUCT || !ids.every(isUuid)) return fail("item_ids", "item_ids_invalid");
  if (new Set(ids.map((i) => i.toLowerCase())).size !== ids.length) return fail("item_ids", "item_ids_repeated");
  return { ok: true, value: { expectedRevision: rev.value, itemIds: ids.map((i) => i.toLowerCase()) } };
}
