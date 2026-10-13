import { randomUUID } from 'node:crypto'
import { createSupabaseRunStore, type VersionedRunStore } from '../versioned-store'
import { createPsql, createPsqlSupabaseClient, lit } from './psql-client'

/**
 * Test-only harness over the isolated PostgreSQL container: synthetic published flows (inserted with
 * qa_synth_flow, the same app.flow_publication switch publish_flow_version uses), runs, state readers and
 * stores that simulate a dying process or a flaky transport. Requires the committed QA fixtures/helpers.
 */
const USER = '10000000-0000-4000-8000-000000000001'
const BASE_FLOW = '50000000-0000-4000-8000-000000000001'

export type NodeSpec = { key: string; type: string; config?: Record<string, unknown> }
export type StoreMethod = 'commitTransition' | 'pushSubflow' | 'popSubflow'

export function createHarness(container: string) {
  const psql = createPsql(container)
  const newStore = (): VersionedRunStore => createSupabaseRunStore(createPsqlSupabaseClient(psql))
  let acct = ''
  let contactSeq = 700
  const account = async () => (acct ||= await psql.sql(`select account_id from public.flows where id='${BASE_FLOW}'`))

  async function synth(flowId: string, nodes: NodeSpec[], entry: string): Promise<string> {
    const json = nodes.map((n) => ({ node_key: n.key, node_type: n.type, config: n.config ?? {} }))
    return psql.sql(`select public.qa_synth_flow('${flowId}', ${lit(json)}::jsonb, ${lit(entry)})`)
  }
  const call = (key: string, target: string, next: string): NodeSpec => ({ key, type: 'execute_flow', config: { target_flow_id: target, next_node_key: next } })
  const start = (key: string, next: string): NodeSpec => ({ key, type: 'start', config: { next_node_key: next } })
  const end = (key: string): NodeSpec => ({ key, type: 'end' })

  async function createRun(flowId: string): Promise<string> {
    const a = await account()
    return psql.sql(`select flow_run_id from public.create_versioned_flow_run('${a}','${flowId}',public.qa_new_contact(${++contactSeq}),null)`)
  }
  async function run(runId: string) {
    return (await psql.rows<Record<string, any>>(`select * from public.flow_runs where id='${runId}'`))[0] // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const frames = (runId: string) => psql.rows<{ depth: number; callee_flow_version_id: string; caller_flow_version_id: string; call_node_key: string; return_node_key: string }>(
    `select * from public.flow_run_call_frames where flow_run_id='${runId}' order by depth`)
  const events = (runId: string, type?: string) => psql.rows<{ event_type: string; node_key: string | null; payload: Record<string, unknown> }>(
    `select event_type,node_key,payload from public.flow_run_events where flow_run_id='${runId}' ${type ? `and event_type='${type}'` : ''} order by created_at, id`)
  const activeVersion = (flowId: string) => psql.sql(`select active_version_id from public.flows where id='${flowId}'`)
  const expireLease = (runId: string) => psql.sql(`update public.flow_runs set versioned_lease_expires_at = clock_timestamp() - interval '1 second' where id='${runId}'`)
  const id = () => randomUUID()

  /** Every method fails after the chosen call: the process is gone, nothing else can be asked of the database. */
  function dyingStore(real: VersionedRunStore, spec: { method: StoreMethod; when: 'before' | 'after'; nth?: number }): VersionedRunStore {
    let dead = false
    let seen = 0
    const wrapped = {} as Record<string, unknown>
    for (const [name, fn] of Object.entries(real) as Array<[string, (...a: unknown[]) => Promise<unknown>]>) {
      wrapped[name] = async (...args: unknown[]) => {
        if (dead) throw new Error('process is gone')
        if (name === spec.method && ++seen === (spec.nth ?? 1)) {
          if (spec.when === 'before') { dead = true; throw new Error('simulated crash before the call') }
          const res = await fn(...args)
          void res
          dead = true
          throw new Error('simulated crash after the call returned')
        }
        return fn(...args)
      }
    }
    return wrapped as unknown as VersionedRunStore
  }

  /** A transport that loses the answer (or the request) `times` times for one method, then recovers. */
  function flakyStore(real: VersionedRunStore, spec: { method: StoreMethod; when: 'before' | 'after'; times: number }) {
    let left = spec.times
    const calls = { n: 0 }
    const wrapped = { ...real } as Record<string, unknown>
    wrapped[spec.method] = async (...args: unknown[]) => {
      calls.n++
      const fn = (real as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[spec.method]
      if (left > 0) {
        left--
        if (spec.when === 'after') await fn(...args)   // the database committed, the answer was lost
        throw new Error('simulated transport failure')
      }
      return fn(...args)
    }
    return { store: wrapped as unknown as VersionedRunStore, calls }
  }

  return { psql, newStore, account, synth, call, start, end, createRun, run, frames, events, activeVersion, expireLease, id, dyingStore, flakyStore, USER, BASE_FLOW }
}
export type Harness = ReturnType<typeof createHarness>
