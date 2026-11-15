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


## Validación estructural de peticiones (14/11/2026)

Se ejecutó el modelo de costos reproducible `node qa/search-01/request-budget.mjs`. **No se ejecutó PostgREST ni se midió la duración de consultas reales**. El modelo reproduce los tamaños de lote y el doble escaneo de #120/#121; contabiliza una petición adicional al terminar una página exactamente llena.

| Escenario | Coincidencias únicas | Peticiones #120 | Peticiones #121 | Oleadas extra secuenciales |
| --- | ---: | ---: | ---: | ---: |
| Número encontrado solo en contacto | 1 | 2 | 3 | 1 |
| Número encontrado en contacto y último mensaje | 1 | 2 | 3 | 1 |
| Nombre con diez coincidencias | 10 | 2 | 3 | 1 |
| Término corto: 1.500 coincidencias únicas (500 solapadas) | 1.500 | 4 | 19 | 4 |
| Término amplio: 20.000 coincidencias sin solapamiento | 20.000 | 22 | 222 | 50 |
| Término amplio: 10.000 coincidencias con solapamiento completo | 10.000 | 22 | 122 | 25 |

**Interpretación:** para la búsqueda objetivo (un número conocido), #121 agrega necesariamente una petición de hidratación posterior a los dos escaneos; la consulta `ILIKE '%...%'` sigue ejecutándose igual. Una mejora por menor transferencia no está demostrada. Para búsquedas amplias #121 puede multiplicar las solicitudes. Mantener **NO-GO para merge** mientras no existan datos reales que demuestren mejora.

## Protocolo para benchmark comparativo real (pendiente)

**Barrera de entorno:** comprobar que la base PostgreSQL y la API PostgREST correspondan inequívocamente a una instancia QA *desechable* (no conectada a producción). `qa115-pg` es solo una posible referencia previa, no una autorización implícita. Si no puede comprobarse el aislamiento y el respaldo, detener. **Nunca usar credenciales productivas, datos reales de clientes, endpoints de envío WhatsApp, migraciones o Docker de producción.**

1. Preparar dos worktrees separados: #120 en `30244a76c84eecf63ba9a1bc91967ca2b59ee5fd` y #121 en el SHA vigente. Confirmar diff y árbol limpio. Mantener idénticos Node, dependencias, variables de configuración ficticias y recurso de QA.
2. En una base *solo QA y desechable*, sembrar contactos/conversaciones ficticios con tenants separados, contactos bloqueados, tags, empresa y mensajes. Volúmenes controlados: 1, 10, 1.000, 10.000 y 20.000 coincidencias, incluyendo un caso con 50% de solapamiento entre las dos búsquedas y casos de teléfono vs `last_message_text`.
3. Usar una sesión autenticada de QA con las mismas reglas RLS que la aplicación; nunca desactivar RLS para que la prueba pase. Comparar paridad de identificadores, orden, etiquetas, filtros, y aislamiento entre cuentas. Los resultados buscados no deben quedar limitados a 1.000.
4. Ejecutar 5 calentamientos y al menos 25 repeticiones por escenario y versión, alternando el orden A/B. Registrar p50/p95 desde aplicación de término hasta lista renderizada (también el tiempo total incluyendo los 300 ms de debounce), número de solicitudes, bytes, errores, cancelaciones y CPU/memoria de QA. No registrar números buscados ni datos sensibles.
5. Si hay diferencias de latencia, usar `EXPLAIN (ANALYZE, BUFFERS)` **solo en la QA desechable** para descomponer el costo de cada `ILIKE`, joins y ordenación; contrastar con las estadísticas e índices reales de QA y documentar cualquier divergencia respecto a producción, sin ejecutar consultas costosas en vivo.
6. Criterio inicial: no aceptar regresión de p95 de más del 10% en búsquedas comunes; exigir evidencia de reducción apreciable en búsqueda de teléfono (objetivo tentativo >=20%) y paridad exacta de resultados para integrar. Si #121 empeora o no aporta mejora significativa, descartarlo o reemplazar la implementación antes de cualquier merge. La falta de evidencia implica **NO-GO**, nunca PASS por defecto.

**Estado del gate:** request-budget **PASS como análisis estructural**; benchmark real p50/p95/SQL/RLS **PENDIENTE**. No se modificó producción ni se ejecutó DDL.
