import type { FlowNodeRow } from './types'

export const VERSIONED_LIMITS = { maxDepth: 8, maxNodes: 500, maxMessages: 100 } as const

export interface PublishedFlowDefinition {
  flow: { id: string; name: string; description: string | null; trigger_type: string; trigger_config: Record<string, unknown>; entry_node_id: string | null; fallback_policy: Record<string, unknown> }
  nodes: Array<Pick<FlowNodeRow, 'node_key' | 'node_type' | 'config' | 'position_x' | 'position_y'>>
}

export interface FlowExecutionCursor { flow_version_id: string; node_key: string }
export interface FlowCallFrame { account_id: string; caller_flow_id: string; caller_flow_version_id: string; call_node_key: string; return_node_key: string; depth: number }
export interface VersionedRunContext {
  account_id: string; flow_run_id: string; root_flow_id: string; root_flow_version_id: string
  current: FlowExecutionCursor; vars: Record<string, unknown>; status: 'active' | 'completed' | 'failed'
  frames: FlowCallFrame[]; nodes_executed: number; messages_executed: number; depth: number
}
export interface FlowStepReceipt { flow_run_id: string; flow_version_id: string; node_key: string; step_number: number; outcome: 'entered' | 'sent' | 'returned' | 'failed' }

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }

/** Parses the immutable JSONB envelope written by E4.1 without duplicating node semantics. */
export function parsePublishedFlowDefinition(value: unknown): PublishedFlowDefinition | null {
  if (!record(value) || !record(value.flow) || !Array.isArray(value.nodes)) return null
  const flow = value.flow
  if (typeof flow.id !== 'string' || typeof flow.name !== 'string' || (flow.description !== null && typeof flow.description !== 'string') || typeof flow.trigger_type !== 'string' || !record(flow.trigger_config) || (flow.entry_node_id !== null && typeof flow.entry_node_id !== 'string') || !record(flow.fallback_policy)) return null
  const seen = new Set<string>()
  const nodes: PublishedFlowDefinition['nodes'] = []
  for (const node of value.nodes) {
    if (!record(node) || typeof node.node_key !== 'string' || !node.node_key || typeof node.node_type !== 'string' || !record(node.config) || !Number.isInteger(node.position_x) || !Number.isInteger(node.position_y) || seen.has(node.node_key)) return null
    seen.add(node.node_key); nodes.push(node as PublishedFlowDefinition['nodes'][number])
  }
  return { flow: flow as PublishedFlowDefinition['flow'], nodes }
}

/** Persisted shape of flow_runs.versioned_checkpoint. `cursor` always names the node that is pending
 * (or, for a terminal checkpoint, the node that ended the run); `confirmed` names the last node whose
 * transition was committed, so a restarted process never executes it twice. */
export interface VersionedCheckpoint {
  cursor: FlowExecutionCursor
  step: number
  state: 'pending' | 'terminal'
  confirmed: { flow_version_id: string; node_key: string; step: number } | null
  failure: string | null
}

/** Accepts the checkpoint written by create_versioned_flow_run ({cursor, step}) as well as interpreter checkpoints. */
export function parseVersionedCheckpoint(value: unknown): VersionedCheckpoint | null {
  if (!record(value) || !record(value.cursor)) return null
  const { flow_version_id, node_key } = value.cursor
  if (typeof flow_version_id !== 'string' || !flow_version_id || typeof node_key !== 'string' || !node_key) return null
  if (typeof value.step !== 'number' || !Number.isInteger(value.step) || value.step < 0) return null
  const state = value.state === undefined ? 'pending' : value.state
  if (state !== 'pending' && state !== 'terminal') return null
  let confirmed: VersionedCheckpoint['confirmed'] = null
  if (value.confirmed !== undefined && value.confirmed !== null) {
    const c = value.confirmed
    if (!record(c) || typeof c.flow_version_id !== 'string' || typeof c.node_key !== 'string' || typeof c.step !== 'number' || !Number.isInteger(c.step)) return null
    confirmed = { flow_version_id: c.flow_version_id, node_key: c.node_key, step: c.step }
  }
  if (value.failure !== undefined && value.failure !== null && typeof value.failure !== 'string') return null
  return { cursor: { flow_version_id, node_key }, step: value.step, state, confirmed, failure: typeof value.failure === 'string' ? value.failure : null }
}
