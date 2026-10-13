import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { isCustomConditionEnabledForAccount } from '@/lib/flows/custom-condition-capability'
import { isSubflowAuthoringEnabledForAccount } from '@/lib/flows/subflow-authoring-capability'
import { isDurableWaitAuthoringEnabledForAccount } from '@/lib/flows/durable-wait-capability'
import { durableWaitSeconds, isDurableWaitConfig } from '@/lib/flows/durable-wait'
import { isCustomerActivityConfig, isCustomerReplyConditionEnabledForAccount } from '@/lib/flows/customer-reply-condition'
import { ConditionReferenceInfrastructureError, validateConditionReferences } from '@/lib/flows/condition-references'

/**
 * GET   /api/flows/[id]  — fetch one flow with its nodes.
 * PUT   /api/flows/[id]  — replace name/trigger/entry/fallback + the
 *                          full node graph in ONE database transaction
 *                          (replace_flow_draft_atomic, migration 067):
 *                          either the whole save is applied or nothing
 *                          changes. A draft may be incomplete; activation,
 *                          not saving, validates the graph.
 * DELETE /api/flows/[id] — hard delete (RLS+CASCADE clean up nodes,
 *                          runs, events).
 *
 * All three require a signed-in caller who owns the flow. Flows is in
 * soft-GA — the beta gate that previously 404'd non-beta accounts is
 * gone; the "Beta" label in the UI is the only remaining signal.
 */

async function requireOwnership(
  flowId: string,
): Promise<
  | {
      ok: true
      userId: string
      supabase: Awaited<ReturnType<typeof createClient>>
    }
  | { ok: false; status: number; body: { error: string } }
> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } }
  }
  // RLS scopes this to the caller — a flow owned by another user
  // returns null (404 below).
  const { data: flow } = await supabase
    .from('flows')
    .select('id')
    .eq('id', flowId)
    .maybeSingle()
  if (!flow) {
    return { ok: false, status: 404, body: { error: 'Not found' } }
  }
  return { ok: true, userId: user.id, supabase }
}

/**
 * Maps a failed atomic save to a response that explains what happened without echoing database text. In every case the
 * previous version of the flow is intact: the save is a single transaction.
 */
function saveFailure(code: string | undefined, message?: string) {
  console.error('[flows PUT] atomic save failed', code ?? 'no-code')
  switch (code) {
    case 'P0002':
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    case '22023':
      return NextResponse.json({ error: 'Invalid flow data. Nothing was saved.' }, { status: 400 })
    case '23503': // migration 068: execute_flow target is not a flow of this account
      return NextResponse.json({ error: 'A connected flow does not exist anymore or does not belong to this account. Nothing was saved.', code: 'invalid_subflow_target' }, { status: 422 })
    case '0A000': // migrations 068 / 069: execute_flow nodes and durable waits cannot live in an active flow
      return NextResponse.json({ error: /durable/i.test(message ?? '') ? 'Waits can only be added while the flow is a draft. Nothing was saved.' : 'Connected flows can only be edited while the flow is a draft. Nothing was saved.', code: /durable/i.test(message ?? '') ? 'durable_wait_requires_draft' : 'subflow_requires_draft' }, { status: 409 })
    case '23505': // duplicate node_key
    case '23514': // unknown node_type / bad trigger_type
    case '23502': // missing node_key / node_type
    case '22P02': // value of the wrong type
    case '22003': // number out of range
      return NextResponse.json({ error: 'The flow definition is not valid (for example a duplicated or unknown node). Nothing was saved.' }, { status: 422 })
    default:
      return NextResponse.json({ error: 'Could not save flow' }, { status: 500 })
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Checks every execute_flow target against the caller's OWN account. An empty target is fine (an unfinished draft);
 * a malformed id, the flow itself, or a flow that is missing / deleted / in another account is reported per node.
 * Returns null when the lookup itself failed (the caller must not save on an unverified reference).
 */
async function subflowTargetIssues(
  admin: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  flowId: string,
  nodes: Array<{ node_key: string; config: Record<string, unknown> }>,
): Promise<Array<{ node_key: string; issue: 'invalid_target' | 'target_is_self' | 'target_not_found' }> | null> {
  const issues: Array<{ node_key: string; issue: 'invalid_target' | 'target_is_self' | 'target_not_found' }> = []
  const wanted = new Map<string, string[]>()
  for (const node of nodes) {
    const raw = (node.config ?? {}).target_flow_id
    if (raw === undefined || raw === null || raw === '') continue
    if (typeof raw !== 'string' || !UUID_RE.test(raw)) { issues.push({ node_key: node.node_key, issue: 'invalid_target' }); continue }
    if (raw.toLowerCase() === flowId.toLowerCase()) { issues.push({ node_key: node.node_key, issue: 'target_is_self' }); continue }
    wanted.set(raw.toLowerCase(), [...(wanted.get(raw.toLowerCase()) ?? []), node.node_key])
  }
  if (wanted.size) {
    const { data, error } = await admin.from('flows').select('id').eq('account_id', accountId).in('id', [...wanted.keys()])
    if (error) return null
    const found = new Set((data ?? []).map((row: { id: string }) => row.id.toLowerCase()))
    for (const [target, keys] of wanted) if (!found.has(target)) for (const key of keys) issues.push({ node_key: key, issue: 'target_not_found' })
  }
  return issues
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const guard = await requireOwnership(id)
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status })
  const { supabase } = guard

  const [{ data: flow }, { data: nodes }] = await Promise.all([
    supabase.from('flows').select('*').eq('id', id).maybeSingle(),
    supabase
      .from('flow_nodes')
      .select('*')
      .eq('flow_id', id)
      .order('created_at', { ascending: true }),
  ])
  if (!flow) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json({ flow, nodes: nodes ?? [] })
}

interface PutBody {
  name?: string
  description?: string | null
  trigger_type?: 'keyword' | 'first_inbound_message' | 'manual'
  trigger_config?: Record<string, unknown>
  entry_node_id?: string | null
  fallback_policy?: Record<string, unknown>
  nodes?: Array<{
    node_key: string
    node_type: string
    config: Record<string, unknown>
    position_x?: number
    position_y?: number
  }>
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params

  // Writes require at least `agent` — the RLS flows_update policy demands
  // it, but this route mutates via the service-role client which bypasses
  // RLS, so the role must be enforced here (a viewer passes ownership).
  try {
    const account = await requireRole('agent')
    const guard = await requireOwnership(id)
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status })

    const body = (await request.json().catch(() => null)) as PutBody | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    if (body.name !== undefined && !body.name.trim()) {
      return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    }
    if (body.nodes !== undefined && !Array.isArray(body.nodes)) {
      return NextResponse.json({ error: 'nodes must be an array' }, { status: 400 })
    }

    const admin = supabaseAdmin()
    // Validate ALL external references before anything is written, so an invalid request never reaches the database.
    if (body.nodes !== undefined) {
      const capabilityEnabled = isCustomConditionEnabledForAccount(account.accountId)
      const { data: currentNodes, error: currentNodesError } = !capabilityEnabled
        ? await admin.from('flow_nodes').select('node_key, node_type, config').eq('flow_id', id)
        : { data: [], error: null }
      if (currentNodesError) return NextResponse.json({ error: 'Could not validate condition references' }, { status: 503 })
      const existingCustom = new Set((currentNodes ?? []).filter((node) => node.node_type === 'condition' && (node.config as Record<string, unknown>).subject === 'contact_field' && typeof (node.config as Record<string, unknown>).subject_key === 'string').map((node) => `${node.node_key}:${(node.config as Record<string, unknown>).subject_key}`))
      const issues = (await validateConditionReferences(
        account.supabase,
        account.accountId,
        body.nodes,
        capabilityEnabled,
      )).filter((issue) => issue.issue !== 'custom_condition_capability_disabled' || !existingCustom.has(`${issue.node_key}:${(body.nodes ?? []).find((node) => node.node_key === issue.node_key)?.config.subject_key}`))
      if (issues.length) return NextResponse.json({ error: 'Invalid condition reference', issues }, { status: 422 })
    }

    // "Run another flow" nodes (pilot): only accounts opted in on the server may write them, and every target must be
    // an existing flow of the caller's own account (never the flow itself). Migration 068 enforces the same in SQL.
    const subflowNodes = (body.nodes ?? []).filter((n) => n.node_type === 'execute_flow')
    if (subflowNodes.length) {
      if (!isSubflowAuthoringEnabledForAccount(account.accountId)) {
        return NextResponse.json({ error: 'Connecting flows is not enabled for this account.', code: 'subflow_authoring_disabled' }, { status: 403 })
      }
      // P8 settings of the call: the reference must be a send step of THIS payload, the reply policy one of two values.
      const sendKeys = new Set((body.nodes ?? []).filter((n) => n.node_type === 'send_message' || n.node_type === 'send_media').map((n) => n.node_key))
      const badSettings = subflowNodes.flatMap((n) => {
        const c = n.config as { reference_node_key?: unknown; on_customer_reply?: unknown }
        const issues: Array<{ node_key: string; issue: string }> = []
        if (c.reference_node_key !== undefined && (typeof c.reference_node_key !== 'string' || !sendKeys.has(c.reference_node_key))) issues.push({ node_key: n.node_key, issue: 'invalid_reference_node' })
        if (c.on_customer_reply !== undefined && c.on_customer_reply !== 'stop' && c.on_customer_reply !== 'continue') issues.push({ node_key: n.node_key, issue: 'invalid_on_customer_reply' })
        return issues
      })
      if (badSettings.length) return NextResponse.json({ error: 'A call setting is not valid. Nothing was saved.', code: 'invalid_subflow_settings', issues: badSettings }, { status: 422 })
      const subflowIssues = await subflowTargetIssues(admin, account.accountId, id, subflowNodes)
      if (subflowIssues === null) return NextResponse.json({ error: 'Could not validate the connected flows' }, { status: 503 })
      if (subflowIssues.length) {
        return NextResponse.json({ error: 'A connected flow does not exist anymore or does not belong to this account. Nothing was saved.', code: 'invalid_subflow_target', issues: subflowIssues }, { status: 422 })
      }
    }

    // Durable waits (delay nodes with a unit): only accounts opted in on the server may write them, and each one must be
    // well formed. Legacy delays (seconds only) are untouched. Migration 069 enforces the same shape in SQL.
    const durableNodes = (body.nodes ?? []).filter((n) => n.node_type === 'delay' && isDurableWaitConfig(n.config))
    if (durableNodes.length) {
      if (!isDurableWaitAuthoringEnabledForAccount(account.accountId)) {
        return NextResponse.json({ error: 'Durable waits are not enabled for this account.', code: 'durable_wait_authoring_disabled' }, { status: 403 })
      }
      const badWaits = durableNodes.flatMap((n) => { const w = durableWaitSeconds(n.config); return w.ok ? [] : [{ node_key: n.node_key, issue: w.reason }] })
      if (badWaits.length) {
        return NextResponse.json({ error: 'A wait is not valid (whole amount of at least 1 second, at most 30 days). Nothing was saved.', code: 'invalid_durable_wait', issues: badWaits }, { status: 422 })
      }
    }

    // End scope (P8): "run" (default) or "subflow". Anything else is refused before anything is written.
    const badEnds = (body.nodes ?? []).filter((n) => n.node_type === 'end' && (n.config as { scope?: unknown })?.scope !== undefined && !['run', 'subflow'].includes(String((n.config as { scope?: unknown }).scope)))
    if (badEnds.length) return NextResponse.json({ error: 'An End step has an invalid scope. Nothing was saved.', code: 'invalid_end_scope', issues: badEnds.map((n) => ({ node_key: n.node_key })) }, { status: 422 })

    // Customer-activity conditions (P7): only accounts opted in on the server may write them. Drafts only: activation is
    // blocked by the validator (and the engine fails closed at run time), so saving one never runs anything.
    if ((body.nodes ?? []).some((n) => n.node_type === 'condition' && isCustomerActivityConfig(n.config)) && !isCustomerReplyConditionEnabledForAccount(account.accountId)) {
      return NextResponse.json({ error: 'The customer-activity condition is not enabled for this account.', code: 'customer_reply_condition_disabled' }, { status: 403 })
    }

    // Only the fields the client sent are patched: a header-only save (no `nodes`) leaves the graph alone.
    const flowPatch: Record<string, unknown> = {}
    if (body.name !== undefined) flowPatch.name = body.name.trim()
    if (body.description !== undefined) flowPatch.description = body.description
    if (body.trigger_type !== undefined) flowPatch.trigger_type = body.trigger_type
    if (body.trigger_config !== undefined) flowPatch.trigger_config = body.trigger_config
    if (body.entry_node_id !== undefined) flowPatch.entry_node_id = body.entry_node_id
    if (body.fallback_policy !== undefined) flowPatch.fallback_policy = body.fallback_policy

    // ONE call = ONE transaction. The account comes from the authenticated session (requireRole), never from the
    // request body, and the function only writes a flow that belongs to it.
    const { error: saveErr } = await admin.rpc('replace_flow_draft_atomic', {
      p_account_id: account.accountId,
      p_flow_id: id,
      p_patch: flowPatch,
      p_nodes: body.nodes === undefined ? null : body.nodes.map((n) => ({ node_key: n.node_key, node_type: n.node_type, config: n.config, position_x: n.position_x ?? 0, position_y: n.position_y ?? 0 })),
    })
    if (saveErr) return saveFailure(saveErr.code, saveErr.message)
    const [{ data: flow }, { data: nodes }] = await Promise.all([
      admin.from('flows').select('*').eq('id', id).maybeSingle(),
      admin.from('flow_nodes').select('*').eq('flow_id', id).order('created_at', { ascending: true }),
    ])
    return NextResponse.json({ flow, nodes: nodes ?? [] })
  } catch (err) {
    if (err instanceof ConditionReferenceInfrastructureError) {
      return NextResponse.json({ error: 'Could not validate condition references' }, { status: 503 })
    }
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params

  // Writes require at least `agent` — see the PUT handler note. The
  // service-role client below bypasses the agent-gated flows_delete RLS.
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const guard = await requireOwnership(id)
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status })

  // CASCADE on flow_nodes / flow_runs / flow_run_events handles the
  // children. Active runs end abruptly — there's no graceful "drain"
  // mechanism in v1, but that's intentional: deleting a flow is a
  // deliberate destructive action and the partial unique index will
  // free up the contact for new triggers immediately.
  const { error } = await supabaseAdmin().from('flows').delete().eq('id', id)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

