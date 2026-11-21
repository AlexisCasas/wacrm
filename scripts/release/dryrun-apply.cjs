/* DATABASE DRY-RUN applier. LOCAL ONLY and ISOLATED: it refuses any target other than the docker container `dryrun-db` (an internal-network clone of the production backup).
 * It applies the 22 release migrations ONE BY ONE, in manifest order, each in its own transaction (psql -1, ON_ERROR_STOP, lock_timeout 3 s, statement_timeout 30 s: the
 * same discipline production operators use), checks the objects each file declares, writes the `.applied` record the real deploy would write (into a LOCAL directory) and
 * ABORTS on the first problem.
 *   node scripts/release/dryrun-apply.cjs <applied-dir> [--only <version>]            */
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const CONTAINER = 'dryrun-db'
const DB = 'wacrm_clone'
const repo = path.resolve(__dirname, '..', '..')
const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'supabase/release/migration-manifest.json'), 'utf8'))
const appliedDir = process.argv[2]
if (!appliedDir) { console.error('usage: dryrun-apply.cjs <applied-dir> [--only <version>]'); process.exit(1) }
fs.mkdirSync(appliedDir, { recursive: true })
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
function psql(args, input) {
  const r = spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'supabase_admin', '-d', DB, '-X', '-v', 'ON_ERROR_STOP=1', ...args], { input, encoding: 'utf8', maxBuffer: 1 << 26 })
  return { rc: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}
const q = (sql) => psql(['-At', '-c', sql]).out.trim()

// the target must be the isolated clone
const net = spawnSync('docker', ['inspect', CONTAINER, '--format', '{{json .NetworkSettings.Networks}} {{json .HostConfig.PortBindings}}'], { encoding: 'utf8' }).stdout
if (!net.includes('dryrun-int') || net.includes('"bridge"') || !/\{\}\s*$/.test(net.trim())) { console.error('refusing: target is not the isolated dry-run container'); process.exit(2) }

const declared = (sql) => {
  const code = sql.replace(/^\s*--.*$/gm, '')
  const tables = [...code.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(public\.[a-z_0-9]+)/gi)].map((m) => m[1])
  const fns = [...code.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (public\.[a-z_0-9]+)\(/gi)].map((m) => m[1])
  return { tables: [...new Set(tables)], fns: [...new Set(fns)] }
}

let failed = false
for (const r of manifest.release_migrations) {
  if (only && r.new_version !== only) continue
  const file = path.join(repo, 'supabase/migrations', r.new_file)
  const sql = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const checksum = sha(sql)
  const prev = path.join(appliedDir, r.new_file.replace(/\.sql$/, '.applied'))
  if (checksum !== r.sha256) { console.error(`ABORT ${r.new_file}: checksum ${checksum} != manifest ${r.sha256}`); process.exit(2) }
  if (fs.existsSync(prev)) { console.error(`ABORT ${r.new_file}: already recorded in ${appliedDir}`); process.exit(2) }
  const d = declared(sql)
  // none of the objects it CREATEs (not OR REPLACE) may pre-exist except the ones it replaces
  for (const t of d.tables) if (q(`select to_regclass('${t}') is not null`) === 't') { console.error(`ABORT ${r.new_file}: ${t} already exists in the clone`); process.exit(2) }

  const started = new Date()
  const t0 = Date.now()
  const res = psql(['-1'], `SET lock_timeout = '3s';\nSET statement_timeout = '30s';\n${sql}`)
  const ms = Date.now() - t0
  const tags = res.out.split('\n').filter((l) => /^[A-Z][A-Z ]+/.test(l)).slice(0, 40)
  const tagSummary = [...new Set(tags.map((t) => t.split(' ').slice(0, 2).join(' ')))].join('; ')
  console.log(`[${String(r.order).padStart(2, '0')}] ${r.new_file}  rc=${res.rc}  ${ms} ms`)
  if (res.rc !== 0) {
    console.error(res.err.split('\n').slice(0, 8).join('\n'))
    console.error(`ABORT at ${r.new_file}: psql exit code ${res.rc}. Nothing else is applied.`)
    process.exit(3)
  }
  const missing = []
  for (const t of d.tables) if (q(`select to_regclass('${t}') is not null`) !== 't') missing.push(t)
  for (const f of d.fns) if (q(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname='${f}'`) === '0') missing.push(`${f}()`)
  if (missing.length) { console.error(`ABORT ${r.new_file}: declared objects missing after apply: ${missing.join(', ')}`); process.exit(4) }
  const record = [
    `migration: supabase/migrations/${r.new_file}`,
    `commit: 0eddc0f733ba9656fc4b355e93db56e01e21472a`,
    `sha256: ${checksum}`,
    `applied_at_utc: ${started.toISOString()}..${new Date().toISOString()}   duration: ${ms} ms   rc=0`,
    `applied_by: dry-run (psql -1, ON_ERROR_STOP, lock_timeout=3s, statement_timeout=30s) on ISOLATED clone`,
    `backup: /opt/backups/wacrm/pr01-pr06-dryrun-predeploy-20261120T042242Z (restored into the clone)`,
    `result: ${tagSummary || 'ok'} (rc=0)`,
    `objects_checked: tables=${d.tables.length} functions=${d.fns.length}`,
    `original_release_version: ${r.old_version} (${r.old_file})`,
  ].join('\n')
  fs.writeFileSync(prev, `${record}\n`)
  console.log(`      ok: ${d.tables.length} table(s), ${d.fns.length} function(s) verified; recorded ${path.basename(prev)}`)
}
console.log(failed ? 'DRY-RUN FAILED' : only ? 'done (single migration)' : 'ALL 22 APPLIED ON THE ISOLATED CLONE')
