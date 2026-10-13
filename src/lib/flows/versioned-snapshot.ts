import { parsePublishedFlowDefinition, type FlowExecutionCursor, type PublishedFlowDefinition } from './versioned-runtime'
import type { FlowVersionRow, VersionedRunStore } from './versioned-store'

export type SnapshotErrorCode = 'version_not_found' | 'account_mismatch' | 'invalid_definition' | 'flow_mismatch' | 'node_not_found'
export class SnapshotError extends Error {
  constructor(public readonly code: SnapshotErrorCode, message: string) { super(message); this.name = 'SnapshotError' }
}

export type SnapshotNode = PublishedFlowDefinition['nodes'][number]
/** One immutable published version, indexed by node_key. Nodes are only ever addressed as (flow_version_id, node_key). */
export interface VersionSnapshot {
  versionId: string; flowId: string; accountId: string; definition: PublishedFlowDefinition
  node(nodeKey: string): SnapshotNode | undefined
}

/** Structural validation of a flow_versions row; the parser rejects duplicate node_keys and malformed nodes. */
export function buildSnapshot(row: FlowVersionRow, expectedAccountId: string): VersionSnapshot {
  if (row.account_id !== expectedAccountId) throw new SnapshotError('account_mismatch', `flow version ${row.id} belongs to another account`)
  const definition = parsePublishedFlowDefinition(row.definition)
  if (!definition) throw new SnapshotError('invalid_definition', `flow version ${row.id} has an invalid definition`)
  if (definition.flow.id !== row.flow_id) throw new SnapshotError('flow_mismatch', `flow version ${row.id} definition belongs to another flow`)
  const byKey = new Map(definition.nodes.map((n) => [n.node_key, n] as const))
  return { versionId: row.id, flowId: row.flow_id, accountId: row.account_id, definition, node: (key) => byKey.get(key) }
}

/** Loads published versions of one account on demand. Versions are immutable, so entries are cached for the
 * loader's lifetime; live flows / flow_nodes are never read. */
export class SnapshotLoader {
  private readonly cache = new Map<string, VersionSnapshot>()
  constructor(private readonly store: Pick<VersionedRunStore, 'loadVersion'>, private readonly accountId: string) {}

  async get(versionId: string): Promise<VersionSnapshot> {
    const hit = this.cache.get(versionId)
    if (hit) return hit
    const row = await this.store.loadVersion(this.accountId, versionId)
    if (!row) throw new SnapshotError('version_not_found', `flow version ${versionId} not found for account`)
    const snapshot = buildSnapshot(row, this.accountId)
    this.cache.set(versionId, snapshot)
    return snapshot
  }

  async resolve(cursor: FlowExecutionCursor): Promise<{ snapshot: VersionSnapshot; node: SnapshotNode }> {
    const snapshot = await this.get(cursor.flow_version_id)
    const node = snapshot.node(cursor.node_key)
    if (!node) throw new SnapshotError('node_not_found', `node ${cursor.node_key} not found in flow version ${cursor.flow_version_id}`)
    return { snapshot, node }
  }
}
