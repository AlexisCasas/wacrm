-- SEARCH-01: DRAFT ONLY. NOT AN APPLIED MIGRATION.
-- Before any database change, generate a migration via \`supabase migration new\`
-- in a verified disposable WACRM QA checkout; copy/review this content
-- there, then verify migration ordering and the RLS/security QA gates.
--
-- Returns native conversations rows so PostgREST can embed
-- contact:contacts!inner(*,contact_tags(tags(*))) on the RPC result.
-- A normal (read-only) SECURITY INVOKER function preserves RLS on both
-- conversations and contacts. No caller-supplied account_id or
-- SECURITY DEFINER, and contacts must have the same account as the chat.
--
-- Intentionally NO LIMIT: the client pages deterministically to retain
-- conversations after the first 1,000 matches.
--
-- The phone_normalized equality path is strictly additive for complete
-- phone-looking inputs. Existing substring criteria for name, phone,
-- wa_username and last_message_text remain unchanged.
--
-- The SQL function does NOT by itself guarantee faster search:
-- ILIKE '%term%' still needs query-plan inspection and likely trigram
-- indexes in a separately authorized migration.

CREATE OR REPLACE FUNCTION public.search_inbox_conversations(p_search text)
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
    AND (
      ct.name ILIKE '%' || n.term || '%'
      OR ct.phone ILIKE '%' || n.term || '%'
      OR ct.wa_username ILIKE '%' || n.term || '%'
      OR c.last_message_text ILIKE '%' || n.term || '%'
      OR (n.exact_phone IS NOT NULL AND ct.phone_normalized = n.exact_phone)
    );
$search$;

REVOKE ALL ON FUNCTION public.search_inbox_conversations(text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_inbox_conversations(text)
  TO authenticated;

-- PostgREST needs a schema cache reload after the function is created:
-- NOTIFY pgrst, 'reload schema';
-- Execute that only as part of a separately authorized QA migration.
