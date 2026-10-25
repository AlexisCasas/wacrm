-- ============================================================
-- 077_contact_identities_bsuid
--
-- WhatsApp usernames / business-scoped user IDs (BSUID).
--
-- A WhatsApp user who enables the username feature reaches the business
-- WITHOUT a phone number in the webhook (`messages[].from` and
-- `contacts[].wa_id` are omitted; the BSUID arrives in
-- `messages[].from_user_id` / `contacts[].user_id`). Until now such a
-- message was dropped (`missing_sender_identity`).
--
-- Model (additive; nothing existing is rewritten or removed):
--   * `contacts.id` stays the stable internal identity.
--   * `contact_identities` holds the WhatsApp user ids of a contact
--     (BSUID and, when Meta shares it, the parent BSUID). It is keyed by
--     (account_id, kind, value) so an id resolves to one contact per
--     account, and the composite FK (contact_id, account_id) makes a
--     cross-account link impossible.
--   * A contact known only by BSUID has `phone = ''` (the column stays
--     NOT NULL, exactly like the 41 historical rows) and
--     `phone_optional = true`. No fake number is ever written and the
--     BSUID is never copied into `phone`.
--   * `contacts.wa_username` is display-only and mutable; it is never a key.
--
-- Compatibility with the previous image: every change is additive.
-- The old code never reads the new table/columns, inserts contacts with
-- the column defaults (`phone_optional = false`, so migration 046's rule
-- still applies to it), and treats a BSUID-only contact like the existing
-- empty-phone rows. Rolling the image back therefore needs no schema
-- rollback; see docs/whatsapp/BSUID_IDENTITY.md.
--
-- Idempotent.
-- ============================================================

-- 1) contacts: optional phone + display username -----------------------
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS phone_optional boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS wa_username text;

-- Target of the composite FK below. `id` is already unique; this index only
-- lets (id, account_id) be referenced.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_id_account
  ON public.contacts (id, account_id);

-- 2) migration 046's rule, relaxed ONLY for contacts flagged phone_optional.
--    The flag is only honoured when an identity row exists (checked at
--    commit by the constraint trigger in step 4), so it cannot be used to
--    smuggle a phone-less contact in.
CREATE OR REPLACE FUNCTION public.contacts_require_phone_on_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.phone_optional THEN
    RETURN NEW;
  END IF;
  IF regexp_replace(COALESCE(NEW.phone, ''), '\D', '', 'g') = '' THEN
    RAISE EXCEPTION
      'contacts.phone must normalize to at least one digit (account_id=%)',
      NEW.account_id
      USING ERRCODE = '23514'; -- check_violation
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_require_phone_on_write ON public.contacts;
CREATE TRIGGER trg_contacts_require_phone_on_write
  BEFORE INSERT OR UPDATE OF phone, phone_optional ON public.contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.contacts_require_phone_on_write();

-- 3) contact_identities --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contact_identities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('bsuid', 'parent_bsuid')),
  value       text NOT NULL CHECK (value <> '' AND length(value) <= 200),
  -- A BSUID that Meta replaced (user changed number / id). It still
  -- resolves to the same contact, but is never used to send.
  superseded_at timestamptz,
  source      text NOT NULL DEFAULT 'webhook' CHECK (source IN ('webhook', 'system_change')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_identities_contact_fkey
    FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts (id, account_id) ON DELETE CASCADE,
  CONSTRAINT contact_identities_unique UNIQUE (account_id, kind, value)
);

CREATE INDEX IF NOT EXISTS idx_contact_identities_contact
  ON public.contact_identities (contact_id);

-- At most one ACTIVE (not superseded) BSUID per contact: the one used to send.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_identities_one_active_bsuid
  ON public.contact_identities (contact_id)
  WHERE kind = 'bsuid' AND superseded_at IS NULL;

ALTER TABLE public.contact_identities ENABLE ROW LEVEL SECURITY;

-- Members of the account can read the ids of their own contacts. Nobody but
-- the service role writes: ids come from Meta's webhook, never from a client.
DROP POLICY IF EXISTS contact_identities_select ON public.contact_identities;
CREATE POLICY contact_identities_select ON public.contact_identities
  FOR SELECT USING (public.is_account_member(account_id));

-- 4) A phone_optional contact must have an identity (checked at commit, so
--    the creating function can insert contact and identity in one statement
--    block). Direct writes that skip it fail.
CREATE OR REPLACE FUNCTION public.contacts_phone_optional_needs_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.phone_optional
     AND regexp_replace(COALESCE(NEW.phone, ''), '\D', '', 'g') = ''
     AND NOT EXISTS (
       SELECT 1 FROM public.contact_identities i
       WHERE i.contact_id = NEW.id AND i.account_id = NEW.account_id
     ) THEN
    RAISE EXCEPTION 'a contact without phone needs a WhatsApp user id (contact_id=%)', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_phone_optional_needs_identity ON public.contacts;
CREATE CONSTRAINT TRIGGER trg_contacts_phone_optional_needs_identity
  AFTER INSERT OR UPDATE OF phone, phone_optional ON public.contacts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.contacts_phone_optional_needs_identity();

-- 5) Atomic create-or-resolve for a BSUID-only sender --------------------
--    Returns the contact for (account, bsuid), creating contact + identity
--    in one transaction. A concurrent delivery of the same BSUID serialises
--    on an advisory lock and gets the same row. Service role only.
CREATE OR REPLACE FUNCTION public.resolve_bsuid_contact(
  p_account_id     uuid,
  p_owner_user_id  uuid,
  p_bsuid          text,
  p_parent_bsuid   text,
  p_username       text,
  p_name           text
)
RETURNS TABLE (contact_id uuid, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_contact uuid;
BEGIN
  IF p_bsuid IS NULL OR btrim(p_bsuid) = '' THEN
    RAISE EXCEPTION 'bsuid is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_account_id::text || ':bsuid:' || p_bsuid, 0));

  SELECT i.contact_id INTO v_contact
  FROM contact_identities i
  WHERE i.account_id = p_account_id AND i.kind = 'bsuid' AND i.value = p_bsuid;

  IF v_contact IS NOT NULL THEN
    RETURN QUERY SELECT v_contact, false;
    RETURN;
  END IF;

  INSERT INTO contacts (account_id, user_id, phone, phone_optional, name, wa_username)
  VALUES (p_account_id, p_owner_user_id, '', true,
          COALESCE(NULLIF(btrim(p_name), ''), NULLIF(btrim(p_username), ''), 'WhatsApp user'),
          NULLIF(btrim(p_username), ''))
  RETURNING id INTO v_contact;

  INSERT INTO contact_identities (account_id, contact_id, kind, value)
  VALUES (p_account_id, v_contact, 'bsuid', p_bsuid);

  IF p_parent_bsuid IS NOT NULL AND btrim(p_parent_bsuid) <> '' THEN
    INSERT INTO contact_identities (account_id, contact_id, kind, value)
    VALUES (p_account_id, v_contact, 'parent_bsuid', p_parent_bsuid)
    ON CONFLICT (account_id, kind, value) DO NOTHING;
  END IF;

  RETURN QUERY SELECT v_contact, true;
END;
$$;

-- 6) Link an id to an EXISTING contact (same event carried both the phone
--    and the id). Never merges: an id already owned by another contact is
--    reported as a conflict and left alone.
CREATE OR REPLACE FUNCTION public.link_contact_bsuid(
  p_account_id    uuid,
  p_contact_id    uuid,
  p_bsuid         text,
  p_parent_bsuid  text,
  p_username      text,
  p_supersedes    text DEFAULT NULL
)
RETURNS TABLE (outcome text, owner_contact_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF p_bsuid IS NULL OR btrim(p_bsuid) = '' THEN
    RAISE EXCEPTION 'bsuid is required' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM contacts WHERE id = p_contact_id AND account_id = p_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact does not belong to this account' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_account_id::text || ':bsuid:' || p_bsuid, 0));

  SELECT i.contact_id INTO v_owner
  FROM contact_identities i
  WHERE i.account_id = p_account_id AND i.kind = 'bsuid' AND i.value = p_bsuid;

  IF v_owner IS NOT NULL AND v_owner <> p_contact_id THEN
    RETURN QUERY SELECT 'conflict'::text, v_owner;
    RETURN;
  END IF;

  IF p_supersedes IS NOT NULL AND btrim(p_supersedes) <> '' THEN
    UPDATE contact_identities
       SET superseded_at = now()
     WHERE account_id = p_account_id AND contact_id = p_contact_id
       AND kind = 'bsuid' AND value = p_supersedes AND superseded_at IS NULL;
  END IF;

  IF v_owner IS NULL THEN
    -- The contact may already hold a different ACTIVE bsuid (the partial unique
    -- index allows one). Keep the older one as history instead of failing.
    UPDATE contact_identities
       SET superseded_at = now()
     WHERE account_id = p_account_id AND contact_id = p_contact_id
       AND kind = 'bsuid' AND superseded_at IS NULL;
    INSERT INTO contact_identities (account_id, contact_id, kind, value, source)
    VALUES (p_account_id, p_contact_id, 'bsuid', p_bsuid,
            CASE WHEN p_supersedes IS NULL THEN 'webhook' ELSE 'system_change' END);
  END IF;

  IF p_parent_bsuid IS NOT NULL AND btrim(p_parent_bsuid) <> '' THEN
    INSERT INTO contact_identities (account_id, contact_id, kind, value)
    VALUES (p_account_id, p_contact_id, 'parent_bsuid', p_parent_bsuid)
    ON CONFLICT (account_id, kind, value) DO NOTHING;
  END IF;

  IF p_username IS NOT NULL AND btrim(p_username) <> '' THEN
    UPDATE contacts SET wa_username = btrim(p_username)
     WHERE id = p_contact_id AND account_id = p_account_id AND wa_username IS DISTINCT FROM btrim(p_username);
  END IF;

  RETURN QUERY SELECT CASE WHEN v_owner IS NULL THEN 'linked' ELSE 'already_linked' END, p_contact_id;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_bsuid_contact(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.link_contact_bsuid(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_bsuid_contact(uuid, uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.link_contact_bsuid(uuid, uuid, text, text, text, text) TO service_role;

-- No backfill, no UPDATE of existing rows. Down path (only needed if the
-- feature is abandoned AFTER BSUID contacts exist): see
-- docs/whatsapp/BSUID_IDENTITY.md — the table and columns are inert for the
-- previous image and are kept to preserve those contacts and conversations.
