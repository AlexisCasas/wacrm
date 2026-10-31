-- Read-only checks for the "Confirmar pedido" pilot. Run with:
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -v acc="'<ACCOUNT_ID>'" -f - < scripts/ops/orders-pilot-verify.sql
\echo '== 1. objects (after migrations): expect 4 tables, functions present'
SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('order_integration_settings','order_confirmations','order_confirmation_deliveries','order_sellers') ORDER BY 1;
SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('create_order_confirmation','order_seller_candidates','order_seller_display_name','claim_order_deliveries','finish_order_delivery','acknowledge_order_delivery','order_confirmations_freeze') ORDER BY 1;
\echo '== 2. RLS enabled on every order table (expect all t)'
SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'order\_%' AND relkind='r' ORDER BY 1;
\echo '== 3. functions closed to browser roles (expect no rows for anon/authenticated)'
SELECT p.proname, r.rolname FROM pg_proc p CROSS JOIN pg_roles r WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('create_order_confirmation','order_seller_candidates','claim_order_deliveries','finish_order_delivery','acknowledge_order_delivery') AND r.rolname IN ('anon','authenticated','public') AND has_function_privilege(r.oid, p.oid, 'EXECUTE');
\echo '== 4. switches (expect no rows before enabling; then confirm_enabled=t, enabled=f for the pilot only)'
SELECT account_id = :acc::uuid AS is_pilot, confirm_enabled, enabled FROM order_integration_settings;
\echo '== 5. eligible sellers of the pilot account (name + role only)'
SELECT name, account_role FROM order_seller_candidates(:acc::uuid) ORDER BY account_role, name;
\echo '== 6. no seller leaks across accounts (expect 0)'
SELECT count(*) FROM order_seller_candidates(:acc::uuid) c WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = c.user_id AND p.account_id = :acc::uuid);
\echo '== 7. orders by delivery state (expect only held; zero sending/sent)'
SELECT d.delivery_status, count(*) FROM order_confirmation_deliveries d GROUP BY 1 ORDER BY 1;
