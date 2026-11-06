#!/bin/sh
# READ-ONLY health probe of the Sheets export: SELECTs only. Prints "<code> <value>" lines; a code with a value > 0 is an alert. No secrets, no PII.
q() { docker exec -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000' supabase-db psql -U postgres -d postgres -At -c "$1"; }
echo "S1_dead_jobs $(q "select count(*) from order_sheet_exports where status='dead'")"
echo "S2_stuck_jobs $(q "select count(*) from order_sheet_exports where status in ('pending','processing') and updated_at < now() - interval '15 minutes' and next_attempt_at < now() - interval '15 minutes'")"
echo "S3_lease_held_over_10m $(q "select count(*) from order_sheet_destinations where enabled and lease_token is not null and lease_expires_at < now() - interval '10 minutes'")"
echo "S4_destination_enabled_without_global_switch $(q "select case when exists (select 1 from order_sheet_destinations where enabled) and '$(docker exec wacrm-app-1 printenv ORDERS_SHEETS_EXPORT_ENABLED 2>/dev/null | tr -d '\r\n')' <> 'true' then 1 else 0 end")"
echo "S5_exported_but_acknowledged_without_job $(q "select count(*) from order_confirmations o join order_sheet_destinations d on d.account_id=o.account_id and d.enabled where o.delivery_status='acknowledged' and (d.eligible_since is null or o.confirmed_at>=d.eligible_since) and o.confirmed_at < now() - interval '15 minutes' and not exists (select 1 from order_sheet_exports e where e.order_id=o.id)")"
echo "I_enabled_destinations $(q "select count(*) from order_sheet_destinations where enabled")"
echo "I_exported $(q "select count(*) from order_sheet_exports where status='exported'")"
