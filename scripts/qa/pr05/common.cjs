/* LOCAL ONLY. Shared helpers of the PR-05 (Shalom tracking) QA tooling. Builds on the PR-04 integrated QA world (scripts/qa/pr04-integrated) and the
 * local Supabase only (refuses any other host). Nothing here talks to Shalom: the app runs the FAKE provider reading SHALOM_FAKE_SCENARIO_FILE. */
const L = require('../pr04-integrated/lib.cjs')
const { fs, path, admin } = L

const SCENARIO_FILE = path.join(L.QA_DIR, 'shalom-scenarios.json')
const SCENARIOS = [
  'origin', 'transit', 'destination', 'delivered', 'not_found', 'invalid', 'rate_limited', 'credentials_401', 'credentials_403',
  'server_500', 'server_502', 'server_503', 'server_504', 'timeout', 'hang', 'invalid_json', 'degraded_auth', 'degraded_login', 'degraded_order', 'unknown',
]

function readScenarios() {
  try {
    return JSON.parse(fs.readFileSync(SCENARIO_FILE, 'utf8'))
  } catch {
    return { default: 'origin', byNumber: {} }
  }
}
function writeScenarios(s) {
  fs.mkdirSync(L.QA_DIR, { recursive: true })
  fs.writeFileSync(SCENARIO_FILE, JSON.stringify(s, null, 2))
}
const validScenario = (spec) => SCENARIOS.includes(String(spec).split('@')[0])

function state() {
  const st = L.readState()
  if (!st) throw new Error('No QA world: run `node scripts/qa/pr04-integrated/seed.cjs create` first (app running).')
  return st
}

async function shipments(accountId) {
  const { data } = await admin.from('order_shipments').select('order_id, tracking_number, tracking_code, identifier_version, logistic_status, tracking_state, next_poll_at, last_polled_at, last_error_kind, last_error_code, consecutive_failures, destination_episode, destination_entered_at').eq('account_id', accountId).order('created_at')
  return data ?? []
}

module.exports = { L, admin, fs, path, SCENARIO_FILE, SCENARIOS, readScenarios, writeScenarios, validScenario, state, shipments }
