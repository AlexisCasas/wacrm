import { describe, expect, it } from 'vitest'
import { parsePublishedFlowDefinition } from './versioned-runtime'

const definition = { flow: { id: 'flow-a', name: 'A', description: null, trigger_type: 'manual', trigger_config: {}, entry_node_id: 'start', fallback_policy: {} }, nodes: [{ node_key: 'start', node_type: 'start', config: {}, position_x: 0, position_y: 0 }] }

describe('parsePublishedFlowDefinition', () => {
  it('parses the immutable E4.1 envelope', () => expect(parsePublishedFlowDefinition(definition)?.flow.id).toBe('flow-a'))
  it('rejects duplicate node keys even across a versioned cursor', () => expect(parsePublishedFlowDefinition({ ...definition, nodes: [...definition.nodes, { ...definition.nodes[0] }] })).toBeNull())
})
