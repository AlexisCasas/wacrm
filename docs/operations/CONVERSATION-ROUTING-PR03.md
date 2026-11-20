# PR-03 · Routing operativo de conversaciones (Comercial / Logística / Compartida)

Estado: **preparado y probado solo en LOCAL** (`127.0.0.1:55322`, Realtime local). Sin push / PR / deploy. Producción no fue tocada.
Migration: `supabase/migrations/20261204000002_conversation_routing.sql` · Rollback exacto: `docs/operations/CONVERSATION-ROUTING-ROLLBACK.sql`.
Feature flag: `order_integration_settings.logistics_mvp_enabled` (por cuenta, `FALSE` por defecto).
Reemplaza **solo** la forma de derivar la etapa de PR-02 (antes "existe un pedido ⇒ logística"); las políticas RLS de PR-02 y todo lo demás se conservan.

> **Relación con PR-02.** PR-02 (`CONFIRMED-ORDERS-PR02-DEPLOY.md`, `CONVERSATION-HANDOFF-RLS.md`) queda congelado tal como se entregó; esos documentos NO se editan. Este documento es el único que describe PR-03. Al aplicarse la migration `20261128000000`, la sección "etapa = existe un pedido" de `CONVERSATION-HANDOFF-RLS.md` se reemplaza por `conversation_routing`; el rollback de PR-03 vuelve a esa regla. Los tests de PR-02 que insertaban pedidos directamente (`conversation-handoff-test.sql`, `conversation-handoff-realtime.cjs`) solo se adaptaron para llamar también `apply_order_confirmed_routing` (lo que hace `create_order_confirmation`); ninguna aserción de PR-02 cambió.

## Modelo (reglas del modelo, no fallbacks)

- `stage ∈ { commercial, logistics, shared }`. `commercial`: Comercial atiende. `logistics`: Logística atiende. `shared`: Comercial y Logística atienden **el mismo chat** (Logística sigue gestionando el pedido existente; Comercial atiende la nueva venta). Supervisor accede a las tres.
- **La ausencia de fila en `conversation_routing` significa `commercial`.** Una conversación solo tiene fila cuando sale de la etapa comercial. Una conversación nueva no necesita ninguna escritura.
- Se conserva siempre el mismo `conversation_id`, el mismo historial, los mismos mensajes y los pedidos. No se cierra, duplica ni copia nada, y no se crean mensajes (no hay `sender_type` nuevo).
- `conversation.status` y `delivery_status` no se usan ni se modifican. `operational_role` no cambia.

## Transiciones (únicos escritores; el navegador no puede escribir las tablas)

| Transición | Quién / cuándo | Motivo del evento |
|---|---|---|
| commercial → logistics | `create_order_confirmation`, en la **misma transacción** del pedido nuevo | `order_confirmed` (con `order_id`) |
| shared → logistics | igual, al confirmar el pedido 2 | `order_confirmed` |
| logistics → logistics | un pedido más sobre un chat ya logístico: no hay transición ni evento | — |
| logistics → shared | `derive_conversation_to_commercial` (Logística o Supervisor) | `derived_to_commercial` |
| (migration / activación del flag) con pedido → logistics | `backfill_conversation_routing`, solo cuentas con flag ON, una vez por conversación | `backfill` |
| logistics/shared → commercial | **reservado**, no implementado | `logistics_completed` |

## Matriz de acceso (flag ON)

| operational_role | commercial | logistics | shared |
|---|---|---|---|
| commercial | sí | no | sí |
| logistics | no | sí | sí |
| supervisor | sí | sí | sí |
| NULL (owner/admin sin área incluidos) | no | no | no |
| otra cuenta | nunca | nunca | nunca |

Flag OFF: comportamiento legacy exacto (el helper responde `TRUE` y deciden los términos de membresía de siempre). Se protegen `conversations` (SELECT/UPDATE/DELETE), `messages`, `message_reactions`, el envío (`/api/whatsapp/send` y `/react` consultan el mismo helper), la lectura y Realtime. `service_role` (webhook, crons, flows) no cambia. Owner/admin + supervisor = acceso completo por supervisor. `/confirmed-orders` sigue siendo solo para logistics y supervisor (que el chat esté `shared` no da acceso a Comercial).

## Qué crea la migration

1. `UNIQUE (id, account_id)` en `conversations` (necesario para la FK compuesta; no destructivo).
2. `conversation_routing` (`conversation_id` PK, `account_id`, `stage`, `updated_at`, `updated_by`, `version`) con **FK compuesta** `(conversation_id, account_id) → conversations(id, account_id)`.
3. `conversation_routing_events` (`id`, `account_id`, `conversation_id`, `from_stage`, `to_stage`, `reason`, `actor_user_id`, `actor_name`, `order_id`, `created_at`): **append-only** (trigger: UPDATE siempre rechazado; DELETE solo cuando se borra la conversación). Índices únicos: un evento `order_confirmed` por pedido y un `backfill` por conversación. Sin FK a `auth.users` a propósito (la auditoría sobrevive al usuario).
4. RLS: el navegador solo hace SELECT, con la misma política de la conversación. Ambas tablas, solo la de routing, en la publicación Realtime.
5. `conversation_operational_access` (misma firma y endurecimiento) leyendo `conversation_routing` por clave primaria en **una** consulta (flag + membresía + etapa).
6. `apply_order_confirmed_routing` (interna, solo `service_role`) y `create_order_confirmation` con **una sola sentencia nueva** (`PERFORM public.apply_order_confirmed_routing(...)`) justo después de crear el pedido, sus items y el paro de automatizaciones. Verificado con `diff`: es la única diferencia del cuerpo de la función; firma, owner, ACL (solo postgres y service_role) y `search_path` no cambian. **No hay trigger.**
7. `derive_conversation_to_commercial(p_conversation_id)`.
8. `backfill_conversation_routing(p_account DEFAULT NULL)` (solo `service_role`) y su ejecución en la migration: **solo cuentas con `logistics_mvp_enabled = true`**; conversaciones **con** pedido → `logistics` (`backfill`, un evento por conversación); **sin** pedido → sin fila (= commercial); cuentas con flag OFF → se omiten. Idempotente.
9. `DROP INDEX order_confirmations_account_conversation_idx` (de PR-02; ya nadie lo usa).

**Todo el routing es por flag.** Con `logistics_mvp_enabled = FALSE`: `create_order_confirmation` no escribe fila ni evento de routing (el cuerpo de la función no cambia; `apply_order_confirmed_routing` sale al principio), el acceso es el legacy, derivar se rechaza y el backfill omite la cuenta. Decisión técnica: así el modo OFF no puede introducir ningún efecto ni fallo nuevo en la confirmación de pedidos.

**Activar el flag en una cuenta que ya tiene pedidos confirmados:** ejecutar ANTES, con `service_role`, `SELECT public.backfill_conversation_routing('<account_id>');` (idempotente; mueve a `logistics` los chats con pedido, reason `backfill`) y recién después poner `logistics_mvp_enabled = TRUE`. Si se activa sin backfill, esos chats se tratan como `commercial` (ausencia de fila) hasta ejecutarlo. Pedidos confirmados mientras el flag estuvo OFF se incorporan al volver a ejecutar el backfill (no toca chats que ya tienen fila).

## Derivar a Comercial

- Botón en el sidebar del chat (junto a Confirmar pedido / Pedidos), visible solo si el servidor dice `can_derive` (flag ON, rol logistics o supervisor, etapa `logistics`). Diálogo: "¿Derivar esta conversación a Comercial? Úsalo cuando el cliente quiera realizar una nueva compra. Los pedidos logísticos existentes seguirán visibles para Logística." — Cancelar / Derivar.
- `POST /api/conversations/[id]/derive-to-commercial` es delgado (sesión, id, RPC, errores 403/409/500, sin cuerpo): la RPC toma el actor de `auth.uid()`, la cuenta del perfil, exige flag y rol, bloquea la fila (`FOR UPDATE`) y solo permite `logistics → shared`.
- **Idempotencia:** ya `shared` → devuelve `shared` sin evento nuevo (doble clic y llamadas concurrentes verificados). `commercial → shared` por esta RPC → rechazado (409 `invalid_transition`). Otra cuenta o conversación inexistente → 403 indistinguibles. Confirmar un pedido con el mismo `request_key` no repite la transición (índice único por pedido + la rama solo se ejecuta cuando el pedido es nuevo).
- La UI se refresca sin F5 (Realtime del routing + `refresh()` tras derivar) y muestra "Compartida con Comercial · Derivada a Comercial por {nombre} · {fecha Lima}" leyendo la auditoría; no se crean mensajes.

## Concurrencia (mecanismos reales de BD, probados con peticiones simultáneas)

- `apply_order_confirmed_routing` toma `SELECT … FOR UPDATE` sobre la fila de routing; si no existe, `INSERT … ON CONFLICT DO NOTHING` y, si otra transacción la creó primero, vuelve a la ruta con bloqueo. Dos confirmaciones concurrentes se serializan.
- Misma `request_key` en paralelo: `ON CONFLICT (account_id, request_key) DO NOTHING` de `create_order_confirmation` hace que solo una transacción cree el pedido y ejecute el routing; las demás devuelven el mismo `order_id` con `created = false` sin tocar nada. Red de seguridad: índice único parcial `(order_id) WHERE reason = 'order_confirmed'`.
- `derive_conversation_to_commercial` bloquea la misma fila (`FOR UPDATE`): doble clic y dos usuarios a la vez → un solo cambio (`changed = true`) y los demás reciben `shared / changed = false` sin evento.
- Confirmar vs derivar en paralelo: cualquier orden da una cadena de transiciones legal, sin eventos duplicados ni saltos.
- Verificado en `qa/orders/conversation-routing-realtime.cjs` (caso D): 4 confirmaciones simultáneas con la misma clave → 1 pedido y 1 transición; 4 derivaciones simultáneas (2 usuarios) → 1 cambio; 2 claves nuevas + 1 reintento sobre un chat `shared` → 1 transición `shared → logistics` y 3 pedidos; pedido que falla (price ausente) → ni routing, ni evento, ni pedido.

## Realtime (probado con la pila local real)

`qa/orders/conversation-routing-realtime.cjs` (usuarios sintéticos con contraseñas aleatorias; se limpia; rechaza cualquier host distinto de `127.0.0.1:55321`), con canales abiertos antes de cada transición:

- Etapa commercial: reciben mensajes supervisor y comercial; no logística ni sin-área.
- Etapa logistics: reciben supervisor y logística; no comercial.
- Etapa shared: reciben supervisor, comercial y logística; no sin-área. Además el **evento del routing** llega a Comercial (Realtime evalúa la política sobre la fila nueva), así que el chat aparece en su lista sin F5 (`useRoutingStageEvents` → `hydrateConversation`).
- Flag OFF: reciben todos los miembros (legacy).

Limitación real: Realtime no emite evento cuando una fila **deja de ser visible** (p. ej. Comercial al pasar a `logistics`). El comercial que confirma el pedido ve desaparecer el chat de inmediato (hook `useHandoffConversationGuard`, evento existente de pedido confirmado). Otra pestaña/otro comercial abierto sobre ese chat lo pierde al próximo refresco; sus peticiones ya son rechazadas por RLS.

## EXPLAIN / rendimiento (local, 5.000 conversaciones, 20.000 pedidos, `SELECT count(*)` completo como usuario)

| | commercial | logistics | 100 mensajes (supervisor) |
|---|---|---|---|
| PR-03 (routing, PK) | ≈ 370 ms | ≈ 397 ms | ≈ 2,5 ms |
| PR-02 (EXISTS pedidos) | ≈ 400 ms | ≈ 521 ms | ≈ 2,5 ms |
| flag OFF (legacy) | ≈ 350 ms | | |

El lookup usa la PK de `conversation_routing`: **no se añadió ningún índice extra** (solo el `UNIQUE (id, account_id)` que exige la FK compuesta, y los índices únicos propios de eventos). Se eliminó el índice de PR-02, ya innecesario.

## Pruebas

- `supabase/ci/conversation-routing-test.sql` (transaccional, `ROLLBACK`): 92 comprobaciones (incluye backfill solo-flag-ON, owner+supervisor, viewer, flag OFF sin escrituras y backfill al activar) — matriz por etapa y rol, transiciones con la función real, reintento del mismo `request_key`, pedido fallido sin cambio de routing, derivar (permisos, idempotencia, rechazos), auditoría, escrituras de navegador bloqueadas, inmutabilidad, flag OFF, cascada, catálogo.
- `supabase/ci/conversation-handoff-test.sql` (PR-02) adaptado al modelo de routing; sigue pasando.
- `qa/orders/conversation-routing-realtime.cjs`: casos A, B y C de extremo a extremo (PostgREST + Realtime reales).
- Vitest: migration (estático), API derivar y routing, lib, componente `DeriveToCommercial` y tests de PR-02 actualizados.

## Orden de deploy (nada ejecutado)

1. Backup de BD. 2. Migrations en orden: `20261126…`, `20261127…`, `20261128…` (la última hace el backfill y reemplaza `create_order_confirmation`; transaccional). 3. Verificar BD (abajo). 4. Imagen de PR-03. 5. Smoke tests. 6. Activar `logistics_mvp_enabled` solo en la cuenta deseada, **con las áreas operativas ya asignadas**.
Compatibilidad: migration antes que la app y flag OFF → nadie nota nada; la app anterior sigue funcionando (no conoce el routing; `create_order_confirmation` solo añade escrituras internas). Con el flag ON y la app anterior, el acceso lo decide la BD (correcto), pero no habría botón "Derivar". App nueva con BD anterior: las rutas nuevas fallan cerrado y el botón no aparece.

Verificación de BD tras la migration: tablas y políticas creadas; `SELECT stage, count(*) FROM conversation_routing GROUP BY 1` (= nº de conversaciones con pedido, todas `logistics`); `SELECT count(*) FROM conversation_routing_events WHERE reason='backfill'` igual; `\d conversation_routing`; `has_function_privilege('authenticated','public.apply_order_confirmed_routing(uuid,uuid,uuid,text,uuid)','EXECUTE')` = false; `create_order_confirmation` sigue sin EXECUTE para `anon`/`authenticated`.

## Smoke tests posteriores (cuenta con flag y áreas)

A. Comercial ve un chat comercial, confirma el pedido → el chat desaparece de su Inbox sin F5, Logística lo ve aparecer (mismo chat, todo el historial), Supervisor lo ve.
B. Logística pulsa "Derivar a Comercial" → confirma → estado compartido; Comercial y Logística ven el mismo chat; el segundo clic no duplica; el texto "Derivada a Comercial por … · fecha" aparece.
C. Comercial confirma el segundo pedido → vuelve a logística, Comercial lo pierde, Logística y Supervisor siguen; ambos pedidos están en Pedidos confirmados.
D. Un usuario sin área no ve el Inbox operativo; con el flag apagado en otra cuenta todo funciona como antes.
E. `SELECT * FROM conversation_routing_events ORDER BY created_at DESC LIMIT 10` muestra actor, motivo y pedido.

## Qué revisar en logs

Errores `42501` y `22023 invalid_transition` en `/api/conversations/*/derive-to-commercial`; errores de `create_order_confirmation` (la ruta de confirmar pedido debe seguir igual de estable: cualquier fallo del routing aborta el pedido por diseño); tiempos de la lista del Inbox; 404 en `/api/conversations/*/routing`; quejas de "no veo mi chat" (usuario sin `operational_role`); mensajes del webhook (siguen con `service_role`).

## Rollback

`docs/operations/CONVERSATION-ROUTING-ROLLBACK.sql` (probado en una transacción local con `ROLLBACK`): restaura el índice y el helper de PR-02, el cuerpo anterior de `create_order_confirmation`, elimina las dos RPC, las tablas (también salen de la publicación Realtime) y el índice `UNIQUE (id, account_id)`. No toca pedidos, conversaciones ni mensajes. **Borra la auditoría de routing**: exportar antes si se necesita. Atajo: `logistics_mvp_enabled = FALSE` en la cuenta.

## Riesgos / notas

- `create_order_confirmation` ahora puede abortar el pedido si falla el routing (por diseño: atómico). La escritura es mínima (UPSERT + INSERT) y está probada, pero es la función más sensible del flujo de pedidos: smoke test obligatorio.
- Una conversación `shared` con dos equipos hablando puede producir respuestas cruzadas (de proceso, no técnico).
- Realtime no avisa cuando una fila deja de ser visible (ver arriba).
- El ciclo de vida de `logistics → commercial` **no existe todavía**: hoy un chat solo sale de `logistics` pasando por `shared` y volviendo con otro pedido.
- El routing y el backfill existen solo para cuentas con flag ON: activar el flag exige ejecutar antes `backfill_conversation_routing(<cuenta>)` (ver arriba).
- Un usuario `viewer` con área logística NO puede derivar (los viewers son de solo lectura en todo el sistema, misma regla que `create_order_confirmation`).
- Eventos de auditoría se borran con su conversación (cascada); los pedidos se conservan (`conversation_id` pasa a NULL como siempre).

## Decisión pendiente del cliente para automatizar "Entregado → Comercial"

Definir la **fuente de verdad de "gestión logística terminada"**: qué estado/evento la marca (nuevo estado logístico manual, señal de InkaClick o ambos), qué cuenta como terminado (Entregado / Cancelado / Devuelto), si deben estar terminados **todos** los pedidos del chat, y si el regreso a `commercial` ocurre al escribir el cliente también desde `shared`. El motivo `logistics_completed` queda reservado en el modelo, sin automatización.
