# SEARCH-01 — Piloto controlado de búsqueda (sin RPC)

**Estado:** plan de liberación, NO autoriza un despliegue por sí mismo.
**Base:** PR #120, commit `30244a76c84eecf63ba9a1bc91967ca2b59ee5fd`.
**Complemento:** desempate estable por `id` para búsquedas Inbox, tras QA de 12.000 coincidencias con fechas iguales.

## Alcance

- Debounce de 300 ms y cancelación de solicitudes antiguas (PR #120).
- En Inbox, `ORDER BY last_message_at DESC, id ASC` antes de paginar la búsqueda de contactos y de texto del último mensaje.
- Ajustes de Contactos de PR #120.
- **Excluido:** `search_inbox_conversations_page` de PR #124, índices `pg_trgm`, cambios SQL/migraciones/RLS, `NEXT_PUBLIC_SEARCH01_INBOX_RPC=true`, nuevos env o infraestructura QA.
- El patrón `ILIKE '%...%'` de producción sigue vigente. Este piloto no promete reducir la latencia de una búsqueda individual de un minuto.

## Gates antes de fusionar y desplegar

1. Verificar que PR #120 y este PR solo contienen los archivos autorizados; fusionar en el orden #120 y luego el correctivo (o rebasar si cambiaron las ramas). Sin merge a ciegas ni arrastrar commits de PR #124.
2. `npm ci`, `npm run typecheck`, `npm run lint`, `npm test` y `npm run build` sobre el SHA exacto del candidato. Build con placeholders de `.github/workflows/ci.yml`; variable RPC desactivada.
3. Auditoría de producción de solo lectura: imagen y SHA activos, CPU/RAM/disco, colas/crons healthy, clientes activos y métricas de Inbox/Contactos. Confirmar rollback basado en imagen anterior y respaldo vigente.
4. Aprobación expresa del operador para una ventana controlada de despliegue de la aplicación. No ejecutar migraciones ni cambios SQL.
5. Después de desplegar, verificar login, Inbox, búsqueda por teléfono exacto/parcial, nombre y último mensaje, Contactos con filtro de etiquetas/tiempo, búsquedas consecutivas rápidas y cancelación; ausencia de 5xx nuevos, RLS sin cambios, Flows/automations/crons operativos.
6. Tomar evidencia de piloto con 1–2 usuarios acordados (sin prometer segmentación técnica por cuenta: este cambio en la UI se distribuye a quienes usen la versión desplegada). Registrar p50/p95 por búsquedas representativas y percepción de usuario al menos 24–48 h.
7. Si aumentan errores, se pierden resultados, se deteriora p95 o aparecen problemas en Flows/colas, hacer rollback de imagen; no improvisar cambios SQL.

## Estado y límites

- Código y pruebas de la rama: pendientes de la nueva corrida de CI/QA sobre SHA exacto.
- PR #124 continúa en borrador, sin aprobación de producción. Su RPC fue funcionalmente correcta con QA sintética pero empeoró p95 de teléfono y nombre; la activación queda fuera del piloto.
- Medir satisfacción del usuario es valioso, pero no reemplaza los controles funcionales, de seguridad y de rendimiento.
