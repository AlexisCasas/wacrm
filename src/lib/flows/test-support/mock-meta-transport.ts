import { HttpTransportError, type HttpRequest, type HttpResponse, type HttpTransport } from '../versioned-meta-sender'

/**
 * Test-only scripted HTTP transport for the Meta adapter. No sockets: every request is recorded and answered from a
 * script. `delivered` is what the pretend provider really accepted, which is how duplicates are detected.
 *
 *   accept                 200 + a synthetic wamid (delivered)
 *   accept_then_timeout    delivered, but the caller only sees an in-flight timeout
 *   lost_response          delivered, the caller sees a plain "socket hang up" error
 *   reset_in_flight        NOT delivered, in-flight connection reset
 *   refused_before_send    NOT delivered, provably never transmitted
 *   not_allowed            400 / 131030 (recipient not in the allowed list)
 *   invalid_param          400 / 100
 *   undeliverable          400 / 131026
 *   auth_error             401 / 190
 *   rate_limited           429 / 131056 (+ Retry-After when `retryAfterHeader` is set)
 *   throttled_400          400 / 130429 (Meta throttling that does not use HTTP 429)
 *   throttle_code_500/503/408  a throttle code on a 5xx / 408: NOT trusted, stays ambiguous
 *   throttle_code_403      a throttle code on a definitive 4xx: a temporary rejection
 *   server_error           500 (not delivered, but the caller cannot know)
 *   accepted_no_id         200 with a body that has no message id (delivered)
 */
export type MetaBehavior = 'accept' | 'accept_then_timeout' | 'lost_response' | 'reset_in_flight' | 'refused_before_send' | 'not_allowed'
  | 'invalid_param' | 'undeliverable' | 'auth_error' | 'rate_limited' | 'throttled_400' | 'throttle_code_500' | 'throttle_code_503' | 'throttle_code_408' | 'throttle_code_403' | 'server_error' | 'accepted_no_id'

export interface RecordedRequest { url: string; headers: Record<string, string>; body: Record<string, unknown>; to: string }

export class MockMetaTransport implements HttpTransport {
  readonly requests: RecordedRequest[] = []
  readonly delivered: Array<{ wamid: string; to: string; body: Record<string, unknown> }> = []
  /** Runs before the behavior is applied (e.g. to take the lease away while a request is in flight). */
  onPost?: (request: RecordedRequest) => Promise<void> | void
  /** Retry-After header sent with the next rate_limited answer (undefined = none). */
  retryAfterHeader?: string
  /** Forces the next accepted request to answer with this exact wamid (to simulate a provider id that is already in use). */
  nextWamid?: string
  private queue: MetaBehavior[] = []
  private fallback: MetaBehavior = 'accept'
  private counter = 0
  private readonly namespace = Math.random().toString(36).slice(2, 10).toUpperCase()

  script(...behaviors: MetaBehavior[]) { this.queue.push(...behaviors); return this }
  setDefault(b: MetaBehavior) { this.fallback = b; return this }
  get wamids() { return this.delivered.map((d) => d.wamid) }

  async post(request: HttpRequest): Promise<HttpResponse> {
    const body = JSON.parse(request.body) as Record<string, unknown>
    const rec: RecordedRequest = { url: request.url, headers: request.headers, body, to: String(body.to) }
    this.requests.push(rec)
    await this.onPost?.(rec)
    const b = this.queue.shift() ?? this.fallback
    const deliver = () => { const wamid = this.nextWamid ?? `wamid.HBg${this.namespace}${++this.counter}AA=`; this.nextWamid = undefined; this.delivered.push({ wamid, to: rec.to, body }); return wamid }
    const err = (status: number, code: number, message: string): HttpResponse => ({ status, body: JSON.stringify({ error: { message, type: 'OAuthException', code, fbtrace_id: 'TRACE' } }) })
    switch (b) {
      case 'accept': return { status: 200, body: JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: rec.to, wa_id: rec.to }], messages: [{ id: deliver() }] }) }
      case 'accept_then_timeout': deliver(); throw new HttpTransportError('timed out waiting for the response', 'in_flight', 'transport_timeout')
      case 'lost_response': deliver(); throw new Error('socket hang up')
      case 'reset_in_flight': throw new HttpTransportError('connection reset by peer', 'in_flight', 'transport_reset')
      case 'refused_before_send': throw new HttpTransportError('connect ECONNREFUSED', 'before_transmission', 'connect_refused')
      case 'not_allowed': return err(400, 131030, 'Recipient phone number not in allowed list')
      case 'invalid_param': return err(400, 100, 'Invalid parameter')
      case 'undeliverable': return err(400, 131026, 'Message undeliverable')
      case 'auth_error': return err(401, 190, 'Invalid OAuth access token')
      case 'rate_limited': { const r = err(429, 131056, 'Pair rate limit hit'); return this.retryAfterHeader === undefined ? r : { ...r, headers: { 'Retry-After': this.retryAfterHeader } } }
      case 'throttled_400': return err(400, 130429, 'Rate limit hit')
      case 'throttle_code_500': return err(500, 131056, 'Rate limit code on a server error')
      case 'throttle_code_503': return err(503, 80007, 'Rate limit code on an unavailable service')
      case 'throttle_code_408': return err(408, 130429, 'Rate limit code on a request timeout')
      case 'throttle_code_403': return err(403, 80007, 'Rate limit code on a definitive 4xx')
      case 'server_error': return { status: 500, body: JSON.stringify({ error: { message: 'Service temporarily unavailable', code: 2 } }) }
      case 'accepted_no_id': deliver(); return { status: 200, body: JSON.stringify({ messaging_product: 'whatsapp', messages: [] }) }
    }
  }
}
