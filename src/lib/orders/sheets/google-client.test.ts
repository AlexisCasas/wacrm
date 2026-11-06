import { createServer, type Server } from 'node:http'
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GoogleSheetsClient, SheetsError, readGoogleCredentials } from './google-client'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
let srv: Server, base = '', log: { url: string; auth?: string; body?: string }[] = [], script: ((n: number, url: string) => { status: number; body?: unknown; headers?: Record<string, string> }) | null = null, tokenCalls = 0, assertions: string[] = []

beforeEach(async () => {
  log = []; tokenCalls = 0; assertions = []; script = null
  srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/token') {
        tokenCalls++; assertions.push(new URLSearchParams(body).get('assertion') ?? '')
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: `tok-${tokenCalls}`, expires_in: 3600 })); return
      }
      log.push({ url: req.url ?? '', auth: req.headers.authorization, body })
      const r = script?.(log.length, req.url ?? '') ?? { status: 200, body: { values: [['a']] } }
      res.statusCode = r.status
      for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v)
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(r.body ?? {}))
    })
  })
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok))
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
})
afterEach(() => new Promise<void>((ok) => srv.close(() => ok())))

const mk = () => new GoogleSheetsClient({ clientEmail: 'sa@proj.iam.example.invalid', privateKey, tokenUri: `${base}/token` }, { apiBase: base })

describe('GoogleSheetsClient', () => {
  it('signs a valid RS256 service-account assertion and reuses the token', async () => {
    const c = mk(); await c.headerRow('S'.repeat(30), 'Registro de pedidos'); await c.column('S'.repeat(30), 'Registro de pedidos', 'Q')
    expect(tokenCalls).toBe(1)
    const [h, b, s] = assertions[0].split('.')
    expect(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(createPublicKey(publicKey), Buffer.from(s, 'base64url'))).toBe(true)
    const claims = JSON.parse(Buffer.from(b, 'base64url').toString())
    expect(claims).toMatchObject({ iss: 'sa@proj.iam.example.invalid', scope: 'https://www.googleapis.com/auth/spreadsheets', aud: `${base}/token` })
    expect(log.every((l) => l.auth === 'Bearer tok-1')).toBe(true)
  })
  it('appends typed cells with appendCells: text stays text (even "="), numbers stay numbers, formats attached, one atomic request', async () => {
    script = (_n, url) => (url.includes('batchUpdate') ? { status: 200, body: {} } : { status: 200, body: { sheets: [{ properties: { sheetId: 77, title: "Pedidos 'x'" } }] } })
    const c = mk()
    await c.append('S'.repeat(30), "Pedidos 'x'", [[46330, 46330.5, '=1+1', '00000001', '', 'x', 1, 95.5]])
    await c.append('S'.repeat(30), "Pedidos 'x'", [[46331]])                       // second call reuses the cached sheetId
    const calls = log.filter((l) => l.url.includes('batchUpdate')), meta = log.filter((l) => !l.url.includes('batchUpdate'))
    expect(meta).toHaveLength(1); expect(calls).toHaveLength(2)
    expect(log.some((l) => l.url.includes('values:append') || l.url.includes('INSERT_ROWS'))).toBe(false)   // regression: INSERT_ROWS shifted the formulas that reference the register
    const req = JSON.parse(calls[0].body!).requests[0].appendCells
    expect(req.sheetId).toBe(77); expect(req.fields).toBe('userEnteredValue,userEnteredFormat.numberFormat')
    const v = req.rows[0].values
    expect(v[0]).toEqual({ userEnteredValue: { numberValue: 46330 }, userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'd/M/yyyy' } } })
    expect(v[1].userEnteredFormat.numberFormat.type).toBe('DATE_TIME')
    expect(v[2]).toEqual({ userEnteredValue: { stringValue: '=1+1' } })     // never a formula
    expect(v[3]).toEqual({ userEnteredValue: { stringValue: '00000001' } }) // leading zeros kept
    expect(v[4]).toEqual({})                                                  // blank
    expect(v[7].userEnteredValue).toEqual({ numberValue: 95.5 })
  })
  it('an unknown tab is reported as not_found (retryable config problem), nothing is written', async () => {
    script = () => ({ status: 200, body: { sheets: [{ properties: { sheetId: 1, title: 'Otra' } }] } })
    const e = await mk().append('S'.repeat(30), 'Registro', [['x']]).catch((x) => x)
    expect(e.code).toBe('not_found'); expect(log.every((l) => !l.url.includes('batchUpdate'))).toBe(true)
  })
  it('refreshes the token once on 401', async () => {
    script = (n) => (n === 1 ? { status: 401 } : { status: 200, body: { values: [['k1', 'k2']] } })
    await expect(mk().column('S'.repeat(30), 't', 'Q')).resolves.toEqual(['k1', 'k2'])
    expect(tokenCalls).toBe(2)
  })
  it.each([[429, 'rate_limited', true], [503, 'google_5xx', true], [403, 'forbidden', true], [404, 'not_found', true], [400, 'http_400', false]])('classifies HTTP %i', async (status, code, retryable) => {
    script = () => ({ status, headers: (status === 429 ? { 'retry-after': '7' } : {}) as Record<string, string> })
    const e = await mk().append('S'.repeat(30), 't', [['x']]).catch((x) => x)
    expect(e).toBeInstanceOf(SheetsError); expect(e.code).toBe(code); expect(e.retryable).toBe(retryable)
    if (status === 429) expect(e.retryAfterMs).toBe(7000)
  })
  it('network failure is retryable and message never contains the key', async () => {
    const c = new GoogleSheetsClient({ clientEmail: 'a@b.invalid', privateKey, tokenUri: 'http://127.0.0.1:1/token' }, { timeoutMs: 500 })
    const e = await c.headerRow('S'.repeat(30), 't').catch((x) => x)
    expect(e.retryable).toBe(true); expect(String(e.message) + String(e.stack)).not.toContain('PRIVATE KEY')
  })
})
describe('readGoogleCredentials', () => {
  const env = { ORDERS_SHEETS_EXPORT_ENABLED: 'true', GOOGLE_SHEETS_SA_EMAIL: 'a@b.invalid', GOOGLE_SHEETS_SA_KEY_B64: Buffer.from(privateKey).toString('base64') } as never
  it('requires the global switch, email and a PEM key', () => {
    expect(readGoogleCredentials(env)?.clientEmail).toBe('a@b.invalid')
    expect(readGoogleCredentials({ ...(env as object), ORDERS_SHEETS_EXPORT_ENABLED: 'false' } as never)).toBeNull()
    expect(readGoogleCredentials({ ...(env as object), GOOGLE_SHEETS_SA_KEY_B64: 'bm90LWEta2V5' } as never)).toBeNull()
    expect(readGoogleCredentials({} as never)).toBeNull()
  })
})
