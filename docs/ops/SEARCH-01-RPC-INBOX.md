# SEARCH-01 — RPC de búsqueda de Inbox (candidato, sin despliegue)

Fecha: 2026-11-16. Base: PR #120 (`30244a76c84eecf63ba9a1bc91967ca2b59ee5fd`). El PR #121 (ID-first) está **cerrado sin merge**, tras revisión del costo de hidratación.

## Alcance de este incremento

- SQL candidato V2 de `public.search_inbox_conversations_page(p_search text, p_cursor_last_message_at timestamptz, p_cursor_id uuid, p_page_size integer)`: `qa/search-01/search_inbox_conversations.rpc.sql`. **No es una migración aplicada en producción**. Se renombró la función para que no choque con la V1 de `OFFSET` instalada únicamente en QA.
- Devuelve `SETOF public.conversations` para conservar la proyección `INBOX_CONVERSATION_SELECT` y poder incrustar `contacts!inner` con etiquetas mediante PostgREST.
- Unifica por servidor los criterios: `contacts.name`, `contacts.phone`, `contacts.wa_username` y `conversations.last_message_text`. Agrega igualdad exacta con `contacts.phone_normalized` solo para entradas de aspecto telefónico con al menos 7 dígitos; nunca sustituye la búsqueda previa de mensajes.
- Bloquea resultados de contactos con `blocked = true`; exige `contacts.account_id = conversations.account_id`, usa `SECURITY INVOKER` y conserva **RLS** de ambas tablas. Solo la función `authenticated` tiene permiso EXECUTE (no `PUBLIC` ni `anon`).
- Paginación **keyset** dentro del SQL con `last_message_at DESC NULLS LAST, id ASC`; cada página devuelve como máximo 1.000 conversaciones y se continúa con el cursor de la última. No hay límite total de 1.000 resultados. La ruta tradicional también ordena por `id` para evitar saltarse filas cuando varias comparten hora.
- Activación controlada a través de la **variable de build** `NEXT_PUBLIC_SEARCH01_INBOX_RPC=true`. **Por defecto desactivada**; el algoritmo del PR #120 continúa funcionando sin cambios. No habilitar hasta instalar la función en QA, validar su RLS y medir.
- Tests unitarios en `src/lib/inbox/search-rpc.test.ts` para contrato de peticiones y búsqueda normalizada.

## Dependencias antes de cualquier migración

1. Reutilizar exclusivamente la **QA WACRM `search01-rpcqa` ya creada y preservada**, si el preflight verifica sus IDs, red, volumen, roles y datos ficticios. Su Postgres y PostgREST quedaron detenidos tras una primera ejecución con 68 PASS / 1 FAIL. No utilizar `qa115` ni Supabase/DB de producción.
2. Confirmar el esquema de producción a reproducir, las migraciones aplicadas y el orden cronológico. Hay migraciones con nombres fechados hasta `20261125000000` en el repositorio: evitar insertar fuera de orden una migración nueva.
3. En el checkout de QA, usar la CLI instalada y `supabase migration new <nombre_descriptivo>` para generar **el nombre real** de la migración, copiar el SQL candidato y comprobar la secuencia con `supabase migration list`. Esta rama conserva solo un borrador SQL porque no se ha ejecutado la CLI ni se ha autorizado DDL.
4. Aplicar la migración solamente en QA autorizada y refrescar el caché de PostgREST (`NOTIFY pgrst, 'reload schema'`).
5. Antes de consultar datos, inspeccionar `pg_proc.prosecdef` (debe ser false), `has_function_privilege` para `anon` (false) y `authenticated` (true), RLS de `conversations` y `contacts`, acceso cruzado entre dos cuentas sintéticas, contact blocked y contacto BSUID con teléfono vacío.

## Gates funcionales (fail closed)

- [ ] Un usuario de cuenta A nunca ve chats, contactos ni etiquetas de cuenta B, con o sin búsqueda.
- [ ] `anon` no ejecuta la RPC; `authenticated` con RLS solo ve sus conversaciones.
- [ ] Búsqueda por nombre, teléfono parcial/completo, `wa_username`, número solo en último mensaje, BSUID sin teléfono, etiquetas, compañía y estado.
- [ ] Teléfono con formato `+51 981 629 790` coincide al buscar los 11 dígitos exactos y no se inventan identidades para BSUID.
- [ ] Más de 1.000 y 12.000 coincidencias con timestamps idénticos, además de la transición a `last_message_at IS NULL`: comprobar IDs únicos (12.000/12.000), orden estable, terminación del cursor y ninguna página vacía prematura.
- [ ] Cancelaciones y cambios rápidos de término no dejan respuestas antiguas visibles.
- [ ] Parámetros con comillas, espacios, `%` y `_` no permiten inyección (la RPC usa parámetros y SQL sin ejecución dinámica); documentar semántica actual de comodines.
- [ ] Los cambios de `contacts.blocked` siguen ocultando conversaciones; no se ejecuta ninguna escritura.
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` PASS en el commit exacto.

## Gate de rendimiento

Comparar el cliente del PR #120 con RPC sobre el **mismo QA** y las mismas filas sintéticas: al menos cinco warmups y 25 muestras A/B para búsquedas de 1, 10, 1.000, 10.000 y 20.000 coincidencias; al menos un caso de teléfono completo y uno de teléfono parcial. Registrar **p50/p95**, cantidad de peticiones, bytes, CPU, planes `EXPLAIN (ANALYZE, BUFFERS)` **solo en QA**, y paridad de IDs bajo RLS. Objetivo inicial p95 teléfono >=20% más rápido, sin regresiones >10% en otras búsquedas.

**Riesgo conocido:** keyset elimina el incremento de `OFFSET` y corrige los empates, pero **NO elimina la reevaluación de `ILIKE '%término%'` y RLS en cada petición**. En QA V1, con 12.000 coincidencias, el servidor devolvió un `57014 statement_timeout` al paginar; antes de continuar, validar que V2 no repita el fallo. Evaluar `pg_trgm` y el plan SQL exclusivamente en QA, como experimento separado y controlado. No prometer mejora solo por cambiar la paginación.

## Orden futuro de activación (pendiente de autorización)

1. Validación de SQL en QA desechable + build y pruebas frontend.
2. Plan aprobado para índices/medición, respaldo y rollback.
3. Migración aditiva autorizada y recarga de esquema en destino controlado.
4. Build con variable `NEXT_PUBLIC_SEARCH01_INBOX_RPC=true`, prueba canary y postchecks.
5. Si fallan p95, RLS o paridad, desactivar flag por rollback del build y conservar la ruta anterior.

## Contactos queda fuera de este incremento

Contactos tiene una ruta especial para seleccionar y borrar *todos los coincidentes*, además de dos RPC ya existentes con filtro por etiquetas y tiempo. Activar criterios ampliados solo en la lista sin actualizar esa selección/borrado podría causar discrepancias en operaciones destructivas. Su RPC debe diseñarse y probarse en un incremento independiente que reutilice **exactamente el mismo predicado de búsqueda en la lista, el conteo y la selección masiva**. No modificar contactos en este PR.

**No aprobado:** migraciones, SQL en servidor, índices, merge o despliegue. PR de código exclusivamente.


## Evidencia de QA V1 y correctivo V2 (16/11/2026)

QA V1 reportada por Claude Desktop: RLS/tenants/embeds/BSUID y criterios básicos **68 PASS**, caso amplio **1 FAIL**: 12.000 coincidencias con timestamp empatado y un `statement_timeout` de 8 s. La ruta #120 perdió 73 IDs (11.927/12.000) por falta de desempate al usar `OFFSET`. RPC V1 repetía un escaneo costoso para cada página; ejemplo de ~52 s total. Datos de una sola corrida, **no p50/p95**.

V2 desarrollada solo en GitHub:
- SQL distinto `search_inbox_conversations_page` con `p_cursor_id` y `p_cursor_last_message_at` en vez de `OFFSET`, con `LIMIT` interno de 1 a 1.000 y `SECURITY INVOKER`.
- Cliente `fetchInboxSearchViaRpc` que envía cursor, permite avanzar incluso entre miles de timestamps iguales o `NULL`, y falla si una página repite un ID o no avanza.
- Ruta anterior con `ORDER BY last_message_at DESC, id ASC` para no perder resultados en páginas empatadas, aunque conserva el costo de escaneo por página.
- Tests con 12.000 IDs empatados, 1.001 IDs, fechas nulas, errores y repetición malformada; **pendientes de ejecutar en el nuevo HEAD**.

**Estado:** V2 diseñada, RLS/latencia/bulks **NO verificados** tras el correctivo. El `search01-rpcqa` existente permanece detenido con su volumen y solo puede reanudarse tras verificar que es el mismo entorno QA ficticio; no tocar producción. Mantener PR #124 en borrador y flag desactivado.
