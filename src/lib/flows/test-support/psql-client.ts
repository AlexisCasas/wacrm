import { execFile } from 'node:child_process'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Test-only. Runs SQL inside the isolated PostgreSQL container (no network, no published ports)
 * through `docker exec psql`, and exposes just enough of the supabase-js surface (`rpc`,
 * `from().select().eq().maybeSingle()`, head/count selects) for createSupabaseRunStore to run
 * unchanged against a real database. Results mimic PostgREST: RETURNS TABLE functions yield an
 * array of row objects and failures come back as { code: SQLSTATE, message }.
 */

interface PgError { code: string; message: string }
const IDENT = /^[a-z_][a-z0-9_]*$/

export function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const text = typeof v === 'string' ? v : JSON.stringify(v)
  return `'${text.replace(/'/g, "''")}'`
}

export function createPsql(container: string) {
  function run(sql: string): Promise<{ stdout: string } | { error: PgError }> {
    return new Promise((resolve) => {
      execFile('docker', ['exec', '-i', container, 'psql', '-U', 'supabase_admin', '-h', '/var/run/postgresql', '-d', 'postgres',
        '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-c', sql], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolve({ stdout: stdout.trim() })
        const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(stderr)
        resolve({ error: m ? { code: m[1], message: m[2].trim() } : { code: 'psql', message: stderr || String(err) } })
      })
    })
  }
  /** Statement(s) whose text output is wanted; throws on SQL errors. */
  async function sql(q: string): Promise<string> {
    const r = await run(q)
    if ('error' in r) throw new Error(`${r.error.code}: ${r.error.message}`)
    return r.stdout
  }
  async function rows<T = Record<string, unknown>>(q: string): Promise<T[]> {
    return JSON.parse(await sql(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (${q}) t`)) as T[]
  }
  return { run, sql, rows }
}

export type Psql = ReturnType<typeof createPsql>

export function createPsqlSupabaseClient(psql: Psql): SupabaseClient {
  const rpc = (fn: string, args: Record<string, unknown>) => {
    if (!IDENT.test(fn)) throw new Error('bad function name')
    const named = Object.entries(args).map(([k, v]) => {
      if (!IDENT.test(k)) throw new Error('bad arg name')
      return `${k} => ${lit(v)}`
    }).join(', ')
    return psql.run(`select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from public.${fn}(${named}) r`).then((r) =>
      'error' in r ? { data: null, error: r.error } : { data: JSON.parse(r.stdout) as unknown, error: null })
  }
  const from = (table: string) => {
    if (!IDENT.test(table)) throw new Error('bad table name')
    const state = { cols: '*', filters: [] as string[], head: false, count: false }
    const exec = async (single: boolean) => {
      const where = state.filters.length ? ` where ${state.filters.join(' and ')}` : ''
      if (state.head) {
        const r = await psql.run(`select count(*) from public.${table}${where}`)
        return 'error' in r ? { data: null, count: null, error: r.error } : { data: null, count: Number(r.stdout), error: null }
      }
      const r = await psql.run(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select ${state.cols} from public.${table}${where}) t`)
      if ('error' in r) return { data: null, count: null, error: r.error }
      const list = JSON.parse(r.stdout) as unknown[]
      if (single && list.length > 1) return { data: null, count: null, error: { code: 'PGRST116', message: 'multiple rows' } }
      return { data: single ? (list[0] ?? null) : list, count: null, error: null }
    }
    const builder = {
      select(cols: string, opts?: { count?: string; head?: boolean }) {
        cols.split(',').forEach((c) => { if (!IDENT.test(c.trim())) throw new Error('bad column') })
        state.cols = cols; state.head = !!opts?.head; state.count = !!opts?.count
        return builder
      },
      eq(col: string, val: unknown) {
        if (!IDENT.test(col)) throw new Error('bad column')
        state.filters.push(`${col} = ${lit(val)}`)
        return builder
      },
      maybeSingle: () => exec(true),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => exec(false).then(resolve, reject),
    }
    return builder
  }
  return { rpc, from } as unknown as SupabaseClient
}
