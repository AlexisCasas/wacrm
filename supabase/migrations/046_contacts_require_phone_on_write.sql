-- ============================================================
-- 046_contacts_require_phone_on_write
--
-- P1 Fase 2C (docs/P1_DUPLICATE_CHATS_AUDIT.md section Q) — stop NEW
-- contacts.phone = '' rows from being created (and stop an existing
-- contact's phone from being cleared to ''), WITHOUT requiring the
-- historical empty-phone rows the "Juor Nuevo" incident already
-- produced to be cleaned up first. That cleanup is out of scope for
-- this phase — see section Q.9 of the audit doc.
--
-- Application-level prevention already landed in this same phase:
--   - src/lib/whatsapp/resolve-sender-identity.ts — the native Meta
--     webhook now resolves the sender's identity from `message.from`
--     with a `contact.wa_id` fallback, and refuses to create anything
--     (no contact, no conversation, no message) when neither yields a
--     usable phone;
--   - src/lib/contacts/find-or-create.ts — re-normalizes `phone` and
--     refuses the INSERT if it doesn't normalize to any digits,
--     regardless of what the caller passed in.
-- This migration is the DB-level backstop for both: it protects
-- against a bug in a *future* caller of either of the above (or any
-- other write path — including ad-hoc SQL) that isn't covered by
-- application code at all.
--
-- Why a trigger, not `CHECK (phone_normalized <> '') NOT VALID`
-- -----------------------------------------------------------------
-- `NOT VALID` only skips the one-time table scan Postgres would
-- otherwise run when the constraint is added — it does NOT exempt
-- already-non-conforming rows from the constraint afterwards. Once a
-- CHECK constraint exists (valid or not), PostgreSQL re-evaluates it
-- against the FULL new row image on every subsequent INSERT *and*
-- UPDATE of that row, regardless of which columns the UPDATE's SET
-- list actually touches — a CHECK constraint has no concept of "this
-- row was already bad before I existed."
--
-- Production already has multiple contacts with phone_normalized=''
-- (the pre-fix pattern this phase's audit found), and at least two
-- live write paths legitimately UPDATE those rows without ever
-- touching `phone`:
--   - `block_contact_internal()` (migration 044) — UPDATE contacts SET
--     blocked = ... — exactly the action an agent would reach for on
--     one of these spam-looking ghost contacts;
--   - `PATCH /api/v1/contacts/{id}` (src/app/api/v1/contacts/[id]/route.ts)
--     — updates name/email/company only, never phone.
-- A `CHECK (phone_normalized <> '') NOT VALID` would make BOTH of
-- those fail on every existing empty-phone contact until each row is
-- individually repaired — i.e. it would silently force exactly the
-- historical cleanup this phase explicitly defers, and break a P0
-- safety feature (contact blocking) in the process.
--
-- A trigger scoped to `INSERT OR UPDATE OF phone` has no such gotcha:
-- Postgres's `UPDATE OF column` trigger syntax fires ONLY when that
-- column is part of the UPDATE's SET list, so it never runs for the
-- blocking/PATCH updates above, and never touches historical rows
-- unless something actively tries to blank out an existing phone.
-- ============================================================

CREATE OR REPLACE FUNCTION public.contacts_require_phone_on_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF regexp_replace(COALESCE(NEW.phone, ''), '\D', '', 'g') = '' THEN
    RAISE EXCEPTION
      'contacts.phone must normalize to at least one digit (account_id=%)',
      NEW.account_id
      USING ERRCODE = '23514'; -- check_violation
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_require_phone_on_write ON contacts;
CREATE TRIGGER trg_contacts_require_phone_on_write
  BEFORE INSERT OR UPDATE OF phone ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.contacts_require_phone_on_write();

-- No UPDATE, DELETE, backfill, or VALIDATE CONSTRAINT runs here.
-- Historical rows with phone='' are left exactly as they are, and
-- remain fully editable on every column except `phone` itself.
