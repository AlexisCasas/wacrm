import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isMediaAudioEnabledForAccount, isVoiceNoteEnabledForAccount } from '@/lib/flows/voice-note-capability'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { validateFlowForActivation } from '@/lib/flows/validate'
import { isCustomConditionEnabledForAccount } from '@/lib/flows/custom-condition-capability'
import { executionAllowedForAccount } from '@/lib/flows/execution-gates'
import { isDurableWaitConfig } from '@/lib/flows/durable-wait'
import { isCustomerActivityConfig, isCustomerReplyConditionEnabledForAccount } from '@/lib/flows/customer-reply-condition'
import { analyzeCallGraph, isSubflowExecutionAllowed, type AccountFlowInfo } from '@/lib/flows/subflow-activation'
import { ConditionReferenceInfrastructureError, validateConditionReferences } from '@/lib/flows/condition-references'

// Pilot: flows that run another flow can be authored as drafts but NOT activated until subflow execution exists.
const CUSTOMER_REPLY_DISABLED = { error: 'This flow contains a customer-activity condition, which is not enabled for this account, so it can only be kept as a draft.', code: 'customer_reply_condition_disabled' }
const DURABLE_WAIT_EXECUTION_DISABLED = { error: 'This flow contains a wait. Running waits is not enabled for this account yet, so it can only be kept as a draft.', code: 'durable_wait_execution_disabled' }
const SUBFLOW_EXECUTION_DISABLED = { error: 'This flow runs another flow. Running connected flows is not enabled yet, so it can only be kept as a draft.', code: 'subflow_execution_disabled' }

/**
 * POST /api/flows/[id]/activate
 *
 * Body: { status: 'draft' | 'active' | 'archived' }
 *
 * Activating runs the full validator and refuses on any 'error'
 * severity issue. Drafts and archives are unconditional — users
 * need to be able to save broken-work-in-progress and pause flows
 * without first fixing them.
 *
 * Returns the updated flow on success; on validation failure returns
 * the full issue list so the builder can highlight each problem.
 */

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params

  // Changing status (activate / draft / archive) is a write — the RLS
  // flows_update policy requires `agent`, but the service-role client
  // below bypasses RLS, so enforce the role here (a viewer passes the
  // membership-only ownership check).
  try {
    const account = await requireRole('agent')

    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => null)) as { status?: 'draft' | 'active' | 'archived' } | null
    const status = body?.status
    if (!status || !['draft', 'active', 'archived'].includes(status)) return NextResponse.json({ error: "status must be one of 'draft' | 'active' | 'archived'" }, { status: 400 })
    const { data: existing } = await supabase.from('flows').select('id').eq('id', id).maybeSingle()
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const admin = supabaseAdmin()
    if (status === 'active') {
      const [{ data: flow, error: flowError }, { data: nodes, error: nodesError }] = await Promise.all([
        admin.from('flows').select('name, trigger_type, trigger_config, entry_node_id').eq('id', id).maybeSingle(),
        admin.from('flow_nodes').select('node_key, node_type, config').eq('flow_id', id),
      ])
      if (flowError || nodesError) return NextResponse.json({ error: 'Could not validate condition references' }, { status: 503 })
      if (!flow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      const callNodes = (nodes ?? []).filter((node) => node.node_type === 'execute_flow')
      let subflowAllowed = false
      if (callNodes.length) {
        // Running other flows needs BOTH the server flag and the account's row in flow_execution_enablement (fail closed otherwise).
        subflowAllowed = await isSubflowExecutionAllowed(admin, account.accountId)
        if (!subflowAllowed) return NextResponse.json(SUBFLOW_EXECUTION_DISABLED, { status: 409 })
      }
      const durableEnabled = await executionAllowedForAccount(admin, account.accountId, 'durable_wait')
      if (!durableEnabled && (nodes ?? []).some((node) => node.node_type === 'delay' && isDurableWaitConfig(node.config))) return NextResponse.json(DURABLE_WAIT_EXECUTION_DISABLED, { status: 409 })
      if ((nodes ?? []).some((node) => node.node_type === 'condition' && isCustomerActivityConfig(node.config)) && !isCustomerReplyConditionEnabledForAccount(account.accountId)) return NextResponse.json(CUSTOMER_REPLY_DISABLED, { status: 409 })
      const callGraphIssues = callNodes.length ? await callGraphIssuesFor(admin, account.accountId, id, callNodes as Array<{ node_key: string; config: Record<string, unknown> }>) : []
      if (callGraphIssues === null) return NextResponse.json({ error: 'Could not validate the connected flows' }, { status: 503 })
      const issues = validateFlowForActivation(flow as { name: string; trigger_type: 'keyword' | 'first_inbound_message' | 'manual'; trigger_config: Record<string, unknown>; entry_node_id: string | null }, (nodes ?? []) as Array<{ node_key: string; node_type: string; config: Record<string, unknown> }>, { accountId: account.accountId, voiceNoteEnabled: isVoiceNoteEnabledForAccount(account.accountId), mediaAudioEnabled: isMediaAudioEnabledForAccount(account.accountId), durableWaitExecution: durableEnabled, subflowExecution: subflowAllowed })
      // "Audios por producto": the gate tag must be one of THIS account's tags (the runtime also fails closed on it).
      const gateTags = (nodes ?? []).filter((node) => node.node_type === 'send_product_audios').map((node) => ({ key: node.node_key as string, tag: (node.config as { gate_tag_id?: unknown } | null)?.gate_tag_id })).filter((g) => typeof g.tag === 'string' && g.tag)
      if (gateTags.length) {
        const { data: ownTags, error: tagsError } = await admin.from('tags').select('id').eq('account_id', account.accountId).in('id', gateTags.map((g) => g.tag as string))
        if (tagsError) return NextResponse.json({ error: 'Could not validate the gate tag' }, { status: 503 })
        const known = new Set((ownTags ?? []).map((t: { id: string }) => t.id))
        for (const g of gateTags) if (!known.has(g.tag as string)) issues.push({ severity: 'error', scope: 'node', node_key: g.key, field: 'gate_tag_id', code: 'product_audios_gate_unknown', message: 'The gate tag does not exist in this account.' })
      }
      for (const issue of callGraphIssues) issues.push({ severity: issue.severity, scope: 'node', node_key: issue.node_key, field: 'target_flow_id', code: `execute_flow_${issue.code}`, ...(issue.params ? { params: issue.params } : {}), message: issue.message })
      const referenceIssues = await validateConditionReferences(account.supabase, account.accountId, (nodes ?? []) as Array<{ node_key: string; node_type: string; config: Record<string, unknown> }>, isCustomConditionEnabledForAccount(account.accountId))
      for (const issue of referenceIssues) issues.push({ severity: 'error', scope: 'node', node_key: issue.node_key, field: 'subject_key', message: issue.issue })
      if (issues.some((issue) => issue.severity === 'error')) return NextResponse.json({ error: 'Cannot activate flow — fix the issues below first.', issues }, { status: 422 })
    }
    const { data: updated, error } = await admin.from('flows').update({ status, updated_at: new Date().toISOString() }).eq('id', id).select().maybeSingle()
    // 0A000 = migration 068's database guard (covers a node added between the check above and this update)
    if (error) return error.code === '0A000' ? NextResponse.json(/durable/i.test(error.message ?? '') ? DURABLE_WAIT_EXECUTION_DISABLED : SUBFLOW_EXECUTION_DISABLED, { status: 409 }) : NextResponse.json({ error: 'Could not update flow' }, { status: 500 })
    return NextResponse.json({ flow: updated })
  } catch (err) {
    if (err instanceof ConditionReferenceInfrastructureError) return NextResponse.json({ error: 'Could not validate condition references' }, { status: 503 })
    return toErrorResponse(err)
  }
}

/** Every flow of the account with the calls it makes: enough for the cycle / depth / return checks. null = could not read (fail closed). */
async function callGraphIssuesFor(admin: ReturnType<typeof supabaseAdmin>, accountId: string, flowId: string, callNodes: Array<{ node_key: string; config: Record<string, unknown> }>) {
  const { data: flows, error: flowsError } = await admin.from('flows').select('id, status').eq('account_id', accountId)
  if (flowsError) return null
  const ids = (flows ?? []).map((f: { id: string }) => f.id)
  const { data: rows, error: nodesError } = ids.length
    ? await admin.from('flow_nodes').select('flow_id, node_type, config, node_key').in('flow_id', ids).in('node_type', ['execute_flow', 'end'])
    : { data: [], error: null }
  if (nodesError) return null
  const info = new Map<string, AccountFlowInfo>()
  for (const f of (flows ?? []) as Array<{ id: string; status: string }>) info.set(f.id, { status: f.status, targets: [], endScopes: [] })
  for (const n of (rows ?? []) as Array<{ flow_id: string; node_type: string; config: Record<string, unknown> }>) {
    const entry = info.get(n.flow_id)
    if (!entry) continue
    if (n.node_type === 'execute_flow' && typeof n.config?.target_flow_id === 'string') entry.targets.push(n.config.target_flow_id.toLowerCase())
    if (n.node_type === 'end') entry.endScopes.push(typeof n.config?.scope === 'string' ? n.config.scope : undefined)
  }
  const mine = { status: 'draft', targets: callNodes.map((n) => String(n.config.target_flow_id ?? '').toLowerCase()), endScopes: [], callNodes: callNodes.map((n) => ({ node_key: n.node_key, target: String(n.config.target_flow_id ?? '').toLowerCase() })) }
  return analyzeCallGraph(flowId, mine, info)
}
