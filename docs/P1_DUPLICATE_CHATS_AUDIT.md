# P1 — Auditoría de chats/conversaciones duplicadas

Rama: `fix/p1-duplicate-chats-audit`
HEAD auditado: `4b974877ea172378de3165a0eca3d7c66b4f1583` ("Merge pull request #17 from AlexisCasas/feat/user-language-preference")
Tipo de documento: **solo diagnóstico**. No se modificó código, no se crearon migraciones, no se ejecutó SQL contra producción, no se hizo commit ni push.

> **ACTUALIZACIÓN (2026-09-10)** — Se recibió evidencia productiva decisiva del caso real "Juor Nuevo" que **descarta la hipótesis fuzzy/trunk-prefix como causa de este incidente** y **corrige la conclusión sobre Flow** de la versión anterior de este documento. La causa raíz candidata ahora es una identidad de remitente vacía (`contacts.phone = ''`) que ningún índice actual impide. Ver la sección nueva **Q** para el análisis completo; las secciones A–P se conservan sin editar como registro histórico del primer pase, con notas de corrección puntuales donde aplica.

---

## A. Resumen ejecutivo

El código **actual** de la rama contiene la corrección completa de issue #363/#364 (fragmentación de conversaciones) y de issue #367/#369 (idempotencia de mensajes/webhook). Ambas están respaldadas por índices `UNIQUE` a nivel de PostgreSQL (migraciones 036 y 037), no solo por lógica de aplicación, y la evidencia de producción aportada (0 filas duplicadas en `(account_id, contact_id)`, `(account_id, phone_normalized)` y `(conversation_id, message_id)`, más la existencia de `merge_duplicate_conversations()`, `merge_duplicate_contacts()` y `bump_conversation_on_inbound()` en producción) confirma que al menos esas tres migraciones fueron aplicadas.

Sin embargo, la auditoría del código encontró **una vía de duplicación lógica que sigue abierta hoy** y que no se detecta con las consultas ya ejecutadas: dos contactos con números de teléfono *equivalentes pero no idénticos dígito a dígito* (variante de prefijo troncal, ej. `37063949836` vs `370063949836`) pueden coexistir como dos filas de `contacts` — y por tanto como dos `conversations` distintas — porque:

- el índice `UNIQUE(account_id, phone_normalized)` (migración 022) compara los dígitos **exactos**, sin la tolerancia de `phonesMatch()`;
- dos de las cuatro rutas que crean contactos (alta manual desde el formulario y la importación CSV) **no** aplican `phonesMatch()` de forma bloqueante — solo lo hacen el webhook de Meta, el puente ManyChat y la API pública v1, a través de `findOrCreateContact` / `findExistingContact`.

Esto coincide exactamente con la hipótesis (C) planteada en el encargo, y es independiente de si los duplicados históricos ya fueron saneados (hipótesis D, también verosímil para el reporte original dado el estado limpio de producción).

Adicionalmente, se confirmó una causa **concreta y verificable en código** para el síntoma "no se pudo iniciar un Flow" que no depende de que existan duplicados de conversación *hoy*: la ventana de servicio de 24h en `POST /api/flows/[id]/start` busca el último mensaje del cliente **filtrando solo por `conversation_id`**. Si el hilo abierto en el Inbox es una fragmentación (histórica o producida por el gap de arriba) que no contiene los mensajes reales del cliente, la búsqueda no encuentra nada y el endpoint responde `409 service_window_expired` — el mismo síntoma reportado.

**Conclusión de clasificación (A–E del encargo):**
- Para el **caso reportado específico** (3 mensajes → 3 chats): más probablemente **(D)** datos/artefactos previos a los fixes #363/#364/#367, dado que las claves canónicas actuales (`account_id+contact_id`, `account_id+phone_normalized`, `conversation_id+message_id`) están limpias en producción.
- Para el **riesgo hacia adelante**: la implementación está **(B) parcialmente corregida** — persiste una vía de duplicación lógica vía variantes de teléfono en alta manual y CSV import, que ningún índice único detecta porque produce valores `phone_normalized` legítimamente distintos.
- No se encontró evidencia de (E) (duplicación puramente de frontend); el руidoso candidato más cercano — joins de Supabase/PostgREST en el listado de Inbox — se descartó (ver sección I).

---

## B. Estado actual de la implementación

| Mecanismo | Estado en código actual | Respaldo en BD |
|---|---|---|
| Un contacto por `(account_id, phone_normalized)` exacto | Implementado (`findExistingContact` + insert) | `UNIQUE INDEX idx_contacts_account_phone_normalized` (migración 022) — confirmado con 0 duplicados en producción |
| Un contacto por `phonesMatch()` (variante de troncal) | Implementado **solo** en webhook, ManyChat, API v1, `resolveConversationByPhone` | **No hay respaldo en BD** — imposible de garantizar a nivel constraint porque `phone_normalized` es una columna generada por regex simple |
| Alta manual de contacto (`contact-form.tsx`) | `phonesMatch()` solo **advierte** (no bloquea) en coincidencia difusa; solo bloquea coincidencia exacta | Ninguno más allá del índice exacto |
| Importación CSV (`import-modal.tsx`) | Dedupe **solo exacto** (`normalizeKey`), sin `phonesMatch()` en absoluto | Ninguno más allá del índice exacto |
| Una conversación por `(account_id, contact_id)` | Implementado (`findOrCreateConversation`, oldest-first, sin `.single()`) | `UNIQUE INDEX idx_conversations_account_contact` (migración 036) — confirmado con 0 duplicados en producción |
| Idempotencia de mensajes Meta | Implementado (`upsert` con `onConflict: 'conversation_id,message_id', ignoreDuplicates: true`) | `UNIQUE INDEX idx_messages_conversation_message_id` (migración 037) — confirmado con 0 duplicados en producción |
| Incremento atómico de `unread_count` | Implementado vía RPC `bump_conversation_on_inbound` | Función confirmada presente en producción |
| Manejo de carrera 23505 en contacto/conversación | Implementado en las 3 rutas que usan los helpers compartidos | N/A |
| Flow start — ventana de servicio 24h | Filtra `messages` **solo por `conversation_id`**, no por `contact_id` | N/A (no es un problema de BD, es de alcance de la consulta) |

---

## C. Qué partes del requerimiento YA están resueltas

1. **Identidad de conversación**: `1 account + 1 contact_id ⇒ 1 conversation` está garantizado a nivel de PostgreSQL (índice único, no solo aplicación) desde la migración 036.
2. **Reintentos de Meta no duplican mensajes**: garantizado a nivel de PostgreSQL (índice único `conversation_id, message_id`) desde la migración 037, con `ignoreDuplicates: true` en el `upsert` y un `return` explícito que corta todos los efectos secundarios (`bump_conversation_on_inbound`, flows, automatizaciones, IA, webhooks salientes) cuando la fila insertada viene vacía.
3. **Snowballing histórico** (el bug original de #363, donde `.single()` fallaba con ≥2 filas y creaba una conversación nueva en cada mensaje): eliminado — `findOrCreateConversation` usa `.order(...).limit(1)` en vez de `.single()`/`.maybeSingle()`.
4. **Carrera de creación concurrente** (dos entregas de Meta procesando el mismo contacto/conversación al mismo tiempo): manejada explícitamente vía `isUniqueViolation` + re-resolución a la fila ganadora, en las tres rutas que insertan contactos/conversaciones a través de los helpers compartidos.
5. **Tres rutas de creación de contacto/conversación coinciden en identidad** (webhook, ManyChat, API pública `/api/v1/contacts` y `resolveConversationByPhone`): las cuatro usan literalmente los mismos helpers (`findOrCreateContact`/`findExistingContact`/`findOrCreateConversation`), confirmado por lectura de código, no solo por comentarios.
6. **Cobertura de test para idempotencia**: `route.test.ts` tiene tests dedicados a `#367` ("a genuine first delivery persists once and fans out downstream" / "a replayed delivery is a no-op") y a `#369` (incremento atómico), no solo comentarios.

---

## D. Qué partes NO están resueltas o no pueden demostrarse

1. **Duplicación lógica por variante de teléfono equivalente** (`phonesMatch()` true, `phone_normalized` distinto): posible hoy mismo vía alta manual (aviso no bloqueante) y vía importación CSV (sin aviso ni bloqueo). Ningún índice único la detecta ni la impide, porque por definición genera dos valores de `phone_normalized` distintos.
2. **Estado real de las migraciones en producción**: no existe `supabase_migrations.schema_migrations` en este Supabase self-hosted, y no se encontró ningún mecanismo de tracking alternativo en el repositorio. La evidencia de funciones (`merge_duplicate_conversations`, `merge_duplicate_contacts`, `bump_conversation_on_inbound`) demuestra que **partes** de 022/036/037 corrieron, pero no confirma que los índices `UNIQUE` correspondientes existan, ni que las *definiciones* de esas funciones en producción coincidan con las del repo actual (podrían haber sido creadas/editadas manualmente). Ver sección L para el SQL de verificación pendiente.
3. **Causa raíz del reporte original** (3 mensajes → 3 chats): no puede demostrarse con el código actual por sí solo si el caso era anterior o posterior a los fixes, porque no se dispone de fecha del incidente ni de los IDs de fila involucrados. La evidencia de producción (0 duplicados hoy) es compatible con "ya se corrigió y limpió", pero también con "el contacto real del reporte cae en el gap de la sección D.1" — ambas hipótesis siguen abiertas hasta cruzar el número de teléfono real reportado contra `contacts`.
4. **Vínculo Flow ⇄ fragmentación**: se identificó un mecanismo de código plausible (sección J), pero no se confirmó con el caso real reportado (no se dispuso del `conversation_id` que falló).

---

## E. Mapa webhook → contacto → conversación → mensaje

```
POST /api/whatsapp/webhook
  → verificación de firma HMAC (por whatsapp_config resuelto por phone_number_id/waba_id)
  → after() { processWebhook(body) }   // responde 200 a Meta ANTES de procesar
      for entry in body.entry:
        for change in entry.changes:
          si es evento de plantilla → handleTemplateWebhookChange (rama separada)
          si trae value.statuses  → handleStatusUpdate (actualiza messages.status y broadcast_recipients)
          si trae value.messages:
            whatsapp_config = SELECT * WHERE phone_number_id = X   (config.account_id, config.user_id)
            for i in value.messages:                                // SECUENCIAL, awaited, dentro del mismo payload
              processMessage(message[i], contacts[i] ?? contacts[0], accountId, configOwnerUserId, ...)
                → findOrCreateContact(accountId, phone)             // dedupe fuzzy (phonesMatch)
                → si contact.blocked → record_blocked_inbound() y STOP (nada más se ejecuta)
                → findOrCreateConversation(accountId, contact.id)   // oldest-first, sin .single()
                → si created → dispatchWebhookEvent('conversation.created')
                → si type === 'reaction' → handleReaction() y STOP (no crea fila en messages)
                → parseMessageContent()  // puede mirror-ear media a Storage
                → messages.upsert({ conversation_id, message_id, ... }, { onConflict: 'conversation_id,message_id', ignoreDuplicates: true })
                → si insertedRows vacío → log "duplicate inbound message ignored" y STOP (idempotencia #367)
                → rpc bump_conversation_on_inbound(conversation_id, text)   // unread++ atómico + last_message_*
                → reopenClosedConversation()                                // solo si status = 'closed'
                → flagBroadcastReplyIfAny()
                → dispatchInboundToFlows()            // puede consumir el mensaje
                → runAutomationsForTrigger() * N       // suprimidas si el flow consumió
                → dispatchInboundToAiReply()           // solo si el flow no consumió y hay texto
                → dispatchWebhookEvent('message.received')
```

Puntos de posible carrera **entre payloads distintos** (dos requests HTTP concurrentes, p. ej. un reintento de Meta llegando mientras el `after()` del primero sigue corriendo): están cubiertos por el backstop `isUniqueViolation` tanto en `findOrCreateContact` como en `findOrCreateConversation`. **Dentro de un mismo payload**, el `for` de `value.messages` es secuencial y `await`-ado, así que no hay concurrencia interna que audit.

---

## F. Identidad canónica actual

**Contacto** = `(account_id, phone)`, donde "igual" se define de dos formas distintas según la ruta:
- **Aplicación (fuzzy)**: `phonesMatch()` — igualdad exacta de dígitos, o igualdad de los últimos 8 dígitos (tolerancia de prefijo troncal). Usada por `findExistingContact` (webhook, ManyChat, API v1, `resolveConversationByPhone`).
- **PostgreSQL (exacta)**: `UNIQUE(account_id, phone_normalized)` donde `phone_normalized = regexp_replace(phone, '\D', '', 'g')` — **no** aplica ninguna normalización de prefijo troncal.

**Discrepancia identificada**: la identidad de aplicación es *más amplia* (agrupa más números como "el mismo contacto") que la identidad garantizada por PostgreSQL. Esto es seguro mientras **todas** las rutas de creación pasen por `findExistingContact` antes de insertar — pero dos rutas no lo hacen (alta manual, CSV import; ver sección D.1). El resultado no es una violación de constraint (`23505`) — es una segunda fila válida que la aplicación *habría* fusionado si hubiera consultado con `phonesMatch()`.

**Conversación** = `(account_id, contact_id)`, sin ambigüedad: aplicación y PostgreSQL coinciden exactamente (`UNIQUE INDEX idx_conversations_account_contact`). No hay discrepancia aquí — el riesgo entra únicamente a través de tener dos `contact_id` para lo que un humano considera un solo cliente.

---

## G. Protección contra carreras

- **Contacto**: lookup (`findExistingContact`) → insert → en caso de `23505`, re-lookup y devolver la fila ganadora. Presente en las 3 rutas compartidas. Los dos INSERT directos (`contact-form.tsx`, `import-modal.tsx`) también capturan `23505` (`isUniqueViolation`), pero **solo después de que ya insertaron** — es un manejo de error post-hoc, no una prevención por `findExistingContact` previo, y en el caso fuzzy no hay 23505 que capturar porque el índice no lo detecta.
- **Conversación**: mismo patrón lookup → insert → re-lookup en 23505, en `findOrCreateConversation` y en `resolveConversationByPhone`.
- **Mensaje**: no hay "lookup antes de insertar" — se usa directamente `upsert(..., { onConflict, ignoreDuplicates: true })`, que es la estrategia correcta para alta frecuencia/reintentos (evita el propio round-trip de lookup).
- **unread_count**: movido a un UPDATE atómico de un solo statement (`bump_conversation_on_inbound`), eliminando el read-modify-write que perdía incrementos bajo concurrencia (#369).
- **Statuses de mensajes salientes**: `isValidStatusTransition` impide que un evento de estado retroceda la escalera `pending→sent→delivered→read→replied`, protegiendo contra reordenamiento de eventos de Meta.

No se encontró ninguna ruta de escritura a `conversations` que inserte sin pasar por `findOrCreateConversation` o el bloque equivalente en `resolveConversationByPhone` (búsqueda exhaustiva de `.from('conversations')...insert(` en `src/`).

---

## H. Idempotencia Meta

- Clave de idempotencia: `(conversation_id, message_id)` — deliberadamente NO `message_id` solo, porque Meta reutiliza IDs entre distintos números (comentario de migración 009, confirmado también en el manejo de `handleStatusUpdate`, que nunca asume una sola fila al filtrar solo por `message_id`).
- El `upsert` con `ignoreDuplicates: true` + `.select('id')` es el mecanismo real: en un reintento, `insertedRows` vuelve vacío y el código corta inmediatamente (`return`) antes de: bump de unread, reopen de conversación, `flagBroadcastReplyIfAny`, flows, automatizaciones, IA, y el webhook saliente `message.received`. Es decir, **todos** los efectos secundarios están después del punto de corte, no solo el insert de mensaje.
- Migración 037 pre-limpia duplicados exactos existentes en `messages` (`ROW_NUMBER() OVER (PARTITION BY conversation_id, message_id ...)`) antes de crear el índice único, para que el `CREATE UNIQUE INDEX` no falle contra datos previos.
- `route.test.ts` cubre explícitamente ambos casos: primera entrega (persiste y dispara efectos) y reintento (no-op, sin bump, sin fan-out) — no es solo un comentario, hay test.

---

## I. Auditoría frontend

- **Query de Inbox** (`conversation-list.tsx`): un solo `select(INBOX_CONVERSATION_SELECT)` sin paginación, ordenado por `last_message_at desc`, filtrando `contact.blocked = false` vía inner join. `INBOX_CONVERSATION_SELECT = "*, contact:contacts!inner(*, contact_tags(tags(*)))"`.
  - **Los joins NO producen filas duplicadas**: PostgREST/Supabase anida los embeds (`contact_tags(tags(*))` queda como array dentro de `contact`, no aplana el resultado como un `JOIN` SQL crudo). Se descarta esta hipótesis explícitamente.
  - **No hay paginación** en el listado — se descarta duplicación por límites de página solapados.
- **Key de renderizado**: `<ConversationItem key={conv.id} ...>` — usa el UUID real de la fila, no un índice de array ni una clave derivada. Correcto.
- **Realtime**: `handleConversationEvent`/`handleMessageEvent` en `inbox/page.tsx` comprueban `knownConvIdsRef.current.has(id)` (un `Set` sincrónico, no el `state` async) antes de decidir entre "parchear" o "hidratar", y el INSERT de conversación hace `if (prev.some(c => c.id === conv.id)) return prev;` antes de anteponer — previene duplicado por evento repetido o fuera de orden. El propio código documenta un bug histórico relacionado (#105/#106) y su fix, lo que indica que este patrón ya fue endurecido una vez.
- **Merge de estado optimista** (mensaje temporal `temp-*` reemplazado por el real): filtra por prefijo antes de agregar el mensaje del servidor — no se identificó ventana de doble-render.
- **Conclusión de la sección**: no se encontró mecanismo de frontend que duplique el *renderizado* de una fila de conversación real. Si el usuario reportó "3 chats" para "3 mensajes", lo más consistente con el código es que existían/existieron **3 filas reales** (contacto o conversación), no una sola fila mostrada 3 veces.

---

## J. Relación posible con Flow

Ruta completa: botón "Iniciar Flow" (Inbox) → `POST /api/flows/[id]/start` con body `{ conversation_id }` → `startFlowManually({ accountId, flowId, conversationId })`.

Identificadores usados, en orden:
1. `conversation_id` (recibido del cliente) — verificado contra `account_id` de sesión.
2. Ventana de servicio 24h: `SELECT created_at FROM messages WHERE conversation_id = X AND sender_type = 'customer' ORDER BY created_at DESC LIMIT 1` — **esto vive en el route handler, ANTES de llamar a `startFlowManually`**, y filtra **solo por `conversation_id`**.
3. Dentro de `startFlowManually`: `conversation_id → contact_id` (vía `conversations` table), luego `contact_id → blocked` (vía `contacts`), y el chequeo de "ya tiene un flow activo" se hace **por `contact_id`** (`loadActiveRunForContact`), no por `conversation_id` — esta parte SÍ es resistente a fragmentación.

**Hallazgo relevante**: el paso 2 (ventana de 24h) es el único punto de todo el flujo de Flow que depende de `conversation_id` para localizar mensajes del cliente, en vez de agregarlos por `contact_id`. Si el hilo abierto en el Inbox es una conversación fragmentada que no contiene los mensajes reales del cliente (por duplicado histórico, o por el gap de teléfono-equivalente de la sección D.1), esta consulta devuelve `null`, y el endpoint responde:

```json
{ "error": "No customer message found for this conversation", "code": "service_window_expired" }
```

— que es exactamente la clase de fallo ("no podía iniciarse/enviarse un Flow") reportada junto con los chats fragmentados.

**¿Es esto evidencia suficiente de causa-efecto para el caso reportado?** Es una **hipótesis plausible y verificable en código**, no una certeza: requiere que el `conversation_id` sobre el que se intentó iniciar el Flow fuera realmente un fragmento sin mensajes de cliente. No se auditó todavía si el caso concreto reportado cumple esa condición (no se dispuso del `conversation_id` real). Se recomienda NO tratarlo como la misma causa que la fragmentación sin antes confirmar con el `conversation_id`/`contact_id` reales del caso — tal como pedía el encargo.

> **CORRECCIÓN (2026-09-10, ver sección Q.8)**: con el caso real "Juor Nuevo" confirmado, las tres conversaciones fragmentadas SÍ contienen cada una un mensaje de cliente reciente (~12-13h). Por tanto, para ESTE caso concreto, `service_window_expired` **no puede ser la explicación** del fallo de Flow. La hipótesis de esta sección J sigue siendo válida en abstracto (para un fragmento que realmente carezca de mensajes de cliente), pero no aplica sin más aquí. La sección Q.8 enumera las causas alternativas y por qué ninguna puede confirmarse sin el código/log de respuesta real del intento fallido.

---

## K. Estado de migraciones 022/036/037 en el repositorio

Las tres existen en el repo, en `HEAD` actual, con contenido completo e idempotente (`CREATE ... IF NOT EXISTS`, funciones re-ejecutables). El commit `faf0f740` ("fix: stop inbound chats fragmenting into duplicate conversations (#363)") es ancestro confirmado de `HEAD` (`git merge-base --is-ancestor` → true), y su merge posterior `b867760` (#364) también está en el historial.

**Lo que el repositorio NO puede demostrar por sí solo**: si estas migraciones fueron efectivamente aplicadas al Supabase self-hosted de producción, en qué orden, ni si las definiciones de función en producción coinciden con las del archivo. No existe `supabase_migrations.schema_migrations` en esa instancia (confirmado por instrucción previa) ni ningún mecanismo alternativo de tracking en el repo.

La evidencia de producción aportada (existencia de `merge_duplicate_conversations()`, `merge_duplicate_contacts()`, `bump_conversation_on_inbound()`, y 0 filas duplicadas en las tres claves relevantes) es **evidencia indirecta fuerte** de que 022, 036 y 037 corrieron — porque esas funciones y esa limpieza son artefactos específicos de esas migraciones y no existían antes de ellas — pero no es prueba de que el *índice único* correspondiente exista (una función puede haberse creado sin el índice, por ejemplo si el `CREATE UNIQUE INDEX` falló silenciosamente o se ejecutó en una sesión separada). Ver sección L.

---

## L. SQL de SOLO LECTURA recomendado para comprobar producción

Todas de solo lectura; ninguna escribe, bloquea en exclusiva, ni ejecuta las funciones de merge.

```sql
-- 1) ¿Existen realmente los índices únicos esperados (no solo las funciones)?
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('contacts', 'conversations', 'messages', 'whatsapp_config', 'message_reactions', 'flow_runs')
ORDER BY tablename, indexname;

-- 2) Comparar la definición de las funciones de producción contra el repo actual.
SELECT proname, pg_get_functiondef(oid) AS definition
FROM pg_proc
WHERE proname IN (
  'merge_duplicate_contacts',
  'merge_duplicate_conversations',
  'bump_conversation_on_inbound',
  'record_blocked_inbound'
);

-- 3) Contactos "lógicamente duplicados" que NINGÚN índice único detecta:
--    mismo account_id, phone_normalized distinto, mismos últimos 8 dígitos
--    (la clase de duplicado descrita en la sección D.1 / hipótesis C).
SELECT a.account_id, a.id AS contact_a, a.phone AS phone_a,
       b.id AS contact_b, b.phone AS phone_b
FROM public.contacts a
JOIN public.contacts b
  ON a.account_id = b.account_id
 AND a.id < b.id
 AND length(a.phone_normalized) >= 8
 AND length(b.phone_normalized) >= 8
 AND right(a.phone_normalized, 8) = right(b.phone_normalized, 8)
 AND a.phone_normalized <> b.phone_normalized;

-- 4) Para cada par del punto 3, ¿tienen conversaciones separadas?
--    (confirma el síntoma real: 2 contact_id ⇒ 2 conversation_id para
--    lo que probablemente es un solo cliente).
SELECT c.contact_id, c.id AS conversation_id, c.created_at, c.last_message_at
FROM public.conversations c
WHERE c.contact_id IN (
  SELECT a.id FROM public.contacts a
  JOIN public.contacts b
    ON a.account_id = b.account_id AND a.id <> b.id
   AND length(a.phone_normalized) >= 8 AND length(b.phone_normalized) >= 8
   AND right(a.phone_normalized, 8) = right(b.phone_normalized, 8)
   AND a.phone_normalized <> b.phone_normalized
)
ORDER BY c.contact_id, c.created_at;

-- 5) Confirmar que whatsapp_config no tiene phone_number_id duplicado
--    (precondición silenciosa de todo el pipeline del webhook).
SELECT phone_number_id, COUNT(*)
FROM public.whatsapp_config
GROUP BY phone_number_id
HAVING COUNT(*) > 1;

-- 6) Mensajes con message_id NULL en volumen anómalo (no deberían
--    generar colisión, pero conviene descartar volumen inesperado
--    de mensajes salientes atascados "mid-send").
SELECT conversation_id, COUNT(*)
FROM public.messages
WHERE message_id IS NULL
GROUP BY conversation_id
HAVING COUNT(*) > 20
ORDER BY 2 DESC
LIMIT 20;

-- 7) Reconstrucción histórica: contactos del MISMO account_id creados
--    con pocos minutos de diferencia y nombre/empresa iguales — señal
--    de alta manual duplicada o import CSV duplicado (no de webhook,
--    que siempre reutiliza por phonesMatch()).
SELECT account_id, phone, name, created_at
FROM public.contacts
WHERE account_id = '<ACCOUNT_ID_DEL_CASO>'
ORDER BY created_at;
```

---

## M. Hipótesis ordenadas por probabilidad

> **Nota de corrección (2026-09-10)**: esta sección M y su numeración reflejan el estado del análisis ANTES de la evidencia del caso "Juor Nuevo". Con esa evidencia, la hipótesis (2) de abajo queda **descartada para este incidente concreto** (los teléfonos no son variantes fuzzy: están vacíos) y pasa a ser sustituida en el ranking real por la causa raíz de la sección Q.3 ("identidad de remitente vacía"), que hoy es la hipótesis de mayor probabilidad confirmada por datos. Se conserva el texto original sin editar como registro histórico.

1. **(Alta)** El reporte original corresponde a datos/conversaciones creados **antes** de que 036/037 quedaran vigentes en producción, y `merge_duplicate_conversations()` ya los consolidó — consistente con "0 rows" en las tres consultas de duplicados exactos.
2. **(Media-alta)** El número de teléfono real del contacto reportado tiene una variante de prefijo troncal (u otro formato que `phonesMatch()` reconoce pero `phone_normalized` no colapsa) y en algún momento se creó una segunda fila de contacto vía alta manual o CSV import — produciendo 2 (o 3) `contact_id` distintos y por tanto 2-3 `conversation_id` reales, ninguno de los cuales viola ningún índice único. Se verifica con la consulta 3/4 de la sección L.
3. **(Media)** El fallo de Flow es una consecuencia directa de 1 o 2: el agente abrió el fragmento de conversación equivocado (sin mensajes de cliente), y la ventana de 24h de `POST /api/flows/[id]/start` (sección J) lo rechazó — no una incidencia de Flow independiente.
4. **(Baja)** Persiste alguna otra ruta de creación de `conversations` no cubierta por `findOrCreateConversation` — descartada por búsqueda exhaustiva de `.insert()` en `src/`, pero no puede descartarse al 100% sin auditar también triggers/funciones SQL adicionales instaladas directamente en producción y no presentes en `supabase/migrations/`.
5. **(Muy baja)** Duplicación de renderizado en frontend — descartada por lectura de código (sección I); no hay mecanismo de joins, paginación o reconciliación de estado que produzca una fila fantasma.

---

## N. Plan mínimo de corrección, SOLO si queda algún gap

**No debe ejecutarse en esta fase.** Se deja documentado para una eventual Fase 2, condicionado a que la sección L confirme el gap de la hipótesis 2:

1. Extender el índice único de contactos (o una validación de aplicación equivalente con `SELECT ... FOR UPDATE` transaccional) para que las rutas de alta manual y CSV import consulten `findExistingContact` (fuzzy) **antes** de insertar, igual que ya hacen webhook/ManyChat/API v1 — actualmente solo lo hacen como aviso no bloqueante (manual) o no lo hacen en absoluto (CSV).
2. Cambiar la consulta de ventana de 24h en `POST /api/flows/[id]/start` para resolver el `contact_id` de la conversación primero y buscar el último mensaje de cliente en **todas** las conversaciones de ese contacto, no solo en la que el cliente tiene abierta — o, alternativamente, dejar que sea un job de backfill el que impida que existan conversaciones fragmentadas para un mismo contacto real.
3. Un job de reconciliación (no automático, ejecutado manualmente tras revisar la sección L) que identifique pares de contactos "equivalentes por `phonesMatch()`" y ofrezca fusionarlos con `merge_duplicate_contacts()` extendido a esa definición de igualdad — hoy esa función solo fusiona por `phone_normalized` exacto.

---

## O. Casos de prueba requeridos (para una eventual Fase 2)

1. Alta manual de un contacto con número que es variante de troncal de uno ya existente → debe bloquear o fusionar, no crear una segunda fila.
2. Importación CSV con una fila cuyo número es variante de troncal de un contacto ya existente → debe contarse como "skipped", no como "imported".
3. Dos mensajes inbound consecutivos de Meta para un contacto cuyo número llega en dos formatos distintos dentro de la ventana `contacts[i] ?? contacts[0]` (`processWebhook`) → deben resolver al mismo `contact_id`.
4. `POST /api/flows/[id]/start` sobre una conversación que es un fragmento sin mensajes de cliente, cuando SÍ existe otro fragmento del mismo contacto con mensajes recientes → decidir el comportamiento deseado (¿fusionar antes de intentar? ¿mirar por contacto?) y testear ese comportamiento explícitamente.
5. Test de regresión que reconstruya el escenario original: 3 mensajes inbound rápidos para un contacto nuevo → exactamente 1 `contact_id` y 1 `conversation_id` al final.

---

## P. Archivos que sería necesario modificar en una eventual Fase 2

Solo si la sección L confirma el gap — ningún archivo fue tocado en esta auditoría:

- [src/components/contacts/contact-form.tsx](src/components/contacts/contact-form.tsx) — alta manual, endurecer el aviso fuzzy a bloqueo o fusión.
- [src/components/contacts/import-modal.tsx](src/components/contacts/import-modal.tsx) — CSV import, añadir chequeo `phonesMatch()` antes de insertar.
- [src/app/api/flows/[id]/start/route.ts](src/app/api/flows/[id]/start/route.ts) — ventana de 24h, resolver por `contact_id` en vez de solo `conversation_id`.
- Posible nueva migración (si se decide official-support de fusión fuzzy) que amplíe `merge_duplicate_contacts()` — actualmente en [supabase/migrations/022_contact_phone_dedup.sql](supabase/migrations/022_contact_phone_dedup.sql).

---

## Q. ACTUALIZACIÓN — Causa raíz confirmada: identidad de remitente vacía (caso "Juor Nuevo")

### Q.1 Evidencia concreta del caso

Mismo `account_id` (`c35b393f-9492-4321-80f2-987766c224d0`), tres `contact_id` distintos, los tres con `name = 'Juor Nuevo'`, `phone = ''`, `phone_normalized = ''`:

| conversation_id | contact_id | contact created_at | mensaje del cliente | message_id Meta |
|---|---|---|---|---|
| `b20fa65d-d371-49c9-b711-abf39d7b012e` | `32cec31d-dea1-42dd-91b9-edb42cf22ccd` | 2026-09-09 16:57:05.563591+00 | "🔥 Hola, vi el Taladro Redbo profesional ¿Aún está disponible?" (16:57:04) | `wamid.*` |
| `892cdbeb-d7ca-48b0-b0db-b47560a68fc0` | `61aaf2db-931a-405c-a932-808a40253f44` | 2026-09-09 16:57:42.674767+00 | "Enviame modalidad de compra provincias" (16:57:41) | `wamid.*` (distinto) |
| `0c9b6aa5-6ae4-4073-8418-30e23f942e56` | `30d40e6f-afb5-4468-ad0a-0cc57486b926` | 2026-09-09 16:58:22.949838+00 | "Informacion del contenido del estuche" (16:58:21) | `wamid.*` (distinto) |

Los tres `message_id` son `wamid.*` genuinos y distintos entre sí → **no son reintentos** del mismo webhook (la idempotencia de la migración 037 no aplica aquí porque no hay colisión de `message_id`: son tres entregas legítimas y diferentes). Cada contacto se creó ~1 segundo antes de que se insertara "su" mensaje, y cada uno recibió exactamente una conversación — consistente con tres pasadas independientes por `processMessage()` que, cada vez, no encontraron un contacto existente y crearon uno nuevo.

Evidencia adicional aportada: el patrón **no es exclusivo de este contacto** — se detectaron varios grupos de contactos con `phone=''`/`phone_normalized=''` que comparten nombre dentro de la misma cuenta (ORELY ×4, "😏.. ..." ×3, Juor Nuevo ×3, Hipolito Martinez M ×2, Carlos Z ×2), además de numerosos contactos individuales con `phone=''` y exactamente 1 conversación y 1 mensaje, creados casi en el mismo instante que el mensaje inbound. Esto descarta que sea un evento aislado: es un **patrón sistémico** de creación de contactos inbound sin identidad telefónica.

También se confirmó que los tres índices únicos relevantes existen físicamente en producción (`idx_contacts_account_phone_normalized`, `idx_conversations_account_contact`, `idx_messages_conversation_message_id`), que no hay `whatsapp_config` duplicado por cuenta, que no hay contactos fuzzy-equivalentes por sufijo de 8 dígitos, y que producción está exactamente en el HEAD auditado (`4b974877...`, con `faf0f740` incluido). Esto cierra definitivamente las dudas de las secciones D.2/K sobre si las migraciones 022/036/037 están realmente desplegadas: **sí lo están**, y aun así el incidente ocurre — confirmando que la causa no es un índice faltante, sino un dato de entrada (`phone=''`) que ningún índice de estos está diseñado para rechazar.

### Q.2 La hipótesis fuzzy/trunk-prefix (secciones D.1/M.2) queda descartada para ESTE incidente

`phone` y `phone_normalized` están vacíos en los tres contactos — no hay dos representaciones distintas de un mismo número, no hay prefijo troncal, no hay nada que `phonesMatch()` pudiera haber unificado. La consulta de producción por sufijo de 8 dígitos confirma 0 filas. **La sección D.1 sigue documentando un gap de código real** (alta manual y CSV import sin `phonesMatch()` bloqueante), pero no es la causa de este caso ni, aparentemente, del patrón sistémico observado — ese patrón afecta específicamente a contactos con `phone=''`, que es una categoría distinta.

### Q.3 Nueva causa raíz candidata: identidad de remitente no resuelta en el webhook nativo

**Cadena confirmada por lectura de código actual** ([src/app/api/whatsapp/webhook/route.ts:625-636](src/app/api/whatsapp/webhook/route.ts#L625-L636), [src/lib/whatsapp/phone-utils.ts:15-18](src/lib/whatsapp/phone-utils.ts#L15-L18), [src/lib/contacts/dedupe.ts:35-56](src/lib/contacts/dedupe.ts#L35-L56), [src/lib/contacts/find-or-create.ts:27-80](src/lib/contacts/find-or-create.ts#L27-L80)):

```ts
// route.ts:625
const senderPhone = normalizePhone(message.from)   // (1)
...
// route.ts:629
const contactOutcome = await findOrCreateContact(
  supabaseAdmin(), accountId, configOwnerUserId, senderPhone, contactName  // (2)
)
```

1. `normalizePhone(phone)` ([phone-utils.ts:15](src/lib/whatsapp/phone-utils.ts#L15)): `if (!phone) return ''`. Si `message.from` es `undefined`, `null` o `''`, el resultado es `''` — **sin lanzar excepción, sin log, sin marcador de error**.
2. `findOrCreateContact(db, accountId, configOwnerUserId, '', contactName)` llama primero a `findExistingContact(db, accountId, '')` ([dedupe.ts:35-42](src/lib/contacts/dedupe.ts#L35-L42)): `const normalized = normalizePhone(phone); if (!normalized) return null;` → **retorna `null` inmediatamente, sin consultar la BD**. No es "no se encontró coincidencia" — es "no se buscó".
3. De vuelta en `findOrCreateContact` ([find-or-create.ts:34-64](src/lib/contacts/find-or-create.ts#L34-L64)): como `existingContact` es `null`, cae al bloque de creación e inserta sin ninguna validación adicional:
   ```ts
   await db.from('contacts').insert({
     account_id: accountId, user_id: configOwnerUserId,
     phone,                    // '' — se persiste tal cual
     name: name || phone,      // usa contactName si vino; si no, ''
   })
   ```
   **Esta función NO valida que `phone` sea no-vacío ni tenga forma de E.164** — a diferencia de sus dos análogas: `src/lib/api/v1/contacts.ts`'s `findOrCreateContact` (línea ~116, `isValidE164(sanitized)` → lanza `ContactError` 400 si falla) y `src/lib/whatsapp/resolve-conversation.ts`'s `resolveConversationByPhone` (línea ~48, mismo chequeo). **Esta es la asimetría concreta de código**: dos de las tres implementaciones de "resolver/crear contacto por teléfono" validan forma E.164 antes de insertar; la que usa el webhook nativo de Meta —la ruta de mayor volumen— no lo hace.
4. El INSERT tiene éxito porque `idx_contacts_account_phone_normalized` es un índice **parcial**: `UNIQUE (account_id, phone_normalized) WHERE phone_normalized <> ''` (migración 022). La cláusula `WHERE phone_normalized <> ''` **excluye deliberadamente** las filas con teléfono vacío de la garantía de unicidad — diseño original pensado, con toda probabilidad, para permitir contactos dados de alta manualmente sin número (solo con email/nombre). Ese diseño correcto para el caso manual se convierte en un agujero cuando una ruta automática e inbound (el webhook) también puede producir `phone=''`.
5. `findOrCreateConversation(accountId, contact.id)` ([find-or-create.ts](src/lib/conversations/find-or-create.ts) en `src/lib/conversations/`) actúa correctamente sobre el `contact.id` que recibe — no tiene forma de saber que ese `contact.id` es "ilegítimo"; simplemente aplica su regla `(account_id, contact_id) → 1 conversation`, que es exactamente lo que se diseñó en la migración 036. **El motor de deduplicación de conversaciones funciona perfectamente; el problema es que recibe una identidad de contacto que no debería haberse creado.**

Conclusión: cada mensaje con `message.from` vacío/no resuelto genera, de forma determinista y sin ningún error visible en los logs actuales, un contacto nuevo + una conversación nueva. Tres mensajes de ese tipo para el "mismo" cliente real producen exactamente el síntoma reportado (3 mensajes → 3 chats), sin que ningún índice único se viole en el proceso.

### Q.4 Por qué los índices actuales no lo impiden (resumen)

| Índice | Por qué no bloquea `phone=''` |
|---|---|
| `idx_contacts_account_phone_normalized` (022) | Es parcial: `WHERE phone_normalized <> ''` excluye expresamente las filas vacías de la unicidad — por diseño, para no impedir contactos manuales sin teléfono. |
| `idx_conversations_account_contact` (036) | Actúa sobre `contact_id`, que ya es distinto para cada contacto "fantasma" creado — no tiene visibilidad sobre si ese `contact_id` representa una identidad real. |
| `idx_messages_conversation_message_id` (037) | Los tres `message_id` de Meta son genuinamente distintos (no son reintentos) — no hay nada que este índice deba ni pueda deduplicar aquí. |

### Q.5 ¿Por qué llega `message.from` vacío? — Lo que el código SÍ permite afirmar y lo que NO

**No hay evidencia en el repositorio de que Meta omita `message.from`** en su especificación de Cloud API, y este documento no afirma tal cosa. Lo que sí es 100% verificable por lectura de código:

- `processMessage`/`processWebhook` **solo se invocan desde dentro de `route.ts`** (confirmado por búsqueda exhaustiva de `processMessage(` / `processWebhook(` en `src/`) — no existe ningún simulador interno, endpoint de prueba o migración de datos que construya un `WhatsAppMessage` sintético y lo alimente a este pipeline. El payload que llega a `processMessage` es el mismo `JSON.parse(rawBody)` del cuerpo crudo de la petición HTTP, sin transformación intermedia que pudiera "vaciar" el campo `from`.
- El puente ManyChat (`src/app/api/integrations/manychat/inbound/route.ts`) es una ruta HTTP **completamente separada**, con su propio parser de payload; nunca llama a `processMessage`/`findOrCreateContact` (la versión del webhook) ni construye objetos `WhatsAppMessage`. Se confirma además que ese bridge exige `whatsapp_id` no vacío (`isNonEmptyString`, línea 201, responde 400 si falta) y genera `message_id` con el prefijo `manychat:...` — los `message_id` del caso real son `wamid.*`, así que **el bridge de ManyChat queda descartado como origen de este incidente**.
- La interfaz `WhatsAppMessage` ([route.ts:40-75](src/app/api/whatsapp/webhook/route.ts#L40-L75)) declara `from: string` (no opcional) — pero esto es solo una anotación de TypeScript sobre un valor que en realidad proviene de `JSON.parse` de una petición HTTP externa; **no impone nada en tiempo de ejecución**. Un payload real que llegue con `from` ausente, `null`, o `''` pasa el "type check" de todas formas porque TypeScript no valida JSON en runtime.
- El interruptor de tipo de mensaje (`parseMessageContent`) tiene una rama `default` para tipos no reconocidos (`[Unsupported message type: ...]`), lo que demuestra que el código YA anticipa mensajes con forma inesperada en su contenido — pero esa tolerancia nunca se extendió al campo `from`, que se lee de forma incondicional antes de llegar siquiera a `parseMessageContent`.
- El objeto `contact` (`value.contacts[i]`) sí trae `wa_id` ([route.ts:88](src/app/api/whatsapp/webhook/route.ts#L88): `wa_id: string`), y el código lo destructura en la firma de `processMessage` ([route.ts:611](src/app/api/whatsapp/webhook/route.ts#L611): `contact: { profile: { name: string }; wa_id: string }`) — pero **`wa_id` nunca se lee para nada más que el tipo**; solo `contact.profile.name` se usa en tiempo de ejecución. `contact.wa_id` es, hoy, un campo completamente ignorado como fuente de identidad.
- No existe ningún test (`route.test.ts`) que ejercite `message.from` vacío, ausente, o distinto de `contact.wa_id` — confirmado por búsqueda de `from: ''` / `from: undefined` en el archivo de test: todas las fixtures usan `from: '15551230000'` fijo. **Este es un hueco de cobertura real**, no solo una sospecha.
- El webhook nativo de Meta existe desde el scaffold inicial del proyecto (no es una migración reciente desde ManyChat) — el historial de `git log --follow` sobre `route.ts` no muestra ninguna reestructuración de "ManyChat → Meta directo"; ambas rutas de ingesta coexisten desde hace tiempo como integraciones independientes.

**Conclusión honesta**: el repositorio demuestra de forma concluyente que WACRM *procesa* algunos inbound con `message.from` vacío y que **no tiene ninguna defensa contra ello**, hasta el punto de persistir un contacto y una conversación nuevos cada vez. El repositorio **no puede demostrar** si el origen del campo vacío es (a) un tipo/forma de mensaje de Meta que nuestro código no modela explícitamente, (b) un comportamiento de un intermediario/BSP delante de nuestro endpoint, o (c) otra causa aún no identificada. Cerrar esa pregunta requiere los logs de producción recomendados en Q.6, no más lectura de código.

### Q.6 Identidad primaria vs. fallback — diseño recomendado (NO implementado)

Dado lo anterior, y sin inventar comportamiento de Meta, el diseño defensivo mínimo razonable es:

1. **Identidad primaria**: `message.from` normalizado, como hoy.
2. **Fallback explícito**: si `normalizePhone(message.from)` es `''`, intentar `normalizePhone(contact.wa_id)` — el propio payload de Meta ya nos entrega este segundo campo en `value.contacts[i]`, y hoy se descarta sin usarlo.
3. **Chequeo de consistencia** (cuando ambos están presentes y son distintos tras normalizar): no fallar el mensaje por esto — persistir igual usando `message.from` como fuente de verdad (es el campo que Meta asocia específicamente al mensaje, no al "contacto" genérico del payload), pero emitir el log de observabilidad de Q.7 para poder cuantificar cuántas veces ocurre y decidir si alguna vez `wa_id` debería preferirse.
4. **Rechazo explícito si ninguno produce una identidad válida**: no crear `contact`, no crear/reutilizar `conversation`, no insertar `message`, no disparar ningún efecto secundario (flows, automatizaciones, IA, webhooks salientes) — exactamente la misma disciplina de "corte total" que ya existe para el caso de contacto bloqueado ([route.ts:644-654](src/app/api/whatsapp/webhook/route.ts#L644-L654)) y para el replay idempotente ([route.ts:787-793](src/app/api/whatsapp/webhook/route.ts#L787-L793)) — este sería un tercer punto de corte temprano, antes de tocar `contacts` en absoluto.
5. **Segunda barrera en el helper compartido** (`src/lib/contacts/find-or-create.ts`): añadir la misma validación `isValidE164`/no-vacío que ya existe en `src/lib/api/v1/contacts.ts` y `resolveConversationByPhone`, para que ningún caller futuro (o un bug en el punto 1-4) pueda colar un `phone` vacío. Esto convierte una responsabilidad hoy solo del *caller* en una garantía del *helper compartido* — coincide con el pedido explícito del encargo ("ninguna caller pueda crear contactos con teléfono vacío/no normalizable aunque el caller tenga un bug").
6. **Base de datos**: NO se recomienda añadir un `CHECK` directo sobre `contacts.phone` todavía — producción ya tiene contactos históricos legítimos con `phone=''` (altas manuales sin número, y ahora también los del patrón sistémico aquí descrito), y un `CHECK` retroactivo fallaría o requeriría un saneamiento previo no trivial. La secuencia correcta, si se decide seguir por ahí en Fase 2, es: (a) cerrar primero la vía de entrada en el webhook + helper compartido (puntos 1-5), (b) medir durante un tiempo cuántos contactos nuevos con `phone=''` se siguen creando por otras vías legítimas (alta manual sin número), (c) recién entonces evaluar si un `CHECK` con excepción explícita (p. ej. una columna `phone_optional_reason` o un `CHECK (phone <> '' OR source = 'manual_no_phone')`) tiene sentido — este documento no toma esa decisión, solo la deja planteada.

### Q.7 Logging recomendado (NO implementado)

Cuando la identidad del remitente no pueda resolverse (o cuando `message.from` y `contact.wa_id` normalizados difieran), registrar exclusivamente:
- tipo de mensaje (`message.type`);
- presencia/ausencia de `message.from` (booleano, nunca el valor si se sospecha que podría ser un dato parcialmente válido — pero en este caso el valor normalizado ya es `''`, así que no hay secreto que proteger al loguearlo);
- presencia/ausencia de `contact.wa_id`;
- `phone_number_id` receptor (identifica el número de negocio, no el del cliente);
- `message.id` (el `wamid.*` de Meta — es un identificador de mensaje, no un secreto);
- **nunca**: `access_token`, `app_secret`, `verify_token`, contenido del mensaje, ni el payload completo crudo.

Esto permitiría, sin exponer nada sensible, distinguir en producción si el patrón correlaciona con un `message.type` específico, con un `phone_number_id` específico, o si es transversal — información que hoy no existe y que es necesaria antes de afirmar una causa definitiva en Meta o en un intermediario.

### Q.8 Flow — tratado como incidencia potencialmente separada

Con el caso real confirmado, las tres conversaciones fragmentadas **sí** contienen cada una un mensaje de cliente reciente (~12-13h) — la hipótesis de la sección J (`service_window_expired` por ausencia de mensajes de cliente en el fragmento abierto) **no puede ser la explicación aquí**. Sin el código/`code` de respuesta real que devolvió el intento fallido de "Iniciar Flow", solo se puede enumerar qué pudo haber pasado y qué evidencia haría falta para confirmar cada uno:

| Resultado posible | ¿Consistente con fragmentación (3 contact_id distintos)? | Qué evidencia falta para confirmar/descartar |
|---|---|---|
| `service_window_expired` (ruta, 24h) | Descartado para este caso — las 3 conversaciones tienen mensaje de cliente reciente | — |
| `active_flow_exists` | **Sí, plausible** — el chequeo de "flow activo" es por `contact_id` (`idx_one_active_run_per_contact` / `loadActiveRunForContact`). Si el agente ya inició un flow desde el fragmento A (contact A), y luego lo reintenta desde el mismo fragmento A, obtendría este error legítimamente. Fragmentación NO causa esto directamente, pero sí permite el escenario inverso más peligroso: iniciar flows independientes y duplicados en los fragmentos B y C sin que el sistema lo detecte, porque cada uno tiene su propio `contact_id` "limpio" | El `flow_run_id`/`active_flow_run_id` que devolvería la API en este caso, y en qué `contact_id` está esa ejecución activa |
| `flow_not_active` | Independiente de la fragmentación — depende únicamente del `status` del flow elegido | El `flow_id` usado y su `status` en `flows` |
| `contact_not_found` | Improbable — los tres `contact_id` existen y están bien formados (solo con `phone=''`) | — |
| `contact_blocked` | Posible solo si el `contact_id` concreto de la conversación abierta fue bloqueado — independiente de la fragmentación | Estado de `contacts.blocked` para ese `contact_id` específico |
| `conversation_not_found` | Improbable — las tres conversaciones existen y pertenecen a la cuenta correcta | — |
| `internal_error` | Posible por cualquier fallo de BD/RPC no relacionado con identidad | Log del servidor en el momento del intento |

**No se debe modificar Flow sin antes obtener** el cuerpo de respuesta JSON real (`code` + `error`) del intento fallido, o el log del servidor correspondiente — la ruta ya devuelve códigos específicos y distinguibles (sección J del documento original), así que esta evidencia debería ser trivial de recuperar sin tocar código.

### Q.9 Estrategia segura para el histórico — sin fusionar por nombre

**No se ejecuta ningún merge en esta fase.** Restricciones explícitas para una eventual Fase 2:

- `merge_duplicate_contacts()` (migración 022) **no sirve para este caso**: agrupa por `(account_id, phone_normalized)` exacto, y aquí los tres registros tienen `phone_normalized = ''` — la condición `WHERE phone_normalized <> ''` de su propio `GROUP BY`/filtro los excluye por diseño (coherente con que el índice que la función alimenta es igualmente parcial).
- **Hallazgo adicional (Fase 2, confirmado por lectura del código, NO ejecutado)**: `merge_duplicate_contacts()` podría fallar hoy incluso para el caso que SÍ sabe manejar (duplicados con `phone_normalized` exacto no vacío). Su re-apuntado de `conversations` ([022_contact_phone_dedup.sql:62-66](supabase/migrations/022_contact_phone_dedup.sql#L62-L66)) es un `UPDATE conversations SET contact_id = v_survivor WHERE contact_id = ANY(v_losers)` sin manejo de conflicto, con un comentario que dice explícitamente "these tables have no contact-scoped unique constraint" — cierto cuando se escribió 022, pero la migración 036 (posterior) agregó exactamente esa constraint: `UNIQUE(account_id, contact_id)` en `conversations`. Si el sobreviviente Y al menos un perdedor ya tienen cada uno su propia conversación (el estado normal para cualquier contacto que alguna vez recibió un mensaje, dado que `findOrCreateConversation` siempre crea una), este `UPDATE` viola `idx_conversations_account_contact` con un 23505, y como la función no tiene manejo de excepción por grupo, ese error aborta la función completa (incluyendo cualquier otro grupo de duplicados que aún no se hubiera procesado en ese mismo `SELECT public.merge_duplicate_contacts();`). Esto es una tarea separada para la fase de saneamiento histórico — no se corrige aquí ni se ejecuta la función para comprobarlo.
- **`name` nunca debe usarse como clave de fusión**: dos clientes reales distintos pueden compartir el mismo nombre de perfil de WhatsApp ("Juor Nuevo", "Carlos Z" son nombres de perfil, no identificadores). Fusionar por coincidencia de nombre arriesgaría mezclar el historial de conversación de dos personas distintas — un daño potencialmente peor que el problema original.
- **Sin identidad Meta recuperable, el saneamiento automático debe abstenerse.** Si en los logs de la aplicación (fuera de esta BD, p. ej. logs de Vercel/edge previos a esta auditoría) existiera el payload crudo de alguno de estos tres mensajes con un `wa_id`/`from` real capturado por algún sistema externo de observabilidad, ESO sería identidad suficiente para reasignar manualmente el/los contacto(s) correcto(s) — pero no debe asumirse que existe sin verificarlo primero.
- **`merge_duplicate_conversations()` (migración 036) hoy es segura de re-ejecutar** en el sentido de que sigue siendo idempotente y coherente con `UNIQUE(account_id, contact_id)`: agrupa `conversations` por `(account_id, contact_id)`, y como esa migración se aplicó DESPUÉS de crear el índice único, por construcción nunca encontrará más de una conversación por `contact_id` hoy — es decir, la función seguiría corriendo sin error, simplemente no tendría nada que hacer (su `FOR ... HAVING count(*) > 1` no devolvería filas), lo cual es el comportamiento esperado y no arriesgado. **No aplica a este caso** porque el problema no es que un `contact_id` tenga 2 conversaciones (eso el índice ya lo impide) — es que hay 3 `contact_id` que probablemente representan al mismo cliente real.
- **Camino seguro recomendado (no ejecutado)**: si en el futuro se decide fusionar estos tres contactos concretos, debe hacerse con una decisión humana explícita por caso (no un script automático basado en `name`), reasignando `conversations.contact_id`, `messages` (vía `conversation_id`, ya heredado), y cualquier `deals`/`flow_runs`/`notifications` asociados al contacto perdedor hacia el sobreviviente elegido — replicando el patrón ya usado en `merge_duplicate_contacts()`/`merge_duplicate_conversations()`, pero disparado manualmente fila por fila y con confirmación, nunca por lote automático sobre `name`.

### Q.10 Archivos exactos que requeriría una Fase 2

- [src/app/api/whatsapp/webhook/route.ts](src/app/api/whatsapp/webhook/route.ts) — `processMessage`: resolver identidad primaria (`message.from`) + fallback (`contact.wa_id`) + corte explícito y log si ninguno es válido, ANTES de llamar a `findOrCreateContact`.
- [src/lib/contacts/find-or-create.ts](src/lib/contacts/find-or-create.ts) — añadir la segunda barrera de validación (no-vacío / forma E.164) que hoy solo existe en `src/lib/api/v1/contacts.ts` y `src/lib/whatsapp/resolve-conversation.ts`.
- [src/lib/contacts/dedupe.ts](src/lib/contacts/dedupe.ts) — posible endurecimiento de `findExistingContact`/`isExactMatch` si la validación se centraliza aquí en vez de en cada `findOrCreateContact`.
- [src/app/api/whatsapp/webhook/route.test.ts](src/app/api/whatsapp/webhook/route.test.ts) — añadir los casos de prueba de Q.11.
- Posible nueva migración de saneamiento (no automática) para los contactos históricos con `phone=''` agrupables — condicionada a que exista identidad Meta recuperable (Q.9); no se propone su contenido todavía.
- `POST /api/flows/[id]/start` ([src/app/api/flows/[id]/start/route.ts](src/app/api/flows/[id]/start/route.ts)) — solo si Q.8 se confirma con evidencia real como relacionado; no tocar sin esa evidencia.

### Q.11 Tests concretos que deben añadirse

1. `processMessage`/webhook: `message.from` ausente/`''` y `contact.wa_id` presente y válido → debe resolver el contacto usando el fallback, no crear un contacto con `phone=''`.
2. `processMessage`/webhook: `message.from` ausente/`''` y `contact.wa_id` también ausente/inválido → no debe crearse `contact`, ni `conversation`, ni `message`; debe registrarse el log de observabilidad de Q.7.
3. `processMessage`/webhook: `message.from` y `contact.wa_id` presentes pero con valores normalizados distintos → debe persistir usando `message.from` (fuente de verdad) y emitir el log de discrepancia, sin fallar el mensaje.
4. `findOrCreateContact` (`src/lib/contacts/find-or-create.ts`) unitario: llamado directamente con `phone=''` → debe rechazar (retornar `null` o lanzar, a decidir en Fase 2) en vez de insertar, igual que ya hace la versión de `src/lib/api/v1/contacts.ts`.
5. Regresión del caso real: tres mensajes con `message.from` vacío pero `contact.wa_id` idéntico entre sí → deben resolver a **un solo** `contact_id` y **una sola** `conversation_id` al final (replica exacta del escenario "Juor Nuevo" una vez implementado el fallback).
6. Test negativo explícito para la asimetría encontrada: confirmar que `src/lib/api/v1/contacts.ts`'s `findOrCreateContact` y `resolveConversationByPhone` YA rechazan `phone` inválido/vacío hoy (test de regresión para no perder esa protección al tocar el helper compartido).

---

## Verificación de la propia auditoría

```
git status --short   → (sin salida: árbol de trabajo limpio salvo este documento)
git diff --check     → (sin salida: sin conflictos ni espacios en blanco residuales)
```

Ningún archivo de código fue modificado. Único archivo nuevo: `docs/P1_DUPLICATE_CHATS_AUDIT.md`.
