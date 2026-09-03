-- ============================================================
-- 040_manychat_contact_links
--
-- TEMPORARY-bridge persistence: records which WA CRM contact
-- corresponds to which ManyChat subscriber. The inbound bridge
-- (POST /api/integrations/manychat/inbound) upserts a row here on
-- every delivery — including retries, since the mapping has nothing
-- to do with message idempotency. The outbound bridge
-- (src/lib/whatsapp/send-message.ts, gated on
-- WHATSAPP_OUTBOUND_TRANSPORT=manychat) reads it back to learn which
-- manychat_contact_id to hand to ManyChat's Public API when an agent
-- replies from the Inbox.
--
-- A dedicated table rather than a column on `contacts`:
--   - `contacts` is the account's canonical customer record, read and
--     written by every non-ManyChat path (manual create, CSV import,
--     the Meta webhook). Bolting a temporary-bridge concern onto it
--     means every future change to that table has to reason about an
--     unrelated integration's lifecycle.
--   - this bridge is explicitly temporary — removed once the number is
--     registered directly in WA CRM and ManyChat is decommissioned. A
--     separate table drops cleanly with one `DROP TABLE`; a column on
--     `contacts` would need its own migration to reverse.
--
-- RLS mirrors `webhook_endpoints` (028) — a settings-adjacent,
-- account-scoped table: any member may read the mapping, only admin+
-- may write it via the dashboard/API. In practice all writes today
-- come from the inbound bridge's service-role client, which bypasses
-- RLS entirely — no dashboard UI exists yet to create or edit these
-- rows by hand, but the write policies are in place for when one does.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS manychat_contact_links (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id           UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  manychat_contact_id  TEXT NOT NULL,
  whatsapp_id          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One ManyChat mapping per CRM contact. This is also the inbound
  -- bridge's upsert conflict target — a re-delivery for the same
  -- contact updates the existing row instead of erroring.
  UNIQUE (account_id, contact_id),

  -- One CRM contact per ManyChat subscriber, scoped to the account so
  -- two different accounts' ManyChat integrations can never collide on
  -- the same manychat_contact_id.
  UNIQUE (account_id, manychat_contact_id)
);

-- Outbound-send lookups filter by BOTH (account_id, contact_id)
-- together (never contact_id alone — see send-message.ts), which the
-- first UNIQUE constraint above already backs with a matching index.
-- This second index exists purely for the ON DELETE CASCADE from
-- `contacts` (and any future direct by-contact lookup), since
-- contact_id is only the trailing column in that composite index.
CREATE INDEX IF NOT EXISTS idx_manychat_contact_links_contact
  ON manychat_contact_links (contact_id);

ALTER TABLE manychat_contact_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS manychat_contact_links_select ON manychat_contact_links;
CREATE POLICY manychat_contact_links_select ON manychat_contact_links FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS manychat_contact_links_insert ON manychat_contact_links;
CREATE POLICY manychat_contact_links_insert ON manychat_contact_links FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS manychat_contact_links_update ON manychat_contact_links;
CREATE POLICY manychat_contact_links_update ON manychat_contact_links FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS manychat_contact_links_delete ON manychat_contact_links;
CREATE POLICY manychat_contact_links_delete ON manychat_contact_links FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON manychat_contact_links;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON manychat_contact_links
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
