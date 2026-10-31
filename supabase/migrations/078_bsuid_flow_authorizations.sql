-- ============================================================
-- 078_bsuid_flow_authorizations
--
-- BSUID phase 3: lets Flows (and nothing else) serve contacts that are known only by a WhatsApp user id, under a DB-managed,
-- CLOSED-BY-DEFAULT authorization that can be switched on/off without restarting the app.
--
-- Additive only: three new tables and three new functions. No existing table, column, policy or function changes, so the previous
-- image keeps working unchanged. Idempotent (IF NOT EXISTS / CREATE OR REPLACE).
--
--   bsuid_pilot_scopes          which business numbers (account + phone_number_id + WABA) have BSUID support on, in addition to the
--                                WHATSAPP_BSUID_PILOT environment variable (the union applies). Default row state: disabled.
--   bsuid_flow_settings         per-account master switch for Flows on BSUID contacts (the account-level kill switch). Default: off.
--   bsuid_flow_authorizations   which FLOW may serve BSUID contacts, optionally only ONE contact (canary), per message modality
--                                (text / media / buttons / list / audio), optionally expiring. Default: disabled, text only.
--
-- Nothing here is readable or writable by clients: RLS is on with no policies and every privilege is revoked from anon and
-- authenticated; only service_role (the server) and the operator script (postgres) can use the tables and the two check functions.
-- A browser or the public API cannot declare "this send comes from an authorized Flow": the check is made by the server against a real,
-- active flow_runs row of that contact, never against a value the caller supplies.
--
--   bsuid_flow_scope(account, contact)                 -> the flow ids that may START or CONTINUE for this contact
--   bsuid_flow_send_check(account, run, contact, mod)  -> 'ok' or the reason for refusal (checked on EVERY send, so the kill switch
--                                                          and a flow switch act on the very next message of a run in progress)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.bsuid_pilot_scopes (
  account_id      uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  phone_number_id text        NOT NULL CHECK (phone_number_id ~ '^[0-9]{6,25}$'),
  waba_id         text        NOT NULL CHECK (waba_id ~ '^[0-9]{6,25}$'),
  enabled         boolean     NOT NULL DEFAULT false,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, phone_number_id, waba_id)
);

CREATE TABLE IF NOT EXISTS public.bsuid_flow_settings (
  account_id    uuid        PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  flows_enabled boolean     NOT NULL DEFAULT false,
  note          text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bsuid_flow_authorizations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  flow_id     uuid        NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  contact_id  uuid        REFERENCES public.contacts(id) ON DELETE CASCADE,   -- NULL = any BSUID contact of the account
  enabled     boolean     NOT NULL DEFAULT false,
  allow_text    boolean   NOT NULL DEFAULT true,
  allow_media   boolean   NOT NULL DEFAULT false,
  allow_buttons boolean   NOT NULL DEFAULT false,
  allow_list    boolean   NOT NULL DEFAULT false,
  allow_audio   boolean   NOT NULL DEFAULT false,
  expires_at  timestamptz,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bsuid_flow_authorizations_scope_uq
  ON public.bsuid_flow_authorizations (account_id, flow_id, COALESCE(contact_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- The flow and the contact must belong to the SAME account as the authorization (no cross-account authorization is storable).
CREATE OR REPLACE FUNCTION public.bsuid_flow_authorization_integrity() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.flows f WHERE f.id = NEW.flow_id AND f.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'flow does not belong to this account' USING ERRCODE = '42501';
  END IF;
  IF NEW.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = NEW.contact_id AND c.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'contact does not belong to this account' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bsuid_flow_authorization_integrity ON public.bsuid_flow_authorizations;
CREATE TRIGGER bsuid_flow_authorization_integrity BEFORE INSERT OR UPDATE ON public.bsuid_flow_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.bsuid_flow_authorization_integrity();

ALTER TABLE public.bsuid_pilot_scopes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bsuid_flow_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bsuid_flow_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bsuid_pilot_scopes, public.bsuid_flow_settings, public.bsuid_flow_authorizations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.bsuid_pilot_scopes, public.bsuid_flow_settings, public.bsuid_flow_authorizations TO service_role;

-- Flows that may start or continue for this contact: master switch on, authorization enabled and not expired, flow active and of this account,
-- and the authorization either for the whole account or for exactly this contact.
CREATE OR REPLACE FUNCTION public.bsuid_flow_scope(p_account_id uuid, p_contact_id uuid) RETURNS uuid[]
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(array_agg(DISTINCT a.flow_id), '{}'::uuid[])
    FROM public.bsuid_flow_authorizations a
    JOIN public.bsuid_flow_settings s ON s.account_id = a.account_id AND s.flows_enabled
    JOIN public.flows f ON f.id = a.flow_id AND f.account_id = a.account_id AND f.status = 'active'
    JOIN public.contacts c ON c.id = p_contact_id AND c.account_id = a.account_id
   WHERE a.account_id = p_account_id
     AND a.enabled
     AND (a.expires_at IS NULL OR a.expires_at > now())
     AND (a.contact_id IS NULL OR a.contact_id = p_contact_id)
$$;

-- Per-send check for a Flow run. Every flow of the run (the root flow, the flow it is currently in, and every frame of the call stack)
-- must be authorized for this contact and for this modality. Returns 'ok' or a reason code.
CREATE OR REPLACE FUNCTION public.bsuid_flow_send_check(p_account_id uuid, p_run_id uuid, p_contact_id uuid, p_modality text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_run public.flow_runs%ROWTYPE;
  v_flows uuid[];
  v_flow uuid;
  v_auth public.bsuid_flow_authorizations%ROWTYPE;
BEGIN
  IF p_modality IS NULL OR p_modality NOT IN ('text', 'media', 'buttons', 'list', 'audio') THEN RETURN 'bad_modality'; END IF;
  SELECT * INTO v_run FROM public.flow_runs r
   WHERE r.id = p_run_id AND r.account_id = p_account_id AND r.contact_id = p_contact_id AND r.status = 'active';
  IF NOT FOUND THEN RETURN 'run_invalid'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bsuid_flow_settings s WHERE s.account_id = p_account_id AND s.flows_enabled) THEN RETURN 'flows_disabled'; END IF;
  v_flows := ARRAY[v_run.flow_id] || COALESCE(ARRAY[v_run.current_flow_id], '{}'::uuid[])
             || COALESCE((SELECT array_agg(fr.callee_flow_id) FROM public.flow_run_subflow_frames fr WHERE fr.flow_run_id = v_run.id), '{}'::uuid[]);
  FOR v_flow IN SELECT DISTINCT x FROM unnest(v_flows) x WHERE x IS NOT NULL LOOP
    SELECT * INTO v_auth FROM public.bsuid_flow_authorizations a
     WHERE a.account_id = p_account_id AND a.flow_id = v_flow AND a.enabled
       AND (a.expires_at IS NULL OR a.expires_at > now())
       AND (a.contact_id IS NULL OR a.contact_id = p_contact_id)
     ORDER BY (a.contact_id IS NOT NULL) DESC LIMIT 1;
    IF NOT FOUND THEN RETURN 'flow_not_authorized'; END IF;
    IF NOT (CASE p_modality WHEN 'text' THEN v_auth.allow_text WHEN 'media' THEN v_auth.allow_media WHEN 'buttons' THEN v_auth.allow_buttons
                            WHEN 'list' THEN v_auth.allow_list WHEN 'audio' THEN v_auth.allow_audio END) THEN
      RETURN 'modality_not_allowed';
    END IF;
  END LOOP;
  RETURN 'ok';
END $$;

REVOKE ALL ON FUNCTION public.bsuid_flow_scope(uuid, uuid), public.bsuid_flow_send_check(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bsuid_flow_scope(uuid, uuid), public.bsuid_flow_send_check(uuid, uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.bsuid_flow_authorization_integrity() FROM PUBLIC, anon, authenticated;
