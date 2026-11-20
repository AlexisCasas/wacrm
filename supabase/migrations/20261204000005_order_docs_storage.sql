-- ============================================================
-- 20261129000002_order_docs_storage
--
-- PR-04 · private Storage bucket for order documents (vouchers and the durable snapshot of chat evidence). Purely additive.
--
--   * PRIVATE (public = FALSE). It is NOT chat-media / flow-media / voice-notes (all public): a voucher carries personal data.
--   * NO policy on storage.objects for this bucket (no anon, no authenticated). Every existing policy of the project is bound to its own
--     bucket_id, and RLS is enabled on storage.objects, so a browser role can neither read, list, upload nor delete here (verified by the
--     Storage QA test). All access is server-side: the backend (service role) uploads after authorizing the caller and hands out short-lived
--     signed URLs; the account / order scope is enforced by order_documents (RLS + RPCs), which holds the only reference to each object.
--   * Object paths are account-scoped: account-<account_id>/orders/<order_id | unassigned>/(vouchers|evidence)/<document_id>/<file>
--     (order_documents has a CHECK that the path starts with the document's own account prefix). Bulk vouchers not yet associated live under
--     "unassigned": the object is never moved afterwards, the association lives in the database row.
--   * The MIME allow-list is the file types a voucher / evidence can legitimately be; the backend also sniffs the bytes (never trusts the header).
--   * Limit 10 MB (the application caps uploads at 8 MB: the request also crosses the proxy/middleware buffer).
--
-- Idempotent. Re-running forces public = FALSE (it never makes the bucket public).
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'order-docs',
  'order-docs',
  FALSE,
  10485760,
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET
  public = FALSE,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
