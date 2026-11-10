-- Additive read-only report function for "Resultados de anuncios" -> "Por producto vendido".
-- No table/column/data change; ads_results_report and order_ad_attribution are NOT modified. SECURITY INVOKER (RLS applies) and it additionally
-- requires agent+ membership of p_account. Depends only on order_confirmations, order_confirmation_items (20261105000000) and is_account_member.
--
-- ads_results_by_product: SOLD product (what the order lines say), never "advertised product".
--   * Lines come from order_confirmation_items (unit_price/subtotal are item-level; create_order_confirmation enforces price = SUM(subtotal)),
--     or, for legacy orders WITHOUT items, the single header line (product/quantity/price). Nothing is split or prorated.
--   * Grouped by lower(btrim(product name)). buyers = distinct contacts, orders = distinct orders (an order counts once per product), units/sales summed.
--   * legacy_orders = how many of those orders came from the header fallback (sales there is the whole order price of a one-line legacy order).
CREATE FUNCTION public.ads_results_by_product(p_account UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (product TEXT, buyers BIGINT, orders BIGINT, units BIGINT, sales NUMERIC, legacy_orders BIGINT)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH guard AS (SELECT public.is_account_member(p_account, 'agent') AS ok),
  ords AS (
    SELECT o.id, o.contact_id, o.product, o.quantity, o.price
    FROM public.order_confirmations o, guard
    WHERE guard.ok AND o.account_id = p_account AND o.confirmed_at >= p_from AND o.confirmed_at < p_to
  ),
  lines AS (
    SELECT od.id AS order_id, od.contact_id, i.product_name AS name, i.quantity::BIGINT AS qty, i.subtotal AS amount, FALSE AS legacy
    FROM ords od JOIN public.order_confirmation_items i ON i.order_id = od.id AND i.account_id = p_account
    UNION ALL
    SELECT od.id, od.contact_id, od.product, od.quantity::BIGINT, od.price, TRUE
    FROM ords od WHERE NOT EXISTS (SELECT 1 FROM public.order_confirmation_items i WHERE i.order_id = od.id AND i.account_id = p_account)
  )
  SELECT (array_agg(l.name ORDER BY l.qty DESC, l.name))[1] AS product,
         COUNT(DISTINCT l.contact_id) AS buyers,
         COUNT(DISTINCT l.order_id) AS orders,
         SUM(l.qty)::BIGINT AS units,
         SUM(l.amount) AS sales,
         COUNT(DISTINCT l.order_id) FILTER (WHERE l.legacy) AS legacy_orders
  FROM lines l
  GROUP BY lower(btrim(l.name))
  ORDER BY SUM(l.amount) DESC, SUM(l.qty) DESC, 1;
$$;
REVOKE ALL ON FUNCTION public.ads_results_by_product(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ads_results_by_product(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
