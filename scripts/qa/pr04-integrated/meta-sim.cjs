/* LOCAL ONLY. Preloaded into the Next dev server (NODE_OPTIONS=--require <this file>) so that NO request ever reaches Meta:
 * every call to *.facebook.com is answered here, according to the mode in C:\WACRM-LOCAL-QA\meta-mode.txt (read on every call, no restart needed):
 *   success    -> 200 with a fake wamid                                  (the template send succeeds)
 *   failed     -> 400 Meta-style rejection                               (nothing reached WhatsApp -> dispatch "failed")
 *   uncertain  -> network failure ("fetch failed")                       (the outcome is unknown -> dispatch "uncertain", never re-sent automatically)
 * Every simulated call is logged to C:\WACRM-LOCAL-QA\meta-sim.log (method, path, template name; never headers or tokens). Product code is untouched. */
const fs = require('node:fs')
const MODE_FILE = 'C:\\WACRM-LOCAL-QA\\meta-mode.txt'
const LOG_FILE = 'C:\\WACRM-LOCAL-QA\\meta-sim.log'

const mode = () => {
  try {
    const m = fs.readFileSync(MODE_FILE, 'utf8').trim()
    return ['success', 'failed', 'uncertain'].includes(m) ? m : 'success'
  } catch {
    return 'success'
  }
}
const log = (line) => {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

const realFetch = globalThis.fetch
globalThis.fetch = async function patchedFetch(input, init) {
  let url
  try {
    url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  } catch {
    return realFetch(input, init)
  }
  if (!/(^|\.)facebook\.com$/i.test(url.hostname)) return realFetch(input, init)

  const method = (init && init.method) || 'GET'
  let template = ''
  try {
    template = JSON.parse(String(init && init.body)).template?.name ?? ''
  } catch {}
  const m = mode()
  log(`${m.toUpperCase()} ${method} ${url.pathname}${template ? ` template=${template}` : ''}`)
  if (m === 'uncertain') throw new TypeError('fetch failed')
  if (m === 'failed') {
    return new Response(JSON.stringify({ error: { message: '(#132000) QA simulated rejection', type: 'OAuthException', code: 132000, fbtrace_id: 'QASIM' } }), { status: 400, headers: { 'content-type': 'application/json' } })
  }
  const wamid = `wamid.QASIM${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  return new Response(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: 'qa', wa_id: 'qa' }], messages: [{ id: wamid }] }), { status: 200, headers: { 'content-type': 'application/json' } })
}
