# P0 parity InkaClick → WACRM: saldo, variantes de plantilla y voucher Shalom (LOCAL)

Rama `feat/p0-parity-balance-voucher` (base `a21eaac`). **Solo local**: sin deploy, sin push, sin Meta real, sin activar Shalom, sin tocar InkaClick,
sin crear plantillas en Meta, sin migrar ni alterar pedidos históricos, sin cargar valores reales de pago.

Migraciones nuevas (aditivas, idempotentes, `patch_migrations` en el manifiesto, estado `pending`):
`20261205000002_balance_templates_and_payment_instructions.sql` y `20261205000003_shipment_voucher_message.sql`.

## 1. Variable `pending_balance`

- Fuente única: PR-06 (`order_financials`). `pending_balance = precio − pagado confirmado`, nunca negativo. Nunca viene de InkaClick para pedidos nuevos.
- Formato: `S/ 150.00` (`formatSoles`).
- Pedido **tracked** → saldo real confirmado (0 si está pagado). Pedido **not_tracked** (sin fila financiera) → la variable **no está disponible**: el envío
  se rechaza (`pending_balance_unavailable`); jamás se convierte en `S/ 0`.
- Código: `src/lib/orders/payments/balance.ts` (`resolveOrderBalance`) y `src/lib/orders/logistics/template-params.ts`.

## 2. Embalaje (PR-04)

| Caso | Plantilla |
| --- | --- |
| Saldo = 0 (pagado) | `pedido_embalado_listo` (existente, sin cambios) |
| Saldo > 0 | `pedido_embalado_listo_saldo` (header IMAGE; nombre, producto, destino, `pending_balance`; sin DNI; evidencia/foto en la misma conversación) |
| not_tracked | rechazado (`pending_balance_unavailable`), nada se envía |

Opt-in por cuenta: columnas `order_logistics_settings.packaging_balance_template_*`. Sin variante de saldo configurada, el comportamiento anterior no cambia.

## 3. Llegada a destino (aviso inmediato)

| Caso | Plantilla |
| --- | --- |
| Saldo = 0 | `pedido_llegada_destino` (existente) |
| Saldo > 0 | `pedido_llegada_destino_saldo` (nombre, producto, destino, `pending_balance`, instrucciones de pago configurables) |
| not_tracked | **no se envía nada automáticamente** (ver §6) |

Opt-in: `order_shipment_settings.arrival_balance_template_*`. La variante se decide en el momento del envío (el saldo puede haber cambiado desde el encolado) y se
registra en la fila del ledger. Los errores `pending_balance_unavailable` / `payment_instructions_not_configured` no se reintentan solos.

## 4. Instrucciones de pago (por cuenta)

`order_payment_settings.customer_payment_instructions`: una línea ≤ 200 caracteres, sin saltos ni caracteres de control, configurable por cuenta en servidor.
No hay datos bancarios en código ni en migraciones; no se cargó ningún valor real. Si falta y la plantilla las pide → `payment_instructions_not_configured`.

## 5. Voucher Shalom (`voucher_envio_shalom`, UTILITY, header DOCUMENT)

- **Envío manual** por Logística o Supervisor (Comercial, viewer y otras cuentas bloqueados). Nunca lo envía el tick ni el sender automático.
- Mismo `conversation_id` del pedido; el voucher PDF validado de PR-04 va como header DOCUMENT (URL firmada de 10 min del bucket privado).
- Variables: nombre, número Shalom, código Shalom, destino. **Nunca** el DNI ni el saldo.
- Ledger propio `order_shipment_voucher_messages`, `UNIQUE (order_id, identifier_version)` → **máximo un aviso por guía**. Una guía corregida es un aviso nuevo.
- Doble clic / concurrencia: un solo envío (claim atómico). `sent` es final.
- `failed` (rechazo claro, o fallo antes de Meta): visible, **sin reintento automático**; solo una persona reintenta (`retry_voucher`).
- `uncertain` (resultado desconocido): **nunca se reenvía solo**; una persona resuelve (`confirmed_sent` / `confirmed_not_sent`) y recién entonces puede reintentar.
- Requiere `destination_customer_message_enabled`, flag Shalom de la cuenta y plantilla configurada (`order_shipment_settings.voucher_message_template_*`).
- API: `POST /api/orders/shalom/orders/[orderId]` acciones `send_voucher`, `retry_voucher`, `resolve_voucher`. UI: fila "Voucher al cliente" en Tracking Shalom.

## 6. Comportamiento `not_tracked` / pedidos históricos

Los pedidos históricos (1012+) no tienen fila financiera. Regla: **nunca se asume saldo 0, no se envía nada automático, se trata como caso con estrategia de transición**.
Opciones documentadas (**no elegidas ni ejecutadas**; decisión del negocio):

- **A.** Seguir operando temporalmente esos pedidos en InkaClick hasta que se cierren.
- **B.** Registrar el saldo manualmente en WACRM al momento del cutover (pago/saldo por pedido).
- **C.** Comunicar al cliente sin saldo (plantilla sin variable de saldo), asumiendo que se pierde el recordatorio de cobro.

## 7. OCR de vouchers — DECISIÓN P0 pendiente

~62 vouchers/día hoy se leen a mano. No se integró ningún proveedor OCR. Decidir: proveedor / modelo de costo / validación humana. **No bloquea** los demás P0
(el voucher se envía y valida manualmente como en InkaClick).

## 8. Bloqueador separado: número antiguo +51 963 465 690

Recibe respuestas reales de clientes y no se puede apagar sin una estrategia de transición (redirección/atención del número viejo, mensaje de cambio, ventana de convivencia).
No se tocó ni se migró ningún número/WABA. Es dependencia del cutover, independiente de este código.

## 9. Plantillas Meta adicionales a crear (aún NO creadas)

Se mantienen sin cambios las 3 existentes (PENDING): `pedido_embalado_listo`, `pedido_llegada_destino`, `recordatorio_recojo_pedido`.

| Plantilla | Cat. | Header | Variables (orden) |
| --- | --- | --- | --- |
| `pedido_embalado_listo_saldo` | UTILITY | IMAGE | `customer_name`, `product`, `destination`, `pending_balance` |
| `pedido_llegada_destino_saldo` | UTILITY | — | `customer_name`, `product`, `destination`, `pending_balance`, `payment_instructions` |
| `voucher_envio_shalom` | UTILITY | DOCUMENT | `customer_name`, `shalom_number`, `shalom_code`, `destination` |

Luego de aprobarlas: configurar `*_balance_template_*`, `voucher_message_template_*` y `customer_payment_instructions` por cuenta (SQL/Settings), sin deploy de código adicional.

## 10. Dependencias antes del cutover

Aprobación Meta de las 3 plantillas nuevas y de las 3 PENDING; carga de instrucciones de pago; decisión §6 (A/B/C) y §7 (OCR); estrategia del número antiguo (§8);
deploy controlado de las 2 migraciones; rotación del CRON_SECRET de InkaClick (acción de seguridad pendiente, separada).
