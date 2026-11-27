// Runs the functional matrix in order. A failed row never stops the run; the verdict is computed by report.mjs.
// Optional: QA_ONLY=01,04 runs only those groups.
import { writeFileSync } from 'node:fs'

import { RESULTS, Runner } from './lib/harness.mjs'

const groups = ['qa01-orders', 'qa02-catalog', 'qa03-payments', 'qa04-routing', 'qa05-regression', 'qa06-isolation']
const only = process.env.QA_ONLY?.split(',')
const runner = new Runner()
const persist = () => writeFileSync(`${RESULTS}/tests.json`, JSON.stringify(runner.results, null, 2))

await runner.start()
try {
  for (const name of groups) {
    if (only && !only.some((n) => name.startsWith(`qa${n}`))) continue
    console.log(`\n== ${name}`)
    try {
      const module = await import(`./tests/${name}.mjs`)
      await module.register(runner)
    } catch (error) {
      runner.results.push({ id: `${name.slice(2, 4)}.0`, user: '—', title: `Grupo ${name}`, expected: 'El grupo se ejecuta', observed: String(error.message).slice(0, 800), status: 'BLOQUEADA', notes: [] })
      console.error(`group ${name} could not run: ${error.message}`)
    }
    persist()
  }
} finally {
  persist()
  await runner.stop()
}
const tally = runner.results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {})
console.log(`\n${runner.results.length} rows: ${JSON.stringify(tally)}`)
