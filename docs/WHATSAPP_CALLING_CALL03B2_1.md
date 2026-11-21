# CALL-03B2.1 — Inbound call association and lifecycle

## Problem

CALL-03B2 persisted incoming `USER_INITIATED` Calling events but did not associate the resulting session with a WACRM contact or conversation. `CallingPanel` intentionally filters incoming calls to the currently open conversation, so an unlinked session could not display Accept/Reject.

The same path also left unanswered offers in `offered` after their short-lived SDP expired.

## Resolution

### Trusted identity mapping

Meta's Calling webhook uses `to` for the WhatsApp user/callee and `from` for the business phone number in both user-initiated and business-initiated examples. BSUID mapping remains direction-specific:

- User-initiated: `from_user_id` / `from_parent_user_id`.
- Business-initiated: `to_user_id` / `to_parent_user_id`.
- Phone fallback: `contacts[].wa_id` when `calls[].to` is omitted.

The server-side processor already follows this contract. CALL-03B2.1 keeps that behavior and aligns unit fixtures and the QA mock with it.

### Contact resolution

`whatsapp_call_resolve_inbound_association` resolves only within the account mapped from `phone_number_id`.

It unions matches from:
- `contact_identities` for direct BSUID.
- `contact_identities` for parent BSUID.
- `contacts.phone_normalized` for the customer phone.

The resolver links only one distinct contact. If phone and BSUID point to different contacts, it returns `contact_ambiguous` and does not guess.

It then selects the existing `open` or `pending` conversation for that contact. It never creates or reopens a conversation. If no active conversation exists, it links the contact only and records `conversation_not_found`.

The existing `whatsapp_call_session_metadata_guard` remains authoritative for tenant, contact/conversation and WhatsApp identity validation.

### Idempotency and history

The inbound `connect` event writes the resolved contact, conversation and diagnostic code in the same transaction as the event/session persistence.

Later terminate/status updates preserve existing associations. Duplicate event keys remain idempotent. A bounded migration backfill links still-active, previously unlinked inbound sessions when the identity resolves unambiguously.

### Offer expiration

`whatsapp_call_sdp_prune` now marks unanswered inbound `offered`/`ringing` sessions as `terminated` when their session SDP expires, or when the SDP/expiry metadata is missing and the offer is older than five minutes. The processor gives inbound offers a 60-second SDP lifetime, aligned with Meta's documented 30–60-second acceptance window; outbound SDP retains its five-minute lifetime. It sets `ended_at`, releases any claim and clears ephemeral SDP. Accepted calls are not terminated merely because Meta's status webhook is delayed; their expired SDP is still cleared, and they remain unavailable to other agents. Connected calls are not terminated merely because their SDP expires.

The existing GET/POST Calling API invokes this bounded cleanup before listing or acting on calls, so expired offers cannot be claimed or accepted.

## Regression coverage

`scripts/qa/whatsapp-calling/verify-call03b2-1.sql` verifies:

- Phone, BSUID and parent-BSUID association.
- Open/pending conversation resolution.
- Ambiguous phone/BSUID identity fails closed.
- Missing and cross-tenant contacts remain unlinked.
- Closed conversations are not selected.
- Duplicate events and later terminate preserve associations.
- Expired inbound offers become `terminated` and cannot be reclaimed.
- Fresh offers remain available.

All SQL fixtures are synthetic and rolled back in the verification script.

## Operational boundary

This increment changes the application migration, webhook processor, authenticated Calling API, tests and documentation. It does not activate Meta webhooks, enable real Calling, or change production configuration.

## QA deployment verification

- Deployed to the isolated `call03b2-qa` stack from commit `35cac275fa981ac4dc1ac2def1b38ac2c5481d46`.
- `20261130000003_whatsapp_calling_inbound_association_lifecycle.sql` was applied to `call03b2-qa-db` with `supabase_admin`.
- The exact `whatsapp_call_sdp_prune(integer)` definition from this commit was installed in a separate locked transaction. `whatsapp_call_sdp_prune(100)` returned `0`.
- All eight pre-existing QA call sessions remained byte-for-byte equivalent by the reported row/hash comparison; no session attribution or timestamps changed during the function update.
- The three older inbound sessions had already been explicitly terminated before this final prune-function update; they were not terminated by the prune invocation returning zero.
- Production, Meta configuration and the real `calls` webhook were not changed.
