import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { validateFlowForActivation } from '@/lib/flows/validate'
import { isCustomConditionEnabledForAccount } from '@/lib/flows/custom-condition-capability'
import { ConditionReferenceInfrastructureError, validateConditionReferences } from '@/lib/flows/condition-references'

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
      const [{ data: flow }, { data: nodes }] = await Promise.all([
        admin.from('flows').select('name, trigger_type, trigger_config, entry_node_id').eq('id', id).maybeSingle(),
        admin.from('flow_nodes').select('node_key, node_type, config').eq('flow_id', id),
      ])
      if (!flow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      const issues = validateFlowForActivation(flow as { name: string; trigger_type: 'keyword' | 'first_inbound_message' | 'manual'; trigger_config: Record<string, unknown>; entry_node_id: string | null }, (nodes ?? []) as Array<{ node_key: string; node_type: string; config: Record<string, unknown> }>)
      const referenceIssues = await validateConditionReferences(account.supabase, account.accountId, (nodes ?? []) as Array<{ node_key: string; node_type: string; config: Record<string, unknown> }>, isCustomConditionEnabledForAccount(account.accountId))
      for (const issue of referenceIssues) issues.push({ severity: 'error', scope: 'node', node_key: issue.node_key, field: 'subject_key', message: issue.issue })
      if (issues.some((issue) => issue.severity === 'error')) return NextResponse.json({ error: 'Cannot activate flow — fix the issues below first.', issues }, { status: 422 })
    }
    const { data: updated, error } = await admin.from('flows').update({ status, updated_at: new Date().toISOString() }).eq('id', id).select().maybeSingle()
    if (error) return NextResponse.json({ error: 'Could not update flow' }, { status: 500 })
    return NextResponse.json({ flow: updated })
  } catch (err) {
    if (err instanceof ConditionReferenceInfrastructureError) return NextResponse.json({ error: 'Could not validate condition references' }, { status: 503 })
    return toErrorResponse(err)
  }
}
