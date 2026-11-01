# Fase 4 — primera recepción productiva controlada (WACRM → InkaClick)

Estado: **preparada, no ejecutada; a la espera de autorización para abrir la ventana de entrega**. Cada paso `[AUTORIZAR]` cambia producción. Este repositorio es público: aquí no hay datos personales, identificadores de clientes ni hashes de teléfonos.

## Punto de partida (verificado)
- InkaClick: migración y función instaladas; 0 filas `source='wacrm'`; 0 eventos; historial intacto (hash de `confirmed_orders` igual al del respaldo).
- WACRM: URL y token cargados; `INKACLICK_ORDERS_ENABLED` sin definir; `enabled = FALSE`; sin cron; dos pedidos de prueba en `held` (0 intentos).
- `claim_order_deliveries` solo reclama `pending` (y `sending` con lease vencida) de cuentas con `enabled`. Ninguna función de la base ni código de la app pasa un pedido de `held` a `pending`: **el único pedido elegible para una llamada manual al cron será el nuevo**.

## Efectos de insertar un pedido en InkaClick
| Mecanismo | Efecto |
|---|---|
| 5 disparadores de `confirmed_orders` | Normalizan el teléfono, calculan pagos (`pago_restante = precio`, sin pagar) y **hacen upsert del cliente** en `customers`. No envían nada |
| Cron `notify-destination-vouchers` y `sync-shalom-statuses` (los únicos 2 de la base) | Actúan sobre vouchers; solo leen `confirmed_orders` para resolver el producto de un voucher con ese teléfono |
| Disparadores con `net.http_*`, colas o tablas de notificaciones | No existen |
| `whatsapp-webhook` | No envía respuestas automáticas |
| `send-confirmed-order-whatsapp` | Solo desde la UI, por una persona operadora |
| Vista `v_whatsapp_conversation_confirmed_orders` y rutas de contexto (solo lectura) | Enlazan por teléfono: la conversación mostrará el pedido y su etapa de pipeline; la fila de la conversación y sus mensajes no se modifican |
| Módulo logístico | Lista por `created_at` desc, sin filtro por `source`: el pedido aparece arriba y cuenta como +1 pedido |

## Variante A — contacto nuevo sin rastro en InkaClick
Contacto de la cuenta piloto con teléfono `51` + 9 dígitos, sin cliente, pedidos, conversación ni vouchers. Se comprueba con hashes, sin mostrar el número. Efecto: se crea un cliente.

## Variante B — contacto existente (sin SIM nueva)
Se admite un contacto de la cuenta piloto cuyo teléfono ya existe en InkaClick **solo si** el preflight confirma, en el momento de la prueba:
1. 0 vouchers asociados a ese teléfono en **todas** sus columnas (`destinatario_telefono`, `remitente_telefono`, `shalom_phone`, `whatsapp_phone_resolved`) ni al DNI del cliente.
2. 0 pedidos en `confirmed_orders` por teléfono ni por DNI, y ninguno creado en las últimas horas.
3. Sin colas ni tareas de notificación vinculadas (no existen tablas de cola ni disparadores `net.http`).
4. La persona titular del número confirma por escrito que autoriza la prueba y que ese cliente se modifica (ver consecuencias).
5. Que el nombre del contacto en WACRM y el del cliente en InkaClick pueden diferir: se decide en el paso 2 qué nombre se escribe.

### Consecuencias exactas sobre el cliente existente
El disparador `sync_customer_from_confirmed_order` hace `INSERT … ON CONFLICT (telefono_normalized) DO UPDATE` sobre la fila existente de `customers`:

| Campo de `customers` | Efecto |
|---|---|
| `nombre_completo` | **Se sobrescribe** con el nombre del pedido (`coalesce(nuevo, existente)`), salvo que el pedido lleve exactamente el mismo nombre que ya tiene el cliente |
| `total_pedidos` | **Se recalcula**: cuenta pedidos por el DNI del cliente (si tiene DNI válido) o por teléfono; el pedido de prueba no lleva DNI, así que si no hay pedidos históricos por ese DNI el contador **baja** (p. ej. de 2 a 0) aunque haya un pedido nuevo |
| `ultimo_pedido_at` | Pasa a la fecha del pedido nuevo |
| `telefono` | Se reescribe con el valor del pedido (mismo teléfono normalizado) |
| `updated_at` | Pasa a ahora |
| `nombre`, `apellido`, `dni`, `dni_normalized`, `source`, `created_at`, `id` | Sin cambios (el DNI existente se conserva) |

Sobre la conversación: **ninguna fila de `whatsapp_conversations` ni de `whatsapp_messages` cambia**; el único efecto es de lectura (el pedido aparece en el contexto del chat y su etapa). No se envía ningún mensaje de WhatsApp.

### Antes de abrir la ventana: pre-imagen
El respaldo `pre-wacrm-<ts>` contiene la fila original del cliente. Antes de la ventana se extrae esa fila del volcado (`pg_restore -a -t customers`) a un archivo del servidor con permisos 600, sin imprimirla, y se anotan los valores de `nombre_completo`, `total_pedidos`, `ultimo_pedido_at` y `telefono`. Si el volcado no contiene la fila, se detiene la prueba.

## Datos de la prueba
Producto `PRUEBA WACRM E2E - NO DESPACHAR`, cantidad 1, precio S/ 1.00, agencia Shalom, destino y vendedor reales de la cuenta, DNI vacío, **descripción y departamento vacíos** (el frontend productivo aún trata la descripción como enlace; ver `InkaClick-Saas#5`). Variante B: el nombre del pedido se escribe igual al del cliente existente si se quiere conservar su `nombre_completo`; si no, se acepta la sobrescritura y la limpieza lo restaura.

## Procedimiento
| # | Paso | Verificación | Si falla |
|---|---|---|---|
| 0 | Línea base: recuentos y hashes de `confirmed_orders`/`customers`, 2 pedidos `held`; pre-imagen del cliente (variante B); aviso a logística de que existe un pedido de prueba | Coinciden con el respaldo | Detener |
| 1 `[AUTORIZAR]` | Ventana de entrega: `INKACLICK_ORDERS_ENABLED=true` en `.env.local` (recrear solo `app`) y `enabled=TRUE` en la cuenta piloto. **Sin cron** | `app` healthy; llamada manual a `/api/orders/cron` devuelve `claimed:0` | Revertir (paso 7) |
| 2 | La persona responsable confirma **un** pedido desde el Inbox con el contacto elegido | Una fila nueva en `pending`; los 2 antiguos siguen `held` | Revertir; no llamar al cron |
| 3 `[AUTORIZAR]` | **Una** llamada manual a `/api/orders/cron` con su secreto | `claimed=1, sent=1`; `attempts=1`; 1 fila en `order_confirmation_deliveries` | Revertir; revisar `last_error_code` |
| 4 | Segunda llamada manual | `reconciled=1`; pedido `acknowledged` con `inkaclick_order_id` | Revertir |
| 5 | Verificar en InkaClick | 1 fila `source='wacrm'` con los 13 campos y vendedor correctos; 1 evento `created`; el cliente cambió **solo** como se describe arriba; hash del historial ManyChat idéntico; conversación con los mismos mensajes | Revertir; conservar evidencia |
| 6 | Idempotencia: repetir el mismo payload con el token (script que no imprime datos) y consultar por GET | 200, mismo id; evento `replayed`; sigue 1 fila | Revertir |
| 7 `[AUTORIZAR]` | Cerrar la ventana: `enabled=FALSE`, quitar `INKACLICK_ORDERS_ENABLED` (recrear `app`) | Llamada manual del cron devuelve `enabled:false`; sin cron; 2 `held` intactos | — |
| 8 | Visibilidad: la persona responsable abre el módulo logístico y el chat y comprueba producto, cantidad, precio, vendedor, agencia, destino, estado y etapa del chat | Visibles; departamento y descripción vacíos | Registrar |
| 9 `[AUTORIZAR]` aparte | Limpieza (siguiente sección) o conservación del pedido de prueba | Conteos finales | — |

Mientras dure la ventana (pasos 1 a 7), otro pedido que confirme la cuenta piloto quedaría `pending` en vez de `held`; no se enviaría sin la llamada manual y el cron sigue sin instalar.

## Limpieza (paso 9) — pedido, cliente y conversación
Todo en una transacción con `lock_timeout`, y solo con autorización expresa.

1. **Precondiciones (abortan si fallan)**: el pedido de prueba es el único con `source='wacrm'` y su `external_order_id`; ninguna fila de `vouchers`, `whatsapp_messages`, `manychat_webhook_events` ni `confirmed_orders.replacement_confirmed_order_id` lo referencia; el historial ManyChat conserva su hash.
2. **Eventos**: `DELETE FROM wacrm_order_events WHERE external_order_id = <ID>` (debe borrar los `created` y `replayed` de la prueba).
3. **Pedido**: `DELETE FROM confirmed_orders WHERE source='wacrm' AND external_order_id = <ID>`.
4. **Cliente (variante B)**: `UPDATE customers SET nombre_completo=<pre>, total_pedidos=<pre>, ultimo_pedido_at=<pre>, telefono=<pre> WHERE id=<cliente>` con los valores de la pre-imagen (archivo protegido). El borrado del pedido no dispara el disparador (es `AFTER INSERT OR UPDATE`), así que el cliente no se recompone solo. `updated_at` queda con la hora de la limpieza (el disparador de `customers` lo fija); si se necesita el valor original se desactiva ese disparador solo durante la transacción.
5. **Cliente (variante A)**: borrar la fila de `customers` solo si se creó en la prueba (`source='confirmed_orders'`, `created_at` posterior a la ventana y sin otros pedidos).
6. **Conversación**: no hay nada que restaurar; se verifica que conserva sus mensajes (mismo recuento y último mensaje) y que el chat ya no muestra el pedido.
7. **WACRM**: el pedido de prueba (`acknowledged`) se conserva como evidencia; es inmutable por diseño y no se borra.
8. **Verificación final**: hash de `confirmed_orders` igual al del respaldo (excluyendo las dos columnas nuevas); fila del cliente igual a la pre-imagen salvo `updated_at`; 0 filas `wacrm`; 0 eventos.

## Reversión
| Situación | Acción |
|---|---|
| Cualquier fallo | `enabled=FALSE`, quitar `INKACLICK_ORDERS_ENABLED`, recrear `app`; no hay cron que detener |
| Pedidos `pending` sin enviar tras la ventana | Quedan en WACRM sin enviarse mientras `enabled` sea `FALSE`; decidir caso por caso |
| Pedido de prueba en InkaClick | No se borra sin autorización; ver «Limpieza» |
| Datos históricos | No se modifican; restauración solo por tabla desde el respaldo |

## Por qué `customers.total_pedidos` no coincide con los pedidos reales
`customers.total_pedidos` y `ultimo_pedido_at` solo se recalculan cuando se **inserta o actualiza** un pedido (el disparador es `AFTER INSERT OR UPDATE OF …`; no hay ninguno para `DELETE`). El pedido más antiguo que conserva `confirmed_orders` es del 22-ago-2026 y no queda ninguno anterior: una limpieza de datos antiguos borró pedidos sin tocar `customers`. Por eso un cliente cuyo último pedido fue el 21-ago conserva `total_pedidos = 2` aunque ya no tenga pedidos. No es un fallo de esta integración: afecta a más de la mitad de los clientes con contador positivo. **Consecuencia para la prueba:** el primer pedido nuevo recalcula el contador desde los pedidos que existan hoy (0 por DNI), por lo que puede bajar; la limpieza lo restaura desde la pre-imagen.

## Limpieza — SQL de referencia (solo con autorización; valores entre `<>` desde la pre-imagen y la prueba)
```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM confirmed_orders WHERE source = 'wacrm';
  IF n <> 1 THEN RAISE EXCEPTION 'se esperaba exactamente 1 pedido wacrm, hay %', n; END IF;
  SELECT (SELECT count(*) FROM vouchers WHERE confirmed_order_id = o.id) + (SELECT count(*) FROM whatsapp_messages WHERE confirmed_order_id = o.id)
       + (SELECT count(*) FROM manychat_webhook_events WHERE confirmed_order_id = o.id) + (SELECT count(*) FROM confirmed_orders r WHERE r.replacement_confirmed_order_id = o.id)
    INTO n FROM confirmed_orders o WHERE o.source = 'wacrm';
  IF n <> 0 THEN RAISE EXCEPTION 'el pedido de prueba esta referenciado (% filas); abortar', n; END IF;
END $$;
DELETE FROM wacrm_order_events WHERE external_order_id = '<EXTERNAL_ORDER_ID>';
DELETE FROM confirmed_orders WHERE source = 'wacrm' AND external_order_id = '<EXTERNAL_ORDER_ID>';
ALTER TABLE customers DISABLE TRIGGER trg_customers_updated_at;   -- solo para devolver updated_at; se revierte con la transacción si algo falla
UPDATE customers SET total_pedidos = <TOTAL_PEDIDOS_ORIGINAL>, ultimo_pedido_at = '<ULTIMO_PEDIDO_AT_ORIGINAL>', updated_at = '<UPDATED_AT_ORIGINAL>'
  -- nombre_completo y telefono: añadir solo si la prueba los cambió (si el pedido llevó el mismo nombre, no cambian)
  WHERE id = '<CLIENTE_ID>';
ALTER TABLE customers ENABLE TRIGGER trg_customers_updated_at;
-- Verificaciones antes de COMMIT: md5(to_jsonb(fila del cliente)) = el de la línea base; 0 filas wacrm; 0 eventos;
-- md5 de confirmed_orders (sin las 2 columnas nuevas) = el de la línea base; la conversación conserva sus mensajes y su fila.
COMMIT;
```
No se borra ninguna ficha de cliente ni dato histórico. El pedido de WACRM (`acknowledged`) se conserva como evidencia.

## Evaluación: nombre del pedido distinto del de la ficha del cliente
El formulario toma por defecto el nombre del contacto de WACRM; la ficha histórica de `customers` puede tener otro. Los pedidos de WACRM son **inmutables** (disparador de congelación), así que el nombre de un pedido ya confirmado no se puede corregir. Al insertar el pedido, el disparador de InkaClick hace `nombre_completo = coalesce(nuevo, existente)`: el nombre del pedido sobrescribe el de la ficha. Es el comportamiento normal de InkaClick (también con pedidos de ManyChat), no un defecto de la integración.

| Opción | Efecto sobre la ficha histórica | Valoración |
|---|---|---|
| Escribir en el formulario exactamente el nombre de la ficha | Ninguno | La mejor; hay que hacerlo **antes** de confirmar |
| Enviar un pedido con otro nombre y restaurar después | La ficha cambia hasta la limpieza; después vuelve a su estado original (hash de la fila idéntico a la pre-imagen) | Aceptable en una prueba si la limpieza se hace de inmediato |
| Corregir el pedido ya confirmado | No es posible (inmutable) | Descartada |
| Retirar el pedido de la cola y confirmar otro | Requiere cambiar el estado de un pedido de WACRM | Solo con autorización expresa |
| Cambiar el disparador de InkaClick para no sobrescribir nombres | Cambia el comportamiento de producción para todos los pedidos | Fuera de alcance |

Para operación general: el nombre del pedido debe ser el del cliente real, no el alias del contacto de WACRM.

## Evaluación: departamento distinto del destino
`departamento` y `destino` son campos independientes del formulario: el primero se guarda en la columna nueva `departamento` (que el frontend productivo aún no muestra) y el segundo en `destino`, que es el que usa la logística. Una discrepancia entre ambos (p. ej. departamento de una región y destino en otra) no impide la entrega ni afecta a la logística, pero es una incoherencia de datos. El pedido ya confirmado no se puede editar. En la prueba es inocuo y además ejercita el campo `departamento`; para operación general conviene validar la coherencia en el formulario (mejora futura, no bloqueante).

## Resultado de la prueba E2E en producción (2026-11-01)
Primera entrega real de un pedido de WACRM a InkaClick con un contacto existente. Una llamada manual envió el pedido (HTTP 201), un reenvío idempotente devolvió 200 con el mismo id, y una segunda llamada manual lo reconcilió (`acknowledged`). Después se cerró la ventana (`enabled = FALSE`, variable global retirada, `app` recreada, sin cron). Los dos pedidos de prueba anteriores siguen en `held`; el historial de ManyChat conserva su hash; el pedido E2E y su evento de auditoría se conservan.

| Verificación | Resultado |
|---|---|
| Una sola fila nueva `source='wacrm'` con el `external_order_id` correcto | PASS |
| Campos comerciales transferidos (incluido `departamento`) | PASS |
| 1 evento `created`; reenvío: 200, mismo id, evento `replayed`, sigue 1 fila | PASS |
| Reconciliación: `claimed=0`, `reconciled=1`, pedido `acknowledged` con su `inkaclick_order_id`, sin segunda entrega | PASS |
| Ventana cerrada, `app` healthy, sin cron, entrega global apagada | PASS |
| Dos pedidos originales en `held` | PASS |
| Historial ManyChat intacto | PASS |
| Conversación del contacto sin cambios (mismos mensajes, misma fila) | PASS |
| Ficha histórica del cliente intacta | **FAIL (esperado y documentado): modificada por el disparador; restauración preparada** |

## Incidencia: ficha del cliente
Causa (demostrada con la definición de producción en una base desechable): `sync_customer_from_confirmed_order()` no distingue el origen. Con un cliente que ya tiene DNI válido cuenta los pedidos **solo por ese DNI**; un pedido de WACRM sin DNI no entra en la cuenta, y como `count(*)` nunca es `NULL`, el respaldo `coalesce(v_total_pedidos, 1)` no se aplica: el contador queda en 0 aunque acabe de entrar un pedido. Además sobrescribe `nombre_completo` con el nombre del pedido, que en WACRM es el alias del contacto del Inbox. Con pedidos de prueba el contador sigue siendo, por diseño, "pedidos que cumplen el criterio"; la semántica correcta para pedidos de prueba requiere poder identificarlos (ver abajo).
- **Restauración controlada** (preparada, no ejecutada): `scripts/ops/inkaclick-phase4-restore-customer.sql`. Bloquea la fila, exige que siga en el estado exacto posterior a la prueba (sin cambios concurrentes) y que no haya otros pedidos, restaura desde la pre-imagen y comprueba que el hash de la fila vuelve a ser idéntico al original; no toca el pedido E2E ni su auditoría. Ensayada con datos sintéticos (caso feliz y cambio concurrente simulado).
- **Corrección separada del disparador** (propuesta, sin desplegar): rama `codex/customer-sync-wacrm-semantics` en InkaClick-Saas, con regresión: la función actual de producción reproduce la incidencia, el comportamiento de ManyChat es idéntico antes y después (misma instantánea de `customers`) y siete escenarios WACRM pasan.

## Validaciones comerciales pendientes
1. **Departamento frente a destino:** el pedido de prueba llevó un departamento distinto de la región del destino. Son campos independientes; no afecta a la logística (usa `destino`), pero conviene validar la coherencia en el formulario.
2. **Visualización segura de descripción y departamento en el frontend de InkaClick:** pendiente (`InkaClick-Saas#5`, borrador, no fusionado). Hasta entonces la descripción libre no debe enviarse en operación general.
3. **Pedidos de prueba y estadísticas:** el pedido E2E (S/ 1.00) cuenta como un pedido más en listados y recuentos. Hace falta una marca de prueba (por ejemplo `is_test` o un valor reservado en el payload) que los pedidos de WACRM puedan llevar y que los informes, el contador de clientes y el pipeline excluyan. No existe hoy; es decisión de diseño pendiente.
4. **Nombre del pedido:** en operación general debe ser el del cliente real y no el alias del contacto.
5. Mientras no se despliegue la corrección del disparador, no activar WACRM comercialmente: cada pedido de WACRM de un cliente existente con DNI vuelve a sobrescribir su nombre y su contador.

## Restauración: primer intento abortado por la comprobación final (2026-11-01)
La plantilla de restauración se ejecutó una vez y **abortó sin cambiar nada**: las guardas iniciales pasaron (la fila estaba en el estado exacto posterior a la prueba y no había otros pedidos), pero la comprobación final detectó que la fila restaurada no coincidía con la anterior a la prueba, porque el primer intento solo restauraba cuatro columnas. Las columnas `nombre` y `apellido` también habían cambiado, algo que no se había previsto. La definición de producción del disparador, reproducida en una base desechable, **no** modifica `nombre` ni `apellido` por sí sola, así que el origen de ese cambio no está aclarado (el módulo de clientes de InkaClick permite editar clientes a mano; no se ha podido confirmar si alguien lo hizo). La plantilla ya restaura todas las columnas afectadas. Hasta aclarar el origen no se aplica la restauración completa.
