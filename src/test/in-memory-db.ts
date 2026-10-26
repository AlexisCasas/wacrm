/**
 * Minimal in-memory stand-in for the Supabase query builder, used by tests of the contact / conversation / webhook logic.
 *
 * It models only what that code uses (select / eq / neq / in / is / like / order / limit / maybeSingle / single /
 * insert / update / upsert / rpc / head counts) and the database rules the logic depends on:
 *   - contacts: unique (account_id, digits-only phone) when the phone is not empty (migration 022);
 *   - contact_identities: unique (account_id, kind, value); the contact must belong to the same account (migration 077);
 *   - conversations: one per (account_id, contact_id) (migration 036);
 *   - messages: upsert with ignoreDuplicates on (conversation_id, message_id).
 * Its `resolve_bsuid_contact` / `link_contact_bsuid` mirror the SQL functions, which are verified against a real
 * PostgreSQL by qa/bsuid/run-migration-qa.sh. Unknown tables behave as empty.
 */
import { randomUUID } from 'node:crypto'

type Row = Record<string, unknown>
type Result = { data: unknown; error: { code?: string; message: string } | null; count?: number }

export interface InMemoryDb {
  tables: Record<string, Row[]>
  /** Calls to rpc(), in order. */
  rpcCalls: Array<{ name: string; args: Row }>
  /** Make the next read of `table` fail (infrastructure error). */
  failReads: Set<string>
  client: unknown
}

const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '')

export function createInMemoryDb(seed: Record<string, Row[]> = {}): InMemoryDb {
  const tables: Record<string, Row[]> = { contacts: [], contact_identities: [], contact_identity_audit: [], conversations: [], messages: [], whatsapp_config: [], ...seed }
  const db: InMemoryDb = { tables, rpcCalls: [], failReads: new Set(), client: null }
  let clock = Date.parse('2026-10-25T12:00:00Z')
  const tick = () => new Date((clock += 1000)).toISOString()

  function violatesUnique(table: string, row: Row, ignoreId?: unknown): boolean {
    const others = (tables[table] ?? []).filter((r) => r.id !== ignoreId)
    if (table === 'contacts') {
      const d = digits(row.phone)
      return d !== '' && others.some((r) => r.account_id === row.account_id && digits(r.phone) === d)
    }
    if (table === 'contact_identities') return others.some((r) => r.account_id === row.account_id && r.kind === row.kind && r.value === row.value)
    if (table === 'conversations') return others.some((r) => r.account_id === row.account_id && r.contact_id === row.contact_id)
    return false
  }
  function checkForeign(table: string, row: Row): boolean {
    if (table !== 'contact_identities') return true
    return tables.contacts.some((c) => c.id === row.contact_id && c.account_id === row.account_id)
  }

  function builder(table: string) {
    let op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
    let payload: Row | Row[] | null = null
    let head = false
    let wantCount = false
    const filters: Array<(r: Row) => boolean> = []
    let orderKey: string | null = null
    let orderAsc = true
    let limitN: number | null = null
    let selectAfterWrite = false
    let embedContact = false
    let embedConversation = false

    const matching = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))

    function run(): Result {
      if (op === 'select') {
        if (db.failReads.has(table)) return { data: null, error: { code: 'XX000', message: 'simulated read failure' } }
        let rows = matching().map((r) => ({ ...r }))
        if (embedConversation) rows = rows.map((r) => ({ ...r, conversations: { ...(tables.conversations.find((c) => c.id === r.conversation_id) ?? {}) } }))
        if (embedContact) rows = rows.map((r) => ({ ...r, contact: { ...(tables.contacts.find((c) => c.id === r.contact_id) ?? {}) } }))
        if (orderKey) rows.sort((a, b) => (String(a[orderKey!]) < String(b[orderKey!]) ? -1 : 1) * (orderAsc ? 1 : -1))
        if (limitN !== null) rows = rows.slice(0, limitN)
        return head ? { data: null, error: null, count: matching().length } : { data: rows, error: null, count: wantCount ? rows.length : undefined }
      }
      if (op === 'insert' || op === 'upsert') {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[]
        const out: Row[] = []
        for (const input of list) {
          const row: Row = { id: randomUUID(), created_at: tick(), updated_at: tick(), blocked: false, ...input }
          if (table === 'contacts') { row.phone_optional ??= false; row.wa_username ??= null; row.phone ??= '' }
          if (op === 'upsert' && table === 'messages') {
            if (tables.messages.some((m) => m.conversation_id === row.conversation_id && m.message_id === row.message_id)) continue
          }
          if (!checkForeign(table, row)) return { data: null, error: { code: '23503', message: 'foreign key violation' } }
          if (violatesUnique(table, row)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
          tables[table] = [...(tables[table] ?? []), row]
          out.push(row)
        }
        return { data: selectAfterWrite || op === 'upsert' ? out.map((r) => ({ ...r })) : null, error: null }
      }
      if (op === 'update') {
        const rows = matching()
        for (const r of rows) {
          const next = { ...r, ...(payload as Row) }
          if (table === 'contacts' && violatesUnique(table, next, r.id)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
          Object.assign(r, payload as Row)
        }
        return { data: selectAfterWrite ? rows.map((r) => ({ ...r })) : null, error: null }
      }
      const rows = matching()
      tables[table] = (tables[table] ?? []).filter((r) => !rows.includes(r))
      return { data: null, error: null }
    }

    const api: Record<string, unknown> = {
      select(cols?: string, opts?: { head?: boolean; count?: string }) {
        if (typeof cols === 'string' && cols.includes('contact:contacts(')) embedContact = true
        if (typeof cols === 'string' && cols.includes('conversations(')) embedConversation = true
        if (op === 'insert' || op === 'upsert' || op === 'update') selectAfterWrite = true
        else op = 'select'
        head = Boolean(opts?.head); wantCount = Boolean(opts?.count)
        return api
      },
      insert(row: Row | Row[]) { op = 'insert'; payload = row; return api },
      update(row: Row) { op = 'update'; payload = row; return api },
      upsert(row: Row | Row[]) { op = 'upsert'; payload = row; return api },
      delete() { op = 'delete'; return api },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return api },
      neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return api },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return api },
      is(c: string, v: unknown) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return api },
      like(c: string, pattern: string) {
        const suffix = pattern.replace(/^%/, '')
        filters.push((r) => String(r[c] ?? '').endsWith(suffix))
        return api
      },
      order(c: string, o?: { ascending?: boolean }) { orderKey = c; orderAsc = o?.ascending !== false; return api },
      limit(n: number) { limitN = n; return api },
      maybeSingle: async () => { const r = run(); return r.error ? r : { data: (r.data as Row[])?.[0] ?? null, error: null } },
      single: async () => { const r = run(); if (r.error) return r; const first = (r.data as Row[])?.[0]; return first ? { data: first, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } } },
      then: (ok: (v: Result) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    }
    return api
  }

  const rpcs: Record<string, (a: Row) => Result> = {
    resolve_bsuid_contact(a) {
      const found = tables.contact_identities.find((i) => i.account_id === a.p_account_id && i.kind === 'bsuid' && i.value === a.p_bsuid)
      if (found) return { data: [{ contact_id: found.contact_id, created: false }], error: null }
      const name = String(a.p_name ?? '').trim() || String(a.p_username ?? '').trim() || 'WhatsApp user'
      const contact: Row = { id: randomUUID(), account_id: a.p_account_id, user_id: a.p_owner_user_id, phone: '', phone_optional: true, name, wa_username: a.p_username ?? null, blocked: false, created_at: tick(), updated_at: tick() }
      tables.contacts.push(contact)
      tables.contact_identities.push({ id: randomUUID(), account_id: a.p_account_id, contact_id: contact.id, kind: 'bsuid', value: a.p_bsuid, superseded_at: null, send_authorized_remaining: 0, source: 'webhook' })
      if (a.p_parent_bsuid) tables.contact_identities.push({ id: randomUUID(), account_id: a.p_account_id, contact_id: contact.id, kind: 'parent_bsuid', value: a.p_parent_bsuid, superseded_at: null, source: 'webhook' })
      return { data: [{ contact_id: contact.id, created: true }], error: null }
    },
    link_contact_bsuid(a) {
      if (!tables.contacts.some((c) => c.id === a.p_contact_id && c.account_id === a.p_account_id)) return { data: null, error: { code: '42501', message: 'contact does not belong to this account' } }
      const owner = tables.contact_identities.find((i) => i.account_id === a.p_account_id && i.kind === 'bsuid' && i.value === a.p_bsuid)
      if (owner && owner.contact_id !== a.p_contact_id) return { data: [{ outcome: 'conflict', owner_contact_id: owner.contact_id }], error: null }
      if (a.p_supersedes) for (const i of tables.contact_identities) if (i.account_id === a.p_account_id && i.contact_id === a.p_contact_id && i.kind === 'bsuid' && i.value === a.p_supersedes && !i.superseded_at) i.superseded_at = tick()
      if (!owner) {
        for (const i of tables.contact_identities) if (i.account_id === a.p_account_id && i.contact_id === a.p_contact_id && i.kind === 'bsuid' && !i.superseded_at) i.superseded_at = tick()
        tables.contact_identities.push({ id: randomUUID(), account_id: a.p_account_id, contact_id: a.p_contact_id, kind: 'bsuid', value: a.p_bsuid, superseded_at: null, send_authorized_remaining: 0, source: a.p_supersedes ? 'system_change' : 'webhook' })
      }
      if (a.p_parent_bsuid && !tables.contact_identities.some((i) => i.account_id === a.p_account_id && i.kind === 'parent_bsuid' && i.value === a.p_parent_bsuid)) {
        tables.contact_identities.push({ id: randomUUID(), account_id: a.p_account_id, contact_id: a.p_contact_id, kind: 'parent_bsuid', value: a.p_parent_bsuid, superseded_at: null, source: 'webhook' })
      }
      if (a.p_username) { const c = tables.contacts.find((x) => x.id === a.p_contact_id); if (c) c.wa_username = String(a.p_username).trim() }
      return { data: [{ outcome: owner ? 'already_linked' : 'linked', owner_contact_id: a.p_contact_id }], error: null }
    },
    audit_bsuid_event(a) {
      tables.contact_identity_audit.push({ id: randomUUID(), account_id: a.p_account_id, contact_id: a.p_contact_id, event: a.p_event, origin: a.p_origin, detail: a.p_detail ?? {}, created_at: tick() })
      return { data: null, error: null }
    },
    authorize_bsuid_send(a) {
      const i = tables.contact_identities.find((x) => x.account_id === a.p_account_id && x.contact_id === a.p_contact_id && x.kind === 'bsuid' && !x.superseded_at)
      if (!i) return { data: null, error: { code: '42704', message: 'no active BSUID for this contact in this account' } }
      i.send_authorized_remaining = Number(a.p_count ?? 1)
      tables.contact_identity_audit.push({ id: randomUUID(), account_id: a.p_account_id, contact_id: a.p_contact_id, event: 'send_authorized', origin: null, detail: { count: a.p_count ?? 1 }, created_at: tick() })
      return { data: i.send_authorized_remaining, error: null }
    },
    consume_bsuid_send(a) {
      const i = tables.contact_identities.find((x) => x.account_id === a.p_account_id && x.contact_id === a.p_contact_id && x.kind === 'bsuid' && !x.superseded_at && Number(x.send_authorized_remaining ?? 0) > 0)
      if (!i) return { data: false, error: null }
      i.send_authorized_remaining = Number(i.send_authorized_remaining) - 1
      tables.contact_identity_audit.push({ id: randomUUID(), account_id: a.p_account_id, contact_id: a.p_contact_id, event: 'send_consumed', origin: a.p_origin, detail: { remaining: i.send_authorized_remaining }, created_at: tick() })
      return { data: true, error: null }
    },
    // Mirrors migration 078 (bsuid_flow_scope / bsuid_flow_send_check); the SQL itself is exercised against PostgreSQL by qa/bsuid.
    bsuid_flow_scope(a) {
      const settings = (tables.bsuid_flow_settings ?? []).find((x) => x.account_id === a.p_account_id && x.flows_enabled)
      if (!settings) return { data: [], error: null }
      const contact = tables.contacts.find((c) => c.id === a.p_contact_id && c.account_id === a.p_account_id)
      if (!contact) return { data: [], error: null }
      const ids = (tables.bsuid_flow_authorizations ?? [])
        .filter((x) => x.account_id === a.p_account_id && x.enabled && (!x.expires_at || new Date(String(x.expires_at)) > new Date()) && (!x.contact_id || x.contact_id === a.p_contact_id))
        .filter((x) => (tables.flows ?? []).some((f) => f.id === x.flow_id && f.account_id === a.p_account_id && f.status === 'active'))
        .map((x) => x.flow_id)
      return { data: [...new Set(ids)], error: null }
    },
    bsuid_flow_send_check(a) {
      const flag: Record<string, string> = { text: 'allow_text', media: 'allow_media', buttons: 'allow_buttons', list: 'allow_list', audio: 'allow_audio' }
      if (!flag[String(a.p_modality)]) return { data: 'bad_modality', error: null }
      const run = (tables.flow_runs ?? []).find((r) => r.id === a.p_run_id && r.account_id === a.p_account_id && r.contact_id === a.p_contact_id && r.status === 'active')
      if (!run) return { data: 'run_invalid', error: null }
      if (!(tables.bsuid_flow_settings ?? []).some((x) => x.account_id === a.p_account_id && x.flows_enabled)) return { data: 'flows_disabled', error: null }
      const flows = new Set<string>([String(run.flow_id)])
      if (run.current_flow_id) flows.add(String(run.current_flow_id))
      for (const fr of tables.flow_run_subflow_frames ?? []) if (fr.flow_run_id === run.id) flows.add(String(fr.callee_flow_id))
      for (const f of flows) {
        const auths = (tables.bsuid_flow_authorizations ?? [])
          .filter((x) => x.account_id === a.p_account_id && x.flow_id === f && x.enabled && (!x.expires_at || new Date(String(x.expires_at)) > new Date()) && (!x.contact_id || x.contact_id === a.p_contact_id))
          .sort((x, y) => Number(Boolean(y.contact_id)) - Number(Boolean(x.contact_id)))
        const auth = auths[0]
        if (!auth) return { data: 'flow_not_authorized', error: null }
        if (!auth[flag[String(a.p_modality)]]) return { data: 'modality_not_allowed', error: null }
      }
      return { data: 'ok', error: null }
    },
    record_blocked_inbound(a) {
      const c = tables.contacts.find((x) => x.id === a.p_contact_id && x.account_id === a.p_account_id)
      if (c) c.blocked_inbound_count = Number(c.blocked_inbound_count ?? 0) + 1
      return { data: null, error: null }
    },
  }

  db.client = {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Row) => {
      db.rpcCalls.push({ name, args })
      if (db.failReads.has(`rpc:${name}`)) return { data: null, error: { code: 'XX000', message: 'simulated rpc failure' } }
      return (rpcs[name] ?? (() => ({ data: null, error: null })))(args)
    },
    storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }) }) },
  }
  return db
}
