-- SYNC-00/01 CORE snapshot for InkaClick. READ ONLY.
-- This file intentionally uses ONLY confirmed_orders columns verified in AlexisCasas/InkaClick-Saas.
-- Voucher/Shalom/message tables in production are NOT assumed here; schema_probe.sql discovers them first.
WITH c AS (
  SELECT x.*, to_jsonb(x) AS j FROM public.confirmed_orders x
)
SELECT jsonb_build_object(
  'canonical_order_id', NULLIF(c.j->>'external_order_id', ''),
  'legacy_inkaclick_id', c.id,
  'source', COALESCE(c.j->>'source', 'manychat'),
  'coverage', jsonb_build_object(
    'customer', true, 'product', true, 'total', true, 'payments', true, 'balance', true,
    'voucher', false, 'packing', true, 'shalom', false, 'tracking', false, 'messages', false
  ),
  'product_key', lower(btrim(COALESCE(c.j->>'producto', ''))),
  'total', NULLIF(c.j->>'precio', '')::numeric,
  'paid', COALESCE(NULLIF(c.j->>'pago_inicial', '')::numeric, 0),
  'balance', COALESCE(
    NULLIF(c.j->>'pago_restante', '')::numeric,
    GREATEST(NULLIF(c.j->>'precio', '')::numeric - COALESCE(NULLIF(c.j->>'pago_inicial', '')::numeric, 0), 0)
  ),
  'customer', jsonb_build_object(
    'has_name', NULLIF(btrim(COALESCE(c.j->>'nombre_completo', '')), '') IS NOT NULL AND btrim(COALESCE(c.j->>'nombre_completo', '')) <> '.',
    'has_phone', NULLIF(btrim(COALESCE(c.j->>'telefono', '')), '') IS NOT NULL AND btrim(COALESCE(c.j->>'telefono', '')) <> '.',
    'has_dni', NULLIF(btrim(COALESCE(c.j->>'dni', '')), '') IS NOT NULL AND btrim(COALESCE(c.j->>'dni', '')) <> '.',
    'has_destination', NULLIF(btrim(COALESCE(c.j->>'destino', '')), '') IS NOT NULL AND btrim(COALESCE(c.j->>'destino', '')) <> '.'
  ),
  'vouchers', '[]'::jsonb,
  'packing_completed', lower(COALESCE(c.j->>'estado_pedido', '')) IN ('procesado', 'pagado'),
  'shipment', NULL,
  'messages', '{}'::jsonb
)
FROM c
ORDER BY c.created_at, c.id;
