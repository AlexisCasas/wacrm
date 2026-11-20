import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { processWhatsAppCallingWebhookChange } from './calling-webhook-processor'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('processWhatsAppCallingWebhookChange feature gate', () => {
  it('does not query or persist calls while the global feature switch is off', async () => {
    vi.stubEnv('WHATSAPP_CALLING_ENABLED', '')
    const from = vi.fn()
    const rpc = vi.fn()
    const db = { from, rpc } as unknown as SupabaseClient

    await expect(processWhatsAppCallingWebhookChange(
      db,
      { field: 'calls', value: {} },
      '1100749476063768',
    )).resolves.toBeUndefined()

    expect(from).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })
})
