import { afterEach, describe, expect, it, vi } from 'vitest'
import { processWhatsAppCallingWebhookChange } from './calling-webhook-processor'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('processWhatsAppCallingWebhookChange feature gate', () => {
  it('does not query or persist calls while the global feature switch is off', async () => {
    vi.stubEnv('WHATSAPP_CALLING_ENABLED', '')
    const db = { from: vi.fn(), rpc: vi.fn() } as never

    await expect(processWhatsAppCallingWebhookChange(
      db,
      { field: 'calls', value: {} },
      '1100749476063768',
    )).resolves.toBeUndefined()

    expect(db.from).not.toHaveBeenCalled()
    expect(db.rpc).not.toHaveBeenCalled()
  })
})
