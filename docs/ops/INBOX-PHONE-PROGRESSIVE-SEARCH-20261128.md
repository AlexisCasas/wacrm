# WACRM — Inbox phone progressive search fix

**Fecha:** 2026-11-28  
**Base productiva:** `0c4e88bb0d52eac69a944a38c3d662f97d2425c4`  
**Candidato:** `d0c5220935e2f40ba52ef7bd6ceb34099e4b1c37`

## Problema observado

Al buscar un número completo en el Inbox (ejemplo observado en video: `51942309277`), WACRM podía mostrar:

> No se encontraron conversaciones

aunque la conversación existiera.

La búsqueda de `contacts` ya normalizaba teléfonos, pero el fallback mediante `order_confirmations` comparaba `phone` por igualdad literal. Un histórico como `+51 942-309-277` no coincidía con `51942309277`.

Además, el fallback recorría una única consulta amplia y no implementaba la estrategia progresiva acordada.

## Solución

La búsqueda visible para el usuario NO cambia.

Para un teléfono completo:

1. buscar primero contacto normalizado dentro de la cuenta actual;
2. si se encuentra, devolverlo sin consultar histórico de pedidos;
3. si no se encuentra, buscar por teléfono normalizado en pedidos, progresivamente:
   - últimos 15 días;
   - 15–30 días;
   - 30–90 días;
   - 90–180 días;
   - 180–365 días;
   - histórico anterior;
4. detener la búsqueda en la primera ventana con coincidencia;
5. resolver `contact_id -> conversation`, nunca confiar en un `conversation_id` histórico del pedido.

Todo ocurre en segundo plano.

## Normalización

La función SQL `order_phone_digits(phone)` elimina cualquier carácter no numérico.

Por tanto son equivalentes:

- `+51 942-309-277`
- `51 942 309 277`
- `51942309277`

El índice por `account_id + phone normalizado + confirmed_at` evita recorrer todos los pedidos.

## Aislamiento

- Todas las consultas usan el `accountId` actual.
- El RPC es `SECURITY INVOKER`; conserva RLS.
- No usa service role.
- No acepta account desde la UI como fuente de autoridad.
- No mezcla conversaciones de otras cuentas.

## Alcance

Solo:
- Inbox search;
- helper de búsqueda;
- tests;
- migration de soporte de lectura/búsqueda.

No toca:
- unread/read;
- mensajes;
- WhatsApp;
- Flows;
- Cobranza;
- Pedidos confirmados;
- plantillas;
- Shalom;
- datos de negocio.

## Migration

`20261205000007_inbox_phone_progressive_search.sql`

Agrega:
- helper immutable de normalización;
- índice de búsqueda;
- RPC de solo lectura.

No modifica datos existentes.


## Robustez adicional de Contacts

Se añadió una segunda ruta exacta para teléfonos completos que normaliza directamente `contacts.phone` con `regexp_replace`.

Esto cubre registros históricos donde:
- `phone_normalized` está vacío;
- `phone_normalized` quedó desactualizado;
- `phone` contiene espacios, guiones, paréntesis o `+51`.

Ejemplo equivalente:
- `+51 942-309-277`
- `51942309277`
- `942309277`

Orden definitivo para un teléfono completo:
1. búsqueda normal existente;
2. contacto por `contacts.phone` normalizado;
3. si aún no existe coincidencia, pedidos históricos por ventanas progresivas.

El usuario no ve ninguno de estos pasos.


## V2 — causa real confirmada

Para `51942309277`, el contacto es BSUID y no tiene teléfono en contacts. El número existe en `order_confirmations.phone` y la conversación sí existe.

La falla era de composición: la rama de pedidos encontraba el contacto, pero las búsquedas anchas por contacto/mensaje podían dar timeout/500 y, al ejecutarse juntas, descartaban el resultado correcto.

V2 resuelve teléfonos completos en este orden:
1. contacto exacto indexado por `phone_normalized`;
2. pedidos por ventanas progresivas;
3. si alguno encuentra conversación, devuelve inmediatamente;
4. solo sin match exacto corre la búsqueda ancha.

La RPC de contactos reutiliza `idx_contacts_account_phone_normalized`; no crea índice de expresión en contacts.


## Estado final pre-deploy

- Producción actual: `0c4e88bb0d52eac69a944a38c3d662f97d2425c4`
- Imagen actual: `wacrm-app:cobranza-filters-0c4e88bb`
- Candidato final remoto: `186d388a76bdb3b824ee508fa1860a8bb1852a8e`
- Rama: `fix/inbox-phone-progressive-search-20261128`
- Estado: **READY FOR DEPLOY**
- Ahead / behind: 7 / 0
- Merge-base: producción exacta `0c4e88bb...`

Validación final:
- 467/467 tests PASS, dos pasadas
- 52/52 tests de comportamiento PASS
- release-manifest PASS
- migration-ledger verify OK
- typecheck PASS
- lint 0 errores
- build PASS

Alcance del deploy:
- solo búsqueda por número completo en Inbox;
- búsqueda por nombre/texto preservada;
- unread/read sin cambios;
- no toca Cobranza, Flows, WhatsApp send, Shalom, Calling, plantillas, Caddy ni crons.

Orden obligatorio:
1. aplicar únicamente `20261205000007_inbox_phone_progressive_search.sql`;
2. validar RPCs/índice/caso real;
3. desplegar el SHA exacto `186d388a...`;
4. verificar en producción el caso `51942309277`.

No marcar como cerrado hasta obtener `DEPLOY PASS`.
