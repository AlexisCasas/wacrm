# PR #98 — Preflight formal, solo lectura (VPS WACRM)

**Estado:** preparar evidencias; NO autoriza deploy, rollback, merge, reinicio, modificación de Caddy ni creación de contenedores/redes. Ejecutar desde Claude Code conectado por SSH con permisos de solo lectura sobre Docker.

## Restricciones innegociables
- No ejecutar `deploy.sh --execute`, `rollback.sh --execute`, `docker compose up/down`, `docker stop/start/restart`, `docker network connect/disconnect`, migraciones SQL, `docker exec` sobre otros servicios, ni `caddy reload`.
- No imprimir `.env`, `docker inspect .Config.Env`, tokens, encabezados HTTP, mensajes privados ni payloads de WhatsApp. Entregar únicamente conteos, nombres de servicios/rutas y estados.
- Si un control requiere acceso a secretos para inspección, marcar PENDIENTE y describir cómo validarlo sin divulgarlos. No actuar sobre Dentalpin.

## 1. Inventario de la topología (sin mutaciones)
```bash
docker version --format '{{.Server.Version}}'
docker compose version
docker ps --filter name=wacrm --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
docker inspect -f 'running={{.State.Running}} restart={{.RestartCount}} image_id={{.Image}}' wacrm-app-1
docker inspect -f 'project={{index .Config.Labels "com.docker.compose.project"}} working_dir={{index .Config.Labels "com.docker.compose.project.working_dir"}} config_files={{index .Config.Labels "com.docker.compose.project.config_files"}}' wacrm-app-1
docker port wacrm-app-1
docker network inspect edge_proxy --format 'network={{.Name}} driver={{.Driver}} scope={{.Scope}}'
docker inspect -f '{{json (index .NetworkSettings.Networks "edge_proxy").Aliases}}' wacrm-app-1
df -h / /opt/backups
free -h
```
**Registrar:** Compose >=2.24.4; servicio vivo; alias esperado; archivos Compose originales existentes; puerto(s) host publicados; capacidad de memoria y disco para 2 contenedores y backups.

## 2. Dependencias de puertos y cron
```bash
ss -ltnp | grep -E ':(3000|8080)[[:space:]]' || true
grep -RIlE 'wacrm-app-1|127\.0\.0\.1:(3000|8080)|localhost:(3000|8080)' /etc/cron.d /usr/local/bin 2>/dev/null || true
```
**No imprimir los contenidos de los scripts encontrados.** Confirmar, caso a caso, si cada consumidor necesita el puerto publicado o puede usar `edge_proxy`. No establecer `ALLOW_DROP_HOST_PORTS=1` sin evidencia y aprobación explícita.

## 3. Caddy compartido (lectura exclusivamente)
- Identificar nombre del contenedor Caddy, su versión y la configuración efectiva del *bloque WACRM*, sin mostrar otros sitios ni secretos.
- Confirmar exactamente el upstream de `crm.globaltechup.com`, si usa `wacrm-app:3000`, transport/keepalive, timeouts, health checks y registros de acceso/errores.
- No asumir que el bloque propuesto `caddy-hardening.proposed.md` ya esté instalado. **No editar, validar con reload ni reiniciar Caddy/Dentalpin.**
- Medir solo conteos de errores upstream relacionados con WACRM para una ventana definida. No copiar líneas de logs con teléfonos, headers o payloads.
- **Bloqueo P0:** el rollback actual reinicia el contenedor antiguo con el alias público antes de readiness. Requiere rediseño/ensayo antes de permitir una conmutación.

## 4. Reversibilidad, seguridad y compatibilidad
- Confirmar respaldo existente y su integridad mediante manifiesto/checksum; no crear ni restaurar backups todavía.
- Verificar la referencia de imagen del candidato y su digest, y que corresponde al commit autorizado; no construir imágenes en la VPS.
- Comprobar que `last.env` apunta únicamente al último cutover exitoso y tiene acceso restringido; no revelar su contenido ni sobrescribirlo.
- Analizar etiquetas Compose, named volumes, networks y overlays de la imagen activa: el candidato usa otro project name y no debe crear redes/volúmenes de datos divergentes.
- Verificar que la imagen antigua permite un GET read-only al endpoint de BD desde dentro, sin exponer credenciales. Registrar únicamente 200/503/timeout.
- Confirmar que crons basados en `docker exec wacrm-app-1` no pierden la referencia en fallo parcial de `docker rename`.

## 5. Gates y entrega
| Gate | PASS exige |
|---|---|
| VPS / Compose | versión compatible, etiquetas/overlays coherentes, disco/RAM suficientes |
| Puerto host | consumidores identificados y estrategia aprobada sin corte |
| Caddy | topología y keepalive documentados; prueba real pendiente separada |
| Rollback | **P0 corregido**: previo no aparece en DNS público hasta estar listo |
| Fallo de rename | retorno a estado consistente ensayado con inyección de fallo |
| Backup | integridad verificada y rollback de datos documentado |
| CI GitHub | CI y lab PASS en HEAD exacto |

**Formato del reporte:** hora Lima y SHA, tabla de gates PASS/FAIL/PENDIENTE, evidencias sintetizadas, riesgos residuales, conclusión GO/NO-GO y cambios solicitados. Mientras falle cualquier gate crítico: NO-GO para merge y `--execute`.
