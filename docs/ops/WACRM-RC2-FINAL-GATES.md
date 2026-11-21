# WACRM Calling RC2 — cierre de tres gates predespliegue

Estado: **instrumentación en GitHub + verificación real pendiente en VPS**. El green de GitHub Actions solo demuestra que el comprobador funciona y que las ACL de Calling pasan en un esquema limpio. GitHub **no tiene el tar de 5,7 GB, el dump productivo ni la imagen Docker viva** y no certifica esos objetos. Nunca subir copias de clientes, SQL dumps, secretos ni snapshots ACL a issues, artifacts o logs de Actions.

SHA base integrador: `793b9f38b24355c68e2711304d84e9051a79a4db`, PR #153. Los nuevos scripts de esta revisión no aplican SQL ni usan la VPS. El despliegue sigue en NO-GO hasta evidencias del host.

## Gate A: Storage (tar de `chat-media`)

La copia reportada de `/opt/backups/wacrm/rc2-predeploy-20261121T210530Z/` **NO está certificada**: `tar rc=1` con `file changed as we read it`. Un SHA-256 correcto solo demuestra integridad de los bytes archivados, no un punto en el tiempo coherente ni que falten archivos.

Procedimiento autorizado para operador en VPS (no hacerlo desde un runner público):
1. Mantener intacto el backup anterior y sus SHA; registrar inicio/fin, tamaño y lista de archivos desde ubicación privada.
2. Para una copia coherente, respaldar desde snapshot del volumen/FS tomado en un instante consistente, o coordinar barrera de escrituras breve y controlada del servicio de Storage. **No crear un tar directo de un directorio con escrituras activas y ocultar el rc=1**. No parar WhatsApp/productivo sin autorización específica de ventana.
3. Crear nuevo tar desde ese origen inmutable, guardar el código real de `tar`, SHA-256, evidencia de snapshot/barrera y salida sanitizada en la carpeta privada de backup. No incluir medios/tokens en GitHub.
4. Probar lectura integral con:
   `python3 scripts/release/rc2-proof-check.py storage --archive <tar> --sha256 <64-hex> --tar-rc 0`
   El comando devuelve `RC2_STORAGE_ARCHIVE=PASS_SHA256_AND_FULL_READ` y **exit 2** porque no puede certificar por sí solo la consistencia temporal. La evidencia de snapshot o barrera, evaluada independientemente, es obligatoria para `STORAGE_BACKUP=PASS`.

## Gate B: paridad de ACL y RLS en restauración

`supabase/ci/rc2-acl-snapshot.sql` extrae **solo metadatos** de relaciones, funciones, roles y políticas del esquema `public`. Incluye `supabase_realtime_admin` como requisito de paridad observable.

Ejecutar exactamente contra la BD productiva real **en transacción solo lectura**, y contra la restauración aislada *después* de aplicar las ocho migraciones, sin exponer credenciales ni imprimir archivos completos:

```bash
umask 077
# Revisar nombres de contenedor y contexto antes de ejecutar.
docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' wacrm-db-1 \
  psql -XAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < supabase/ci/rc2-acl-snapshot.sql > /opt/backups/wacrm/rc2-acl-prod.jsonl
docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' rc2-rehearsal-db \
  psql -XAt -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < supabase/ci/rc2-acl-snapshot.sql > /opt/backups/wacrm/rc2-acl-rehearsal.jsonl
python3 scripts/release/rc2-proof-check.py acl \
  --before /opt/backups/wacrm/rc2-acl-prod.jsonl \
  --after /opt/backups/wacrm/rc2-acl-rehearsal.jsonl
```

**IMPORTANTE:** `wacrm-db-1` es un nombre **ilustrativo**, no confirmado. Claude debe localizar el nombre verdadero con comandos de solo lectura y sustituirlo. Si la restauración todavía está detenida, no conectar a producción por error. El resultado debe ser `RC2_RESTORE_ACL_PARITY=PASS_METADATA_ONLY`, sin objetos anteriores perdidos ni permisos cambiados. Nuevas tablas/funciones Calling están permitidas; cualquier diferencia de RLS, `anon`, `authenticated`, `service_role`, expresiones de políticas o rol `supabase_realtime_admin` es motivo de **investigación**. Un display `uid()` vs `auth.uid()` no se normaliza silenciosamente.

Este gate de metadatos **no reemplaza** el ensayo de restauración reproducible ni las pruebas con roles reales. Si se necesitan GRANT correctivos, documentar qué falló **antes** de editar y repetir el restore aislado usando el procedimiento corregido.

Por separado, `supabase/ci/rc2-dark-acl.sql` se ejecuta automáticamente en `Migrations` y comprueba las cinco tablas Calling, RLS y no acceso directo de `anon`/`authenticated` a tablas y funciones no trigger.

## Gate C: imagen anterior compatible con la base migrada

`scripts/release/rc2-legacy-offline-probe.sh` ejecuta **solo lecturas** y rechaza el contenedor de producción por nombre, imagen o redes. Exige:
- un contenedor nuevo con prefijo `rc2-` ejecutando exactamente la imagen antigua `wacrm-app:p0-total-correction-300284e6`;
- `rc2-rehearsal-db` con 8 migraciones ya aplicadas;
- ambos en **una única red Docker `--internal`** con prefijo `rc2-`, sin salida a Meta/Internet ni acceso a DB productiva;
- readiness con consulta DB real mediante el mismo fallback de `rollback.sh`.

El operador monta previamente una pila Supabase/REST privada de QA y pasa la configuración interna **sin imprimir secretos**. Nunca apuntar la prueba a la URL real de Supabase o Meta, ni reutilizar contenedores `wacrm-app-1`.

```bash
RC2_LEGACY_CONTAINER=rc2-legacy-app \
RC2_REHEARSAL_DB_CONTAINER=rc2-rehearsal-db \
RC2_INTERNAL_NETWORK=rc2-offline-internal \
  bash scripts/release/rc2-legacy-offline-probe.sh
```

El resultado `RC2_LEGACY_POST_MIGRATION=PASS_ISOLATED_DB_READINESS` demuestra arranque y acceso DB; **todavía falta** smoke read-only de pedidos, flows, inbox y funciones de negocio sin mandar mensajes. No probar fallos artificiales/Meta en producción.

## Cierre controlado y privacidad

Se requiere un informe conjunto `STORAGE_BACKUP`, `RESTORE_ACL_PARITY`, `LEGACY_IMAGE_POST_MIGRATION`, `BUSINESS_SMOKE`, `PROD_BASELINE_RECHECK` y `DARK_DEPLOY_GO_NO_GO`, firmado sobre el SHA real del candidato. Conservar el dump, los tar y snapshots de datos productivos **solo en VPS o almacenamiento privado**, con permisos 0600/0700 y retención definida. Una vez verificados, eliminar el contenedor `rc2-rehearsal-db` por contener copia de datos reales, tras autorización.

Una decisión de GO para publicar dark requiere aprobación independiente de las ocho migraciones SQL productivas y del comando `deploy.sh --execute`. Calling seguirá `WHATSAPP_CALLING_ENABLED=false`; Meta `calls` OFF y `messages` ON. No hay activación del piloto real en este gate.
