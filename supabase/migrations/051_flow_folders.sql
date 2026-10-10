-- ============================================================
-- 051_flow_folders
--
-- E3/F05 — flat, account-scoped flow folders. This migration is
-- additive: existing flows remain unfiled (folder_id IS NULL), and no
-- flow nodes, runs, triggers, or execution state are changed.
-- ============================================================

CREATE TABLE public.flow_folders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT flow_folders_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT flow_folders_name_trimmed CHECK (name = btrim(name)),
  CONSTRAINT flow_folders_name_max_length CHECK (char_length(name) <= 80),
  -- Required for the composite FK below. id remains the ordinary PK;
  -- this pair makes tenant equality part of referential integrity.
  CONSTRAINT flow_folders_id_account_key UNIQUE (id, account_id)
);

CREATE UNIQUE INDEX flow_folders_account_name_ci_key
  ON public.flow_folders (account_id, lower(name));

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.flow_folders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.flow_folders ENABLE ROW LEVEL SECURITY;

-- Do not rely on project-level default privileges for this new table.
-- PostgreSQL grants are only the coarse gate; the policies below remain
-- mandatory and distinguish viewer from agent/admin/owner.
REVOKE ALL ON TABLE public.flow_folders FROM PUBLIC;
REVOKE ALL ON TABLE public.flow_folders FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_folders TO authenticated;
GRANT ALL ON TABLE public.flow_folders TO service_role;

CREATE POLICY flow_folders_select ON public.flow_folders
  FOR SELECT USING (public.is_account_member(account_id));
CREATE POLICY flow_folders_insert ON public.flow_folders
  FOR INSERT WITH CHECK (public.is_account_member(account_id, 'agent'));
CREATE POLICY flow_folders_update ON public.flow_folders
  FOR UPDATE
  USING (public.is_account_member(account_id, 'agent'))
  WITH CHECK (public.is_account_member(account_id, 'agent'));
CREATE POLICY flow_folders_delete ON public.flow_folders
  FOR DELETE USING (public.is_account_member(account_id, 'agent'));

ALTER TABLE public.flows ADD COLUMN folder_id UUID;

ALTER TABLE public.flows
  ADD CONSTRAINT flows_folder_same_account_fkey
  FOREIGN KEY (folder_id, account_id)
  REFERENCES public.flow_folders (id, account_id)
  ON UPDATE RESTRICT
  ON DELETE RESTRICT;

CREATE INDEX idx_flows_account_folder ON public.flows (account_id, folder_id);

-- Delete is deliberately a server-side transaction, rather than an
-- ON DELETE SET NULL action on the composite FK. It takes a row lock on
-- the folder, clears only same-account flows, then deletes the folder.
-- A concurrent move to this folder blocks on the lock and then fails
-- referential integrity instead of leaving a dangling/cross-tenant row.
CREATE FUNCTION public.delete_flow_folder(p_folder_id UUID)
RETURNS TABLE(deleted BOOLEAN, flow_id UUID, flow_updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT account_id
    INTO v_account_id
    FROM public.flow_folders
    WHERE id = p_folder_id
    FOR UPDATE;

  IF NOT FOUND THEN
    deleted := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  RETURN QUERY
  WITH cleared AS (
    UPDATE public.flows
      SET folder_id = NULL
      WHERE account_id = v_account_id
        AND folder_id = p_folder_id
      RETURNING id, updated_at
  ), removed AS (
    DELETE FROM public.flow_folders
      WHERE id = p_folder_id
        AND account_id = v_account_id
      RETURNING id
  )
  SELECT TRUE, cleared.id, cleared.updated_at
    FROM removed
    LEFT JOIN cleared ON TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_flow_folder(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_flow_folder(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_flow_folder(UUID) TO authenticated;
