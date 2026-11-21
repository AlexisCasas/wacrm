# SYNC-06 — Voucher parity foundation

A local validated WACRM voucher emits voucher.validated with only non-PII metadata:
source document id, Shalom number/code, optional freight amount, MIME, size and SHA-256.

The file itself is served only through the authenticated ORDER_SYNC transport route and never by embedding a permanent public URL in an event.

Imported InkaClick vouchers are stored as order_documents.source=sync. They deliberately have no uploaded_by or validated_by human UUID; audit rows use actor_name=InkaClick sync. Normal uploads keep their existing human-actor requirements.

An imported voucher may replace the validated voucher only before packing starts. Once packing/ready has started, the import becomes a conflict instead of silently rewriting the workflow.
