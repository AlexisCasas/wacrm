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
