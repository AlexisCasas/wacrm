import { vi } from 'vitest'
import { runVersionedFlow, type RunVersionedFlowOptions } from '../versioned-interpreter'
import type { EffectSender, OutboundRequest } from '../versioned-messaging'
import { createMetaEffectSender } from '../versioned-meta-sender'
import { createHarness, type NodeSpec } from './versioned-pg'
import type { MockMetaTransport } from './mock-meta-transport'

/**
 * Test-only kit shared by the PR #30 integration tests: a caller flow A (start -> call -> fin) that calls a callee B
 * (bstart -> bmsg -> bend) which sends one message, a run WITH a conversation, the Meta adapter wired to a scripted
 * transport, processes that die, and readers for the ledger, the Inbox and the link table. No network, synthetic token.
 */
export const TOKEN = 'SYNTHETIC-TOKEN-NOT-REAL-9f3a'
export const pass = (id: string, detail: string) => console.log(`QA-RESULT ${id} PASS ${detail}`)

export function createKit(container: string) {
  const h = createHarness(container)
  const { call, start, end } = h
  const msg = (key: string, text: string, next: string): NodeSpec => ({ key, type: 'send_message', config: { text, next_node_key: next } })
  const metaSender = (t: MockMetaTransport, extra: Record<string, unknown> = {}): EffectSender =>
    createMetaEffectSender({ transport: t, resolveContext: async () => ({ ok: true, phoneNumberId: '1234567890', accessToken: TOKEN, recipientPhone: '+37063949836' }), ...extra })
  type Proc = { runs: ReturnType<typeof h.newStore>; effects: ReturnType<typeof h.newEffectStore>; sender: EffectSender }
  const proc = (t: MockMetaTransport, extra: Record<string, unknown> = {}): Proc => ({ runs: h.newStore(), effects: h.newEffectStore(), sender: metaSender(t, extra) })
  /** A process that dies at the chosen effect-store call. */
  function dying(t: MockMetaTransport, target: { method: string; when: 'before' | 'after'; nth?: number }): Proc {
    const death = h.processDeath(); const inner = metaSender(t)
    return { runs: death.wrap(h.newStore()), effects: death.wrap(h.newEffectStore(), target), sender: death.wrap({ send: (r: OutboundRequest) => inner.send(r) }) }
  }
  const go = async (p: Proc, runId: string, owner: string, extra: Partial<RunVersionedFlowOptions> = {}, msgExtra: Record<string, unknown> = {}) =>
    runVersionedFlow(p.runs, { accountId: await h.account(), runId, owner, messaging: { effects: p.effects, sender: p.sender, ...msgExtra }, ...extra })
  let seq = 8000 + Math.floor(Math.random() * 2_000_000)
  async function flows() {
    const A = h.id(), B = h.id()
    await h.synth(B, [start('bstart', 'bmsg'), msg('bmsg', 'Hola {{vars.name}}', 'bend'), end('bend')], 'bstart')
    await h.synth(A, [start('start', 'call'), call('call', B, 'fin'), end('fin')], 'start')
    const runId = await h.psql.sql(`select public.qa_flow_run_conv('${A}', ${++seq})`)
    await h.psql.sql(`update public.flow_runs set vars='{"name":"Ana"}' where id='${runId}'`)
    const run = await h.run(runId)
    return { A, B, runId, conversationId: run.conversation_id as string }
  }
  type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const inbox = (conv: string) => h.psql.rows<Row>(`select * from public.messages where conversation_id='${conv}' order by created_at, id`)
  const effects = (runId: string) => h.psql.rows<Row>(`select * from public.flow_run_effects where flow_run_id='${runId}' order by occurrence_revision`)
  const links = (runId: string) => h.psql.rows<Row>(`select * from public.flow_run_effect_messages where flow_run_id='${runId}'`)
  const makeDue = (runId: string) => h.psql.sql(`update public.flow_run_effects set retry_not_before = clock_timestamp() - interval '1 second' where flow_run_id='${runId}' and retry_not_before is not null`)
  const secondsUntilRetry = async (runId: string) => Number(await h.psql.sql(`select extract(epoch from (retry_not_before - clock_timestamp())) from public.flow_run_effects where flow_run_id='${runId}'`))
  const outage = (on: boolean) => h.psql.sql(on ? `delete from public.qa_inbox_outage; insert into public.qa_inbox_outage values (true)` : `delete from public.qa_inbox_outage`)
  /** A switchable Inbox outage: while a row exists in qa_inbox_outage every insert into messages fails. */
  const installOutage = () => h.psql.sql(`create table if not exists public.qa_inbox_outage (on_flag boolean); delete from public.qa_inbox_outage;
    create or replace function public.qa_inbox_outage_fn() returns trigger language plpgsql as $f$ begin
      if exists (select 1 from public.qa_inbox_outage) then raise exception 'qa inbox outage' using errcode = 'P9997'; end if; return new; end $f$;
    drop trigger if exists qa_inbox_outage_trg on public.messages;
    create trigger qa_inbox_outage_trg before insert on public.messages for each row execute function public.qa_inbox_outage_fn();`)
  const removeOutage = () => h.psql.sql(`drop trigger if exists qa_inbox_outage_trg on public.messages; drop function if exists public.qa_inbox_outage_fn(); drop table if exists public.qa_inbox_outage;`)
  const trapNetwork = () => { const trap = vi.fn(() => { throw new Error('network access is forbidden in these tests') }); vi.stubGlobal('fetch', trap); return trap }
  return { h, msg, metaSender, proc, dying, go, flows, inbox, effects, links, makeDue, secondsUntilRetry, outage, installOutage, removeOutage, trapNetwork }
}
export type Kit = ReturnType<typeof createKit>
