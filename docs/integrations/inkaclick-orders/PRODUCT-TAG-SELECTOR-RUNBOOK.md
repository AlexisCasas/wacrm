# Selector de productos desde "Audios por producto" — corrección PR #90

## Fuente autorizada (aclaración del cliente, 08/11/2026)

**No usar etiquetas de contacto.** La única fuente de productos permitidos es la
lista existente de la pantalla `/audio-guide`, tabla PostgreSQL
`public.audio_guide_products` (id, account_id, product_key, display_name, active).

El cliente elige en esa pantalla los productos que vende. Un producto no necesita
tener una grabación de voz para que aparezca: se requiere `active=TRUE`.
Los estados de logística, etiquetas de interés, campos personalizados y nombres
históricos de órdenes NO constituyen catálogo.

## Compatibilidad de la migración YA instalada en VPS

La migración original `20261112000000_order_product_tag_selector.sql` ya fue
aplicada al PostgreSQL de WACRM en el despliegue productivo `33e3cb33`.
Esa migración añadió dos columnas con valores FALSE. **No se debe repetir ni
alterar el archivo histórico aplicado.** Su columna
`tags.is_order_product` y su índice son obsoletos y no se usan en el nuevo
código; su limpieza, si se requiere, será un correctivo futuro separado.

Se reutiliza por compatibilidad la columna ya instalada
`order_integration_settings.product_tags_required` como bandera de
*selección estricta desde audio_guide_products*. El nombre es histórico,
pero **no implica etiquetas**: todo el código la interpreta como
`catalogo_de_productos_obligatorio`. No se necesitan migraciones nuevas.

## Contrato funcional

- Sin la bandera: comportamiento legado, sin regresión, incluyendo el selector
  opcional multiproducto desde `audio_guide_products`.
- Con la bandera TRUE: producto único exige `catalog_product_id` válido,
  y cada línea multiproducto exige su propio `catalog_product_id`.
- El GET `/api/orders/products?q=...` lista SOLO productos activos de la
  cuenta de la sesión (no admite `account_id` del navegador), desde
  `audio_guide_products`. Búsqueda por nombre y orden alfabético.
- El POST `/api/orders/confirm` resuelve todos los IDs contra
  `audio_guide_products` filtrando por cuenta y `active=true`.
  Ignora los nombres enviados y guarda el `display_name` oficial.
  Para múltiples productos preserva `catalog_product_id` en
  `order_confirmation_items`; el RPC actual también comprueba pertenencia
  y estado activo. No se crea ni modifica ningún producto ni nota de audio.
- La descripción, precios, cantidades, vendedor, outbox e integración InkaClick
  conservan las reglas previas.
- La lista visible en `/audio-guide` es autoridad; para agregar un artículo
  nuevo, usar `Nuevo producto` en ese módulo, no el formulario de pedidos.

## Despliegue correctivo (VPS, ejecución por Claude Code)

1. Registrar el SHA y estado real del contenedor `wacrm-app`, migraciones,
   versionado del código y salud. Última imagen reportada:
   `wacrm-app:product-tags-33e3cb33`. Sin cambios sobre otros módulos.
2. Verificar backup existente: `/opt/backups/wacrm/product-tags-pr90-deploy/db/`,
   chequeo de SHA y capacidad de volver a la imagen 33e3cb33.
3. En worktree aislado con la HEAD actual de PR #90:
   `npm ci`, `npm run lint`, `npm run typecheck`,
   `npm test` y `npm run build`. Corregir solo el alcance #90.
4. **No repetir migración 20261112000000**. Corroborar ambas columnas
   existentes y `product_tags_required=FALSE` en Keyler.
5. Compilar imagen del nuevo commit, smoke aislado, swap controlado, T+0/T+10,
   sin tocar el servicio activo hasta aprobación de todos los gates.
6. Identificar cuenta de Keyler de manera independiente en la DB; cuenta
   reportada previamente `4d04a2e0-62b8-4508-a046-4b125aa2e8db`.
   Verificar el catálogo con:
   ```sql
   SELECT id, display_name, active
   FROM public.audio_guide_products
   WHERE account_id = '4d04a2e0-62b8-4508-a046-4b125aa2e8db'::uuid
   ORDER BY display_name;
   ```
   Comparar nombres de la pantalla, comprobar que existan productos activos
   y ausencia de duplicados sospechosos. **No se requiere clasificar tags**.
7. Si la cuenta y lista están verificadas, activar exclusivamente Keyler:
   ```sql
   BEGIN;
   UPDATE public.order_integration_settings s
      SET product_tags_required=TRUE, updated_at=NOW()
    WHERE s.account_id='4d04a2e0-62b8-4508-a046-4b125aa2e8db'::uuid
      AND s.confirm_enabled=TRUE
      AND EXISTS (
        SELECT 1 FROM public.audio_guide_products p
        WHERE p.account_id=s.account_id AND p.active=TRUE
      )
    RETURNING account_id, product_tags_required;
   -- VALIDAR EXACTAMENTE UNA FILA antes de COMMIT.
   COMMIT;
   ```
   Si no devuelve una fila, ROLLBACK y diagnosticar. Resto de cuentas en FALSE.
8. QA autenticado con datos sintéticos: producto único y múltiple, búsqueda de
   existentes, rechazo de texto arbitrario, id ajeno o inactivo, selección
   seguida de baja del producto, precio, cantidad y descripción libres,
   idempotencia `request_key`, receptor InkaClick, cola, mensaje y Flows.
   Evitar crear entregas reales no deseadas: usar entorno aislado o
   desactivar entrega (held) bajo control si se necesita una inserción.
9. Registrar T+0/T+10/T+30, SHA/imagen activa, catálogo activo, flag y
   resultados. Fusionar PR #90 a main solo tras validación.

## Rollback de flag y de imagen

Primero:
```sql
UPDATE public.order_integration_settings
SET product_tags_required=FALSE, updated_at=NOW()
WHERE account_id='4d04a2e0-62b8-4508-a046-4b125aa2e8db'::uuid;
```
Luego, si hay fallas, volver a imagen previa verificada. Las columnas
históricas y los registros de audio permanecen intactos. Nunca borrar los
productos ni editar sus nombres para resolver problemas de confirmación.
