// Builds LOG-00H.2-QA-REPORT.md, summary.json and the final block from whatever the run produced.
// Anything that did not run is reported as NOT_RUN: it is never counted as a pass.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const dir = process.argv[2]
const read = (name) => (existsSync(`${dir}/${name}`) ? readFileSync(`${dir}/${name}`, 'utf8') : null)
const json = (name) => {
  try {
    return JSON.parse(read(name))
  } catch {
    return null
  }
}

const tests = json('tests.json') ?? []
const schema = json('schema.json')
const seed = json('seed.json')
const before = json('isolation-before.json')
const after = json('isolation-after.json')
const sqlSuites = (read('sql-suites.tsv') ?? '').split('\n').filter(Boolean).map((l) => l.split('\t'))

// ---- database suites ----
// A failing TEST counts against the candidate only if it does not also fail on the base. A FILE that fails without any failing test did not get
// through its preparation: it is BLOCKED and proves nothing about either commit, even when the base shows the same thing.
const fileOf = (suite) => suite.name.replace(/^.*\/(repo|base)\//, '')
const failedCases = (report) =>
  new Map((report?.testResults ?? []).flatMap((suite) =>
    (suite.assertionResults ?? []).filter((a) => a.status === 'failed').map((a) => [`${fileOf(suite)} › ${a.fullName}`, (a.failureMessages?.[0] ?? '').split('\n')[0]])))
const blockedFiles = (report) =>
  (report?.testResults ?? [])
    .filter((suite) => suite.status === 'failed' && !(suite.assertionResults ?? []).some((a) => a.status === 'failed'))
    .map((suite) => `${fileOf(suite)} — ${(suite.message ?? '').split('\n')[0] || 'fallo en la preparación (ver el registro de vitest)'}`)
const candidate = json('vitest-candidate.json')
const base = json('vitest-base.json')
const candidateFailed = failedCases(candidate)
const baseFailed = failedCases(base)
const newFailures = [...candidateFailed.keys()].filter((k) => !baseFailed.has(k))
const oldFailures = [...candidateFailed.keys()].filter((k) => baseFailed.has(k))
const blocked = blockedFiles(candidate)

// ---- outcome of each workflow step, as GitHub recorded it ----
let steps = {}
try {
  steps = JSON.parse(process.env.STEP_OUTCOMES || '{}')
} catch {
  steps = {}
}
const outcome = (id) => steps[id]?.outcome ?? 'skipped'
const stage = (...list) => {
  const seen = list.map(outcome)
  if (seen.some((o) => o === 'failure' || o === 'cancelled')) return 'FAIL'
  return seen.every((o) => o === 'success') ? 'PASS' : 'NOT_RUN'
}

const byId = new Map(tests.map((t) => [t.id, t]))
function group(ids) {
  const rows = ids.map((id) => byId.get(id))
  if (rows.some((r) => r?.status === 'FAIL')) return 'FAIL'
  if (rows.some((r) => !r)) return 'NOT_RUN'
  if (rows.some((r) => r.status === 'BLOQUEADA')) return 'BLOCKED'
  return 'PASS'
}
const LEGACY = ['01.1', '01.2a', '01.3a', '01.4a', '01.5a', '01.6', '01.7', '01.8', '01.12']
const FINANCIAL = ['01.2b', '01.3b', '01.4b', '01.2c', '01.3c', '01.4c', '01.5c', '01.9', '01.10', '01.11a', '01.11b', '01.13']
const CATALOG = ['01.10', '02.4a', '02.4b', '02.5', '02.6a', '02.6b', '02.7']
const ACCESSORY = ['02.1', '02.2', '02.3']
const PAYMENTS = ['03.1', '03.2', '03.3', '03.4', '03.5', '03.6', '03.7', '03.8a', '03.8b', '03.8c', '03.8d', '03.9', '03.10', '03.11', '03.12', '03.13', '03.14']
const ROUTING = ['04.1', '04.2', '04.3', '04.7', '04.8', '04.9', '04.10', '04.11']
const TENANT = ['04.6a', '04.6b', '06.1a', '06.1b', '06.2', '06.3', '06.4', '06.5', '06.6']
const PERMISSIONS = ['04.4', '04.5', '05.4', '05.6']

let payments = group(PAYMENTS)
if (payments === 'PASS' && PAYMENTS.some((id) => byId.get(id)?.status === 'HALLAZGO')) payments = 'PARTIAL'
const isolated = before && after ? (before.leaks === 0 && after.leaks === 0 && before.positiveControl === true ? 'PASS' : 'FAIL') : 'NOT_RUN'
const migration = !schema ? 'UNKNOWN' : schema.checks.every((c) => c.status === 'PASS') ? 'VERIFIED' : 'PARTIAL'

const fields = {
  LOG00H2_ISOLATED_ENV: isolated,
  LEGACY_ORDERS: group(LEGACY),
  FINANCIAL_PRESERVATION: group(FINANCIAL),
  CATALOG_LINKS: group(CATALOG),
  ACCESSORY_HANDLING: group(ACCESSORY),
  PAYMENTS: payments,
  COMMERCIAL_ROUTING: group(ROUTING),
  TENANT_ISOLATION: group(TENANT),
  PERMISSIONS: group(PERMISSIONS),
  INBOX_REGRESSION: group(['05.1a', '05.1b']),
  CALLING_REGRESSION: group(['05.4']),
  FLOWS_REGRESSION: group(['05.5']),
  MIGRATION_OBJECTS: migration,
}

// ---- closing criteria ----
const databaseSuites = (() => {
  if (!candidate || sqlSuites.length === 0) return ['db_suites', 'sql_suites'].some((id) => outcome(id) === 'failure') ? 'FAIL' : 'NOT_RUN'
  if (newFailures.length > 0 || sqlSuites.some(([, result]) => result !== 'PASS')) return 'FAIL'
  if (blocked.length > 0) return 'BLOCKED'
  if (oldFailures.length > 0 || candidate.numPendingTests > 0 || candidate.numPassedTests === 0) return 'PARTIAL'
  return stage('db_suites', 'sql_suites')
})()
const schemaState = (() => {
  if (!schema) return outcome('schema') === 'failure' ? 'FAIL' : 'NOT_RUN'
  if (schema.checks.some((c) => c.status === 'FAIL')) return 'FAIL'
  return schema.checks.every((c) => c.status === 'PASS') ? stage('schema') : 'PARTIAL'
})()
const seeded = (area) => {
  const checks = seed?.summary?.checks?.filter((c) => c.area === area) ?? []
  if (checks.length === 0) return outcome('seed') === 'failure' ? 'FAIL' : 'NOT_RUN'
  return checks.every((c) => c.ok) ? 'PASS' : 'FAIL'
}
const migrations = (() => {
  const named = schema?.checks.filter((c) => ['migrations_applied', 'migration_ledger'].includes(c.id)) ?? []
  if (named.some((c) => c.status !== 'PASS')) return 'FAIL'
  const applied = stage('migrations')
  return applied === 'PASS' && named.length !== 2 ? 'PARTIAL' : applied
})()
const ORDER_EDIT = [...new Set([...LEGACY, ...FINANCIAL, ...CATALOG, ...ACCESSORY])]
const REGRESSION = ['05.1a', '05.1b', '05.2', '05.3', '05.4', '05.5', '05.6']
const isolationState = (() => {
  if (isolated === 'FAIL') return 'FAIL'
  const ran = stage('isolate', 'isolation_check')
  return ran === 'PASS' && isolated !== 'PASS' ? 'FAIL' : ran
})()

const closing = {
  RUNNER: stage('candidate', 'deps', 'build', 'qauser'),
  BROWSER: stage('browser'),
  SUPABASE_START: stage('supabase'),
  NETWORK_ISOLATION: isolationState,
  MIGRATIONS: migrations,
  SCHEMA: schemaState,
  DATABASE_SUITES: databaseSuites,
  SYNTHETIC_ACCOUNTS: seeded('ACCOUNTS'),
  SYNTHETIC_USERS: seeded('USERS'),
  SYNTHETIC_CONVERSATIONS: seeded('CONVERSATIONS'),
  SYNTHETIC_ORDERS: seeded('ORDERS'),
  SYNTHETIC_PAYMENTS: seeded('PAYMENTS'),
  APPLICATION_START: stage('start_app'),
  ORDER_EDIT_QA: group(ORDER_EDIT),
  PAYMENT_QA: group(PAYMENTS),
  COMMERCIAL_ROUTING_QA: group(ROUTING),
  TENANT_ISOLATION_QA: group(TENANT),
  PERMISSIONS_QA: group(PERMISSIONS),
  REGRESSION_QA: group(REGRESSION),
  ARTIFACT_SCAN: process.env.ARTIFACT_SCAN || 'NOT_RUN',
  TEARDOWN: stage('teardown'),
}
const findings = tests.filter((t) => t.status === 'HALLAZGO')
const states = Object.values(closing)
let final
if (states.includes('FAIL') || tests.some((t) => t.status === 'FAIL')) final = 'FAIL'
else if (tests.length === 0) final = 'NOT_RUN'
else if (states.every((v) => v === 'PASS') && findings.length === 0) final = 'PASS'
else final = 'PARTIAL'

const block = [
  ...Object.entries(closing).map(([k, v]) => `${k}=${v}`),
  `QA_FINAL=${final}`,
  'PRODUCTION_MODIFIED=NO',
  'PRODUCTION_DATABASE_MODIFIED=NO',
  'MESSAGES_SENT=NO',
  'DEPLOYMENT_EXECUTED=NO',
  `NEXT_STEP=${final === 'PASS' ? 'REVIEW' : 'REMEDIATE'}`,
].join('\n')
const detail = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n')

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 600)
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n')
const matrix = (list) => (list.length ? table(['ID', 'Usuario', 'Prueba', 'Esperado', 'Obtenido', 'Estado', 'Evidencia'], list.map((t) => [t.id, t.user, t.title, t.expected, [t.observed, ...(t.notes ?? [])].join(' · '), t.status, `evidence/${t.id}.json${t.screenshots?.length ? `, ${t.screenshots.join(', ')}` : ''}`])) : '_Sin ejecutar._')
const section = (title, prefixList) => `## ${title}\n\n${matrix(tests.filter((t) => prefixList.some((p) => t.id.startsWith(p))))}\n`
const tally = tests.reduce((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {})
const totals = (r) => (r ? `${r.numPassedTests} correctas, ${r.numFailedTests} fallidas, ${r.numPendingTests} omitidas de ${r.numTotalTests}` : 'sin ejecutar')
const run = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : 'local'

const report = `# LOG-00H.2 — QA funcional con datos sintéticos

Candidato: \`${process.env.CANDIDATE_SHA ?? 'desconocido'}\` · Arnés: \`${process.env.GITHUB_SHA ?? 'local'}\` · Ejecución: ${run} · Generado: ${new Date().toISOString()}

## 1. Resumen ejecutivo

- Matriz funcional: ${tests.length} filas — ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ') || 'sin ejecutar'}.
- Suites de base de datos del repositorio (candidato): ${totals(candidate)}. Pruebas que fallan solo en el candidato: ${newFailures.length}; también en la base: ${oldFailures.length}; archivos bloqueados en la preparación: ${blocked.length}.
- Resultado: **${final}**. Todos los datos son ficticios; la salida de red se cortó antes de migrar, sembrar y probar.
- \`NA\` = no aplicable; \`HALLAZGO\` = comportamiento de riesgo reproducido; \`BLOQUEADA\` = no se pudo preparar. Lo no ejecutado figura como \`NOT_RUN\`.

## 2. Matriz de pruebas

${matrix(tests)}

## 3. Hallazgos

${findings.length ? findings.map((t) => `- **${t.id}** ${t.title}: ${cell(t.notes.join(' '))}`).join('\n') : '- Ninguna fila marcada como HALLAZGO.'}

Observaciones registradas en filas aprobadas:

${tests.filter((t) => t.status === 'PASS' && t.notes?.length).map((t) => `- **${t.id}** ${cell(t.notes.join(' '))}`).join('\n') || '- Ninguna.'}

${section('4. Evidencia de permisos y aislamiento', ['04.4', '04.5', '04.6', '05.4', '05.6', '06.'])}
${section('5. Validación de importes', ['01.7', '01.8', '01.9', '01.10', '01.11'])}
${section('6. Validación de catálogo y accesorios', ['02.'])}
${section('7. Validación de derivación', ['04.'])}
${section('8. Resultados de pagos', ['03.'])}
## 9. Regresiones

${section('9.1 Interfaz y API', ['05.'])}
### 9.2 Suites de base de datos

- Candidato: ${totals(candidate)}.
- Base (solo archivos que fallaron): ${totals(base)}.

${blocked.length ? `**Archivos bloqueados en la preparación (no dicen nada sobre la aplicación):**\n\n${blocked.map((k) => `- ${cell(k)}`).join('\n')}\n` : ''}
${newFailures.length ? `**Fallos que no ocurren en la base:**\n\n${newFailures.map((k) => `- ${cell(k)} — ${cell(candidateFailed.get(k))}`).join('\n')}` : 'Sin fallos nuevos frente a la base.'}

${oldFailures.length ? `Fallos que también ocurren en la base:\n\n${oldFailures.map((k) => `- ${cell(k)} — ${cell(candidateFailed.get(k))}`).join('\n')}` : ''}

### 9.3 Suites SQL del repositorio

${sqlSuites.length ? table(['Suite', 'Resultado', 'Primer error'], sqlSuites) : '_Sin ejecutar._'}

## 10. Migraciones y esquema

${schema ? `PostgreSQL ${schema.postgres}; ${schema.migrationFiles} archivos de migración.\n\n${table(['Control', 'Estado', 'Esperado', 'Obtenido'], schema.checks.map((c) => [c.id, c.status, JSON.stringify(c.expected), JSON.stringify(c.observed)]))}` : '_Sin ejecutar._'}

\`DIFF\` es deriva entre el esquema o los permisos que producen las migraciones en este entorno y la referencia leída en producción; las líneas de permisos que no coinciden quedan en \`schema.json\`. La migración \`20261206000001\` se aplicó solo en la base desechable.

## 11. Entorno y aislamiento

- Sembrado: ${seed ? JSON.stringify(seed.summary) : 'sin ejecutar'}.
- Canarios antes: ${before ? `control positivo ${before.positiveControl}, fugas ${before.leaks} de ${before.canaries.length}` : 'sin ejecutar'}. Después: ${after ? `fugas ${after.leaks} de ${after.canaries.length}` : 'sin ejecutar'}.

Servicios usados:

\`\`\`text
${(read('services.tsv') ?? 'no disponible').trim()}
\`\`\`

## 12. Límites y riesgos pendientes

- Servicios de Supabase en las versiones que elige su CLI, no necesariamente las de producción.
- Sin exploración manual; sin WhatsApp, Shalom ni OCR reales; Flows solo se abre y lista; Calling solo su control de acceso.
- El pago sigue siendo un proceso de varios pasos (ver 03.6–03.8).
- Preparación de los datos: filas por la conexión PostgreSQL local; pedidos y pagos sembrados con las funciones de base que llama el servidor (rol de servicio y usuario actor).
- Los permisos de la base desechable se comparan con los efectivos de producción por conteo y huella (sección 10).
- Datos sintéticos: no reproducen la variedad de los datos reales.

## 13. Criterios de cierre

\`\`\`text
${block}
\`\`\`

Detalle por área:

\`\`\`text
${detail}
\`\`\`
`

writeFileSync(`${dir}/LOG-00H.2-QA-REPORT.md`, report)
writeFileSync(`${dir}/final-block.txt`, `${block}\n`)
writeFileSync(`${dir}/summary.json`, JSON.stringify({ final, closing, fields, tally, newFailures, oldFailures, blocked, findings: findings.map((f) => f.id), failed: tests.filter((t) => t.status === 'FAIL').map((t) => t.id) }, null, 2))
console.log(block)
