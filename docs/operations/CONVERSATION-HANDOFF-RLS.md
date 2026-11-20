# Handoff Comercial → Logística (RLS del Inbox)

Estado: **preparado y probado solo en LOCAL** (`127.0.0.1:55322`, Realtime local). Sin push / PR / deploy. Producción no fue tocada.
Migration: `supabase/migrations/20261204000001_conversation_handoff_rls.sql` (posterior a `20261126000000`). Flag: `order_integration_settings.logistics_mvp_enabled`.

## Flujo funcional

```
COMERCIAL atiende el chat → confirma pedido (create_order_confirmation) → termina su trabajo
LOGÍSTICA  recibe el pedido → abre EL MISMO chat (mismo conversation_id) → ve TODO el historial → sigue respondiendo
```

No se cierra la conversación, no se crea otra, no se copian mensajes y no se usa `conversations.status`.
La etapa se **deriva** de `order_confirmations`: la conversación es *logística* si existe un pedido con su `conversation_id` y `account_id`; si no, es *comercial*.
No hay columna ni tabla nueva de estado. El handoff empieza solo cuando el pedido quedó persistido (si Confirmar pedido falla no hay fila: Comercial conserva el chat). Si el cliente vuelve a escribir sigue siendo logística (el pedido sigue existiendo).

## Reglas (flag ON, por cuenta)

| operational_role | Conversación SIN pedido (comercial) | Conversación CON pedido (logística) |
|---|---|---|
| commercial | listar, abrir, leer, reaccionar, actualizar, enviar | **bloqueado** (no aparece, no se abre, no se leen mensajes, no se envía; 403 en `/api/whatsapp/send`) |
| logistics | **bloqueado** | listar, abrir, historial completo, reaccionar, actualizar, enviar |
| supervisor | sí | sí |
| (ninguno) — owner/admin incluidos | **bloqueado** | **bloqueado** |
| otra cuenta | nunca | nunca |

owner/admin **sin** área operativa no se saltan el flujo; owner/admin **con** área supervisor tienen acceso completo por `operational_role = supervisor`.
**Flag OFF (o sin fila de settings): comportamiento legacy exacto** (solo la membresía de siempre; verificado para commercial, logistics, sin área y owner).
`service_role` (webhook entrante, crons, flows, automations) salta la RLS y no cambia.

## Qué hace la migration

1. **Índice** `order_confirmations_account_conversation_idx (account_id, conversation_id) WHERE conversation_id IS NOT NULL`. Justificado con EXPLAIN local (5.000 conversaciones / 20.000 pedidos, comprobación por fila como hace la RLS): **13,8 s → 0,1 s** (sin índice recorre todos los pedidos de la cuenta por cada conversación).
2. **Helper** `public.conversation_operational_access(p_account_id uuid, p_conversation_id uuid) RETURNS boolean`: `STABLE`, `SECURITY DEFINER`, owner `postgres`, `search_path = public`, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO anon, authenticated` (anon solo para que una petición sin sesión devuelva 0 filas y no "permission denied"; siempre responde `false`). Toma el caller de `auth.uid()`, hace **una** consulta para flag + membresía + área, y solo consulta pedidos para commercial/logistics. No recibe ni confía en nada del navegador.
3. **`ALTER POLICY`** (solo expresiones, no se borran políticas): `conversations` SELECT/UPDATE/DELETE, `messages` SELECT/ALL, `message_reactions` SELECT/ALL. El término de membresía legacy se conserva y se le añade `AND conversation_operational_access(...)`. `conversations` INSERT no cambia.
   Los INSERT de mensajes entrantes (webhook) usan `service_role` y no pasan por la RLS.

Costo medido (local, 5.000 conversaciones, `SELECT count(*)` completo como usuario): legacy ≈ 225–300 ms; flag ON ≈ 420–435 ms (+≈30–40 µs por fila). Lectura de 100 mensajes de una conversación: ≈ 2 ms.

## Defensa en profundidad en la app

- `/api/whatsapp/send` y `/api/whatsapp/react` llaman antes a `conversation_operational_access` (cuenta de la sesión): si es `false` → **403** sin tocar Meta. `send` responde 403 también para commercial en post-confirmación; `react` responde 404 porque el mensaje ya es invisible por RLS (no revela existencia). Si la función aún no existe en la BD (migration pendiente) se comporta como antes; cualquier otro fallo del chequeo cierra en falso.
- Inbox: al confirmar un pedido con éxito, el diálogo ya dispara el evento existente `ORDERS_CHANGED_EVENT`; el hook `useHandoffConversationGuard` vuelve a consultar la conversación abierta y, si la BD ya no la devuelve, la quita de la lista y cierra el hilo sin F5. Realtime no avisa de filas que dejan de ser visibles, por eso hace falta este re-chequeo. No se creó otro mecanismo de eventos.
- Pedidos confirmados (`/confirmed-orders`): commercial → 403 y sin menú; logistics y supervisor → sí; sin área → 403.

## Realtime (probado, no asumido)

Con la pila local real (GoTrue → PostgREST → Realtime `postgres_changes`), `qa/orders/conversation-handoff-realtime.cjs` (usuarios sintéticos con contraseñas aleatorias; limpia al terminar; rechaza cualquier host que no sea `127.0.0.1:55321`):

- PRE: reciben eventos supervisor y commercial; logistics y sin-área no.
- POST (canales abiertos **antes** del handoff): reciben supervisor y logistics; commercial y sin-área no (Realtime reevalúa la RLS por evento).
- Flag OFF: todos los miembros reciben (legacy).
- Lectura por PostgREST: commercial 0/0 tras el pedido; logistics 1/N con todo el historial (cliente + comercial); escrituras bloqueadas con `42501` donde corresponde.

Limitación documentada: Supabase Realtime no emite un evento cuando una fila *deja de ser visible* para un suscriptor (p. ej. al aparecer el pedido). La lista de Comercial se limpia por el hook descrito (misma pestaña) o en el siguiente refetch/resync; en otra pestaña/dispositivo abierto del mismo comercial la conversación desaparece al próximo refresco, y sus peticiones ya son rechazadas por RLS.

## Pruebas

- `supabase/ci/conversation-handoff-test.sql` (transaccional, `ROLLBACK`, usuarios sintéticos): 31 comprobaciones — matriz commercial/logistics/supervisor/sin área/owner sin área/cross-account × (PRE, POST) × (listar, mensajes, reacciones, update, insert), handoff al persistir el pedido y vuelta atrás si no se persiste, cliente que vuelve a escribir, flag OFF legacy, anon y catálogo del helper.
- `qa/orders/conversation-handoff-realtime.cjs`: Realtime + PostgREST reales (ver arriba).
- Vitest: guard de `/api/whatsapp/send` (403, no Meta, cuenta de la sesión, función ausente, fallo cerrado), helper de la app, hook del Inbox, Pedidos confirmados.

## Orden de deploy (nada ejecutado)

Backup → migration `20261126000000` → migration `20261127000000` → verificar BD → imagen → smoke tests → activar `logistics_mvp_enabled` solo en la cuenta deseada.
La migration puede ir antes que la imagen: con el flag OFF no cambia nada para nadie; la imagen anterior sigue funcionando. Activar el flag ANTES de tener asignadas las áreas operativas deja sin Inbox a quien no tenga área (incluidos owner/admin): **asignar áreas primero** (Ajustes → Miembros), luego activar el flag.

## Smoke tests posteriores (cuenta con el flag activo y áreas asignadas)

1. Comercial: ve sus conversaciones sin pedido; confirma un pedido → la conversación desaparece sin F5; no puede abrirla por URL (`/inbox?c=<id>`) ni leer sus mensajes; `POST /api/whatsapp/send` con ese `conversation_id` → 403.
2. Logística: encuentra esa conversación, ve todo el historial anterior (incluidos mensajes y archivos del comercial), responde; un nuevo mensaje del cliente llega en tiempo real.
3. Logística no ve conversaciones sin pedido; Comercial no ve las confirmadas.
4. Supervisor ve ambas. Un usuario sin área (owner/admin incluidos) no ve el Inbox operativo.
5. Con el flag apagado en otra cuenta: el Inbox funciona exactamente como antes.
6. Confirmar pedido con error (p. ej. validación) → Comercial conserva el chat.
7. `/confirmed-orders`: commercial 403 y sin menú; logistics/supervisor sí.

## Qué revisar en logs tras el deploy

Errores `42501` / `permission denied` en `conversations`, `messages`, `message_reactions`; 403 en `/api/whatsapp/send` y `/api/whatsapp/react`; tiempos de la consulta de lista del Inbox (esperado < +50% sobre el histórico); mensajes entrantes del webhook (deben seguir persistiendo: usan `service_role`); latencia de Realtime; quejas de "no veo mi conversación" (señal de usuario sin `operational_role`).

## Rollback SQL (autorización únicamente; no borra pedidos, conversaciones ni mensajes)

```sql
BEGIN;

-- 1. Restaurar las políticas anteriores (expresiones exactas previas a 20261127000000)
ALTER POLICY conversations_select ON public.conversations
  USING (is_account_member(account_id));
ALTER POLICY conversations_update ON public.conversations
  USING (is_account_member(account_id, 'agent'::account_role_enum));
ALTER POLICY conversations_delete ON public.conversations
  USING (is_account_member(account_id, 'agent'::account_role_enum));

ALTER POLICY messages_select ON public.messages
  USING (EXISTS (SELECT 1 FROM conversations c
                 WHERE c.id = messages.conversation_id AND is_account_member(c.account_id)));
ALTER POLICY messages_modify ON public.messages
  USING (EXISTS (SELECT 1 FROM conversations c
                 WHERE c.id = messages.conversation_id AND is_account_member(c.account_id, 'agent'::account_role_enum)))
  WITH CHECK (EXISTS (SELECT 1 FROM conversations c
                      WHERE c.id = messages.conversation_id AND is_account_member(c.account_id, 'agent'::account_role_enum)));

ALTER POLICY message_reactions_select ON public.message_reactions
  USING (EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
                 WHERE m.id = message_reactions.message_id AND is_account_member(c.account_id)));
ALTER POLICY message_reactions_modify ON public.message_reactions
  USING (EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
                 WHERE m.id = message_reactions.message_id AND is_account_member(c.account_id, 'agent'::account_role_enum)))
  WITH CHECK (EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
                      WHERE m.id = message_reactions.message_id AND is_account_member(c.account_id, 'agent'::account_role_enum)));

-- 2. Quitar el helper (ya nadie lo referencia)
DROP FUNCTION IF EXISTS public.conversation_operational_access(UUID, UUID);

-- 3. El índice pertenece solo a esta migration: se puede quitar (opcional; es inofensivo si se queda)
DROP INDEX IF EXISTS public.order_confirmations_account_conversation_idx;

COMMIT;
```

Rollback rápido sin SQL: `UPDATE order_integration_settings SET logistics_mvp_enabled = FALSE WHERE account_id = '<ACCOUNT_ID>'` devuelve a esa cuenta al comportamiento legacy del Inbox al instante (también oculta Pedidos confirmados).
Si se hace rollback de la migration, hacer también rollback de la app (el guard de `/send` y `/react` trata la función ausente como legacy, así que no rompe).

## Riesgos / notas

- Si se activa el flag sin áreas asignadas, esos usuarios (owner/admin incluidos) pierden el Inbox operativo hasta que tengan área. Es la regla pedida; asignar áreas antes.
- Notificaciones (`notifications`) y otras tablas con `conversation_id` (deals, flow_runs, ai_usage_log…) no se tocaron: no son parte del Inbox operativo. Una notificación ya creada para el comercial puede mostrar el texto de un mensaje previo al handoff.
- El `INSERT` de `conversations` no cambia: un usuario de logística que iniciara una conversación nueva (sin pedido) no podría volver a verla (queda en etapa comercial).
- Rutas de servidor con `service_role` o API key (`/api/v1/*`, webhook, crons, flows, autoreply) no pasan por esta RLS por diseño.
- Costo extra por fila de la RLS en listados muy grandes (medido arriba). Para cuentas > ~20.000 conversaciones conviene volver a medir.
