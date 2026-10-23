-- the 6 columns that 076 adds are removed from the row image, so "before" and "after" hash exactly the same original columns;
-- one row per table ALWAYS (an empty table gives count 0 and the hash of the empty string), so the result has exactly 4 lines
SELECT t.n || ':' || count(z.id) || ':' || md5(coalesce(string_agg(z.j, ',' ORDER BY z.id), '')) FROM (VALUES ('items'), ('products'), ('requests'), ('sends')) t(n)
LEFT JOIN (
  SELECT 'products' AS t, id, (to_jsonb(x) - ARRAY['purpose_id','identifier_id','selection_mode','purpose_name','identifier_name','node_key'])::text AS j FROM public.audio_guide_products x
  UNION ALL SELECT 'items', id, (to_jsonb(x) - ARRAY['purpose_id','identifier_id','selection_mode','purpose_name','identifier_name','node_key'])::text FROM public.audio_guide_items x
  UNION ALL SELECT 'requests', id, (to_jsonb(x) - ARRAY['purpose_id','identifier_id','selection_mode','purpose_name','identifier_name','node_key'])::text FROM public.audio_guide_requests x
  UNION ALL SELECT 'sends', id, (to_jsonb(x) - ARRAY['purpose_id','identifier_id','selection_mode','purpose_name','identifier_name','node_key'])::text FROM public.audio_guide_sends x
) z ON z.t = t.n GROUP BY t.n ORDER BY t.n;
