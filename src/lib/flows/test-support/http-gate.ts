import { createHmac } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Test-only plumbing for the F06 Security Gate: REAL HTTP requests against a REAL PostgREST that runs on an isolated
 * (`--internal`) Docker network next to the QA PostgreSQL. JWTs are signed with a synthetic secret that exists only in the QA
 * process environment. Every request is checked against the QA PostgREST address, so nothing can leave for another host.
 */
export const REST_URL = process.env.QA_REST_URL ?? ''
export const JWT_SECRET = process.env.QA_JWT_SECRET ?? ''

const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')
/** HS256 JWT. `exp` defaults to one hour from now; pass a past value to mint an expired token. */
export function signJwt(claims: Record<string, unknown>, opts: { secret?: string; alg?: 'HS256' } = {}): string {
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: opts.alg ?? 'HS256', typ: 'JWT' })
  const body = b64({ iat: now, exp: now + 3600, ...claims })
  const sig = createHmac('sha256', opts.secret ?? JWT_SECRET).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}
export const tokenFor = (role: string, sub?: string, extra: Record<string, unknown> = {}) =>
  signJwt({ role, aud: 'authenticated', ...(sub ? { sub } : {}), ...extra })

/** The only fetch this suite uses: refuses any URL outside the QA PostgREST. */
export const guardedFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
  if (!REST_URL || !url.startsWith(REST_URL)) throw new Error(`blocked: ${url} is not the QA PostgREST`)
  return fetch(input, init)
}

export interface Raw { status: number; headers: Headers; text: string; json: any } // eslint-disable-line @typescript-eslint/no-explicit-any
/** One raw HTTP request. `token` undefined = no Authorization header at all. */
export async function raw(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Raw> {
  const res = await guardedFetch(`${REST_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })
  const text = await res.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json }
}

/** The real supabase-js client against PostgREST (it appends /rest/v1; PostgREST serves at the root, so the prefix is stripped). */
export function httpClient(token?: string): SupabaseClient {
  const rewriting: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    return guardedFetch(url.replace('/rest/v1', ''), init)
  }
  return createClient(REST_URL, token ?? 'qa-anon-placeholder', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: rewriting, headers: token ? { Authorization: `Bearer ${token}` } : {} },
  })
}
