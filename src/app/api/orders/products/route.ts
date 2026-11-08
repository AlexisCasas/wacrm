import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** Optional commercial picker backed by the account's existing product names.
 * It is independent of the separate voice-note feature gate. Products carry
 * no catalog prices: the agent always enters the unit price manually.
 * The caller cannot choose an account ID. The backend and RPC both enforce
 * that only enabled accounts may use structured order items. */
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole("agent");
    const admin = supabaseAdmin();
    const { data: settings, error: settingsError } = await admin
      .from("order_integration_settings")
      .select("confirm_enabled, multiproduct_enabled, product_tags_required")
      .eq("account_id", accountId)
      .maybeSingle();

    if (settingsError) return NextResponse.json({ error: "catalog_unavailable" }, { status: 500, headers: NO_STORE });
    if (!settings?.confirm_enabled || (!settings.multiproduct_enabled && !settings.product_tags_required))
      return NextResponse.json({ error: "multiproduct_disabled" }, { status: 403, headers: NO_STORE });

    // PostgREST treats '*' as an ILIKE wildcard even though PostgreSQL uses '%'.
    // Drop asterisks before constructing the LIKE pattern; preserve tenant scoping.
    const q = (new URL(request.url).searchParams.get("q") ?? "").replace(/\*/g, "").trim();
    if (q.length < 2 || q.length > 120)
      return NextResponse.json({ products: [] }, { headers: NO_STORE });

    const literal = q.replace(/[\\%_]/g, (char) => "\\" + char);

    // In strict mode the catalogue is an explicit commercial subset of tags:
    // operational statuses (Avisados, En destino, etc.) never appear by default.
    if (settings.product_tags_required === true) {
      const { data: tags, error: tagsError } = await admin
        .from("tags")
        .select("id, name")
        .eq("account_id", accountId)
        .eq("is_order_product", true)
        .ilike("name", "%" + literal + "%")
        .order("name")
        .limit(20);
      if (tagsError) return NextResponse.json({ error: "catalog_unavailable" }, { status: 500, headers: NO_STORE });
      return NextResponse.json({
        products: (tags ?? []).map((tag) => ({ id: tag.id, display_name: tag.name, active: true })),
      }, { headers: NO_STORE });
    }

    // Product names live in the per-account audio_guide_products catalog. This
    // endpoint does NOT require voice-note functionality to be switched on.
    // Escaping search wildcards avoids unintended broad matches.
    const { data, error } = await admin
      .from("audio_guide_products")
      .select("id, display_name, active")
      .eq("account_id", accountId)
      .eq("active", true)
      .ilike("display_name", "%" + literal + "%")
      .order("display_name")
      .limit(10);

    if (error) return NextResponse.json({ error: "catalog_unavailable" }, { status: 500, headers: NO_STORE });
    return NextResponse.json({ products: data ?? [] }, { headers: NO_STORE });
  } catch (error) {
    return toErrorResponse(error);
  }
}
