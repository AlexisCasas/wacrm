import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { isCustomConditionEnabledForAccount } from "@/lib/flows/custom-condition-capability";
import { isCompoundConditionEnabledForAccount } from "@/lib/flows/compound-condition-capability";
import { isSubflowAuthoringEnabledForAccount } from "@/lib/flows/subflow-authoring-capability";
import { isCustomerReplyConditionEnabledForAccount } from "@/lib/flows/customer-reply-condition";
import { isDurableWaitAuthoringEnabledForAccount } from "@/lib/flows/durable-wait-capability";
import { executionAllowedForAccount } from "@/lib/flows/execution-gates";
import { supabaseAdmin } from "@/lib/flows/admin-client";

/** A safe client-facing view of the server-enforced per-account capabilities (F04 and the subflow-authoring pilot). */
export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    // Can this account actually RUN the features (environment AND database)? The editor needs the truth to word its messages honestly.
    const run = async (kind: "subflow" | "durable_wait") => { try { return await executionAllowedForAccount(supabaseAdmin(), ctx.accountId, kind); } catch { return false; } };
    const [subflowExecution, durableWaitExecution] = await Promise.all([run("subflow"), run("durable_wait")]);
    return NextResponse.json(
      {
        customConditions: isCustomConditionEnabledForAccount(ctx.accountId),
        compoundConditions: isCompoundConditionEnabledForAccount(ctx.accountId),
        subflowAuthoring: isSubflowAuthoringEnabledForAccount(ctx.accountId),
        durableWaitAuthoring: isDurableWaitAuthoringEnabledForAccount(ctx.accountId),
        customerReplyCondition: isCustomerReplyConditionEnabledForAccount(ctx.accountId),
        subflowExecution,
        durableWaitExecution,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
