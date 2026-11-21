-- SYNC-00/01. READ ONLY. Produces one JSON row per InkaClick order without customer PII.
-- Uses to_jsonb so optional/legacy columns can be read without exposing their values.
WITH c AS (
  SELECT x.*, to_jsonb(x) AS j FROM public.confirmed_orders x
), voucher_rows AS (
  SELECT v.confirmed_order_id,
    jsonb_agg(jsonb_build_object(
      'shalom_number', to_jsonb(v)->>'numero_orden',
      'shalom_code', to_jsonb(v)->>'codigo',
      'status', COALESCE(to_jsonb(v)->>'estado_operativo', to_jsonb(v)->>'estado')
    ) ORDER BY v.created_at) AS rows
  FROM public.vouchers v GROUP BY v.confirmed_order_id
)
SELECT jsonb_build_object(
  'canonical_order_id', NULLIF(c.j->>'external_order_id', ''),
  'legacy_inkaclick_id', c.id,
  'source', COALESCE(c.j->>'source', 'manychat'),
  'product_key', lower(btrim(COALESCE(c.j->>'producto', ''))),
  'total', NULLIF(c.j->>'precio', '')::numeric,
  'paid', COALESCE(NULLIF(c.j->>'pago_inicial', '')::numeric, 0),
  'balance', COALESCE(NULLIF(c.j->>'pago_restante', '')::numeric, GREATEST(NULLIF(c.j->>'precio', '')::numeric - COALESCE(NULLIF(c.j->>'pago_inicial', '')::numeric, 0), 0)),
  'customer', jsonb_build_object(
    'has_name', NULLIF(btrim(COALESCE(c.j->>'nombre_completo', '')), '') IS NOT NULL AND btrim(COALESCE(c.j->>'nombre_completo', '')) <> '.',
    'has_phone', NULLIF(btrim(COALESCE(c.j->>'telefono', '')), '') IS NOT NULL AND btrim(COALESCE(c.j->>'telefono', '')) <> '.',
    'has_dni', NULLIF(btrim(COALESCE(c.j->>'dni', '')), '') IS NOT NULL AND btrim(COALESCE(c.j->>'dni', '')) <> '.',
    'has_destination', NULLIF(btrim(COALESCE(c.j->>'destino', '')), '') IS NOT NULL AND btrim(COALESCE(c.j->>'destino', '')) <> '.'
  ),
  'vouchers', COALESCE(v.rows, '[]'::jsonb),
  'packing_completed', COALESCE(NULLIF(c.j->>'whatsapp_embalaje_sent_at', ''), NULLIF(c.j->>'fecha_whatsapp_embalaje', '')) IS NOT NULL OR lower(COALESCE(c.j->>'estado_pedido', '')) IN ('procesado', 'pagado'),
  'shipment', CASE
    WHEN NULLIF(c.j->>'shalom_numero_orden', '') IS NULL AND NULLIF(c.j->>'shalom_codigo', '') IS NULL AND NULLIF(c.j->>'estado_shalom', '') IS NULL THEN NULL
    ELSE jsonb_build_object('tracking_number', c.j->>'shalom_numero_orden', 'tracking_code', c.j->>'shalom_codigo', 'status', c.j->>'estado_shalom')
  END,
  'messages', jsonb_build_object(
    'packaging', NULLIF(c.j->>'whatsapp_embalaje_sent_at', '') IS NOT NULL,
    'shipment_voucher', NULLIF(c.j->>'whatsapp_voucher_sent_at', '') IS NOT NULL,
    'arrival', NULLIF(c.j->>'whatsapp_llegada_sent_at', '') IS NOT NULL,
    'reminder', NULLIF(c.j->>'whatsapp_recordatorio_sent_at', '') IS NOT NULL,
    'balance', false
  )
)
FROM c
LEFT JOIN voucher_rows v ON v.confirmed_order_id = c.id
ORDER BY c.created_at, c.id;
