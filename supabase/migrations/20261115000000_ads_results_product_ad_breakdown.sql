-- Additive read-only function for "Resultados de anuncios" -> "Rendimiento por producto" -> drilldown "Anuncios atribuidos".
-- No table/column/data change; ads_results_report, ads_results_by_product and order_ad_attribution are NOT modified. SECURITY INVOKER (RLS applies) and it
-- additionally requires agent+ membership of p_account. Must order AFTER 20261114000000_ads_results_by_product (same product normalisation) and
-- 20261111000000_meta_capi_ad_results (order_ad_attribution).
--
-- ads_results_product_ad_breakdown: one row per (SOLD product, ad bucket).
--   * Order -> ad uses EXACTLY the resolution of ads_results_report: LEFT JOIN order_ad_attribution(p_account); no evidence (or an order without contact)
--     => source_id NULL = "Sin atribución comprobable"; evidence without an id => '(sin id de anuncio)'. An order lands in exactly ONE bucket.
--   * Lines and product normalisation are those of ads_results_by_product (item lines, or the single legacy header line; lower(btrim(name)); display
--     name = the line name with most units over ALL ads of that product, so `product` here equals `product` there).
--   * Per product, SUM(orders), SUM(units) and SUM(sales) over its buckets equal the product row of ads_results_by_product. `buyers` does NOT add up:
--     a contact who bought the same product under two different ads counts once in each bucket.
--   * Nothing is prorated: every line keeps its own subtotal (legacy one-line orders keep the order price).
CREATE FUNCTION public.ads_results_product_ad_breakdown(p_account UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (product TEXT, source_id TEXT, buyers BIGINT, orders BIGINT, units BIGINT, sales NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH guard AS (SELECT public.is_account_member(p_account, 'agent') AS ok),
  ords AS (
    SELECT o.id, o.contact_id, o.product, o.quantity, o.price,
           CASE WHEN att.order_id IS NULL THEN NULL ELSE COALESCE(att.source_id, '(sin id de anuncio)') END AS ad
    FROM public.order_confirmations o
    LEFT JOIN public.order_ad_attribution(p_account) att ON att.order_id = o.id, guard
    WHERE guard.ok AND o.account_id = p_account AND o.confirmed_at >= p_from AND o.confirmed_at < p_to
  ),
  lines AS (
    SELECT od.id AS order_id, od.contact_id, od.ad, i.product_name AS name, i.quantity::BIGINT AS qty, i.subtotal AS amount
    FROM ords od JOIN public.order_confirmation_items i ON i.order_id = od.id AND i.account_id = p_account
    UNION ALL
    SELECT od.id, od.contact_id, od.ad, od.product, od.quantity::BIGINT, od.price
    FROM ords od WHERE NOT EXISTS (SELECT 1 FROM public.order_confirmation_items i WHERE i.order_id = od.id AND i.account_id = p_account)
  ),
  disp AS (
    SELECT lower(btrim(l.name)) AS k, (array_agg(l.name ORDER BY l.qty DESC, l.name))[1] AS product
    FROM lines l GROUP BY lower(btrim(l.name))
  )
  SELECT d.product,
         l.ad AS source_id,
         COUNT(DISTINCT l.contact_id) AS buyers,
         COUNT(DISTINCT l.order_id) AS orders,
         SUM(l.qty)::BIGINT AS units,
         SUM(l.amount) AS sales
  FROM lines l JOIN disp d ON d.k = lower(btrim(l.name))
  GROUP BY d.k, d.product, l.ad
  ORDER BY d.product, SUM(l.amount) DESC, l.ad NULLS LAST;
$$;
REVOKE ALL ON FUNCTION public.ads_results_product_ad_breakdown(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ads_results_product_ad_breakdown(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
