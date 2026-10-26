import { NextResponse, type NextRequest } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { buildCatalog, flowVarKeys } from "@/lib/variables";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/variables[?flow_id=<uuid>] — what the "Insert variable" picker offers: contact fields, the account's custom fields (stable token
 * plus friendly alias) and, for a flow, the variables its collect_input nodes capture. Runs with the CALLER's session (RLS) and filters by the
 * caller's account as well; no service-role access.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireRole("viewer");
    const { data: fields, error } = await ctx.supabase
      .from("custom_fields")
      .select("id, field_name, field_type")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true });
    if (error) return NextResponse.json({ error: "Could not load custom fields" }, { status: 503 });

    let keys: string[] = ["contact_name"];
    const flowId = req.nextUrl.searchParams.get("flow_id");
    if (flowId) {
      if (!UUID.test(flowId)) return NextResponse.json({ error: "Invalid flow_id" }, { status: 400 });
      const { data: flow } = await ctx.supabase.from("flows").select("id").eq("id", flowId).eq("account_id", ctx.accountId).maybeSingle();
      if (!flow) return NextResponse.json({ error: "Flow not found" }, { status: 404 });
      const { data: nodes } = await ctx.supabase.from("flow_nodes").select("node_type, config").eq("flow_id", flowId);
      keys = flowVarKeys(nodes ?? []);
    }
    return NextResponse.json({ variables: buildCatalog(fields ?? [], keys) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
