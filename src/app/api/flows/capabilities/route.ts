import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { isCustomConditionEnabledForAccount } from "@/lib/flows/custom-condition-capability";
import { isSubflowAuthoringEnabledForAccount } from "@/lib/flows/subflow-authoring-capability";

/** A safe client-facing view of the server-enforced per-account capabilities (F04 and the subflow-authoring pilot). */
export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json(
      {
        customConditions: isCustomConditionEnabledForAccount(ctx.accountId),
        subflowAuthoring: isSubflowAuthoringEnabledForAccount(ctx.accountId),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
