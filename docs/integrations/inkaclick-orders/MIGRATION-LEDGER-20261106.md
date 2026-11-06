# Registro de migraciones de producción (WACRM, VPS) — 2026-11-06

Producción **no tiene** `supabase_migrations.schema_migrations`. Las migraciones se aplican a mano, una por una, con
`docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 -f -`. Por eso este documento, junto con una
comprobación del esquema antes de aplicar, es la fuente de verdad sobre qué está aplicado. Nunca se aplica la carpeta entera.

## Estado verificado en producción (solo lectura, 2026-11-06)

| Archivo | Estado | Evidencia en el esquema |
|---|---|---|
| `20261101000000_order_confirmations.sql` | APLICADA | existe `order_confirmations` |
| `20261102000000_order_sellers_from_members.sql` | APLICADA | `md5(prosrc)` de `create_order_confirmation` = `f99aebab9fd01bdae2da8d606f7362a8` |
| `20261103000000_whatsapp_config_messaging_account_id.sql` | APLICADA | existe `whatsapp_config.messaging_account_id` |
| `20261104000000_contact_keyword_automations_pause.sql` | APLICADA | existe `contact_automation_settings` |
| `20261105000000_contacts_time_filter_bulk_delete.sql` | APLICADA | existe `filter_contacts_by_tags_time` |
| `20261105000000_order_confirmation_items.sql` | **PENDIENTE** | no existen `order_confirmation_items` ni `order_integration_settings.multiproduct_enabled` |
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

1. La migración de pedidos se aplica **por nombre de archivo completo**, nunca con «todo lo de `20261105`».
2. Antes de aplicarla, la comprobación previa debe dar `t|t`:
   ```sql
   SELECT to_regclass('public.order_confirmation_items') IS NULL,
          md5(prosrc) = 'f99aebab9fd01bdae2da8d606f7362a8'
     FROM pg_proc WHERE proname = 'create_order_confirmation';
   ```
3. **Nunca** se vuelve a ejecutar `20261104`–`20261107` (contactos).
4. Si en el futuro se adopta la CLI de Supabase (`schema_migrations`), hay que resolver la colisión antes, por ejemplo marcando como
   aplicadas las versiones existentes y reasignando una versión única a la de pedidos.

Después de aplicar la migración de pedidos, actualizar esta tabla con su `md5(prosrc)` final y la fecha.
