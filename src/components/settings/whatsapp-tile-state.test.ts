import { describe, expect, it } from 'vitest'
import { whatsappTileState } from './whatsapp-tile-state'

describe('whatsappTileState', () => {
  it('an operating account is "connected" (unchanged)', () => {
    expect(whatsappTileState({ configured: true, connected: true, receiving: true })).toBe('connected')
  })
  it('valid credentials but not receiving (prepared) is NOT shown as connected', () => {
    expect(whatsappTileState({ configured: true, connected: true, receiving: false })).toBe('credentials_only')
  })
  it('invalid credentials need reconnecting, whatever "receiving" says', () => {
    expect(whatsappTileState({ configured: true, connected: false, receiving: true })).toBe('needs_reconnecting')
    expect(whatsappTileState({ configured: true, connected: false, receiving: false })).toBe('needs_reconnecting')
  })
  it('no row, or still loading: not set up', () => {
    expect(whatsappTileState({ configured: false, connected: false, receiving: true })).toBe('not_setup')
    expect(whatsappTileState(null)).toBe('not_setup')
  })
})
