-- Rolls back migration 076 (audio selection). QA database or explicit approval only. Leaves 073/074/075 and all their data intact.
-- SAFE BY DEFAULT: it refuses to run when anything would be lost (any purpose, any identifier, any classified audio, any request that records a
-- selection). The image-only rollback needs none of this: the schema is additive and the previous image ignores it.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.audio_guide_purposes) OR EXISTS (SELECT 1 FROM public.audio_guide_identifiers)
     OR EXISTS (SELECT 1 FROM public.audio_guide_items WHERE purpose_id IS NOT NULL OR identifier_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.audio_guide_requests WHERE selection_mode IS NOT NULL OR purpose_id IS NOT NULL OR identifier_id IS NOT NULL OR node_key IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback-076 refused: purposes, identifiers, classifications or selective requests exist and would be lost';
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.audio_guide_record_selected_skip(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.audio_guide_open_selected_request(UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER, UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.audio_guide_classify_item(UUID, UUID, INTEGER, UUID, UUID);
DROP FUNCTION IF EXISTS public.audio_guide_delete_identifier(UUID, UUID);
DROP FUNCTION IF EXISTS public.audio_guide_delete_purpose(UUID, UUID);
DROP FUNCTION IF EXISTS public.audio_guide_save_identifier(UUID, UUID, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.audio_guide_save_purpose(UUID, UUID, TEXT, TEXT, BOOLEAN);
ALTER TABLE public.audio_guide_requests DROP CONSTRAINT IF EXISTS audio_guide_requests_identifier_fkey;
ALTER TABLE public.audio_guide_requests DROP CONSTRAINT IF EXISTS audio_guide_requests_purpose_fkey;
ALTER TABLE public.audio_guide_requests DROP CONSTRAINT IF EXISTS audio_guide_requests_selection_text;
ALTER TABLE public.audio_guide_requests DROP CONSTRAINT IF EXISTS audio_guide_requests_selection_mode;
ALTER TABLE public.audio_guide_requests DROP COLUMN IF EXISTS node_key, DROP COLUMN IF EXISTS identifier_name, DROP COLUMN IF EXISTS purpose_name,
  DROP COLUMN IF EXISTS identifier_id, DROP COLUMN IF EXISTS purpose_id, DROP COLUMN IF EXISTS selection_mode;
DROP INDEX IF EXISTS public.audio_guide_items_classification_key;
ALTER TABLE public.audio_guide_items DROP CONSTRAINT IF EXISTS audio_guide_items_classified_both;
ALTER TABLE public.audio_guide_items DROP CONSTRAINT IF EXISTS audio_guide_items_identifier_fkey;
ALTER TABLE public.audio_guide_items DROP CONSTRAINT IF EXISTS audio_guide_items_purpose_fkey;
ALTER TABLE public.audio_guide_items DROP COLUMN IF EXISTS identifier_id, DROP COLUMN IF EXISTS purpose_id;
DROP TABLE IF EXISTS public.audio_guide_identifiers;
DROP TABLE IF EXISTS public.audio_guide_purposes;
COMMIT;
