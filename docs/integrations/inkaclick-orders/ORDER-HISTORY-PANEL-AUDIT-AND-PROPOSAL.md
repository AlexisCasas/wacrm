# Historial de pedidos confirmados en el Inbox: auditoría y propuesta

Estado: **auditoría de solo lectura y propuesta. No hay código de la funcionalidad, ni migración, ni despliegue.** Datos productivos leídos con SELECT (3 filas de `order_confirmations`, 1 de `order_confirmation_deliveries`, políticas RLS, restricciones de `messages`/`notifications`, publicación realtime).

## 1. Qué ya existe

| Necesidad | Dónde está hoy | Estado |
|---|---|---|
| Producto, cantidad, importe | `order_confirmations.product / quantity / price` (congelados por el trigger `order_confirmations_freeze`) | Listo |
| Fecha y hora de confirmación | `confirmed_at timestamptz` (UTC). La hora de Lima se calcula al mostrarla (`America/Lima`, sin horario de verano) | Listo |
| Usuario que confirmó | `confirmed_by uuid` (FK `auth.users`, `ON DELETE SET NULL`) **y** `confirmed_by_name` (copia congelada del nombre). Se guardan desde la primera versión; los 3 pedidos productivos las tienen | Listo, sin migración |
| Vendedor, dato independiente | `seller_user_id` (FK) y `seller_name` (copia congelada). Los pedidos productivos lo confirman: Keyler confirmó con vendedor David y al revés | Listo |
| Estado de sincronización | `delivery_status`: `held`, `pending`, `sending`, `sent`, `acknowledged`, `failed`, `dead`; más `attempts` y `last_error_code` | Listo |
| Fechas de envío y de reconocimiento | `sent_at` (InkaClick respondió 2xx) y `acknowledged_at` (WACRM comprobó por consulta que InkaClick tiene el pedido) | Listo, con una salvedad (sección 4) |
| Identificador | `id` (uuid de WACRM) = `external_order_id` en InkaClick. `inkaclick_order_id` solo existe tras el envío | Listo |
| Varios pedidos por conversación | `UNIQUE (account_id, request_key)`: no hay unicidad por conversación. Índice `order_confirmations_contact_idx (account_id, contact_id, confirmed_at DESC)` | Listo |
| Historial de intentos | `order_confirmation_deliveries` (intento, resultado, HTTP, código de error) | Listo |
| Endpoints | `POST /api/orders/confirm`, `GET /api/orders/sellers`, `GET /api/orders/cron`. **No hay ningún endpoint ni consulta de lectura de pedidos** | Falta |
| Aislamiento por cuenta | RLS `order_confirmations_select`: `is_account_member(account_id, 'agent')`. Escrituras solo con service role | Listo |

## 2. Hallazgos que condicionan el diseño

1. **Permisos.** La RLS aísla por **cuenta** (tenant), no por usuario: cualquier agente, admin u owner de la cuenta ve todos los pedidos de esa cuenta. Los `viewer` no ven nada, porque el SELECT exige rol `agent`. Entiendo que «cada cuenta ve solo sus pedidos» significa esto. Si se quisiera que cada agente vea solo los que confirmó, sería una política nueva: no la recomiendo, porque el historial es de la conversación y cualquier agente puede continuarla.
2. **El interruptor `confirm_enabled`** hoy solo gobierna el botón y el POST. La lectura nueva debe respetarlo: una cuenta sin la función no debe ver la sección.
3. **Tiempo real.** `order_confirmations` **no** está en la publicación `supabase_realtime` (solo `messages` y `conversations`, entre las tablas relevantes). Para que el estado cambie en pantalla hay dos opciones: sondeo (sin tocar la base) o añadir la tabla a la publicación (migración aditiva y pequeña).
4. **Eventos en el chat.** `messages` no admite eventos internos: `sender_type` solo acepta `customer/agent/bot`, `content_type` no tiene un valor de evento, y hay un trigger `enforce_message_sender_identity`. Insertar ahí un pedido arrastraría contador de no leídos, vista previa de la lista y cualquier lógica que reaccione a mensajes. No he trazado todas esas rutas porque no hace falta si no se usa esa tabla.
5. **Notificaciones.** `notifications.type` está restringido a `'conversation_assigned'` (CHECK en la base). Hoy la única notificación del flujo es el `toast` al confirmar, que no se guarda. No existe aviso persistente del resultado de la entrega.
6. **El estado `held`** significa «confirmado en WACRM, nunca se enviará automáticamente». Hay que presentarlo así y no como «pendiente», para no prometer un envío que no ocurrirá.

## 3. Propuesta

### Principios
- Reutilizar `order_confirmations`. **Sin migración de campos de autoría** (ya existen).
- Solo lectura: la sección no cambia estados, no reenvía, no toca `delivery_status`, no manda WhatsApp ni dispara automatizaciones.
- El botón «Confirmar pedido» y el diálogo quedan intactos.

### Lectura
Nueva ruta `GET /api/orders/history?conversation_id=<uuid>` (rol `agent`, cuenta tomada de la sesión, `confirm_enabled` obligatorio, `limit` 50 con cursor por `confirmed_at`). Usa el cliente de sesión, así que la RLS se aplica dos veces (filtro explícito por cuenta más política). Devuelve una lista blanca de columnas: `id, confirmed_at, product, quantity, price, confirmed_by_name, seller_name, delivery_status, sent_at, acknowledged_at, attempts`. No devuelve `dni`, `phone`, `customer_name` ni `last_error_code` en la lista; el detalle muestra un motivo ya traducido a una etiqueta.

Se filtra por `conversation_id`. Los pedidos cuya conversación se borró (`conversation_id` queda `NULL`) se encuentran por `contact_id`; propongo filtrar por contacto de la conversación para no perderlos.

### Estados visuales
| `delivery_status` | Etiqueta | Tono |
|---|---|---|
| `held` | «Confirmado en WACRM · envío a InkaClick no activado» | neutro (gris) |
| `pending` / `sending` | «Pendiente de envío» / «Enviando…» | ámbar |
| `sent` | «Enviado · verificando recepción» | azul |
| `acknowledged` | «Recibido en InkaClick» + fecha | verde |
| `failed` | «InkaClick lo rechazó · requiere revisión» | rojo |
| `dead` | «Reintentos agotados · requiere revisión» | rojo |

Así «confirmado en WACRM» (siempre verdadero) queda separado de «recibido en InkaClick» (solo con `acknowledged`).

### Propuesta visual (columna derecha, 280 px)
Debajo del botón «Confirmar pedido» y antes de «Teléfono»:

```
[ Confirmar pedido ]
Pedidos confirmados (3)                    ⟳
┌──────────────────────────────────────┐
│ Prensa de banco SAFARI               │
│ 1 u. · S/ 110.00                     │
│ ● Confirmado en WACRM · no enviado   │
│ 31 oct 2026, 11:24 (Lima)            │
└──────────────────────────────────────┘
┌──────────────────────────────────────┐
│ PRUEBA WACRM E2E - NO DESPACHAR      │
│ 1 u. · S/ 1.00                       │
│ ● Recibido en InkaClick              │
│ 31 oct 2026, 19:41 (Lima)        ›   │
└──────────────────────────────────────┘
```
Cada tarjeta abre un detalle (diálogo, como el de confirmación): confirmó, vendedor, fecha de confirmación, fecha de envío, fecha de reconocimiento, intentos, y el identificador con botón «Copiar» (el mismo uuid que InkaClick guarda como `external_order_id`). Estado vacío: «Aún no hay pedidos confirmados en esta conversación». Estado de error de carga: mensaje discreto con «Reintentar», sin ocultar el botón de confirmar. La sección entera no se renderiza si `confirm_enabled` está apagado o el usuario no es agente.

### Actualización de estado
Versión 1, **sin migración**: sondeo cada 30 s mientras la pestaña está visible y la conversación abierta, más recarga inmediata al cerrar el diálogo de confirmación (el POST ya devuelve el `order_id`). Versión 2, opcional: añadir `order_confirmations` a `supabase_realtime`. Es aditivo, pero es un cambio de base productiva que requeriría su propia autorización.

### Historial dentro del chat
Recomiendo **no** insertar mensajes en `messages` en esta etapa. Si se quiere una marca en la línea de tiempo (por ejemplo «Pedido confirmado por Keyler»), la opción segura es una tabla aparte `conversation_events` (aditiva), que el hilo intercala por fecha como un separador visual. No envía nada y no pasa por ningún trigger de mensajes. Queda como fase 2 y no es necesaria para el panel.

## 4. Salvedades que conviene decidir

1. **«Fecha de recepción en InkaClick».** WACRM no guarda la hora a la que InkaClick creó el pedido. Tiene `sent_at` (respuesta 201, que es el momento real de la recepción) y `acknowledged_at` (cuando WACRM lo *verificó*). En el pedido E2E, la diferencia es de unos 4 minutos (00:57:47 frente a 01:01:49 UTC) porque la verificación fue manual. Propongo mostrar «Enviado: `sent_at`» y «Confirmado por InkaClick: `acknowledged_at`», y no inventar un tercer dato. Con el cron real la diferencia será de segundos o minutos.
2. **Pedido E2E.** Se puede mostrar tal cual: tiene autor, vendedor, importe, 1 intento, 201 y `acknowledged`. WACRM **no** sabe que en InkaClick está marcado `is_test` (esa marca vive solo allí y no se desarrolla ahora, como indicaste). La tarjeta lo identifica por su texto «PRUEBA WACRM E2E - NO DESPACHAR». Los dos `held` se muestran como «no enviado»; sus datos históricos están completos, sin campos que inventar.
3. **Visibilidad por rol.** Si se quisiera que los `viewer` lo vean, hay que ampliar la política (cambio de base). No lo propongo.

## 5. Archivos afectados (previstos)

Nuevos:
- `src/app/api/orders/history/route.ts` y `route.test.ts`
- `src/lib/orders/history.ts` (etiquetas, formato Lima, lista blanca) y `history.test.ts`
- `src/components/orders/order-history.tsx`, `order-history-detail.tsx` y sus tests

Modificados:
- `src/components/inbox/contact-sidebar.tsx` (montar la sección tras `ConfirmOrderButton`, misma condición `canSendMessages`)
- `messages/es.json`, `en.json`, `ko.json` (bloque `Orders`: etiquetas y textos)
- `src/components/inbox/contact-sidebar.test.tsx`
- `docs/integrations/inkaclick-orders/` (este documento y el runbook de despliegue)

Sin cambios: `confirm-order-*`, `outbox.ts`, `payload.ts`, el cron, todas las migraciones, InkaClick y ManyChat.

## 6. Pruebas necesarias

Unitarias (Vitest):
- Etiquetas y tono por cada `delivery_status` (7 casos) y que `held` nunca diga «pendiente».
- Formato de fecha: instante UTC cercano a medianoche (p. ej. 2026-11-01 03:30 UTC es el 31 oct 22:30 en Lima); no depende de la zona del navegador.
- Importe con dos decimales, cantidad, nombre largo, producto con HTML (se muestra como texto).
- Autor ausente (`confirmed_by` nulo tras borrar al usuario): se usa el nombre congelado.

Ruta (Vitest, con la misma simulación de sesión de las rutas actuales):
- 401 sin sesión; 403 para `viewer`; `confirm_enabled` apagado → lista vacía con `enabled: false`.
- La cuenta sale de la sesión: un `conversation_id` de otra cuenta devuelve vacío, no 403 ni datos.
- Lista blanca: la respuesta no contiene `dni`, `phone` ni `last_error_code`.
- Orden descendente y paginación.

Base aislada (la misma pila desechable de `e2e.integration.test.ts`, solo datos sintéticos):
- **Dos cuentas:** el agente de A no ve pedidos de B por la API ni por consulta directa con su JWT (RLS).
- Varios pedidos en la misma conversación se listan todos.
- Pedido tras borrar conversación y tras borrar al autor.
- El historial refleja la transición `held`/`pending` → `sent` → `acknowledged` sin recargar la página (sondeo).
- Comprobación negativa: tras renderizar y sondear, `messages`, `notifications`, `order_confirmations` y las entregas no cambian, y no hay llamadas a WhatsApp ni al receptor.

Interfaz (Playwright sobre datos sintéticos, como el QA del frontend de InkaClick): panel con 0, 1 y 6 pedidos; los 7 estados; ancho de 280 px sin desbordes; los temas de acento (la app tiene una sola paleta oscura, no hay modo claro); detalle y copia del identificador; estado de error con reintento; el botón «Confirmar pedido» sigue abriendo el diálogo; cuenta con `confirm_enabled` apagado sin sección.

## 7. Plan de despliegue

1. Implementar en una rama nueva desde `codex/orders-receiver-e2e`, con la suite y el QA de interfaz en verde. Nada se despliega.
2. La versión 1 **no necesita migración**: solo imagen de la aplicación. Rollback = volver a la imagen anterior (`wacrm-app:orders-1246621b`); la base no cambia.
3. Antes de construir la imagen, recordar la divergencia de producción ya anotada: la imagen productiva sale de la pila sin fusionar (`1343ea65`), no de `main`; hay que integrar sobre esa base y probarla.
4. Con tu autorización: respaldo de la base, construcción de la imagen, guardado de la imagen previa con `docker save`, reinicio de `wacrm-app`, y verificación con los tres pedidos reales como solo lectura. Sin crear pedidos, sin activar el cron, sin liberar los `held`.
5. Solo después, la activación automática de la entrega, que es la etapa siguiente que indicaste.

## 8. Restricciones respetadas en esta etapa

Sin cron, sin liberar los dos `held`, sin pedidos nuevos, sin cambios en InkaClick productivo, sin fusiones, sin despliegue, y sin trabajo adicional sobre `is_test` ni sobre pruebas de duplicados.

## 9. Resultado del QA (rama `codex/order-history-panel`)

| Prueba | Cómo se ejecuta | Resultado |
|---|---|---|
| Vitest: librería, ruta, panel, barra lateral, mensajes | `npx vitest run` | 3256 pasan, 134 omitidas (E2E con Docker) |
| Aislamiento entre cuentas y RLS, sobre una base desechable (sin red, esquema de producción sin filas, datos sintéticos) | `WACRM_SCHEMA_DUMP=… scripts/qa/orders-history/run.sh` | 23 aserciones PASS |
| QA visual en Chromium sobre los componentes reales (dos temas de acento, columna de 280 px) | `scripts/qa/orders-history/visual/` | 48 de 48 PASS |

Lo que cubre la base desechable: un agente de A ve sus 3 pedidos y nada de B (con y sin filtro de cuenta); B no ve A; un `viewer`, un usuario de otra cuenta y una sesión vacía ven 0; ningún agente puede insertar, actualizar, borrar ni llamar a `create_order_confirmation`; los pedidos sobreviven al borrado de la conversación (se encuentran por el contacto) y al del autor (queda el nombre congelado); no se crea ningún mensaje, notificación ni intento de entrega.
Lo que cubre el QA visual: vacío, uno, seis, los siete estados, 50+, error y función apagada; autor y vendedor por separado; fechas de Lima; la tarjeta `held` nunca dice «pendiente» y solo `acknowledged` dice «Recibido en InkaClick»; sin desbordes horizontales con un nombre de producto largo; el detalle se abre con el teclado y el botón «Confirmar pedido» sigue abriendo su diálogo; todas las peticiones son GET.
El QA visual encontró un defecto real (el identificador se partía en ocho líneas en un diálogo estrecho) y quedó corregido.

Límites: el entorno de pruebas tiene el ACL de `authenticated` con más privilegios que producción (allí es solo SELECT); en las pruebas la escritura la frena la RLS (0 filas), en producción ya falla por privilegio. Tampoco sustituye mirar la sesión real tras un despliegue autorizado.
