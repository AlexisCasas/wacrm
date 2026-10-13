import type { EffectSender, OutboundRequest, SendOutcome } from '../versioned-messaging'

/**
 * Test-only scripted sender. It never touches the network: "delivered" is just a list in memory that the tests
 * compare with what the ledger believes, which is how duplicate sends are detected.
 *
 *   accept                     delivered, answer = accepted
 *   accept_then_timeout        delivered, answer = ambiguous (timeout after acceptance)
 *   accept_then_lose_response  delivered, the call throws (response lost)
 *   timeout_not_delivered      NOT delivered, answer = ambiguous (the interpreter cannot know)
 *   fail_before_send           NOT delivered, answer = not_dispatched (provably never handed over)
 *   permanent_failure          NOT delivered, answer = rejected
 */
export type MockBehavior = 'accept' | 'accept_then_timeout' | 'accept_then_lose_response' | 'timeout_not_delivered' | 'fail_before_send' | 'permanent_failure'

export class MockEffectSender implements EffectSender {
  /** Every request handed to send(), in order (including those that were not delivered). */
  readonly calls: OutboundRequest[] = []
  /** What the pretend provider really delivered. */
  readonly delivered: Array<{ providerMessageId: string; request: OutboundRequest }> = []
  /** Runs before the behavior is applied (e.g. to steal the lease while a send is in flight). */
  onSend?: (request: OutboundRequest) => Promise<void> | void
  private queue: MockBehavior[] = []
  private fallback: MockBehavior = 'accept'
  private counter = 0
  /** Provider ids must be unique per account in the ledger, so every double has its own namespace. */
  private readonly namespace = Math.random().toString(36).slice(2, 10)

  /** Behaviors for the next calls, consumed in order; after them the default applies. */
  script(...behaviors: MockBehavior[]) { this.queue.push(...behaviors); return this }
  setDefault(behavior: MockBehavior) { this.fallback = behavior; return this }

  async send(request: OutboundRequest): Promise<SendOutcome> {
    this.calls.push(request)
    await this.onSend?.(request)
    const behavior = this.queue.shift() ?? this.fallback
    const deliver = () => { const providerMessageId = `wamid.MOCK.${this.namespace}.${++this.counter}`; this.delivered.push({ providerMessageId, request }); return providerMessageId }
    switch (behavior) {
      case 'accept': return { kind: 'accepted', providerMessageId: deliver() }
      case 'accept_then_timeout': deliver(); return { kind: 'ambiguous', errorCode: 'timeout' }
      case 'accept_then_lose_response': deliver(); throw new Error('response lost')
      case 'timeout_not_delivered': return { kind: 'ambiguous', errorCode: 'timeout' }
      case 'fail_before_send': return { kind: 'not_dispatched', errorCode: 'connect_refused' }
      case 'permanent_failure': return { kind: 'rejected', errorCode: 'invalid_recipient' }
    }
  }

  texts() { return this.delivered.map((d) => (d.request.payload.kind === 'text' ? d.request.payload.text : `[${d.request.payload.media_type}] ${d.request.payload.caption ?? ''}`.trim())) }
}
