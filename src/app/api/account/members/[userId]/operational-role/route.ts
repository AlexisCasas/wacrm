// ============================================================
// PATCH /api/account/members/[userId]/operational-role   Any signed-in member; the RPC decides.
//
// Sets a member's operational area (commercial | logistics | supervisor | null). Deliberately separate from the account_role endpoint: it never
// touches account_role. This route only authenticates, validates the payload (UUID + enum | null) and forwards to the SECURITY DEFINER RPC
// `set_member_operational_role` (migrations 20261121000000 + 20261126000000), which is the single authority: owner/admin may assign any area;
// an operational supervisor (who is not owner/admin) may assign commercial/logistics/NULL to non-supervisors only; everyone else is rejected;
// same account is always enforced there (the logistics_mvp_enabled gate was removed by 20261205000000 so areas can be assigned BEFORE activation). No account_id / role is ever read from the browser.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { isOperationalRole } from "@/lib/auth/operational-role";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    // No role gate here on purpose: an operational supervisor can be a plain `agent`. The RPC authorizes (and fails closed with 42501).
    const ctx = await getCurrentAccount();

    const limit = checkRateLimit(`admin:memberOperationalRole:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;
    if (!UUID.test(userId)) {
      return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
    }

    const body = (await request.json().catch(() => null)) as { operational_role?: unknown } | null;
    const value = body?.operational_role;
    if (value !== null && !isOperationalRole(value)) {
      return NextResponse.json(
        { error: "'operational_role' must be one of commercial, logistics, supervisor or null" },
        { status: 400 },
      );
    }

    const { error } = await ctx.supabase.rpc("set_member_operational_role", {
      p_user_id: userId,
      p_operational_role: value,
    });

    if (error) {
      if (error.code === "42501") return NextResponse.json({ error: error.message }, { status: 403 });
      if (error.code === "22023") return NextResponse.json({ error: error.message }, { status: 400 });
      console.error("[operational-role route] unexpected RPC error:", error.code);
      return NextResponse.json({ error: "Failed to update operational role" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, operational_role: value });
  } catch (err) {
    return toErrorResponse(err);
  }
}
