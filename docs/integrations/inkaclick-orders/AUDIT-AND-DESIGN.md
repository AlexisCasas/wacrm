# WACRM → InkaClick: pedidos confirmados (auditoría y diseño)

Estado: borrador para conformidad. Sin migraciones, sin despliegue, sin envíos reales.
Auditoría de solo lectura del 2026-10-31 (Supabase `sbbxcunexmjxtzdelypv` y VPS WACRM).

## A. Auditoría de arquitectura real

### Lo que NO se pudo verificar
- El código del receptor `/api/webhooks/manychat/confirmed-orders` (Vercel `inkaclick-api`) **no está** en el repo `InkaClick-Saas` (solo un front Vite con datos de ejemplo, sin `supabase/`), ni en la VPS, ni en las 9 edge functions desplegadas. Su contrato (validaciones, auth, parseo) se infiere de los datos, no del código.

### InkaClick (Supabase `sbbxcunexmjxtzdelypv`)
- `confirmed_orders`: 4.054 filas, todas `source='manychat'`, `agencia='Shalom'`. RLS activa; escritura solo con service role (el receptor).
- `manychat_webhook_events`: 4.416 eventos, todos `processed`, `token_valid=true`, `request_headers` siempre nulo. 426 eventos sin pedido (duplicados ignorados), 1 pedido con 2 eventos.
- Payload ManyChat: 26 claves, **todas string** (incluidas `precio` y `cantidad_productos`), con `fecha`, `fecha_hora`, `manychat_contact_id`, `switch_*`, etc.
- `idempotency_key` del evento = SHA-256 hex de 64 caracteres. `duplicate_key` del pedido = `<prefijo>_<manychat_contact_id>_<fecha_hora ISO -05:00>` (36–39 caracteres). Índice **no único**; 0 grupos duplicados en 4.020 filas con clave (34 filas sin clave). Depende del ID de contacto de ManyChat: no sirve tal cual para WACRM.
- `fecha_registro` es nulo en las 4.054 filas; la fecha real vive en `fecha_text`/`fecha_hora_text` (texto) y `created_at`.
- Triggers sobre `confirmed_orders` (afectan a cualquier INSERT de WACRM):
  - `recalculate_confirmed_order_payments`: `pago_restante = precio - pago_inicial` → **`precio` es el TOTAL del pedido**, no unitario. Si `pago_restante = 0` fuerza `estado_pedido='Pagado'`. Un `precio = 0` marcaría el pedido como pagado (existe al menos un `precio` 0,00).
  - `sync_confirmed_order_paid_status`: pone `'pagado'` en minúscula. Estados reales hoy: `procesado` 4.004, `pagado` 37, `Pedido confirmado` 13.
  - `sync_confirmed_orders_telefono_normalized`: normaliza a `51XXXXXXXXX`.
  - `sync_customer_from_confirmed_order` (SECURITY DEFINER): crea/actualiza `customers` solo si el teléfono normalizado cumple `^51[0-9]{9}$`; el DNI solo si tiene 8 dígitos.
- Procesos posteriores: no hay trigger ni cron que envíe WhatsApp al insertar. `send-confirmed-order-whatsapp` lo dispara el operador desde la UI de InkaClick (imagen de embalaje + plantilla) y cambia `estado_pedido` a `procesado`/`pagado`. Los crons (`notify-destination-vouchers`, `sync-shalom-statuses`) actúan sobre vouchers y Shalom. **Un pedido de WACRM no envía mensajes al cliente al crearse.**
- Fuera de alcance y sin tocar: ManyChat, el webhook actual, columnas de productos adicionales, pagos y logística.

### Perfil de datos (aprobación de campos obligatorios)
| Campo | Evidencia en 4.054 pedidos | Propuesta |
|---|---|---|
| DNI | 15 vacíos (0,4 %), 116 con formato no de 8 dígitos (2,9 %) | Opcional, con aviso |
| Departamento | No existe en InkaClick | Opcional |
| Destino | 5 vacíos (0,1 %), 1.997 valores distintos | Obligatorio, texto libre |
| Vendedor | 3.386 nulos (83 %); valores: Lindey, Nando, Keyler Ortega, Jhon | Obligatorio en WACRM, selector |
| Cantidad | 34 nulos; 3.979 son 1 | Obligatoria, entero ≥ 1 |
| Precio | 0 nulos; máx. 2.100,00; media 151,48 | Obligatorio, > 0, `numeric(12,2)` |
| Producto | 829 valores distintos (multilínea) | Obligatorio, texto libre con sugerencias |
| Descripción | `descripcion_pedido_url`: 2.108 texto libre (media 22 car.), 1.244 URL, 702 vacíos | Reutilizar la columna; ya admite texto libre |
| Teléfono | 3.883 `51+9`, 126 de 9 dígitos, 44 otros | Texto, validar a `51XXXXXXXXX` |

### WACRM (cuenta `keyler.ortega@unmsm.edu.pe`, `account_id = 4d04a2e0-62b8-4508-a046-4b125aa2e8db`)
- 5 contactos; campos existentes: `Producto`, `Precio`, `Destino` (todos `text`). Faltan DNI, Cantidad, Descripción de pedido, Agencia, Vendedor, Departamento. Un solo perfil en la cuenta.
- `custom_fields`/`contact_custom_values` guardan un único valor por contacto: no sirven como historial de ventas. `deals` (valor/moneda/asignado) no modela un pedido congelado.
- La cuenta operativa con tráfico real es otra (`c35b393f…`, corp.lortegdelperu): confirmar si el piloto es en la de Keyler.

## B. Mapeo de los 13 campos

| # | Campo | Origen en WACRM | Columna InkaClick | Notas |
|---|---|---|---|---|
| 1 | Fecha y hora | `now()` al confirmar, America/Lima | `fecha_hora_text` (ISO `-05:00`), `fecha_text`, `created_at` | Mismo formato que ManyChat; `fecha_registro` queda nula como hoy |
| 2 | Nombre completo | Contacto, editable | `nombre_completo` (+ `nombre`/`apellido` si se separan) | |
| 3 | DNI | Campo nuevo | `dni` | Normalización la hace el trigger |
| 4 | Teléfono | Contacto, como texto | `telefono` | Trigger normaliza |
| 5 | Producto | Campo `Producto` / formulario | `producto` | |
| 6 | Cantidad | Formulario | `cantidad_productos` | |
| 7 | Precio | Formulario, `numeric(12,2)` | `precio` | **Total**; JSON como string decimal |
| 8 | Descripción | Formulario | `descripcion_pedido_url` | Texto o URL |
| 9 | Agencia | Default Shalom | `agencia` | |
| 10 | Destino | Campo `Destino` existente | `destino` | |
| 11 | Vendedor | Selector | `vendedor` | Nombre comercial |
| 12 | Estado | Constante | `estado_pedido` = `Pedido confirmado` | |
| 13 | Departamento | Campo nuevo | **`departamento` (columna nueva, aditiva, nullable)** | |

Extras de trazabilidad (columnas nuevas, nullables, aditivas): `external_order_id`, `source='wacrm'`.

## C. Diseño de datos en WACRM (propuesta)
- `order_confirmations`: `id`, `account_id`, `contact_id`, `conversation_id`, `deal_id` (nulo, futuro F2), los 13 campos congelados, `confirmed_by` (+ snapshot de nombre, como F1), `seller_user_id` + `seller_name`, `confirmed_at`, `request_key` (token del formulario) con único `(account_id, request_key)`, `delivery_status`, `inkaclick_order_id`, `external_order_id` único.
- `order_confirmation_deliveries`: un intento por fila (`attempt`, `started_at`, `http_status`, `error_code`, texto de error sin datos personales, `next_attempt_at`).
- RLS por `account_id` en ambas; sin UPDATE directo de los campos congelados (trigger de inmutabilidad, igual que F1).
- Interruptor por cuenta (`integration enabled`) independiente; apagarlo detiene solo el envío, no los pedidos.

## D. Formulario «Confirmar pedido»
Inbox → botón → formulario precargado (contacto + campos personalizados) → validación → vista previa → confirmar. El botón se deshabilita tras el clic y el servidor deduplica por `request_key`.

## E. Receptor/emisor e idempotencia
- Recomendado: **edge function nueva `wacrm-confirmed-orders` en el Supabase de InkaClick**, con secreto propio (`WACRM_ORDERS_TOKEN`, comparación en tiempo constante), que llama a una función SQL idempotente. Motivo: el código del receptor Vercel no está localizado; la deduplicación queda en la base, independiente de la capa HTTP. No toca la ruta ManyChat.
- Migración aditiva en InkaClick (no aplicada): `external_order_id text`, `departamento text`, índice **único parcial** `(source, external_order_id) WHERE external_order_id IS NOT NULL`. `duplicate_key = 'wacrm_' || external_order_id` para no colisionar con ManyChat.
- Respuesta idempotente: mismo `external_order_id` → mismo `id` de InkaClick, sin segunda fila.
- Emisor (outbox): reclamo con `FOR UPDATE SKIP LOCKED`, backoff exponencial con tope y límite de intentos, timeout, solo 5xx/timeout/429 se reintentan, 4xx → `failed` revisable. HTTP 200 = `sent`; `acknowledged` solo tras reconciliación (consulta por `external_order_id`).
- Logs sin nombre, DNI ni teléfono completos.

## F. Convivencia y rollback
- ManyChat sigue intacto. El emisor WACRM se apaga con el interruptor; los pedidos ya confirmados no se alteran.
- Rollback del emisor: apagar interruptor (inmediato). Rollback de la migración InkaClick: columnas aditivas; basta dejar de usarlas.
- Rollback del número de WhatsApp: **no es instantáneo** (migración de número entre proveedores); se documenta aparte y no depende de este código.

## G. Decisiones pendientes (conformidad)
1. Ubicación del receptor: edge function nueva (recomendada) frente a ruta Vercel (requiere el código).
2. Cuenta del piloto: Keyler (5 contactos) o la operativa.
3. Obligatorios: DNI y Departamento opcionales; Destino y Vendedor obligatorios.
4. Catálogo de vendedores: Lindey, Nando, Keyler Ortega, Jhon (la cuenta tiene un solo perfil).
5. Reutilizar `descripcion_pedido_url` para texto libre.
6. Migración aditiva en InkaClick por quien administre ese proyecto.
