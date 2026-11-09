# WACRM: razones de fallos de entrega (P1) — PR de diagnóstico

## Alcance
- Cuando Meta envía `statuses[].status=failed`, guardar solamente `errors[].code` (entero) y `errors[].title` (máx. 160 caracteres; números de 7 o más dígitos ocultos).
- Guardar exclusivamente en mensajes salientes de la cuenta y que ya tengan `status=failed`. No escribir el cuerpo del mensaje, teléfono, `message`, `error_data` ni payload íntegro.
- Mostrar el motivo en tooltip de la X roja en Inbox; no cambiar el comportamiento de envío, Flows o pedidos.
- La persistencia del motivo es best-effort: si falla, el estado `failed` continúa aplicándose.
- Los eventos pasados no tienen backfill: no es posible recuperar la razón de Keyler del historial anterior.

## Despliegue y verificación
1. Comprobar base `main`, commit e imagen productiva. Hacer respaldo y ensayo en copia aislada, con lock timeout.
2. Aplicar la migración aditiva `20261113000000_whatsapp_delivery_failure_reason.sql` ANTES de actualizar la imagen.
3. Ejecutar tests, `tsc`, `eslint`, QA SQL de aislamiento por cuenta y permisos `service_role`.
4. Desplegar imagen controlada y medir postchecks T0/T10/T30 para mensajes entrantes/salientes, Flows, pedidos, BSUID y estados.
5. En una **nueva** falla real de Meta comprobar el código/título del webhook y que el mensaje permanezca `failed`, sin reintentos ni cambios de estado. No provocar fallos reales artificiales.
6. Rollback de imagen: desactivar código nuevo; columnas/función aditivas pueden permanecer. Evitar DROP de columnas con datos nuevos.

## No resuelve el P0 de pérdida de mensajes entrantes
El webhook actual devuelve HTTP 200 antes de completar `processWebhook` en `after()`. Una caída posterior de Postgres puede dejar el mensaje sin persistir. El P0 debe ir en **PR separado** con inbox duradero transaccional, idempotencia y recuperación; no basta reemplazar 200 por 500.
