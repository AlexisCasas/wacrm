# WACRM → InkaClick: despliegue, activación y rollback

Nada de esto se ha ejecutado. Cada paso productivo requiere autorización explícita.

## PRs (en este orden; cada uno se revisa por separado)

| # | Repo | Rama | Responsabilidad |
|---|---|---|---|
| 0 | wacrm | `codex/inkaclick-orders-design` | Auditoría y diseño (solo docs) |
| 1 | wacrm | `codex/inkaclick-orders-db` | Esquema: pedidos, historial de intentos, vendedores, interruptor, funciones del outbox |
| 2 | wacrm | `codex/inkaclick-orders-core` | Validación de los 13 campos, payload, emisor, outbox, rutas `/api/orders/*` |
| 3 | wacrm | `codex/inkaclick-orders-ui` | Botón y formulario «Confirmar pedido» en el Inbox + este documento |
| 4 | InkaClick-Saas | `codex/wacrm-confirmed-orders-receiver` | Migración aditiva + edge function `wacrm-confirmed-orders` |

Los PRs 1 a 3 están apilados (cada uno contiene los anteriores); fusionar en orden.

## Despliegue (todo apagado por defecto)

0. (Opcional, requiere permiso `workflow`) añadir a `.github/workflows/migrations.yml`, tras «Verify the resulting schema», el paso `supabase db query --local --file supabase/ci/verify-order-confirmations.sql`.
1. **InkaClick** (otro proyecto Supabase, lo aplica quien lo administra): backup, migración `20261101010000_wacrm_confirmed_orders.sql`, `supabase functions deploy wacrm-confirmed-orders --no-verify-jwt` (**obligatorio**: la función se autentica con su propio secreto Bearer, que no es un JWT de Supabase; con `verify_jwt` activo el gateway rechaza al emisor con `Invalid JWT` antes de llegar al código, y un redespliegue sin la bandera lo reactiva), secreto `WACRM_ORDERS_TOKEN` (distinto del de ManyChat). Comprobar tras desplegar: sin token → 401 `unauthorized`, token incorrecto → 401 `unauthorized`, secreto válido → no 401. La migración solo añade 2 columnas nulas, un índice único parcial, 1 tabla de auditoría y 1 función; ManyChat no se toca.
2. **WACRM**, mismo procedimiento que F1: backup + `docker save` de la imagen anterior, aplicar `20261101000000_order_confirmations.sql` **antes** de la imagen, construir y recrear `app`. La imagen anterior sigue funcionando con el esquema nuevo (solo tablas nuevas).
3. Con todo apagado nada cambia: sin vendedores el botón no aparece; sin `INKACLICK_ORDERS_ENABLED=true` el cron no envía.
4. **Cron** (cuando se active): añadir una línea igual a la de flows que llame a `GET /api/orders/cron` con `x-cron-secret` cada minuto.

## Activación gradual (cuenta piloto de pruebas)

1. Crear vendedores (`order_sellers`): los 4 vendedores históricos (lista a confirmar). El botón aparece.
2. Con el interruptor de la cuenta apagado, confirmar un pedido de prueba: queda `held` (guardado, no se envía).
3. Prueba extremo a extremo contra un **proyecto InkaClick de pruebas** (no el productivo): `order_integration_settings.enabled = true`, `INKACLICK_ORDERS_*` apuntando al entorno de pruebas.
4. Producción: un solo pedido real autorizado, comprobar fila en `confirmed_orders` (`source='wacrm'`), estado `acknowledged` en WACRM y que el cliente se creó en `customers`.
5. Ampliar.

Los pedidos `held` nunca se liberan solos al activar el interruptor.

## Qué se verificó (datos sintéticos, aislado, sin tocar producción)

- Esquema WACRM (`supabase/ci/verify-order-confirmations.sql`): creación idempotente, dos pedidos del mismo contacto, rechazo de contacto/vendedor ajenos, `held` con interruptor apagado, `precio > 0`, cantidad ≥ 1, campos congelados, lease `SKIP LOCKED`, reintento, ignorar reportes obsoletos, `failed`, `dead`, recuperación de lease vencido, RLS y cierre a usuarios autenticados.
- Aplicación WACRM: 81 tests (validación, payload, emisor: éxito, 200 sin id, 409 con id, timeout, red, 429/5xx, 4xx, Retry-After, sin PII en errores; outbox: apagado, backoff, reconciliación; ruta: rol, cuenta de la sesión, doble clic, idempotencia, referencias ajenas) y 8 del formulario (precarga, edición, vista previa, doble clic = una petición con una sola `request_key`). Mutaciones en los 4 controles críticos fueron detectadas.
- InkaClick (`supabase/tests/`, réplica del esquema y triggers): ManyChat sin cambios, creación/reenvío con el mismo id, reenvío con contenido distinto no altera el pedido, triggers de pagos y clientes, 16 entradas inválidas rechazadas, 12 llamadas concurrentes → 1 fila, migración re-aplicable, función cerrada a usuarios autenticados. Edge function: 7 tests (auth, 201/200/422/500/400/405, GET, sin datos del cliente en las respuestas).
- No verificado: la edge function bajo el runtime Deno real y el flujo completo entre los dos sistemas (requieren un proyecto InkaClick de pruebas), ni el rendimiento con carga real.

## Rollback

| Qué | Cómo | Efecto |
|---|---|---|
| Detener el envío | `order_integration_settings.enabled = false` (por cuenta) o quitar `INKACLICK_ORDERS_ENABLED` (global) | Inmediato. Los pedidos quedan guardados; los pendientes esperan. ManyChat intacto |
| Quitar el botón | Desactivar los vendedores (`active = false`) | El botón desaparece; los pedidos existentes no cambian |
| Imagen WACRM | Recrear `app` con la imagen anterior | Compatible: el esquema nuevo solo añade tablas |
| InkaClick | Dejar de usar la edge function (o borrarla). Columnas/índice pueden quedarse | No altera filas existentes ni ManyChat |

Un pedido ya recibido por InkaClick **no se borra** con un rollback: se anula con el flujo de anulación existente de InkaClick.

## Número de WhatsApp (aparte de este código)

Cambiar de proveedor el número no es una operación instantánea ni reversible a voluntad: el traslado y el retorno dependen de Meta y del proveedor (verificación, ventanas de espera, plantillas). Esta integración no depende del número, solo del Inbox de WACRM. El plan de reversión del número debe acordarse con el proveedor antes de migrar y no se da por supuesto aquí.

## Pendiente de conformidad

- Lista final de vendedores y quién los da de alta (no hay pantalla de administración todavía: se cargan por SQL con rol de servicio).
- Proyecto InkaClick de pruebas para la verificación extremo a extremo.
- Quién aplica la migración en InkaClick y despliega la edge function.
- Confirmar que la UI de InkaClick muestra `descripcion_pedido_url` con texto libre (ya contiene texto libre en más de la mitad de los pedidos históricos) y si debe mostrar `departamento`.
