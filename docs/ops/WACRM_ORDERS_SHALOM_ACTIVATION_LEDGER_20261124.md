# WACRM — Registro de cierre: Pedidos Confirmados autónomos y activación Shalom
**Fecha de evidencia:** 2026-11-24 UTC (captura de UI compartida después, 24 nov. 19:12 hora Perú).  
**Origen:** registros de SSH, SQL y UI aportados por el operador durante la sesión; **no** constituyen acceso directo de este documento a la VPS.  
**Alcance:** WACRM exclusivamente. Este documento es inventario de estado, decisiones, pendientes y procedimiento de comprobación; no ejecuta despliegues ni cambia configuración.

## 0. Decisiones de producto vinculantes
- WACRM e InkaClick operan de forma **independiente**, cada uno con su **propio número de WhatsApp**.
- **No** se migrarán ni sincronizarán clientes, pedidos, vouchers, guías, pagos, estados ni historiales entre plataformas. No ejecutar iniciativas históricas SYNC-00…SYNC-08 para este objetivo. Los PRs existentes sobre sincronización **no representan** la arquitectura elegida.
- WACRM genera y administra **sus propios** pedidos y guías Shalom, consulta directamente al proveedor, y mantiene su WhatsApp.
- No modificar InkaClick, su VPS, cron, base de datos, automatizaciones ni WhatsApp; tampoco refactorizar Inbox, Calling, Flow u otros módulos de WACRM.
- Una guía obtenida de InkaClick solo puede servir como **referencia de QA**; evitar incorporarla al polling permanente de ambos sistemas. Nunca generar notificaciones o modificar pedidos reales sin autorización.
- Alcance específico cerrado en esta sesión: **activar tracking y cron Shalom**. Regla de 20 días, plantillas adicionales y paridad total funcional son **trabajo futuro**, no parte de esta activación.

## 1. Estado técnico confirmado en producción (logs del operador)
### 1.1 Aplicación y release
- Contenedor: `wacrm-app-1`.
- Imagen: `wacrm-app:autonomy-shalom-20261124`.
- ID imagen: `sha256:4c6ed24248a5f5ab494437f9c2f92cfec2d760799faed62e7daca2b624cf4f1d` (verificado igual entre contenedor e imagen local antes de la recreación).
- Estado antes/después de recreación: running/healthy; endpoint readiness HTTP 200 y prueba desde Caddy satisfactoria.
- Proyecto Compose **real**: `wacrm-cand-20261124t233405z` (no `wacrm`), servicio `app`, número 1.
- Redes conservadas: `edge_proxy` y `wacrm-cand-20261124t233405z_default`.
- Upstream Caddy real: `reverse_proxy wacrm-app-1:3000`. `wget` desde contenedor `dentalpin-caddy-1` a `http://wacrm-app-1:3000/api/health/ready` = PASS; host `wacrm-app` no resolvía. **No exigir alias `wacrm-app` como precondición.**
- Producción Compose tenía 17 archivos efectivos (base, prod, bsuid-vars, candidate overrides previos y override de imagen), sin mounts ni puertos publicados en app; entorno desde `/opt/apps/wacrm/.env.local`.
- Importante: `deploy.sh --execute <image>` impide reusar exactamente el ID activo; NO eludir esa protección. Se hizo una recreación acotada `docker compose -p wacrm-cand-20261124t233405z ... up -d --no-build --no-deps --force-recreate app`, reconstruyendo los 17 argumentos `-f` de labels y `CAND_NAME=wacrm-app-1`. Prechecks PASS: proyecto, servicio, nombre, imagen, flags, demás variables, mounts, puertos, red interna y edge_proxy, redes exactas, healthy; poschecks PASS: misma imagen, healthy, redes, Caddy, flags.

### 1.2 Activaciones ya realizadas
- En `/opt/apps/wacrm/.env.local` se registraron:
  - `SHALOM_TRACKING_ENABLED=true`
  - `SHALOM_CUSTOMER_MESSAGES_ENABLED=false`
- **Ambos flags confirmados dentro del contenedor recreado**, no solo en el archivo.
- Proveedor runtime `SHALOM_PROVIDER=shalom_http`, credenciales Shalom detectadas presentes, sin exponer valores.
- BD `supabase-db`, base `postgres`:
  - `public.order_integration_settings.logistics_mvp_enabled=true` para **una** cuenta.
  - `public.order_shipment_settings.shalom_tracking_enabled=true` para esa misma cuenta, tras UPDATE transaccional con precondiciones (resultado SQL `t | t | 1`, BEGIN / NOTICE PASS / DO / COMMIT).
  - `SELECT COUNT(*) FROM public.order_shipments` = **0** durante el smoke del 24 nov. 23:56 UTC. Esto es una fotografía temporal, no un valor perpetuo.
- Cron operativo instalado:
  - Script `/usr/local/bin/wacrm-shalom-cron.sh`, root, `0755`, 1073 bytes.
  - Programación `/etc/cron.d/wacrm-shalom`, root, `0644`, 673 bytes.
  - `cron` de Ubuntu `active`; entrada:
    `*/15 * * * * root flock -n /var/lock/wacrm-shalom-15min.lock /usr/local/bin/wacrm-shalom-cron.sh >> /var/log/wacrm-shalom-cron.log 2>&1`
  - Cron consulta exclusivamente `GET http://127.0.0.1:3000/api/orders/shalom/cron` dentro de `wacrm-app-1`, autenticado con `AUTOMATION_CRON_SECRET` mediante `x-cron-secret`; timeout externo de 140s e interno 130s; una línea de log resumida por ejecución. No publicar secretos ni logs con PII.
- **Primera ejecución MANUAL del cron con flock PASS** a `2026-11-24T23:56:34Z`:
  `rc=0 200 {"provider":"shalom_http","enabled":true,"claimed":0,"applied":0,"ignored":0,"byOutcome":{},"paused":null,"alertsCreated":0,"alertsNotified":0,"pickup":{"alerted":0,"messagesDue":0,"abandoned":0},"messages":{"claimed":0,"sent":0,"failed":0,"uncertain":0,"skipped":0,"errors":0},"purgedPolls":0,"errors":0,"durationMs":54,...}`
  y `running | healthy` después.
- Lo anterior valida endpoint, autenticación y ejecución manual **sin guías**; NO valida todavía trigger del scheduler a los minutos 00/15/30/45, rate limits con volumen, un pedido real ni transición de estado real.
- Mensajería generada por el poller cron **desactivada** por `SHALOM_CUSTOMER_MESSAGES_ENABLED=false`. No es un interruptor general de WhatsApp: envíos manuales de plantillas y otros procesos pueden seguir habilitados.

### 1.3 Scripts, artefactos, pruebas y protecciones
- Código fuente de scripts: `/opt/apps/wacrm-orders-autonomy-20261124/scripts/ops/shalom-cron/wacrm-shalom-cron.sh` y `wacrm-shalom.cron.d`.
- Workspace de desarrollo: `/opt/apps/wacrm-orders-autonomy-20261124`, rama local `feat/orders-autonomy-20261124`, con referencia anterior al commit `fd13a286` sobre base `b241fee1`; **no asumir que esta rama local está subida a GitHub ni que el HEAD remoto contiene los cambios sin verificarlo**.
- Migración ya aplicada en la sesión previa: `supabase/migrations/20261206000000_order_edit_and_cancellation.sql` (tablas `order_edits`, `order_cancellations`, funciones/triggers); se ejecutó con `psql --single-transaction -v ON_ERROR_STOP=1`. No volver a aplicar por rutina.
- QA reportado en desarrollo: 132 tests focales Shalom, 13 del servicio administrativo de pedidos, 7 UI edición/anulación, 2 tests de gate de mensajería, y `tsc --noEmit` PASS; la prueba real con guía en producción sigue pendiente. Evitar elevar resultados locales a garantía E2E.
- Respaldo DB predeploy: `/opt/backups/wacrm/autonomy-shalom-predeploy-20261124T232345Z/postgres.dump` (~282 MB), `postgres.dump.sha256` cotejado; `pg_restore --list` exitoso, **restauración real no probada**.
- Respaldo .env previo a habilitar: `/opt/backups/wacrm/env-pre-shalom-20261124T234341Z.bak` y `/opt/backups/wacrm/env-shalom-activation-20261124T234715Z.bak` (600). No copiar secretos a GitHub.
- Imagen anterior aparcada según deploy: `wacrm-app-1-prev-20261124T233405Z`, antigua etiqueta `wacrm-app:call-rbac-b241fee1cda3`; rollback de app **no revierte migraciones SQL**.
- Host reportó 193 GB total / 179 GB usados / 15 GB libres (93% ocupación). Evitar builds y backups superfluos.
- Algunos 502 puntuales durante rollout anterior, pero últimas verificaciones de Caddy: cero 502 recientes. No afirmar «cero interrupciones históricas».

## 2. UX Pedidos Confirmados — evidencia de la prueba manual
En captura aportada por operador, vista `Detalle del pedido` muestra:
- Estados `Pendiente voucher` y `Voucher validado` completados; `Embalaje en proceso` actual; `Listo para despacho` aún no alcanzado.
- Voucher de pago adjunto versión 1 con estado `Validado` (24 nov., 19:12 en UI). **No confundir voucher de pago con guía/voucher de envío Shalom.**
- Trazabilidad: «Voucher subido», «Lectura automática iniciada/completada», «Voucher validado», «Embalaje iniciado», atribuidos al operador visible en la UI.
- En `Embalaje`: **sin evidencia aún**; disponibles `Subir evidencia` y `Elegir del chat` para foto/PDF.
- Botón `Enviar plantilla y dejar listo para despacho` visible pero no confirmado como pulsado. **Es potencialmente un envío de WhatsApp real; comprobar destinatario, plantilla y aprobación antes de accionarlo.**
- No declarar completado embalaje, despacho, envío ni seguimiento a Shalom con esta captura. La prueba manual se detuvo en «añadir evidencia»; la recomendación fue no presionar envío de plantilla sin revisión.

## 3. Plantillas WhatsApp — matriz de trabajo, NO inventario verificado de Meta
Identificadas previamente como integradas en desarrollo, **sin comprobación en este registro de aprobación/activación Meta en WACRM**:
1. `pedido_embalado_listo`
2. `pedido_embalado_listo_saldo`
3. `pedido_llegada_destino`
4. `pedido_llegada_destino_saldo`
5. `recordatorio_recojo_pedido`
6. `voucher_envio_shalom`

Necesidades propuestas, NO completadas ni aprobadas por el mero hecho de estar aquí:
1. `pedido_embalaje_imagen_extra` — foto adicional de embalaje.
2. `pedido_listo_en_agencia` — aviso previo al despacho.
3. Confirmación de pago — nombre, variables y trigger por definir.
4. Anulación de pedido — nombre, variables y trigger por definir.

Antes de cualquier envío: consultar plantillas y estado de aprobación en **la WABA/número propio de WACRM**, mapear variables, verificar flujo, opt-in/reglas y deduplicación. No asumir reutilización automática de plantillas de InkaClick. Mantener cron-messaging OFF hasta decisión separada; el botón manual no está cubierto por este flag.

## 4. Comprobaciones pendientes (NO ejecutadas ni declaradas PASS)
### Críticas para cerrar E2E Shalom
- Verificar una ejecución **disparada automáticamente** por cron (últimas entradas en `/var/log/wacrm-shalom-cron.log`; fecha, HTTP, retorno, sin secretos). Scheduler estaba instalado/activo, no se observó una ejecución por reloj en evidencia.
- Registrar una **guía de prueba propia de WACRM** y confirmar: autorización/tenant, lectura directa de Shalom, mapeo estado, creación/actualización de `order_shipments`, auditoría y re-poll, idempotencia, ausencia de mensajes del poller. No usar por defecto una guía ya gestionada por InkaClick en ambos pollers. Consultar primero límites/rate limit de proveedor (se observaron antes respuestas 503 de rate limiting).
- E2E desde UI: evidencia de embalaje (foto/PDF), validación de paso a despacho, registro de guía, permisos y auditoría, con destinatario controlado en caso de plantilla.
- Verificar aislamiento y permisos de la cuenta; no realizar writes destructivos en pedidos reales.

### Funciones fuera de esta activación
- Regla de los 20 días: requisito aún por especificar con exactitud; no implementar supuestos.
- Plantillas adicionales y confirmación de aprobaciones Meta en WACRM.
- Comprobar paridad real de vouchers de **envío** (generación vs carga/revisión), asignación de vendedor y demás necesidades funcionales; no asumir 100% paridad con InkaClick.
- Pruebas de regresión operativa mínimas de Inbox, Calling y Flows posteriores al rollout (healthy no prueba cada flujo).
- Auditar que no haya sincronización heredada activa: la decisión de producto es NO sincronizar, pero este registro **no es auditoría exhaustiva de crons/funciones legacy**.

## 5. Operación segura y respuesta ante incidencias
- Nunca publicar contraseñas, tokens, datos personales ni contenido de `.env.local` en GitHub.
- Cron se detiene retirando únicamente `/etc/cron.d/wacrm-shalom` **si hay incidente y con aprobación operativa**; no editar crons ajenos ni tocar InkaClick. Alternativamente deshabilitar `SHALOM_TRACKING_ENABLED` en el entorno y recrear app por el procedimiento seguro (editar env por sí solo no actualiza contenedor).
- Mantener `SHALOM_CUSTOMER_MESSAGES_ENABLED=false` hasta validar plantillas, propiedad de cada pedido, idempotencia y destinatarios.
- No ejecutar `docker compose up` sin reconstruir exactamente los overlays del proyecto real; las comprobaciones demostraron que `-p wacrm` usaría otra red inexistente. Verificar alias funcional de Caddy `wacrm-app-1` antes y después.
- Si hay fallos, recopilar únicamente salud, response codes, counters de cron y estado de guías anonimizado; decidir rollback con cuidado: datos y migraciones no revierten con rollback de imagen.
- Las nuevas órdenes de WACRM usarán su número de WhatsApp; InkaClick mantiene el suyo. **No transportar pedidos ni contactos**.

## 6. Resumen de cierre y criterios de aceptación
**CERRADO (infraestructura):** despliegue saludable; configuración global y por cuenta Shalom habilitada; cron de 15 minutos instalado; ejecución manual `HTTP 200 / rc=0 / errors=0`; mensajes automáticos por cron desactivados.

**PENDIENTE (operativo):** evidencia de ejecución programada + seguimiento completo de una guía propia de WACRM + QA de embalaje/despacho. **NO se debe reportar seguimiento real end-to-end como probado aún.**

**FUERA DE ALCANCE:** migración/sync InkaClick, habilitar WhatsApp automático, regla de 20 días, plantillas nuevas, cambios de producción adicionales.

### Evidencia directa disponible
- Salidas SSH/SQL aportadas por operador el 24 nov. UTC: flags runtime, migración/respaldos, 13 guardas PASS de recreación, validación Caddy, commit de habilitación de cuenta, instalación cron, ejecución manual JSON de counters.
- Captura de UI «Detalle del pedido» aportada durante la conversación.
- Documentación relacionada previa en GitHub incluye PRs SYNC de carácter draft: no implican autorización para sincronizar.
