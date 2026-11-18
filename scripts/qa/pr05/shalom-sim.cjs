/* LOCAL ONLY. Switch the FAKE Shalom scenario while the app is running (it is re-read on every query: no restart).
 *   node scripts/qa/pr05/shalom-sim.cjs show
 *   node scripts/qa/pr05/shalom-sim.cjs set <scenario> [numero_orden]     (without a number = the default for every guide)
 *   node scripts/qa/pr05/shalom-sim.cjs reset
 * Scenarios: origin transit destination delivered not_found invalid rate_limited credentials_401 credentials_403 server_500 server_502 server_503 server_504
 *            timeout hang invalid_json degraded_auth degraded_login degraded_order unknown   ("destination@2026-12-01T15:00:00Z" sets the arrival date Shalom reports) */
const C = require('./common.cjs')

const [cmd, a, b] = process.argv.slice(2)
const s = C.readScenarios()
if (cmd === 'set') {
  if (!C.validScenario(a)) throw new Error(`unknown scenario "${a}". Use one of: ${C.SCENARIOS.join(', ')}`)
  if (b) (s.byNumber ??= {})[b] = a
  else s.default = a
  C.writeScenarios(s)
} else if (cmd === 'reset') {
  C.writeScenarios({ default: 'origin', byNumber: {} })
} else if (cmd !== 'show') {
  throw new Error('usage: show | set <scenario> [numero_orden] | reset')
}
console.log(JSON.stringify(C.readScenarios(), null, 2))
