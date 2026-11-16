-- SEARCH-01 V2: DRAFT ONLY. NOT A DEPLOYABLE/APPLIED MIGRATION.
-- Generated/tested on a disposable QA only, after explicit approval.
-- Do not reuse the old (p_search text) RPC: that signature performs
-- LIMIT/OFFSET at the REST layer and repeats large scans.
--
-- Returns native conversations for PostgREST embedding. All rows are
-- checked by the caller's existing conversations/contacts RLS policies:
-- SECURITY INVOKER; never SECURITY DEFINER; no caller-supplied account.
--
-- Keyset cursor: last_message_at DESC NULLS LAST, id ASC. Two values
-- suffice for a stable *unique* total order even with 12,000 equal
-- timestamps. The client uses the final row as the next cursor. SQL
-- enforces a bounded page, not an OFFSET. Client-side final rendering
-- still uses the canonical activity sorter (created_at tie-break).
--
-- This avoids increasing OFFSET sorting/scan overhead, but DOES NOT
-- eliminate the need to evaluate search predicates on later pages.
-- Benchmark under RLS is mandatory; pg_trgm indexes are a separate
-- QA experiment, not an automatic production recommendation.

CREATE OR REPLACE FUNCTION public.search_inbox_conversations_page(
  p_search TEXT,
  p_cursor_last_message_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_id UUID DEFAULT NULL,
  p_page_size INTEGER DEFAULT 1000
)
RETURNS SETOF public.conversations
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $search$
  WITH needle AS (
    SELECT
      NULLIF(btrim(p_search), '') AS term,
      CASE
        WHEN btrim(p_search) ~ '^[+() .0-9-]+$'
          AND length(regexp_replace(btrim(p_search), '\D', '', 'g')) >= 7
        THEN regexp_replace(btrim(p_search), '\D', '', 'g')
        ELSE NULL
      END AS exact_phone
  )
  SELECT c.*
  FROM public.conversations AS c
  JOIN public.contacts AS ct
    ON ct.id = c.contact_id
   AND ct.account_id = c.account_id
  CROSS JOIN needle AS n
  WHERE (SELECT auth.uid()) IS NOT NULL
    AND n.term IS NOT NULL
    AND ct.blocked IS FALSE
    -- A null cursor ID means the FIRST page. Non-null ID with a null
    -- timestamp means we already entered the NULLS LAST portion.
    AND (
      p_cursor_id IS NULL
      OR (
        p_cursor_last_message_at IS NULL
        AND c.last_message_at IS NULL
        AND c.id > p_cursor_id
      )
      OR (
        p_cursor_last_message_at IS NOT NULL
        AND (
          c.last_message_at < p_cursor_last_message_at
          OR (
            c.last_message_at = p_cursor_last_message_at
            AND c.id > p_cursor_id
          )
          OR c.last_message_at IS NULL
        )
      )
    )
    AND (
      ct.name ILIKE '%' || n.term || '%'
      OR ct.phone ILIKE '%' || n.term || '%'
      OR ct.wa_username ILIKE '%' || n.term || '%'
      OR c.last_message_text ILIKE '%' || n.term || '%'
      OR (n.exact_phone IS NOT NULL AND ct.phone_normalized = n.exact_phone)
    )
  ORDER BY c.last_message_at DESC NULLS LAST, c.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_page_size, 1000), 1), 1000);
$search$;

REVOKE ALL ON FUNCTION public.search_inbox_conversations_page(
  TEXT, TIMESTAMPTZ, UUID, INTEGER
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_inbox_conversations_page(
  TEXT, TIMESTAMPTZ, UUID, INTEGER
) TO authenticated;

-- QA ONLY, after DDL with a verified PostgREST QA instance:
-- NOTIFY pgrst, 'reload schema';
--
-- Existing search_inbox_conversations(text) may remain in QA because
-- this V2 has a DIFFERENT name; no production function is touched.
