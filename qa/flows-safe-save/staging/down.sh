#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
docker rm -f "$LOCALPROXY" "$GW" "$APP" "$REST" "$AUTH" "$DB" >/dev/null 2>&1
docker network rm "$NET_INT" "$NET_FRONT" >/dev/null 2>&1
echo "staging removed (secrets kept in $STATE; delete the folder to forget them)"
