-- ============================================================
-- 048_tags_case_insensitive_uniqueness
--
-- P3 (docs/P3_TAGS_INBOX_AUDIT.md section K) — today `tags.name` has
-- NO uniqueness guarantee at all, not even an exact-match one:
-- "Pendiente", "pendiente", and "PENDIENTE" can all coexist as three
-- distinct rows in the same account. This adds the case- and
-- whitespace-insensitive guarantee the product needs, scoped per
-- account.
-- ============================================================

-- ------------------------------------------------------------
-- 0) Preflight — abort loudly if historical collisions already
--    exist under the normalized key (account_id, lower(btrim(name))).
--    Never auto-merged, renamed, or deleted: two "Pendiente" rows may
--    have accumulated genuinely different contact_tags relationships,
--    and collapsing them is a product/data decision for a human, not
--    this migration. A blank/whitespace-only name normalizes to the
--    same key ('') as any other blank name, so this also naturally
--    catches multiple blank-named tags in one account without any
--    separate check.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_collision_count INTEGER;
BEGIN
  SELECT count(*) INTO v_collision_count
  FROM (
    SELECT account_id, lower(btrim(name)) AS key
    FROM public.tags
    GROUP BY account_id, lower(btrim(name))
    HAVING count(*) > 1
  ) collisions;

  IF v_collision_count > 0 THEN
    RAISE EXCEPTION
      'tags_case_insensitive_uniqueness preflight failed: % account(s) have two or more tags that collide once normalized (lower(btrim(name))). Resolve these manually (never auto-merge/rename/delete) before re-running migration 048 — see docs/P3_TAGS_INBOX_AUDIT.md section K.',
      v_collision_count;
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 1) The unique guarantee. Named distinctly from the existing
--    non-unique idx_tags_account (migration 017, plain btree on
--    account_id alone) to avoid any confusion between the two.
--
-- Not CREATE INDEX CONCURRENTLY: no other migration in this repo uses
-- it (see e.g. 022's idx_contacts_account_phone_normalized), and
-- CONCURRENTLY cannot run inside the transaction Supabase wraps each
-- migration file in. `tags` is a small, low-write settings-class
-- table, so the brief lock a plain CREATE UNIQUE INDEX takes is an
-- acceptable, consistent trade-off here.
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_account_name_ci
  ON public.tags (account_id, lower(btrim(name)));

-- ------------------------------------------------------------
-- 2) Empty/whitespace-only names — deliberately NOT a DB-level CHECK.
--
-- A `CHECK (btrim(name) <> '')` would be re-evaluated on every future
-- UPDATE of a row that already has a blank name (Postgres CHECK
-- constraints re-validate the whole row on any UPDATE, not just when
-- the checked column changes — the exact gotcha documented for
-- migration 046's phone guard). If any historical blank-name tag
-- exists, that CHECK would silently block unrelated future edits
-- (recoloring it, renaming a DIFFERENT column) until someone manually
-- fixes the name first — a surprise this migration must not introduce.
--
-- The unique index above already limits the blast radius heavily: at
-- most ONE blank-named tag can ever exist per account (a second
-- INSERT/UPDATE with an empty/whitespace name normalizes to the same
-- '' key and is rejected as a duplicate). The remaining gap — a
-- single blank-named tag being created in the first place — is closed
-- at the application layer instead: the new tag-creation service
-- (src/lib/contacts/tag-create.ts) rejects an empty/whitespace name
-- before ever reaching the database. Documented here per the explicit
-- instruction to prefer server-side validation over a DB constraint
-- when the constraint risks blocking unrelated historical writes.
-- ------------------------------------------------------------
