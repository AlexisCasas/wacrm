import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeAdReferral } from "./ad-referral";

/**
 * Stores the ad a contact came from, FIRST ATTRIBUTION WINS: contact_ad_attributions has one row per contact and the insert is ON CONFLICT DO NOTHING, so a
 * later message (with no referral, or with another ad) can never replace it. Best effort: it never throws and never blocks message processing; a failure
 * is logged with a code only (never the payload).
 */
export async function captureAdAttribution(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; referral: unknown },
): Promise<"stored" | "ignored" | "error"> {
  const ad = normalizeAdReferral(args.referral);
  if (!ad) return "ignored";
  try {
    const { error } = await db
      .from("contact_ad_attributions")
      .upsert({ contact_id: args.contactId, account_id: args.accountId, ...ad }, { onConflict: "contact_id", ignoreDuplicates: true });
    if (error) {
      console.error("[webhook] ad attribution not stored:", error.code ?? "error");
      return "error";
    }
    return "stored";
  } catch {
    console.error("[webhook] ad attribution not stored: exception");
    return "error";
  }
}
