import type { SupabaseClient } from "@supabase/supabase-js";
import { extractFepEvidence, type MetaStatusPricingFields } from "./fep-window";

/**
 * Keeps the free-entry-point evidence of a STATUS event (see fep-window.ts). Best effort: it never throws and the caller never depends on it, so a failure
 * here cannot stop the normal status handling. A failure is logged with a code only (never the payload). Scoped to the account of the signed payload
 * by the database function.
 */
export async function captureMessagePricing(
  db: Pick<SupabaseClient, "rpc">,
  accountId: string,
  status: MetaStatusPricingFields & { id?: unknown },
): Promise<"stored" | "ignored" | "unknown_message" | "error"> {
  try {
    if (typeof status.id !== "string" || !status.id) return "ignored";
    const evidence = extractFepEvidence(status);
    if (!evidence) return "ignored";
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
