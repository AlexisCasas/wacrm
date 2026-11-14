# SEARCH-01 — Fase 2A: búsqueda de Inbox por identificadores (candidato)

- **Fecha:** 2026-11-14
- **Estado:** Candidato experimental — **no aprobado para producción**
- **Repositorio:** `AlexisCasas/wacrm`
- **Dependencia:** PR #120 (Fases 0 y 1) commit `30244a76c84eecf63ba9a1bc91967ca2b59ee5fd`
- **Rama:** `perf/search-01-phase2-id-first-20261114`

## Objetivo

Reducir el volumen de datos y las hidrataciones duplicadas de las búsquedas de Inbox, sin alterar la semántica de los resultados: búsqueda en nombre/teléfono/usuario WhatsApp y en texto del último mensaje, filtrado de contactos bloqueados, orden por actividad, etiquetas, empresa y resultados después del registro 1.000.

## Implementación propuesta

Anterior: dos búsquedas, cada una con proyección completa `*, contact:contacts!inner(*,contact_tags(tags(*)))`, paginadas en lotes de 1.000, y deduplicación tras descargar todas las conversaciones completas.

Candidato:

1. Dos búsquedas con las **mismas condiciones SQL** y la misma paginación, pero solo seleccionando `conversations.id` y el contacto mínimo del `INNER JOIN` requerido para excluir bloqueados.
2. Unión/deduplicación de los IDs obtenidos por ambas ramas.
3. Hidratación de las conversaciones **una sola vez** con la proyección original y todos los datos de contacto/etiquetas; lotes de 100 IDs, máximo cuatro consultas simultáneas.
4. Mantenimiento de `AbortController`, debounce y `sortConversationsByActivity` de la Fase 1.

**No** se introduce límite de resultados, exclusión de búsquedas numéricas en mensajes, cambio de criterio, modificación de RLS, creación de índices ni migración de base.

## Hipótesis y riesgos

La reducción de transferencia de resultados intermedios podría ser útil si existen miles de coincidencias o duplicados entre las dos ramas. **No se ha medido aún** y podría ser más lenta por las consultas adicionales de hidratación, especialmente cuando hay pocos resultados o alta latencia de red. Los predicados `ILIKE '%término%'` siguen sin un índice adecuado; por tanto, este cambio **no garantiza resolver los ~60 segundos** reportados.

Riesgos que hay que verificar:
- Las selecciones abreviadas con relación `contacts!inner` conservan los mismos resultados y políticas RLS.
- La hidratación posterior no provoca error por límites de URL, diferencias de permisos o resultados desaparecidos entre ambas fases de lectura.
- Una conversación que cambia entre la búsqueda de IDs y la hidratación puede requerir refresco (se mantiene resync y realtime).
- El lote de hasta 400 IDs por oleada (cuatro solicitudes de 100) no genera sobrecarga excesiva.
- El número de peticiones puede crecer frente a la implementación anterior. No se debe desplegar si empeora p95 o CPU.

## Validaciones obligatorias antes de considerar merge

- [ ] `npm run typecheck` en el commit exacto.
- [ ] `npm run lint` sin nuevos errores.
- [ ] Pruebas específicas de `conversation-list.test.tsx`.
- [ ] Suite completa y `npm run build`.
- [ ] Pruebas con contactos bloqueados, tags, empresa, estado, realtime, petición cancelada, roles/cuentas distintas y coincidencias después de 1.000.
- [ ] QA con datos **sintéticos** de volumen comparable: casos 1, 10, 1.000, 10.000+ coincidencias; términos de 1-2 y 9-12 caracteres; comparar antes/después en p50/p95, filas, bytes y cantidad de peticiones.
- [ ] Verificar que el resultado final mantiene los mismos IDs visibles que PR #120; registrar diferencias y resolverlas.
- [ ] Confirmar el código exacto de producción antes de preparar un despliegue.
- [ ] Autorización expresa para merge y despliegue; backups/preflight/postchecks vigentes.

## Fases siguientes fuera del alcance

- **2B — Contactos:** evaluar mejora de búsqueda, conteo exacto, filtro por etiquetas y costes de RPC; no alterar selección masiva ni paginación sin evidencia.
- **2C — Teléfonos normalizados:** evaluar consulta eficiente utilizando `phone_normalized`, compatible con RLS e índice compuesto; diseñar estrategia que preserve las coincidencias parciales y de mensaje.
- **3 — Índices PostgreSQL:** medir con `EXPLAIN` en QA; evaluar `pg_trgm`, orden por `last_message_at` y plan de migración independiente. No tocar producción sin aprobación.

## Resultado hasta ahora

Este PR conserva la Fase 0/1 como base y registra una **hipótesis de optimización comprobable**, no una mejora de tiempo ya confirmada. Sin ejecución de SQL, modificación de VPS, merge ni despliegue.
