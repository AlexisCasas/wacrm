-- ============================================================
-- 042_flow_delay_and_contact_field_nodes.sql
--
-- Adds two new `flow_nodes.node_type` values, needed for the temporary
-- ManyChat → WA CRM Flows migration (coexistence phase):
--
--   1. 'delay' — a short (1-30s), in-process auto-advance pause. NOT a
--      durable scheduler; see DelayNodeConfig in src/lib/flows/types.ts
--      for the runtime contract. No new columns — the seconds/
--      next_node_key config lives in the existing `config` JSONB, same
--      as every other node type.
--
--   2. 'set_contact_field' — sets one custom field on the contact
--      (`custom:<custom_field_id>` — mirrors Automations'
--      `update_contact_field` encoding) then auto-advances. Replicates
--      ManyChat "Set Custom User Field" actions (e.g. Combo XTD's
--      `Precio` / `Producto`).
--
-- Same drop-and-recreate pattern migrations 010 and 016 used to widen
-- this CHECK constraint — preserves every previously-valid node_type,
-- including 'send_media' (added in 016) and 'http_fetch' (present in
-- 010 but not yet used by the v1 engine).
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'delay',
    'set_contact_field',
    'handoff',
    'http_fetch',
    'end'
  ));
