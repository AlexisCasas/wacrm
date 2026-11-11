import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const mig = read('supabase/migrations/20261120000000_order_confirm_stops_automations.sql')
const code = mig.replace(/^--.*$/gm, '')
const qa = read('qa/orders/order-confirm-stops-automations.sql')

const fnOf = (sql: string, start: string) => {
  const a = sql.indexOf(start)
  expect(a, `missing ${start}`).toBeGreaterThanOrEqual(0)
  return sql.slice(a, sql.indexOf('$$;', sql.indexOf('$$', a) + 2) + 3)
}
const WAIT = 'CREATE OR REPLACE FUNCTION schedule_automation_wait_if_contact_active('
const RETRY = 'CREATE OR REPLACE FUNCTION public.schedule_automation_retry_if_contact_active('
const ORDER = 'CREATE OR REPLACE FUNCTION public.create_order_confirmation('
const STOP = 'CREATE OR REPLACE FUNCTION public.stop_contact_automations_for_order('
const CHECK = 'CREATE OR REPLACE FUNCTION public.automation_run_stopped_by_order('
const FLOWCHECK = 'CREATE OR REPLACE FUNCTION public.flow_run_stopped_by_order('
const AICHECK = 'CREATE OR REPLACE FUNCTION public.ai_reply_stopped_by_order('

const guard = `  IF public.automation_run_stopped_by_order(p_account_id, p_contact_id, p_log_id) THEN
    RETURN FALSE;
  END IF;

`
const afterBlocked = '  IF v_blocked THEN\n    RETURN FALSE;\n  END IF;\n\n'

describe('migration 20261120000000 — Confirmar pedido stops the contact automations', () => {
  it('create_order_confirmation is the previous definition plus ONE stop call, executed only when the order row was really inserted', () => {
    const original = fnOf(read('supabase/migrations/20261105000000_order_confirmation_items.sql'), ORDER)
    const replaced = fnOf(mig, ORDER)
    const added = replaced.indexOf('    -- A NEWLY confirmed order')
    const end = replaced.indexOf('    RETURN QUERY SELECT v_id, TRUE;')
    expect(added).toBeGreaterThan(0)
    expect(replaced.slice(0, added) + replaced.slice(end)).toBe(original)
    // inside the `IF v_id IS NOT NULL` branch (a retry of the same request_key takes the ELSE branch and has no effect)
    expect(replaced.lastIndexOf('IF v_id IS NOT NULL THEN', added)).toBeGreaterThan(0)
    expect(replaced.indexOf('ELSE', end)).toBeGreaterThan(end)
    expect(replaced.slice(added, end)).toContain('PERFORM public.stop_contact_automations_for_order(')
    // failed confirmations raise BEFORE the insert: nothing reaches the stop call
    expect(replaced.indexOf("RAISE EXCEPTION 'feature_disabled'")).toBeLessThan(added)
    expect(replaced.indexOf('INSERT INTO order_confirmations AS o')).toBeLessThan(added)
  })

  it('the wait and retry schedulers are unchanged except for the stopped-by-order refusal after the blocked check', () => {
    for (const [start, source] of [[WAIT, 'supabase/migrations/044_contact_blocking.sql'], [RETRY, 'supabase/migrations/050_meta_rate_limit_retry.sql']] as const) {
      const original = fnOf(read(source), start)
      const replaced = fnOf(mig, start)
      expect(replaced).toBe(original.replace(afterBlocked, afterBlocked + guard))
      expect(replaced).not.toBe(original)
    }
  })

  it('stop function: pauses the SAME existing control, cancels Automation waits/retries and active Flow runs (durable waits included), never blocks the contact', () => {
    const stop = fnOf(mig, STOP)
    expect(stop).toMatch(/SECURITY DEFINER SET search_path = public/)
    expect(stop).toContain('PERFORM 1 FROM contacts WHERE id = p_contact AND account_id = p_account FOR UPDATE')
    expect(stop).toMatch(/INSERT INTO contact_automation_settings[\s\S]*keyword_automations_paused[\s\S]*ON CONFLICT \(contact_id\) DO UPDATE/)
    expect(stop).toMatch(/UPDATE flow_runs SET status = 'paused_by_agent', ended_at = v_now, end_reason = 'order_confirmed'\s+WHERE account_id = p_account AND contact_id = p_contact AND status = 'active'/)
    expect(stop).toMatch(/UPDATE automation_pending_executions SET status = 'done'\s+WHERE account_id = p_account AND contact_id = p_contact AND status IN \('pending', 'running'\)/)
    expect(stop).not.toMatch(/blocked|messages|DELETE|conversations/i)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.stop_contact_automations_for_order\(UUID, UUID, UUID\) FROM PUBLIC, anon, authenticated;\s*GRANT EXECUTE ON FUNCTION public\.stop_contact_automations_for_order\(UUID, UUID, UUID\) TO service_role;/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.ai_reply_stopped_by_order\(UUID, UUID, TIMESTAMPTZ\) FROM PUBLIC, anon, authenticated;\s*GRANT EXECUTE ON FUNCTION public\.ai_reply_stopped_by_order\(UUID, UUID, TIMESTAMPTZ\) TO service_role;/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.flow_run_stopped_by_order\(UUID, UUID, UUID\) FROM PUBLIC, anon, authenticated;\s*GRANT EXECUTE ON FUNCTION public\.flow_run_stopped_by_order\(UUID, UUID, UUID\) TO service_role;/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.automation_run_stopped_by_order\(UUID, UUID, UUID\) FROM PUBLIC, anon, authenticated;\s*GRANT EXECUTE ON FUNCTION public\.automation_run_stopped_by_order\(UUID, UUID, UUID\) TO service_role;/)
  })

  it('the Automation fence: refused when the contact is still paused BY the order, or when the log started at/before order_stop_at (Reanudar never lifts the second case)', () => {
    const check = fnOf(mig, CHECK)
    expect(check).toContain('s.order_stop_at IS NOT NULL')
    expect(check).toContain('s.keyword_automations_paused AND s.updated_at = s.order_stop_at')
    expect(check).toContain('l.created_at <= s.order_stop_at')
  })

  it('is additive: one nullable column, no table drop, no policy, no timeout, no data backfill', () => {
    expect(code.match(/ALTER TABLE/g)).toHaveLength(1)
    expect(code).toContain('ADD COLUMN IF NOT EXISTS order_stop_at TIMESTAMPTZ;')
    expect(code).not.toMatch(/DROP TABLE|CREATE POLICY|statement_timeout|TRUNCATE|UPDATE contacts|blacklist|tombstone/i)
  })

  it('"Reanudar" (PUT automation-pause) is untouched and cannot revive anything: it only writes contact_automation_settings.keyword_automations_paused', () => {
    const route = read('src/app/api/contacts/[id]/automation-pause/route.ts').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(route).not.toMatch(/flow_runs|automation_pending_executions|order_stop_at|automation_logs/)
    expect(route).toContain("keyword_automations_paused: body.paused")
    expect(route.match(/\.from\('/g)).toHaveLength(2) // contacts lookup + contact_automation_settings upsert
  })

  it('the confirm endpoint itself writes no automation state: the stop is atomic inside create_order_confirmation', () => {
    const route = read('src/app/api/orders/confirm/route.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(route).not.toMatch(/contact_automation_settings|flow_runs|automation_pending_executions|keyword_automations_paused/)
    expect(route).toContain("admin.rpc('create_order_confirmation'")
  })

  it('the behaviour QA script embeds exactly the migration functions (it cannot drift)', () => {
    const tmp = (s: string) => s
      .replaceAll('public.stop_contact_automations_for_order', 'pg_temp.stop_contact_automations_for_order')
      .replaceAll('public.automation_run_stopped_by_order', 'pg_temp.automation_run_stopped_by_order')
      .replaceAll('public.flow_run_stopped_by_order', 'pg_temp.flow_run_stopped_by_order')
      .replaceAll('public.ai_reply_stopped_by_order', 'pg_temp.ai_reply_stopped_by_order')
      .replaceAll('public.create_order_confirmation', 'pg_temp.create_order_confirmation')
      .replaceAll('public.schedule_automation_retry_if_contact_active', 'pg_temp.schedule_automation_retry_if_contact_active')
      .replaceAll('FUNCTION schedule_automation_wait_if_contact_active', 'FUNCTION pg_temp.schedule_automation_wait_if_contact_active')
      .replaceAll('SET search_path = public', 'SET search_path = pg_temp, public')
      .replaceAll('FROM order_seller_candidates(', 'FROM pg_temp.order_seller_candidates(')
    for (const [start, qaStart] of [
      [STOP, 'CREATE OR REPLACE FUNCTION pg_temp.stop_contact_automations_for_order('],
      [CHECK, 'CREATE OR REPLACE FUNCTION pg_temp.automation_run_stopped_by_order('],
      [FLOWCHECK, 'CREATE OR REPLACE FUNCTION pg_temp.flow_run_stopped_by_order('],
      [AICHECK, 'CREATE OR REPLACE FUNCTION pg_temp.ai_reply_stopped_by_order('],
      [ORDER, 'CREATE OR REPLACE FUNCTION pg_temp.create_order_confirmation('],
      [WAIT, 'CREATE OR REPLACE FUNCTION pg_temp.schedule_automation_wait_if_contact_active('],
      [RETRY, 'CREATE OR REPLACE FUNCTION pg_temp.schedule_automation_retry_if_contact_active('],
    ] as const) {
      expect(fnOf(qa, qaStart)).toBe(tmp(fnOf(mig, start)))
    }
  })

  it('the QA script covers every scenario required (1, 3-12)', () => {
    for (const label of ['AI1 contact still paused', 'AI3 after Reanudar an AI activity that STARTED BEFORE', 'AI4 after Reanudar a NEW customer interaction', 'AI6 a manual Pausar', '1 new confirmed order', '3 failed confirmation', '4 retry of the same request_key', '5/6 earlier Automation wait, Meta retry',
      '7 active Flow run', '8 durable wait previo', '9 new automation started after the sale', '10 Reanudar does not revive', '11 new confirmation after Reanudar', '12 the contact is NOT blocked']) {
      expect(qa).toContain(label)
    }
  })

  it('the Flow fence has the same two clauses: still paused by the order, or the run started at/before order_stop_at', () => {
    const flow = fnOf(mig, FLOWCHECK)
    expect(flow).toContain('s.keyword_automations_paused AND s.updated_at = s.order_stop_at')
    expect(flow).toContain('r.started_at <= s.order_stop_at')
    expect(flow).toContain('r.account_id = p_account')
    expect(flow).toContain('s.order_stop_at IS NOT NULL')
  })

  it('the AI fence has the same rule: still paused by the order (any reply), or AI activity that started at/before order_stop_at (even after Reanudar)', () => {
    const ai = fnOf(mig, AICHECK)
    expect(ai).toContain('s.keyword_automations_paused AND s.updated_at = s.order_stop_at')
    expect(ai).toContain('p_since IS NOT NULL AND p_since <= s.order_stop_at')
    expect(ai).toContain('s.order_stop_at IS NOT NULL')
    // the stop function writes updated_at and order_stop_at from the SAME timestamp: that equality is what identifies "paused by the order"
    const stop = fnOf(mig, STOP)
    expect(stop).toContain('VALUES (p_contact, p_account, TRUE, v_now, v_now, p_actor)')
    expect(stop).toContain('updated_at = EXCLUDED.updated_at')
  })

  it('4. a durable wait cannot resume once the run is not active: both the claim and the consume of migration 069 require status = active', () => {
    const wait = read('supabase/migrations/069_flow_durable_waits.sql')
    expect(fnOf(wait, 'CREATE FUNCTION public.claim_due_flow_waits(')).toContain("r.status = 'active' AND r.wait_until IS NOT NULL AND r.wait_until <= clock_timestamp()")
    expect(fnOf(wait, 'CREATE FUNCTION public.consume_flow_wait(')).toContain("r.status = 'active'")
    expect(fnOf(mig, STOP)).toContain("status = 'paused_by_agent'")
  })

  it('the fence is wired at the LAST point before any provider call: the shared guard, fed by every automatic sender', () => {
    const guard = read('src/lib/contacts/blocking.ts')
    expect(guard).toContain('"flow_run_stopped_by_order"')
    expect(guard).toContain('"automation_run_stopped_by_order"')
    expect(guard).toMatch(/origin && \(origin\.flowRunId \|\| origin\.automationLogId \|\| origin\.aiActivityStartedAt\) && \(await isExecutionStoppedByOrder/)
    const flowSend = read('src/lib/flows/meta-send.ts')
    expect(flowSend.match(/\{ flowRunId: (?:args|input)\.flowRunId, automationLogId: (?:args|input)\.automationLogId \}\)\n/g)).toHaveLength(3)
    expect(flowSend.match(/await assertContactCanReceive\(/g)).toHaveLength(3) // every guard call site carries the origin
    expect(read('src/lib/automations/meta-send.ts')).toContain('assertContactCanReceive(db, input.accountId, input.contactId, { automationLogId: input.automationLogId })')
    const engine = read('src/lib/automations/engine.ts')
    expect(engine.match(/automationLogId: args\.logId \?\? undefined/g)).toHaveLength(4)
    // manual sends use their own path (send-message.ts) and never call the guard with an origin
    expect(read('src/lib/whatsapp/send-message.ts')).not.toMatch(/AutomatedSendOrigin|flow_run_stopped_by_order|automation_run_stopped_by_order|isExecutionStoppedByOrder/)
    expect(read('src/lib/ai/send.ts')).toContain('{ aiActivityStartedAt: activityStartedAt }')
    expect(read('src/lib/ai/send.ts')).not.toMatch(/flowRunId|automationLogId/)
    // AI auto-reply: checked before generating, again right after generating (before handoff / reply-slot claim), and in the sender guard
    const ai = read('src/lib/ai/auto-reply.ts')
    expect(ai.match(/await stoppedByOrder\(\)/g)).toHaveLength(2)
    expect(ai.indexOf('if (await stoppedByOrder()) return')).toBeLessThan(ai.indexOf('await generateReply('))
    expect(ai.lastIndexOf('if (await stoppedByOrder()) return')).toBeGreaterThan(ai.indexOf('await generateReply('))
    expect(ai.lastIndexOf('if (await stoppedByOrder()) return')).toBeLessThan(ai.indexOf("'claim_ai_reply_slot'"))
    expect(read('src/lib/contacts/blocking.ts')).toContain('"ai_reply_stopped_by_order"')
    // the Audio Guide sequencer (and its deferred resumer) halts through the same helper
    expect(read('src/lib/audio-guide/sequencer.ts')).toContain('isExecutionStoppedByOrder(db as never, accountId, contactId, { flowRunId: runId })')
  })

  it('8. sidebar copy: no longer claims that active flows keep working, and says that confirming an order stops them (es, en, ko)', () => {
    for (const locale of ['es', 'en', 'ko']) {
      const hint = (JSON.parse(read(`messages/${locale}.json`)) as { Inbox: { sidebar: { automationsHint: string } } }).Inbox.sidebar.automationsHint
      expect(hint).not.toMatch(/Los flujos activos, botones e inicio manual siguen funcionando|Active flows, buttons and manual start keep working|진행 중인 플로우, 버튼, 수동 시작은 계속 작동합니다/)
      if (locale === 'es') expect(hint).toMatch(/Al confirmar un pedido también se detienen las automatizaciones, flujos y respuestas de IA de este contacto hasta que pulses Reanudar/)
      if (locale === 'en') expect(hint).toMatch(/Confirming an order also stops this contact's automations, flows and AI replies until you press Resume/)
      if (locale === 'ko') expect(hint).toMatch(/주문을 확인하면 재개를 누를 때까지 이 연락처의 자동화, 플로우, AI 답변도 중지됩니다/)
    }
  })
})
