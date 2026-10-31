#!/usr/bin/env bash
# Points the self-hosted Supabase Auth (GoTrue) at an SMTP relay (Brevo) WITHOUT touching any other service.
#   ./auth-smtp-apply.sh            dry run: prints the plan, writes nothing
#   ./auth-smtp-apply.sh --apply    asks for the values (password is not echoed), backs up .env, edits only the SMTP_* keys,
#                                   recreates ONLY the `auth` service, waits for healthy, rolls back by itself if it does not come up
# Secrets are never printed, never passed on a command line and never written anywhere but the stack .env (mode 600).
# Overridable for tests: STACK_DIR, COMPOSE_FILES (colon separated), AUTH_SERVICE, AUTH_CONTAINER.
set -euo pipefail
STACK_DIR="${STACK_DIR:-/opt/apps/supabase}"
COMPOSE_FILES="${COMPOSE_FILES:-docker-compose.yml:docker-compose.edge-proxy.yml}"
AUTH_SERVICE="${AUTH_SERVICE:-auth}"; AUTH_CONTAINER="${AUTH_CONTAINER:-supabase-auth}"
KEYS=(SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_ADMIN_EMAIL SMTP_SENDER_NAME)
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
cd "$STACK_DIR"; ENV_FILE="$STACK_DIR/.env"; umask 077
FILES=(); IFS=: read -ra CF <<< "$COMPOSE_FILES"; for f in "${CF[@]}"; do FILES+=(-f "$f"); done
dc() { docker compose "${FILES[@]}" "$@"; }

echo "Stack:   $STACK_DIR   service: $AUTH_SERVICE   container: $AUTH_CONTAINER"
[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found"; exit 1; }
for k in "${KEYS[@]}"; do grep -q "^$k=" "$ENV_FILE" || { echo "ERROR: $k is missing from .env (refusing to add keys)"; exit 1; }; done
grep -q '^ENABLE_EMAIL_AUTOCONFIRM=false' "$ENV_FILE" || { echo "ERROR: ENABLE_EMAIL_AUTOCONFIRM is not false; refusing"; exit 1; }
echo "Current SMTP host/port : $(grep '^SMTP_HOST=' "$ENV_FILE" | cut -d= -f2-) : $(grep '^SMTP_PORT=' "$ENV_FILE" | cut -d= -f2-)"
echo "Keys that will change  : ${KEYS[*]}   (nothing else in .env is modified)"
echo "Service that restarts  : $AUTH_SERVICE only (up -d --no-deps --force-recreate)"
if [ "$APPLY" -ne 1 ]; then echo "DRY RUN - nothing written. Re-run with --apply."; exit 0; fi

read -r -p "SMTP host [smtp-relay.brevo.com]: " V_HOST; V_HOST="${V_HOST:-smtp-relay.brevo.com}"
read -r -p "SMTP port [587]: " V_PORT; V_PORT="${V_PORT:-587}"
read -r -p "SMTP login (Brevo SMTP identifier): " V_USER
read -r -s -p "SMTP key (Brevo SMTP key, not the API key): " V_PASS; echo
read -r -p "Sender address (verified in Brevo): " V_ADMIN
read -r -p "Sender name [WhatsCRM]: " V_NAME; V_NAME="${V_NAME:-WhatsCRM}"
for v in "$V_HOST" "$V_PORT" "$V_USER" "$V_PASS" "$V_ADMIN" "$V_NAME"; do
  case "$v" in ''|*"'"*|*$'\n'*) echo "ERROR: empty value or value with a quote/newline"; exit 1;; esac; done
[[ "$V_PORT" =~ ^[0-9]+$ ]] || { echo "ERROR: port must be numeric"; exit 1; }
[[ "$V_ADMIN" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { echo "ERROR: sender is not an email address"; exit 1; }

BACKUP="$ENV_FILE.bak-smtp-$(date -u +%Y%m%dT%H%M%SZ)"; cp -p "$ENV_FILE" "$BACKUP"; chmod 600 "$BACKUP"
echo "$BACKUP" > "$STACK_DIR/.smtp-last-backup"; chmod 600 "$STACK_DIR/.smtp-last-backup"; echo "Backup: $BACKUP (mode 600)"
BEFORE="$(docker ps -q --no-trunc | sort | md5sum)"; OTHER_BEFORE="$(docker ps --format '{{.Names}} {{.ID}}' | grep -v " $(docker inspect -f '{{.Id}}' "$AUTH_CONTAINER" | cut -c1-12)" | sort | md5sum)"

# Values travel through the environment, never argv; only the six keys are rewritten, single-quoted so `$` is literal.
SMTP_HOST="$V_HOST" SMTP_PORT="$V_PORT" SMTP_USER="$V_USER" SMTP_PASS="$V_PASS" SMTP_ADMIN_EMAIL="$V_ADMIN" SMTP_SENDER_NAME="$V_NAME" \
ENV_FILE="$ENV_FILE" python3 - <<'PY'
import os, re
p = os.environ["ENV_FILE"]; keys = ["SMTP_HOST","SMTP_PORT","SMTP_USER","SMTP_PASS","SMTP_ADMIN_EMAIL","SMTP_SENDER_NAME"]
lines = open(p).read().split("\n")
for i, l in enumerate(lines):
    for k in keys:
        if l.startswith(k + "="):
            lines[i] = "%s='%s'" % (k, os.environ[k])
tmp = p + ".tmp"; fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f: f.write("\n".join(lines))
os.replace(tmp, p)
PY
chmod 600 "$ENV_FILE"
echo "Changed keys (names only):"; diff <(cut -d= -f1 "$BACKUP") <(cut -d= -f1 "$ENV_FILE") >/dev/null && echo "  key set unchanged"
for k in "${KEYS[@]}"; do cmp -s <(grep "^$k=" "$BACKUP") <(grep "^$k=" "$ENV_FILE") || echo "  $k"; done
echo "Other lines identical: $(diff <(grep -vE "^($(IFS='|'; echo "${KEYS[*]}"))=" "$BACKUP") <(grep -vE "^($(IFS='|'; echo "${KEYS[*]}"))=" "$ENV_FILE") >/dev/null && echo yes || echo NO)"

dc up -d --no-deps --force-recreate "$AUTH_SERVICE"
echo "Waiting for $AUTH_CONTAINER to be healthy..."
ok=0; for _ in $(seq 1 30); do s="$(docker inspect -f '{{.State.Health.Status}}' "$AUTH_CONTAINER" 2>/dev/null || echo none)"; [ "$s" = healthy ] && { ok=1; break; }; sleep 2; done
if [ "$ok" -ne 1 ]; then echo "NOT healthy -> rolling back"; "$(dirname "$0")/auth-smtp-rollback.sh"; exit 1; fi

echo "Effective configuration in the container (password masked):"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$AUTH_CONTAINER" | awk -F= '
  /^GOTRUE_SMTP_(HOST|PORT|ADMIN_EMAIL|SENDER_NAME)=/ {print "  "$0}
  /^GOTRUE_SMTP_USER=/ {print "  GOTRUE_SMTP_USER=<set, "length($0)-16" chars>"}
  /^GOTRUE_SMTP_PASS=/ {print "  GOTRUE_SMTP_PASS=<set, "length($0)-16" chars>"}
  /^GOTRUE_MAILER_AUTOCONFIRM=/ {print "  "$0}'
OTHER_AFTER="$(docker ps --format '{{.Names}} {{.ID}}' | grep -v " $(docker inspect -f '{{.Id}}' "$AUTH_CONTAINER" | cut -c1-12)" | sort | md5sum)"
[ "$OTHER_BEFORE" = "$OTHER_AFTER" ] && echo "Other containers untouched (same IDs): yes" || echo "WARNING: other containers changed"
echo "Done. Rollback any time with: $(dirname "$0")/auth-smtp-rollback.sh"
