#!/usr/bin/env node
// Updates ONLY the status formulas of the «Control de conciliación» tab from src/lib/orders/sheets/control-formulas.json (single source, tested).
// It never touches the register, the server-written figures (C2:D7, B9, C13:C15) or any order data.
//   DRY RUN (default, read-only):   node apply-control-formulas.mjs --sheet <spreadsheetId>
//   APPLY:                          CONFIRM=yes node apply-control-formulas.mjs --sheet <spreadsheetId> --apply
// Credentials: the service-account JSON at $SA_JSON (default /root/.config/wacrm-secrets/google-sa.json). Nothing secret is printed.
import { readFileSync } from 'node:fs'
import { createSign } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const sheet = args[args.indexOf('--sheet') + 1]
if (!sheet || args.indexOf('--sheet') < 0) { console.error('usage: apply-control-formulas.mjs --sheet <spreadsheetId> [--apply]'); process.exit(2) }
const apply = args.includes('--apply')
if (apply && process.env.CONFIRM !== 'yes') { console.error('REFUSING: --apply changes the sheet. Re-run with CONFIRM=yes after approval.'); process.exit(2) }

const spec = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../src/lib/orders/sheets/control-formulas.json'), 'utf8'))
const sa = JSON.parse(readFileSync(process.env.SA_JSON ?? '/root/.config/wacrm-secrets/google-sa.json', 'utf8'))
const b = (x) => Buffer.from(x).toString('base64url'), now = Math.floor(Date.now() / 1000)
const head = b(JSON.stringify({ alg: 'RS256', typ: 'JWT' })), body = b(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: sa.token_uri, iat: now, exp: now + 3600 }))
const assertion = `${head}.${body}.${b(createSign('RSA-SHA256').update(`${head}.${body}`).sign(sa.private_key))}`
const tok = await (await fetch(sa.token_uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) })).json()
if (!tok.access_token) { console.error('auth failed'); process.exit(1) }
const call = async (path, init = {}) => { const r = await fetch(`https://sheets.googleapis.com${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${tok.access_token}` } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }
const q = (a1) => encodeURIComponent(`'${spec.tab}'!${a1}`)

const current = {}
for (const c of spec.cells) current[c.a1] = ((await call(`/v4/spreadsheets/${sheet}/values/${q(c.a1)}?valueRenderOption=FORMULA`)).values ?? [[]])[0]?.[0] ?? ''
const mustBeEmpty = /^(F[1-6]|A12|B12)$/
const guard = []
if (!String(current.B10).includes('SIN CONCILIAR')) guard.push('B10 does not look like the control tab status formula')
for (const c of spec.cells) if (mustBeEmpty.test(c.a1) && current[c.a1] !== '' && current[c.a1] !== (c.formula ?? c.value)) guard.push(`${c.a1} already holds something else`)
for (const c of spec.cells) console.log(`${c.a1.padEnd(4)} ${current[c.a1] === (c.formula ?? c.value) ? 'unchanged' : current[c.a1] === '' ? 'NEW      ' : 'CHANGES  '} ${String(c.formula ?? c.value).slice(0, 110)}`)
if (guard.length) { console.error('STOP:', guard.join('; ')); process.exit(1) }
if (!apply) { console.log('DRY RUN: nothing was written. Add --apply (with CONFIRM=yes) to write these cells.'); process.exit(0) }
for (const c of spec.cells) await call(`/v4/spreadsheets/${sheet}/values/${q(c.a1)}?valueInputOption=USER_ENTERED`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ majorDimension: 'ROWS', values: [[c.formula ?? c.value]] }) })
const after = (await call(`/v4/spreadsheets/${sheet}/values/${q('B10')}`)).values?.[0]?.[0]
console.log(`APPLIED ${spec.cells.length} cells. Estado general now: ${after}`)
