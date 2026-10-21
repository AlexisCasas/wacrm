import { timingSafeEqual } from "node:crypto";

/** Shortest secret the audio-guide operational endpoints accept: a short or guessable secret is refused, not tolerated. */
export const MIN_CRON_SECRET_LENGTH = 24;

/** Query-string names that must never carry the secret: URLs end up in proxy, access and shell-history logs. */
const FORBIDDEN_QUERY_PARAMS = ["secret", "token", "key", "cron_secret", "x-cron-secret", "authorization", "api_key", "apikey"];

export type CronAuthResult = { ok: true } | { ok: false; status: 400 | 401 | 503; error: string };

/**
 * Authenticates a scheduler/monitor call by the shared secret in the `x-cron-secret` HEADER only, compared in constant time. Never logs the
 * supplied value. A secret in the URL is refused outright (400) without being compared.
 */
export function authenticateCron(request: Request, expected = process.env.AUTOMATION_CRON_SECRET): CronAuthResult {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((name) => FORBIDDEN_QUERY_PARAMS.includes(name.toLowerCase()))) return { ok: false, status: 400, error: "secret_in_url_refused" };
  if (!expected || expected.length < MIN_CRON_SECRET_LENGTH) return { ok: false, status: 503, error: "cron not configured" };
  const supplied = Buffer.from(request.headers.get("x-cron-secret") ?? "");
  const wanted = Buffer.from(expected);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) return { ok: false, status: 401, error: "Unauthorized" };
  return { ok: true };
}
