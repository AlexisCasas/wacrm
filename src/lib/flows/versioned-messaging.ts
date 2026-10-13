import { effectOccurrenceKey, type EffectType, type ResolveOutcome, type VersionedEffectStore } from './versioned-effects'
import type { PublishedFlowDefinition } from './versioned-runtime'
import type { VersionedRunStore } from './versioned-store'

/**
 * Contracts for messaging effects of versioned runs (E4.2C2). One flow node is exactly one logical outbound
 * message: `send_message` is one text; `send_media` is one WhatsApp media message (the caption travels in the
 * same message). The ledger therefore needs exactly one effect per node occurrence, which its key
 * (run, occurrence_revision) provides. A node that needed several physical messages would be refused by that
 * unique key rather than silently sharing one identity.
 *
 * The sender is injected. This module has no network code and no provider SDK; the only implementation in this
 * repository is a scripted test double.
 */

export type OutboundPayload =
  | { kind: 'text'; text: string }
  | { kind: 'media'; media_type: 'image' | 'video' | 'document'; media_url: string; caption?: string; filename?: string }

export interface OutboundRequest {
  effectId: string
  /** Fresh for every claim. Use it as the client reference towards the provider. */
  attemptId: string
  attempt: number
  /** Stable identity of this node occurrence: `${runId}:${revision}`. */
  occurrenceKey: string
  effectType: EffectType
  contactId: string | null
  conversationId: string | null
  /** The payload exactly as registered in the ledger. */
  payload: OutboundPayload
}

/**
 * - accepted        the provider took the message (id recorded)
 * - rejected        the provider refused it with certainty
 * - ambiguous       outcome unknown (timeout, lost response...): the message may or may not have gone out
 * - not_dispatched  failed with proof that the request never reached the provider; the ONLY outcome that can
 *                   justify an automatic retry
 */
export type SendOutcome =
  | { kind: 'accepted'; providerMessageId: string }
  | { kind: 'rejected'; errorCode: string }
  | { kind: 'ambiguous'; errorCode?: string }
  | { kind: 'not_dispatched'; errorCode?: string }

export interface EffectSender { send(request: OutboundRequest): Promise<SendOutcome> }

export interface MessagingOptions {
  effects: VersionedEffectStore
  sender: EffectSender
  /** Automatic re-sends after `not_dispatched` within one invocation. Default 2. */
  maxNotDispatchedRetries?: number
}

/** `{{vars.name}}` interpolation with the legacy runner's semantics (missing values render as empty). */
export function renderVarTemplate(template: string, vars: Record<string, unknown>): string {
  if (!template) return ''
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_m, key: string) => {
    const v = vars[key]
    return v === undefined || v === null ? '' : String(v)
  })
}

export interface MessageNodeSpec { effectType: EffectType; nextNodeKey: string; build(vars: Record<string, unknown>): OutboundPayload }

const MEDIA_TYPES = new Set(['image', 'video', 'document'])
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Reads a snapshot node of type send_message / send_media; null when its configuration is unusable. */
export function parseMessageNode(node: PublishedFlowDefinition['nodes'][number]): MessageNodeSpec | null {
  const c = node.config as Record<string, unknown>
  if (typeof c.next_node_key !== 'string' || !c.next_node_key) return null
  if (node.node_type === 'send_message') {
    if (typeof c.text !== 'string' || !c.text.trim()) return null
    const text = c.text
    return { effectType: 'send_message', nextNodeKey: c.next_node_key, build: (vars) => ({ kind: 'text', text: renderVarTemplate(text, vars) }) }
  }
  if (node.node_type === 'send_media') {
    if (typeof c.media_type !== 'string' || !MEDIA_TYPES.has(c.media_type) || typeof c.media_url !== 'string') return null
    try { if (!/^https?:$/.test(new URL(c.media_url).protocol)) return null } catch { return null }
    if (c.caption !== undefined && typeof c.caption !== 'string') return null
    if (c.filename !== undefined && typeof c.filename !== 'string') return null
    const { media_type, media_url, caption, filename } = c as { media_type: 'image' | 'video' | 'document'; media_url: string; caption?: string; filename?: string }
    return { effectType: 'send_media', nextNodeKey: c.next_node_key, build: (vars) => ({
      kind: 'media', media_type, media_url,
      ...(caption ? { caption: renderVarTemplate(caption, vars) } : {}), ...(filename ? { filename } : {}),
    }) }
  }
  return null
}

/** Validates the payload read back from the ledger before it is handed to a sender. */
export function parseOutboundPayload(request: unknown): OutboundPayload | null {
  if (!isRecord(request)) return null
  if (request.kind === 'text' && typeof request.text === 'string') return { kind: 'text', text: request.text }
  if (request.kind === 'media' && typeof request.media_type === 'string' && MEDIA_TYPES.has(request.media_type) && typeof request.media_url === 'string') {
    return { kind: 'media', media_type: request.media_type as 'image' | 'video' | 'document', media_url: request.media_url,
      ...(typeof request.caption === 'string' ? { caption: request.caption } : {}), ...(typeof request.filename === 'string' ? { filename: request.filename } : {}) }
  }
  return null
}

export { effectOccurrenceKey }

export interface ResolveAmbiguousInput {
  accountId: string; runId: string; owner: string; effectId: string
  resolution: ResolveOutcome; evidence: string; providerMessageId?: string
  ttlSeconds?: number
  /** Take over an expired lease through the explicit reclaim RPC. Default false. */
  recoverExpiredLease?: boolean
}

/**
 * The only way out of `ambiguous`: someone supplies evidence (a delivery receipt, the provider's own record, an
 * operator's check). Takes the run's lease for the duration of the call, like any other writer, and releases it.
 */
export async function resolveAmbiguousEffect(runs: VersionedRunStore, effects: VersionedEffectStore, input: ResolveAmbiguousInput) {
  const ttl = input.ttlSeconds ?? 60
  let lease = await runs.acquireLease(input.accountId, input.runId, input.owner, ttl)
  if (!lease.acquired && lease.reason === 'lease_expired' && input.recoverExpiredLease) lease = await runs.reclaimLease(input.accountId, input.runId, input.owner, ttl)
  if (!lease.acquired) return { resolved: false as const, state: null, reason: lease.reason ?? 'lease_unavailable' }
  try {
    // an attempt abandoned by an older lease must be marked ambiguous before it can be resolved
    await effects.recoverEffects({ accountId: input.accountId, runId: input.runId, owner: input.owner, fencingToken: lease.fencingToken })
    return await effects.resolveEffect({ accountId: input.accountId, runId: input.runId, owner: input.owner, fencingToken: lease.fencingToken,
      effectId: input.effectId, resolution: input.resolution, evidence: input.evidence, providerMessageId: input.providerMessageId })
  } finally {
    try { await runs.releaseLease(input.accountId, input.runId, input.owner, lease.fencingToken) } catch { /* the lease expires on its own */ }
  }
}
