-- ============================================================
-- 073_audio_guide_catalog
--
-- "Audios por producto", stage 1: the storage and the catalog structures.
-- Purely additive. It changes no existing table, flow, run or policy, and it
-- is inert until code writes to it:
--
--   1. `voice-notes` bucket   verified WhatsApp voice notes (OGG/Opus, mono).
--                             Public by URL (Meta fetches it) but NO policy at all: only
--                             the server (service role) can list, add, replace or delete
--                             objects, and it names each one after its own SHA-256.
--   2. audio_guide_products   product (normalized key + visible name) per account.
--   3. audio_guide_items      ordered voice notes of a product; the file is
--                             pinned by hash and cannot be edited afterwards.
--   4. audio_guide_requests   one row per inbound message that asked for the
--                             guide: the duplicate guard.
--   5. audio_guide_sends      one row per audio of a request: id and state of
--                             each WhatsApp send, with a one-way state machine.
--
-- Tenancy: every row carries account_id, children reference parents through a
-- composite (id, account_id) key, and the stored file path embeds the account
-- id, so a row can never point at another account's parent or file. Users get
-- SELECT only; writes go through the server (service role) after it has
-- verified the audio.
-- ============================================================

-- ---------------------------------------------------------------
-- 1. Bucket
-- ---------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('voice-notes', 'voice-notes', TRUE, 16777216, ARRAY['audio/ogg'])
    ON CONFLICT (id) DO UPDATE
      SET public = EXCLUDED.public,
          file_size_limit = EXCLUDED.file_size_limit,
          allowed_mime_types = EXCLUDED.allowed_mime_types;
  END IF;
  -- Deliberately NO storage.objects policy for this bucket, not even SELECT:
  --   * the bucket is public, so Storage serves /object/public/voice-notes/<path> to anyone with the URL (Meta needs that);
  --   * with no SELECT policy nobody but the service role can LIST the bucket, so the hash-named URLs of every account
  --     cannot be enumerated (a "public read" policy would let any caller list all of them);
  --   * with no INSERT/UPDATE/DELETE policy nobody but the service role can write, replace or delete an object.
END $$;

-- ---------------------------------------------------------------
-- 2. Products
-- ---------------------------------------------------------------
CREATE TABLE public.audio_guide_products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Normalized by the application (lower case, no accents, single spaces); the
  -- database refuses any other form so a lookup by key is exact.
  product_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT audio_guide_products_key_form CHECK (
    product_key = lower(btrim(product_key))
    AND product_key ~ '^[^[:space:]]+( [^[:space:]]+)*$'
    AND char_length(product_key) <= 120
  ),
  CONSTRAINT audio_guide_products_name_form CHECK (
    btrim(display_name) <> '' AND display_name = btrim(display_name) AND char_length(display_name) <= 120
  ),
  CONSTRAINT audio_guide_products_account_key UNIQUE (account_id, product_key),
  CONSTRAINT audio_guide_products_id_account_key UNIQUE (id, account_id)
);

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.audio_guide_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------
-- 3. Items: the ordered voice notes of a product
-- ---------------------------------------------------------------
CREATE TABLE public.audio_guide_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL,
  product_id UUID NOT NULL,
  -- Playing order. A product holds at most 6: each audio waits 5 s before it
  -- goes out and the webhook that runs the sequence has a 60 s budget.
  position SMALLINT NOT NULL,
  -- Content address of the verified file, and where it lives. The path must be
  -- exactly the account folder + the hash, which ties the file to the account
  -- and to its bytes in one constraint.
  voice_sha256 TEXT NOT NULL,
  voice_path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  channels SMALLINT NOT NULL DEFAULT 1,
  -- Seconds to wait BEFORE this audio, the first one included. 5 by contract.
  pre_delay_seconds SMALLINT NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT audio_guide_items_product_fkey FOREIGN KEY (product_id, account_id)
    REFERENCES public.audio_guide_products (id, account_id) ON DELETE CASCADE,
  CONSTRAINT audio_guide_items_position_range CHECK (position BETWEEN 1 AND 6),
  CONSTRAINT audio_guide_items_sha256_form CHECK (voice_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audio_guide_items_path_matches CHECK (
    voice_path = 'account-' || account_id::text || '/' || voice_sha256 || '.ogg'
  ),
  CONSTRAINT audio_guide_items_bytes_range CHECK (bytes BETWEEN 1 AND 16777216),
  CONSTRAINT audio_guide_items_duration_positive CHECK (duration_ms > 0),
  CONSTRAINT audio_guide_items_mono CHECK (channels = 1),
  CONSTRAINT audio_guide_items_pre_delay CHECK (pre_delay_seconds BETWEEN 5 AND 30),
  CONSTRAINT audio_guide_items_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT audio_guide_items_product_position_key UNIQUE (product_id, position),
  CONSTRAINT audio_guide_items_id_account_key UNIQUE (id, account_id)
);

CREATE INDEX idx_audio_guide_items_account ON public.audio_guide_items (account_id);

-- Once an item exists its file cannot change. To replace a recording, delete
-- the item and create a new one: history keeps a snapshot of what was sent.
CREATE FUNCTION public.audio_guide_items_immutable_file()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.voice_sha256 IS DISTINCT FROM OLD.voice_sha256
     OR NEW.voice_path IS DISTINCT FROM OLD.voice_path
     OR NEW.bytes IS DISTINCT FROM OLD.bytes
     OR NEW.duration_ms IS DISTINCT FROM OLD.duration_ms
     OR NEW.channels IS DISTINCT FROM OLD.channels THEN
    RAISE EXCEPTION 'audio_guide_items: the audio file of an item cannot be changed; create a new item'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER audio_guide_items_immutable_file
  BEFORE UPDATE ON public.audio_guide_items
  FOR EACH ROW EXECUTE FUNCTION public.audio_guide_items_immutable_file();

-- The referenced object must already be in the voice-notes bucket, i.e. it went
-- through the server-side verification (only the service role can put it there).
CREATE FUNCTION public.audio_guide_items_require_object()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM storage.objects o
       WHERE o.bucket_id = 'voice-notes' AND o.name = NEW.voice_path
    ) THEN
      RAISE EXCEPTION 'audio_guide_items: % is not a stored voice note', NEW.voice_path
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.audio_guide_items_require_object() FROM PUBLIC;

CREATE TRIGGER audio_guide_items_require_object
  BEFORE INSERT ON public.audio_guide_items
  FOR EACH ROW EXECUTE FUNCTION public.audio_guide_items_require_object();

-- ---------------------------------------------------------------
-- 4. Requests: one per inbound message (duplicate guard)
-- ---------------------------------------------------------------
CREATE TABLE public.audio_guide_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  -- The inbound message that asked for the guide: a Meta wamid or the
  -- `manychat:...` bridge id. Whoever inserts first owns the request.
  trigger_message_id TEXT NOT NULL,
  product_id UUID,
  product_key TEXT,
  status TEXT NOT NULL DEFAULT 'claimed',
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT audio_guide_requests_product_fkey FOREIGN KEY (product_id, account_id)
    REFERENCES public.audio_guide_products (id, account_id) ON DELETE SET NULL (product_id),
  CONSTRAINT audio_guide_requests_message_nonblank CHECK (btrim(trigger_message_id) <> ''),
  CONSTRAINT audio_guide_requests_status CHECK (
    status IN ('claimed', 'sending', 'completed', 'partial', 'failed', 'skipped')
  ),
  CONSTRAINT audio_guide_requests_reason_length CHECK (reason IS NULL OR char_length(reason) <= 200),
  -- THE duplicate guard: the same inbound message can never open a second request.
  CONSTRAINT audio_guide_requests_message_key UNIQUE (account_id, trigger_message_id),
  CONSTRAINT audio_guide_requests_id_account_key UNIQUE (id, account_id)
);

CREATE INDEX idx_audio_guide_requests_account_created
  ON public.audio_guide_requests (account_id, created_at DESC);

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.audio_guide_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------
-- 5. Sends: the individual WhatsApp messages
-- ---------------------------------------------------------------
CREATE TABLE public.audio_guide_sends (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL,
  request_id UUID NOT NULL,
  item_id UUID,
  position SMALLINT NOT NULL,
  -- Snapshot of what was sent, so history survives an item being deleted.
  voice_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  whatsapp_message_id TEXT,
  error_code TEXT,
  error_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  CONSTRAINT audio_guide_sends_request_fkey FOREIGN KEY (request_id, account_id)
    REFERENCES public.audio_guide_requests (id, account_id) ON DELETE CASCADE,
  CONSTRAINT audio_guide_sends_item_fkey FOREIGN KEY (item_id, account_id)
    REFERENCES public.audio_guide_items (id, account_id) ON DELETE SET NULL (item_id),
  CONSTRAINT audio_guide_sends_position_range CHECK (position BETWEEN 1 AND 6),
  CONSTRAINT audio_guide_sends_sha256_form CHECK (voice_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audio_guide_sends_status CHECK (
    status IN ('pending', 'sending', 'sent', 'failed', 'uncertain', 'skipped')
  ),
  CONSTRAINT audio_guide_sends_sent_has_id CHECK (status <> 'sent' OR whatsapp_message_id IS NOT NULL),
  CONSTRAINT audio_guide_sends_error_length CHECK (
    (error_code IS NULL OR char_length(error_code) <= 80)
    AND (error_detail IS NULL OR char_length(error_detail) <= 500)
  ),
  -- Each audio of a request exists once: a retry cannot add a second row.
  CONSTRAINT audio_guide_sends_request_position_key UNIQUE (request_id, position)
);

CREATE INDEX idx_audio_guide_sends_account_created
  ON public.audio_guide_sends (account_id, created_at DESC);
-- Rows stuck in 'sending' (the process died mid-send) are found by this.
CREATE INDEX idx_audio_guide_sends_in_flight
  ON public.audio_guide_sends (started_at) WHERE status = 'sending';

-- One-way state machine. A send is claimed (pending -> sending) BEFORE Meta is
-- called, and nothing leaves a terminal state, so "send at most once" holds even
-- if two workers race or a process dies between the call and its bookkeeping.
CREATE FUNCTION public.audio_guide_sends_state_machine()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.position IS DISTINCT FROM OLD.position
     OR NEW.voice_sha256 IS DISTINCT FROM OLD.voice_sha256 THEN
    RAISE EXCEPTION 'audio_guide_sends: identity columns are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('sending', 'skipped'))
    OR (OLD.status = 'sending' AND NEW.status IN ('sent', 'failed', 'uncertain'))
  ) THEN
    RAISE EXCEPTION 'audio_guide_sends: illegal transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status AND OLD.status IN ('sent', 'failed', 'uncertain', 'skipped')
     AND (NEW.whatsapp_message_id IS DISTINCT FROM OLD.whatsapp_message_id) THEN
    RAISE EXCEPTION 'audio_guide_sends: a finished send cannot change its message id' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audio_guide_sends_state_machine
  BEFORE UPDATE ON public.audio_guide_sends
  FOR EACH ROW EXECUTE FUNCTION public.audio_guide_sends_state_machine();

-- ---------------------------------------------------------------
-- RLS and grants: members read their own account; the server writes.
-- ---------------------------------------------------------------
ALTER TABLE public.audio_guide_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audio_guide_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audio_guide_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audio_guide_sends    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.audio_guide_products FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.audio_guide_items    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.audio_guide_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.audio_guide_sends    FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.audio_guide_products TO authenticated;
GRANT SELECT ON TABLE public.audio_guide_items    TO authenticated;
GRANT SELECT ON TABLE public.audio_guide_requests TO authenticated;
GRANT SELECT ON TABLE public.audio_guide_sends    TO authenticated;
GRANT ALL ON TABLE public.audio_guide_products TO service_role;
GRANT ALL ON TABLE public.audio_guide_items    TO service_role;
GRANT ALL ON TABLE public.audio_guide_requests TO service_role;
GRANT ALL ON TABLE public.audio_guide_sends    TO service_role;

CREATE POLICY audio_guide_products_select ON public.audio_guide_products
  FOR SELECT USING (public.is_account_member(account_id));
CREATE POLICY audio_guide_items_select ON public.audio_guide_items
  FOR SELECT USING (public.is_account_member(account_id));
CREATE POLICY audio_guide_requests_select ON public.audio_guide_requests
  FOR SELECT USING (public.is_account_member(account_id));
CREATE POLICY audio_guide_sends_select ON public.audio_guide_sends
  FOR SELECT USING (public.is_account_member(account_id));
