import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { validateFlowForActivation } from '@/lib/flows/validate'
import { isCustomConditionEnabledForAccount } from '@/lib/flows/custom-condition-capability'
import { isDurableWaitExecutionEnabledForAccount } from '@/lib/flows/durable-wait-capability'
import { isDurableWaitConfig } from '@/lib/flows/durable-wait'
import { ConditionReferenceInfrastructureError, validateConditionReferences } from '@/lib/flows/condition-references'

// Pilot: flows that run another flow can be authored as drafts but NOT activated until subflow execution exists.
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
      if ((nodes ?? []).some((node) => node.node_type === 'execute_flow')) return NextResponse.json(SUBFLOW_EXECUTION_DISABLED, { status: 409 })
      const durableEnabled = isDurableWaitExecutionEnabledForAccount(account.accountId)
      if (!durableEnabled && (nodes ?? []).some((node) => node.node_type === 'delay' && isDurableWaitConfig(node.config))) return NextResponse.json(DURABLE_WAIT_EXECUTION_DISABLED, { status: 409 })
      const issues = validateFlowForActivation(flow as { name: string; trigger_type: 'keyword' | 'first_inbound_message' | 'manual'; trigger_config: Record<string, unknown>; entry_node_id: string | null }, (nodes ?? []) as Array<{ node_key: string; node_type: string; config: Record<string, unknown> }>, { durableWaitExecution: durableEnabled })
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
