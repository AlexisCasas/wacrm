# Aviso inmediato al cliente al llegar a destino (kind `destination_arrival_customer`)

Estado: **implementado solo en local** (rama `feat/meta-destination-arrival-message`). Sin deploy, sin plantillas creadas en Meta, sin ningún WhatsApp real, sin Shalom activado, sin cron nuevo. Con el flag apagado queda totalmente inerte.

## 1. Qué hace

Cuando un envío pasa **por primera vez** a *En destino* (`at_destination`) dentro de un episodio, WACRM deja un registro **pendiente** en el ledger de mensajes al cliente (`order_shipment_messages`, el mismo del mensaje del día 15) con `kind = destination_arrival_customer`. El envío lo hace el sender que ya existe (`sendMessageToConversation`, en el siguiente tick del cron de Shalom): **misma conversación del pedido, mismo número de WhatsApp configurado en la cuenta, mismo historial en el Inbox**, sin crear chats paralelos y sin depender de que haya un usuario conectado.

No se creó un segundo sistema de envío: ledger, claim/lease, reintentos, `uncertain`, `skipped`, retry/resolve por personas, webhook de estados y RLS son los de PR-05A **sin cambios** (las RPC compartidas no se tocaron).

## 2. Cuándo se crea el aviso (el disparador)

Un trigger `AFTER UPDATE` sobre `order_shipments` que solo se dispara en la **transición hacia** `at_destination` (`OLD.logistic_status <> 'at_destination'`). Como el estado nunca retrocede y un refresh que se queda en `at_destination` no es una transición, se dispara **una sola vez por episodio**. Un episodio nuevo legítimo (guía corregida que vuelve a llegar a destino) es una transición nueva y genera un aviso nuevo; el anterior queda como historial.

No se dispara en `at_origin`, `in_transit`, ni en `delivered` (si nunca pasó por destino no hay fila; si pasó por destino y se entrega antes del envío, el aviso se **omite** (`skipped`) y no se envía).

## 3. Inercia: cuándo NO hace nada

El trigger no crea **nada** (ni fila, ni evento, ni claim, ni WhatsApp) salvo que la cuenta tenga **todo** esto:

* `logistics_mvp_enabled = true`,
* `order_shipment_settings.shalom_tracking_enabled = true`,
* `order_shipment_settings.destination_customer_message_enabled = true` (el interruptor existente del mensaje al cliente: no se creó otro flag),
* una **plantilla de llegada configurada** (`arrival_message_template_name` / `_language`).

Además el envío respeta el kill switch global `SHALOM_TRACKING_ENABLED` (sin `true` el tick no envía ningún mensaje). Consecuencias deliberadas:

* **Sin plantilla de llegada configurada, una cuenta que solo use el mensaje del día 15 se comporta exactamente como antes** (el aviso de llegada es *opt-in* por configuración).
* Activar el interruptor más tarde **no** avisa de envíos que ya estaban en destino (el trigger solo mira transiciones que ocurren con todo encendido). No hay backfill.
* Al activar `destination_customer_message_enabled` también queda habilitado el mensaje del día 15 (el interruptor es uno solo): **configurar la plantilla C antes del primer día 15**, o ese aviso quedará `failed` con `template_not_configured` y esperará a una persona.

## 4. Configuración (de la cuenta, no del código)

Columnas nuevas en `order_shipment_settings` (la migración **no** las rellena ni activa nada):

```sql
UPDATE order_shipment_settings SET
  arrival_message_template_name     = 'pedido_llegada_destino',
  arrival_message_template_language = 'es',
  arrival_message_template_params   = '["customer_name","product","destination"]'
WHERE account_id = '<cuenta>';
```

La plantilla debe existir en `message_templates` de la cuenta con estado `APPROVED` (se sincroniza desde Meta), con el mismo número de variables de `params`. Campos de variable permitidos (los de siempre): `customer_name`, `product`, `quantity`, `total`, `destination`, `seller_name`, `dni`. La plantilla y los parámetros se **congelan en el registro** cuando el aviso queda pendiente.

Plantilla conceptual (**no creada en Meta todavía**): `pedido_llegada_destino`, idioma `es`, categoría `UTILITY`, **sin header** (este camino solo envía cuerpo):

> Hola {{1}}, tu pedido de {{2}} ya llegó a destino ({{3}}). Puedes acercarte a la agencia a recogerlo con tu DNI. Si tienes alguna duda, responde a este mensaje.

Las otras dos plantillas de la estrategia siguen **documentadas, sin implementar por código**: **A.** `pedido_embalado_listo` (embalaje; PR-04 ya tiene el mecanismo y su configuración `packaging_template_*`) y **C.** `recordatorio_recojo_pedido` (día 15; mecanismo PR-05A, configuración `customer_message_template_*`).

## 5. Idempotencia y concurrencia

* `UNIQUE (order_id, destination_episode, kind)` + `ON CONFLICT DO NOTHING`: ticks, refrescos, workers y reintentos no pueden crear un segundo registro del mismo episodio.
* Un solo evento `destination_arrival_message_due` por episodio (índice único).
* Dos workers a la vez: un envío por aviso (`FOR UPDATE SKIP LOCKED` + token + lease).
* `sent`/`delivered`/`read` no generan envíos nuevos: `sent` es final y los estados del webhook solo actualizan el mensaje ya guardado.
* Convive con el mensaje del día 15: mismo episodio, dos filas de `kind` distinto, cada una una sola vez.

## 6. Política de reintentos (la existente, sin motor nuevo)

* **`failed`** (nada llegó a WhatsApp: Meta rechaza, falta la plantilla…): reintentos automáticos acotados, **3 intentos** por defecto (`messageMaxAttempts`) con **backoff 5 / 15 / 60 min** (`messageBackoffMinutes`), ambos ajustables con `SHALOM_CONFIG_JSON`. Los errores de configuración (`template_not_configured / not_found / not_approved / malformed / params_mismatch`, pedido sin conversación) **no** se reintentan solos: esperan a una persona. Agotados los intentos, solo una persona puede reintentar.
* **`uncertain`** (Meta pudo haber aceptado el envío): **nunca** se reenvía automáticamente. Una persona revisa la conversación y lo resuelve (*sí se entregó* / *no se entregó*). Un proceso muerto a mitad de envío también queda `uncertain`.
* **`skipped`**: si al momento del envío el pedido ya no está en destino (entregado, corregido, detenido).

## 7. Permisos (sin cambios)

Reintentar o resolver: Logística y Supervisor de la cuenta. Comercial, espectadores y otras cuentas no leen ni operan el ledger (RLS + RPC). El aviso automático no depende de un usuario conectado y Comercial no dispara mensajes logísticos.

## 8. Panel del pedido

*Tracking Shalom* muestra una fila **Aviso de llegada al cliente** (solo si existe) junto a **Mensaje al cliente (día 15)**, y los botones de reintentar/resolver actúan sobre el aviso fallido/incierto correspondiente.

## 9. Dependencia de cutover (InkaClick)

`notify-destination-vouchers` de InkaClick **solo podrá apagarse** cuando este aviso esté: **desplegado**, con la plantilla **APPROVED** en el WABA de WACRM, **probado con el número de WACRM** (+51 980 942 247, Phone Number ID `740434745820831`, WABA `1100749476063768`), y **activo y validado** (interruptor encendido y un aviso real recibido y registrado en la conversación). Nota de la auditoría: lo que InkaClick envía en volumen al llegar a destino es `confirmacion_recojo_hoy_v2` (con instrucciones de pago), no `pedido_listo_en_agencia`; qué contenido replica WACRM es una **decisión de negocio** pendiente.

## 10. Pendiente

* Crear y aprobar en Meta las plantillas A, B y C en el WABA de WACRM (no se hace aquí).
* Decisión de negocio: contenido (¿instrucciones de pago? ¿DNI?) y categoría.
* Prueba real controlada con el número de WACRM antes de apagar InkaClick.
* Migración `20261205000001_shipment_arrival_message.sql` (aditiva e idempotente, sin DROP de datos, sin tocar settings ni activar flags): **aplicar en producción solo con autorización de deploy** (ver `supabase/release/migration-manifest.json`, `patch_migrations`).
