-- ============================================================
-- 20261205000002_balance_templates_and_payment_instructions
--
-- P0 parity patch (feat/p0-parity-balance-voucher), unit 1 of 2. ADDITIVE and IDEMPOTENT: only new NULLABLE columns and their CHECK constraints. No DROP of data, no
-- historical migration edited, no existing value changed, no flag activated, no template created, nothing loaded.
--
-- WHY: 99% of real orders carry a pending balance and the customer is told about it (packaging notice and arrival notice). WACRM is the future financial source of
-- truth: the balance comes from PR-06 (pending_balance), never from another system. The templates therefore need TWO variants (with / without balance) and the
-- payment instructions have to be CONFIGURABLE per account (never hardcoded):
--
--   order_logistics_settings.packaging_balance_template_*   the packaging notice for an order WITH a pending balance (the existing packaging_template_* stays the
--                                                           variant for a fully paid order). Opt-in: with no balance variant configured nothing changes.
--   order_shipment_settings.arrival_balance_template_*      the arrival notice for an order WITH a pending balance (the existing arrival_message_template_* stays the
--                                                           variant for a fully paid order). Opt-in as well.
--   order_payment_settings.customer_payment_instructions    ONE short operational text (<= 200 chars, single line) that a template variable can carry. It is plain
--                                                           operational wording chosen by the account (no secrets are required or expected here).
--
-- Which variant is used, and with which balance, is decided by the application at send time from the PR-06 financial row (see payments/balance.ts); an order that
-- has no financial row (NOT TRACKED) never gets an invented balance: the send is refused / left to a person.
-- ============================================================

-- 1. Packaging notice with balance ------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE public.order_logistics_settings ADD COLUMN IF NOT EXISTS packaging_balance_template_name TEXT;
ALTER TABLE public.order_logistics_settings ADD COLUMN IF NOT EXISTS packaging_balance_template_language TEXT;
ALTER TABLE public.order_logistics_settings ADD COLUMN IF NOT EXISTS packaging_balance_template_params JSONB;
ALTER TABLE public.order_logistics_settings DROP CONSTRAINT IF EXISTS order_logistics_settings_balance_template_pair;
ALTER TABLE public.order_logistics_settings ADD CONSTRAINT order_logistics_settings_balance_template_pair CHECK ((packaging_balance_template_name IS NULL) = (packaging_balance_template_language IS NULL));
ALTER TABLE public.order_logistics_settings DROP CONSTRAINT IF EXISTS order_logistics_settings_balance_template_form;
ALTER TABLE public.order_logistics_settings ADD CONSTRAINT order_logistics_settings_balance_template_form CHECK (
  packaging_balance_template_name IS NULL
  OR (btrim(packaging_balance_template_name) <> '' AND char_length(packaging_balance_template_name) <= 512 AND btrim(packaging_balance_template_language) <> '' AND char_length(packaging_balance_template_language) <= 20)
);
ALTER TABLE public.order_logistics_settings DROP CONSTRAINT IF EXISTS order_logistics_settings_balance_params_form;
ALTER TABLE public.order_logistics_settings ADD CONSTRAINT order_logistics_settings_balance_params_form CHECK (
  packaging_balance_template_params IS NULL OR (jsonb_typeof(packaging_balance_template_params) = 'array' AND jsonb_array_length(packaging_balance_template_params) <= 20)
);

-- 2. Arrival notice with balance -------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE public.order_shipment_settings ADD COLUMN IF NOT EXISTS arrival_balance_template_name TEXT;
ALTER TABLE public.order_shipment_settings ADD COLUMN IF NOT EXISTS arrival_balance_template_language TEXT;
ALTER TABLE public.order_shipment_settings ADD COLUMN IF NOT EXISTS arrival_balance_template_params JSONB;
ALTER TABLE public.order_shipment_settings DROP CONSTRAINT IF EXISTS order_shipment_settings_arrival_balance_pair;
ALTER TABLE public.order_shipment_settings ADD CONSTRAINT order_shipment_settings_arrival_balance_pair CHECK ((arrival_balance_template_name IS NULL) = (arrival_balance_template_language IS NULL));
ALTER TABLE public.order_shipment_settings DROP CONSTRAINT IF EXISTS order_shipment_settings_arrival_balance_form;
ALTER TABLE public.order_shipment_settings ADD CONSTRAINT order_shipment_settings_arrival_balance_form CHECK (
  arrival_balance_template_name IS NULL
  OR (btrim(arrival_balance_template_name) <> '' AND char_length(arrival_balance_template_name) <= 512 AND btrim(arrival_balance_template_language) <> '' AND char_length(arrival_balance_template_language) <= 20)
);
ALTER TABLE public.order_shipment_settings DROP CONSTRAINT IF EXISTS order_shipment_settings_arrival_balance_params_form;
ALTER TABLE public.order_shipment_settings ADD CONSTRAINT order_shipment_settings_arrival_balance_params_form CHECK (
  arrival_balance_template_params IS NULL OR (jsonb_typeof(arrival_balance_template_params) = 'array' AND jsonb_array_length(arrival_balance_template_params) <= 20)
);

-- 3. Payment instructions (per account, one line, <= 200 chars) ------------------------------------------------------------------------------------------------
ALTER TABLE public.order_payment_settings ADD COLUMN IF NOT EXISTS customer_payment_instructions TEXT;
ALTER TABLE public.order_payment_settings DROP CONSTRAINT IF EXISTS order_payment_settings_instructions_form;
ALTER TABLE public.order_payment_settings ADD CONSTRAINT order_payment_settings_instructions_form CHECK (
  customer_payment_instructions IS NULL
  OR (btrim(customer_payment_instructions) <> '' AND char_length(customer_payment_instructions) <= 200 AND customer_payment_instructions !~ '[[:cntrl:]]')
);
