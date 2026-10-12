-- E4.2A: additive persistence only. Legacy execution remains untouched.
ALTER TABLE public.flow_runs
  ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (execution_mode IN ('legacy', 'versioned')),
  ADD COLUMN root_flow_version_id UUID REFERENCES public.flow_versions(id) ON DELETE RESTRICT,
  ADD COLUMN current_flow_version_id UUID REFERENCES public.flow_versions(id) ON DELETE RESTRICT,
  ADD COLUMN versioned_node_key TEXT,
  ADD COLUMN versioned_nodes_executed INTEGER NOT NULL DEFAULT 0 CHECK (versioned_nodes_executed >= 0 AND versioned_nodes_executed <= 500),
  ADD COLUMN versioned_messages_executed INTEGER NOT NULL DEFAULT 0 CHECK (versioned_messages_executed >= 0 AND versioned_messages_executed <= 100),
  ADD COLUMN versioned_depth INTEGER NOT NULL DEFAULT 0 CHECK (versioned_depth >= 0 AND versioned_depth <= 8),
  ADD COLUMN versioned_checkpoint JSONB,
  ADD COLUMN versioned_lease INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.flow_runs ADD CONSTRAINT flow_runs_versioned_shape CHECK (
  (execution_mode = 'legacy' AND root_flow_version_id IS NULL AND current_flow_version_id IS NULL)
  OR (execution_mode = 'versioned' AND root_flow_version_id IS NOT NULL AND current_flow_version_id IS NOT NULL AND versioned_node_key IS NOT NULL)
);
ALTER TABLE public.flow_runs ADD CONSTRAINT flow_runs_id_account_key UNIQUE (id, account_id);
ALTER TABLE public.flow_runs
  ADD CONSTRAINT flow_runs_root_version_same_account_fkey FOREIGN KEY (root_flow_version_id, account_id) REFERENCES public.flow_versions(id, account_id),
  ADD CONSTRAINT flow_runs_current_version_same_account_fkey FOREIGN KEY (current_flow_version_id, account_id) REFERENCES public.flow_versions(id, account_id);

CREATE TABLE public.flow_run_call_frames (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), flow_run_id UUID NOT NULL, account_id UUID NOT NULL,
  caller_flow_id UUID NOT NULL, caller_flow_version_id UUID NOT NULL,
  call_node_key TEXT NOT NULL, return_node_key TEXT NOT NULL, depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 8),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (flow_run_id, depth),
  FOREIGN KEY (flow_run_id, account_id) REFERENCES public.flow_runs(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (caller_flow_version_id, account_id) REFERENCES public.flow_versions(id, account_id) ON DELETE RESTRICT
);
ALTER TABLE public.flow_run_call_frames ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.flow_run_call_frames FROM PUBLIC;
REVOKE ALL ON TABLE public.flow_run_call_frames FROM anon;
GRANT SELECT ON TABLE public.flow_run_call_frames TO authenticated;
GRANT ALL ON TABLE public.flow_run_call_frames TO service_role;
CREATE POLICY flow_run_call_frames_select ON public.flow_run_call_frames FOR SELECT USING (public.is_account_member(account_id));
