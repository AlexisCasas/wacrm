-- ============================================================
-- 20261103000000_whatsapp_config_messaging_account_id
--
-- Meta's new WhatsApp account model: billing, templates and webhook subscriptions belong to a MESSAGING ACCOUNT, not to the phone number. When
-- a token can reach more than one messaging account for the same number, a send has to NAME the one that is billed (`messaging_account_id` in
-- the POST /{phone_number_id}/messages body); otherwise Meta may charge an account nobody chose.
--
-- This adds ONE nullable column to whatsapp_config, kept apart from the two identifiers that already exist:
--   * phone_number_id  - the number (unique per instance, resolves the inbound webhook to the account). Unchanged.
--   * waba_id          - the Graph node used for template CRUD and /subscribed_apps. Unchanged. For a number connected through its own
--                        messaging account it holds that account's id; it must never be filled with another provider's account.
--   * messaging_account_id (NEW) - the account billed for outbound sends. NULL = not sent = exactly the behaviour before this migration.
--
-- Additive and idempotent. Existing rows (every existing account) stay NULL and keep sending the same payload. The CHECK keeps the value to
-- digits only, because it is copied into a request body. No data is moved, no index is needed (it is only read with the row of the account).
-- ============================================================

ALTER TABLE public.whatsapp_config ADD COLUMN IF NOT EXISTS messaging_account_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_messaging_account_id_format' AND conrelid = 'public.whatsapp_config'::regclass) THEN
    ALTER TABLE public.whatsapp_config
      ADD CONSTRAINT whatsapp_config_messaging_account_id_format
      CHECK (messaging_account_id IS NULL OR messaging_account_id ~ '^[0-9]{5,25}$');
  END IF;
END $$;

COMMENT ON COLUMN public.whatsapp_config.messaging_account_id IS
  'Meta messaging account billed for outbound sends (new account model). NULL = the send does not name one (legacy behaviour). Not an identifier of the phone number (phone_number_id) nor of the Graph node used for templates/subscriptions (waba_id).';
