#!/usr/bin/env bash
# Enrol or rotate the Meta Ads (read-only) token of ONE WACRM account, directly on the VPS, without ever showing it.
#
#   scripts/ops/meta-ads/set-token.sh --account-id <WACRM account uuid> --ad-account-id <numeric Meta Ad Account id, no "act_">
#        [--api-version v27.0] [--token-file /path/0600-file] [--enable] [--dry-run]
#
# The token is read from the terminal with echo OFF (or from a 0600 --token-file) and travels only:
#   - inside this process (a shell variable, never argv, never the environment of another command, never `set -x`),
#   - on stdin of `docker exec -i <app> node` (to encrypt it with the app's own ENCRYPTION_KEY: the key never leaves the container),
#   - on stdin of `curl -K -` (Authorization header; so it never appears in a process list or a URL).
# Only the ENCRYPTED value is written to the database. Nothing here prints the token, the ciphertext or any Meta response body.
#
# Steps: validate the token against Meta (ad account currency/timezone + one catalog row) -> encrypt -> upsert meta_ads_settings
# (enabled stays FALSE unless --enable is given AND validation passed) -> unpause the catalog sync state.
# --dry-run performs validation and encryption but writes NOTHING.
#
# Rotation = run it again with the new token, then revoke the old one in Meta Business Settings. Revocation = revoke in Meta, then clear the
# stored token with scripts/ops/meta-ads/clear-token.sql.
set -euo pipefail
umask 077

APP_CONTAINER="${APP_CONTAINER:-wacrm-app-1}"
DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENCRYPT_JS="${ENCRYPT_JS:-$HERE/../messaging-account/encrypt-secret.js}"

ACCOUNT_ID="" AD_ACCOUNT_ID="" API_VERSION="v27.0" TOKEN_FILE="" ENABLE=0 DRY=0
EXPECT_CURRENCY="${EXPECT_CURRENCY:-PEN}"
EXPECT_TIMEZONE="${EXPECT_TIMEZONE:-America/Bogota}"

die() { echo "ERROR: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --account-id) ACCOUNT_ID="${2:-}"; shift 2 ;;
    --ad-account-id) AD_ACCOUNT_ID="${2:-}"; shift 2 ;;
    --api-version) API_VERSION="${2:-}"; shift 2 ;;
    --token-file) TOKEN_FILE="${2:-}"; shift 2 ;;
    --enable) ENABLE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) die "unknown argument (never pass the token as an argument)" ;;
  esac
done

[[ "$ACCOUNT_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "--account-id must be a UUID"
[[ "$AD_ACCOUNT_ID" =~ ^[0-9]{6,25}$ ]] || die "--ad-account-id must be the numeric id without the act_ prefix"
[[ "$API_VERSION" =~ ^v[0-9]{2}\.[0-9]$ ]] || die "--api-version must look like v27.0"
[ -f "$ENCRYPT_JS" ] || die "encrypt helper not found: $ENCRYPT_JS"

# 1) Read the token without echo --------------------------------------------------------------
TOKEN=""
if [ -n "$TOKEN_FILE" ]; then
  [ -f "$TOKEN_FILE" ] || die "token file not found"
  perms="$(stat -c '%a' "$TOKEN_FILE")"
  [ "$perms" = "600" ] || [ "$perms" = "400" ] || die "token file must have mode 600 or 400"
  TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
else
  [ -r /dev/tty ] || die "no terminal available: use --token-file with a 0600 file"
  printf 'Meta Ads token (input hidden): ' > /dev/tty
  IFS= read -rs TOKEN < /dev/tty
  printf '\n' > /dev/tty
fi
[ -n "$TOKEN" ] || die "empty token"
[[ "$TOKEN" =~ ^[A-Za-z0-9_.-]{20,600}$ ]] || die "token has an unexpected shape (not stored, not sent)"

# 2) Validate against Meta (read-only calls; responses are parsed, never printed) ---------------
graph() { # $1 = path+query ; token goes in a curl config on stdin, never in argv
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -sS --max-time 30 -K - "https://graph.facebook.com/${API_VERSION}/$1"
}
jfield() { python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print("__invalid__"); sys.exit(0)
v=d
for k in sys.argv[1].split("."):
    v=v.get(k) if isinstance(v,dict) else None
print("__none__" if v is None else v)' "$1"; }

ACCT_JSON="$(graph "act_${AD_ACCOUNT_ID}?fields=currency,timezone_name,account_status" || true)"
CUR="$(printf '%s' "$ACCT_JSON" | jfield currency)"
TZN="$(printf '%s' "$ACCT_JSON" | jfield timezone_name)"
[ "$CUR" != "__invalid__" ] && [ "$CUR" != "__none__" ] || die "Meta rejected the token or the ad account is not readable (no details are printed on purpose)"
[ "$CUR" = "$EXPECT_CURRENCY" ] || die "ad account currency is not $EXPECT_CURRENCY (got: $CUR); nothing was stored"
[ "$TZN" = "$EXPECT_TIMEZONE" ] || die "ad account timezone is not $EXPECT_TIMEZONE (got: $TZN); nothing was stored"

CAT_JSON="$(graph "act_${AD_ACCOUNT_ID}/ads?fields=id,name&limit=1" || true)"
[ "$(printf '%s' "$CAT_JSON" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print("ok" if isinstance(d.get("data"),list) else "bad")
except Exception:
    print("bad")')" = "ok" ] || die "the catalog edge act_${AD_ACCOUNT_ID}/ads is not readable with this token; nothing was stored"
echo "Meta validation: token valid, ad account readable, currency=$CUR, timezone=$TZN, catalog edge OK"

# 3) Encrypt inside the app container (key never leaves it) -------------------------------------
ENC="$(printf '%s' "$TOKEN" | docker exec -i "$APP_CONTAINER" node -e "$(cat "$ENCRYPT_JS")")" || die "encryption failed"
[[ "$ENC" =~ ^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$ ]] || die "unexpected ciphertext shape"
unset TOKEN ACCT_JSON CAT_JSON

if [ "$DRY" = 1 ]; then echo "DRY RUN: validated and encrypted; NOTHING was written."; exit 0; fi

# 4) Store only the ciphertext ------------------------------------------------------------------
ENABLED_SQL="FALSE"; [ "$ENABLE" = 1 ] && ENABLED_SQL="TRUE"
docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
BEGIN;
INSERT INTO public.meta_ads_settings (account_id, ad_account_id, access_token_enc, api_version, currency, account_timezone, token_status, token_rotated_at, enabled, updated_at)
VALUES ('${ACCOUNT_ID}', '${AD_ACCOUNT_ID}', '${ENC}', '${API_VERSION}', '${EXPECT_CURRENCY}', '${EXPECT_TIMEZONE}', 'valid', now(), ${ENABLED_SQL}, now())
ON CONFLICT (account_id) DO UPDATE SET
  ad_account_id = EXCLUDED.ad_account_id, access_token_enc = EXCLUDED.access_token_enc, api_version = EXCLUDED.api_version,
  currency = EXCLUDED.currency, account_timezone = EXCLUDED.account_timezone,
  token_status = 'valid', token_rotated_at = now(), disabled_reason = NULL, disabled_at = NULL,
  enabled = public.meta_ads_settings.enabled OR EXCLUDED.enabled, updated_at = now();
UPDATE public.meta_ads_sync_state SET status = 'idle', consecutive_failures = 0, next_run_at = now(), lease_until = NULL, updated_at = now()
 WHERE account_id = '${ACCOUNT_ID}' AND job = 'catalog';
COMMIT;
SQL
unset ENC
echo "Stored (encrypted). enabled=$([ "$ENABLE" = 1 ] && echo requested || echo unchanged). The sync still needs META_ADS_ENABLED=true in the app and the cron entry."
