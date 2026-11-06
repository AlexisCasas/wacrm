#!/usr/bin/env bash
# READ-ONLY verification: objects, privileges, RLS, PostgREST visibility, orders untouched. Safe to run any time (before: expects everything absent).
. "$(dirname "$0")/lib.sh"
MODE=${1:-after}
if [ "$MODE" = before ]; then
  chk "tables absent (pending)" "$(tbl_count)" 0; chk "functions absent (pending)" "$(fn_count)" 0
else
  chk "4 tables exist" "$(tbl_count)" 4
  chk "8 functions exist" "$(fn_count)" 8
  chk "RLS enabled on all 4 tables" "$(RO "select count(*) from pg_class where relname in ('order_sheet_destinations','order_sheet_exports','order_sheet_exclusions','order_sheet_events') and relrowsecurity")" 4
  chk "anon/authenticated have NO table privilege" "$(RO "select count(*) from information_schema.role_table_grants where table_name like 'order_sheet%' and grantee in ('anon','authenticated','PUBLIC')")" 0
  chk "service_role can use the tables" "$(RO "select bool_and(has_table_privilege('service_role','public.'||t,'select,insert,update,delete')) from unnest(array['order_sheet_destinations','order_sheet_exports','order_sheet_exclusions','order_sheet_events']) t")" t
  chk "only service_role may execute the 8 functions" "$(RO "select count(*) from pg_proc p where proname like 'order_sheet%' and pronamespace='public'::regnamespace and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute') or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee=0))")" 0
  chk "service_role may execute the 8 functions" "$(RO "select bool_and(has_function_privilege('service_role',p.oid,'execute')) from pg_proc p where proname like 'order_sheet%' and pronamespace='public'::regnamespace")" t
  chk "none is SECURITY DEFINER; search_path pinned" "$(RO "select count(*) from pg_proc where proname like 'order_sheet%' and pronamespace='public'::regnamespace and (prosecdef or proconfig::text not like '%search_path=public%')")" 0
  chk "UNIQUE (spreadsheet_id) present (one file per account)" "$(RO "select count(*) from pg_constraint where conname='order_sheet_destinations_spreadsheet_unique'")" 1
  chk "no destination is enabled yet (nothing can export)" "$(RO "select count(*) from order_sheet_destinations where enabled")" "${EXPECT_ENABLED:-0}"
  RES=$(docker exec wacrm-app-1 node -e "
const url=process.env.NEXT_PUBLIC_SUPABASE_URL, key=process.env.SUPABASE_SERVICE_ROLE_KEY;
fetch(url+'/rest/v1/order_sheet_destinations?select=account_id&limit=1',{headers:{apikey:key,Authorization:'Bearer '+key}})
 .then(async r=>{const t=await r.text();let c='';try{c=JSON.parse(t).code||''}catch(e){} console.log(r.status+' '+(c||'ok'))}).catch(e=>console.log('ERR '+e.message))" 2>&1 | tail -1)
  chk "PostgREST sees the table (read-only probe, HTTP 200)" "${RES%% *}" 200
  [ "${RES%% *}" = 404 ] && echo "     -> schema cache is stale: NOTIFY pgrst, 'reload schema' (pgrst_ddl_watch normally does it)"
  if [ -s $D/migration-pre.txt ]; then
    chk "order switches unchanged by the migration" "$(RO "select 'PRE order_integration_settings md5='||md5(string_agg(t::text,',' order by account_id)) from order_integration_settings t")" "$(grep '^PRE order_integration_settings' $D/migration-pre.txt)"
  fi
fi
[ $fail -eq 0 ] && echo "VERIFY-MIGRATION PASS" || { echo "VERIFY-MIGRATION FAIL"; exit 1; }
