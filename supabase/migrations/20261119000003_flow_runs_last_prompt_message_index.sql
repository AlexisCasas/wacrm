-- Bulk (and single) contact deletion was still hitting the API role's 8 s statement_timeout (SQLSTATE 57014). Measured with the real delete
-- of a 100-contact / 1980-message batch inside a rolled-back transaction: 19.6 s of the 20.6 s total were the foreign-key trigger
-- flow_runs_last_prompt_message_id_fkey (flow_runs.last_prompt_message_id -> messages.id, ON DELETE SET NULL). Deleting a message fires it
-- once PER MESSAGE and the column has no index, so each call scanned all of flow_runs (~50 k rows, ~2.2 k pages, ~11.7 ms).
-- Only ~800 flow_runs rows have a value, so a partial index is tiny (~48 kB measured on a copy) and turns each call into an index probe
-- (~0.04 ms). Index-only change: no data, function, grant, policy or timeout change; delete semantics are unchanged (nothing is blocked or
-- tombstoned; the same phone/BSUID can still create a new contact and chat).
-- Plain CREATE INDEX like the rest of the repo; on a live database it may be built first with CREATE INDEX CONCURRENTLY IF NOT EXISTS using
-- the same name and predicate, which makes this file a no-op.

CREATE INDEX IF NOT EXISTS idx_flow_runs_last_prompt_message ON public.flow_runs (last_prompt_message_id) WHERE last_prompt_message_id IS NOT NULL;
