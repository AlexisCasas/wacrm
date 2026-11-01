export interface WhatsAppTileInput {
  configured: boolean
  /** Meta accepted the stored token. */
  connected: boolean
  /** false = valid credentials but the account is not receiving yet (saved with prepare_only). */
  receiving: boolean
}

export type WhatsAppTileState = 'not_setup' | 'connected' | 'credentials_only' | 'needs_reconnecting'

/** Which line the Settings overview shows for WhatsApp. "Connected" is reserved for an account that both has valid credentials AND receives. */
export function whatsappTileState(s: WhatsAppTileInput | null | undefined): WhatsAppTileState {
  if (!s?.configured) return 'not_setup'
  if (!s.connected) return 'needs_reconnecting'
  return s.receiving ? 'connected' : 'credentials_only'
}
