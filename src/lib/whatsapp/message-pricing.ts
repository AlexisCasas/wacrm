import type { SupabaseClient } from "@supabase/supabase-js";
import { extractFepEvidence, FEP_PRICING_TYPE, type MetaStatusPricingFields } from "./fep-window";

/**
 * Keeps the free-entry-point evidence of a STATUS event (see fep-window.ts). Best effort: it never throws and the caller never depends on it, so a failure
 * here cannot stop the normal status handling. A failure is logged with a code only (never the payload). Scoped to the account of the signed payload
 * by the database function.
 */
export async function captureMessagePricing(
  db: Pick<SupabaseClient, "rpc">,
  accountId: string,
  status: MetaStatusPricingFields & { id?: unknown; status?: unknown },
): Promise<"stored" | "ignored" | "unknown_message" | "error"> {
  try {
    if (typeof status.id !== "string" || !status.id) return "ignored";
    const evidence = extractFepEvidence(status);
    if (!evidence) return "ignored";
    if (evidence.pricingType === FEP_PRICING_TYPE) logFepStructure(status, evidence.expiresAt !== null);
    const { data, error } = await db.rpc("record_whatsapp_message_pricing", {
      p_account_id: accountId,
      p_wamid: status.id,
      p_type: evidence.pricingType,
      p_category: evidence.pricingCategory,
      p_expiration: evidence.expiresAt ? evidence.expiresAt.toISOString() : null,
    });
    if (error) {
      console.error("[webhook] message pricing not stored:", error.code ?? "error");
      return "error";
    }
    return data === false ? "unknown_message" : "stored";
  } catch {
    console.error("[webhook] message pricing not stored: exception");
    return "error";
  }
}

const token = (v: unknown): string | null => (typeof v === "string" && /^[a-z_]{1,40}$/.test(v) ? v : null);

/**
 * Structure only, to learn what Meta really sends with a free_entry_point status (does `conversation.expiration_timestamp` come along, with which
 * `origin.type`?): presence flags and documented enum values, never the message id, a phone, a text, a timestamp or any other value.
 */
function logFepStructure(status: MetaStatusPricingFields & { status?: unknown }, expirationStored: boolean): void {
  const c = status.conversation;
  console.info("[webhook] free_entry_point status structure", {
    status: token(status.status),
    has_conversation: !!c,
    has_expiration_timestamp: c?.expiration_timestamp != null,
    conversation_origin_type: token(c?.origin?.type),
    expiration_stored: expirationStored,
  });
}
