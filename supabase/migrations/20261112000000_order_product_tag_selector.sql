-- Commercial product selector: reuse existing account tags without treating
-- operational labels as products. No existing tag is implicitly a product.
-- Feature is OFF for every account until curated and explicitly enabled.
ALTER TABLE public.tags
  ADD COLUMN IF NOT EXISTS is_order_product BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.order_integration_settings
  ADD COLUMN IF NOT EXISTS product_tags_required BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_tags_order_products_by_account
  ON public.tags (account_id, name)
  WHERE is_order_product = TRUE;

COMMENT ON COLUMN public.tags.is_order_product IS
  'Explicit admin-curated commercial product label; default false keeps operational labels out of order selectors.';
COMMENT ON COLUMN public.order_integration_settings.product_tags_required IS
  'When enabled for an account, WACRM manual confirmed orders require a valid product tag for each product. Defaults OFF.';

-- Activation is deliberately NOT included here.
-- First classify the commercial tags through Settings, verify the catalogue,
-- then enable precisely ONE audited account_id inside a controlled release:
-- UPDATE public.order_integration_settings SET product_tags_required=TRUE
-- WHERE account_id = :verified_account_id AND confirm_enabled=TRUE;
-- Rollback switch (does not undo orders or alter the historical snapshots):
-- UPDATE public.order_integration_settings SET product_tags_required=FALSE
-- WHERE account_id = :verified_account_id;
