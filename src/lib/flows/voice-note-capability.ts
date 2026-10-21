/**
 * Server-only gate for WhatsApp voice notes in Flows ("Audios por producto").
 *
 * Off by default: an empty or missing list means NO account can author, upload,
 * activate or send a voice note, which is today's behavior. An operator opts an
 * account in by adding its id to the list; the value is never sent to the
 * browser and is evaluated again by the editor's status endpoint, the upload
 * route, the save and activation routes, and the sender itself.
 *
 * It is deliberately independent of the F04/F06 flags (custom conditions,
 * versioning, subflows, durable waits, FLOW_AUTHORING_SCOPE): turning those on
 * or off never changes this one, and this one changes none of them.
 *
 * Operational limitation: removing an account takes effect on the next check.
 * A voice-note step in an already active flow then fails closed at the send
 * (the run ends with `send_media_failed`) instead of sending.
 */
export const VOICE_NOTE_ACCOUNT_IDS_ENV = "FLOW_VOICE_NOTE_ACCOUNT_IDS";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isVoiceNoteEnabledForAccount(accountId: string): boolean {
  if (typeof accountId !== "string" || !UUID.test(accountId)) return false;
  const wanted = accountId.toLowerCase();
  return (process.env[VOICE_NOTE_ACCOUNT_IDS_ENV] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => UUID.test(id))
    .some((id) => id.toLowerCase() === wanted);
}

/**
 * Scope of the Multimedia (`send_media`) audio option ONLY. `FLOW_MEDIA_AUDIO_SCOPE=all` offers it to every account, current and
 * future; anything else keeps today's behavior (only the accounts in FLOW_VOICE_NOTE_ACCOUNT_IDS). It never widens "Audios por
 * producto" (`send_product_audios`, its catalog API and its cron), which keep using `isVoiceNoteEnabledForAccount`.
 */
export const MEDIA_AUDIO_SCOPE_ENV = "FLOW_MEDIA_AUDIO_SCOPE";

export function isMediaAudioEnabledForAccount(accountId: string): boolean {
  if (typeof accountId !== "string" || !UUID.test(accountId)) return false;
  if ((process.env[MEDIA_AUDIO_SCOPE_ENV] ?? "").trim().toLowerCase() === "all") return true;
  return isVoiceNoteEnabledForAccount(accountId);
}
