// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account. Any member can call
// it (the Members tab is shown to admins+, but agents/viewers see
// a read-only roster too).
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only".
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { canManageMembers, isAccountRole } from "@/lib/auth/roles";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { isOperationalRole } from "@/lib/auth/operational-role";
import type { AccountMember } from "@/types";

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  account_role: string;
  operational_role?: string | null;
  created_at: string;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // PR-01 logistics: the account flag comes from the session's account (never from the browser). Fail-closed: any error / missing column
    // = OFF, in which case the query below is exactly the legacy one.
    const { data: flagRow } = await supabaseAdmin()
      .from("order_integration_settings")
      .select("logistics_mvp_enabled")
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    const operationalRolesEnabled = flagRow?.logistics_mvp_enabled === true;

    // RLS on profiles allows reading any row whose account matches
    // the caller's, so this query is naturally account-scoped.
    const { data, error } = await ctx.supabase
      .from("profiles")
      .select(
        operationalRolesEnabled
          ? "user_id, full_name, email, avatar_url, account_role, operational_role, created_at"
          : "user_id, full_name, email, avatar_url, account_role, created_at",
      )
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[GET /api/account/members] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }

    const canSeeEmails = canManageMembers(ctx.role);

    const members: AccountMember[] = (data as unknown as ProfileRow[]).flatMap((row) => {
      // Defensive: the DB enum should never let an unknown role
      // through, but if a migration ever broadens the enum without
      // updating TS, skip the row rather than crash the page.
      if (!isAccountRole(row.account_role)) return [];
      return [
        {
          user_id: row.user_id,
          full_name: row.full_name ?? "",
          email: canSeeEmails ? row.email : null,
          avatar_url: row.avatar_url,
          role: row.account_role,
          operational_role: operationalRolesEnabled && isOperationalRole(row.operational_role) ? row.operational_role : null,
          joined_at: row.created_at,
        },
      ];
    });

    return NextResponse.json({ members, operational_roles_enabled: operationalRolesEnabled });
  } catch (err) {
    return toErrorResponse(err);
  }
}
