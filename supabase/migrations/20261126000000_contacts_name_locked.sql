-- FIX 03: protect names edited by a person from the automatic WhatsApp profile-name sync.
--
-- Additive and idempotent. `DEFAULT false` with NOT NULL is a metadata-only change on PostgreSQL 11+
-- (no table rewrite). Existing contacts keep their current names and are NOT locked: nothing in the data
-- tells a manual name from an automatic one, so none is assumed manual.
--
-- Semantics (enforced by the application, not by a trigger):
--   * name_locked = false -> inbound WhatsApp/ManyChat events may refresh contacts.name from the profile.
--   * name_locked = true  -> contacts.name was set by a person/API/automation; inbound events never overwrite it.
-- No RLS or grant changes: the column inherits the existing contacts policies.
-- Rollback: previous application versions ignore the column; it can stay in place.
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS name_locked boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.contacts.name_locked IS
  'true when contacts.name was set manually (UI, API, automation); the WhatsApp profile-name sync must not overwrite it.';
