import { createHash } from 'node:crypto'

/**
 * Short, stable digest of a WhatsApp message id for logs. The `wamid` embeds the sender's identifier (a phone or a BSUID), so
 * where the sender is a phone-less user or could not be resolved, logs carry this digest instead: it still lets two lines about
 * the same message be correlated, and reveals nothing about who sent it.
 */
export function messageRef(messageId: unknown): string {
  return `ref:${createHash('sha256').update(String(messageId ?? '')).digest('hex').slice(0, 12)}`
}
