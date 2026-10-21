/**
 * Where a verified voice note lives, and how to tell that a URL points at one.
 *
 * A guide audio is stored ONCE, under a name derived from its own SHA-256:
 *
 *   voice-notes/account-<account_id>/<sha256>.ogg
 *
 * The `voice-notes` bucket has no write policy for ordinary users (migration
 * 073): only the server, after it has verified the bytes, writes there, and it
 * never overwrites. So a URL that follows this shape cannot start serving
 * different bytes later, and the account folder in the path is the proof of
 * which account owns it. Everything here is pure string handling (no I/O) so
 * the validator, the engine and the tests share one definition.
 */

export const VOICE_NOTE_BUCKET = "voice-notes";

/** Bucket the browser stages a candidate file in before the server verifies it. */
export const VOICE_NOTE_STAGING_BUCKET = "chat-media";

/**
 * Folder, inside the account folder of the staging bucket, that ONLY the voice-note editor writes to. Staged files live nowhere
 * else, which is what lets a cleanup recognise them without ever touching the Inbox's own media in the same bucket.
 */
export const VOICE_NOTE_STAGING_SUBFOLDER = "voice-staging";

/** The exact name the editor gives a staged file: `<epoch ms>-<sanitised name>.ogg` (see buildMediaPath). */
const STAGED_NAME = /^(\d{13})-[A-Za-z0-9_-]{1,40}\.ogg$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PATH_LENGTH = 300;

function normalizedUuid(value: string): string | null {
  return UUID.test(value) ? value.toLowerCase() : null;
}

/** `account-<uuid>/<sha256>.ogg` — the object path of a verified voice note. */
export function buildVoiceNoteObjectPath(accountId: string, sha256: string): string {
  const account = normalizedUuid(accountId);
  if (!account) throw new Error("invalid account id");
  if (!SHA256_HEX.test(sha256)) throw new Error("invalid sha256");
  return `account-${account}/${sha256}.ogg`;
}

/**
 * A staging path the browser is allowed to ask the server to verify: exactly
 * `account-<caller's account>/voice-staging/<file>.ogg`, plain segments only. Rejects the Inbox's own media (other folders of the
 * same bucket), another account's folder, traversal (`..`, `.`), empty segments, percent-encoding, backslashes and control
 * characters, so the value can be passed to Storage as-is.
 */
export function isSafeStagingPath(accountId: string, path: unknown): path is string {
  const account = normalizedUuid(accountId);
  if (!account || typeof path !== "string") return false;
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  const segments = path.split("/");
  if (segments.length !== 3) return false;
  if (segments[0] !== `account-${account}` || segments[1] !== VOICE_NOTE_STAGING_SUBFOLDER) return false;
  return SAFE_SEGMENT.test(segments[2]) && /\.ogg$/i.test(segments[2]);
}

/**
 * Whether `path` is, unmistakably, a file the voice-note editor staged: the staging folder of a real account and the editor's own
 * naming. Returns the epoch-ms stamp in its name (when it was staged), or `null` for anything else — which a cleanup must leave alone.
 */
export function stagedObjectTimestamp(path: unknown): { accountId: string; stagedAtMs: number } | null {
  if (typeof path !== "string" || path.length > MAX_PATH_LENGTH) return null;
  const segments = path.split("/");
  if (segments.length !== 3 || segments[1] !== VOICE_NOTE_STAGING_SUBFOLDER) return null;
  const folder = /^account-([0-9a-fA-F-]{36})$/.exec(segments[0]);
  const accountId = folder ? normalizedUuid(folder[1]) : null;
  const name = STAGED_NAME.exec(segments[2]);
  if (!accountId || !name) return null;
  return { accountId, stagedAtMs: Number(name[1]) };
}

/**
 * The public URL of a verified voice note: `<storage origin>/storage/v1/object/public/voice-notes/account-<id>/<sha256>.ogg`. It is
 * built, never read from user input, and always satisfies `isVoiceNoteUrlForAccount`. `origin` is the app's Supabase URL.
 */
export function buildVoiceNotePublicUrl(origin: string, accountId: string, sha256: string): string {
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    throw new Error("invalid storage origin");
  }
  return `${base.origin}/storage/v1/object/public/${VOICE_NOTE_BUCKET}/${buildVoiceNoteObjectPath(accountId, sha256)}`;
}

export interface ParsedVoiceNoteUrl {
  accountId: string;
  sha256: string;
  origin: string;
}

/** The pieces of a public voice-note URL, or `null` when it has any other shape. */
export function parseVoiceNoteUrl(url: unknown): ParsedVoiceNoteUrl | null {
  if (typeof url !== "string" || url.length === 0 || url.length > 600) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const match = new RegExp(
    `^/storage/v1/object/public/${VOICE_NOTE_BUCKET}/account-([0-9a-fA-F-]{36})/([0-9a-f]{64})\\.ogg$`,
  ).exec(parsed.pathname);
  if (!match) return null;
  const accountId = normalizedUuid(match[1]);
  if (!accountId) return null;
  return { accountId, sha256: match[2], origin: parsed.origin };
}

/**
 * The origin the app's Storage is served from, so a node cannot point Meta at
 * an arbitrary host that merely imitates the path. `null` when the deployment
 * does not publish one (tests, scripts), in which case the origin is not pinned.
 */
function configuredStorageOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * True only when `url` is a verified voice note owned by `accountId` — and,
 * when given, carries exactly the content hash recorded next to it.
 */
export function isVoiceNoteUrlForAccount(
  url: unknown,
  accountId: string,
  options: { sha256?: string; origin?: string | null } = {},
): boolean {
  const parsed = parseVoiceNoteUrl(url);
  const account = normalizedUuid(accountId);
  if (!parsed || !account || parsed.accountId !== account) return false;
  if (options.sha256 !== undefined && options.sha256 !== parsed.sha256) return false;
  const origin = options.origin === undefined ? configuredStorageOrigin() : options.origin;
  return origin === null || parsed.origin === origin;
}
