# Atribución publicitaria y Meta Conversions API (Business Messaging)

Estado: **implementado, desactivado por defecto, nunca validado contra Meta real** (no hay credenciales ni se enviaron eventos).

## Flujo
Anuncio CTWA → webhook (`referral.ctwa_clid`, `source_id`) → `contact_ad_attributions` (primera, sin cambios) + `contact_ad_clicks` (historial, nuevo) →
pedido (`order_confirmations`) → `order_ad_attribution()` (último clic **anterior** a la confirmación; si no hay historial, la primera atribución) →
cola `meta_capi_events` → cron `/api/meta-capi/cron` → `POST graph.facebook.com/{versión}/{DATASET_ID}/events`.

## Qué se envía (doc oficial: Conversions API for Business Messaging)
`event_name`, `event_time`, `action_source=business_messaging`, `messaging_channel=whatsapp`, `user_data{whatsapp_business_account_id, ctwa_clid}`, `custom_data{currency,value}`.
Sin teléfono, nombre ni DNI. Meta **no deduplica**: la deduplicación es nuestra (`UNIQUE(account_id, order_id, event_name)` y `event_id` determinista).

| Evento | Estado | Motivo |
|---|---|---|
| `OrderCreated` (pedido confirmado) | Implementado, apagado | Un pedido confirmado NO es venta pagada. |
| `Purchase` | **Bloqueado por CHECK** | InkaClick no informa pago/entrega; `order_status` es siempre `Pedido confirmado`. Además, si el cliente activó *Automatic Events*, Meta ya reporta `Purchase`/`LeadSubmitted` por su cuenta: duplicar inflaría conversiones. |
| `OrderCanceled` | **Bloqueado por CHECK** | No existe estado de cancelación en WACRM/InkaClick. |
| `LeadSubmitted` | No implementado | Misma razón (Automatic Events). |

## Requisitos de Meta para activar (por cuenta)
- WABA ID y **Dataset ID** (`GET/POST /{WABA_ID}/dataset`; un dataset por WABA).
- Token (System User / Embedded Signup) con `whatsapp_business_management` y `whatsapp_business_manage_events` (Advanced Access) + Marketing API Access Tier.
- Versión de API: por defecto `v27.0`, la que usa el ejemplo oficial de Business Messaging (revisado 2026-11-07). El changelog de Graph/Marketing API lista v26.0 (29-jul-2026) como última versión con fecha y es ambiguo sobre v27.0: **confirmar en el App Dashboard antes de activar**; es configurable por cuenta (`api_version`).
- `OrderCreated` figura en la lista oficial de 14 eventos de Business Messaging (la página no lo desglosa por canal ni exige `custom_data` para él; enviamos `currency`/`value` del total del pedido). Confirmar en Events Manager que el dataset lo acepta para WhatsApp.
- `test_event_code`: la página de Business Messaging **no lo documenta**; es el parámetro estándar de CAPI. Soportado por cuenta (`meta_capi_settings.test_event_code`); si Meta lo rechazara, el evento queda `failed` sin efecto productivo. Mientras esté definido, TODOS los envíos de esa cuenta llevan el código; quitarlo para pasar a producción.
- Consentimiento/privacidad: solo se envían `ctwa_clid` y WABA; confirmar con el cliente que acepta compartir eventos con Meta. No disponible para clientes en UE/UK/JP/KR según Meta (Automatic Events).
- Ventana: `max_click_age_days` (7 por defecto, conservador; la doc fija 7 días solo para la ruta con datos hasheados).

## Seguridad / aislamiento
- Doble interruptor: env `META_CAPI_ENABLED=true` **y** `meta_capi_settings.enabled=true` (CHECK exige dataset, WABA, token cifrado y `activated_at`). Solo se reportan pedidos confirmados **después** de `activated_at`.
- Token cifrado con el mismo AES-GCM de `whatsapp_config`; la columna no se concede a `authenticated`. No se loguean tokens, `ctwa_clid` ni mensajes de error de Meta (solo `http N code M`).
- Reintentos con backoff (1 min → 6 h, máx. 6), límite horario por cuenta (`hourly_limit`, 200), lease con `SKIP LOCKED`.
- Error de token/permiso (190, 10, 200-299, 401/403) → corta la cuenta (`enabled=false`, `disabled_reason='auth_error'`).
- Un fallo de Meta solo afecta a este cron. El webhook añade una sola llamada best-effort (`recordAdClick`, nunca lanza).

## Panel
`/ads-results` (solo lectura, rol agent+): por anuncio contactos, pedidos, importe de pedidos **confirmados**, unidades, productos, conversión (contactos del anuncio que pidieron ÷ contactos del anuncio). Pedidos sin evidencia en fila aparte. Ventas verificadas y ROAS: *No disponible*. Entrada «Resultados de anuncios» en el menú lateral (icono Megaphone, visible solo para owner/admin/agent, igual que la API; viewer no la ve). Estados: sin datos, integración desactivada (aviso informativo, el reporte funciona igual), sin permisos (403) y error de carga.

## Activación (NO ejecutada)
1. Revisar y mergear el PR; desplegar imagen (la migración `20261111000000` es aditiva).
2. Aplicar la migración (backup previo). Verificar `select count(*) from meta_capi_settings` = 0.
3. Insertar settings de UNA cuenta piloto con `enabled=false`, `send_order_created=true`, token cifrado con `encrypt()` (script de operaciones, service role).
4. Cargar un `test_event_code` de Events Manager → Test events en la cuenta piloto, `enabled=true`, y validar UN pedido real de la piloto en esa pestaña. Después `test_event_code=NULL`.
5. Poner `activated_at=now()`, `enabled=true`, `META_CAPI_ENABLED=true`, y añadir cron cada minuto a `GET /api/meta-capi/cron` con `x-cron-secret`.
## Rollback
Inmediato: `select meta_capi_disable('<account>')` y/o quitar `META_CAPI_ENABLED`. Imagen anterior: sin cambios de esquema. Esquema: `docs/integrations/meta-capi/ROLLBACK.sql` (probado en QA).

## Pruebas
`npx vitest run src/lib/meta-capi src/app/api/meta-capi` (fetch simulado, sin red) y `qa/meta-capi/run-sql-qa.sh` (PostgreSQL desechable, red interna, datos sintéticos).
