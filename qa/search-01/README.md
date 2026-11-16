# SEARCH-01 — Runbook de QA para RPC de búsqueda (PR #124)

**Estado V2:** primera ejecución QA con 68 PASS / 1 FAIL (timeout del caso de 12.000). Se corrigió el código en GitHub para usar keyset; falta repetir el QA. Los recursos propios `search01-rpcqa` permanecen **detenidos** con datos ficticios. No tocar WACRM productivo ni QA115.

## 0. Alcance y seguridad

- Git base #120: `30244a76c84eecf63ba9a1bc91967ca2b59ee5fd`; candidato #124: leer su HEAD actual desde GitHub.
- El archivo `qa/search-01/search_inbox_conversations.rpc.sql` es **un borrador**; no instalarlo en el Postgres productivo. En QA, usar un nombre de migración generado por la versión instalada de la CLI y validar la cronología.
- No reutilizar las configuraciones/secretos de `qa115` ni de `/opt/apps/supabase`. No copiar datos reales.
- Todo elemento QA debe llevar nombre/prefijo y etiquetas inequívocas `search01-rpcqa`; guardar un manifiesto con los IDs de los contenedores, redes y volúmenes creados. No publicar puertos en `0.0.0.0`; usar `127.0.0.1` solamente o acceso por red local privada sin publicación.
- No aceptar la ausencia de RLS por omisión. Ejecutar consultas con un JWT de `authenticated` de QA; nunca con `service_role`.
- El objetivo es medir el **efecto de la RPC y, por separado, de los índices**; una misma imagen PostgreSQL, esquema, cuentas, datos, configuración y carga se usan para ambos brazos A/B.
- Sin autorización expresa de despliegue o migración productiva, todo queda en QA y repositorio. Parar antes de crear contenedores si el preflight de capacidad/aislamiento no es PASS.

## 1. Preflight VPS (solo lectura)

1. Verificar `docker ps -a`, `docker network ls`, `docker volume ls`, `docker system df -v`, `free -h`, `df -h` y carga actual.
2. Verificar que `search01-rpcqa-pg`, `search01-rpcqa-rest`, `search01-rpcqa-pgdata` y la red pertenecen **exactamente al QA sintético preservado de la primera ejecución**. Confirmar IDs y etiquetas del manifiesto de Claude. Si no coinciden, detenerse; no recrear/editar objetos desconocidos. QA115 permanece detenido y sin cambios.
3. Identificar imágenes disponibles (Postgres 17 y PostgREST 14.17), versión/digest y puertos ocupados. Usar referencias de imagen verificadas o digests; no hacer `pull` automático.
4. Inspeccionar solo el código/migraciones de GitHub para identificar el esquema **exacto que la RPC necesita**. No considerar equivalentes políticas RLS simplificadas sin un cotejo explícito con las políticas de WACRM.

## 2. Diseño del stack QA (solo recursos exclusivos)

- Contenedores: PostgreSQL y PostgREST de QA, red propia sin rutas a redes de producción. Puerto PostgREST solo en loopback; PostgreSQL sin publicación de puerto.
- Límite inicial candidato: PostgreSQL 768 MiB RAM / 1 CPU; PostgREST 256 MiB RAM / 0,5 CPU (revisar con preflight y evidencias, no asumir consumo anterior). `restart: no`, sin privilegios adicionales ni montajes de host de producción.
- Secretos **nuevos y exclusivos** en directorio fuera de `/tmp` con permisos restrictivos; no subir ni mostrar contraseñas, JWT, `.env` o registros de contacto.
- Volumen nuevo, único para datos ficticios, y archivos de configuración propios. Registrar IDs exactos y rutas para limpieza futura.
- Si no hay forma de replicar el contrato de roles `authenticated`, `anon`, `auth.uid()`, `is_account_member`, RLS de contactos/conversaciones/contact_tags y relaciones de tags, **no declarar el QA representativo**. Parar y documentar qué falta.

## 3. Contrato SQL, PostgREST y RLS

La consulta de la RPC y las dos ramas antiguas deben ejecutarse a través de la misma API PostgREST, con sesiones `authenticated` separadas para dos cuentas QA (A/B).

### Verificación de seguridad SQL (QA solamente)

```sql
SELECT p.oid::regprocedure AS signature, p.prosecdef AS security_definer
FROM pg_proc AS p
WHERE p.oid = to_regprocedure('public.search_inbox_conversations_page(text,timestamp with time zone,uuid,integer)');

SELECT
  has_function_privilege('anon', 'public.search_inbox_conversations_page(text,timestamp with time zone,uuid,integer)', 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', 'public.search_inbox_conversations_page(text,timestamp with time zone,uuid,integer)', 'EXECUTE') AS authenticated_can_execute;

SELECT n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('conversations', 'contacts', 'contact_tags')
ORDER BY c.relname;
```

**Expected:** `security_definer = false`, `anon_can_execute = false`, `authenticated_can_execute = true`, RLS habilitado en las tres tablas y políticas aplicables a las cuentas de QA. Comprobar también que un JWT inexistente/malformado y la ausencia de sesión no permiten recuperar chats.

Probar la respuesta exacta a `rpc('search_inbox_conversations_page', { p_search: term, p_cursor_last_message_at: null, p_cursor_id: null, p_page_size: 1000 }).select(INBOX_CONVERSATION_SELECT)`: `id`, `contact` y `contact_tags` con forma compatible con `normalizeConversations`. Una prueba que solamente consulta `SELECT * FROM public.search_inbox_conversations(...)` **no valida** el embed de PostgREST.

### Casos de paridad obligatorios

- Búsqueda por nombre, teléfono parcial y exacto, teléfono almacenado con guiones/espacios, `wa_username` y último mensaje.
- Solo coincidencia en `last_message_text` numérico; BSUID sin número; contacto bloqueado excluido.
- 0, 1, 10, 1000, 1001, 10000+ coincidencias; empates `last_message_at` alrededor de los cortes de página.
- Etiquetas, compañía, estado y orden; ninguna fila de cuenta B en búsquedas de cuenta A.
- Términos con espacios, comillas, `%`, `_`; distinguir coincidencias SQL y filtro visible del navegador. **Reportar** cambios semánticos, no ocultarlos.
- Si la igualdad de `phone_normalized` descubre una coincidencia **adicional** respecto al #120, documentarlo como cambio intencional y revisar que no se pierde por el filtrado del cliente.
- La prueba de seguridad debe verificar que el ID de contacto y su `account_id` coinciden con los de la conversación.

## 4. Benchmark A/B

1. Al menos 5 calentamientos + 25 muestras por escenario y versión, alternando el orden #120 / #124.
2. Conservar la misma configuración (imágenes, CPU, RAM, roles, RLS, filas, índices, warm cache) entre variantes.
3. Registrar p50/p95, peticiones HTTP, bytes transferidos, errores, cancelaciones, CPU y memoria. No registrar texto real de búsqueda ni números de contacto; utilizar solo términos sintéticos.
4. Analizar `EXPLAIN (ANALYZE, BUFFERS)` **solo en QA**, con usuario y contexto RLS comparables. Medir tanto el predicado sin índices nuevos como una variante experimental con índices `pg_trgm`, sin extrapolar esta última a producción.
5. Evaluar búsquedas típicas de número (1 coincidencia) y términos amplios (10.000+). No declarar mejora por el solo hecho de reducir la cantidad de llamadas.
6. Umbral propuesto de decisión: paridad de IDs y visibilidad **sin regresiones**; mejora clara y repetible de p95 en teléfono (objetivo provisional >=20%), y ninguna regresión de p95 >10% en escenarios comunes. Si no se demuestra, **NO-GO**.

## 5. Evidencia, decisiones y desmontaje

- Guardar `REPORT.md` y métricas anonimizadas, con SHA exacto de ambos PRs, configuración, tamaños de datos y límites de recursos. Registrar explícitamente qué comprobaciones fueron aproximaciones y cuáles validaron PostgREST con RLS real.
- En QA: se permite corregir scripts/fixtures que solo afecten esa instancia, pero ninguna mutación de producción.
- Detener el stack QA al terminar. **No eliminar el volumen/configuración/secretos** antes de confirmar que la evidencia necesaria está guardada y obtener autorización de limpieza; no borrar recursos ajenos ni realizar `docker system prune`.
- Si RLS, paridad, URLs o función PostgREST fallan, detener el benchmark, reportar FAIL y entregar el mínimo cambio de código necesario para un PR correctivo.


## Segunda iteración V2: ejecución recomendada (sin producción)

**Precedente:** en primera QA, 12.000 conversaciones con el mismo `last_message_at` dispararon `57014 statement_timeout` en la RPC V1 por `OFFSET`; 68 de 69 controles de seguridad/función fueron PASS. La ruta #120 perdió 73 IDs porque usaba `ORDER BY last_message_at DESC` sin desempate. El benchmark se detuvo sin 25 muestras; sus tiempos eran orientativos.

### 1. Código

- Actualizar exclusivamente worktree `/home/deploy/wacrm-qa-pr124` al SHA vigente del PR #124, verificando árbol limpio. Mantener CI con placeholders y `NEXT_PUBLIC_SEARCH01_INBOX_RPC=false`.
- Ejecutar `npm run typecheck`, `npm run lint`, `npx vitest run src/lib/inbox/search-rpc.test.ts src/components/inbox/conversation-list.test.tsx`, `npm test`, y build con las mismas variables ficticias de `.github/workflows/ci.yml`. Las pruebas anteriores correspondían a la V1; **no reutilizar resultados antiguos como PASS de V2**.

### 2. SQL en la QA existente

- Identificar los recursos propios **ya existentes y detenidos**. Verificar UUID/labels/red/puerto y que las credenciales estén aisladas. Reanudar solamente `search01-rpcqa-pg` y `search01-rpcqa-rest`, **tras cotejar manifest y capacidades**. No crear un stack nuevo; no iniciar QA115.
- Instalar **solo en esta QA** el SQL V2 de `qa/search-01/search_inbox_conversations.rpc.sql`. La función V2 se llama `search_inbox_conversations_page`, distinta de la V1: no sobreescribir la función vieja. Recargar caché PostgREST en QA.
- Confirmar firma, `SECURITY INVOKER`, `GRANT authenticated`, `REVOKE anon`, e imposibilidad de consultar cross-tenant con JWT y RLS reales. Probar el mismo embed de contactos y etiquetas.
- Control de página: verificar `p_page_size <= 1000` aunque se solicite 1500; nulidad `last_message_at`; 1.000, 1.001 y 12.000 filas; 12.000/12.000 IDs únicos con empates; el cursor debe avanzar sin repetir IDs, aun tras terminar página completa.
- Verificar que la ruta tradicional del mismo commit con `ORDER BY last_message_at DESC, id ASC` ya no pierde los 73 IDs originales. Comparar en cuenta A y B con los filtros y límites reales de QA.
- El primer control `57014`, pérdida de IDs, error SQL de firma o fuga entre tenants implica **FAIL inmediato, detener el benchmark**, conservar logs y no tocar producción.

### 3. Análisis de rendimiento en dos brazos claramente separados

**A. SIN índices nuevos:** repetir diagnósticos de un solo disparo por escenario para detectar timeout. Si todos los gates funcionales pasan, medir cinco calentamientos y 25 muestras por caso y versión, con recurso fijo y sin resembrar. Registrar p50/p95, HTTP requests, bytes y `EXPLAIN (ANALYZE, BUFFERS)` del rol autenticado de QA.

**B. CON índices experimentales, solo si A indica scans costosos:** ejecutar `qa/search-01/EXPERIMENT_ONLY_trgm.sql` **únicamente en la QA sintética** y repetir mediciones. El script añade `pg_trgm`, índices GIN en nombre, teléfono, `wa_username` y último mensaje, y un B-tree por tenant/cursor. Distinguir mejora de p95 por índices frente a mejora por keyset. Un índice que el optimizador ignore no cuenta como solución.

**No extrapolar** tiempos de una VPS limitada a producción sin planes SQL y datos realistas; no habilitar flag ni cambiar índices productivos con esta autorización. Detener los dos contenedores QA al terminar y mantener volumen/secretos/configuración para revisión y limpieza autorizada.
