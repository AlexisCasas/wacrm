# Registro de migraciones de producción (WACRM, VPS) — 2026-11-06

Producción **no tiene** `supabase_migrations.schema_migrations`. Las migraciones se aplican a mano, una por una, con
`docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 -f -`. Por eso este documento, junto con una
comprobación del esquema antes de aplicar, es la fuente de verdad sobre qué está aplicado. Nunca se aplica la carpeta entera.

## Estado de producción tras despliegue (2026-11-06)

Actualización basada en el informe operativo de Claude Code de **2026-11-06 a las 05:36:52 UTC**: se aplicó en transacción la migración de pedidos (rc=0) y se desplegó la imagen `wacrm-app:multiproduct-c2d03f16`, compilada desde `c2d03f161b0009ea21ce5c75f4084af36449d09d`. Los postchecks terminaron en PASS, sin rollback. Este documento registra evidencia operativa, no reemplaza un historial transaccional automático.

| Archivo | Estado | Evidencia en el esquema |
|---|---|---|
| `20261101000000_order_confirmations.sql` | APLICADA | existe `order_confirmations` |
| `20261102000000_order_sellers_from_members.sql` | APLICADA | introdujo la versión anterior de `create_order_confirmation` (MD5 `f99aebab9fd01bdae2da8d606f7362a8`), luego reemplazada por la migración multiproducto |
| `20261103000000_whatsapp_config_messaging_account_id.sql` | APLICADA | existe `whatsapp_config.messaging_account_id` |
| `20261104000000_contact_keyword_automations_pause.sql` | APLICADA | existe `contact_automation_settings` |
| `20261105000000_contacts_time_filter_bulk_delete.sql` | APLICADA | existe `filter_contacts_by_tags_time` |
| `20261105000000_order_confirmation_items.sql` | **APLICADA** (2026-11-06 05:36:52 UTC) | existen `order_confirmation_items`, restricción y trigger, con RLS y permisos verificados; `multiproduct_enabled BOOLEAN NOT NULL DEFAULT FALSE`; `create_order_confirmation` MD5 `a2bd25dd51bd5a7b8e715935e4f121ae` |
| `20261106000000_contacts_full_cleanup.sql` | APLICADA | existe `contact_chat_media_candidates` |
| `20261107000000_contact_media_cleanup_queue.sql` | APLICADA | existen `contact_media_cleanup_items` y `classify_chat_media_object` |

## Colisión de versión `20261105000000`

Dos archivos comparten el prefijo `20261105000000`. Nacieron en ramas paralelas: contactos, que se desplegó desde una rama local, y
pedidos (#73). **No hay conflicto funcional**, porque tocan objetos disjuntos:

- **`_contacts_time_filter_bulk_delete`:** `filter_contacts_by_tags_time` y `bulk_delete_contacts_internal`. Esta última la redefinen
  después `20261106` y `20261107`.
- **`_order_confirmation_items`:** la tabla `order_confirmation_items`, la columna `multiproduct_enabled`, la restricción
  `order_confirmations_id_account_unique` y una nueva versión de `create_order_confirmation`. Depende solo de `073_audio_guide_catalog` y
  `20261102000000`.

Decisión: **no se renombra ningún archivo**.

- **Contactos:** su archivo ya está aplicado, y renombrarlo daría la falsa impresión de que es una migración nueva.
- **Pedidos:** su nombre ya está referenciado en la QA y en los runbooks.

**Reglas mientras exista la colisión:**

1. La migración de pedidos **ya se aplicó** por nombre completo; **no se debe volver a ejecutar**, ni procesar masivamente los archivos con prefijo `20261105`.
2. **Precheck histórico** (anterior a la aplicación, ahora obsoleto): la comprobación dio `t|t` antes de migrar. El siguiente SQL se conserva únicamente como evidencia y ya no es un gate reutilizable:
   ```sql
   SELECT to_regclass('public.order_confirmation_items') IS NULL,
          md5(prosrc) = 'f99aebab9fd01bdae2da8d606f7362a8'
     FROM pg_proc WHERE proname = 'create_order_confirmation';
   ```
3. **Nunca** se vuelve a ejecutar `20261104`–`20261107` (contactos).
4. Si en el futuro se adopta la CLI de Supabase (`schema_migrations`), hay que resolver la colisión antes, por ejemplo marcando como
   aplicadas las versiones existentes y reasignando una versión única a la de pedidos.

## Verificación posterior al despliegue (solo lectura)

La consulta vigente debe verificar la versión ya aplicada, no reutilizar el precheck de ausencia de tabla:

```sql
SELECT to_regclass('public.order_confirmation_items') IS NOT NULL AS items_present;

SELECT md5(prosrc) AS function_md5
  FROM pg_proc
 WHERE oid = 'public.create_order_confirmation(uuid,uuid,uuid,uuid,text,text,uuid,jsonb)'::regprocedure;

SELECT count(*) AS enabled_accounts
  FROM public.order_integration_settings
 WHERE multiproduct_enabled = TRUE;
```

Resultado documentado tras migración: tabla existente, MD5 `a2bd25dd51bd5a7b8e715935e4f121ae` y **cero cuentas con multiproducto activado**. Los 209 pedidos anteriores conservaron su huella MD5, sin líneas de detalle nuevas. Keyler permaneció con `enabled=true` y `confirm_enabled=true`; no se modificaron. La imagen quedó healthy y el cron de pedidos, la pausa por keyword y las demás funciones de contactos siguieron operativos.

El despliegue del código **no constituye autorización de activación** de Keyler. La habilitación puntual de `multiproduct_enabled` requiere una validación de interfaz y un paso independiente, ya que el envío a InkaClick está activo.

Este cambio al ledger es únicamente documental y no requiere reconstruir ni redeplegar la imagen de producción.


## Activación exclusiva de Keyler — 2026-11-06, 13:06:20.745 UTC

**Estado operativo comunicado:** el wrapper transaccional de activación de Keyler terminó con \`ACTIVATION CHECKS PASSED\`, \`COMMIT\` y código 0. Una segunda sesión verificó que **solo la cuenta de Keyler** tiene \`multiproduct_enabled = TRUE\`. No se modificaron \`enabled\` ni \`confirm_enabled\`, que permanecen en \`TRUE\`. Se actualizó únicamente \`multiproduct_enabled\` y \`updated_at\` de una fila. No hubo cambios en otras cuentas, permisos, Flows ni en la configuración de InkaClick.

| Control | Resultado reportado |
|---|---|
| Revalidación previa al COMMIT | 7/7 PASS |
| Tabla \`order_integration_settings\` | Una fila cambiada; una sola cuenta con multiproducto habilitado |
| Versión de función \`create_order_confirmation\` | MD5 \`a2bd25dd51bd5a7b8e715935e4f121ae\` |
| Imagen desplegada | \`wacrm-app:multiproduct-c2d03f16\`, healthy, 0 reinicios |
| Pedidos antes y después de activar | 219 → 219, misma huella MD5 |
| Líneas \`order_confirmation_items\` | 0 → 0 |
| Entregas anteriores | 217 → 217 |
| Cron de InkaClick | 3/3 respuestas 200 tras la activación, sin rechazos nuevos |
| Flows, automatizaciones y mensajes | Operativos, sin regresión atribuida a la activación |

**Precisiones históricas:** los 10 pedidos adicionales respecto de los 209 registrados tras el despliegue fueron confirmaciones tradicionales legítimas **antes** de activar el interruptor. Las cifras del bloque anterior siguen siendo el corte correspondiente al momento del despliegue, no una fotografía actual. Los contadores de pedidos, mensajes y Flows pueden seguir variando por operación comercial normal.

### QA funcional pendiente

La activación del flag **no equivale al cierre funcional**. Falta revisar desde una sesión de asesor de Keyler, **sin confirmar pedidos**: aparición del editor tras recargar, cambio entre modo tradicional y multiproducto, añadir/editar/eliminar líneas, cantidades/precios/subtotales, sugerencias del catálogo y escritura manual, validación y vista previa. No pulsar el botón final \`Confirmar pedido\`: la entrega real a InkaClick está habilitada.

El monitoreo de solo lectura y el guion de QA están en el servidor, bajo \`/opt/backups/wacrm/multiproduct-c2d03f16-deploy/keyler-activation/\`. No publicar aquí secretos, credenciales ni datos de clientes.

### Rollback funcional

Si la funcionalidad presenta un problema, el procedimiento probado revierte **solo** \`multiproduct_enabled\` para Keyler sin modificar \`enabled\` ni \`confirm_enabled\`:

```bash
MODE=commit CONFIRM=yes /opt/backups/wacrm/multiproduct-c2d03f16-deploy/keyler-activation/keyler-multiproduct.sh rollback
```

Revisar el estado real antes de repetir cualquier comando que haya devuelto resultado incierto. Este rollback no elimina pedidos existentes ni revierte el esquema.
