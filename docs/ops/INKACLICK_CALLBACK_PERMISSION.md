# CALL-04.1 — InkaClick callback permission (Meta-only setting)

**Scope:** single WACRM production business Phone Number ID `740434745820831` (InkaClick / Keyler), **without** new deploy, DB schema change, tenant changes, client consent bypass, webhook replay, messages, Flows, or automated test calls.

**Intent:** after a customer-initiated WhatsApp call (connected or missed), Meta may surface its callback consent UI. The customer remains responsible for permission; WACRM MUST re-check `call_permissions` and `canStartCall` before any outbound `connect`. The normal `ALLOW_APPROVED_PERMISSION_ONLY` model stays unchanged. This setting is **not** quality-based business-initiated calling.

Official sources (checked 23-Nov-2026):
- https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions/

## Preflight (no changes to Meta)

The scripts read `whatsapp_config.access_token` **encrypted**, using the live app's `SUPABASE_SERVICE_ROLE_KEY`, and decrypt it **in memory inside the live WACRM app container** using the existing app's GCM/CBC algorithm and `ENCRYPTION_KEY`. No token, ciphertext, decrypted SDP, contact ID or customer phone is printed.

Run on the VPS as an operator with access to the live Docker container and checked-out audited GitHub source. DO NOT run with `bash -x`, `set -x`, or copy internal token values into a chat. Exact source commit and Docker image must be verified independently.

```bash
set -euo pipefail
cd /root/wacrm-inkaclick
test "$(docker inspect -f '{{.Config.Image}}' wacrm-app-1)" = "wacrm-app:global-incoming-alert-9076c1c8"
test "$(docker inspect -f '{{.State.Health.Status}}' wacrm-app-1)" = "healthy"
test -z "$(git status --porcelain)"
# checkout exactly the commit stated in the PR release notes:
# git fetch origin ops/inkaclick-callback-permission-20261123
# git switch --detach <EXACT_AUDITED_PR_HEAD_SHA>
umask 077
docker exec -i wacrm-app-1 node - audit \
  < scripts/ops/calling-callback-permission-inkaclick.cjs
```

**Require before enabling:**
- `CALLING_MODE_GATE=PASS`, `READY_FOR_ENABLE=YES`.
- Sanitized `META_BEFORE`: `calling_status=ENABLED`, `callback_permission_status=DISABLED`, `call_permission_mode=ALLOW_APPROVED_PERMISSION_ONLY`, `sip_status=DISABLED` or `NOT_SET` (documented SIP default).
- GitHub CI and operator tests PASS; backup checksum verified, Caddy/Flows healthy, no active calls.
- If current callback is `NOT_SET`, `ENABLED`, or unknown, **STOP** to reconcile actual Meta state and rollback path. Do not assume the historical settings documented in CALL-01 are still current.
- Permission to mutate Meta must be explicitly given. Only use `enable` after a verified audit.

## One-setting activation (Meta API mutation; no WACRM redeploy)

```bash
docker exec \
  -e CALLBACK_CHANGE_APPROVED=YES \
  -e CALLBACK_EXPECTED_PHONE_NUMBER_ID=740434745820831 \
  -i wacrm-app-1 node - enable \
  < scripts/ops/calling-callback-permission-inkaclick.cjs
```

Expected output: `CALLS_GATE=PASS`, `META_POST=ACKNOWLEDGED`, `META_AFTER` with `callback_permission_status=ENABLED`, `CALLBACK_ENABLED=PASS`, `META_SETTINGS_CHANGED=YES_CALLBACK_ONLY`. The script:
- gates WACRM env to Keyler-only Calling + Flows;
- verifies the real tenant DB config and phone ID;
- does one Meta `GET /{PHONE_NUMBER_ID}/settings` before change;
- refuses any other permission mode, SIP enabled, or callback pre-state other than `DISABLED`;
- checks zero live sessions before POST;
- sends **only** `{"calling":{"callback_permission_status":"ENABLED"}}` to Meta, and performs read-after-write validation;
- compares other stable calling settings for unintended drift.

**Do not automatically retry the POST.** On timeout/uncertain response, run `verify` (GET-only) and diagnose actual Meta state.

## Verification (no writes)

```bash
docker exec -i wacrm-app-1 node - verify \
  < scripts/ops/calling-callback-permission-inkaclick.cjs
```

Observe `callback_permission_status=ENABLED`. The GET does not necessarily mean a particular customer has accepted: test with a **separate consented customer who currently lacks outgoing permission**, because Alexis's phone had an active temporary permission through 29-Nov-2026. Customer places one inbound call to InkaClick (answered or missed); inspect the WhatsApp permission UI. Then, with the customer's action/consent, check the contact's outgoing permission through WACRM; only perform a real outbound call after Meta reports `canStartCall=true` and a current temporary/permanent permission. Verify audio, hangup/history and that messages/Flows remain normal. No unsolicited calls or repeat tests.

## Manual rollback if necessary

ONLY if audit logged previous callback = `DISABLED` and the operator confirms rollback is appropriate. No autoinvocation:

```bash
docker exec \
  -e CALLBACK_CHANGE_APPROVED=YES \
  -e CALLBACK_EXPECTED_PHONE_NUMBER_ID=740434745820831 \
  -i wacrm-app-1 node - rollback \
  < scripts/ops/calling-callback-permission-inkaclick.cjs
```

Expected: `CALLBACK_ROLLED_BACK=PASS`; only `callback_permission_status` is set to `DISABLED`. This **does not revoke a customer's independently granted permanent permission**; it reverts the automatic callback-permission mechanism. Do not roll back the app or PostgreSQL just to toggle this Meta setting.

## Limitations

- Meta may take time to propagate settings to client UI; opening business chat information can refresh it.
- This setting does **not** eliminate user consent, guarantee that a particular user grants permission, nor apply to a person who has never called.
- `settings` API requires Meta `whatsapp_business_management` permission. If Meta returns HTTP 403, do not print token or retry repeatedly; review access in Meta Business Manager.
- Any unconfirmed GET/POST or unrelated settings drift requires investigation instead of automatic retries.
- No application restart or additional Docker image needed to activate this Meta-only switch.
