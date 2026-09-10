-- ============================================================
-- 047_contact_tags_account_integrity
--
-- P3 (docs/P3_TAGS_INBOX_AUDIT.md section G) — close the cross-account
-- gap in contact_tags: a contact in Account A must never be relatable
-- to a tag owned by Account B.
--
-- contact_tags carries no account_id of its own (migration 001) — its
-- tenancy is derived indirectly via contact_id -> contacts.account_id.
-- The RLS policy added in migration 017 (contact_tags_modify) only
-- verifies that `contact_id` belongs to an account the caller is an
-- agent+ member of; it never checks `tag_id` at all. Nothing in the
-- schema stops:
--
--   INSERT INTO contact_tags (contact_id, tag_id)
--   VALUES ('<a contact of Account A>', '<a tag of Account B>');
--
-- No current application code path is exploitable this way (every
-- INSERT today either validates both sides explicitly, via
-- src/lib/contacts/tag-write.ts's assertContactAndTagOwnership, or
-- only ever resolves tag_id from an account-scoped lookup) — but RLS
-- alone would never have stopped it, and RLS provides NO protection
-- at all for writes made via the service_role client (webhook, the
-- Automations engine, the Flows engine all use it, and service_role
-- has BYPASSRLS in Supabase). This migration adds two independent,
-- complementary layers so the guarantee holds regardless of which
-- role or code path performs the write.
-- ============================================================

-- ------------------------------------------------------------
-- 0) Preflight — abort loudly if historical cross-account rows
--    already exist. Never merged, renamed, or deleted here: doing so
--    silently could destroy a real (if mistaken) relationship an
--    account was relying on. If this raises, resolve the offending
--    rows by hand (see docs/P3_TAGS_INBOX_AUDIT.md section G) and
--    re-run this migration — it is fully idempotent otherwise.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_bad_count INTEGER;
BEGIN
  SELECT count(*) INTO v_bad_count
  FROM public.contact_tags ct
  JOIN public.contacts c ON c.id = ct.contact_id
  JOIN public.tags t ON t.id = ct.tag_id
  WHERE c.account_id <> t.account_id;

  IF v_bad_count > 0 THEN
    RAISE EXCEPTION
      'contact_tags_account_integrity preflight failed: % existing contact_tags row(s) relate a contact to a tag from a DIFFERENT account. Resolve these manually (never auto-merge/delete) before re-running migration 047 — see docs/P3_TAGS_INBOX_AUDIT.md section G.',
      v_bad_count;
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 1) DB-level integrity trigger — the authoritative guarantee.
--
-- Deliberately PLAIN (no SECURITY DEFINER): this function runs with
-- the invoking role's own privileges, and that is actually what makes
-- it correct for BOTH access paths, not a weakness:
--
--   - service_role (webhook, Automations engine, Flows engine) has
--     BYPASSRLS, so its SELECTs here see the real account_id of any
--     contact/tag regardless of account — exactly what's needed to
--     enforce the check for the one set of callers RLS can't reach
--     at all.
--   - Any RLS-scoped authenticated caller can only ever see rows
--     `is_account_member` already allows — so if `tag_id` belongs to
--     a foreign account, the SELECT below finds no row for it, and
--     the "must exist" branch rejects it exactly as if the tag were
--     missing. RLS's own visibility rules do useful work here for
--     free.
--
-- No UPDATE/DELETE/backfill of existing rows — see the preflight above
-- for why. Re-running this whole migration is always safe: both
-- statements below are idempotent (CREATE OR REPLACE / DROP IF EXISTS
-- + CREATE).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.contact_tags_require_same_account()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_contact_account UUID;
  v_tag_account UUID;
BEGIN
  SELECT account_id INTO v_contact_account FROM public.contacts WHERE id = NEW.contact_id;
  SELECT account_id INTO v_tag_account FROM public.tags WHERE id = NEW.tag_id;

  -- One generic message for "doesn't exist" and "exists but wrong
  -- account" alike — distinguishing them would let a caller probing
  -- tag ids learn whether a given UUID is a real tag in some other
  -- account.
  IF v_contact_account IS NULL OR v_tag_account IS NULL OR v_contact_account <> v_tag_account THEN
    RAISE EXCEPTION
      'contact_tags: contact and tag must exist and belong to the same account'
      USING ERRCODE = '23514'; -- check_violation
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contact_tags_require_same_account ON public.contact_tags;
CREATE TRIGGER trg_contact_tags_require_same_account
  BEFORE INSERT OR UPDATE OF contact_id, tag_id ON public.contact_tags
  FOR EACH ROW
  EXECUTE FUNCTION public.contact_tags_require_same_account();

-- ------------------------------------------------------------
-- 2) RLS reinforcement — cheap, redundant fast-fail for RLS-scoped
--    (authenticated client) writes, on top of the trigger above.
--
-- Only WITH CHECK changes: it now requires a tag with the SAME
-- account_id as the contact, not just a same-account contact. USING
-- (which governs which existing rows an UPDATE/DELETE may target) is
-- intentionally left untouched — an agent must still be able to
-- DELETE an existing relation on their own contact regardless of which
-- account a pre-existing (e.g. historical) tag_id belongs to; removing
-- a relation is never itself a cross-account write. contact_tags_select
-- is also untouched — the audit found no reason to tighten it.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS contact_tags_modify ON contact_tags;
CREATE POLICY contact_tags_modify ON contact_tags FOR ALL USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent'))
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM contacts c
    JOIN tags t ON t.account_id = c.account_id
    WHERE c.id = contact_tags.contact_id
      AND t.id = contact_tags.tag_id
      AND is_account_member(c.account_id, 'agent')
  )
);
