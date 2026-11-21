-- SYNC-00/01. READ ONLY. Produces one JSON row per WACRM order without raw customer PII.
-- Run inside an explicit READ ONLY transaction.
WITH payment AS (
  SELECT order_id, COALESCE(SUM(amount) FILTER (WHERE status = 'confirmed'), 0)::numeric(12,2) AS paid
  FROM public.order_payments GROUP BY order_id
), vouchers AS (
  SELECT order_id, jsonb_agg(jsonb_build_object(
    'shalom_number', COALESCE(reviewed_data->>'shalom_number', ocr_result->>'shalom_number'),
    'shalom_code', COALESCE(reviewed_data->>'shalom_code', ocr_result->>'shalom_code'),
    'status', status
  ) ORDER BY created_at) AS rows
  FROM public.order_documents WHERE kind = 'voucher' GROUP BY order_id
), last_shipment AS (
  SELECT DISTINCT ON (order_id) order_id, tracking_number, tracking_code, logistic_status
  FROM public.order_shipments ORDER BY order_id, created_at DESC
), msg AS (
  SELECT o.id AS order_id,
    EXISTS (SELECT 1 FROM public.order_template_dispatches d WHERE d.order_id = o.id AND d.status = 'sent') AS packaging,
    EXISTS (SELECT 1 FROM public.order_shipment_voucher_messages v WHERE v.order_id = o.id AND v.status = 'sent') AS shipment_voucher,
    EXISTS (SELECT 1 FROM public.order_shipment_messages m WHERE m.order_id = o.id AND m.kind = 'destination_arrival_customer' AND m.status = 'sent') AS arrival,
    EXISTS (SELECT 1 FROM public.order_shipment_messages m WHERE m.order_id = o.id AND m.kind = 'destination_15d_customer' AND m.status = 'sent') AS reminder
  FROM public.order_confirmations o
)
SELECT jsonb_build_object(
  'canonical_order_id', o.id,
  'delivery_status', o.delivery_status,
  'coverage', jsonb_build_object(
    'customer', true, 'product', true, 'total', true, 'payments', true, 'balance', true,
    'voucher', true, 'packing', true, 'shalom', true, 'tracking', true, 'messages', true
  ),
  'product_key', lower(btrim(o.product)),
  'total', o.price,
  'paid', COALESCE(p.paid, 0),
  'balance', GREATEST(o.price - COALESCE(p.paid, 0), 0),
  'customer', jsonb_build_object(
    'has_name', NULLIF(btrim(o.customer_name), '') IS NOT NULL AND btrim(o.customer_name) <> '.',
    'has_phone', NULLIF(btrim(o.phone), '') IS NOT NULL AND btrim(o.phone) <> '.',
    'has_dni', NULLIF(btrim(o.dni), '') IS NOT NULL AND btrim(o.dni) <> '.',
    'has_destination', NULLIF(btrim(o.destination), '') IS NOT NULL AND btrim(o.destination) <> '.'
  ),
  'vouchers', COALESCE(v.rows, '[]'::jsonb),
  'packing_completed', l.packaging_completed_at IS NOT NULL,
  'shipment', CASE WHEN s.order_id IS NULL THEN NULL ELSE jsonb_build_object(
    'tracking_number', s.tracking_number, 'tracking_code', s.tracking_code, 'status', s.logistic_status
  ) END,
  'messages', jsonb_build_object(
    'packaging', COALESCE(m.packaging, false),
    'shipment_voucher', COALESCE(m.shipment_voucher, false),
    'arrival', COALESCE(m.arrival, false),
    'reminder', COALESCE(m.reminder, false)
  )
)
FROM public.order_confirmations o
LEFT JOIN payment p ON p.order_id = o.id
LEFT JOIN vouchers v ON v.order_id = o.id
LEFT JOIN public.order_logistics l ON l.order_id = o.id
LEFT JOIN last_shipment s ON s.order_id = o.id
LEFT JOIN msg m ON m.order_id = o.id
ORDER BY o.confirmed_at, o.id;
