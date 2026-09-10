# P3 — Auditoría: Completar sistema de etiquetas y filtros de chats

Rama auditada: `main` (actualizado a `origin/main`, commit `28f0d2c`).
Tipo de documento: **solo diagnóstico y diseño**. No se modificó código, no se crearon migraciones, no se ejecutó SQL contra producción, no se hizo commit ni push.

---

## A. Estado actual real

El sistema de tags **ya existe y funciona** en tres módulos independientes que hoy NO están unificados:

1. **Settings → `TagManager`** ([src/components/settings/tag-manager.tsx](src/components/settings/tag-manager.tsx)): CRUD completo de la *definición* de tags (crear/eliminar), con inserción/eliminación **raw** desde el cliente.
2. **Contacts → `ContactDetailView`** ([src/components/contacts/contact-detail-view.tsx](src/components/contacts/contact-detail-view.tsx)): asignación/quitado de tags a un contacto, ya usando el **endpoint seguro** `POST`/`DELETE /api/contacts/[id]/tags` a través de [src/lib/contacts/tag-api.ts](src/lib/contacts/tag-api.ts).
3. **Inbox → `ConversationList`** ([src/components/inbox/conversation-list.tsx](src/components/inbox/conversation-list.tsx)): filtro por tags ya completo (multi-select, OR, combinación AND con otros filtros, chips, "limpiar"). **Solo lectura** — no asigna ni crea.
4. **Inbox → `ContactSidebar`** ([src/components/inbox/contact-sidebar.tsx](src/components/inbox/contact-sidebar.tsx)): solo lectura — muestra badges, sin administración.

El hueco real de Prioridad 3 es **exclusivamente de UI**: conectar `ContactSidebar` (Inbox) al endpoint que `ContactDetailView` (Contacts) ya usa, y añadir badges compactos a `ConversationList`. La capa de datos, permisos (parcialmente) y el writer seguro ya existen y están probados.

El hallazgo de seguridad cross-account (sección G) es real y **anterior** a esta prioridad — no lo introduce el trabajo pendiente, pero debe cerrarse antes o junto con él, porque la nueva UI de asignación desde Inbox sería la primera superficie de producto que invita a un agente (rol más bajo que admin) a manipular `contact_tags` con frecuencia.

---

## B. Qué partes del alcance YA existen

| Requisito del alcance | Estado |
|---|---|
| Ver etiquetas del contacto | ✅ `ContactSidebar` (solo lectura) |
| Asignar una o varias | ❌ No hay UI en Inbox — pero el backend (`POST /api/contacts/[id]/tags`) ya existe y está probado |
| Quitar una relación | ❌ No hay UI en Inbox — backend (`DELETE /api/contacts/[id]/tags`) ya existe y probado |
| Crear nuevas etiquetas (nombre/color) | ✅ Existe en Settings (`TagManager`), pero con escritura raw y sin backend reutilizable — falta decidir si Inbox la reutiliza o llama un servicio compartido nuevo |
| Verlas inmediatamente | Parcial — el patrón "persistir-antes-de-actualizar-UI" ya existe en `ContactDetailView.toggleTag` y es reutilizable tal cual |
| Representación compacta en ConversationList | ❌ No existe — `ConversationItem` no renderiza `contact.tags` hoy |
| Filtrar Inbox por una o varias etiquetas | ✅ Completo, incluyendo UI |
| Mantener OR entre tags | ✅ `matchesContactFilters` (`.some`) |
| Combinar tags con otros filtros mediante AND | ✅ Filtros encadenados secuencialmente en `conversation-list.tsx` |
| Persistencia | ✅ Vía Postgres, ya con test suite en la capa de escritura |
| Aislamiento multi-account (aplicación) | ✅ `assertContactAndTagOwnership` en `tag-write.ts` — probado |
| Aislamiento multi-account (DB/RLS) | ❌ **Hueco confirmado** — ver sección G |
| Evitar N+1 | ✅ Ya resuelto por `INBOX_CONVERSATION_SELECT`'s embed; no debe introducirse ninguna query nueva por conversación |

---

## C. Qué partes faltan

1. UI de administración de tags en `ContactSidebar` (+, buscador, multi-select, quitar, crear).
2. Badges compactos en `ConversationItem`.
3. Endurecimiento DB del hueco cross-account en `contact_tags` (sección G).
4. Corrección de consistencia menor en `automations/engine.ts`'s paso `remove_tag` (bypassa el writer seguro — ver H).
5. Unicidad case-insensitive de `tags.name` (no existe ningún constraint hoy, ni siquiera exacto).
6. Validación server-side de `name`/`color` en creación de tag (hoy 100% frontend).
7. Catálogo de tags por defecto (no existe en absoluto).
8. Sincronización del estado de tags entre `ContactSidebar` y `ConversationList` tras una mutación (hoy son dos fuentes de estado independientes).
9. Traducciones ES/EN nuevas para la UI de administración.
10. Tests nuevos para todo lo anterior.

---

## D. Schema real de tags/contact_tags

**`tags`** (migración 001, extendida por 017):
```sql
CREATE TABLE tags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE  -- añadido en 017
);
```

**`contact_tags`** (migración 001, sin cambios de schema desde entonces):
```sql
CREATE TABLE contact_tags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contact_id, tag_id)
);
```

`contact_tags` **no tiene columna `account_id`** — su tenencia se deriva siempre indirectamente vía `contact_id → contacts.account_id`. Esto es la raíz estructural del hueco de la sección G.

---

## E. Constraints e índices

| Tabla | Constraint/índice | Confirmado |
|---|---|---|
| `contact_tags` | `PRIMARY KEY(id)` | Sí |
| `contact_tags` | `UNIQUE(contact_id, tag_id)` — **el único constraint real, sin duplicados**, vigente desde 001, nunca reemplazado | Sí — no debe crearse otro `UNIQUE` redundante |
| `contact_tags` | `idx_contact_tags_contact ON (contact_id)`, `idx_contact_tags_tag ON (tag_id)` | Sí, ambos no-únicos |
| `contact_tags` | FK `contact_id → contacts(id) ON DELETE CASCADE` | Sí |
| `contact_tags` | FK `tag_id → tags(id) ON DELETE CASCADE` | Sí |
| `tags` | `PRIMARY KEY(id)` | Sí |
| `tags` | `idx_tags_account ON (account_id)` | Sí, no-único |
| `tags` | **Ningún UNIQUE ni siquiera exacto sobre `name`** | Confirmado — "Pendiente" duplicado literal ya es posible hoy, sin hablar de mayúsculas |
| `tags` | Ningún CHECK sobre `color` (formato libre) | Confirmado |

---

## F. RLS real y matriz de permisos

`is_account_member(target_account_id, min_role DEFAULT 'viewer')` (migración 017, `SECURITY DEFINER`) rankea `owner(4) > admin(3) > agent(2) > viewer(1)` y compara `>=`.

| Tabla | Policy | Regla | Rol mínimo |
|---|---|---|---|
| `tags` | `tags_select` | `is_account_member(account_id)` | viewer+ |
| `tags` | `tags_insert` | `is_account_member(account_id, 'admin')` | admin+ |
| `tags` | `tags_update` | `is_account_member(account_id, 'admin')` | admin+ |
| `tags` | `tags_delete` | `is_account_member(account_id, 'admin')` | admin+ |
| `contact_tags` | `contact_tags_select` | `EXISTS(...contacts c... is_account_member(c.account_id))` | viewer+ |
| `contact_tags` | `contact_tags_modify` (FOR ALL = insert+update+delete) | `EXISTS(...contacts c... is_account_member(c.account_id, 'agent'))`, mismo predicado en `USING` y `WITH CHECK` | agent+ |

Confirmado: **ninguna migración posterior a 017** (018 a 046) toca las policies de `tags` ni `contact_tags`. La matriz descrita por el usuario es exacta y sigue vigente sin cambios.

**Matriz funcional resultante** (aplicación de la matriz permitida por RLS + el guard `requireRole` del endpoint existente):

| Rol | Ver | Asignar/Quitar | Crear tag |
|---|---|---|---|
| viewer | ✅ | ❌ | ❌ |
| agent | ✅ | ✅ | ❌ |
| admin | ✅ | ✅ | ✅ |
| owner | ✅ | ✅ | ✅ |

Coincide exactamente con la propuesta funcional preliminar del encargo. **No requiere cambios** para el alcance actual.

**Si en el futuro `agent` debe poder crear tags**: cambiar `tags_insert`'s `is_account_member(account_id, 'admin')` → `'agent'` (una sola migración, un solo `DROP POLICY`+`CREATE POLICY`), y en el endpoint de creación que se diseñe (sección J) cambiar `requireRole('admin')` → `requireRole('agent')`. Ningún otro archivo depende de este umbral hoy.

---

## G. Confirmación del hueco cross-account

**CONFIRMADO — sigue vigente en el schema actual de `main`.**

```sql
-- supabase/migrations/017_account_sharing.sql
CREATE POLICY contact_tags_modify ON contact_tags FOR ALL USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent'))
);
```

El `WITH CHECK` valida **solo** que `contact_id` pertenezca a una cuenta donde el llamante es `agent`+. **No hay ninguna cláusula que valide `tag_id`.** Como `contact_tags` no tiene `account_id` propio, nada en el schema impide:

```sql
INSERT INTO contact_tags (contact_id, tag_id)
VALUES ('<contacto de la cuenta A>', '<tag UUID de la cuenta B>');
```

si el llamante conoce (o adivina/filtra) el UUID de un tag ajeno.

**Impacto real si se explota**: no es una fuga de lectura directa — cuando la cuenta A intenta leer el tag embebido (`contact_tags(tags(*))`), la policy `tags_select` de la cuenta B lo bloquea, así que PostgREST devuelve `tags: null` para esa fila (y el código actual de `ContactSidebar`/`ContactDetailView` filtra explícitamente `.filter(ct => ct.tags)`, ocultando la fila fantasma). El daño real es de **integridad, no de confidencialidad**: una fila huérfana cross-tenant queda en `contact_tags`, cuenta para el índice/constraint, y —lo más grave— si la cuenta B **elimina** ese tag más tarde, el `ON DELETE CASCADE` borra silenciosamente esa relación de la cuenta A como efecto colateral de una acción tomada enteramente dentro de la cuenta B. Es una violación real del aislamiento de tenants, aunque de bajo impacto inmediato.

### Explotabilidad hoy vía código de aplicación

Se auditaron **todos** los `INSERT`/`UPSERT` actuales contra `contact_tags` en el repo:

| Sitio | Mecanismo | ¿Valida `tag_id` cross-account? |
|---|---|---|
| `tag-write.ts` → `addContactTagIfAbsent` | `assertContactAndTagOwnership` explícito | ✅ Sí — valida contact Y tag |
| `automations/engine.ts` → `add_tag` | Llama a `addContactTagIfAbsent` | ✅ Sí (heredado) |
| `flows/engine.ts` → `set_tag` (modo add) | Llama a `addContactTagAndDispatch` → `addContactTagIfAbsent` | ✅ Sí (heredado) |
| `resolve-import-tags.ts` → `assignImportedContactTags` (CSV import, API v1 PATCH) | `upsert` raw, pero `tag_id` proviene **siempre** de `resolveImportTagIds`, que solo resuelve/crea tags con `.eq('account_id', accountId)` | ✅ Seguro por construcción (nunca acepta un `tag_id` crudo del cliente, solo nombres) |

**Conclusión de explotabilidad**: hoy, **ningún camino de la aplicación permite insertar un `tag_id` ajeno** — el hueco solo es alcanzable mediante (a) una llamada REST directa a Supabase desde el navegador (`supabase.from('contact_tags').insert(...)`, protegida únicamente por RLS), o (b) un futuro código que —como advierte el propio encargo— haga un insert crudo en vez de reusar el writer. Es decir: **el hueco es real y debe cerrarse en la BD**, no como parche urgente de un ataque ya explotado, sino como defensa-en-profundidad obligatoria antes de dar a los agentes (rol más bajo con permiso de escritura) una superficie de producto —el nuevo "+"" de Inbox— que hace mucho más fácil, frecuente y tentador escribir directamente desde el cliente.

### Hallazgo relacionado (inconsistencia, no explotable hoy)

`src/lib/automations/engine.ts`, paso `remove_tag`:
```ts
// See add_tag: tenant scoping relies on the runAutomationsForTrigger
// ownership guard, since contact_tags carries no account_id.
await db.from('contact_tags').delete()
  .eq('contact_id', args.contactId)
  .eq('tag_id', cfg.tag_id)
```
Bypassa `removeContactTag()` con un `delete` raw, sin revalidar que `cfg.tag_id` pertenezca a la cuenta del automation. Hoy es **benigno** (un `DELETE` solo puede borrar una fila que ya exista con ese `contact_id` exacto — ya scoped a la cuenta correcta por el dispatcher — así que en el peor caso es un no-op contra una fila cross-tenant que, per el punto anterior, no debería existir de todas formas), pero es inconsistente con `add_tag` (que sí usa el writer seguro) y con `flows/engine.ts`'s `set_tag`, que usa `removeContactTag()` correctamente en ambos sentidos. Se recomienda alinearlo en una fase de limpieza — **no se toca en esta auditoría**.

### Opciones evaluadas para el endurecimiento DB mínimo

**A. Reforzar solo RLS** (añadir un segundo `EXISTS` sobre `tags` en `USING`/`WITH CHECK`): barato, sin cambio de schema, cierra el hueco para escrituras vía cliente autenticado (RLS-scoped). **Insuficiente en solitario**: no protege escrituras vía `service_role` (webhook, `flows/engine.ts`, `automations/engine.ts` corren con `supabaseAdmin()`, que **bypassa RLS por diseño**) — y el propio encargo exige explícitamente proteger "escrituras no provenientes del UI".

**B. Trigger de integridad same-account** (`BEFORE INSERT OR UPDATE OF contact_id, tag_id ON contact_tags`): compara `contacts.account_id` del `NEW.contact_id` contra `tags.account_id` del `NEW.tag_id`; `RAISE EXCEPTION` si difieren. Corre para **cualquier rol**, incluido `service_role` — cierra el hueco de forma uniforme sin importar el camino de escritura. Sin cambio de schema. Precedente idéntico ya existente en este mismo repo: `contacts_require_phone_on_write` (migración 046).

**C. Añadir `account_id` a `contact_tags` + FK compuesta** (`FOREIGN KEY (contact_id, account_id) REFERENCES contacts(id, account_id)` y lo mismo contra `tags`, requiriendo `UNIQUE(id, account_id)` en ambas tablas padre): la opción más robusta a largo plazo (constraint declarativo, no procedural; permite simplificar RLS a `USING (account_id = ...)` sin subconsulta; permite indexar/filtrar por cuenta directamente). Pero es una migración bastante más grande: nueva columna, backfill de todas las filas existentes, nuevos `UNIQUE` en `contacts`/`tags`, dos FKs compuestas nuevas, actualización de **todos** los writers (`tag-write.ts`, `automations/engine.ts`, `resolve-import-tags.ts`) para poblar la columna nueva, y reescritura de las 2 policies. Desproporcionado para lo pedido ("MÍNIMO").

**D. Descartada**: usar `WITH CHECK` en `tags_select`/embeds del lado del cliente (filtrar en la app, no en la BD) — exactamente lo que el patrón `.filter(ct => ct.tags)` ya hace hoy accidentalmente. No es una solución, es la razón por la que el síntoma pasó desapercibido.

**Recomendación: B (trigger) como guarda autoritativa, más A (RLS) como capa barata y redundante para fallar rápido en escrituras RLS-scoped.** Mismo patrón "belt-and-suspenders" ya usado en el propio repo (el trigger de teléfono de la migración 046 convive con las RLS existentes sobre `contacts`). C queda documentado como alternativa de mayor alcance para una futura fase de endurecimiento estructural, no para esta prioridad.

**Diseño conceptual de la migración 047** (NO creada aún):
```sql
CREATE OR REPLACE FUNCTION public.contact_tags_require_same_account()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_contact_account UUID;
  v_tag_account UUID;
BEGIN
  SELECT account_id INTO v_contact_account FROM contacts WHERE id = NEW.contact_id;
  SELECT account_id INTO v_tag_account     FROM tags     WHERE id = NEW.tag_id;
  IF v_contact_account IS NULL OR v_tag_account IS NULL OR v_contact_account <> v_tag_account THEN
    RAISE EXCEPTION 'contact_tags: contact and tag must belong to the same account'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_contact_tags_require_same_account
  BEFORE INSERT OR UPDATE OF contact_id, tag_id ON contact_tags
  FOR EACH ROW EXECUTE FUNCTION public.contact_tags_require_same_account();

-- Complemento RLS (mismo archivo o migración separada):
DROP POLICY IF EXISTS contact_tags_modify ON contact_tags;
CREATE POLICY contact_tags_modify ON contact_tags FOR ALL USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent'))
  AND EXISTS (
    SELECT 1 FROM contacts c JOIN tags t ON t.account_id = c.account_id
    WHERE c.id = contact_tags.contact_id AND t.id = contact_tags.tag_id
  )
);
```
No se ha creado el archivo — queda como diseño para la fase de implementación.

---

## H. Servicios/writers existentes que debemos reutilizar

**Para asignar/quitar (Inbox) — reutilizar tal cual, cero backend nuevo:**
- Cliente: [src/lib/contacts/tag-api.ts](src/lib/contacts/tag-api.ts) — `addContactTag(contactId, tagId)` / `deleteContactTag(contactId, tagId)`.
- Servidor: `POST`/`DELETE /api/contacts/[id]/tags` ([src/app/api/contacts/[id]/tags/route.ts](src/app/api/contacts/[id]/tags/route.ts)) — `requireRole('agent')`, ya usa `addContactTagAndDispatch`/`removeContactTag`, ya tiene test suite.
- Ya usado en producción por `ContactDetailView` (Contacts) — **no es código nuevo, es reutilización directa**.

**Patrón de UX a reutilizar** (no solo el servicio): `ContactDetailView.toggleTag()` ya implementa exactamente "persistir primero → actualizar estado local solo tras éxito → toast de error si falla, sin chip fantasma" — es el mismo comportamiento pedido para `ContactSidebar`.

**Para crear tags**: no existe un servicio compartido hoy — `TagManager` hace `insert` raw. Ver sección J para la propuesta.

**Confirmaciones de `tag-write.ts`/`tag-events.ts`/`tag-chain.ts`** (todas ya con test suite en verde):
- `assertContactAndTagOwnership`: valida `contact.account_id` Y `tag.account_id` contra el `accountId` del caller — confirmado por lectura y por el test `'refuses contacts and tags outside the account'`.
- Tratamiento `23505`: `addContactTagIfAbsent` lo captura y devuelve `false` (idempotente, no lanza) — confirmado por test.
- Side effect `tag_added`: `addContactTagAndDispatch` dispara `runAutomationsForTrigger({triggerType:'tag_added', ...})` **solo** cuando la fila se creó de verdad (no en duplicados), con límite de profundidad de cadena (`MAX_TAG_CHAIN_DEPTH = 3`) para evitar loops A→B→A — confirmado por test.
- Consumidores actuales del side effect: webhook de asignación (`/api/contacts/[id]/tags`), API pública v1 (`PATCH /api/v1/contacts/{id}`), motor de Automations (`add_tag` step), motor de Flows (`set_tag` step, modo add).

---

## I. Side effects existentes de `tag_added` que debemos preservar

La nueva UI de Inbox **debe** llamar `addContactTag()`/el endpoint existente (nunca un insert directo) precisamente para preservar:
1. El disparo de automatizaciones con `triggerType: 'tag_added'` — cualquier automation configurada con ese trigger debe seguir disparándose cuando un agente etiqueta desde Inbox, exactamente igual que si lo hiciera desde Contacts.
2. El límite de profundidad de cadena de 3 niveles (evita que dos automations que se etiquetan mutuamente entren en loop infinito).
3. La semántica "no-op idempotente" — asignar un tag ya presente nunca debe re-disparar `tag_added`.

Ningún cambio de este alcance debe tocar `tag-events.ts`/`tag-chain.ts` — están fuera del alcance ("nuevas automatizaciones" está explícitamente excluido) y ya hacen exactamente lo necesario.

---

## J. Estrategia para creación de tag

No existe hoy ningún endpoint ni helper compartido de creación — solo el insert raw de `TagManager`. Propuesta:

1. **Nuevo helper de servidor**, ej. `src/lib/contacts/tag-create.ts`, con una función `createTag(db, { accountId, userId, name, color })` que:
   - `name`: `trim()`; rechaza vacío; longitud máxima explícita (ej. 40, igual al `maxLength` que ya usa `TagManager` en el input, para no romper la expectativa visual existente); compara duplicados de forma case-insensitive (`lower(trim(name))`) contra los tags existentes de la cuenta **antes** de insertar, devolviendo un error claro y estable (ej. `tag_name_conflict`) en vez de dejar que el índice único (sección K) lo rechace con un 23505 crudo.
   - `color`: validar formato `#RRGGBB` estricto (regex), o restringir a la paleta ya usada por `TagManager` (`PRESET_COLORS`) — recomendado lo segundo por simplicidad y consistencia visual, con fallback a validación de formato si en el futuro se permite un color picker libre.
   - Nunca confía en el frontend: esta validación debe repetirse server-side aunque el formulario ya la aplique (el propio encargo lo pide explícitamente).
2. **Nuevo endpoint mínimo**, ej. `POST /api/tags`, `requireRole('admin')` (coincide con `tags_insert`'s umbral RLS), delegando en `createTag()`.
3. **Refactor de `TagManager`** para llamar a este mismo endpoint en vez de su insert raw actual — unifica la única ruta de escritura pedida por el encargo, sin duplicar validación entre Settings e Inbox.
4. La nueva UI de `ContactSidebar` (sección M) llama al mismo endpoint para "Crear nueva etiqueta", y tras un 201 puede encadenar inmediatamente `addContactTag()` para asignarla al contacto activo.

Este es el único cambio de esta auditoría que introduce un archivo de backend genuinamente nuevo — todo lo demás (asignar/quitar) reutiliza lo existente.

---

## K. Estrategia para case-insensitive uniqueness

Hoy: cero protección, ni exacta ni case-insensitive.

**Migración propuesta** (no creada), en dos pasos obligatorios:

1. **Preflight de duplicados** (script/consulta de solo lectura, ejecutado manualmente contra producción ANTES de decidir aplicar el índice — no automatizado, no en la migración):
   ```sql
   SELECT account_id, lower(trim(name)) AS key, array_agg(id ORDER BY created_at) AS tag_ids, count(*)
   FROM tags
   GROUP BY account_id, lower(trim(name))
   HAVING count(*) > 1;
   ```
   Si devuelve filas, **NO fusionar automáticamente** (perdería historial de qué contactos tenían cuál fila exacta, y `contact_tags` no tiene manejo de conflicto para colapsar dos `tag_id` distintos en un contacto que ya tuviera ambos). Requiere decisión humana caso por caso — fuera del alcance de esta fase, tal como pide el encargo.
2. **Índice único condicionado** a que el preflight salga limpio (o tras sanear manualmente los históricos detectados):
   ```sql
   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_tags_account_name_ci
     ON tags (account_id, lower(trim(name)));
   ```
   (`CONCURRENTLY` para no bloquear escrituras en producción durante la construcción del índice; requiere ejecutarse fuera de una transacción, con las salvedades habituales de Supabase CLI/migraciones para índices concurrentes).
3. El helper `createTag()` (sección J) debe hacer su propio chequeo case-insensitive **antes** del insert (para dar un error de negocio legible), y además capturar `23505` sobre este índice como red de seguridad ante una carrera — mismo patrón ya usado en `findOrCreateContact`/`isUniqueViolation` en otras partes del código.

---

## L. Estrategia para defaults de cuentas existentes/futuras

Confirmado: no existe ningún INSERT a `tags` en migraciones, seed, ni en `handle_new_user()` (el trigger de provisioning de cuenta, migración 017). No hay `supabase/seed.sql`. El catálogo pedido (Favoritos, Pendiente, Pedido confirmado, Pendiente de pago, Reclamo, Cliente frecuente) no existe en ningún lado del código ni de la base de datos.

**Diseño propuesto** (no implementado):

- **A. Cuentas futuras**: extender `handle_new_user()` (migración 017's función, re-`CREATE OR REPLACE`) para insertar el catálogo fijo de 6 tags inmediatamente después de crear la `account`, con `account_id = v_account_id` recién generado. Debe ser tolerante a fallos igual que el resto de la función (ya envuelve todo en `EXCEPTION WHEN OTHERS` con `RAISE WARNING`, nunca bloquea el signup) — los inserts de tags deben incluirse dentro de ese mismo bloque protegido.
- **B. Cuentas existentes**: una migración idempotente de backfill, ej.:
  ```sql
  INSERT INTO tags (account_id, user_id, name, color)
  SELECT a.id, a.owner_user_id, d.name, d.color
  FROM accounts a
  CROSS JOIN (VALUES
    ('Favoritos', '#f59e0b'), ('Pendiente', '#3b82f6'), ('Pedido confirmado', '#10b981'),
    ('Pendiente de pago', '#ef4444'), ('Reclamo', '#ec4899'), ('Cliente frecuente', '#8b5cf6')
  ) AS d(name, color)
  WHERE NOT EXISTS (
    SELECT 1 FROM tags t WHERE t.account_id = a.id AND lower(trim(t.name)) = lower(d.name)
  );
  ```
  El `WHERE NOT EXISTS` la hace re-ejecutable (idempotente) y evita duplicar el default en una cuenta que YA tenga manualmente un tag llamado, por ejemplo, "Pendiente" — respeta el trabajo ya hecho por el usuario en vez de duplicarlo. Debe aplicarse **después** de que exista el índice case-insensitive de la sección K (o al menos después del preflight), para no introducir sus propios duplicados.
- Nombres NUNCA hardcodeados en el frontend — viven solo en la migración/función de provisioning, tal como pide el encargo.

---

## M. Diseño UI mínimo

**`ContactSidebar`** — cambio dentro del bloque "Tags" existente (líneas 186-210 del archivo actual):

```
ETIQUETAS                         [+]
[tag actual ×] [tag actual ×]
```

- El `[+]` abre un popover (reutilizar `DropdownMenu`/`Popover` ya presente en el proyecto, mismo patrón que el filtro de tags de `ConversationList`) con:
  - Input de búsqueda por nombre.
  - Lista de tags de la cuenta (ya cargada — ver "sin N+1" abajo) como checkboxes; togglear cada uno llama `addContactTag`/`deleteContactTag` (sección H) siguiendo el patrón "persistir → luego reflejar" de `ContactDetailView.toggleTag`.
  - Al pie, "Crear nueva etiqueta" — **visible solo si el rol del usuario actual es admin+** (mismo check que ya usa el resto de la UI de settings, ej. `canEditSettings`/similar ya usado en `import-modal.tsx`) — abre un mini-formulario inline (nombre + swatches, mismo componente visual que `TagManager`) que llama al endpoint de la sección J y, tras éxito, la asigna inmediatamente al contacto activo.
- Quitar: el `×` en cada chip llama `deleteContactTag` directamente, sin confirmación (elimina solo la relación, nunca el tag — ya así en el backend, `DELETE` solo borra de `contact_tags`).
- Error visible: `toast.error` (patrón ya usado en todo el resto de `ContactSidebar`/`ContactDetailView`), sin mutar el estado local si la llamada falla.

**Fuente de datos recomendada (mejora sobre el sketch original)**: `ContactSidebar` hoy hace su **propia** consulta a `contact_tags` (línea 59-62 del archivo actual), redundante con el `contact.tags` que `INBOX_CONVERSATION_SELECT` ya trae para la conversación activa. Se recomienda que `ContactSidebar` reciba `contact.tags` como parte de la prop `contact` que ya recibe (sin fetch propio) y exponga un callback `onTagsChanged(contactId, tags)` — exactamente el mismo patrón que ya usan `onStatusChange`/`onAssignChange`/`onContactBlocked` entre `MessageThread` e `inbox/page.tsx`. Esto elimina una consulta redundante y resuelve de raíz el problema de sincronización de la sección N.

---

## N. Diseño de sincronización/realtime

**Mínimo exigido y suficiente para esta fase**: tras un `addContactTag`/`deleteContactTag`/`createTag` exitoso, el estado local debe quedar consistente **sin recargar la página**, y nunca debe quedar un chip optimista si la escritura falla.

**Diseño recomendado** (evita añadir infraestructura nueva):
1. `ContactSidebar` reporta el cambio hacia arriba vía `onTagsChanged` (sección M) en vez de mantener su propio estado aislado.
2. `inbox/page.tsx` (dueño de `conversations`/`activeConversation`) aplica el patch al array `conversations` y a `activeConversation`/`activeContact` en memoria — mismo mecanismo ya usado para `handleStatusChange`/`handleAssignChange`. Esto resuelve automáticamente "cambio Contact A → B sin estado visual arrastrado" (el estado vive en el padre, indexado por conversación, no en un `useState` local de `ContactSidebar` que sobreviva al cambio de `contact` prop).
3. **No se propone** una nueva suscripción realtime a `contact_tags`/`tags` en esta fase: el hook `useRealtime` actual solo escucha `messages`/`conversations` (payloads planos, sin joins) — añadir tags requeriría resolver `tag_id → {name,color}` client-side contra el catálogo ya cargado y parchear el `contact_id` correcto dentro de `conversations`, complejidad no justificada por el requisito mínimo declarado ("operación exitosa → estado local consistente").
4. **Multi-pestaña/multi-agente**: se apoya en el mecanismo `resyncToken` ya existente (reconexión, cambio de visibilidad, botón de refresco manual) — como ese refetch vuelve a traer `INBOX_CONVERSATION_SELECT` completo, los tags de otros agentes llegan "razonablemente" (no instantáneo, pero sin construir nada nuevo), que es exactamente lo que el encargo permite explícitamente.
5. Si en el futuro se decide que la sincronización cross-agente debe ser instantánea, quedaría documentado como mejora posterior (suscripción a `contact_tags` filtrada por los `contact_id` visibles en la lista actual) — no se diseña en detalle aquí por ir más allá del mínimo pedido.

---

## O. Diseño de carga de badges sin N+1

`INBOX_CONVERSATION_SELECT` (`"*, contact:contacts!inner(*, contact_tags(tags(*)))"`) **ya trae** `contact.tags` para cada conversación en la misma consulta inicial — confirmado por lectura de [src/lib/inbox/conversations.ts](src/lib/inbox/conversations.ts). Añadir badges a `ConversationItem` es **puramente de renderizado**: leer `conversation.contact?.tags` (ya en memoria) y pintar hasta N chips + un contador `+N`. **Cero queries nuevas.**

**Diseño de la representación compacta**:
- Máximo visible: 2 tags a ancho completo de card (320px) — más que eso satura la fila de una sola línea junto al nombre/hora ya presentes.
- Resto: chip `+N` (ej. `+3`), sin texto, con `title="tag3, tag4, tag5"` para accesibilidad/hover en desktop.
- Truncado: cada chip de tag trunca su texto a un ancho fijo (`max-w-16 truncate`, patrón ya usado para `company`/`tag?.name` en el propio `conversation-list.tsx`).
- Mobile: mismo componente — a este ancho de card no hay layout separado; si el badge de "needs human attention"/unread ya compite por espacio, los tags se muestran en una segunda línea debajo del preview del último mensaje, nunca empujando el timestamp fuera de vista.
- Colores: `backgroundColor: ${tag.color}20, color: tag.color` — mismo patrón exacto ya usado en `ContactSidebar`/`ContactDetailView`/`TagManager` (consistencia visual gratis, cero decisiones de diseño nuevas).
- **No debe alterar** `matchesContactFilters`/la lógica de filtrado existente — es una capa de presentación adicional sobre datos ya filtrados, no una nueva fuente de verdad.

---

## P. Plan de tests

**Mantener intactos** (ya en verde, no tocar): `tag-write.test.ts`, `tag-events.test.ts`, `route.test.ts` de `/api/contacts/[id]/tags`, `conversation-list.test.tsx` (filtros existentes).

**Nuevos, por capa:**

*Unitarios (vitest, mocks — igual que los existentes):*
1. `tag-create.ts`: nombre vacío → rechazo; nombre con espacios → trim; nombre duplicado case-insensitive (Pendiente/pendiente/PENDIENTE) → rechazo con código estable; color inválido (si se valida formato) → rechazo; creación válida → tag persistida con `account_id` correcto.
2. `POST /api/tags` (nuevo endpoint): 401/403 por rol (viewer/agent rechazados, admin+ aceptado); 409/400 en nombre duplicado; 201 en éxito.
3. Regresión explícita de permisos ya confirmados: viewer no puede `POST`/`DELETE /api/contacts/[id]/tags` (ya cubierto indirectamente por `requireRole`, añadir un caso explícito si no existe hoy en `route.test.ts`).
4. **Cross-account tag_id** — el caso que `tag-write.test.ts` ya cubre a nivel de aplicación (`'refuses contacts and tags outside the account'`); **añadir** un caso equivalente para el nuevo endpoint de creación si aplica.

*RLS/trigger (fuera de vitest — requiere Postgres real):*
5. Smoke test estilo `supabase/ci/_smoke_*.sql` (mismo patrón usado para la migración 046 de P1, vía Supabase CLI local + Docker, NUNCA contra producción): insertar `contact_tags` con `tag_id` de otra cuenta → debe fallar (antes del fix, confirmar que efectivamente pasa hoy sin el trigger — ES el reproducible del hueco; después del fix, confirmar rechazo).
6. Mismo smoke test: confirmar que un insert/delete legítimo (mismo account) sigue funcionando tras añadir el trigger — no debe romper ningún flujo existente (webhook, automations, flows, CSV import).

*Componentes (Testing Library, patrón de `conversation-list.test.tsx`/`flow-start-picker.test.tsx`):*
7. `ContactSidebar`: etiquetas existentes se muestran; asignar una (éxito) actualiza UI; asignar (fallo de red) NO deja chip fantasma y muestra error; quitar relación elimina el chip; abrir "+" lista tags disponibles marcando los ya asignados; "Crear nueva etiqueta" oculto para agent, visible para admin; crear tag nueva la deja disponible inmediatamente para asignar.
8. Cambio de contacto activo (A → B) no arrastra estado de selección/carga del contacto anterior.
9. `ConversationItem`: badges compactos con truncado y `+N`; no dispara ninguna query adicional al renderizar (assert sobre el mock de fetch/supabase — cero llamadas nuevas).
10. Filtros existentes (`OR` entre tags, `AND` con búsqueda/estado, "limpiar filtros") — regresión, no deben cambiar de comportamiento con los badges añadidos.

*Idempotencia/duplicados (ya cubierto, confirmar que sigue):*
11. `addContactTagIfAbsent` con relación ya existente → `false`, sin `tag_added` duplicado (ya existe, mantener).

---

## Q. Migraciones que serían necesarias (NO creadas)

Siguiente número disponible en `main`: **047**.

1. **047 — `contact_tags_require_same_account`**: trigger + refuerzo de RLS (sección G). Independiente de las demás — puede ir sola y primero.
2. **048 — `tags_name_ci_unique`**: índice único case-insensitive (sección K), **condicionada** al preflight manual de duplicados históricos. Puede requerir ejecutarse en dos sesiones (preflight de solo lectura, luego la migración) si el preflight encuentra colisiones que haya que resolver a mano primero.
3. **049 — `tags_account_defaults`**: backfill idempotente para cuentas existentes + extensión de `handle_new_user()` para cuentas futuras (sección L). Debe ir **después** de 048 (para no crear sus propios duplicados contra el índice nuevo).

Ninguna de las tres es estrictamente bloqueante para empezar la UI de asignación (que ya tiene backend seguro) — pero **047 debería preceder** a la fase de UI si se quiere evitar exponer la superficie de escritura de Inbox mientras el hueco cross-account sigue abierto.

---

## R. Orden final recomendado de implementación

1. **047** (trigger + RLS cross-account) — cierra el hueco de seguridad antes de dar más superficie de escritura a agentes.
2. Refactor `ContactSidebar` para recibir `contact.tags` por prop + `onTagsChanged` (elimina su fetch redundante) — cambio de bajo riesgo, prepara el terreno.
3. UI de asignar/quitar en `ContactSidebar` (reutilizando `tag-api.ts`) — entrega valor inmediato sin tocar creación ni schema.
4. Badges compactos en `ConversationItem` — puramente de presentación, sin dependencias de lo anterior salvo el tipo `Contact.tags` ya existente.
5. `tag-create.ts` + `POST /api/tags`, refactor de `TagManager` para usarlo.
6. **048** (unicidad case-insensitive) — después de tener `createTag()` listo para consultarla en el flujo de validación.
7. "Crear nueva etiqueta" dentro de `ContactSidebar`, apoyada en el endpoint del paso 5.
8. **049** (catálogo por defecto) — al final, para que ya exista la unicidad case-insensitive y el helper de creación reutilizable a la hora de decidir cómo tratar colisiones con tags que el cliente ya haya creado manualmente.
9. Tests (sección P) en paralelo a cada paso, no al final.

---

## S. Riesgos

- **El hueco cross-account (G) es el único hallazgo con calificación de seguridad real** — bajo impacto inmediato (no hay lectura cruzada, solo integridad), pero se agrava directamente por el propio trabajo de esta prioridad si se construye la UI de Inbox antes de cerrarlo.
- El backfill de tags por defecto (L) debe ejecutarse con cuidado en cuentas con muchos usuarios: `handle_new_user()` ya tiene su propio `EXCEPTION WHEN OTHERS` — los nuevos inserts de tags deben quedar dentro de ese mismo bloque para no convertir un fallo de tags en un fallo de signup.
- El índice único case-insensitive (K) puede exponer colisiones históricas inesperadas en cuentas antiguas — el preflight es obligatorio y no debe saltarse "porque parece poco probable".
- Reescribir `TagManager` para usar el nuevo endpoint (J) toca un componente en producción activo — requiere regresión visual/funcional completa de Settings, no solo de Inbox.
- Ninguno de los cambios de esta fase debería degradar el rendimiento del Inbox: la disciplina "sin N+1" ya está garantizada por el embed existente; el riesgo real es que una futura suscripción realtime a tags (explícitamente NO diseñada aquí) se añada sin medir su costo en cuentas con muchas conversaciones simultáneas.

---

## T. Verificación de la propia auditoría

```
git status --short   → (sin salida: árbol de trabajo limpio, único archivo nuevo es este documento, sin commit)
```
