# PR-1 — Control de pedidos multiproducto exclusivo por cuenta (Keyler)

Estado: PR de preparación, **no desplegado**. La VPS de WACRM aloja la aplicación y su base operativa. InkaClick es un proyecto aparte y su receptor NO se modifica.

## Contratos que no se deben romper
- `confirm_enabled`: control existente para el botón "Confirmar pedido".
- `enabled`: control existente del outbox hacia InkaClick.
- `multiproduct_enabled`: NUEVO, `NOT NULL DEFAULT FALSE`, controla SOLO solicitudes con el campo JSON `items`.
- `items` ausente = camino antiguo. Se admiten pedidos tradicionales sin tocar `multiproduct_enabled`.
- `items` presente = requiere habilitación en la API y en la función SQL, siempre por `account_id` de sesión / `p_account`.
- Ningún otro proyecto Supabase, flujo de WhatsApp ni otra cuenta se activa con la migración.

## Secuencia de validación previa (Claude Code en VPS)
1. Confirmar versión desplegada, rama `main`, respaldo reciente, integridad de migraciones y estado de outbox; no ejecutar scripts de base sin aprobación.
2. Identificar el `account_id` real de **Keyler** cruzando `accounts`, `profiles` y la sesión de la cuenta. No deducirlo del correo de un usuario o de un texto visible.
3. Confirmar con consulta de solo lectura que las otras cuentas no tienen `multiproduct_enabled = TRUE`.
4. Aplicar la migración de PR-1 únicamente después de QA sobre una base aislada. La migración no habilita ninguna cuenta.
5. Probar con `multiproduct_enabled = FALSE`: pedido clásico funciona y `items` devuelve 403.
6. Probar sobre una cuenta de QA con habilitación explícita: pedido estructurado genera una cabecera y N líneas, una sola clave `request_key`, totales correctos.
7. Verificar que el outbox sigue enviando a InkaClick SOLO el payload actual (producto concatenado, cantidad total, precio total), sin `items` adicionales.
8. Antes de activar a Keyler, verificar que PR-2 (UI) y sus controles estén desplegados y que la cuenta de Keyler tenga `confirm_enabled` operativo.

## SQL de inspección (solo lectura; reemplazar la variable de psql)
```sql
-- keyler_account_id se suministra desde el cliente psql tras validar la identidad.
SELECT account_id, confirm_enabled, enabled, multiproduct_enabled
FROM public.order_integration_settings
WHERE account_id = :'keyler_account_id';

SELECT count(*) AS other_accounts_enabled
FROM public.order_integration_settings
WHERE multiproduct_enabled = TRUE
  AND account_id <> :'keyler_account_id';
-- Debe dar 0 para este despliegue exclusivo.
```

## Activación controlada y rollback
Este paso NO se ejecuta durante PR-1. Solo después de verificación humana del `account_id`, QA y despliegue completo:
```sql
BEGIN;
UPDATE public.order_integration_settings
   SET multiproduct_enabled = TRUE, updated_at = now()
 WHERE account_id = :'keyler_account_id'
   AND confirm_enabled = TRUE
   AND multiproduct_enabled = FALSE
RETURNING account_id, confirm_enabled, enabled, multiproduct_enabled;
-- Revisar que RETURNING muestre exactamente UNA fila y confirmar COMMIT.
ROLLBACK; -- En una inspección/prueba se mantiene ROLLBACK; COMMIT solo al activar de verdad.
```
Rollback de la característica sin afectar el envío/confirmación antiguos:
```sql
UPDATE public.order_integration_settings
   SET multiproduct_enabled = FALSE, updated_at = now()
 WHERE account_id = :'keyler_account_id';
```

**No usar nombres ni correos para el WHERE de UPDATE. No cambiar `confirm_enabled` ni `enabled` al activar/desactivar la modalidad multiproducto.**

## Casos QA mínimos
- Cuenta sin flag: solicitud con `items` denegada tanto por API como por SQL; solicitud antigua permitida si `confirm_enabled` está activo.
- Cuenta habilitada: tres líneas -> cabecera única, suma exacta, detalles inmutables.
- Dos confirmaciones con la misma `request_key` -> un solo pedido y sin líneas duplicadas.
- Artículo inválido o precio/total inconsistente -> ninguna inserción parcial.
- Catálogo vinculado a otra cuenta -> rechazado.
- InkaClick: confirmar mismo payload de siempre, sin modificación de receptor ni flujos existentes.
- Estado de las otras cuentas, `order_confirmation_deliveries` y monitor: sin cambios inesperados.
