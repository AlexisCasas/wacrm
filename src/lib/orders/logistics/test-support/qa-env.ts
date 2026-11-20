// Shared setup for the PR-04 QA tests that run against the REAL local Supabase stack (never against anything else).
// LOCAL ONLY: any host other than http://127.0.0.1:55321 is refused. Everything is synthetic and removed by `dispose`.
import { randomBytes } from 'node:crypto'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const QA_ENABLED = Boolean(process.env.LOCAL_URL)
if (QA_ENABLED && process.env.LOCAL_URL !== 'http://127.0.0.1:55321') throw new Error(`refusing to run against ${process.env.LOCAL_URL}`)

const noSession = { auth: { persistSession: false, autoRefreshToken: false } }

export interface QaActor {
  id: string
  email: string
  password: string
  client: SupabaseClient
}

export interface QaWorld {
  admin: SupabaseClient
  anon: SupabaseClient
  tag: string
  acc: string
  accForeign: string
  owner: QaActor
  logi: QaActor
  logi2: QaActor
  sup: QaActor
  comm: QaActor
  viewer: QaActor
  foreign: QaActor
  /** Track a storage object for cleanup. */
  track(path: string | undefined | null): void
  ctxOf(actor: QaActor, accountId: string, role?: 'agent' | 'viewer' | 'admin' | 'owner'): { supabase: SupabaseClient; userId: string; accountId: string; role: 'agent' }
  /** A confirmed order inserted directly (as any order exists for the account). */
  mkOrder(accountId: string, key: string, fields?: Record<string, unknown>): Promise<string>
  dispose(): Promise<void>
}

export async function createWorld(bucket = 'order-docs'): Promise<QaWorld> {
  const env = process.env
  const admin = createClient(env.LOCAL_URL!, env.LOCAL_SERVICE!, noSession)
  const anon = createClient(env.LOCAL_URL!, env.LOCAL_ANON!, noSession)
  const tag = 'olq' + randomBytes(3).toString('hex')
  const created = { users: [] as string[], accounts: new Set<string>(), objects: [] as string[] }

  const mkUser = async (label: string): Promise<QaActor> => {
    const password = randomBytes(18).toString('base64url')
    const email = `${tag}-${label}@example.invalid`
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (error) throw error
    created.users.push(data.user.id)
    return { id: data.user.id, email, password, client: createClient(env.LOCAL_URL!, env.LOCAL_ANON!, noSession) }
  }
  const accountOf = async (u: QaActor) => ((await admin.from('profiles').select('account_id').eq('user_id', u.id).single()).data as { account_id: string }).account_id

  const owner = await mkUser('owner')
  const [logi, logi2, sup, comm, viewer, foreign] = await Promise.all([mkUser('logi'), mkUser('logi2'), mkUser('sup'), mkUser('comm'), mkUser('viewer'), mkUser('foreign')])
  const acc = await accountOf(owner)
  const accForeign = await accountOf(foreign)
  for (const u of [owner, logi, logi2, sup, comm, viewer, foreign]) created.accounts.add(await accountOf(u))
  for (const [u, role, accountRole] of [[logi, 'logistics', 'agent'], [logi2, 'logistics', 'agent'], [sup, 'supervisor', 'agent'], [comm, 'commercial', 'agent'], [viewer, 'logistics', 'viewer']] as const) {
    const a = await admin.from('profiles').update({ account_id: acc, account_role: accountRole }).eq('user_id', u.id)
    if (a.error) throw a.error
    const b = await admin.from('profiles').update({ operational_role: role }).eq('user_id', u.id)
    if (b.error) throw b.error
  }
  const f = await admin.from('profiles').update({ operational_role: 'supervisor' }).eq('user_id', foreign.id)
  if (f.error) throw f.error
  for (const a of [acc, accForeign]) {
    const s = await admin.from('order_integration_settings').upsert({ account_id: a, confirm_enabled: true, logistics_mvp_enabled: true, multiproduct_enabled: true })
    if (s.error) throw s.error
  }
  for (const u of [logi, logi2, sup, comm, viewer, foreign]) {
    const { error } = await u.client.auth.signInWithPassword({ email: u.email, password: u.password })
    if (error) throw error
  }

  return {
    admin,
    anon,
    tag,
    acc,
    accForeign,
    owner,
    logi,
    logi2,
    sup,
    comm,
    viewer,
    foreign,
    track: (path) => {
      if (path) created.objects.push(path)
    },
    ctxOf: (actor, accountId) => ({ supabase: actor.client, userId: actor.id, accountId, role: 'agent' as const }),
    async mkOrder(accountId, key, fields = {}) {
      const { data, error } = await admin
        .from('order_confirmations')
        .insert({
          account_id: accountId,
          customer_name: 'Cliente Prueba',
          dni: '12345678',
          phone: '51900000001',
          product: 'P',
          quantity: 1,
          price: 10,
          destination: 'Lima',
          seller_name: 'S',
          confirmed_by_name: 'S',
          request_key: `${tag}-${key}`,
          delivery_status: 'held',
          ...fields,
        })
        .select('id')
        .single()
      if (error) throw error
      return (data as { id: string }).id
    },
    async dispose() {
      if (created.objects.length) await admin.storage.from(bucket).remove(created.objects)
      for (const a of created.accounts) await admin.from('accounts').delete().eq('id', a)
      for (const id of created.users) await admin.auth.admin.deleteUser(id)
    },
  }
}

export const pdfBytes = (seed: string) => new TextEncoder().encode(`%PDF-1.7\n% ${seed} ${randomBytes(8).toString('hex')}\n`)
