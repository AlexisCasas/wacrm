# SEARCH-01 — Piloto controlado de búsqueda (sin RPC)

**Estado:** candidato integrado del piloto en PR #125, dirigido a `main` para ejecutar CI. NO autoriza merge ni despliegue por sí mismo.
**Base:** PR #120, commit `30244a76c84eecf63ba9a1bc91967ca2b59ee5fd`.
**Complemento:** desempate estable por `id` para búsquedas Inbox, tras QA de 12.000 coincidencias con fechas iguales.

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
