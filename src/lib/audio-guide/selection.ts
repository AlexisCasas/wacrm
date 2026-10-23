/**
 * Purposes ("finalidades": Pago, Provincia, Promoción...) and identifiers ("identificadores": Principal, Alternativo...) of an account, and how
 * they classify the audios of a product (migration 076). Server-side only; same rules as the catalog: the account id is the session's and every
 * query repeats it, the service role never leaves the server, and every change goes through ONE database function that owns the invariants:
 *
 *   - the unique KEY of a name is its normalised form (accents, case and spacing ignored); the database refuses a second one (duplicate_name);
 *   - at most 50 purposes and 100 identifiers per account (limit_reached);
 *   - a name in use by an audio cannot be deleted (in_use); deactivating it is allowed and keeps the classified audios, but it cannot be newly
 *     assigned and a Flow that asks for it finds no audio;
 *   - audios are referenced by UUID, never by name.
 */

import { normalizeCatalogName } from "./normalize";
import { call, type CatalogDb, type CatalogResult } from "./catalog";

export type NameKind = "purpose" | "identifier";

const TABLE: Record<NameKind, string> = { purpose: "audio_guide_purposes", identifier: "audio_guide_identifiers" };
const ITEM_COLUMN: Record<NameKind, string> = { purpose: "purpose_id", identifier: "identifier_id" };
const SAVE_FN: Record<NameKind, string> = { purpose: "audio_guide_save_purpose", identifier: "audio_guide_save_identifier" };
const DELETE_FN: Record<NameKind, string> = { purpose: "audio_guide_delete_purpose", identifier: "audio_guide_delete_identifier" };

export const MAX_PURPOSES = 50;
export const MAX_IDENTIFIERS = 100;

export interface CatalogName { id: string; name: string; active: boolean; createdAt: string; updatedAt: string; /** audios classified with it */ inUse: number }

type Row = Record<string, unknown>;
const COLUMNS = "id, name, active, created_at, updated_at";
const nameOf = (r: Row, inUse: number): CatalogName => ({ id: r.id as string, name: r.name as string, active: r.active === true, createdAt: String(r.created_at), updatedAt: String(r.updated_at), inUse });
const failed = <T>(reason: "db_error" | "not_found" | "invalid_value"): CatalogResult<T> => ({ ok: false, reason });

/** Every purpose (or identifier) of the account, by name, with how many audios use each. */
export async function listNames(db: CatalogDb, accountId: string, kind: NameKind): Promise<CatalogResult<CatalogName[]>> {
  const { data, error } = await db.from(TABLE[kind]).select(COLUMNS).eq("account_id", accountId).order("name", { ascending: true }).limit(500);
  if (error) return failed("db_error");
  const rows = (data as Row[] | null) ?? [];
  if (rows.length === 0) return { ok: true, value: [] };
  const column = ITEM_COLUMN[kind];
  const { data: used, error: usedError } = await db.from("audio_guide_items").select(column).eq("account_id", accountId).in(column, rows.map((r) => r.id as string));
  if (usedError) return failed("db_error");
  const counts = new Map<string, number>();
  for (const u of (used as unknown as Row[] | null) ?? []) counts.set(u[column] as string, (counts.get(u[column] as string) ?? 0) + 1);
  return { ok: true, value: rows.map((r) => nameOf(r, counts.get(r.id as string) ?? 0)) };
}

async function getName(db: CatalogDb, accountId: string, kind: NameKind, id: string): Promise<CatalogResult<CatalogName>> {
  const { data, error } = await db.from(TABLE[kind]).select(COLUMNS).eq("id", id).eq("account_id", accountId).maybeSingle();
  if (error) return failed("db_error");
  if (!data) return failed("not_found");
  const { count, error: countError } = await db.from("audio_guide_items").select("id", { count: "exact", head: true }).eq("account_id", accountId).eq(ITEM_COLUMN[kind], id);
  if (countError) return failed("db_error");
  return { ok: true, value: nameOf(data as Row, count ?? 0) };
}

/** Creates a purpose / identifier. The name is normalised here (display name + unique key); the database function enforces uniqueness and the limits. */
export async function createName(db: CatalogDb, accountId: string, kind: NameKind, input: { name: unknown; active?: boolean }): Promise<CatalogResult<CatalogName>> {
  const n = normalizeCatalogName(input.name);
  if (!n.ok) return failed("invalid_value");
  const saved = await call(db, SAVE_FN[kind], { p_account: accountId, p_id: null, p_name: n.name, p_name_key: n.key, p_active: input.active ?? true }, (r) => ({ id: String(r.id) }));
  if (!saved.ok) return saved;
  return getName(db, accountId, kind, saved.value.id);
}

/** Renames and/or (de)activates. At least one of `name` / `active`; a rename that only changes case or accents is allowed (same key). */
export async function updateName(db: CatalogDb, accountId: string, kind: NameKind, id: string, input: { name?: unknown; active?: boolean }): Promise<CatalogResult<CatalogName>> {
  let name: string | null = null, key: string | null = null;
  if (input.name !== undefined) {
    const n = normalizeCatalogName(input.name);
    if (!n.ok) return failed("invalid_value");
    name = n.name; key = n.key;
  }
  const saved = await call(db, SAVE_FN[kind], { p_account: accountId, p_id: id, p_name: name, p_name_key: key, p_active: input.active ?? null }, (r) => ({ id: String(r.id) }));
  if (!saved.ok) return saved;
  return getName(db, accountId, kind, id);
}

/** Deletes one that no audio uses. In use -> `in_use` (the database's RESTRICT key decides, not a count read here). */
export const deleteName = (db: CatalogDb, accountId: string, kind: NameKind, id: string) =>
  call(db, DELETE_FN[kind], { p_account: accountId, p_id: id }, () => ({}));
