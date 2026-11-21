// Client-safe types of the conversation routing (migration 20261128000000). Kept apart from routing.ts, which imports the service-role client.

/** commercial: Comercial works the chat. logistics: Logistica works it. shared: both work the SAME chat (a new sale while an order is in logistics). */
export type ConversationStage = 'commercial' | 'logistics' | 'shared'

export const CONVERSATION_STAGES: readonly ConversationStage[] = ['commercial', 'logistics', 'shared'] as const

export function isConversationStage(value: unknown): value is ConversationStage {
  return typeof value === 'string' && (CONVERSATION_STAGES as readonly string[]).includes(value)
}

/** Response of GET /api/conversations/[id]/routing. `enabled: false` = the account does not use the routing (legacy behaviour, nothing is shown). */
export interface RoutingState {
  enabled: boolean
  stage: ConversationStage | null
  /** Only logistics / supervisor, only on a `logistics` conversation. The database function remains the authority. */
  can_derive: boolean
  /** The latest "Derivar a Comercial" while the chat is `shared`: who and when (snapshot name from the audit trail). */
  derived: { by: string; at: string } | null
}
