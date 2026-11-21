# SEARCH-01 — Piloto controlado de búsqueda (sin RPC)

**Estado actualizado (2026-11-16):** desplegado técnicamente en producción y validado cualitativamente por el usuario ("la búsqueda es más rápida"). **Cierre operativo pendiente**: verificación posterior de 502, crons/Flows y seguimiento de 24–48 h. El plan y sus gates predespliegue que siguen abajo son registros históricos, no bloqueos actuales.
**Base:** PR #120, commit `30244a76c84eecf63ba9a1bc91967ca2b59ee5fd`.
**Complemento:** desempate estable por `id` para búsquedas Inbox, tras QA de 12.000 coincidencias con fechas iguales.

## Registro de despliegue — 16 de noviembre de 2026

**Fuente de evidencia:** salida de consola del operador root durante `ops/deploy/deploy.sh --execute`, informe previo de Claude Desktop y confirmación manual del usuario. Evidencia de VPS no sincronizada automáticamente: `/home/deploy/search01-pilot/gates/GATES.md`. No se anexan datos de contactos, secretos ni volcados de BD.

| Campo | Evidencia / resultado |
|---|---|
| Ventana | 2026-11-16 09:17:30–09:18:25 UTC (04:17–04:18 Lima) |
| Imagen activa después del swap | `wacrm-app:candidate-33e7f5a7bb75` |
| Revisión OCI de la imagen | `33e7f5a7bb750b27d82722c31b56ee7670379c08` |
| Cambios incluidos | PR #125 (SEARCH-01 y cambios de #120), PR #126 (`ContactBlockedError` en botones/listas/reintentos) |
| Procedimiento de despliegue | PR #127, HEAD de scripts `542b3ff4e71b307708cccf9bee19caa503155db1` (fusionado en `main` como `31c8223846e027a563753eb444a3e48c406da90c`) |
| Imagen previa | `wacrm-app:webhook-f3-integrated-d545e2e6` |
| Contenedor anterior de rollback | `wacrm-app-1-prev-20261116T091729Z`; detenido y aparcado en privado |
| Alias real de Caddy | `wacrm-app-1:3000`; operación con `PUBLIC_ALIAS=wacrm-app-1` |
| Validaciones durante el despliegue | Ensayo de rollback privado PASS, 3 respuestas 200 de readiness, `FLOW_RECOVERY_CONTINUITY=PASS`, DNS privado y doble servicio PASS, intercambio de nombres PASS, final `done` |
| Overlays Compose conservados | 6; filtro de overlays históricos del PR #127 |
| Terminación del anterior | Código 143 (SIGTERM), registrado como advertencia; no implica por sí solo fallo |
| Migraciones / Caddy / cron | No se reportaron cambios SQL, ediciones de Caddy ni cron en el despliegue |
| Resultado funcional informado | El usuario confirmó después: "sí busca más rápido, todo bien"; percepción positiva, **no** medición p50/p95 ni QA exhaustiva |

**Interpretación:** el cambio de imagen terminó con éxito y no hay un motivo registrado para rollback inmediato. Esta evidencia **no sustituye** la revisión de errores 502, continuidad de colas/cron, búsquedas por escenarios y rendimiento durante 24–48 h. La interfaz de búsqueda se entrega a todos los usuarios del despliegue; no es un piloto limitado por cuenta.

### Secuencia de incidencias y controles cerrados

1. El primer dry-run con `deploy` se detuvo por permisos root en archivos Compose y estado del despliegue. El operador root ejecutó el dry-run completo con resultado `DRY-RUN complete: nothing was changed`; se observaron advertencias de variables `NEXT_PUBLIC_SUPABASE_*` en interpolación de Compose, revisadas como no bloqueantes en la preparación.
2. PR #127 corrigió el arrastre del overlay histórico `/opt/backups/wacrm/f3-scheduled-20261114/ops/candidate.override.yml`: solo se excluye si coincide byte a byte con el candidato vigente. CI y laboratorio Docker del PR cerraron en PASS.
3. El primer intento de `--execute` abortó de forma segura en el control DNS, antes de exponer el candidato: Caddy ya apuntaba a `wacrm-app-1`, no a `wacrm-app`. Se comprobó que producción quedó intacta.
4. Claude probó `PUBLIC_ALIAS == LIVE_NAME` en un laboratorio Docker desechable con scripts reales: despliegue y rollback PASS, 0 fallos DNS/HTTP en 299 muestras de deploy y 105 de rollback, según su informe. No se modificó Caddy.
5. El segundo `--execute`, con `PUBLIC_ALIAS=wacrm-app-1`, completó los siete pasos y conservó el contenedor anterior privado.

### Respaldo y reversibilidad

- Respaldo PostgreSQL `/home/deploy/search01-pilot/backups/search01-predeploy-20261116T085352Z`, creado antes del despliegue: `pg_dump -Fc`, globals/TOC y `sha256sum --check`; Claude informó restauración aislada de todos los esquemas con **0 errores**.
- El respaldo se encuentra en el **mismo servidor**. No equivale a una copia fuera del host.
- El respaldo PostgreSQL **no incluye Storage** (aproximadamente 4 GB de medios). Completar copia/verificación separada; **no asumir recuperabilidad integral** ante pérdida de la VPS.
- La imagen anterior quedó retenida mediante el contenedor `wacrm-app-1-prev-20261116T091729Z`. **No reiniciarlo manualmente.** Si fuese necesario revertir, el procedimiento es el script `ops/deploy/rollback.sh` en una sesión autorizada, con `PUBLIC_ALIAS=wacrm-app-1`, tras diagnosticar la incidencia.

### Cierre posterior — evidencia aún requerida

| Comprobación | Estado al registrar este informe |
|---|---|
| `ops/deploy/verify-no-502.sh --since 15m` y revisión de errores webhook | **PENDIENTE**: no se aportó salida posterior |
| Imagen, health y reinicios actuales (`docker inspect`) | **PENDIENTE**: la última evidencia es el `done` del despliegue |
| Crons de Flows, automations, waits, recovery y webhook-inbox; colas atascadas | **PENDIENTE**: se validó `FLOW_RECOVERY_ACTIVE` del candidato, no la operación posterior |
| QA manual por casos de búsqueda (Inbox/Contactos, cambio rápido, resultados) | **PARCIAL**: el usuario reporta mayor velocidad; casos y métricas sin acta |
| Observabilidad 24–48 h (p50/p95, 5xx, regresiones, Flows) | **PENDIENTE** |
| Respaldo de Storage y/o copia offsite | **PENDIENTE** |

**Condición para cierre operativo:** recopilar esas comprobaciones y registrar PASS/FAIL con la hora del control. El éxito del despliegue **sí está documentado**, pero no corresponde declarar cerrados los controles no ejecutados.

---

## Alcance

- Debounce de 300 ms y cancelación de solicitudes antiguas (PR #120).
- En Inbox, `ORDER BY last_message_at DESC, id ASC` antes de paginar la búsqueda de contactos y de texto del último mensaje.
- Ajustes de Contactos de PR #120.
- **Excluido:** `search_inbox_conversations_page` de PR #124, índices `pg_trgm`, cambios SQL/migraciones/RLS, `NEXT_PUBLIC_SEARCH01_INBOX_RPC=true`, nuevos env o infraestructura QA.
- El patrón `ILIKE '%...%'` de producción sigue vigente. Este piloto no promete reducir la latencia de una búsqueda individual de un minuto.

## Gates antes de fusionar y desplegar

1. Verificar que este PR #125, ahora dirigido a `main`, incluye tanto el código del PR #120 como el desempate adicional, **únicamente** en los siete archivos revisados. El CI debe ejecutarse para el candidato integrado. No fusionar #120 por separado antes de volver a revisar la relación entre ambos PRs; evitar incorporar el RPC #124.
2. `npm ci`, `npm run typecheck`, `npm run lint`, `npm test` y `npm run build` sobre el SHA exacto del candidato. Build con placeholders de `.github/workflows/ci.yml`; variable RPC desactivada.
3. Auditoría de producción de solo lectura: imagen y SHA activos, CPU/RAM/disco, colas/crons healthy, clientes activos y métricas de Inbox/Contactos. **Gate crítico:** la imagen activa `wacrm-app:webhook-f3-integrated-d545e2e6` y `main` tienen historia divergente; reconciliar el árbol productivo y documentar cada diferencia antes de construir cualquier imagen desde `main`. Confirmar rollback verificable y respaldo vigente.
4. Obtener respaldo fresco de la base de datos y verificar restauración sin exponer datos; asegurar que `docker image prune` no elimine la imagen de rollback. Ambos gates son independientes de CI. Aprobación expresa del operador para una ventana controlada de despliegue; no ejecutar migraciones ni cambios SQL.
5. Después de un despliegue autorizado, verificar login, Inbox, búsqueda por teléfono exacto/parcial, nombre y último mensaje, Contactos con filtro de etiquetas/tiempo, búsquedas consecutivas rápidas y cancelación; ausencia de 5xx nuevos, RLS sin cambios, Flows/automations/crons operativos.
6. Tomar evidencia de piloto con 1–2 usuarios acordados (sin prometer segmentación técnica por cuenta: este cambio en la UI se distribuye a quienes usen la versión desplegada). Registrar p50/p95 por búsquedas representativas y percepción de usuario al menos 24–48 h.
7. Si aumentan errores, se pierden resultados, se deteriora p95 o aparecen problemas en Flows/colas, hacer rollback de imagen; no improvisar cambios SQL.

## Estado y límites

- QA combinado local ya reportado por Claude Desktop contra el `main` vigente: TypeScript, ESLint, 4.421 pruebas y build PASS, sin RPC ni migraciones. El CI remoto de PR #125 se solicita por separado y debe verificarse en el HEAD del PR.
- GitHub comparó el commit de la imagen activa `d545e2e644cc` con `main` `bdce08d` y obtuvo historiales divergentes (46 commits por delante, 5 por detrás). Este dato **no** demuestra equivalencia binaria entre la imagen Docker y esos commits; falta inventariar el árbol que se construyó y su procedencia.
- Backups de producción, reversión por imagen y el prune nocturno siguen sin evidencia de cierre. **NO-GO al despliegue**, independientemente de que el CI quede verde.
- PR #124 continúa en borrador, sin aprobación de producción. Su RPC fue funcionalmente correcta con QA sintética pero empeoró p95 de teléfono y nombre; la activación queda fuera del piloto.
- Medir satisfacción del usuario es valioso, pero no reemplaza los controles funcionales, de seguridad y de rendimiento.
