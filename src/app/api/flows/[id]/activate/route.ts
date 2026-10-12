import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { validateFlowForActivation } from '@/lib/flows/validate'
import { isCustomConditionEnabledForAccount } from '@/lib/flows/custom-condition-capability'
import { ConditionReferenceInfrastructureError, validateConditionReferences } from '@/lib/flows/condition-references'

interface ActivateBody {
  status?: 'draft' | 'active' | 'archived'
  expected_updated_at?: string
}

function revisionFailure(error: { code?: string } | null, fallback: string) {
  if (error?.code === '40001') {
    return NextResponse.json(
      { error: 'This flow was changed by another editor. Reload it before trying again.', code: 'flow_revision_conflict' },
      { status: 409 },
    )
  }
  if (error?.code === 'P0002') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (error?.code === '42501') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json({ error: fallback }, { status: 503 })
}

function singlePublishResult(data: unknown): { version_id: string; version_number: number; updated_at: string } | null {
  if (!Array.isArray(data) || data.length !== 1) return null
  const [result] = data
  if (!result || typeof result.version_id !== 'string' || typeof result.version_number !== 'number' || typeof result.updated_at !== 'string') return null
  return result
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  try {
    const account = await requireRole('agent')
    const body = (await request.json().catch(() => null)) as ActivateBody | null
    const status = body?.status
    if (!status || !['draft', 'active', 'archived'].includes(status)) {
      return NextResponse.json({ error: "status must be one of 'draft' | 'active' | 'archived'" }, { status: 400 })
    }
    if (!body?.expected_updated_at || Number.isNaN(Date.parse(body.expected_updated_at))) {
      return NextResponse.json({ error: 'expected_updated_at is required' }, { status: 400 })
    }

    const { data: existing, error: existingError } = await account.supabase
      .from('flows')
      .select('id')
      .eq('id', id)
      .maybeSingle()
    if (existingError) return NextResponse.json({ error: 'Could not read flow' }, { status: 503 })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (status === 'active') {
      const [{ data: flow, error: flowError }, { data: nodes, error: nodesError }] = await Promise.all([
        account.supabase.from('flows').select('id, name, description, trigger_type, trigger_config, entry_node_id, fallback_policy').eq('id', id).maybeSingle(),
        account.supabase.from('flow_nodes').select('node_key, node_type, config, position_x, position_y').eq('flow_id', id).order('node_key', { ascending: true }),
      ])
      if (flowError || nodesError) return NextResponse.json({ error: 'Could not validate flow' }, { status: 503 })
      if (!flow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      const issues = validateFlowForActivation(
        flow as { name: string; trigger_type: 'keyword' | 'first_inbound_message' | 'manual'; trigger_config: Record<string, unknown>; entry_node_id: string | null },
        (nodes ?? []) as Array<{ node_key: string; node_type: string; config: Record<string, unknown> }>,
      )
      const referenceIssues = await validateConditionReferences(
        account.supabase,
        account.accountId,
        (nodes ?? []) as Array<{ node_key: string; node_type: string; config: Record<string, unknown> }>,
        isCustomConditionEnabledForAccount(account.accountId),
      )
      for (const issue of referenceIssues) {
        issues.push({ severity: 'error', scope: 'node', node_key: issue.node_key, field: 'subject_key', message: issue.issue })
      }
      if (issues.some((issue) => issue.severity === 'error')) {
        return NextResponse.json({ error: 'Cannot activate flow — fix the issues below first.', issues }, { status: 422 })
      }

      const expectedDefinition = {
        flow: {
          id: flow.id,
          name: flow.name,
          description: flow.description,
          trigger_type: flow.trigger_type,
          trigger_config: flow.trigger_config,
          entry_node_id: flow.entry_node_id,
          fallback_policy: flow.fallback_policy,
        },
        nodes: (nodes ?? []).map((node) => ({
          node_key: node.node_key,
          node_type: node.node_type,
          config: node.config,
          position_x: node.position_x,
          position_y: node.position_y,
        })),
      }

      const { data, error: publishError } = await supabaseAdmin().rpc('publish_flow_version', {
        p_flow_id: id,
        p_expected_updated_at: body.expected_updated_at,
        p_published_by: account.userId,
        p_expected_definition: expectedDefinition,
      })
      if (publishError) return revisionFailure(publishError, 'Could not publish flow version')
      const published = singlePublishResult(data)
      if (!published) return NextResponse.json({ error: 'Could not confirm published flow version' }, { status: 503 })
      return NextResponse.json({
        updated_at: published.updated_at,
        active_version: { id: published.version_id, version_number: published.version_number },
      })
    }

    const { data: updated, error: updateError } = await account.supabase
      .from('flows')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('updated_at', body.expected_updated_at)
      .select()
      .maybeSingle()
    if (updateError) return revisionFailure(updateError, 'Could not update flow')
    if (!updated) return revisionFailure({ code: '40001' }, 'Could not update flow')
    return NextResponse.json({ flow: updated, updated_at: updated.updated_at })
  } catch (err) {
    if (err instanceof ConditionReferenceInfrastructureError) {
      return NextResponse.json({ error: 'Could not validate condition references' }, { status: 503 })
    }
    return toErrorResponse(err)
  }
}
