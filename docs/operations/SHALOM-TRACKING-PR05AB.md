# PR-05A / PR-05B · Mensaje al cliente (día 15) y "En abandono" (día 20)

Estado: **implementado localmente** sobre PR-05. Sin push, sin deploy, sin mensajes reales de WhatsApp, sin llamadas a Shalom, sin credenciales de Meta.

## 1. Qué hace

Cuando un pedido está **En destino** (Shalom) y sigue sin Entregado:

| Día (calendario America/Lima, completos) | Qué ocurre |
|---|---|
| 0 | Entra a En destino → `pickup_state = waiting_pickup` (evento `pickup_waiting_started`). |
| **15** | La alerta interna de PR-05 **sigue igual** (una por episodio, solo Logística + Supervisor, no se duplica ni se recrea). Además: `pickup_state = alerted_15d` y, si el switch del mensaje está ON, se crea **una** fila en el ledger del mensaje (`destination_customer_message_due`) y el siguiente tick lo envía al cliente por WhatsApp. |
| **20** | `pickup_state = abandoned` (evento `pickup_abandoned`). Es una condición **operativa de WACRM**, no un estado de Shalom: `logistic_status` sigue siendo `at_destination` y el seguimiento continúa. Solo se **detecta, etiqueta, filtra y audita**: no hay reventa, ofertas, reasignación, descuentos, cancelación ni devolución automática. |
| Entregado (cualquier día) | `delivered` + `tracking_state=delivered`, el polling se detiene, las alertas abiertas se cierran, la condición pasa a `completed` (si estaba abandonado: evento `pickup_abandonment_cleared`, el historial `abandoned → delivered` queda auditado). Nada se borra. |
| Corrección válida de guía (sale de En destino) | La condición vuelve a `none`; el abandono previo queda como historia (`pickup_abandonment_cleared`). Si vuelve a En destino es un **nuevo episodio** con sus propios días 15 / 20. |

Regla de días: igual que la alerta de PR-05: `(ahora en Lima)::date >= (entrada a En destino en Lima)::date + N`. Día 14 y día 19 no; día 15 y día 20 sí; una sola vez por episodio.

## 2. Modelo

* **Condición de recojo** (sin tabla extra): columnas en `order_shipments` — `pickup_state` (`none|waiting_pickup|alerted_15d|abandoned|completed`), `pickup_state_at`, `pickup_alerted_at`, `pickup_abandoned_at` — más eventos en `order_shipment_events` (`pickup_waiting_started`, `pickup_abandoned`, `pickup_abandonment_cleared`, `pickup_completed`, `destination_customer_message_due|sent|failed|uncertain|skipped|retry_requested`), únicos por episodio. Constraints: waiting/alerted/abandoned ⇒ `logistic_status='at_destination'`; completed ⇒ `delivered`; abandoned ⇒ `pickup_abandoned_at`. El trigger `order_shipments_pickup_sync` mantiene la condición al entrar / salir de En destino.
* **Ledger del mensaje** (tabla nueva, justificada: el ledger de PR-04 `order_template_dispatches` exige evidencia de empaque y no sirve): `order_shipment_messages`, `UNIQUE(order_id, destination_episode, kind)`.
  Estados: `pending → claimed → sending → sent | failed | uncertain | skipped` (mismo patrón seguro que PR-04: claim con token + lease + `SKIP LOCKED`, guardas de transición, `sent`/`skipped` finales).
* **Evaluadores** (funciones de BD, solo `service_role`): `evaluate_pickup_day15`, `evaluate_pickup_abandonment`; ledger: `claim_shipment_messages`, `mark_shipment_message_sending`, `finish_shipment_message`, `retry_shipment_message`, `resolve_shipment_message`. No se reemplazó ninguna RPC validada de PR-05.

Migraciones nuevas (ninguna editada, PR-04 intacto): `20261201000000_shipment_pickup_state.sql`, `20261201000001_shipment_customer_message.sql`, `20261201000002_shipment_abandonment.sql`.

## 3. El mensaje al cliente (PR-05A)

* **Mismo sistema de WhatsApp**: `sendMessageToConversation` (origin `automated`) con el `conversation_id` del pedido → misma conversación, mismo número, mismo historial. No se crea chat, no se toca `send-message.ts`, `/api/whatsapp/send`, PR-04 ni el core de Meta.
* **Plantilla = configuración de la cuenta**, no código: `order_shipment_settings.customer_message_template_name / _language / _params`, resuelta contra las `message_templates` existentes (debe estar `APPROVED` y el número de variables debe coincidir). Texto **provisional** (concepto, NO congelado como plantilla Meta): "Hola {{cliente}}, tu pedido continúa pendiente de recojo en la agencia de destino. Si no es recogido dentro del plazo indicado, se procederá con la devolución del producto a la agencia de origen."
* **Exactamente una vez** por `order_id + destination_episode + tipo`: unique en BD; varios ticks / workers / reintentos técnicos no duplican.
* **Fallo ≠ incertidumbre**: antes de Meta (sin plantilla, sin conversación, rechazo) → `failed` con reintentos automáticos acotados (3, backoff 5/15/60 min; los errores de configuración esperan a una persona). Después de que Meta pudo aceptar (respuesta perdida, proceso muerto) → `uncertain`: **nunca** se reenvía solo; Logística / Supervisor confirman "sí se entregó / no se entregó". Si el pedido ya no está En destino al enviar → `skipped`.
* **Independiente**: un mensaje fallido / incierto **no** cambia el estado Shalom, **no** detiene el tracking, **no** impide la alerta interna y **no** bloquea el día 20. Atender / leer la alerta no deshace el mensaje.
* **Interruptores**: `shalom_destination_customer_message_enabled` → columna `order_shipment_settings.destination_customer_message_enabled` (**default FALSE**; sin él no se crea ledger ni se envía nada). Además el kill switch global `SHALOM_TRACKING_ENABLED` (sin él el cron no envía mensajes). **No está acoplado** a la detección de abandono: apagar el mensaje (o WhatsApp) no impide detectar el día 20.
* Configuración: `customerMessageDays` (15), `abandonDays` (20), `messageMaxAttempts` (3), `messageBackoffMinutes` ([5,15,60]) en `src/lib/orders/shalom/config.ts` (override QA con `SHALOM_CONFIG_JSON`).

## 4. UI (diseño actual, sin módulo nuevo)

* **Lista de Pedidos Confirmados**: junto a "En destino" aparece `· Alerta 15 días` (día 15–19) o `· En abandono · N días` (día 20+). Sin cambios para el resto.
* **Detalle → Tracking Shalom**: banner "En abandono · Desde <fecha/hora>" (con la nota de que Shalom sigue en "En destino") y bloque **Recojo en destino**: Estado Shalom · Días en destino · Estado de recojo · Alerta interna (Sin alerta / Abierta / Atendida / Resuelta) · Mensaje al cliente (día 15) (No aplica / Pendiente de envío / Enviando / Enviado / Falló / Incierto / Omitido). Falló → **Reintentar mensaje**; Incierto → **Sí se entregó / No se entregó**.
* **Filtro "En abandono (n)"** en el mismo selector de filtros (`GET /api/orders/shalom/abandoned`): solo aparece para Logística / Supervisor con ambos flags; estrecha la lista y sigue paginando hasta encontrar todos.
* Commercial / Viewer / sin área / otra cuenta: no ven nada (RLS + `order_shipments_access`).

## 5. Auditoría

`pickup_waiting_started`, `destination_customer_message_due|sent|failed|uncertain|skipped|retry_requested`, `pickup_abandoned`, `pickup_abandonment_cleared`, `pickup_completed` — nunca duplicados por tick (índices únicos por episodio).

## 6. Escenario QA nuevo (UAT) — no toca A..F

Preparado con `node scripts/qa/pr05/seed.cjs pickup-prepare` (idempotente): switch del mensaje ON en la cuenta QA A, plantilla **fake** `qa_pendiente_recojo` (solo QA), y pedidos nuevos `ready_for_dispatch`:

| Pedido | Guía (número / código) | Para qué |
|---|---|---|
| G · recojo | `40000011` / `QAG1` | día 14 → 15 → 19 → 20 → 21 → Entregado |
| H · mensaje falla | `40000012` / `QAH2` | mensaje día 15 **falla**, el tracking sigue; reintento manual |
| I · mensaje incierto | `40000013` / `QAI3` | mensaje **incierto**, nunca se reenvía solo; confirmación manual |
| S · humo | `40000019` / `QAS9` | ya recorrido por Claude (ignorar) |

Herramientas (todas LOCAL):

| Comando | Qué hace |
|---|---|
| `node scripts/qa/pr05/advance.cjs G 14 --absolute` | deja el pedido **exactamente** N días calendario En destino (sin `--absolute` desplaza lo ya acumulado) |
| `node scripts/qa/pr05/run-cron.cjs` | un tick: consulta al fake, evalúa día 15 / día 20 y envía el mensaje al simulador de Meta |
| `node scripts/qa/pr05/seed.cjs meta success\|failed\|uncertain` | qué responde el simulador de Meta |
| `node scripts/qa/pr05/seed.cjs message on\|off` | kill switch **del mensaje** (no del tracking ni del abandono) |
| `node scripts/qa/pr05/shalom-sim.cjs set destination 40000011` / `set delivered 40000011` | escenario del fake Shalom |
| `node scripts/qa/pr05/status.cjs` | foto: días en destino, recojo, abandono, ledger de mensajes, eventos |
| `powershell -File scripts\qa\pr05\start-app.ps1 [-KillSwitchOff]` | reinicia la app local |

Guía manual (usuario **qa-logistica** o **qa-supervisor**, `http://localhost:3000`, Pedidos Confirmados):

1. **G**: abrir "Envío QA G…", registrar `40000011` / `QAG1`. `shalom-sim set destination 40000011` + `run-cron --make-due` → En destino · Esperando recojo.
2. `advance G 14 --absolute` + `run-cron`: **sin** alerta, **sin** mensaje, sin abandono. `advance G 15 --absolute` + `run-cron`: **1 alerta**, chip "Alerta 15 días", Mensaje al cliente **Enviado** (el mensaje aparece en la conversación del pedido en el Inbox). Otro `run-cron`: nada nuevo.
3. `advance G 19 --absolute` + `run-cron`: **no** abandonado. `advance G 20 --absolute` + `run-cron`: **En abandono** (chip rojo, banner, filtro "En abandono"). `advance G 21 --absolute` + `run-cron`: sigue abandonado, sin evento duplicado, Shalom sigue "En destino".
4. `shalom-sim set delivered 40000011` + `run-cron --make-due`: Entregado, polling detenido, alerta cerrada, abandono cerrado, historial intacto (`pickup_abandoned` y `pickup_abandonment_cleared` en el historial).
5. **H**: registrar `40000012` / `QAH2`, `seed meta failed`, `shalom-sim set destination 40000012`, `run-cron --make-due`, `advance H 15 --absolute`, `run-cron`: mensaje **Falló**, la alerta interna existe, el tracking sigue activo. `seed meta success` + **Reintentar mensaje** + `run-cron`: **Enviado**, sin duplicado.
6. **I**: igual con `40000013` / `QAI3` y `seed meta uncertain`: **Incierto**, no hay botón de reintento ni reenvío automático; **Sí se entregó** lo cierra como Enviado.
7. Permisos: **qa-comercial**, **qa-viewer**, **qa-sinarea** y **qa-externo** no ven el bloque, ni los chips, ni el filtro. Probar también con `seed.cjs message off`: el abandono se sigue detectando, no sale mensaje nuevo.

## 7. Pendientes reales (antes de cualquier prueba / deploy real)

1. **Plantilla Meta real** del mensaje de recojo (texto aprobado por el negocio, categoría, idioma, variables), creada y aprobada en Meta; hoy solo existe la fake `qa_pendiente_recojo`. Registrar su nombre en `order_shipment_settings` de la cuenta real **cuando esté `APPROVED`**.
2. **Plazo en el texto**: el concepto menciona "el plazo indicado" sin cifra; el negocio debe definir el texto final (incluida la política de devolución a agencia de origen).
3. **Coexistencia con InkaClick**: InkaClick hoy envía `pedido_listo_en_agencia` al llegar a destino; definir qué sistema envía cada aviso para no duplicar al cliente (sigue siendo PRE-DEPLOY BLOCKER de PR-05).
4. Mantener `destination_customer_message_enabled = false` en producción hasta tener la plantilla real, el simulador reemplazado por Meta real y el visto bueno del negocio.
5. Qué se hace **después** de "En abandono" (reventa, devolución, cancelación…) es una decisión de negocio aparte, fuera de este alcance.
