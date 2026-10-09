import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isCustomConditionEnabledForAccount } from "@/lib/flows/custom-condition-capability";
import { inspectDowngradeCompatibility } from "@/lib/flows/downgrade-compatibility";

/**
 * Read-only, account-scoped pre-downgrade inspection. It intentionally
 * returns ids and counts only; it never returns node configuration, values,
 * variables, contacts, or changes any flow/run state.
 */
export async function GET() {
  try {
    const ctx = await requireRole("admin");
    const { data: flows, error: flowError } = await ctx.supabase
      .from("flows")
      .select("id, status")
      .eq("account_id", ctx.accountId);
    if (flowError) return NextResponse.json({ error: "Could not inspect downgrade compatibility" }, { status: 503 });
    const ids = (flows ?? []).map((flow) => flow.id);
    if (!ids.length) return NextResponse.json({ customConditionsEnabled: isCustomConditionEnabledForAccount(ctx.accountId), ...inspectDowngradeCompatibility({ flows: [], nodes: [], runs: [] }) });
    const [{ data: nodes, error: nodeError }, { data: runs, error: runError }] = await Promise.all([
      ctx.supabase.from("flow_nodes").select("flow_id, node_type, config").in("flow_id", ids),
      ctx.supabase.from("flow_runs").select("flow_id, status").in("flow_id", ids),
    ]);
    if (nodeError || runError) return NextResponse.json({ error: "Could not inspect downgrade compatibility" }, { status: 503 });
    return NextResponse.json({
      customConditionsEnabled: isCustomConditionEnabledForAccount(ctx.accountId),
      ...inspectDowngradeCompatibility({ flows: flows ?? [], nodes: (nodes ?? []) as Array<{ flow_id: string; node_type: string; config: Record<string, unknown> }>, runs: runs ?? [] }),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
