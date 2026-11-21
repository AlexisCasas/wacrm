-- ============================================================
-- 20261205000004_balance_trusted_since
--
-- Payment parity protection, unit 1 (feat/p0-parity-balance-voucher). ADDITIVE, IDEMPOTENT, FAIL-CLOSED: one nullable column. No historical order is touched, nothing is backfilled,
-- no flag is activated, nothing is sent.
--
-- WHY (audit of the coexistence with InkaClick): orders replicated to InkaClick are operated financially THERE (initial payment, price corrections) while WACRM keeps the full balance.
-- Strategy D: historical and in-flight orders end financially in InkaClick; new orders after the cutover use WACRM as the source of truth of payments and balance.
--
--   order_payment_settings.balance_trusted_since   the official moment from which the WACRM balance can be shown to a customer. NULL (default) = OFF = NO message that carries
--                                                 pending_balance is allowed for ANY order. An order confirmed BEFORE it never gets one (balance_not_trusted). The application enforces
--                                                 it for EVERY communication in ONE place (payments/balance.ts resolveOrderBalance). Internal reads and payment registration are untouched.
-- ============================================================

-- 1. balance_trusted_since (NULL = OFF) ----------------------------------------------------------------------------------------------------------------
ALTER TABLE public.order_payment_settings ADD COLUMN IF NOT EXISTS balance_trusted_since TIMESTAMPTZ;
COMMENT ON COLUMN public.order_payment_settings.balance_trusted_since IS
  'Official trust cutoff of the WACRM balance. NULL = OFF: no customer message may carry pending_balance. An order confirmed BEFORE this moment never does (balance_not_trusted).';
