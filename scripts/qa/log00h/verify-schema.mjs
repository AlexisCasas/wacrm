// Verifies the schema built from the repository migrations. Hard checks stop the run; the rest are reported as drift.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'

const ref = JSON.parse(readFileSync(new URL('./schema-reference.json', import.meta.url), 'utf8'))
const url = process.env.QA_DB_URL
if (!/@(127\.0\.0\.1|localhost):54322\//.test(url ?? '')) throw new Error('refusing to run against a non-local database')
const sql = (q) => execFileSync('psql', [url, '-X', '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim()

const checks = []
const check = (id, expected, observed, hard = false) =>
  checks.push({ id, expected, observed, hard, status: JSON.stringify(expected) === JSON.stringify(observed) ? 'PASS' : hard ? 'FAIL' : 'DIFF' })

const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql'))
check('migrations_applied', files.length, Number(sql('select count(*) from supabase_migrations.schema_migrations')), true)

let ledger = 'VERIFY OK'
try {
  execFileSync(process.execPath, ['scripts/release/migration-ledger.cjs', 'verify'], { encoding: 'utf8' })
} catch (error) {
  ledger = String(error.stdout ?? error.message).split('\n').slice(0, 3).join(' | ')
}
check('migration_ledger', 'VERIFY OK', ledger, true)

check('item_type_column', 'text|NO|\'product\'::text',
  sql("select data_type||'|'||is_nullable||'|'||column_default from information_schema.columns where table_schema='public' and table_name='order_confirmation_items' and column_name='item_type'"), true)
check('item_type_constraint', "t|CHECK ((item_type = ANY (ARRAY['product'::text, 'accessory'::text])))",
  sql("select (case when convalidated then 't' else 'f' end)||'|'||pg_get_constraintdef(oid) from pg_constraint where conrelid='public.order_confirmation_items'::regclass and conname='order_confirmation_items_item_type_check'"), true)

const counts = {
  publicTables: "select count(*) from pg_tables where schemaname='public'",
  publicPolicies: "select count(*) from pg_policies where schemaname='public'",
  publicTriggers: "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal",
  publicTablesWithoutRls: "select count(*) from pg_tables where schemaname='public' and not rowsecurity",
}
for (const [id, q] of Object.entries(counts)) check(id, ref.counts[id], Number(sql(q)), id === 'publicTablesWithoutRls')

for (const [name, expected] of Object.entries(ref.functions)) {
  const hard = name === 'edit_order_confirmation'
  const row = sql(`select left(md5(replace(p.prosrc, E'\\r', '')),12), p.prosecdef,
      concat_ws(',', case when has_function_privilege('anon', p.oid, 'EXECUTE') then 'anon' end,
                     case when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'authenticated' end,
                     case when has_function_privilege('service_role', p.oid, 'EXECUTE') then 'service_role' end)
      from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='${name}'`)
  const [md5, secdef, grants] = row.split('\t')
  check(`function:${name}`, expected, { md5, securityDefiner: secdef === 't', execute: (grants ?? '').split(',').filter(Boolean) }, hard)
}

// ---- effective privileges: the permission tests only mean something if this database grants what the live one grants ----
for (const role of ['authenticated', 'service_role']) {
  check(`privilege_smoke:${role}:profiles`, 't', sql(`select has_table_privilege('${role}', 'public.profiles', 'select')`), true)
}
const privilegeLines = {
  tables: `select c.relname||':'||r.role||':'||concat(case when has_table_privilege(r.role,c.oid,'SELECT') then 'S' else '-' end, case when has_table_privilege(r.role,c.oid,'INSERT') then 'I' else '-' end,
      case when has_table_privilege(r.role,c.oid,'UPDATE') then 'U' else '-' end, case when has_table_privilege(r.role,c.oid,'DELETE') then 'D' else '-' end) as line
    from pg_class c cross join (values ('anon'),('authenticated'),('service_role')) r(role)
    where c.relnamespace='public'::regnamespace and c.relkind in ('r','p','v','m')`,
  functions: `select p.proname||'('||pg_get_function_identity_arguments(p.oid)||'):'||r.role||':'||case when has_function_privilege(r.role,p.oid,'EXECUTE') then 'X' else '-' end as line
    from pg_proc p cross join (values ('anon'),('authenticated'),('service_role')) r(role)
    where p.pronamespace='public'::regnamespace and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')`,
  columns: `select c.relname||'.'||a.attname||':'||a.attacl::text as line from pg_attribute a join pg_class c on c.oid=a.attrelid
    where c.relnamespace='public'::regnamespace and a.attacl is not null`,
}
const privilegeMatrix = {}
for (const [id, q] of Object.entries(privilegeLines)) {
  const [count, digest] = sql(`select count(*), md5(coalesce(string_agg(line, E'\\n' order by line collate "C"), '')) from (${q}) s`).split('\t')
  const observed = { count: Number(count), md5: digest }
  check(`privileges:${id}`, ref.privileges[id], observed)
  if (JSON.stringify(observed) !== JSON.stringify(ref.privileges[id])) privilegeMatrix[id] = sql(`select line from (${q}) s order by line collate "C"`).split('\n')
}

const versions = sql("select current_setting('server_version')")
writeFileSync(`${process.env.QA_RESULTS}/schema.json`, JSON.stringify({ postgres: versions, migrationFiles: files.length, checks, privilegeMatrix }, null, 2))
for (const c of checks) console.log(`${c.status.padEnd(4)} ${c.id}${c.status === 'PASS' ? '' : `  expected=${JSON.stringify(c.expected)} observed=${JSON.stringify(c.observed)}`}`)
if (checks.some((c) => c.status === 'FAIL')) process.exit(1)
