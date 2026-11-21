#!/usr/bin/env bash
set -euo pipefail

# CALL-03 release static contract. This is an early safeguard, NOT a
# production environment check nor authorization to migrate/deploy.
fail() {
  echo "CALLING_DARK_RELEASE=FAIL: $1" >&2
  exit 1
}
test -f src/lib/whatsapp/calling-pilot.ts || fail "missing pilot guard"
grep -Fq "if (process.env.WHATSAPP_CALLING_ENABLED !== 'true') return false" \
  src/lib/whatsapp/calling-pilot.ts || fail "default-off server flag removed"
grep -Fq 'isWhatsAppCallingPilotAllowed' \
  src/app/api/whatsapp/calls/route.ts || fail "API no longer calls pilot guard"
grep -Fq 'isWhatsAppCallingPilotAllowed' \
  src/lib/whatsapp/calling-pilot.test.ts || fail "pilot tests missing"
grep -Fq 'isWhatsAppCallingPhoneEnabled(change.value?.metadata?.phone_number_id)' \
  src/lib/whatsapp/webhook-processor.ts || fail "calling webhook does not gate incoming events"
grep -Fq 'if (isWhatsAppCallingPhoneEnabled(phoneNumberId))' \
  src/lib/whatsapp/webhook-processor.ts || fail "calling permission reply does not gate writes"
grep -Fq 'isWhatsAppCallingPhoneEnabled' \
  src/lib/whatsapp/calling-pilot.test.ts || fail "webhook pilot flag tests missing"
grep -Fq 'await processMessage(' \
  src/lib/whatsapp/webhook-processor.ts || fail "normal message handling missing"
for forbidden in \
  scripts/qa/whatsapp-calling/mock-graph/server.mjs \
  scripts/qa/whatsapp-calling/mock-graph/peer.html \
  scripts/qa/whatsapp-calling/mock-graph/Dockerfile \
  scripts/qa/whatsapp-calling/mock-graph/compose.qa-mock.override.yml; do
  test ! -e "$forbidden" || fail "QA-only mock included: $forbidden"
done
for migration in \
  20261129000000_whatsapp_calling_sessions_permissions.sql \
  20261130000000_whatsapp_calling_agent_attribution.sql \
  20261130000001_whatsapp_calling_signaling.sql \
  20261130000002_whatsapp_call_claim_no_reclaim_after_accept.sql \
  20261130000003_whatsapp_calling_inbound_association_lifecycle.sql \
  20261130000004_whatsapp_calling_authoritative_timing.sql \
  20261201000000_whatsapp_call_terminal_reservation.sql \
  20261201000001_whatsapp_call_signal_fencing.sql; do
  test -f "supabase/migrations/$migration" || fail "missing migration: $migration"
done
echo "CALLING_DARK_RELEASE=PASS_STATIC_ONLY"
echo "PROD_ENV_BACKUP_RESTORE_MIGRATIONS_META=NOT_VERIFIED"
