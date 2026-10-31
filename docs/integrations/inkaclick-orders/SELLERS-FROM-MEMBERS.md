# Vendedores = miembros de la cuenta

Regla aprobada para la primera versión: **cada miembro real de una cuenta de WACRM es elegible como vendedor comercial de un pedido.** No hay catálogo que mantener ni pantalla de alta.

## Alternativas

| | A. Leer los perfiles | B. `order_sellers` sincronizado con los perfiles |
|---|---|---|
| Duplicación de datos | Ninguna | Una copia de cada miembro |
| Alta de un miembro (invitación aceptada) | Automática: `redeem_invitation` ya crea/mueve su perfil | Requiere un disparador en `profiles` |
| Baja (`remove_account_member`) | Automática: el perfil pasa a una cuenta personal | Requiere un disparador; si falla, queda un vendedor fantasma |
| Cambio de nombre | Inmediato | Requiere propagarlo |
| Identidad estable | `auth.users.id` (única por usuario) | Un id propio más el enlace al usuario |
| Perfiles funcionales futuros | Se cambia **una** función | Hay que cambiar el disparador y el catálogo |
| Riesgo | Mínimo | Deriva entre catálogo y perfiles |

**Elegida: A.** `order_seller_candidates(cuenta)` es el único lugar que define quién puede ser vendedor (hoy: todo perfil de la cuenta con nombre). Los perfiles Comercial, Logística y Administrador se añadirán modificando solo esa función.

## Reglas

| Caso | Comportamiento |
|---|---|
| Propietario | Elegible desde el primer día |
| Miembro activo | Elegible |
| Invitación pendiente | No genera vendedor (no tiene perfil en la cuenta) |
| Invitación aceptada | Elegible automáticamente |
| Miembro retirado | Sale del selector; no puede ser vendedor de pedidos nuevos |
| Cambio de nombre | El selector lo refleja; los pedidos anteriores conservan la instantánea |
| Nombre vacío en el perfil | Se usa la parte local del correo; sin ninguno, no es elegible |
| Vendedor ≠ quien confirma | Sí. Se guardan por separado: `confirmed_by` (+ `confirmed_by_name`) y `seller_user_id` (+ `seller_name`) |
| Rol `viewer` | Puede figurar como vendedor, pero **no puede confirmar** (API: `requireRole('agent')`; SQL: `actor_not_allowed`) |
| Otra cuenta | Imposible: el vendedor debe ser miembro de la cuenta del pedido (función y disparador) |
| Historial | `seller_name` es inmutable; `seller_user_id` solo puede pasar a NULL (borrado del usuario). Las tablas `order_sellers`/`seller_id` de la migración anterior se conservan sin uso |

## Interruptor de la función (por cuenta, apagado por defecto)

`order_integration_settings.confirm_enabled`. Es **independiente** de `enabled` (entrega a InkaClick):

| `confirm_enabled` | `enabled` | Resultado |
|---|---|---|
| FALSE (o sin fila) | cualquiera | Sin botón; `POST /api/orders/confirm` → 403 `feature_disabled`; el listado no devuelve miembros |
| TRUE | FALSE | Se pueden confirmar pedidos; quedan `held` (no se envían) |
| TRUE | TRUE | Se confirman y se entregan por el outbox |

Se aplica en tres capas: botón (oculto), API y función SQL.

## Datos que no cambian

Los 13 campos comerciales siguen congelados; la idempotencia (`request_key`) y el contrato JSON hacia InkaClick no cambian (`vendedor` sigue siendo el nombre instantáneo).

## Reversión

`confirm_enabled = FALSE` apaga la función al instante. La migración `20261102000000_order_sellers_from_members.sql` es aditiva y no se revierte: no pierde datos y la imagen anterior no la usa.
