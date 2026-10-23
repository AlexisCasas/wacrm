# Audios por producto — Fase 2: selección de UN audio (finalidad + identificador)

Estado: implementado en la rama `feat/audio-selection-ui-engine`, **sin desplegar**. Requiere la migración 076 (ya aplicada en producción el 23-oct-2026, no se modifica). Este documento recoge el diseño, el orden de implementación, las decisiones y las pruebas.

## 1. Qué permite

1. Un administrador crea y administra **finalidades** (Pago, Provincia, Promoción…) e **identificadores** (Principal, Alternativo…) por cuenta.
2. Clasifica cada audio de un producto con una finalidad **y** un identificador (o ninguno).
3. El nodo existente **Audios por producto** (`send_product_audios`) envía **todos** los audios (comportamiento de siempre) o **uno específico**: el del producto con esa finalidad e identificador.
4. Si no hay audio coincidente, el Flow sigue por la ruta «sin audios».
5. Los Flows y nodos anteriores funcionan exactamente igual: un nodo sin `audio_selection` es «todos».

No se creó un nodo nuevo, ni un segundo motor de envíos: el ejecutor, la secuencia y el reanudador son los de siempre.

## 2. Orden de implementación (cada etapa verificada antes de la siguiente)

| Etapa | Contenido | Verificación |
|---|---|---|
| F2-A | Servicio y API de finalidades/identificadores; clasificación de audios en el catálogo | 45 pruebas de rutas + modelo contrastado con el SQL real |
| F2-C (motor) | Contrato del nodo (`audio_selection`), validación, ejecución con `audio_guide_open_selected_request` / `audio_guide_record_selected_skip`, comprobación al activar | 40+ pruebas del runner, 3 mutaciones que las hacen fallar |
| F2-B | Pantalla de administración: catálogos y clasificación por audio | 21 pruebas de interfaz |
| F2-C (editor) | Selector «todos / uno específico», finalidad e identificador por nombre, avisos | 14 pruebas del editor |
| Cierre | Regresión completa, tipos, lint, build, prueba diferencial contra PostgreSQL real | ver §8 |

## 3. Contrato exacto de las siete funciones de 076 (service role, SECURITY INVOKER)

| Función | Argumentos | Respuestas |
|---|---|---|
| `audio_guide_save_purpose` / `_identifier` | `p_account, p_id` (NULL = crear), `p_name`, `p_name_key`, `p_active` (los tres últimos con DEFAULT NULL) | `{ok:true,id}` · `duplicate_name` · `invalid_value` · `not_found` · `limit_reached` (50 / 100) |
| `audio_guide_delete_purpose` / `_identifier` | `p_account, p_id` | `{ok:true}` · `not_found` · `in_use` (clave RESTRICT de los audios) |
| `audio_guide_classify_item` | `p_account, p_item, p_expected` (revisión del producto), `p_purpose, p_identifier` (ambos o ninguno) | `{ok:true,revision}` · `not_found` · `revision_conflict`(+`revision`) · `invalid_value` · `purpose_not_found` · `identifier_not_found` · `purpose_inactive` · `identifier_inactive` · `duplicate_classification`(+`conflict_item`) |
| `audio_guide_open_selected_request` | `p_account, p_contact, p_conversation, p_run, p_trigger, p_product_key, p_expected_revision, p_purpose, p_identifier, p_node_key` (DEFAULT NULL) | `{ok:true,created,request_id,status,sends?}` · `product_unavailable` · `catalog_changed` · `purpose_unavailable` · `identifier_unavailable` · `audio_not_found` · `audio_disabled` |
| `audio_guide_record_selected_skip` | `p_account, p_contact, p_conversation, p_run, p_trigger, p_product_key, p_reason, p_purpose, p_identifier, p_node_key` (DEFAULT NULL) | `{ok:true,created}` (idempotente por `p_trigger`) |

Las reglas viven en la base: nombre único por cuenta (clave normalizada), límites 50/100, un audio por (producto, finalidad, identificador) **incluidos los desactivados**, claves compuestas por cuenta, clasificación «las dos o ninguna». La aplicación no duplica esa lógica: normaliza el nombre (para construir la clave que el SQL exige) y traduce las respuestas.

## 4. API (`/api/audio-guide`, mismo guardado que el resto)

Lectura: cualquier miembro. Escritura: rol `admin` (o `owner`). La cuenta sale siempre de la sesión (nunca del cuerpo, ruta o consulta). El módulo está cerrado (`403 voice_notes_disabled`) para cuentas sin él. Respuestas `Cache-Control: private, no-store`.

| Ruta | Acción |
|---|---|
| `GET /purposes`, `GET /identifiers` | lista por nombre con `in_use` (audios que lo usan) |
| `POST /purposes`, `POST /identifiers` `{name, active?}` | crea (201) · 409 `duplicate_name` · 422 `invalid_value`/`limit_reached` |
| `PATCH /purposes/:id`, `/identifiers/:id` `{name?, active?}` | renombra (cambiar mayúsculas/acentos solo es la misma clave: permitido) y activa/desactiva |
| `DELETE /purposes/:id`, `/identifiers/:id` | 200 · 409 `in_use` mientras algún audio lo use |
| `PUT /products/:id/items/:itemId/classification` `{expected_revision, purpose_id, identifier_id}` | UUIDs de la cuenta, o ambos `null`. 409 `duplicate_classification` (+`conflict_item`) / `revision_conflict` (+`revision`) / `purpose_inactive` / `identifier_inactive`; 422 `purpose_not_found` / `identifier_not_found`. Devuelve el producto refrescado |

Las referencias son **siempre por UUID**: un nombre en lugar de un id se rechaza (`reference_by_id_only`). El archivo OGG y su hash no se tocan nunca. El detalle del producto añade `purpose_id` / `identifier_id` a cada audio (`null` = sin clasificar; los 76 audios actuales empiezan así y nada los clasifica automáticamente).

## 5. Nodo `send_product_audios`

Campos nuevos, todos opcionales y compatibles: `audio_selection` (`"all"` por defecto, `"single"`), `purpose_id`, `identifier_id`.

| Configuración | Resultado |
|---|---|
| sin `audio_selection` o `"all"` | todos los audios activos, como siempre. Con `purpose_id`/`identifier_id` presentes: **inválido** (`product_audios_selection_conflict`) |
| `"single"` + ambos UUID | un solo audio |
| `"single"` sin uno de ellos, o con algo que no es UUID (p. ej. un nombre) | **inválido** (`…_purpose_missing` / `…_identifier_missing`): no se puede activar |
| cualquier otro valor | **inválido** (`…_selection_unsupported`): el ejecutor no envía nada (`node_config_invalid`); nunca se interpreta como «todos» |

Rutas: audio enviado → `next_node_key`; producto desconocido, sin valor o inactivo → `unknown_node_key`; **audio no disponible** (finalidad/identificador inactivo o inexistente o de otra cuenta, ningún audio con esa pareja, audio desactivado, producto sin audios activos) → `no_audios_node_key` con el motivo registrado; etiqueta requerida ausente → `gate_closed_node_key`. Un fallo de base de datos o una respuesta desconocida → el nodo **falla** (`request_open_failed`), no avanza ni envía.

Ejecución: producto (automático o manual) → `lookupProductAudios` → `audio_guide_open_selected_request` (un solo envío, posición 1, con la pausa propia del audio) → el mismo `runAudioSequence` y el mismo reanudador. El nodo solo reporta éxito si se envió el audio.

### Idempotencia: `trigger_message_id`
La solicitud es única por `(cuenta, trigger_message_id)`. Para «todos» la clave sigue siendo el id del mensaje entrante (o `run:<id>` en un inicio manual), sin cambios. Para «uno específico» es **`<id del mensaje>#<node_key>`**: dos nodos del mismo Flow para el mismo mensaje no se confunden, y el reintento del mismo nodo para el mismo mensaje encuentra su solicitud y no envía otra vez (`duplicate`). `node_key` se copia además (máx. 120) a `audio_guide_requests.node_key`; la columna `trigger_message_id` es `TEXT` sin límite de longitud. Las solicitudes antiguas no cambian y un nodo «todos» y uno «único» para el mismo mensaje usan claves distintas.

### Al activar un Flow
Además de la validación del grafo, `POST /api/flows/:id/activate`: finalidad e identificador **desconocidos** en la cuenta → error 422; **inactivos** → aviso; con producto manual, si ningún audio tiene esa pareja o está desactivado → aviso. Los avisos no bloquean y viajan en la respuesta (`warnings`).

## 6. Interfaz

- **Audios por producto**: panel plegable «Finalidades e identificadores» (crear, renombrar, activar/desactivar, eliminar con confirmación; uso por audios; eliminar bloqueado con explicación; errores siempre visibles; solo lectura para quien no es admin). En cada audio, dos selectores («Sin clasificar» por defecto) que guardan juntos al elegir los dos, botón «Quitar clasificación», valores inactivos/eliminados rotulados, y los errores (duplicado, inactivo, eliminado, revisión) en la propia fila. Reproductor, orden, pausas, interruptor y borrado no cambian.
- **Editor del nodo**: «¿Qué audios enviar?» (todos / uno específico) con ayuda y ejemplo; selectores de finalidad e identificador con **nombre visible y UUID guardado**; avisos de valor faltante, inactivo o eliminado; con producto manual, comprobación de que existe el audio con esa pareja. Al volver a «todos» se vacían finalidad e identificador (no queda ninguna condición oculta).
- Textos en `es` y `en`. `ko.json` es un archivo heredado, excluido a propósito de la paridad (`src/i18n/messages.test.ts`) y sin los espacios `AudioGuide` ni `Flows.builder.form.productAudios*`; no se tocó.

## 7. Compatibilidad y despliegue

- **Orden seguro**: esta versión no requiere ninguna migración nueva. Se despliega como una imagen más; 076 ya está en producción.
- **Imagen anterior (fase 0, `audio-guard-7b9208d7`)**: ante un nodo guardado por esta versión (`audio_selection: "single"`) **no envía nada** (validación y ejecución fallan cerradas). Comprobado con una prueba de usar y tirar sobre el código de ese commit.
- **Deshacer el despliegue** de la imagen no toca la base. `rollback-076.sql` queda prohibido en cuanto exista una finalidad, un identificador, un audio clasificado o una solicitud selectiva.
- G6 (una secuencia por atención comercial) **no** está iniciado.

## 8. Pruebas

| Capa | Archivo | Qué prueba |
|---|---|---|
| Rutas y servicio | `src/app/api/audio-guide/selection-routes.test.ts` | roles, módulo, sesión, CRUD, normalización, límites, aislamiento entre cuentas, clasificación, duplicados con audios desactivados, revisiones concurrentes, contrato de argumentos con el archivo real de 076 |
| Motor | `src/lib/flows/engine.product-audios.test.ts` (bloque «ONE specific audio») | envío exacto, producto automático/manual, pausa propia, sin coincidencia y rutas, idempotencia por mensaje y nodo, dos nodos, fallos de Meta y de base, reanudador, cuentas con nombres iguales |
| Contrato del nodo | `product-audios-config.test.ts`, `validate.product-audios-options.test.ts` | `all`/`single`/valores desconocidos, campos faltantes, conflictos |
| Activación | `src/app/api/flows/[id]/activate/route.test.ts` | cuenta ajena, inactivos, producto manual, avisos |
| Interfaz | `selection-ui.test.tsx`, `selection-form.test.tsx` | catálogos, clasificación, estados de error, permisos, editor |
| Modelo vs SQL real | `audio-selection-model.differential.test.ts` + `ops/076-audio-selection/audio-guide/produccion-076/test-modelo-vs-sql-076.sh` | 40 llamadas repetidas en un PostgreSQL desechable con las migraciones 001–076: mismas respuestas |

El modelo en memoria de las funciones de 076 se contrasta contra el SQL real, de modo que las pruebas rápidas no descansan en la opinión del propio modelo. Las pruebas de RLS con roles reales ya están en `ops/076-audio-selection/audio-guide/produccion-076/test-rls-permisos-076.sh` (PR #39).

## 9. Límites conocidos

- No se enviaron WhatsApp, audios ni plantillas reales, y no se escribió en la base de producción: todo con base en memoria o PostgreSQL desechable.
- La comprobación «hay un audio con esa pareja» del editor es informativa (lee el producto); la decisión final es siempre del servidor al enviar.
- Con producto **automático** no se puede saber en el editor si el contacto tendrá audio; el aviso lo dice.
- No hay prueba end-to-end del navegador (Playwright) contra una base real; la interfaz se prueba con jsdom y un servidor simulado.
