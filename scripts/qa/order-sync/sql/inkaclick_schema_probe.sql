-- SYNC-00/01 InkaClick production schema probe. READ ONLY, metadata only, no row values / PII.
-- Purpose: discover the exact production tables/columns for voucher, Shalom, tracking, payments, packing and messages
-- before extending inkaclick_snapshot.sql. Do not infer missing table names from old application code.
SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    table_name ILIKE ANY (ARRAY['%voucher%','%shalom%','%shipment%','%tracking%','%payment%','%message%','%order%'])
    OR column_name ILIKE ANY (ARRAY[
      '%voucher%','%shalom%','%tracking%','%guia%','%codigo%','%numero_orden%',
      '%pago%','%saldo%','%embalaje%','%whatsapp%','%external_order_id%','%confirmed_order_id%'
    ])
  )
ORDER BY table_name, ordinal_position;

SELECT routine_schema, routine_name, routine_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name ILIKE ANY (ARRAY['%voucher%','%shalom%','%shipment%','%tracking%','%payment%','%order%'])
ORDER BY routine_name;
