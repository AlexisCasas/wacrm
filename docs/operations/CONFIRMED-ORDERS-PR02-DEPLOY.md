# PR-02 · Pedidos confirmados (consulta) — preparación de deploy

Estado: **preparado en local, sin push / PR / deploy**. Todo se probó solo contra Supabase LOCAL (`127.0.0.1:55322`) y `http://localhost:3000`.
Producción, VPS, `globaltechup.com`, InkaClick y Meta productivos no fueron tocados.

## Qué es

Sección de **solo lectura** `/confirmed-orders` ("Pedidos confirmados") sobre `public.order_confirmations` + `public.order_confirmation_items`.
No crea fuente de datos nueva, no modifica `create_order_confirmation`, `ConfirmOrderDialog`, el envío a InkaClick, Flows, Automations, webhook, Ads, Sheets, crons ni Meta.
La sección de consulta **no requiere migration**; el handoff Comercial → Logística del Inbox añade la migration `20261127000000` (ver `CONVERSATION-HANDOFF-RLS.md`).

- `GET /api/orders/confirmed` — lista paginada (cursor), filtro `status`, búsqueda `q`, `limit` (1–50, por defecto 25).
- `GET /api/orders/confirmed/access` — le dice a la UI si debe mostrar el menú (la lista vuelve a comprobar todo).
- Página `/confirmed-orders`, entrada de sidebar y título de header (ES/EN, namespace `ConfirmedOrders`).

## Reglas de acceso (servidor; el navegador no decide nada)

1. Sesión válida (401 si no).
2. La cuenta sale de la sesión/perfil. `account_id`, `seller_user_id` u otros valores enviados por el navegador se ignoran.
3. `order_integration_settings.logistics_mvp_enabled = TRUE` en esa cuenta → si no, `403 feature_disabled` (el menú no aparece y la página muestra un aviso).
4. `profiles.operational_role` manda (el `account_role` por sí solo no da acceso; owner/admin que además es supervisor actúa como supervisor):

| operational_role | Acceso a /confirmed-orders |
|---|---|
| supervisor | sí: todos los pedidos confirmados de su cuenta |
| logistics | sí: todos los pedidos confirmados de su cuenta |
| commercial | **no** (entrega el pedido a Logística): 403 `operational_role_required`, sin menú |
| (ninguno) | no: 403 `operational_role_required`, sin menú |

Los pedidos se leen con el cliente del usuario, así que la RLS (`is_account_member(account_id, 'agent')`) se aplica además de los filtros explícitos.
Consecuencia: un miembro con rol técnico `viewer` y área logística/supervisor vería la lista vacía (la RLS de pedidos exige `agent`+). Documentado, no cambiado en PR-02.

## Datos expuestos

Listado/detalle: fecha-hora (Lima), cliente, productos (items reales o snapshot legacy), cantidad, total, vendedor, estado del pedido, estado de entrega, agencia, destino, departamento, `conversation_id` (para el botón "Abrir chat" → `/inbox?c=<id>`).
**Nunca** se seleccionan ni devuelven `dni`, `phone`, `order_description`, `request_key`, códigos de error ni `seller_user_id`.
Un pedido multiproducto es UNA cabecera con N items (los items se leen en una segunda consulta y se agrupan; sin join que duplique). Un pedido legacy muestra una sola línea con el total (el snapshot no guarda precio unitario).

## Paginación y rendimiento

Cursor keyset sobre `(confirmed_at DESC, id DESC)`; el cursor guarda el timestamp crudo (microsegundos) y el id → sin repetidos ni saltos aunque varios pedidos compartan `confirmed_at` (verificado con los 3 fixtures de igual timestamp y `limit=1`).
`EXPLAIN ANALYZE` local con 20.000 pedidos sintéticos en una sola cuenta (transacción con `ROLLBACK`): primera página ≈ 21 ms, página con cursor ≈ 14 ms, comercial (índice `order_confirmations_seller_user_idx`) ≈ 3 ms. **No hace falta índice nuevo ni migration.**
Si una cuenta superara ~100.000 pedidos, evaluar `CREATE INDEX CONCURRENTLY order_confirmations_account_confirmed_idx ON order_confirmations (account_id, confirmed_at DESC, id DESC)` (no incluido).

## Migrations pendientes (producción)

| Orden | Migration | Contenido | Necesaria para |
|---|---|---|---|
| 1 | `20261204000000_operational_role_supervisor_delegation.sql` | reemplaza la función `set_member_operational_role` | ajuste Supervisor |
| 2 | `20261204000001_conversation_handoff_rls.sql` | índice `(account_id, conversation_id)`, helper `conversation_operational_access`, `ALTER POLICY` en conversations/messages/message_reactions | handoff Comercial → Logística (RLS del Inbox) |

Prerrequisito ya existente: `20261121000000_order_logistics_foundation.sql` (flag `logistics_mvp_enabled`, `operational_role`). Confirmar en producción que esté aplicada antes de empezar.
Con el flag apagado la migration 2 no cambia el comportamiento de nadie. **Asignar las áreas operativas antes de activar el flag** (quien no tenga área pierde el Inbox operativo).

## Feature flag

`order_integration_settings.logistics_mvp_enabled` (por cuenta, `FALSE` por defecto). Activar solo la cuenta deseada, con autorización:

```sql
UPDATE public.order_integration_settings SET logistics_mvp_enabled = TRUE WHERE account_id = '<ACCOUNT_ID>';
```

(la fila de `order_integration_settings` debe existir; no usar `INSERT … ON CONFLICT` que toque `enabled` ni `confirm_enabled`).

## Orden exacto de deploy (esta noche; nada de esto se ha ejecutado)

0. **Preflight**: rama/commits correctos (ver abajo), tests y build en verde, `supabase/config.toml` NO incluido, `.env` de producción intacto, hay imagen anterior etiquetada para rollback.
1. Backup de la BD (y `pg_get_functiondef('public.set_member_operational_role(uuid, public.operational_role_enum)'::regprocedure)` guardado).
2. Aplicar `20261126000000` y después `20261127000000` (la segunda crea un índice —tabla pequeña, bloqueo breve— y reemplaza expresiones de políticas; no toca datos).
3. Verificar BD: `set_member_operational_role` y `conversation_operational_access` con `prosecdef = true`, owner `postgres`, `proconfig = {search_path=public}`; `anon` sin EXECUTE en la primera; `authenticated` con EXECUTE; `\d order_confirmations` muestra el índice nuevo; las 7 políticas de conversations/messages/message_reactions incluyen el helper.
4. Desplegar la imagen que contiene el ajuste Supervisor (commit 1).
5. Smoke test del ajuste Supervisor (ver `OPERATIONAL-ROLE-SUPERVISOR-DELEGATION.md`).
6. Activar/verificar roles operativos de la cuenta deseada (Ajustes → Miembros).
7. Desplegar la imagen con PR-02 + handoff (commit 2). Ya tiene su migration aplicada en el paso 2.
8. Smoke test PR-02 (abajo).
9. Solo si hace falta, activar `logistics_mvp_enabled` en la cuenta deseada.

## Smoke tests PR-02 (cuenta con el flag activo)

1. Sin sesión: `GET /api/orders/confirmed` → 401.
2. Cuenta con flag apagado: el menú no aparece; `GET /api/orders/confirmed` → 403 `feature_disabled`; `/confirmed-orders` muestra el aviso sin romperse.
3. Usuario sin área operativa (incluido un owner/admin sin área): sin menú; API → 403 `operational_role_required`.
4. Supervisor y Logística: ven todos los pedidos de la cuenta. Comercial: solo los suyos.
5. Pedido multiproducto: una fila, detalle con N productos, subtotales y total correctos.
6. Pedido con chat: "Abrir chat" abre `/inbox?c=<id>`. Pedido sin chat: se muestra normal, sin botón.
7. Filtros: estado de entrega y búsqueda por cliente/producto/vendedor; "Cargar más" no repite pedidos.
8. En la respuesta JSON no aparecen `dni` ni `phone`.
9. "Confirmar pedido" desde el Inbox sigue funcionando igual y el historial del panel lateral no cambió.

## Qué revisar en logs después del deploy

- `[orders] confirmed list failed:` / `[orders] confirmed items failed:` (código de error de Postgres).
- 500 en `/api/orders/confirmed*` (fallo de lookup de settings/perfil: la ruta cierra en falso).
- Picos de 403 `operational_role_required` (usuarios sin área que reciben el menú → no debería pasar) y 401 inesperados.
- Tiempo de respuesta de la lista (esperado < 100 ms por página).
- Que no aparezcan cambios en `order_confirmation_deliveries` / envíos a InkaClick provocados por esta pantalla (no debe haber ninguno: es de solo lectura).

## Rollback

| Qué | Cómo |
|---|---|
| Aplicación PR-02 + handoff | Recrear `app` con la imagen anterior (la que contiene solo el ajuste Supervisor). La app de la sección no escribe en la BD. |
| Handoff del Inbox (RLS) | SQL exacto en `CONVERSATION-HANDOFF-RLS.md` (restaura políticas, quita helper e índice; no borra datos). Rápido: `logistics_mvp_enabled = FALSE` en la cuenta. |
| Apagar la sección sin redeploy | `UPDATE order_integration_settings SET logistics_mvp_enabled = FALSE WHERE account_id = '<ACCOUNT_ID>'` (menú oculto, API 403). No borra datos ni altera pedidos. |
| Ajuste Supervisor | Restaurar la función original: SQL en `OPERATIONAL-ROLE-SUPERVISOR-DELEGATION.md` (sección Rollback). Hacer rollback también de la app si ya mostraba el selector de supervisor. |
