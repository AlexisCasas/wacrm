import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  processCustomerMessages: vi.fn(),
}))

vi.mock('@/lib/orders/shalom/customer-message', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/orders/shalom/customer-message')
  >()

  return {
    ...actual,
    processCustomerMessages: mocks.processCustomerMessages,
  }
})

import { runShalomTick } from './poller'

const oldFlag = process.env.SHALOM_CUSTOMER_MESSAGES_ENABLED

afterEach(() => {
  if (oldFlag === undefined) {
    delete process.env.SHALOM_CUSTOMER_MESSAGES_ENABLED
  } else {
    process.env.SHALOM_CUSTOMER_MESSAGES_ENABLED = oldFlag
  }
  vi.clearAllMocks()
})

describe('Shalom cron customer messaging gate', () => {
  it.each([undefined, 'false'])(
    'does not send customer messages when flag is %s',
    async (flag) => {
      if (flag === undefined) {
        delete process.env.SHALOM_CUSTOMER_MESSAGES_ENABLED
      } else {
        process.env.SHALOM_CUSTOMER_MESSAGES_ENABLED = flag
      }

      const admin = {
        rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
      }

      const deps = {
        skipQueries: false,
        cfg: {
          batchSize: 0,
          leaseSeconds: 60,
        },
        now: () => new Date('2026-11-24T18:00:00Z'),
        sendMessage: vi.fn(),
      }

      await runShalomTick(admin as never, deps as never)

      expect(mocks.processCustomerMessages).not.toHaveBeenCalled()
      expect(deps.sendMessage).not.toHaveBeenCalled()
    }
  )
})
