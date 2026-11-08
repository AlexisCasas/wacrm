# Selectores de producto desde etiquetas comerciales — release controlado

## Problema
WACRM permitia editar un nombre arbitrario en el formulario de pedido individual
y en cada linea de multiproducto. Eso crea variantes en los reportes de ventas.
El buscador previo de multiproducto consultaba `audio_guide_products`, que es
un catalogo distinto de las etiquetas de producto usadas por ventas.

## Modelo
- `tags.is_order_product = FALSE` por defecto: no se incluyen estados de
  logistica o etiquetas operativas por accidente.
- Los administradores clasifican las etiquetas existentes usando el distintivo
  **Producto** en Configuracion > Campos y etiquetas. No se crea otra etiqueta.
- `order_integration_settings.product_tags_required = FALSE` por defecto:
  otras cuentas y sus pedidos legados no cambian.
- Cuando el flag es TRUE, el pedido individual y TODAS las lineas multiproducto
  requieren `product_tag_id` presente y valido dentro de la cuenta de sesion.
- La API convierte el ID en el nombre canonico del tag en el momento de guardar;
  ignora cualquier nombre enviado por el navegador. Precios siempre manuales.
- La descripcion del pedido continua libre. Pedidos ya confirmados no se alteran.
- Los IDs de etiquetas NO se confunden con IDs de `audio_guide_products`.
  La estructura de envio hacia InkaClick sigue identica.

## No modificar
- Etiquetas de contactos, automatizaciones, flows, medios, mensajes,
  plantillas WhatsApp y receptor InkaClick.
- `multiproduct_enabled`, `confirm_enabled`, `enabled` y outbox existentes.
- Nombres, importes y lineas historicos.

## Checklist de liberacion — VPS de WACRM, NO Supabase de InkaClick
1. **Preflight de solo lectura:** validar SHA exacto que corre en VPS, rama
   desplegada, integridad de migraciones, outbox, estado del monitor y backup
   verificable. No mezclar con otras releases que esten pendientes.
2. Ejecutar una QA de migracion sobre copia aislada; aplicar solo
   `20261112000000_order_product_tag_selector.sql` con respaldo y registro.
3. Desplegar frontend + API WACRM del commit aprobado con flag FALSE.
   Verificar rutas del modal antiguo, multi, mensajes y outbox.
4. Con rol admin de la cuenta real de Keyler, marcar **Producto** sobre las
   etiquetas comerciales correctas; verificar listado y que estados como
   Avisados, En destino, Entregado no aparecen. Esto no debe crear etiquetas.
5. Comprobar que las etiquetas cubren todos los productos vendidos. Si el
   catalogo esta incompleto, NO activar el modo estricto.
6. Validar `account_id` de Keyler desde `profiles` + `accounts`, no por
   nombre visible. Tomar un respaldo y registrar la cifra exacta de tags.
7. Activar **solo esa cuenta**, si `confirm_enabled = true` y >0 productos
   clasificados. Ejemplo parametrizado en transaccion:
   ```sql
   BEGIN;
   UPDATE public.order_integration_settings s
   SET product_tags_required = TRUE, updated_at = NOW()
   WHERE s.account_id = :'keyler_account_id'
     AND s.confirm_enabled = TRUE
     AND EXISTS (
       SELECT 1 FROM public.tags t
       WHERE t.account_id = s.account_id AND t.is_order_product = TRUE
     )
   RETURNING account_id, product_tags_required;
   -- Revisar que devuelva exactamente UNA fila.
   ROLLBACK; -- usar COMMIT solo durante la activacion autorizada.
   ```
8. QA manual: pedido unico con selector, multiples lineas con selector,
   precios y descripciones libres, busqueda sin resultados, error de catalogo,
   tag desmarcado o eliminado entre preview y confirm, reintento de request_key,
   lectura del pedido en InkaClick, calculos del Excel.
9. Revisar 422/500 y cola de envios. Cerrar release solo con QA real PASS.

## Rollback
Primero desactivar solo la bandera de Keyler:
```sql
UPDATE public.order_integration_settings
SET product_tags_required = FALSE, updated_at = NOW()
WHERE account_id = :'keyler_account_id';
```
Si la UI/API presenta un defecto, volver a la imagen anterior con las columnas
aditivas preservadas. No borrar tags ni rehacer pedidos historicos.

## Control de riesgos
Unicamente el admin puede marcar etiquetas en la API PATCH, que valida
`account_id` de sesion. El GET y el POST validan por cuenta de sesion,
no aceptan un account_id enviado por el cliente. Si falla la consulta del
catalogo se bloquea la confirmacion, no se habilita entrada libre.
