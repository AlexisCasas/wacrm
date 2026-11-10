# WACRM — cron Meta Ads (fuente histórica, no instalar automáticamente)

La fuente `ops/meta-ads/run-meta-sync.sh` se copió **byte por byte** del script en uso en la VPS, según auditoría OPS-03A (10 nov 2026), sin rediseño funcional.

- Ruta actualmente ejecutada por cron: `/opt/apps/wacrm/ops/meta-ads/run-meta-sync.sh`.
- SHA-256 esperado: `e752cf5024ad928804e4628e30d23926896181d8b184564b4ea518f0ba22ffd9`.
- Archivo: 15 líneas y 1.362 bytes; Unix LF, sin secretos literales.
- El cron `/etc/cron.d/wacrm-meta-ads` lo ejecuta cada 5 minutos bajo `flock` con dependencia en `docker exec wacrm-app-1`, `AUTOMATION_CRON_SECRET` de runtime y el endpoint `/api/meta-ads/cron`.
- Git almacena archivos ejecutables como `100755`, no conserva permisos POSIX específicos `0750`. En la VPS el archivo auditado está en `0750` y propiedad de root: mantener esa propiedad y esos permisos en una **instalación autorizada por separado**.

## Riesgo de choque con un archivo no versionado en la VPS

`/opt/apps/wacrm/ops/meta-ads/` figura como no versionado en un worktree local. Un futuro `git checkout` o `git pull` que introduzca la misma ruta puede detenerse por `untracked working tree file would be overwritten`. **No borrar ni sobrescribir el archivo en uso para resolverlo automáticamente.** Antes de incorporar el repositorio actualizado a ese worktree:

1. Volver a verificar SHA-256 del archivo en ejecución y confirmar que el código Git es idéntico.
2. Preservar la copia operacional y los metadatos del cron en un respaldo privado con permiso `0600` y directorio `0700`, cuando se autorice expresamente.
3. Adoptar la ruta versionada en una operación de mantenimiento controlada; confirmar propietario, modo `0750`, `sh -n`, `flock` y cron objetivo sin duplicar el job.
4. Comprobar 2–3 ejecuciones siguientes solo por métricas `rc`/HTTP, sin mostrar payloads o secrets.

La integración de GitHub **no instala, reinicia ni modifica el cron**. Por sí sola no cambia producción. Evitar ejecutar manualmente el script durante QA porque dispara una sincronización real.

**Auditoría adicional pendiente:** al registrar la respuesta de la API, el script incluye hasta 700 caracteres del cuerpo HTTP, con patrones de enmascaramiento limitados. Verificar que el endpoint solo emite métricas no sensibles; una versión endurecida requerirá otro PR y revisión de compatibilidad con el cron actual.
