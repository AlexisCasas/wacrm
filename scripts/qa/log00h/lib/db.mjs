// Privileged preparation of the disposable database, through its local postgres connection ONLY.
// Nothing here simulates a user: what the tests verify goes through real sessions, the app's endpoints and its database functions.
// Values travel as psql variables and are written as :'name', which psql quotes as literals; no value is ever concatenated into SQL.
import { execFileSync } from 'node:child_process'

const URL = process.env.QA_DB_URL
if (!/@(127\.0\.0\.1|localhost):54322\//.test(URL ?? '')) throw new Error('refusing to run against a non-local database')

/**
 * Runs `statements` in ONE transaction and returns what psql printed (one line per row, columns separated by tabs).
 * A failure names the operation and the database error, and stops the caller: nothing is half applied.
 */
export function sql(operation, statements, params = {}) {
  const variables = Object.entries(params).flatMap(([name, value]) => {
    if (value === undefined || value === null) throw new Error(`seed ${operation}: parameter ${name} is empty`)
    return ['-v', `${name}=${value}`]
  })
  try {
    return execFileSync(
      'psql',
      [URL, '-X', '-q', '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '--single-transaction', ...variables, '-f', '-'],
      { input: statements, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim()
  } catch (error) {
    // never echo the command: its first argument is the connection string
    const reason = String(error.stderr ?? '').split('\n').filter(Boolean).slice(0, 4).join(' | ')
    throw new Error(`seed ${operation} failed: ${reason || `psql exit ${error.status}`}`)
  }
}

/** Same, for a statement that must touch exactly `expected` rows (it has to end in RETURNING). */
export function sqlRows(operation, statements, params, expected) {
  const out = sql(operation, statements, params)
  const rows = out ? out.split('\n') : []
  if (rows.length !== expected) throw new Error(`seed ${operation} failed: expected ${expected} row(s), got ${rows.length}`)
  return rows
}
