#!/usr/bin/env bash
# QA-ONLY fault injection for F3-04/F3-05. `on` makes every INSERT into flow_nodes fail in the STAGING database (so a real save
# fails halfway through the transaction); `off` removes it. It is a trigger created by hand in this container, never part of a
# migration and never reachable from the app or the network.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
case "${1:-}" in
  on) psql_db <<'SQL'
CREATE OR REPLACE FUNCTION public.qa_f3_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'qa injected persistence failure' USING ERRCODE = 'XX000'; END $$;
DROP TRIGGER IF EXISTS qa_f3_fault ON public.flow_nodes;
CREATE TRIGGER qa_f3_fault BEFORE INSERT ON public.flow_nodes FOR EACH ROW EXECUTE FUNCTION public.qa_f3_fault();
SQL
  echo "fault ON";;
  off) psql_db -c "DROP TRIGGER IF EXISTS qa_f3_fault ON public.flow_nodes; DROP FUNCTION IF EXISTS public.qa_f3_fault()" >/dev/null; echo "fault OFF";;
  *) echo "usage: fault.sh on|off" >&2; exit 2;;
esac
