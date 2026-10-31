# Fase 4 — primera recepción productiva controlada (WACRM → InkaClick)

Estado: **preparada, no ejecutada**. Cada paso `[AUTORIZAR]` cambia producción. No hay datos personales en este documento.

## Punto de partida (verificado)
- InkaClick: migración y función instaladas; 0 filas `source='wacrm'`; 0 eventos; historial intacto (hash de `confirmed_orders` igual al del respaldo).
- WACRM: URL y token cargados; `INKACLICK_ORDERS_ENABLED` sin definir; `enabled = FALSE`; sin cron; dos pedidos de prueba en `held` (0 intentos).
- `claim_order_deliveries` solo reclama `pending` (y `sending` con lease vencida) de cuentas con `enabled`; ninguna función ni código libera `held`.

## Efectos de insertar un pedido en InkaClick
| Mecanismo | Efecto |
|---|---|
| 5 disparadores de `confirmed_orders` | Normalizan teléfono, calculan pagos (`pago_restante = precio`, sin pagar) y **crean o actualizan el cliente** (`customers`, con `total_pedidos`/`ultimo_pedido_at`). No envían nada |
| Cron `notify-destination-vouchers` y `sync-shalom-statuses` | Actúan sobre vouchers. Solo consultan `confirmed_orders` para resolver producto/pedido activo de un voucher con ese teléfono |
| Realtime y vista `v_whatsapp_conversation_confirmed_orders` | El pedido aparece en el contexto de la conversación si existe una con ese teléfono |
| `send-confirmed-order-whatsapp` | Solo lo dispara una persona operadora desde la UI |
| Módulo logístico | Lista por `created_at` desc, sin filtro por `source`: el pedido aparece arriba |

## Elección del teléfono (condición previa)
Debe ser un contacto de la cuenta piloto en WACRM con teléfono `51` + 9 dígitos y **sin rastro en InkaClick**: sin cliente, pedidos, conversación ni vouchers. Se comprueba con hashes del teléfono, sin mostrarlo. Los dos contactos de los pedidos `held` **no sirven**: ambos ya existen como clientes con conversación, y uno tiene vouchers (los cron podrían resolver su producto con el pedido nuevo).

## Datos de la prueba
Producto `PRUEBA WACRM E2E - NO DESPACHAR`, cantidad 1, precio 1.00, agencia Shalom, destino y vendedor reales de la cuenta, DNI vacío, **descripción y departamento vacíos** (el frontend productivo aún trata la descripción como enlace; ver `InkaClick-Saas#5`).

## Procedimiento
| # | Paso | Verificación | Si falla |
|---|---|---|---|
| 0 | Línea base: recuentos y hashes de `confirmed_orders`/`customers`, 2 pedidos `held`, avisar a logística de que existe un pedido de prueba | Coinciden con el respaldo | Detener |
| 1 `[AUTORIZAR]` | Ventana de entrega: `INKACLICK_ORDERS_ENABLED=true` en `.env.local` (recrear solo `app`) y `enabled=TRUE` en la cuenta piloto. **Sin cron** | `app` healthy; `/api/orders/cron` manual devuelve `claimed:0` | Revertir (paso 7) |
| 2 | La persona responsable confirma **un** pedido desde el Inbox con el contacto elegido | Una fila nueva en `pending`; los 2 antiguos siguen `held` | Revertir; no llamar al cron |
| 3 `[AUTORIZAR]` | **Una** llamada manual a `/api/orders/cron` con su secreto | `claimed=1, sent=1`; `attempts=1`; 1 fila en `order_confirmation_deliveries` | Revertir; revisar `last_error_code` |
| 4 | Segunda llamada manual | `reconciled=1`; pedido `acknowledged` con `inkaclick_order_id` | Revertir |
| 5 | Verificar en InkaClick | 1 fila `source='wacrm'` con los 13 campos y vendedor correctos; 1 evento `created`; 1 cliente creado o actualizado; hash del historial ManyChat idéntico | Revertir; conservar evidencia |
| 6 | Idempotencia: repetir el mismo payload con el token (script que no imprime datos) y consultar por GET | 200, mismo id; evento `replayed`; sigue 1 fila | Revertir |
| 7 `[AUTORIZAR]` | Cerrar la ventana: `enabled=FALSE`, quitar `INKACLICK_ORDERS_ENABLED` (recrear `app`) | Llamada manual del cron devuelve `enabled:false`; sin cron; 2 `held` intactos | — |
| 8 | Visibilidad: la persona responsable abre el módulo logístico y comprueba producto, cantidad, precio, vendedor, agencia, destino y estado | Visibles; departamento y descripción vacíos | Registrar |
| 9 `[AUTORIZAR]` aparte | Limpieza o conservación del pedido de prueba (y del cliente si lo creó) | Conteos finales | — |

Mientras dure la ventana (pasos 1 a 7), cualquier otro pedido que confirme la cuenta piloto quedaría `pending` en vez de `held`; no se enviaría sin la llamada manual, y el cron sigue sin instalar.

## Reversión
| Situación | Acción |
|---|---|
| Cualquier fallo | `enabled=FALSE`, quitar `INKACLICK_ORDERS_ENABLED`, recrear `app`; ningún cron que detener |
| Pedidos `pending` sin enviar tras la ventana | Quedan en WACRM sin enviarse mientras `enabled` sea `FALSE`; decidir caso por caso |
| Pedido de prueba en InkaClick | No se borra sin autorización; limpieza (solo con autorización): borrar su fila de `wacrm_order_events`, la fila de `confirmed_orders` (`source='wacrm'` y su `external_order_id`) y el cliente solo si lo creó la prueba |
| Datos históricos | No se modifican; restauración solo por tabla desde el respaldo |
