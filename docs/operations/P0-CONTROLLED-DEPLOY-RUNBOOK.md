# Runbook: deploy controlado P0 (paridad InkaClick) — PREPARADO, NO EJECUTADO

Alcance: llevar a producción (cuenta de Keyler `4d04a2e0-62b8-4508-a046-4b125aa2e8db`) el código de `feat/p0-parity-balance-voucher` (HEAD `4e1b7b8` o el SHA exacto que se autorice) **con todo apagado**:
variantes con saldo, aviso de llegada, aviso de voucher manual y OCR Gemini quedan **inertes** hasta pasos de configuración posteriores y separados. Nada de esto apaga o toca InkaClick.

Estado de producción verificado (solo lectura): imagen `wacrm-app:shalom-provider-38ecdc51`; migraciones aplicadas hasta `20261205000000`; `logistics_mvp_enabled` y `order_payments_enabled` activos para Keyler; **sin** fila en `order_shipment_settings`
(Shalom OFF), **sin** fila en `order_logistics_settings` (plantilla de embalaje sin configurar); sin variables `ORDER_OCR_*`; variables `SHALOM_*` presentes pero sin `SHALOM_TRACKING_ENABLED`; sin cron de Shalom (solo el cron de retorno a Comercial);
0 envíos / 0 ledgers de plantillas; `message_templates` de la cuenta tiene solo 2 plantillas (última sincronización 2026-11-01): **las 6 plantillas aprobadas todavía no están en la tabla** (paso F).

## 0. Prerrequisitos (antes de la ventana)
- SHA exacto autorizado, árbol limpio, `git archive` LF (como en el deploy anterior), `migration-ledger verify` OK, suite focal + `tsc` + `eslint` + `build` verdes (regresión conocida: solo los 7 fallos históricos).
- Autorización explícita del usuario para: deploy, migraciones, sincronizar plantillas. Las instrucciones de pago reales y la activación de flags **no** forman parte de este deploy.

## A. Backup (solo lectura sobre producción)
1. `pg_dump` de las tablas operativas afectadas y del esquema `public` (esquema + `order_*`, `message_templates`, `whatsapp_config`) a `/opt/backups/wacrm/p0-predeploy-<ts>/` con `SHA256SUMS`.
2. Copia de `/opt/apps/wacrm/.env.local` (modo 0600) y de `deploy-state/last.env`.
3. `ROLLBACK.md` del release (patrón de `shalom-provider-predeploy-*`): imagen anterior `wacrm-app:shalom-provider-38ecdc51`, migraciones aplicadas, estado de flags.
4. Espacio en disco verificado (55 GB libres al momento de la auditoría).

## B. Precheck (solo lectura)
- `deploy.sh <imagen>` en **DRY-RUN** (sin `--execute`).
- Verificar: contenedor vivo `wacrm-app-1`; `GET /api/health/ready` 200; ledger `.applied` = hasta `20261205000000`; sin deploy en curso (lock).
- Confirmar `ORDER_OCR_*` ausentes y que ningún cron de Shalom existe (`crontab`, `/etc/cron.d`).
- Confirmar flags de Keyler: `logistics_mvp_enabled=true`, `order_payments_enabled=true`, y que `order_shipment_settings` sigue sin fila.

## C. Migraciones (orden exacto, una por una, con ledger)
| # | Migración | Depende de | Qué hace | ¿Escribe datos históricos? |
|---|---|---|---|---|
| 1 | `20261205000001_shipment_arrival_message` | `...014`, `...015` | columnas `arrival_message_template_*`, nuevo `kind destination_arrival_customer`, trigger `order_shipments_arrival` | No |
| 2 | `20261205000002_balance_templates_and_payment_instructions` | `...003`, `...009`, `...018`, `...0001` | columnas nullable `packaging_balance_template_*`, `arrival_balance_template_*`, `customer_payment_instructions` | No |
| 3 | `20261205000003_shipment_voucher_message` | `...003`, `...009`, `...010`, `...0001` | columnas `voucher_message_template_*`, tabla `order_shipment_voucher_messages` (vacía), RPCs service-role | No |

Todas aditivas e idempotentes (solo `ADD COLUMN IF NOT EXISTS`, tabla nueva y reemplazo de CHECK por uno ampliado; ningún `INSERT/UPDATE/DELETE` de datos; tests estáticos lo verifican). El trigger `order_shipments_arrival` es inerte salvo que existan los 3 flags
(logistics + shalom_tracking + destination_customer_message_enabled) **y** una plantilla de llegada configurada. Aplicar con el mismo mecanismo del deploy anterior (`.applied` por archivo, sha256 contra el manifiesto), detenerse ante el primer error.
Verificación posterior: las 3 entradas `.applied`; `\d order_shipment_voucher_messages` existe y está vacía; columnas nuevas nullable en NULL.

## D. Deploy de la app
1. Construir la imagen en el VPS desde `git archive` del SHA exacto (LF), etiqueta `wacrm-app:p0-parity-<sha8>`.
2. `deploy.sh --execute wacrm-app:p0-parity-<sha8>` (blue/green; el contenedor anterior queda detenido para rollback).
3. Health: `/api/health/ready` 200 en el nuevo; revisar logs sin errores de arranque.

## E. Variables OCR (paso separado y posterior; NO en esta ventana salvo autorización específica)
- Estado de partida: sin `ORDER_OCR_*` ⇒ `not_configured` ⇒ captura/revisión manual (comportamiento actual).
- Para activarlo (más adelante): `ORDER_OCR_PROVIDER=gemini`, `ORDER_OCR_API_KEY=<key de facturación activa>`, `ORDER_OCR_MODEL=gemini-3.5-flash-lite` en `/opt/apps/wacrm/.env.local` (0600), nunca en git ni en BD; reinicio del contenedor por `deploy.sh`.
- Precondiciones: cierre del piloto con vouchers reales, contrato de datos/retención revisado, política de privacidad actualizada. Siempre: la validación del voucher es una acción de Logística/Supervisor; la confianza < 0.90 se resalta como dudosa
  (hoy la pantalla muestra el porcentaje por campo; resaltar < 0.90 es una mejora pendiente) y la auto-asociación masiva exige DNI y teléfono con confianza ≥ 0.80.

## F. Configurar plantillas (SQL/Settings por cuenta; sin enviar nada)
0. **Sincronizar plantillas desde Meta** (botón/ruta `POST /api/whatsapp/templates/sync`, lectura de Meta → escribe `message_templates`): verificar que las 6 queden `APPROVED` con `header_type` correcto (IMAGE: `pedido_embalado_listo`, `pedido_embalado_listo_saldo`; DOCUMENT: `voucher_envio_shalom`; resto sin header).
1. `order_logistics_settings` (fila nueva para la cuenta):
   - `packaging_template_name='pedido_embalado_listo'`, `packaging_template_language='es'`, `packaging_template_params=["customer_name","product","destination"]`
   - `packaging_balance_template_name='pedido_embalado_listo_saldo'`, `..._language='es'`, `..._params=["customer_name","product","destination","pending_balance"]`
2. `order_shipment_settings` (fila nueva; **`shalom_tracking_enabled=false` y `destination_customer_message_enabled=false`**):
   - `arrival_message_template_name='pedido_llegada_destino'`, `es`, `["customer_name","product","destination"]`
   - `arrival_balance_template_name='pedido_llegada_destino_saldo'`, `es`, `["customer_name","product","destination","pending_balance","payment_instructions"]`
   - `customer_message_template_name='recordatorio_recojo_pedido'` (día 15), `es`, `["customer_name","product","destination"]`
   - `voucher_message_template_name='voucher_envio_shalom'`, `es`, `["customer_name","shalom_number","shalom_code","destination"]`
3. Nada se activa: la configuración de plantillas sin flags no envía nada.

## G. Instrucciones de pago (autorización específica, separada)
`order_payment_settings.customer_payment_instructions`: una línea ≤ 200 caracteres, sin saltos ni caracteres de control, no vacía; se carga por SQL/Settings con el texto aprobado por el negocio. No se carga en este deploy. Mientras esté vacía, el aviso de llegada con saldo falla **antes de Meta**
(`payment_instructions_not_configured`, sin reintento automático) y el embalaje con saldo no se ve afectado (no usa instrucciones).

## H. Health checks
`/api/health/ready` 200; logs del contenedor sin errores; crons de host intactos (retorno a Comercial); `SELECT` de las 3 migraciones aplicadas; conteo de pedidos/ledgers sin cambios (0 envíos, 0 ledger rows); flags de Keyler idénticos a los previos.

## I. Smoke tests (sin WhatsApp real)
1. Login y panel de pedidos; ver un pedido **tracked** (saldo visible) y uno histórico (**not_tracked**: sin saldo, sin avisos).
2. Con Shalom OFF: la sección Shalom de un pedido no aparece / responde `feature_disabled` (esperado).
3. `POST .../documents/<id>/ocr` sobre un voucher de prueba devuelve `ocr_not_configured` y la UI cae a captura manual.
4. Confirmar en `order_template_dispatches` / `order_shipment_messages` / `order_shipment_voucher_messages` que siguen en 0 filas.
5. Ningún mensaje saliente nuevo en `messages` desde el deploy.

## J. Rollback
- **App**: `ops/deploy/rollback.sh` (DRY-RUN y luego `--execute`): vuelve al contenedor anterior (`shalom-provider-38ecdc51`) sin downtime. El esquema nuevo es aditivo y compatible con la app anterior (columnas nullable, tabla vacía, trigger inerte), por lo que **no hace falta revertir la BD** para volver atrás.
- **BD (solo si hay que quitar lo nuevo; sin datos en las tablas nuevas)**, en una transacción, en este orden:
  - `DROP TRIGGER IF EXISTS order_shipments_arrival ON public.order_shipments; DROP FUNCTION IF EXISTS public.order_shipments_arrival_message();`
  - `DROP TABLE IF EXISTS public.order_shipment_voucher_messages CASCADE;` y `DROP FUNCTION IF EXISTS public.{begin,mark_sending→mark_shipment_voucher_sending,finish,retry,resolve}_shipment_voucher_message(...)`.
  - `ALTER TABLE public.order_shipment_settings DROP COLUMN IF EXISTS arrival_message_template_*, arrival_balance_template_*, voucher_message_template_*;`
  - `ALTER TABLE public.order_logistics_settings DROP COLUMN IF EXISTS packaging_balance_template_*;` y `ALTER TABLE public.order_payment_settings DROP COLUMN IF EXISTS customer_payment_instructions;`
  - Los CHECK ampliados (`order_shipment_messages_kind_check`, `order_shipment_events_type_check`) se pueden dejar: son más permisivos y no afectan a la app anterior.
  - Retirar las entradas `.applied` correspondientes. Este SQL debe **probarse en la BD local** antes de la ventana.
- **Configuración**: volver a vaciar las filas de settings de plantillas; `ORDER_OCR_*` fuera del `.env.local` y reinicio.
- **Restauración completa**: solo con el dump del paso A, como último recurso.

## Qué queda APAGADO tras el deploy
`shalom_tracking_enabled`, `destination_customer_message_enabled`, polling/cron de Shalom, `SHALOM_TRACKING_ENABLED`, aviso de llegada, recordatorio día 15, voucher manual, OCR (`ORDER_OCR_*` ausentes), instrucciones de pago vacías, todo el comportamiento automático nuevo. Sin cutover y sin cambios en InkaClick.

## Coexistencia con InkaClick y riesgo de duplicados
Siguen activos en InkaClick (no apagar): `sync-shalom-statuses` (cron cada 15 min), `notify-destination-vouchers` (cada 30 min), `wacrm-confirmed-orders`, `whatsapp-webhook`, las funciones de envío y la operación manual.
Riesgo de **mensajes duplicados** si un mismo pedido recibe aviso desde ambos sistemas (p. ej. llegada a destino por InkaClick y por WACRM, o embalaje enviado desde ambos): se evita manteniendo OFF en WACRM los avisos automáticos y de llegada hasta la ventana de cutover y usando WACRM solo para pedidos nuevos
(estrategia A), y, para los pedidos que sí se operen en WACRM, no enviarles el mismo aviso desde InkaClick.
