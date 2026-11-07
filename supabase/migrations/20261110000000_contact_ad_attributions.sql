-- ============================================================
-- 20261110000000_contact_ad_attributions
--
-- "Origen del cliente": the Meta ad a customer came from (Click-to-WhatsApp), read from `messages[].referral` of the WhatsApp webhook.
-- PURELY ADDITIVE: one new table; no existing table, column, policy or function changes, so the previous application image keeps working
-- (image-only rollback; the table is then simply unused).
--
--   * One row per contact (PRIMARY KEY contact_id): the FIRST valid ad attribution is kept. The webhook inserts with ON CONFLICT DO NOTHING, so a
--     later message without a referral, or with another ad, never replaces it (V1 policy).
--   * account_id is tied to the contact by a composite FK, so a row can never carry another account's id. Deleting the contact deletes the row.
--   * Only service_role writes; members of the account (agent and up) can read. No backfill: contacts that never sent a referral have no row.
--   * ctwa_clid / source_id are stored for future attribution / conversions use; the UI never shows them.
-- ============================================================

CREATE TABLE public.contact_ad_attributions (
  contact_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL DEFAULT 'ad',
  source_id TEXT,
  source_url TEXT,
  headline TEXT,
  body TEXT,
  media_type TEXT,
  image_url TEXT,
  video_url TEXT,
  thumbnail_url TEXT,
  ctwa_clid TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contact_ad_attributions_contact_fk
    FOREIGN KEY (contact_id, account_id) REFERENCES public.contacts (id, account_id) ON DELETE CASCADE
);

CREATE INDEX idx_contact_ad_attributions_account ON public.contact_ad_attributions (account_id);

ALTER TABLE public.contact_ad_attributions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.contact_ad_attributions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.contact_ad_attributions TO authenticated;
GRANT ALL ON TABLE public.contact_ad_attributions TO service_role;

CREATE POLICY contact_ad_attributions_select ON public.contact_ad_attributions
  FOR SELECT USING (public.is_account_member(account_id, 'agent'));
