import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { isCustomConditionEnabledForAccount } from "@/lib/flows/custom-condition-capability";

/** A safe client-facing view of the server-enforced F04 capability. */
export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json(
      { customConditions: isCustomConditionEnabledForAccount(ctx.accountId) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
