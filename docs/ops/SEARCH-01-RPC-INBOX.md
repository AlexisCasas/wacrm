# SEARCH-01 — RPC de búsqueda de Inbox (candidato, sin despliegue)

Fecha: 2026-11-16. Base: PR #120 (`30244a76c84eecf63ba9a1bc91967ca2b59ee5fd`). El PR #121 (ID-first) está **cerrado sin merge**, tras revisión del costo de hidratación.

## Alcance de este incremento

- SQL candidato de `public.search_inbox_conversations(p_search text)`: `qa/search-01/search_inbox_conversations.rpc.sql`. **No es una migración aplicada**.
- Devuelve `SETOF public.conversations` para conservar la proyección `INBOX_CONVERSATION_SELECT` y poder incrustar `contacts!inner` con etiquetas mediante PostgREST.
- Unifica por servidor los criterios: `contacts.name`, `contacts.phone`, `contacts.wa_username` y `conversations.last_message_text`. Agrega igualdad exacta con `contacts.phone_normalized` solo para entradas de aspecto telefónico con al menos 7 dígitos; nunca sustituye la búsqueda previa de mensajes.
- Bloquea resultados de contactos con `blocked = true`; exige `contacts.account_id = conversations.account_id`, usa `SECURITY INVOKER` y conserva **RLS** de ambas tablas. Solo la función `authenticated` tiene permiso EXECUTE (no `PUBLIC` ni `anon`).
- Paginación completa por `last_message_at DESC, id ASC`; sin límite artificial de 1.000 resultados; preserva carga completa de conversaciones/etiquetas para filtros y callbacks.
- Activación controlada a través de la **variable de build** `NEXT_PUBLIC_SEARCH01_INBOX_RPC=true`. **Por defecto desactivada**; el algoritmo del PR #120 continúa funcionando sin cambios. No habilitar hasta instalar la función en QA, validar su RLS y medir.
- Tests unitarios en `src/lib/inbox/search-rpc.test.ts` para contrato de peticiones y búsqueda normalizada.

## Dependencias antes de cualquier migración

1. Restaurar una **QA WACRM nueva, dedicada y desechable**; la QA de SEARCH-01 anterior fue retirada. No utilizar `qa115` ni Supabase/DB de producción sin permiso.
2. Confirmar el esquema de producción a reproducir, las migraciones aplicadas y el orden cronológico. Hay migraciones con nombres fechados hasta `20261125000000` en el repositorio: evitar insertar fuera de orden una migración nueva.
3. En el checkout de QA, usar la CLI instalada y `supabase migration new <nombre_descriptivo>` para generar **el nombre real** de la migración, copiar el SQL candidato y comprobar la secuencia con `supabase migration list`. Esta rama conserva solo un borrador SQL porque no se ha ejecutado la CLI ni se ha autorizado DDL.
4. Aplicar la migración solamente en QA autorizada y refrescar el caché de PostgREST (`NOTIFY pgrst, 'reload schema'`).
5. Antes de consultar datos, inspeccionar `pg_proc.prosecdef` (debe ser false), `has_function_privilege` para `anon` (false) y `authenticated` (true), RLS de `conversations` y `contacts`, acceso cruzado entre dos cuentas sintéticas, contact blocked y contacto BSUID con teléfono vacío.

## Gates funcionales (fail closed)

- [ ] Un usuario de cuenta A nunca ve chats, contactos ni etiquetas de cuenta B, con o sin búsqueda.
- [ ] `anon` no ejecuta la RPC; `authenticated` con RLS solo ve sus conversaciones.
- [ ] Búsqueda por nombre, teléfono parcial/completo, `wa_username`, número solo en último mensaje, BSUID sin teléfono, etiquetas, compañía y estado.
- [ ] Teléfono con formato `+51 981 629 790` coincide al buscar los 11 dígitos exactos y no se inventan identidades para BSUID.
- [ ] Más de 1.000 coincidencias y timestamps idénticos en el borde de página: comparar IDs visibles entre versiones y comprobar orden estable.
- [ ] Cancelaciones y cambios rápidos de término no dejan respuestas antiguas visibles.
- [ ] Parámetros con comillas, espacios, `%` y `_` no permiten inyección (la RPC usa parámetros y SQL sin ejecución dinámica); documentar semántica actual de comodines.
- [ ] Los cambios de `contacts.blocked` siguen ocultando conversaciones; no se ejecuta ninguna escritura.
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` PASS en el commit exacto.

## Gate de rendimiento

Comparar el cliente del PR #120 con RPC sobre el **mismo QA** y las mismas filas sintéticas: al menos cinco warmups y 25 muestras A/B para búsquedas de 1, 10, 1.000, 10.000 y 20.000 coincidencias; al menos un caso de teléfono completo y uno de teléfono parcial. Registrar **p50/p95**, cantidad de peticiones, bytes, CPU, planes `EXPLAIN (ANALYZE, BUFFERS)` **solo en QA**, y paridad de IDs bajo RLS. Objetivo inicial p95 teléfono >=20% más rápido, sin regresiones >10% en otras búsquedas.

**Riesgo conocido:** `ILIKE '%término%'` aún puede hacer sequential scans; una RPC no soluciona automáticamente índices ausentes. Evaluar `pg_trgm` para nombre, teléfono, `wa_username` y último mensaje, y las estadísticas/índices de pertenencia, **en un PR y migración separados**, antes de afirmar mejora.

## Orden futuro de activación (pendiente de autorización)

1. Validación de SQL en QA desechable + build y pruebas frontend.
2. Plan aprobado para índices/medición, respaldo y rollback.
3. Migración aditiva autorizada y recarga de esquema en destino controlado.
4. Build con variable `NEXT_PUBLIC_SEARCH01_INBOX_RPC=true`, prueba canary y postchecks.
5. Si fallan p95, RLS o paridad, desactivar flag por rollback del build y conservar la ruta anterior.

## Contactos queda fuera de este incremento

Contactos tiene una ruta especial para seleccionar y borrar *todos los coincidentes*, además de dos RPC ya existentes con filtro por etiquetas y tiempo. Activar criterios ampliados solo en la lista sin actualizar esa selección/borrado podría causar discrepancias en operaciones destructivas. Su RPC debe diseñarse y probarse en un incremento independiente que reutilice **exactamente el mismo predicado de búsqueda en la lista, el conteo y la selección masiva**. No modificar contactos en este PR.

**No aprobado:** migraciones, SQL en servidor, índices, merge o despliegue. PR de código exclusivamente.
