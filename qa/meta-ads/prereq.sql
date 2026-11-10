-- QA prerequisites for a DISPOSABLE plain PostgreSQL: the minimum slice of the Supabase environment that the Meta Ads migrations rely on.
-- Copied from the production catalog (read-only inspection): roles and their attributes, the schema ACLs, the DEFAULT PRIVILEGES that Supabase applies to
-- everything the `postgres` role creates in `public` (this is what makes a "forgotten" REVOKE a real exposure), auth.uid(), account_role_enum,
-- accounts / profiles (columns used by is_account_member) and public.is_account_member itself. NOTHING here is production data.
\set ON_ERROR_STOP on

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
GRANT USAGE ON SCHEMA auth, extensions TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
CREATE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ select gen_random_uuid() $$;

CREATE TYPE public.account_role_enum AS ENUM ('owner', 'admin', 'agent', 'viewer');
CREATE TABLE public.accounts (
  id uuid DEFAULT extensions.uuid_generate_v4() PRIMARY KEY,
  name text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.profiles (
  id uuid DEFAULT extensions.uuid_generate_v4() PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  email text NOT NULL,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  account_role public.account_role_enum NOT NULL
);
CREATE FUNCTION public.is_account_member(target_account_id uuid, min_role account_role_enum DEFAULT 'viewer'::account_role_enum)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = auth.uid() AND p.account_id = target_account_id
      AND CASE p.account_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END
        >= CASE min_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END
  );
$function$;

-- Synthetic tenants: A (agent uA, viewer uV) and B (agent uB).
INSERT INTO auth.users (id) VALUES ('a0000000-0000-4000-8000-0000000000a1'), ('c0000000-0000-4000-8000-0000000000c3'), ('b0000000-0000-4000-8000-0000000000b2');
INSERT INTO public.accounts (id, name, owner_user_id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Cuenta A', 'a0000000-0000-4000-8000-0000000000a1'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Cuenta B', 'b0000000-0000-4000-8000-0000000000b2');
INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role) VALUES
  ('a0000000-0000-4000-8000-0000000000a1', 'Agente A', 'a@example.test', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'agent'),
  ('c0000000-0000-4000-8000-0000000000c3', 'Viewer A', 'v@example.test', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'viewer'),
  ('b0000000-0000-4000-8000-0000000000b2', 'Agente B', 'b@example.test', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'agent');

-- QA helpers (usable under any role).
CREATE SCHEMA qa;
GRANT USAGE ON SCHEMA qa TO PUBLIC;
CREATE FUNCTION qa.ok(name text, cond boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', name; END IF;
  RAISE NOTICE 'PASS: %', name;
END $$;
-- Runs `stmt` as the CURRENT role and requires it to fail with the given SQLSTATE (42501 = permission denied, 23514 = check, 23502 = not null, 23503 = fk, 23505 = unique).
CREATE FUNCTION qa.raises(name text, stmt text, expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = expected THEN RAISE NOTICE 'PASS: % [%]', name, SQLSTATE; RETURN; END IF;
    RAISE EXCEPTION 'FAIL: % raised % (%) instead of %', name, SQLSTATE, SQLERRM, expected;
  END;
  RAISE EXCEPTION 'FAIL: % did not raise', name;
END $$;
-- Runs a query returning one scalar as the CURRENT role and compares it (as text) with the expectation.
CREATE FUNCTION qa.eq(name text, query text, expected text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got text;
BEGIN
  EXECUTE query INTO got;
  IF got IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: % -> got [%] expected [%]', name, got, expected; END IF;
  RAISE NOTICE 'PASS: % = %', name, expected;
END $$;
