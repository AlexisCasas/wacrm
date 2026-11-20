import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ForbiddenError } from '@/lib/auth/account'
import { assertWhatsAppCallingEnabled } from './calling-config'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('assertWhatsAppCallingEnabled', () => {
  it('fails closed when the global environment switch is absent or false', async () => {
    vi.stubEnv('WHATSAPP_CALLING_ENABLED', '')
    const from = vi.fn()
    const supabase = { from } as unknown as SupabaseClient

    await expect(assertWhatsAppCallingEnabled(supabase, 'account-1'))
      .rejects.toBeInstanceOf(ForbiddenError)
    expect(from).not.toHaveBeenCalled()
  })

  it('fails closed when the per-number database switch is false', async () => {
    vi.stubEnv('WHATSAPP_CALLING_ENABLED', 'true')
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { calling_enabled: false }, error: null }),
    }
    const from = vi.fn().mockReturnValue(query)
    const supabase = { from } as unknown as SupabaseClient

    await expect(assertWhatsAppCallingEnabled(supabase, 'account-1'))
      .rejects.toBeInstanceOf(ForbiddenError)
  })

  it('allows access only when both switches are true', async () => {
    vi.stubEnv('WHATSAPP_CALLING_ENABLED', 'true')
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { calling_enabled: true }, error: null }),
    }
    const from = vi.fn().mockReturnValue(query)
    const supabase = { from } as unknown as SupabaseClient

    await expect(assertWhatsAppCallingEnabled(supabase, 'account-1')).resolves.toBeUndefined()
    expect(from).toHaveBeenCalledWith('whatsapp_config')
  })
})
