/**
 * Pick the `contacts[]` entry that belongs to a webhook `messages[]` entry.
 *
 * Meta pairs them by position in the common case, but the contract does not guarantee it for every batch (several
 * senders in one delivery). An entry whose explicit id (`wa_id` or `user_id`) matches the message's wins; the positional
 * entry is only the fallback. A positional entry that contradicts the message is not trusted downstream
 * (`resolveInboundIdentity` ignores its profile and ids).
 *
 * Lives outside the route file because a Next route module may only export route handlers.
 */
export interface PairableContact {
  wa_id?: string
  user_id?: string
}

export function pairContact<C extends PairableContact>(
  message: { from?: string; from_user_id?: string },
  contacts: C[],
  index: number,
): C | undefined {
  const digits = (v?: string) => (v ?? '').replace(/\D/g, '')
  const byPhone = message.from ? contacts.find((c) => c.wa_id && digits(c.wa_id) === digits(message.from)) : undefined
  if (byPhone) return byPhone
  const byUser = message.from_user_id ? contacts.find((c) => c.user_id && c.user_id === message.from_user_id) : undefined
  if (byUser) return byUser
  return contacts[index] || contacts[0]
}
