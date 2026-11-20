/* LOCAL ONLY. Shared helpers of the PR-01..PR-04 integrated QA tooling.
 * Refuses any Supabase host other than http://127.0.0.1:55321. Everything it creates is synthetic and marked "qa-pr04" (emails @qa-pr04.example.invalid,
 * accounts named "QA-PR04 ...", request keys "qa-pr04-..."), so `cleanup` removes ONLY that and nothing else. */
const { createRequire } = require('node:module')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..', '..')
const req = createRequire(path.join(REPO, 'package.json'))
const { createClient } = req('@supabase/supabase-js')

const QA_DIR = 'C:\\WACRM-LOCAL-QA' // outside the repo: state, fixtures, logs (nothing here is versioned)
const STATE_FILE = path.join(QA_DIR, 'state.json')
const MARK = 'qa-pr04'
const DOMAIN = 'qa-pr04.example.invalid'
const ACCOUNT_PREFIX = 'QA-PR04 '
const APP_URL = 'http://localhost:3000'

function loadEnv() {
  const out = {}
  for (const line of fs.readFileSync(path.join(REPO, '.env.local'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, '')
  }
  return out
}
const env = loadEnv()
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
if (URL_ !== 'http://127.0.0.1:55321') throw new Error(`refusing to run against ${URL_}`)
const noSession = { auth: { persistSession: false, autoRefreshToken: false } }
const admin = createClient(URL_, env.SUPABASE_SERVICE_ROLE_KEY, noSession)
const anonClient = () => createClient(URL_, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, noSession)

function encryptToken(text) {
  const crypto = require('node:crypto')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(env.ENCRYPTION_KEY, 'hex'), iv)
  let enc = cipher.update(text, 'utf8', 'hex')
  enc += cipher.final('hex')
  return `${iv.toString('hex')}:${enc}:${cipher.getAuthTag().toString('hex')}`
}

const readState = () => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null)
const writeState = (s) => {
  fs.mkdirSync(QA_DIR, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))
}

/** Cookie header that the app's @supabase/ssr reads for `session` (name derived from the host, value base64url, chunked at 3180). */
function sessionCookie(session) {
  const name = `sb-${new URL(URL_).hostname.split('.')[0]}-auth-token`
  const value = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
  const size = 3180
  if (value.length <= size) return `${name}=${value}`
  const parts = []
  for (let i = 0; i * size < value.length; i++) parts.push(`${name}.${i}=${value.slice(i * size, (i + 1) * size)}`)
  return parts.join('; ')
}

async function login(email, password) {
  const c = anonClient()
  const { data, error } = await c.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`login ${email}: ${error.message}`)
  return { client: c, session: data.session, cookie: sessionCookie(data.session), userId: data.user.id }
}

module.exports = { REPO, QA_DIR, STATE_FILE, MARK, DOMAIN, ACCOUNT_PREFIX, APP_URL, env, URL_, admin, anonClient, encryptToken, readState, writeState, sessionCookie, login, fs, path }
