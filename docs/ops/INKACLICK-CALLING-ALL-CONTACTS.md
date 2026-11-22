# WhatsApp Calling — InkaClick/Keyler: all contacts (restricted tenant rollout)

## Scope and safety contract
- Enable Calling only for the WhatsApp business phone number ID `740434745820831` (Keyler/InkaClick), after Meta Calling readiness and a controlled operator decision.
- Do **not** enable Calling for other WACRM accounts.
- Do not publish private contacts, credentials, access tokens, WhatsApp user IDs or phone allowlists in GitHub, CI logs or artifacts.
- The business's own phone is *not* a valid call target.
- Incoming `calls` events and permission replies are processed only for the exact business ID when global Calling is on. Ordinary `messages` must remain active.

## Runtime flags (private, server side)
Before rollout, leave `WHATSAPP_CALLING_ENABLED=false`.

For the controlled Keyler-only all-contacts window:
- `WHATSAPP_CALLING_ENABLED=true`
- `WHATSAPP_CALLING_PILOT_PHONE_NUMBER_IDS=740434745820831`
- `WHATSAPP_CALLING_KEYLER_ALL_CONTACTS=true`

When `WHATSAPP_CALLING_KEYLER_ALL_CONTACTS` is absent or not exactly `true`, behavior remains the legacy **single-customer** allowlist from `WHATSAPP_CALLING_PILOT_CUSTOMER_PHONES`. Never use a wildcard or hard-code contact phones.

**Critical:** These are runtime environment variables, not `NEXT_PUBLIC_` variables. Updating an env file alone does not update an existing Docker process; apply via the vetted deployment and recreate/cutover procedure. Do not publish Compose-rendered environment values.

## Prerequisites before enabling
1. Build and CI of **this PR HEAD** PASS; do not reuse an earlier single-contact CI result.
2. Production backup and rollback evidence verified; exact candidate image identity and Docker labels verified; image built with the existing real public Supabase build arguments. Do not bake server secrets into Docker image.
3. Production baseline: `wacrm-app-1` healthy, DB-backed readiness HTTP 200, Caddy correct upstream, Flows recovery active, `messages` receiving normally.
4. Meta Calling enabled for **Keyler's actual business number**; Meta webhook `calls` subscribed while `messages` stays subscribed; Meta permission constraints per recipient remain effective.
5. Deploy new candidate **dark** (`WHATSAPP_CALLING_ENABLED=false`) first; verify no 502, message delivery, inbox, flows, orders and ordinary traffic.

## Rollout QA
- With the private flags enabled, verify authenticated eligibility returns `pilot_allowed=true` for two distinct eligible Keyler contacts, including a BSUID-only contact if present.
- Verify `pilot_allowed=false` for a contact of another account, for the Keyler business number itself, for an unknown/missing contact and while the kill switch is OFF.
- Check that permitted users only can initiate calls and that the `check_permission` result respects Meta's temporary/permanent permission and request limits.
- Have the operator manually place one previously agreed test call, validate microphone/audio, termination and history. Never automatically dial clients.
- Check inbound call handling, 409 concurrency, expired leases, disconnect recovery and correct `account_id` attribution. Preserve evidence without personal details.
- Observe webhook error/duplicate counters and messages/Flows following rollout.

## Emergency rollback
1. Switch `WHATSAPP_CALLING_ENABLED=false` in private runtime configuration and apply it to a newly created container using the approved cutover procedure; confirm effective OFF inside the live container.
2. Confirm WACRM messages and webhook readiness still healthy.
3. If a code rollback is necessary, use the approved `ops/deploy/rollback.sh` procedure **only after its preconditions** pass. Never restore an old database backup over new production messages.
4. Do not alter Meta `messages` subscription. Meta `calls` subscription controls delivery and is distinct from WACRM eligibility; it does not hide the WhatsApp call icon from outside users.

## Evidence
Record `KEYLER_ALL_CONTACTS_CI`, `PRODUCTION_BACKUP`, `DARK_DEPLOY`, `KEYLER_ONLY_GATE`, `OTHER_TENANTS_OFF`, `META_CALLING_READY`, `MESSAGE_CONTINUITY`, `CALL_QA` and `ROLLBACK_READY` as PASS/BLOCKED. If any prerequisite is unverified, keep the all-contacts flag OFF.
