#!/usr/bin/env bash
# Builds the app on the HOST (needs internet once, for next/font) with the staging public settings baked in. No secret leaves $STATE.
set -euo pipefail
source "$(dirname "$0")/lib.sh"; load_env
cd "$ROOT"
NEXT_PUBLIC_SUPABASE_URL="$URL" NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" NEXT_PUBLIC_SITE_URL="$URL" npx next build 2>&1 | tail -15
