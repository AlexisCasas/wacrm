import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isCustomConditionEnabledForAccount } from '@/lib/flows/custom-condition-capability'
import { ConditionReferenceInfrastructureError, validateConditionReferences } from '@/lib/flows/condition-references'

interface PutBody {
  expected_updated_at?: string
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

function rpcFailure(error: { code?: string } | null, fallback: string) {
  if (error?.code === '40001') {
    return NextResponse.json(
      { error: 'This flow was changed by another editor. Reload it before saving again.', code: 'flow_revision_conflict' },
      { status: 409 },
    )
  }
  if (error?.code === 'P0002') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (error?.code === '42501') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (error?.code === '22023') return NextResponse.json({ error: 'Invalid flow data' }, { status: 400 })
  return NextResponse.json({ error: fallback }, { status: 503 })
}

function singleSaveResult(data: unknown): { updated_at: string } | null {
  if (!Array.isArray(data) || data.length !== 1) return null
  const [result] = data
  return result && typeof result.updated_at === 'string' ? { updated_at: result.updated_at } : null
}

async function readableFlow(supabase: Awaited<ReturnType<typeof requireRole>>['supabase'], id: string) {
  const { data, error } = await supabase.from('flows').select('id').eq('id', id).maybeSingle()
  if (error) return { ok: false as const, response: NextResponse.json({ error: 'Could not read flow' }, { status: 503 }) }
  if (!data) return { ok: false as const, response: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return { ok: true as const, flow: data }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  try {
    const account = await requireRole('viewer')
    const readable = await readableFlow(account.supabase, id)
    if (!readable.ok) return readable.response
    const [{ data: flow, error: flowError }, { data: nodes, error: nodesError }] = await Promise.all([
      account.supabase.from('flows').select('*').eq('id', id).maybeSingle(),
      account.supabase.from('flow_nodes').select('*').eq('flow_id', id).order('created_at', { ascending: true }),
    ])
    if (flowError || nodesError) return NextResponse.json({ error: 'Could not read flow' }, { status: 503 })
    if (!flow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ flow, nodes: nodes ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  try {
    const account = await requireRole('agent')
    const readable = await readableFlow(account.supabase, id)
    if (!readable.ok) return readable.response

    const body = (await request.json().catch(() => null)) as PutBody | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    if (!body.expected_updated_at || Number.isNaN(Date.parse(body.expected_updated_at))) {
      return NextResponse.json({ error: 'expected_updated_at is required' }, { status: 400 })
    }
    if (body.name !== undefined && !body.name.trim()) {
      return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    }

    if (body.nodes !== undefined) {
      const capabilityEnabled = isCustomConditionEnabledForAccount(account.accountId)
      const { data: currentNodes, error: currentNodesError } = !capabilityEnabled
        ? await account.supabase.from('flow_nodes').select('node_key, node_type, config').eq('flow_id', id)
        : { data: [], error: null }
      if (currentNodesError) return NextResponse.json({ error: 'Could not validate condition references' }, { status: 503 })
      const existingCustom = new Set(
        (currentNodes ?? [])
          .filter((node) => node.node_type === 'condition' && (node.config as Record<string, unknown>).subject === 'contact_field' && typeof (node.config as Record<string, unknown>).subject_key === 'string')
          .map((node) => `${node.node_key}:${(node.config as Record<string, unknown>).subject_key}`),
      )
      const issues = (await validateConditionReferences(account.supabase, account.accountId, body.nodes, capabilityEnabled)).filter(
        (issue) => issue.issue !== 'custom_condition_capability_disabled' || !existingCustom.has(`${issue.node_key}:${(body.nodes ?? []).find((node) => node.node_key === issue.node_key)?.config.subject_key}`),
      )
      if (issues.length) return NextResponse.json({ error: 'Invalid condition reference', issues }, { status: 422 })
    }

    const patch: Record<string, unknown> = {}
    if (body.name !== undefined) patch.name = body.name.trim()
    if (body.description !== undefined) patch.description = body.description
    if (body.trigger_type !== undefined) patch.trigger_type = body.trigger_type
    if (body.trigger_config !== undefined) patch.trigger_config = body.trigger_config
    if (body.entry_node_id !== undefined) patch.entry_node_id = body.entry_node_id
    if (body.fallback_policy !== undefined) patch.fallback_policy = body.fallback_policy

    const { data, error: saveError } = await account.supabase.rpc('save_flow_draft', {
      p_flow_id: id,
      p_expected_updated_at: body.expected_updated_at,
      p_patch: patch,
      p_nodes: body.nodes ?? null,
    })
    if (saveError) return rpcFailure(saveError, 'Could not save flow')
    const saved = singleSaveResult(data)
    if (!saved) return NextResponse.json({ error: 'Could not confirm saved flow revision' }, { status: 503 })
    return NextResponse.json({ updated_at: saved.updated_at })
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
): Promise<Response> {
  const { id } = await context.params
  try {
    const account = await requireRole('agent')
    const readable = await readableFlow(account.supabase, id)
    if (!readable.ok) return readable.response
    const { error } = await account.supabase.from('flows').delete().eq('id', id)
    if (error?.code === '23503') {
      return NextResponse.json({ error: 'Published flows cannot be deleted because their versions are retained.' }, { status: 409 })
    }
    if (error) return NextResponse.json({ error: 'Could not delete flow' }, { status: 503 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
