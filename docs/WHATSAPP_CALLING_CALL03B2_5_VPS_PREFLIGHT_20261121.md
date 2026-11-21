# WACRM — CALL-03B2.5: resultado de preflight VPS y desbloqueos

**Corte:** 2026-11-21T15:42Z (reporte operativo de Claude Code, solo lectura).
**VPS:** `srv1917080`. **Resultado:** `CALL03B25_VPS_PREFLIGHT=BLOCKED`; no se ejecutaron migraciones, despliegues, builds, fetches, reinicios ni escrituras en BD.
**Fuente:** reporte sanitizado del operador en el proyecto WACRM; los datos VPS aún no han sido confirmados de forma independiente desde GitHub.
**Documento complementario:** [Estado general y matriz QA](WHATSAPP_CALLING_CALL03B2_STATUS_QA_GATE_20261121.md).

## A. Resultado por gate

| Gate | Resultado | Evidencia resumida y restricciones |
|---|---|---|
| Host | PASS | `MemAvailable=7222 MiB` vs piso 2560, 68 GB libres, PSI memoria 0, sin OOM, carga 3.5 |
| Docker QA | PASS | 7 servicios en `call03b2-qa`, sin reinicios ni OOM, app QA `wacrm-app:call03b2-timing-9bc3547`, mock `wacrm-call03b2-mock-graph:8a5a869f` |
| Aislamiento Graph | PASS | `graph.facebook.com` resolvió a `127.0.0.1` en app, mock comparte netns; 38089/38090 escuchan exclusivamente en loopback |
| PostgreSQL QA | PASS de limpieza | PostgreSQL 17.6, contenedor `call03b2-qa-db`, 23 sesiones (20 terminated, 3 rejected), 55 eventos, 8 intentos salientes; 0 claims vigentes, 0 SDP |
| Integridad histórica | BLOCKED | Falta recuperar un artefacto verificable del hash original de las 18 sesiones, no basta con el conteo global |
| Migraciones | BLOCKED documental | Función `whatsapp_call_event_apply` md5 `925d947b…` (9764 caracteres); sin historial de migrations propio; el árbol de código de VPS llega a `20261130000004`, no incluye la migración nueva |
| Respaldos | BLOCKED por acceso | `/opt/backups/call03b2-qa` pertenece a root (0700); el usuario deploy no pudo listar/checksum; 9 respaldos de Compose detectados |
| Producción | PASS salud / REVIEW cambio | `wacrm-app-1`, contenedor `255504863f42`, imagen `wacrm-app:p0-parity-4e1b7b8-ocr` (`sha256:b7189dd1…`), healthy, 0 reinicios/OOM; **rotación no atribuida a este trabajo a las 15:29 UTC** |
| Artefacto QA | BLOCKED | No hay imagen para SHA Draft de #144 ni mecanismo aprobado de build externo para ese HEAD; Dockerfile requiere variables públicas de compilación correctas |

## B. Respaldo previo conocido: verificar sin revelar contenido

Existe una referencia histórica de respaldo **anterior a la migración 00004**; comprobar su presencia, tamaño, checksum y legibilidad del índice con privilegios root, sin restaurarlo ni exponer datos:

- Ruta esperada: `/opt/backups/call03b2-qa/call03b2-qa-pre-20261130000004-20261121T053142Z.dump`
- SHA256 esperado, **reportado previamente**: `5002300df61aad5444fbb64b25b5f1bdce3ade6fe166f172a5cf0a649c2b9a73`
- Tipo esperado: `pg_dump -Fc`; índice `pg_restore -l`, **1.923 entradas según el reporte anterior**.
- Evidencias QA esperadas: `/opt/backups/call03b2-qa/evidence/call03b23/` y las previas de `call03-closeout/`.

Que el checksum coincida **no acredita restaurabilidad** ni que las 18 sesiones históricas no hayan cambiado. La restaurabilidad necesita una prueba de restauración en destino efímero aislado, con autorización separada.

**Huella histórica:** un reporte anterior menciona prefijo `2c004078…` de las 18 sesiones previas. **No disponemos del hash completo ni de su serialización/orden canónico**. Buscar primero el comando, manifiesto o archivo de evidencia que lo generó; jamás fabricar una comparación basada solamente en el prefijo.

## C. Migración GitHub que faltaba en la VPS: no es necesario descargarla para inspeccionar el esquema

- Archivo publicado: [`20261201000000_whatsapp_call_terminal_reservation.sql`](../supabase/migrations/20261201000000_whatsapp_call_terminal_reservation.sql), en el PR [#144](https://github.com/AlexisCasas/wacrm/pull/144).
- Nuevas columnas en `public.whatsapp_call_sessions`: `terminal_request_id`, `terminal_action`, `terminal_actor_user_id`, `terminal_status`, `terminal_reserved_at`, `terminal_updated_at`.
- Constraint: `whatsapp_call_terminal_reservation_shape_ck`.
- RPC nuevas (signaturas exactas):
  - `public.whatsapp_call_terminal_reserve(uuid,text,text,uuid,uuid,text,text,timestamptz)`
  - `public.whatsapp_call_terminal_finish(uuid,text,text,uuid,uuid,text)`
- Sobrescribe RPC existentes: `whatsapp_call_claim`, `whatsapp_call_release`, `whatsapp_call_session_agent_sdp_store`.
- Privilegios: RPC nuevas ejecutables solo por `service_role` (no `anon` ni `authenticated`).

**Inspección read-only:** consultar `information_schema.columns`, `pg_constraint`, `to_regprocedure` y `has_function_privilege` con SQL SELECT, identificando primero DB QA. No hace falta poseer el archivo local para estas verificaciones. Esperado: columnas y RPC de 00005 **ausentes**, no presumirlo antes de consultar.

## D. Producción: cambio paralelo requiere atribución

Según reporte: `wacrm-app-1` se reemplazó a las **15:29 UTC del 21/nov/2026**, rotación `wacrm-app-1-prev-20261121T152922Z` y tag `wacrm-app:p0-parity-4e1b7b8-ocr`. No corresponde al último tag consignado en el cierre anterior.

Confirmar sin afectar servicio:
- Quién inició la rotación (registro de herramienta/operador, journal o artefactos operativos disponibles).
- SHA/digest/labels de imagen actual y anterior, health, 0 reinicios/OOM.
- Si el cambio fue autorizado en otro trabajo de WACRM y si impacta algún plan de despliegue futuro.
- El prefijo `4e1b7b8` coincide en GitHub con el commit [`4e1b7b8bc1173363a3f9832c8d6aab0e81883d35`](https://github.com/AlexisCasas/wacrm/commit/4e1b7b8bc1173363a3f9832c8d6aab0e81883d35), cuyo asunto es una corrección de **OCR de Destino e importes**, no de Calling. Esta coincidencia de tag **no prueba** el contenido de la imagen ni quién ordenó el deploy; verificar OCI label/digest en VPS.
- No inferir que el despliegue fue originado por este PR ni revertirlo sin autorización.

## E. Artefacto QA: diseño provisional, **no ejecutar**

`Dockerfile` necesita en build `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL` y `NEXT_PUBLIC_APP_LOCALE`; los valores deben corresponder exclusivamente al **QA Supabase/Auth/REST** y sitio QA (jamás production). No imprimir valores ni credenciales; contrastar por fingerprints y pertenencia al stack.

El workflow [`wacrm-candidate-image.yml`](../.github/workflows/wacrm-candidate-image.yml) solo empaqueta el SHA actual de `main` usando configuración de producción. **No ejecutarlo ni reutilizarlo para el Draft #144.**

Propuesta para diseño posterior: workflow QA separado, exclusivo para un commit SHA exacto de PR conocido, entorno y variables QA verificadas, Docker `linux/amd64`, exportación a artefacto `docker save` con `SHA256SUMS` y manifest `DEPLOYED=false`, sin `docker push`, Vercel, secrets de servidor, acceso a la VPS ni despliegue. La validación de configuración QA y revisión de seguridad preceden a habilitar dicho workflow. No se aprueba el build mientras falte esa información.

## F. Estado y próxima solicitud

| Bloqueo | Respuesta necesaria (solo lectura) | Aceptación |
|---|---|---|
| BKP-ROOT | `sudo -n` limitado para listar archivos root, comparar SHA256 y validar índice `pg_restore -l` | Coincide dump anterior y se conoce ruta/criterio para restauración aislada |
| HIST-18 | Localizar reporte `2c004078…` y el SQL/método de hash original o snapshots comparables | Hash completo + algoritmo y orden reproducibles, o comparación desde respaldo anterior |
| DB-00005 | Consultar metadata de seis columnas, constraint, dos RPC y ACL en BD QA | Ausencia documentada, no SQL ejecutado de migración |
| BUILD-QA | Identificar procedencia de los cuatro parámetros NEXT_PUBLIC usados al compilar el candidato QA anterior, sin imprimirlos | Factible empaquetar SHA exacto con identidad QA y sin claves productivas |
| PROD-ROTATION | Identificar operador/artefacto que causó rotación 15:29Z | Cambio explicado, no modificar servicio |

**Bloqueo adicional de software (independiente de preflight):** carrera `accept` ya en vuelo versus `terminate` reservado; y mismo agente/dos pestañas. No autorizar merge ni piloto real hasta cerrar sus gates.

`CALL03B25_VPS_PREFLIGHT=BLOCKED` — **NO** migración, backup nuevo, Docker build, despliegue, merge ni activación Meta por este reporte.
