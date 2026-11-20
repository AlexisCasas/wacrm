# PR-05C · Derivar a Comercial (manual) y retorno automático a Comercial (+10 min)

Estado: **implementado localmente** sobre PR-05. Sin push, sin deploy, sin tocar InkaClick, sin migraciones congeladas de PR-03 / PR-04 / PR-05 editadas.

## 1. Auditoría del botón manual (PR-03) — NO se reconstruyó

`Derivar a Comercial` ya existe y funciona (sidebar del chat → `POST /api/conversations/[id]/derive-to-commercial` → RPC `derive_conversation_to_commercial`). Se verificó con tests de BD reales (`finalized-return.qa.test.ts`) y con la suite SQL de PR-03 (92 comprobaciones, intactas):

* Quién lo ve: Logística y Supervisor, con `logistics_mvp_enabled` ON y mientras el chat está en etapa `logistics` (el servidor dice `can_derive`). Está disponible durante TODO el proceso (voucher, embalaje, tracking, abandono…): no depende del estado del pedido.
* Quién NO: Comercial, viewer (aunque tenga área), sin área y otra cuenta (42501, indistinguible de "no existe").
* Es **inmediato** (sin esperar 10 minutos), mismo `conversation_id`, mismo historial (los ids de mensajes no cambian), no toca pedido / Shalom / voucher / embalaje / pagos / recojo.
* **Idempotente** (doble clic u otro operador: `changed=false`, sin evento nuevo), con fila bloqueada. Auditoría: `conversation_routing_events` con `reason = derived_to_commercial`, actor humano, `logistics → shared`.
* Realtime: la fila de `conversation_routing` está publicada; Comercial recibe el chat sin F5 (PR-03).
* **Semántica a tener presente (decisión de PR-03, no cambiada):** la derivación manual deja la conversación en `shared` — Comercial entra al MISMO chat y **Logística conserva el acceso** porque sigue gestionando el pedido existente. No pasa a `commercial` puro. El retorno a `commercial` puro es el automático de este PR (o un cambio futuro explícito).

## 2. La señal "pedido completamente finalizado" (infraestructura solamente)

Tabla `order_finalizations` (una fila por `order_id`; **solo `service_role`**: el navegador no la lee ni la escribe; sin política ni grant). Funciones (solo `service_role`):

* `mark_order_finalized(account, order, source, actor, now)` — valida cuenta/pedido y `logistics_mvp_enabled`; **la primera declaración gana** (repetir no cambia nada). Guarda el **estado esperado** del routing (`routing_stage_at`, `routing_version_at`).
* `clear_order_finalized(account, order, reason, now)` — corrección permitida ANTES de que corra el retorno (`skipped_cleared`); declarar de nuevo reabre y reinicia el reloj. Tras aplicarse, ya no se puede limpiar.
* `return_finalized_conversations(now, grace=10, limit=100)` — el retorno durable.

**Nada la declara hoy**: ningún pedido actual está marcado y el producto no tiene ruta ni botón para hacerlo. La regla real (cuándo un pedido está "completamente finalizado", incluida la parte financiera) la conecta **PR-06** llamando a `mark_order_finalized`. En QA solo la simula `scripts/qa/pr05/finalize.cjs` (`source = qa_simulation`). No se inventó ninguna señal `paid / balance_zero / payment_complete`.

## 3. El retorno automático (durable)

`order_finalized_at = T` → elegible en `T + 10 min` (`>=`: exactamente +10 ya cuenta) → si la conversación **sigue en `logistics`** y su **versión de routing es la registrada al finalizar** → `logistics → commercial`, mismo `conversation_id`, mismo historial (no se copian, mueven ni ocultan mensajes; es solo cambio de ownership). Los mensajes nuevos del cliente entran a Comercial por el routing vigente de PR-03.

* **Sin setTimeout ni estado en memoria**: todo vive en BD. Si la app o el servidor reinicia, el retorno sigue pendiente y ocurre en el siguiente tick (probado con un cliente nuevo y reloj adelantado, y en vivo con la app reiniciada).
* **Scheduler**: `GET /api/conversations/routing/cron` (mismo patrón y secreto `x-cron-secret` que los otros crons; sin `pg_cron`). Independiente de Shalom (no usa `SHALOM_TRACKING_ENABLED` ni `shalom_tracking_enabled`; solo `logistics_mvp_enabled`). Preparado y **NO instalado**: `scripts/ops/routing-cron/` (cada minuto, `flock -n`). `ORDER_FINALIZED_GRACE_MINUTES` solo afina QA (por defecto 10; valores inválidos → 10).
* **Idempotencia**: bloqueo de la fila de la señal (`FOR UPDATE SKIP LOCKED`) + bloqueo de la fila de routing + `return_state` terminal + índice único del evento por pedido. Varios ticks posteriores y dos workers concurrentes: **una sola** transición y **un solo** evento. No hay notificaciones nuevas.
* **Protección frente a decisiones humanas** (NO-OP registrado en `return_state`, nunca se reintenta):
  * `skipped_not_logistics`: la conversación ya no está en `logistics` (Logística pulsó Derivar, Supervisor la cambió, etc.).
  * `skipped_routing_changed`: sigue en `logistics` pero la versión cambió (p. ej. se confirmó otro pedido después): cualquier acción posterior a `order_finalized_at` tiene prioridad.
  * `skipped_cleared`: el pedido dejó de estar finalizado por una corrección antes del vencimiento.
  * `skipped_no_conversation`: pedido sin conversación.
* **Auditoría**: `conversation_routing_events` con `reason = order_finalized_grace_elapsed`, `actor_user_id = NULL`, `actor_name = 'system'`, `order_id`, `from = logistics`, `to = commercial`, timestamp (constraint de forma + índice único). El manual conserva su actor humano y `derived_to_commercial`; así se distinguen. La señal guarda además fuente, quién la declaró y el resultado del retorno.

Migración nueva (la única): `20261204000017_order_finalization_routing_return.sql` (amplía el CHECK de `reason`, tabla + guardas + 3 funciones).

## 4. QA / UAT

Preparación: `node scripts/qa/pr05/seed.cjs routing-prepare` (pedidos nuevos R1..R5 confirmados por Comercial → conversación en **Logística**, con historial propio; `RS` ya lo recorrió Claude). Reiniciar la app con `start-app.ps1` si hace falta.

| Comando | Qué hace |
|---|---|
| `node scripts/qa/pr05/finalize.cjs mark R2 --minutes-ago 9` | declara "completamente finalizado" hace 9 min (elegible en 1 min) |
| `node scripts/qa/pr05/finalize.cjs tick` | un tick del cron de retorno |
| `node scripts/qa/pr05/finalize.cjs human-change R4 shared` | simula una decisión humana posterior (sube la versión) |
| `node scripts/qa/pr05/finalize.cjs clear R2` | corrección antes del vencimiento |
| `node scripts/qa/pr05/finalize.cjs status` | etapa, versión, señal, resultado y auditoría de R1..R5 |

Guía manual (usuarios `qa-logistica`, `qa-supervisor`, `qa-comercial`; `http://localhost:3000`):

* **A (manual, R1)**: entrar como qa-logistica → Inbox → "Ruteo QA R1" → botón **Derivar a Comercial** → confirmar (queda "Compartida con Comercial · Derivada por …"). Entrar como qa-comercial: la misma conversación aparece con el mismo historial.
* **B (automático, R2)**: `finalize.cjs mark R2 --minutes-ago 9` + `tick` → `returned:0`, sigue en Logística (qa-comercial NO la ve). Esperar ~1 minuto reales + `tick` → `returned:1`: qa-comercial la ve, qa-logistica ya no; mismo chat e historial; auditoría `order_finalized_grace_elapsed · system` en `status`. Más ticks no repiten nada.
* **C (manual antes de vencer, R3)**: `mark R3 --minutes-ago 5`, Derivar a Comercial desde la UI, esperar el +10, `tick` → sin segunda transición (`skipped_not_logistics`).
* **D (decisión humana, R4)**: `mark R4 --minutes-ago 5`, `human-change R4 shared`, esperar el +10, `tick` → no se pisa.
* **E (reinicio, R5)**: `mark R5 --minutes-ago 4`, reiniciar con `start-app.ps1`, esperar el +10, `tick` → vuelve igualmente.
* **F (cross-account / permisos)**: cubierto por tests (otras cuentas, Comercial, viewer: no ven la señal ni pueden derivar).

## 5. Lo que debe conectar PR-06 después

1. Llamar a `mark_order_finalized(account, order, 'pr06_…', actor)` en el momento exacto en que se cumpla la regla de **"completamente finalizado"** (parte logística + financiera), y a `clear_order_finalized` si una corrección permitida deshace esa condición antes de los 10 min.
2. Decidir el caso de **chats con varios pedidos**: hoy la señal es por pedido; PR-06 debe definir si basta un pedido finalizado o deben estarlo todos los del chat antes de volver a Comercial.
3. Decidir si la derivación manual debe pasar a `commercial` puro o seguir en `shared` (hoy `shared`, decisión de PR-03).
4. Instalar el cron (cada minuto) solo al desplegar, tras decidir la plantilla de cron del host.
