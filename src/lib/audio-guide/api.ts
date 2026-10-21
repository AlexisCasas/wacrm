/**
 * Shared plumbing of the /api/audio-guide routes: who may call, which account, and how a catalog result becomes an HTTP answer.
 *
 *   - reads need an account member; writes need the `admin` role (owner included);
 *   - the account ALWAYS comes from the session, never from the path, query or body;
 *   - every route is closed unless the account is enabled for voice notes (FLOW_VOICE_NOTE_ACCOUNT_IDS), like the rest of the feature;
 *   - the service-role client is used only AFTER those checks, and every query it runs repeats the session's account id.
 */

import { NextResponse } from "next/server";

import { getCurrentAccount, requireRole, toErrorResponse, type AccountContext } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { isVoiceNoteEnabledForAccount } from "@/lib/flows/voice-note-capability";
import { isUuid } from "./input";
import type { CatalogDb, CatalogFailureReason, CatalogItem, CatalogProduct, CatalogProductDetail, CatalogProductSummary, CatalogResult } from "./catalog";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function guarded(
  mode: "read" | "write",
  run: (ctx: { account: AccountContext; db: CatalogDb }) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const account = mode === "write" ? await requireRole("admin") : await getCurrentAccount();
    if (!isVoiceNoteEnabledForAccount(account.accountId)) return json({ error: "voice_notes_disabled" }, 403);
    return await run({ account, db: supabaseAdmin() as unknown as CatalogDb });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** A path id that is not a UUID can never exist: answer like a missing row, without touching the database. */
export const notFound = () => json({ error: "not_found" }, 404);
export const validId = (id: string) => isUuid(id);

export function badRequest(field: string, error: string) {
  return json({ error, field }, 422);
}

const STATUS: Record<CatalogFailureReason, number> = {
  not_found: 404, revision_conflict: 409, duplicate_key: 409, conflict: 409,
  invalid_value: 422, limit_reached: 422, invalid_order: 422, file_not_stored: 422, file_rejected: 422,
  storage_error: 502, db_error: 500,
};

/** The HTTP answer for a refused catalog change. A conflict carries the current revision so the editor can reload. */
export function failure(result: Extract<CatalogResult<unknown>, { ok: false }>) {
  const body: Record<string, unknown> = { error: result.reason === "db_error" ? "internal_error" : result.reason };
  if (result.revision !== undefined) body.revision = result.revision;
  if (result.voiceNoteReason) body.reason = result.voiceNoteReason;
  return json(body, STATUS[result.reason]);
}

export const itemDto = (i: CatalogItem) => ({
  id: i.id, position: i.position, sha256: i.sha256, url: i.url, label: i.label, bytes: i.bytes,
  duration_ms: i.durationMs, pre_delay_seconds: i.preDelaySeconds, status: i.status,
});

const productFields = (p: CatalogProduct) => ({
  id: p.id, product_key: p.productKey, display_name: p.displayName, active: p.active, revision: p.revision,
  created_at: p.createdAt, updated_at: p.updatedAt,
});
export const productSummaryDto = (p: CatalogProductSummary) => ({ ...productFields(p), item_count: p.itemCount, active_item_count: p.activeItemCount });
export const productDetailDto = (p: CatalogProductDetail) => ({ ...productFields(p), items: p.items.map(itemDto) });
