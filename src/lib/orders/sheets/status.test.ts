import { describe, expect, it } from 'vitest'
import { emptyResult } from './exporter'
import { classifyExport, classifyReconcile, overall } from './status'

const r = (o: Partial<ReturnType<typeof emptyResult>> = {}) => ({ ...emptyResult(true), ...o })
describe('cron pass classification', () => {
  it('a clean pass and an idle pass are ok', () => { expect(classifyExport(r()).status).toBe('ok'); expect(classifyExport(r({ skipped: 'lease_held' })).status).toBe('ok') })
  it('expected retries of transient errors do not alert', () => {
    expect(classifyExport(r({ retried: 3, error: 'google_5xx' }))).toEqual({ status: 'retrying', reasons: ['google_5xx'] })
    expect(overall([{ account: 'a', ...classifyExport(r({ retried: 1, error: 'rate_limited' })) }]).http).toBe(200)
  })
  it.each([
    [{ error: 'layout_mismatch' }, 'layout_mismatch'], [{ mismatched: 1 }, 'row_content_mismatch'], [{ deadOutstanding: 2 }, 'dead_jobs'],
  ])('needs a person: %j', (o, why) => {
    const c = classifyExport(r(o)); expect(c.status).toBe('attention'); expect(c.reasons).toContain(why)
    expect(overall([{ account: 'a', ...c }]).http).toBe(500)
  })
  it('an account that threw is attention, and one bad account turns the whole pass red', () => {
    const bad = classifyExport({ error: 'account_failed' })
    expect(bad).toEqual({ status: 'attention', reasons: ['account_failed'] })
    expect(overall([{ account: 'a', status: 'ok', reasons: [] }, { account: 'b', ...bad }])).toEqual({ status: 'attention', http: 500 })
  })
  it('reconciliation differences are attention', () => {
    expect(classifyReconcile({ differences: 1 } as never).status).toBe('attention'); expect(classifyReconcile({ differences: 0 } as never).status).toBe('ok')
  })
})
