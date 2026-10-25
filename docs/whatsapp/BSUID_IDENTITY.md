# WhatsApp usernames and BSUID: dual identity (phone or user id)

Branch `feat/whatsapp-bsuid-identity`, based on `origin/main` `40df2f9c` (the code running in production at the time of writing). Nothing here is deployed and no migration has been applied to a real database.

## 1. Root cause and what is, and is not, proven

| | Evidence |
|---|---|
| **Confirmed** | 52 inbound messages were discarded between 2026-10-24 07:36 and 2026-10-25 18:26 UTC with `reason: missing_sender_identity, has_from: false, has_wa_id: false` (50 on Rossy's number, 2 on Keyler's). The webhook needed a phone and nothing else, so nothing was stored and no Flow ran. |
| **Consistent with, not proof** | The message ids of those events carry a `PE.` + digits token. Meta documents a BSUID as a country-code prefix, a dot and an id, so this fits, but a message id is **never** used as an identity (and this change never reads it). |
| **Not known** | The real payload of those events was not kept. Which fields the practicante's events carried (`from_user_id`? `contacts[].user_id`?) is therefore not proven for this incident. The temporary diagnostic in section 8 exists to capture it safely. |
| **Related, same cause** | 2 `TypeError ... reading 'name'` at 08:31 and 11:47 on 2026-10-24: `contact.profile.name` with no `profile`. `profile` is now optional everywhere. |

## 2. Meta contract used

Source: Meta for Developers, **Business-scoped user IDs** (`developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/`), consulted 2026-10-25, read through a page-fetch tool (a summarising model, not the raw HTML), plus the Cloud API *send messages* and *text webhook* reference pages, consulted the same day. No intermediary-vendor documentation was used.

| Direction | Field | Notes from the page |
|---|---|---|
| inbound | `messages[].from_user_id` | the sender's BSUID; `messages[].from` may be omitted |
| inbound | `contacts[].user_id` | same id on the contact; `contacts[].wa_id` may be omitted |
| inbound | `contacts[].parent_user_id`, `messages[].from_parent_user_id` | only with parent BSUIDs enabled (`CC.ENT.<id>`) |
| inbound | `contacts[].profile.username` | only if the user enabled usernames; `profile.name` can still exist |
| status | `statuses[].recipient_user_id`; `recipient_id` omitted when the phone cannot be shown | |
| outbound | `recipient: "<BSUID>"` and **no** `to`; if both are sent, `to` wins | |
| changes | no `user_id_update` webhook. A change arrives on `messages` as a `system` message (`user_changed_number`, `user_changed_user_id`) with `system.previous_user_id` | |

Scope: a BSUID is scoped to a **business portfolio**; a number of another portfolio cannot message it. A BSUID changes when the user changes number. The phone is still included in webhooks when the business number talked to the user in the last 30 days or the user is in the portfolio's contact book (per business number). BSUIDs started appearing in webhooks in April 2026 and sending to a BSUID is supported from July 2026.

Minimal fixtures (fake ids) used by the tests:

```json
{ "contacts": [{ "user_id": "PE.QA0000000000001", "profile": { "name": "Ana", "username": "ana_01" } }],
  "messages": [{ "id": "wamid.QA1", "from_user_id": "PE.QA0000000000001", "type": "text", "text": { "body": "hola" } }] }
```
```json
{ "messaging_product": "whatsapp", "recipient_type": "individual", "recipient": "PE.QA0000000000001", "type": "text", "text": { "body": "Hola" } }
```

**What the official pages did NOT let me confirm** (the corresponding behaviour is implemented from the BSUID page only and needs the controlled test of section 9): a free-form text, media, interactive or reaction example using `recipient` (the *send messages* reference has no BSUID content; the only complete `recipient` example on the BSUID page is for calls); whether `recipient_type` must stay; the exact response shape (`contacts[].user_id`); whether the 24 h service window behaves identically for BSUID users; template support for BSUID recipients beyond "not for authentication templates"; the full JSON of the two `system` messages.

## 3. Identity model

* `contacts.id` stays the internal identity. A contact has a phone **or** a BSUID **or** both.
* `contact_identities` (new, migration 077): `(account_id, kind, value)` unique, `kind` is `bsuid` or `parent_bsuid`, composite FK `(contact_id, account_id)` to `contacts(id, account_id)` so an id can never point at another account's contact, at most one **active** BSUID per contact, replaced ids kept with `superseded_at` (they still resolve to the contact but are never used to send). RLS: members of the account can read; only the service role writes.
* A contact known only by BSUID has `phone = ''` (the column stays NOT NULL, as for the 41 historical empty-phone contacts) and `phone_optional = true`. **No fake number is written and the BSUID is never copied into `phone`.** A deferred constraint trigger rejects `phone_optional` without an identity row.
* `contacts.wa_username` is display-only and mutable; usernames are never keys. A visible name proves nothing about identity.
* Linking rules (`src/lib/contacts/resolve-identity.ts`): phone only → exactly the previous behaviour; BSUID only → the account's contact for that id, or a new phone-less one created atomically (`resolve_bsuid_contact`, advisory-locked, race-safe); phone + BSUID in one event → the phone contact gains the id (one event carrying both is the evidence); the id already owned by a **different** contact → **nothing is merged**, the event goes to the id's contact and a structured `identity_conflict` warning is logged for manual review; a new id that a `system` notice says replaced a known one → attached to that contact, old id kept as history. A last-8-digits match is never evidence for a BSUID.

## 4. Migration 077 (`supabase/migrations/077_contact_identities_bsuid.sql`)

Last real migration is 076; 001–076 are untouched. Additive and idempotent: two columns on `contacts`, one unique index, one table, two service-role functions, and `contacts_require_phone_on_write()` relaxed **only** for `phone_optional = true`. No backfill and no UPDATE of existing rows.

Verified on a disposable PostgreSQL 17 restored from the production schema (`qa/bsuid/run-migration-qa.sh`): applies twice, 24 checks pass (existing contacts untouched; the 046 rule still rejects an empty phone for normal contacts; BSUID contact creation and reuse; cross-account and cross-contact guards; conflicts do not merge; RLS; client cannot call the functions or write identities; cascade delete), and 50 concurrent calls from two sessions for one BSUID create exactly one contact.

**Compatibility with the image currently in production:** the previous code never reads the new table or columns, inserts contacts with defaults (`phone_optional = false`, so the 046 rule still binds it) and already copes with empty-phone contacts. So the schema can be applied **before** the new image and the old image keeps working on it. Rolling the image back needs no schema change.

## 5. What each module does now

| Module | BSUID support | Notes |
|---|---|---|
| Webhook inbound (text, media, interactive, location, reactions) | yes | signature and account resolution unchanged; same path: contact → conversation → message → Flows → automations → AI |
| Inbox list, thread, sidebar, contact sheet/list, pipelines card | yes | shows name, `@username`, "Number not available"; never the technical id; copy-phone disabled without a phone |
| Flows: text, image/document, voice note, "audio por producto", buttons, list | yes | `recipient` instead of `to`; one attempt, no prefix variants, `contacts.phone` never touched |
| Inbox composer and AI auto-reply (`sendMessageToConversation`) | yes | same |
| Reactions | yes | |
| Automations (template send) | attempted | template-to-BSUID not verified live, see section 2 |
| Status webhooks | yes | matched by message id; `recipient_user_id` is never read as a phone |
| Broadcasts, CSV import/export, manual contact form, public API create, calls / `tel:` | **no, by design** | they are addressed by number; phone-less contacts are skipped from broadcasts, and the contact sheet explains it |
| ManyChat bridge | unchanged | ManyChat supplies phones |

## 6. Behaviour changes to be aware of

* A `system` message of type `user_changed_user_id` / `user_changed_number` updates the link and is **not** stored or offered to Flows (before, it was stored as a text message).
* `contacts[]` entries are now paired with `messages[]` by explicit id (`wa_id` / `user_id`) first and by position only as fallback; an entry that contradicts the message is not trusted for names or ids.
* Dropped events now log `has_from_user_id` / `has_contact_user_id` and a distinct `invalid_sender_identity`; never values.

## 7. Messages already lost

The 52 discarded events were acknowledged with HTTP 200 and processed afterwards (`after()`), and nothing was stored, so **they cannot be recovered or replayed from WACRM**. This change does not attempt it. Whether Meta redelivers is not something this work verified.

## 8. Temporary shape diagnostic (default off)

`src/lib/whatsapp/payload-shape.ts`, one call in the webhook. Active only while `WEBHOOK_SHAPE_LOG_PHONE_NUMBER_IDS` (the number under test) **and** `WEBHOOK_SHAPE_LOG_UNTIL` (an ISO time in the near future) are set. It prints field names and value types (`bsuid-shaped`, `digits`, `string`, ...), never values. Retire it by unsetting both variables; a later PR deletes the file and its call.

## 9. Controlled test (needs authorization, not run)

1. Set the two variables for the number under test for about one hour.
2. The practicante sends one text from the account with a username. Read the `[webhook] payload shape` line: confirm `messages[].from_user_id` / `contacts[].user_id` and which of `from` / `wa_id` are absent.
3. Reply from the inbox once, then trigger a Flow reply. Confirm delivery on the phone and check the logged Meta response. This is the first real proof of `recipient` for text; if Meta rejects it, the error is kept in the thread trace and nothing else changes.
4. Send a second message and confirm it lands in the same conversation; unset the variables.

## 10. Deployment and recovery

See `/opt/backups/wacrm/bsuid-identity/DEPLOY.md` (generated alongside this branch): backup, apply 077 with `psql -1`, build the image from the exact SHA, swap the image, verify, controlled test, and the recovery path. Recovery never restores the database: rolling back means putting the previous image back; the new table and columns stay, inert, so BSUID contacts, their conversations and messages are preserved. If the feature were abandoned for good, the table could be dropped only after exporting `contact_identities`, since dropping it makes those contacts unreachable.

## 11. Known limits

* Phone-less contacts cannot be broadcast to, imported, exported with a number, or called.
* A user who later reveals a number keeps their conversation (the phone is recorded on the BSUID contact) unless that number already belongs to another contact, in which case the conflict is only reported.
* The BSUID format check is `CC.` + 3 to 150 characters of `[A-Za-z0-9._-]`; an id outside that is rejected as `invalid_sender_identity` (loudly) rather than stored. Revisit after the capture in section 9.
* Out of scope on purpose: the `played` status errors and the SAFARI Flow condition.
