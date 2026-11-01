// How a number came to be registered. Three different facts that must never be mixed up in an audit:
//   * 'wacrm'       - WACRM ran POST /register itself: `registered_at` holds the real time of that call.
//   * 'meta_prior'  - the number was already registered in Meta before WACRM (e.g. under a previous provider). WACRM never registered it, so
//                     `registered_at` stays NULL (no invented date); it counts as operational only because Meta confirms it AND the app is subscribed
//                     AND the account was activated.
//   * 'none'        - neither: not operational for inbound.
export type RegistrationSource = 'wacrm' | 'meta_prior' | 'none'

export interface RegistrationFacts {
  /** `whatsapp_config.registered_at` - set ONLY by a successful /register run by WACRM. */
  registeredAt: string | null | undefined
  /** `whatsapp_config.status` ('connected' once the account was activated / really saved). */
  status: string | null | undefined
  /** `whatsapp_config.subscribed_apps_at`. */
  subscribedAppsAt: string | null | undefined
  /** Meta's `status` of the number as read just now, or undefined when it could not be read. */
  metaPhoneStatus: string | null | undefined
}

export function registrationSource(f: RegistrationFacts): RegistrationSource {
  if (f.registeredAt != null) return 'wacrm'
  const activated = f.status === 'connected' && f.subscribedAppsAt != null
  if (activated && f.metaPhoneStatus === 'CONNECTED') return 'meta_prior'
  return 'none'
}

/** Inbound-operational: Meta can read the number, the app is subscribed, and registration is proven by WACRM (as always) or by Meta (prior). */
export function isRegistrationLive(args: { phoneMetadataOk: boolean; wabaSubscribed: boolean | null; source: RegistrationSource }): boolean {
  return args.phoneMetadataOk && (args.wabaSubscribed ?? false) && args.source !== 'none'
}
