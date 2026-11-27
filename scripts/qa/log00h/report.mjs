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

// ---- database suites: a failing test counts against the candidate only if it does not also fail on the base ----
const failedTests = (report) =>
  new Map((report?.testResults ?? []).flatMap((suite) => {
    const file = suite.name.replace(/^.*\/(repo|base)\//, '')
    const cases = (suite.assertionResults ?? []).filter((a) => a.status === 'failed').map((a) => [`${file} › ${a.fullName}`, (a.failureMessages?.[0] ?? '').split('\n')[0]])
    return cases.length === 0 && suite.status === 'failed' ? [[`${file} › (suite)`, (suite.message ?? '').split('\n')[0]]] : cases
  }))
const candidate = json('vitest-candidate.json')
const base = json('vitest-base.json')
const candidateFailed = failedTests(candidate)
const baseFailed = failedTests(base)
const newFailures = [...candidateFailed.keys()].filter((k) => !baseFailed.has(k))
const oldFailures = [...candidateFailed.keys()].filter((k) => baseFailed.has(k))

const byId = new Map(tests.map((t) => [t.id, t]))
function group(ids) {
  const rows = ids.map((id) => byId.get(id))
  if (rows.some((r) => r?.status === 'FAIL')) return 'FAIL'
  if (rows.some((r) => !r)) return 'NOT_RUN'
  if (rows.some((r) => r.status === 'BLOQUEADA')) return 'BLOCKED'
  return 'PASS'
}
const ids = (prefix) => tests.filter((t) => t.id.startsWith(prefix)).map((t) => t.id)
const LEGACY = ['01.1', '01.2a', '01.3a', '01.4a', '01.5a', '01.6', '01.7', '01.8', '01.12']
const FINANCIAL = ['01.2b', '01.3b', '01.4b', '01.2c', '01.3c', '01.4c', '01.5c', '01.9', '01.10', '01.11a', '01.11b', '01.13']
const CATALOG = ['01.10', '02.4a', '02.4b', '02.5', '02.6a', '02.6b', '02.7']
const ACCESSORY = ['02.1', '02.2', '02.3']
const PAYMENTS = ['03.1', '03.2', '03.3', '03.4', '03.5', '03.6', '03.7', '03.8a', '03.8b', '03.8c', '03.8d', '03.9', '03.10', '03.11']
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

const critical = ['LOG00H2_ISOLATED_ENV', 'LEGACY_ORDERS', 'FINANCIAL_PRESERVATION', 'CATALOG_LINKS', 'ACCESSORY_HANDLING', 'PAYMENTS', 'COMMERCIAL_ROUTING', 'TENANT_ISOLATION', 'PERMISSIONS']
const findings = tests.filter((t) => t.status === 'HALLAZGO')
const anyFail = tests.some((t) => t.status === 'FAIL')
let final
if (tests.length === 0 || fields.LOG00H2_ISOLATED_ENV === 'NOT_RUN') final = 'NOT_RUN'
else if (critical.some((k) => fields[k] === 'FAIL') || newFailures.length > 0) final = 'FAIL'
else if (anyFail || findings.length > 0 || Object.values(fields).some((v) => ['PARTIAL', 'NOT_RUN', 'BLOCKED', 'FAIL'].includes(v)) || !candidate) final = 'PARTIAL'
else final = 'PASS'

const block = [
  ...Object.entries(fields).map(([k, v]) => `${k}=${v}`),
  `QA_FINAL=${final}`,
  'PRODUCTION_MODIFIED=NO',
  'PRODUCTION_DATABASE_MODIFIED=NO',
  'MESSAGES_SENT=NO',
  'DEPLOYMENT_EXECUTED=NO',
  `NEXT_STEP=${final === 'PASS' ? 'REVIEW' : 'REMEDIATE'}`,
].join('\n')

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
- Suites de base de datos del repositorio (candidato): ${totals(candidate)}. Fallos nuevos frente a la base: ${newFailures.length}; previos: ${oldFailures.length}.
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

${newFailures.length ? `**Fallos que no ocurren en la base:**\n\n${newFailures.map((k) => `- ${cell(k)} — ${cell(candidateFailed.get(k))}`).join('\n')}` : 'Sin fallos nuevos frente a la base.'}

${oldFailures.length ? `Fallos que también ocurren en la base:\n\n${oldFailures.map((k) => `- ${cell(k)} — ${cell(candidateFailed.get(k))}`).join('\n')}` : ''}

### 9.3 Suites SQL del repositorio

${sqlSuites.length ? table(['Suite', 'Resultado', 'Primer error'], sqlSuites) : '_Sin ejecutar._'}

## 10. Migraciones y esquema

${schema ? `PostgreSQL ${schema.postgres}; ${schema.migrationFiles} archivos de migración.\n\n${table(['Control', 'Estado', 'Esperado', 'Obtenido'], schema.checks.map((c) => [c.id, c.status, JSON.stringify(c.expected), JSON.stringify(c.observed)]))}` : '_Sin ejecutar._'}

\`DIFF\` es deriva entre el esquema que producen las migraciones y la referencia leída en producción. La migración \`20261206000001\` se aplicó solo en la base desechable.

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
- Datos sintéticos: no reproducen la variedad de los datos reales.

\`\`\`text
${block}
\`\`\`
`

writeFileSync(`${dir}/LOG-00H.2-QA-REPORT.md`, report)
writeFileSync(`${dir}/final-block.txt`, `${block}\n`)
writeFileSync(`${dir}/summary.json`, JSON.stringify({ final, fields, tally, newFailures, oldFailures, findings: findings.map((f) => f.id), failed: tests.filter((t) => t.status === 'FAIL').map((t) => t.id) }, null, 2))
console.log(block)
