-- FIX 04 verification (READ-ONLY): run after applying migrations, and after ANY restore of a database backup, before reopening traffic.
-- A backup taken before FIX 04 would bring back the direct DELETE policy and the public EXECUTE on the merge functions; this script fails loudly if so.
-- It reads catalogs only. The one function call is the retired signature, which must raise and never deletes.
DO $$
DECLARE
  fn text;
  bad text;
BEGIN
  -- 1. No direct deletion path for the API roles on contacts.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts' AND cmd IN ('DELETE', 'ALL')) THEN
    RAISE EXCEPTION 'FIX04: public.contacts still has a DELETE/ALL policy';
  END IF;
  FOREACH bad IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_table_privilege(bad, 'public.contacts', 'DELETE') OR has_table_privilege(bad, 'public.contacts', 'TRUNCATE') THEN
      RAISE EXCEPTION 'FIX04: role % can still DELETE/TRUNCATE public.contacts', bad;
    END IF;
  END LOOP;

  -- 2. Destructive functions are not executable by PUBLIC / anon / authenticated.
  FOREACH fn IN ARRAY ARRAY[
    'public.merge_duplicate_contacts()', 'public.merge_duplicate_conversations()',
    'public.bulk_delete_contacts_internal(uuid,uuid[],text)', 'public.bulk_delete_contacts_internal(uuid,uuid[],text,uuid,boolean)',
    'public.contact_delete_impact(uuid,uuid[])', 'public.purge_contact_deletion_audit(interval,interval)', 'public.contact_delete_limits()'
  ] LOOP
    IF has_function_privilege('anon', fn::regprocedure, 'EXECUTE') OR has_function_privilege('authenticated', fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'FIX04: % is executable by anon/authenticated', fn;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = fn::regprocedure AND a.grantee = 0) THEN
      RAISE EXCEPTION 'FIX04: % is executable by PUBLIC', fn;
    END IF;
  END LOOP;

  -- 3. The audit tables: RLS on, not writable by any API role, append-only triggers present.
  FOREACH fn IN ARRAY ARRAY['public.contact_deletion_operations', 'public.contact_deletion_items'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = fn::regclass) THEN RAISE EXCEPTION 'FIX04: % has RLS disabled', fn; END IF;
    FOREACH bad IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_table_privilege(bad, fn::regclass, 'INSERT') OR has_table_privilege(bad, fn::regclass, 'UPDATE')
         OR has_table_privilege(bad, fn::regclass, 'DELETE') OR has_table_privilege(bad, fn::regclass, 'TRUNCATE') THEN
        RAISE EXCEPTION 'FIX04: role % can write to %', bad, fn;
      END IF;
    END LOOP;
    IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = fn::regclass AND NOT tgisinternal) < 2 THEN
      RAISE EXCEPTION 'FIX04: % is missing its append-only triggers', fn;
    END IF;
  END LOOP;

  -- 4. The retired 3-argument signature fails closed (it never deletes).
  BEGIN
    PERFORM public.bulk_delete_contacts_internal(gen_random_uuid(), ARRAY[gen_random_uuid()], NULL);
    RAISE EXCEPTION 'FIX04: the retired deletion signature did not fail';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'ACTOR_REQUIRED' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'FIX04 contact deletion controls: OK';
END $$;
