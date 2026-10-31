/** Display helpers for contacts that may have no phone number (WhatsApp users identified by a BSUID). */
export interface DisplayableContact {
  name?: string | null
  phone?: string | null
  wa_username?: string | null
}

export function hasPhone(contact: DisplayableContact | null | undefined): boolean {
  return Boolean(contact?.phone && contact.phone.replace(/\D/g, ''))
}

/** Best human label, never the technical id: name, then @username, then phone. */
export function contactLabel(contact: DisplayableContact | null | undefined, fallback = ''): string {
  if (!contact) return fallback
  return contact.name?.trim() || (contact.wa_username ? `@${contact.wa_username}` : '') || (hasPhone(contact) ? String(contact.phone) : '') || fallback
}

/** Text a search box should match: name, phone and username (never any technical id). */
export function contactSearchText(contact: DisplayableContact | null | undefined): string {
  return [contact?.name, contact?.phone, contact?.wa_username].filter(Boolean).join(' ').toLowerCase()
}
