-- READ-ONLY verification of migration 20261125000000 (use after applying it anywhere). Expected: every line ends in 't'.
select 'table exists' chk, to_regclass('public.inbound_dispatch_ledger') is not null ok
union all select 'rls enabled', (select relrowsecurity from pg_class where oid='public.inbound_dispatch_ledger'::regclass)
union all select 'primary key is (account_id, wamid): tenant-scoped', (select array_agg(a.attname order by a.attnum)::text from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey) where i.indrelid='public.inbound_dispatch_ledger'::regclass and i.indisprimary) = '{account_id,wamid}'
union all select 'account_id references accounts (cascade)', exists(select 1 from pg_constraint where conrelid='public.inbound_dispatch_ledger'::regclass and contype='f' and confrelid='public.accounts'::regclass and confdeltype='c')
union all select 'anon/authenticated have NO table access', not (has_table_privilege('anon','public.inbound_dispatch_ledger','SELECT') or has_table_privilege('authenticated','public.inbound_dispatch_ledger','SELECT') or has_table_privilege('authenticated','public.inbound_dispatch_ledger','INSERT') or has_table_privilege('authenticated','public.inbound_dispatch_ledger','UPDATE') or has_table_privilege('authenticated','public.inbound_dispatch_ledger','DELETE'))
union all select 'service_role has table access', has_table_privilege('service_role','public.inbound_dispatch_ledger','SELECT,INSERT,UPDATE,DELETE')
union all select 'no policy grants row access to end users', not exists(select 1 from pg_policy where polrelid='public.inbound_dispatch_ledger'::regclass)
union all select 'fn '||p.proname||': service_role only (anon/authenticated cannot EXECUTE)', has_function_privilege('service_role',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
  from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'inbound_dispatch_%'
union all select 'fn '||p.proname||': SECURITY INVOKER (never elevates)', not p.prosecdef from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'inbound_dispatch_%'
union all select '8 ledger functions exist', (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'inbound_dispatch_%')=8;
