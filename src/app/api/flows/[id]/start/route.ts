import { NextResponse } from "next/server"
import { differenceInHours } from "date-fns"
import { requireRole, toErrorResponse } from "@/lib/auth/account"
import { startFlowManually } from "@/lib/flows/engine"

/**
 * POST /api/flows/[id]/start — "Iniciar Flow" from the Inbox.
 *
 * Body: { conversation_id: string }
 *
 * Any `status=active` flow is startable here regardless of
 * `trigger_type` (keyword / manual / first_inbound_message) — an agent
 * picking the flow explicitly is exactly what the `manual` trigger
 * type exists for, but it's deliberately not the ONLY type allowed:
 * a customer who types something that doesn't match a keyword trigger
 * still needs the agent to be able to start that same commercial flow
 * by hand. Only `draft`/`archived` are rejected.
 *
 * `account_id` is never accepted from the browser — resolved from the
 * session. The 24-hour WhatsApp service-window check lives here (not
 * in the engine) since it's a `messages` table concern, not a flow
 * concern; `startFlowManually` owns flow/conversation/contact tenancy
 * and the active-run conflict check.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: flowId } = await context.params

  let accountId: string
  let userId: string
  let supabase: Awaited<ReturnType<typeof requireRole>>["supabase"]
  try {
    const ctx = await requireRole("agent")
    accountId = ctx.accountId
    userId = ctx.userId
    supabase = ctx.supabase
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = (await request.json().catch(() => null)) as
    | { conversation_id?: string }
    | null
  const conversationId = body?.conversation_id
  if (!conversationId || typeof conversationId !== "string") {
    return NextResponse.json(
      { error: "conversation_id is required", code: "missing_conversation_id" },
      { status: 400 },
    )
  }

  // Account-scoped existence check, via the caller's RLS-scoped client —
  // needed before we can safely query `messages` for this conversation
  // below (never run the 24h lookup against an unverified conversation
  // id, even though startFlowManually re-checks this independently).
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("account_id", accountId)
    .maybeSingle()
  if (!conversation) {
    return NextResponse.json(
      { error: "Conversation not found", code: "conversation_not_found" },
      { status: 404 },
    )
  }

  // 24-hour WhatsApp service window — server-side, never trust the
  // frontend's visual countdown alone. No inbound customer message at
  // all, or the last one is >=24h old, both refuse the start.
  const { data: lastCustomerMessage } = await supabase
    .from("messages")
    .select("created_at")
    .eq("conversation_id", conversationId)
    .eq("sender_type", "customer")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!lastCustomerMessage) {
    return NextResponse.json(
      {
        error: "No customer message found for this conversation",
        code: "service_window_expired",
      },
      { status: 409 },
    )
  }
  const hoursSince = differenceInHours(
    new Date(),
    new Date(lastCustomerMessage.created_at as string),
  )
  if (hoursSince >= 24) {
    return NextResponse.json(
      {
        error: "The 24-hour WhatsApp service window has expired",
        code: "service_window_expired",
      },
      { status: 409 },
    )
  }

  const result = await startFlowManually({
    accountId,
    initiatedByUserId: userId,
    flowId,
    conversationId,
  })

  switch (result.outcome) {
    case "started":
      return NextResponse.json(
        {
          success: true,
          flow_run_id: result.flow_run_id,
          flow_id: result.flow_id,
          flow_name: result.flow_name,
        },
        { status: 201 },
      )
    case "flow_not_found":
      return NextResponse.json(
        { error: "Flow not found", code: "flow_not_found" },
        { status: 404 },
      )
    case "flow_not_active":
      return NextResponse.json(
        { error: "Flow is not active", code: "flow_not_active" },
        { status: 409 },
      )
    case "conversation_not_found":
      return NextResponse.json(
        { error: "Conversation not found", code: "conversation_not_found" },
        { status: 404 },
      )
    case "contact_not_found":
      return NextResponse.json(
        { error: "Contact not found", code: "contact_not_found" },
        { status: 404 },
      )
    case "contact_blocked":
      return NextResponse.json(
        { error: "This contact is blocked", code: "contact_blocked" },
        { status: 409 },
      )
    case "active_flow_exists":
      return NextResponse.json(
        {
          error: "This contact already has an active flow",
          code: "active_flow_exists",
          active_flow_run_id: result.active_flow_run_id,
          active_flow_id: result.active_flow_id,
          active_flow_name: result.active_flow_name,
        },
        { status: 409 },
      )
    case "error":
    default:
      console.error("[flows] start route error:", result.outcome === "error" ? result.message : "unknown")
      return NextResponse.json(
        { error: "Failed to start flow", code: "internal_error" },
        { status: 500 },
      )
  }
}
