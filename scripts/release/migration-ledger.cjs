/* Release tooling (LOCAL, read-only on production: it never connects to anything). Production has NO supabase_migrations.schema_migrations: its ledger is one
 * `<version>_<name>.applied` file per migration under /opt/backups/wacrm/migrations-applied. This tool knows the 22 PR-02..PR-06 migrations of the integrated release
 * (supabase/release/migration-manifest.json) and prepares / checks that ledger WITHOUT touching it.
 *
 *   node scripts/release/migration-ledger.cjs verify                      the files of the working tree == the manifest (names, order, sha256 of the LF content, contiguous block,
 *                                                                          unique versions, strictly after every production / reserved version)
 *   node scripts/release/migration-ledger.cjs plan <applied-dir>          what a deploy would apply, given a COPY of the .applied directory: skip what is already recorded
 *                                                                          with the SAME sha256, ABORT (exit 2) when a version is recorded with a DIFFERENT sha256, fail when a
 *                                                                          prerequisite production migration is not recorded
 *   node scripts/release/migration-ledger.cjs record <file> <release-sha> [backup]   prints the .applied record a deploy should write for ONE migration (stdout only)
 *   node scripts/release/migration-ledger.cjs generate                    regenerates the manifest from the tree (maintainers only; review the diff)
 * One migration per .applied file; checksum = sha256 of the file with LF line endings (what `git show` / `git archive` yield, and what production's own records use). */
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '..', '..')
const MIG = path.join(repo, 'supabase', 'migrations')
const MANIFEST = path.join(repo, 'supabase', 'release', 'migration-manifest.json')

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex')
const versionOf = (f) => f.split('_')[0]
const fail = (msg, code = 1) => { console.error(msg); process.exit(code) }

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
}

function verify() {
  const m = loadManifest()
  const problems = []
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()
  const versions = files.map(versionOf)
  const dup = versions.filter((v, i) => versions.indexOf(v) !== i)
  if (dup.length) problems.push(`duplicate versions: ${[...new Set(dup)].join(', ')}`)

  const maxExternal = [...m.production_baseline.map((p) => p.version), ...m.reserved_external.map((r) => r.version)].sort().at(-1)
  let prev = null
  for (const r of m.release_migrations) {
    const p = path.join(MIG, r.new_file)
    if (!fs.existsSync(p)) { problems.push(`missing ${r.new_file}`); continue }
    if (sha(p) !== r.sha256) problems.push(`checksum differs: ${r.new_file}`)
    if (versionOf(r.new_file) !== r.new_version) problems.push(`version/name mismatch: ${r.new_file}`)
    if (r.new_version <= maxExternal) problems.push(`${r.new_file} is not strictly after the highest production/reserved version ${maxExternal}`)
    if (prev !== null && BigInt(r.new_version) !== BigInt(prev) + 1n) problems.push(`block is not contiguous at ${r.new_file}`)
    if (files.indexOf(r.new_file) !== files.indexOf(m.release_migrations[0].new_file) + (r.order - 1)) problems.push(`order differs in the folder at ${r.new_file}`)
    prev = r.new_version
  }
  for (const b of m.production_baseline) {
    const f = files.find((x) => versionOf(x) === b.version)
    if (!f) problems.push(`production migration ${b.version} is not in the tree`)
    else if (b.sha256 && sha(path.join(MIG, f)) !== b.sha256) problems.push(`production migration ${f} differs from the version production applied`)
  }
  const patches = m.patch_migrations || []
  for (const r of patches) {
    const p = path.join(MIG, r.new_file)
    if (!fs.existsSync(p)) problems.push(`missing patch ${r.new_file}`)
    else if (sha(p) !== r.sha256) problems.push(`checksum differs: ${r.new_file}`)
    if (r.new_version <= m.release_migrations.at(-1).new_version) problems.push(`patch ${r.new_file} is not after the release block`)
  }
  const known = new Set([...m.production_baseline.map((p) => p.version), ...m.release_migrations.map((r) => r.new_version), ...patches.map((r) => r.new_version)])
  const unknownAfterBaseline = files.filter((f) => versionOf(f) > m.historical_main_max && !known.has(versionOf(f)))
  if (unknownAfterBaseline.length) problems.push(`migrations not described by the manifest: ${unknownAfterBaseline.join(', ')}`)
  if (problems.length) fail(`VERIFY FAILED\n - ${problems.join('\n - ')}`, 2)
  console.log(`VERIFY OK: ${m.release_migrations.length} release migrations ${m.release_migrations[0].new_version}..${m.release_migrations.at(-1).new_version}, contiguous, unique, after ${maxExternal}, checksums match`)
}

function parseApplied(dir) {
  const out = new Map()
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.applied')) continue
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    out.set(versionOf(f), { file: f, sha256: (/^sha256:\s*([0-9a-f]{64})/m.exec(text) ?? [])[1] ?? null })
  }
  return out
}

function plan(dir) {
  if (!dir) fail('usage: plan <applied-dir>')
  const m = loadManifest()
  const applied = parseApplied(dir)
  const todo = []
  // 1. every release migration: not recorded -> apply; same checksum -> skip; DIFFERENT checksum -> abort
  for (const r of m.release_migrations) {
    const a = applied.get(r.new_version)
    if (!a) todo.push(r)
    else if (a.sha256 !== r.sha256) fail(`ABORT: ${r.new_version} is recorded as applied (${a.file}) with a DIFFERENT sha256 (${a.sha256 ?? 'none'} != ${r.sha256}). Nothing may be applied.`, 2)
  }
  // 2. the production migrations recorded by operators must still match the tree
  for (const b of m.production_baseline.filter((x) => x.recorded_in_applied)) {
    const a = applied.get(b.version)
    if (!a) fail(`ABORT: production prerequisite ${b.version}_${b.name} has no .applied record in ${dir}`, 2)
    if (a.sha256 !== b.sha256) fail(`ABORT: production record ${a.file} has sha256 ${a.sha256} but the tree has ${b.sha256}`, 2)
  }
  // 3. a recorded version that this release also claims under another name = collision
  for (const [v, a] of applied) {
    const claim = m.release_migrations.find((r) => r.new_version === v)
    if (claim && !a.file.includes(claim.new_file.replace(/\.sql$/, ''))) fail(`ABORT: version ${v} is recorded as ${a.file} but this release uses it for ${claim.new_file}`, 2)
  }
  console.log(todo.length === 0 ? 'PLAN: nothing to apply (every release migration is already recorded with the same checksum)' : `PLAN: apply ${todo.length} migration(s), ONE FILE AT A TIME, in this order:`)
  for (const r of todo) console.log(`  ${String(r.order).padStart(2, '0')}  ${r.new_file}  sha256=${r.sha256.slice(0, 12)}…`)
}

function record(file, release, backup) {
  if (!file || !release) fail('usage: record <migration-file> <release-sha> [backup-dir]')
  const m = loadManifest()
  const r = m.release_migrations.find((x) => x.new_file === path.basename(file))
  if (!r) fail(`${file} is not a release migration`)
  const body = [
    `migration: supabase/migrations/${r.new_file}`,
    `commit: ${release}`,
    `sha256: ${r.sha256}`,
    `applied_at_utc: <fill in at apply time: start..end>`,
    `applied_by: <operator session> (psql -1, ON_ERROR_STOP, lock_timeout=3s, statement_timeout=30s)`,
    `backup: ${backup ?? '<verified predeploy backup directory>'}`,
    `result: <psql command tags> (rc=<n>)`,
    `original_release_version: ${r.old_version} (${r.old_file})`,
    `note: production has no schema_migrations table; this file is the record. One migration per record; never bulk-apply.`,
  ].join('\n')
  console.log(body)
}

function generate() {
  // Maintainers only: rebuilds the checksums of the release block from the current tree, keeping the OLD -> NEW map already in the manifest.
  const m = loadManifest()
  for (const r of m.release_migrations) r.sha256 = sha(path.join(MIG, r.new_file))
  for (const b of m.production_baseline) {
    const f = fs.readdirSync(MIG).find((x) => versionOf(x) === b.version)
    if (f) b.sha256 = sha(path.join(MIG, f))
  }
  fs.writeFileSync(MANIFEST, `${JSON.stringify(m, null, 2)}\n`)
  console.log('manifest checksums regenerated; review the diff')
}

const [cmd, a, b, c] = process.argv.slice(2)
if (cmd === 'verify') verify()
else if (cmd === 'plan') plan(a)
else if (cmd === 'record') record(a, b, c)
else if (cmd === 'generate') generate()
else fail('usage: verify | plan <applied-dir> | record <file> <release-sha> [backup] | generate')
