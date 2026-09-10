-- ============================================================
-- 049_default_account_tags
--
-- P3 (docs/P3_TAGS_INBOX_AUDIT.md section L) — every account should
-- start with a normal, editable set of tags instead of an empty
-- catalogue. Names live here (and only here) as real public.tags
-- rows — never hardcoded in the frontend.
--
-- Depends on migration 048's unique index
-- (account_id, lower(btrim(name))) for its idempotency guard — must
-- run after it.
--
-- REVISED (adversarial review) — this file originally shipped two
-- real defects, both fixed here before anything was ever applied:
--
--   1. handle_new_user() called create_default_account_tags() inside
--      the SAME exception-guarded block as the account/profile
--      inserts. PL/pgSQL's EXCEPTION clause rolls back EVERYTHING
--      since its own BEGIN before running the handler — so a defaults
--      failure would have silently rolled back the account and
--      profile too, even though auth.users itself survives (that
--      insert already committed by the time this trigger fires).
--      Fixed with a NESTED exception block scoped to ONLY the
--      defaults call — see section 7 below.
--
--   2. redeem_invitation() (migration 019) treats ANY row in `tags`
--      for the caller's account as "domain data" that blocks joining
--      an inviter's account (to prevent silent data loss). Once every
--      fresh signup gets 6 default tags automatically, EVERY invited
--      signup would trip that check and redeem_invitation would
--      always fail with 23505 — invitations would be permanently
--      broken, not just degraded. Fixed by marking rows this
--      migration creates with `tags.is_default = true` and excluding
--      them from that specific check — see sections 1 and 8 below.
--
--   3. (found in a LATER adversarial pass, same file — nothing had been
--      applied anywhere real yet) The INVERSE of defect 2 was open:
--      RLS on `tags` only checks account membership/role, never the
--      `is_default` column itself, so any admin/owner could forge
--      `is_default = true` via a direct INSERT or an UPDATE, or call
--      create_default_account_tags() directly (it had no EXECUTE
--      restriction) — any of which would make a REAL tag invisible to
--      redeem_invitation()'s data-loss check. Fixed with a
--      transaction-scoped capability flag only create_default_
--      account_tags() ever sets, enforced by a new trigger — see
--      sections 3 and 6 below — plus revoking that function's default
--      PUBLIC execute grant, since it never needed to be callable by
--      normal clients in the first place.
--
--   4. (found in the SAME later pass, approved fix — nothing had been
--      applied anywhere real yet) The idempotency guard for defect 3's
--      fix relied only on 048's per-name unique index — so it actually
--      meant "these 6 NAMES exist", not "this account was provisioned
--      once". Confirmed against a real Postgres: renaming or deleting
--      a default and then re-running this migration would silently
--      resurrect it under its original name, contradicting this file's
--      own "always a safe no-op" claim (nothing was ever lost — a
--      renamed tag stayed exactly as the user left it — but an unasked-
--      for tag would reappear). Fixed with a real one-time-per-account
--      marker, `accounts.default_tags_provisioned_at` — see sections 2
--      and 3 below. Provisioning is a one-time seed, not a standing
--      "these 6 names must always exist" rule; the unique index from
--      048 is kept as an independent second guard for the one case
--      where identity-by-name is still exactly the right behavior: a
--      pre-existing user tag with a colliding name at first-ever
--      provisioning time (case D in the test suite) is left completely
--      untouched rather than adopted.
-- ============================================================

-- ------------------------------------------------------------
-- 1) `is_default` — distinguishes an untouched system-provisioned
--    tag from a real one (user-created, OR a default the user has
--    since renamed/recolored — see the trigger in section 5). NOT
--    NULL DEFAULT false: every pre-existing historical tag becomes
--    `false` automatically, which is the correct, conservative
--    classification for them (they predate this column entirely and
--    must keep counting as real data everywhere they already did).
-- ------------------------------------------------------------
ALTER TABLE public.tags
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- 2) `default_tags_provisioned_at` — the ACTUAL idempotency marker for
--    "has this account already received its one-time default-tags
--    provisioning". Nullable by design:
--
--      NULL     -> this account may still receive initial provisioning.
--      NOT NULL -> it already happened once; create_default_account_tags()
--                  (section 3) must be a permanent no-op for it from
--                  here on, regardless of what the account did to the
--                  6 tags afterward.
--
--    This is NOT a security control — is_default forgery is entirely
--    the job of the triggers/privileges in sections 5/6, unaffected by
--    this column. This column exists purely to fix a real, confirmed
--    behavioral bug: keying "already provisioned" off `ON CONFLICT` on
--    the tags' NORMALIZED NAME (the only guard that existed before)
--    means renaming or deleting a default and then re-running this
--    migration would silently resurrect it — provisioning is meant to
--    be a ONE-TIME seed, not a permanent "these 6 names must always
--    exist" rule. See section 3 for the fix.
-- ------------------------------------------------------------
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS default_tags_provisioned_at TIMESTAMPTZ;

-- ------------------------------------------------------------
-- 3) Provisioning function — now a real one-time-per-account
--    operation, gated on section 2's marker rather than on whether the
--    6 tag NAMES currently exist. `ON CONFLICT` (048's unique index)
--    is kept as a second, independent guard: it's what makes a
--    pre-existing same-named tag (case D — a user who already had
--    their own "Pendiente" before ever being provisioned) survive
--    completely untouched — ON CONFLICT DO NOTHING never touches the
--    conflicting row's color/user_id/is_default, it just skips that
--    one INSERT — while the other 5 defaults still get created and the
--    account still gets marked provisioned.
--
--    `SELECT ... FOR UPDATE` on the account row serializes concurrent
--    calls for the SAME account: a second call blocks on the row lock
--    until the first finishes (commit or rollback), then reads
--    whatever the first left in `default_tags_provisioned_at`. Combined
--    with 048's unique index as a second, independent guard even in
--    the vanishingly unlikely case two callers raced past the lock
--    somehow (e.g. two separate NOT-yet-committed transactions that
--    later both see NULL — impossible here since FOR UPDATE forces the
--    second to wait for the first's COMMIT, not just its statement),
--    this is deterministic without any advisory/global lock: the
--    contention is scoped to exactly the one row that matters.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_default_account_tags(
  p_account_id UUID,
  p_owner_user_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_provisioned_at TIMESTAMPTZ;
BEGIN
  SELECT default_tags_provisioned_at INTO v_provisioned_at
  FROM public.accounts
  WHERE id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_default_account_tags: account % does not exist', p_account_id;
  END IF;

  IF v_provisioned_at IS NOT NULL THEN
    RETURN; -- already provisioned once, permanently — by design.
  END IF;

  -- Transaction-scoped (SET LOCAL semantics — `is_local := true`)
  -- capability flag: this is the ONLY statement in the whole codebase
  -- that ever sets it, and it evaporates automatically at the end of
  -- this call's transaction. trg_tags_protect_is_default (section 6
  -- below) checks for it before letting `is_default` become true.
  -- This is what makes the 6 rows below legitimate while an identical
  -- direct INSERT from a client is not.
  PERFORM set_config('wacrm.provisioning_default_tags', 'on', true);

  INSERT INTO public.tags (account_id, user_id, name, color, is_default)
  VALUES
    (p_account_id, p_owner_user_id, 'Favoritos',          '#f59e0b', true),
    (p_account_id, p_owner_user_id, 'Pendiente',          '#3b82f6', true),
    (p_account_id, p_owner_user_id, 'Pedido confirmado',  '#10b981', true),
    (p_account_id, p_owner_user_id, 'Pendiente de pago',  '#ef4444', true),
    (p_account_id, p_owner_user_id, 'Reclamo',            '#ec4899', true),
    (p_account_id, p_owner_user_id, 'Cliente frecuente',  '#8b5cf6', true)
  ON CONFLICT (account_id, (lower(btrim(name)))) DO NOTHING;

  -- Only reached if the INSERT above didn't raise — a failure here
  -- (or anywhere above) propagates to the caller with the marker still
  -- NULL, exactly as required: handle_new_user's nested BEGIN/EXCEPTION
  -- (section 7) means a failure never marks an account as provisioned
  -- when it wasn't.
  UPDATE public.accounts SET default_tags_provisioned_at = now() WHERE id = p_account_id;
END;
$$;

ALTER FUNCTION public.create_default_account_tags(UUID, UUID) OWNER TO postgres;

-- This helper has no legitimate caller outside the trigger path below
-- (handle_new_user, section 7) and the migration's own backfill
-- (section 4) — both run as the function's owner regardless of grants
-- (handle_new_user is SECURITY DEFINER owned by postgres; the backfill
-- runs inline in this migration, also as postgres). Left alone, this
-- function is reachable as `rpc/create_default_account_tags` for ANY
-- authenticated (even anon) caller, who could name any account_id —
-- it does no membership check of its own, since it was only ever meant
-- to be called from trusted, already-checked contexts. Confirmed
-- against a real local Postgres that a plain `REVOKE ... FROM PUBLIC`
-- is NOT sufficient here: Supabase's own default-privileges setup
-- grants EXECUTE directly to `anon`, `authenticated`, and
-- `service_role` at CREATE time (separately from — not merely via —
-- the PUBLIC pseudo-role), so all three must be named explicitly.
-- service_role is included too: no server-side code path needs to call
-- this directly either. The owner (postgres) keeps implicit EXECUTE on
-- its own function regardless of any REVOKE, which is exactly what
-- both legitimate call sites rely on.
REVOKE ALL ON FUNCTION public.create_default_account_tags(UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 4) Existing accounts — backfill once, safe to re-run. `user_id` on
--    `tags` is a legacy NOT NULL audit column (predates the
--    account-sharing model, migration 017) with no defaults-specific
--    identity to attribute to — `accounts.owner_user_id` is the
--    correct, already-real identity per the audited architecture
--    (never an invented UUID). The real per-account idempotency check
--    now lives entirely inside create_default_account_tags() (section
--    3) via the marker — this loop deliberately does not duplicate
--    that check; it just calls the helper for every account and lets
--    it decide.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_account RECORD;
BEGIN
  FOR v_account IN SELECT id, owner_user_id FROM public.accounts LOOP
    PERFORM public.create_default_account_tags(v_account.id, v_account.owner_user_id);
  END LOOP;
END
$$;

-- ------------------------------------------------------------
-- 5) `is_default` degrades to `false` the moment a default tag is
--    materially edited (renamed or recolored) — no app UI does this
--    today, but the flag must never let a genuine customization be
--    silently destroyed by a later redeem_invitation() cleanup (see
--    section 8) if such an edit path is ever added, or happens via
--    direct DB/API access. Once a tag has been customized it is, by
--    definition, no longer "the untouched default" and must count as
--    real data everywhere is_default is consulted.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tags_clear_default_on_edit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.is_default AND (NEW.name IS DISTINCT FROM OLD.name OR NEW.color IS DISTINCT FROM OLD.color) THEN
    NEW.is_default := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tags_clear_default_on_edit ON public.tags;
CREATE TRIGGER trg_tags_clear_default_on_edit
  BEFORE UPDATE OF name, color ON public.tags
  FOR EACH ROW
  EXECUTE FUNCTION public.tags_clear_default_on_edit();

-- ------------------------------------------------------------
-- 6) The INVERSE of section 5 — protect `is_default` from ever going
--    false -> true (or arriving true on INSERT) from anywhere except
--    create_default_account_tags() above. Without this, the RLS
--    baseline on `tags` (tags_insert/tags_update, migration 017) only
--    checks account membership/role — it has no column-level opinion
--    on `is_default` — so any admin/owner could, directly via
--    PostgREST:
--
--      INSERT INTO tags (..., is_default) VALUES (..., true);
--      UPDATE tags SET is_default = true WHERE id = '<their own tag>';
--
--    Confirmed exploitable exactly like this against a real local
--    Postgres before this trigger existed. Either one lets a genuine,
--    non-default tag masquerade as a default — and since
--    redeem_invitation() (section 8) treats `is_default` rows as safe
--    to discard, a forged one would let a real tag be silently
--    destroyed when its temp account is deleted on redeem, which is
--    exactly the "never silently lose domain data" guarantee migration
--    019 exists to protect.
--
--    `OF is_default` scopes the UPDATE case to only when that column
--    itself changes (cheap, no-op for the vastly more common
--    name/color-only edits); INSERT has no such qualifier in Postgres
--    (`OF column` is UPDATE-only) so it is checked on every insert,
--    which is exactly the other half of the exploit above. Silently
--    coercing to `false` rather than raising mirrors section 5's
--    already-established behavior for the same reasons: this is a
--    background data-integrity guard, not a user-facing validation the
--    UI needs to react to.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tags_protect_is_default()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_default AND coalesce(current_setting('wacrm.provisioning_default_tags', true), 'off') <> 'on' THEN
    NEW.is_default := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tags_protect_is_default ON public.tags;
CREATE TRIGGER trg_tags_protect_is_default
  BEFORE INSERT OR UPDATE OF is_default ON public.tags
  FOR EACH ROW
  EXECUTE FUNCTION public.tags_protect_is_default();

-- ------------------------------------------------------------
-- 7) Future accounts — hook into the real, single provisioning path
--    (migration 017's handle_new_user(), the auth.users AFTER INSERT
--    trigger that already creates the account + owner profile).
--    Reproduced in full via CREATE OR REPLACE.
--
--    The defaults call is wrapped in its OWN nested BEGIN/EXCEPTION —
--    NOT the outer one. PL/pgSQL's EXCEPTION clause rolls back every
--    statement since ITS OWN enclosing BEGIN before the handler runs;
--    scoping this block to just the PERFORM call means a defaults
--    failure only undoes the (harmless, nothing-inserted) tags
--    attempt — the account + profile inserted just above are
--    unaffected, exactly like the outer handler already protects
--    them from a *different* kind of failure without also hiding one
--    inside the other.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  BEGIN
    PERFORM public.create_default_account_tags(v_account_id, NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Failed to provision default tags for account % (user %): %',
      v_account_id, NEW.id, SQLERRM;
  END;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- ------------------------------------------------------------
-- 8) redeem_invitation() (migration 019) — reproduced in full via
--    CREATE OR REPLACE. The ONLY change from 019's original is the
--    `tags` branch of the domain-data UNION ALL, which now excludes
--    `is_default` rows: an untouched default tag must not block a
--    fresh invited signup from joining the inviter's account (every
--    fresh account has 6 of them as of this migration), but a
--    genuinely user-created tag — or a default the user has since
--    edited (see section 5, which clears the flag) — still does,
--    preserving 019's original "never silently lose domain data"
--    guarantee exactly as before for anything that isn't purely a
--    stock default.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID  -- the joined account_id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  -- Caller's current account + its owner.
  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    -- Defensive — every authenticated user has a profile post-017.
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  -- Edge case: the inviter sent themselves a link, or the
  -- caller is somehow already in the inviter's account.
  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  -- Safety: the caller must be the SOLE OWNER of their current
  -- account (i.e. their fresh personal account from signup or a
  -- prior removal). Any other state means they're either:
  --   - a member of another shared account (joining a second
  --     would silently orphan their access to the first), or
  --   - the owner of an account with teammates (they'd abandon
  --     their team to join the inviter's).
  -- Either way, the safe answer is "make a different login".
  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Belt: even if they own their account, refuse if it has any
  -- domain data — joining would orphan their contacts, deals,
  -- broadcasts, automations, flows, templates, etc.
  --
  -- `tags` excludes `is_default` rows (P3, migration 049) — an
  -- untouched, system-provisioned default must not count as data the
  -- user would lose; a genuinely created (or since-edited, see
  -- section 5 above) tag still does.
  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id AND NOT is_default
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Move the profile first so the cascade-on-delete of the old
  -- account doesn't try to nuke this user's profile too.
  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Clean up the orphan personal account. Its only rows left by now
  -- are the 6 (or fewer) is_default tags checked above — the
  -- ON DELETE CASCADE on accounts(id) <- tags.account_id (migration
  -- 017) removes them along with the account itself.
  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
