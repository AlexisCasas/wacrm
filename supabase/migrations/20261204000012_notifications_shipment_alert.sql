-- ============================================================
-- 20261130000003_notifications_shipment_alert
--
-- PR-05 · the EXISTING notifications table (migration 027) is reused as the CHANNEL of the internal Shalom alert (no second notification centre).
-- Minimal and additive:
--   * the type CHECK (which only allowed 'conversation_assigned') also allows 'shipment_destination_alert'; conversation_assigned is untouched;
--   * a nullable order_id so the notification can open the order / tracking (existing rows and the assignment trigger keep working: it does not set it);
--   * a shape check: a shipment alert always carries its order.
-- RLS is unchanged (recipients read their own rows and can only set read_at). A notification being READ is NOT the alert being ATTENDED: that lifecycle
-- lives in order_shipment_alerts.
-- ============================================================

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type IN ('conversation_assigned', 'shipment_destination_alert'));

ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES public.order_confirmations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_notifications_order ON public.notifications (order_id) WHERE order_id IS NOT NULL;

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_shipment_alert_order;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_shipment_alert_order CHECK (type <> 'shipment_destination_alert' OR order_id IS NOT NULL);
