import { createSign } from 'node:crypto'
import { numberFormatFor, quoteTab, type Cell } from './layout'

// Minimal Google Sheets v4 client authenticated as a SERVICE ACCOUNT (JWT bearer, RS256) using only node:crypto + fetch.
// The private key lives only in the server environment; it is never logged and never part of an error message.

export interface GoogleCredentials { clientEmail: string; privateKey: string; tokenUri?: string }
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const DEFAULT_API = 'https://sheets.googleapis.com'

export class SheetsError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, readonly status = 0, readonly retryAfterMs?: number) {
    super(code)
  }
}

export function readGoogleCredentials(env: NodeJS.ProcessEnv = process.env): GoogleCredentials | null {
  const email = env.GOOGLE_SHEETS_SA_EMAIL?.trim()
  const b64 = env.GOOGLE_SHEETS_SA_KEY_B64?.trim()
  if (env.ORDERS_SHEETS_EXPORT_ENABLED !== 'true' || !email || !b64) return null
  const privateKey = Buffer.from(b64, 'base64').toString('utf8')
  if (!privateKey.includes('PRIVATE KEY')) return null
  return { clientEmail: email, privateKey }
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url')

export function buildAssertion(creds: GoogleCredentials, nowSec: number, audience: string): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ iss: creds.clientEmail, scope: SHEETS_SCOPE, aud: audience, iat: nowSec, exp: nowSec + 3600 }))
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(creds.privateKey)
  return `${head}.${body}.${b64url(sig)}`
}

export interface SheetsApi {
  headerRow(spreadsheetId: string, tab: string): Promise<string[]>
  column(spreadsheetId: string, tab: string, colLetter: string): Promise<string[]>
  rows(spreadsheetId: string, tab: string): Promise<Cell[][]>
  writeRange(spreadsheetId: string, tab: string, a1: string, values: Cell[][]): Promise<void>
  // USER_ENTERED: strings that start with '=' are stored as formulas. Used only for the control tab's own formulas, never for order data.
  writeFormulas(spreadsheetId: string, tab: string, a1: string, values: Cell[][]): Promise<void>
  formulas(spreadsheetId: string, tab: string, a1: string): Promise<Cell[][]>
  append(spreadsheetId: string, tab: string, rows: Cell[][]): Promise<void>
}

export class GoogleSheetsClient implements SheetsApi {
  private token: { value: string; expiresAt: number } | null = null
  constructor(
    private readonly creds: GoogleCredentials,
    private readonly opts: { apiBase?: string; fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
  ) {}

  private get f(): typeof fetch { return this.opts.fetchImpl ?? fetch }
  private now(): number { return (this.opts.now ?? Date.now)() }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value
    const uri = this.creds.tokenUri ?? DEFAULT_TOKEN_URI
    const assertion = buildAssertion(this.creds, Math.floor(this.now() / 1000), uri)
    const res = await this.call(uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() }, 'auth')
    const json = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null
    if (!json?.access_token) throw new SheetsError('auth_bad_response', true, res.status)
    this.token = { value: json.access_token, expiresAt: this.now() + (json.expires_in ?? 3600) * 1000 }
    return json.access_token
  }

  private async call(url: string, init: RequestInit, kind: 'auth' | 'api'): Promise<Response> {
    let res: Response
    try {
      res = await this.f(url, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000), redirect: 'error' })
    } catch {
      throw new SheetsError(kind === 'auth' ? 'auth_network' : 'network', true)
    }
    if (res.ok) return res
    const ra = Number(res.headers.get('retry-after'))
    const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined
    const s = res.status
    if (kind === 'auth') throw new SheetsError(s === 400 || s === 401 ? 'auth_rejected' : 'auth_http', s >= 500 || s === 429, s, retryAfterMs)
    if (s === 429) throw new SheetsError('rate_limited', true, s, retryAfterMs)
    if (s >= 500) throw new SheetsError('google_5xx', true, s, retryAfterMs)
    if (s === 401) throw new SheetsError('unauthorized', true, s)
    if (s === 403) throw new SheetsError('forbidden', true, s)          // fixable by sharing the file: retry slowly, then dead
    if (s === 404) throw new SheetsError('not_found', true, s)
    throw new SheetsError(`http_${s}`, false, s)
  }

  private async api(path: string, init: RequestInit = {}): Promise<Response> {
    const base = this.opts.apiBase ?? DEFAULT_API
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(attempt > 0)
      try {
        return await this.call(`${base}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } }, 'api')
      } catch (e) {
        if (e instanceof SheetsError && e.code === 'unauthorized' && attempt === 0) continue  // token revoked/expired early: refresh once
        throw e
      }
    }
  }

  async headerRow(id: string, tab: string): Promise<string[]> {
    const range = encodeURIComponent(`${quoteTab(tab)}!1:1`)
    const res = await this.api(`/v4/spreadsheets/${encodeURIComponent(id)}/values/${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`)
    const json = (await res.json()) as { values?: string[][] }
    return (json.values?.[0] ?? []).map(String)
  }

  // Whole column below the header (rows 2..), as strings. Blank cells inside the range come back as ''.
  async column(id: string, tab: string, col: string): Promise<string[]> {
    const range = encodeURIComponent(`${quoteTab(tab)}!${col}2:${col}`)
    const res = await this.api(`/v4/spreadsheets/${encodeURIComponent(id)}/values/${range}?majorDimension=COLUMNS&valueRenderOption=UNFORMATTED_VALUE`)
    const json = (await res.json()) as { values?: unknown[][] }
    return (json.values?.[0] ?? []).map((v) => (v === null || v === undefined ? '' : String(v)))
  }

  // Every data row (below the header), unformatted: numbers stay numbers. Used by the reconciliation only.
  async rows(id: string, tab: string): Promise<Cell[][]> {
    const range = encodeURIComponent(`${quoteTab(tab)}!A2:AZ`)
    const res = await this.api(`/v4/spreadsheets/${encodeURIComponent(id)}/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`)
    const json = (await res.json()) as { values?: Cell[][] }
    return json.values ?? []
  }

  // Overwrites a small fixed range (used only for the server-written cells of the control tab). RAW: text stays text, numbers stay numbers.
  async writeRange(id: string, tab: string, a1: string, values: Cell[][]): Promise<void> {
    const range = encodeURIComponent(`${quoteTab(tab)}!${a1}`)
    await this.api(`/v4/spreadsheets/${encodeURIComponent(id)}/values/${range}?valueInputOption=RAW`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ majorDimension: 'ROWS', values }),
    })
  }

  async writeFormulas(id: string, tab: string, a1: string, values: Cell[][]): Promise<void> {
    const range = encodeURIComponent(`${quoteTab(tab)}!${a1}`)
    await this.api(`/v4/spreadsheets/${encodeURIComponent(id)}/values/${range}?valueInputOption=USER_ENTERED`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ majorDimension: 'ROWS', values }),
    })
  }

  // Cell contents as typed (formulas as text), used to show what would change before the control tab's formulas are touched.
  async formulas(id: string, tab: string, a1: string): Promise<Cell[][]> {
    const range = encodeURIComponent(`${quoteTab(tab)}!${a1}`)
    const res = await this.api(`/v4/spreadsheets/${encodeURIComponent(id)}/values/${range}?majorDimension=ROWS&valueRenderOption=FORMULA`)
    return ((await res.json()) as { values?: Cell[][] }).values ?? []
  }

  private sheetIds = new Map<string, number>()
  private async sheetId(id: string, tab: string): Promise<number> {
    const key = `${id}|${tab}`
    const hit = this.sheetIds.get(key)
    if (hit !== undefined) return hit
    const res = await this.api(`/v4/spreadsheets/${encodeURIComponent(id)}?fields=${encodeURIComponent('sheets.properties.sheetId,sheets.properties.title')}`)
    const json = (await res.json()) as { sheets?: { properties: { sheetId: number; title: string } }[] }
    const found = json.sheets?.find((s) => s.properties.title === tab)
    if (!found) throw new SheetsError('not_found', true, 404)
    this.sheetIds.set(key, found.properties.sheetId)
    return found.properties.sheetId
  }

  // appendCells (not values:append with INSERT_ROWS): rows go into the first blank rows after the last row with data and the grid only grows when it must, so
  // formulas that reference the register (open ranges starting at row 2) are never shifted. Typed cells: text stays text (nothing is parsed or evaluated as a
  // formula, '=...' included) and numbers stay numbers. One request = one atomic write of all the rows.
  async append(id: string, tab: string, rows: Cell[][]): Promise<void> {
    if (rows.length === 0) return
    const sheetId = await this.sheetId(id, tab)
    const cell = (v: Cell, col: number) => {
      const fmt = numberFormatFor(col)
      const out: Record<string, unknown> = {}
      if (typeof v === 'number') out.userEnteredValue = { numberValue: v }
      else if (v !== '') out.userEnteredValue = { stringValue: v }
      if (fmt) out.userEnteredFormat = { numberFormat: fmt }
      return out
    }
    await this.api(`/v4/spreadsheets/${encodeURIComponent(id)}:batchUpdate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requests: [{ appendCells: { sheetId, rows: rows.map((r) => ({ values: r.map(cell) })), fields: 'userEnteredValue,userEnteredFormat.numberFormat' } }] }),
    })
  }
}
