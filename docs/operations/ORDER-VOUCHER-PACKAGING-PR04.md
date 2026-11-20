# PR-04 · Voucher, OCR, validación, embalaje, evidencia y plantilla operativa

Estado: **implementado y probado solo en LOCAL** (Supabase local `127.0.0.1:55321/55322`). Sin push / PR / merge / deploy. **Producción no fue tocada y NO debe configurarse todavía.**
Rama: `feat/order-voucher-packaging-pr04`, creada desde `a1d76f3fb89439b692967f5781033ada058a9784` (PR-03). PR-02 (`98397aa…`) y PR-03 quedan intactos, incluidos sus tests.
Feature flag: `order_integration_settings.logistics_mvp_enabled` (el de PR-01; **no se creó otro**).

> Este documento es solo operación/rollback técnico LOCAL. **No es un plan de deploy.** El deploy se prepara en otra fase, con autorización explícita.

## Clasificación de lo entregado

| Parte | Estado |
|---|---|
| Modelo de datos, RLS, RPCs, bucket privado | IMPLEMENTADO Y PROBADO LOCALMENTE |
| Voucher individual / carga masiva / matching conservador / asociación manual | IMPLEMENTADO Y PROBADO LOCALMENTE |
| Evidencia desde el chat con snapshot privado | IMPLEMENTADO Y PROBADO LOCALMENTE |
| Embalaje + `order_template_dispatches` idempotente + `uncertain` | IMPLEMENTADO Y PROBADO LOCALMENTE (Meta **simulado**) |
| **ARQUITECTURA OCR** (`VoucherOcrProvider`, `not_configured`, `fake`) | **TERMINADA** |
| **PROVEEDOR OCR REAL** | **PENDIENTE** (no hay SDK, ni proveedor elegido, ni contrato de campos real) |
| **ARQUITECTURA PLANTILLA** | **IMPLEMENTADA LOCALMENTE** |
| **PLANTILLA REAL / QA META** | **PENDIENTE** (nombre, idioma, variables, header, DNI vacío, URL firmada/media con Meta) |
| UI de administración de `order_logistics_settings` | NO EXISTE (fuera de alcance; se carga por SQL / `service_role`) |

Fuera de alcance de PR-04 (no implementado): Shalom/tracking (PR-05), cobranza/pagos/`advance_payment_proof` (PR-06), cancelación tardía, `item_id` por producto, subida manual de evidencia.

## 1. Migrations (orden obligatorio, todas aditivas)

| # | Archivo | Responsabilidad |
|---|---|---|
| 1 | `20261129000000_order_logistics_model.sql` | 5 tablas, constraints, índices, triggers de inmutabilidad/auditoría. RLS habilitado, sin privilegios para el navegador |
| 2 | `20261129000001_order_logistics_security_rpcs.sql` | `order_logistics_access()`, policies SELECT-only, RPCs de voucher/OCR/revisión/asociación/embalaje (solo `service_role`) |
| 3 | `20261129000002_order_docs_storage.sql` | Bucket **privado** `order-docs`, sin policies para `anon`/`authenticated` |
| 4 | `20261129000003_order_evidence_rpc.sql` | `select_order_evidence()` |
| 5 | `20261129000004_order_template_dispatch_rpcs.sql` | `begin/mark_sending/finish/resolve_template_dispatch` y el helper interno de cierre |
| 6 | `20261129000005_order_evidence_upload.sql` | evidencia de embalaje SUBIDA desde el dispositivo: relaja un CHECK de `order_documents` (evidencia con `source='upload'`), añade el evento `evidence_uploaded` y la RPC `register_order_evidence_upload()` |

Todas sortean **después** de `20261128000000_conversation_routing.sql` (PR-03). Ninguna modifica migrations históricas ni objetos de PR-02/PR-03 (verificado por `migration-order-logistics.test.ts` y `migration-pr03-compat.test.ts`).

## 2. Objetos creados

**Tablas** (todas con `account_id`, FK compuesta `(order_id, account_id)` a `order_confirmations` y RLS SELECT-only):
`order_logistics` (1 fila por pedido; **sin fila = `pending_voucher`**, sin backfill), `order_documents` (voucher y snapshot de evidencia), `order_template_dispatches` (estado operativo del envío de la plantilla), `order_logistics_events` (auditoría append-only), `order_logistics_settings`.

**Estados visibles** (`order_logistics.status`): `pending_voucher` → `voucher_validated` → `packing` → `ready_for_dispatch`. Los estados técnicos (OCR, asociación, dispatch) **no** son estados del pedido.

**RPCs** (solo `service_role`; cada una revalida actor, cuenta, flag, área y propiedad del pedido): `register_order_document`, `begin_document_ocr`, `complete_document_ocr`, `fail_document_ocr`, `associate_order_document`, `review_order_document`, `start_order_packaging`, `select_order_evidence`, `register_order_evidence_upload`, `begin_template_dispatch`, `mark_template_dispatch_sending`, `finish_template_dispatch`, `resolve_template_dispatch`. Helpers internos (sin EXECUTE para nadie salvo el dueño): `order_logistics_actor`, `order_logistics_lock`, `order_logistics_require_order`, `order_logistics_log`, `order_logistics_complete_packaging`. Helper de RLS: `order_logistics_access(account)`.

**Bucket**: `order-docs` (privado, 10 MB, PDF/JPEG/PNG/WEBP). Rutas `account-<id>/orders/<order|unassigned>/(vouchers|evidence)/<doc>/<archivo>`. La evidencia de embalaje se SUBE desde el dispositivo (flujo principal; no exige archivos en el chat) o, opcionalmente, se elige del chat; ambas son una fila `order_documents` kind `evidence` (origen en `source`: `upload` | `chat_message`; auditoría `evidence_uploaded` | `evidence_selected`). Todo acceso es del servidor con URL firmada de corta vida (120 s para ver; 600 s para el header de la plantilla).

**APIs** (`/api/orders/logistics/…`, 13 rutas): `documents` (POST/GET), `documents/[id]` (GET), `…/[id]/url`, `…/[id]/ocr`, `…/[id]/review`, `…/[id]/process`, `…/[id]/associate`, `orders/[orderId]` (GET), `…/chat-media`, `…/evidence` (desde el chat), `…/evidence/upload` (subida desde el dispositivo, multipart), `…/packaging` (`start` | `send_template` | `resolve`), `orders/pending`, `summary`.

**UI**: panel dentro del detalle de Pedidos confirmados, indicador compacto en la lista y `/confirmed-orders/vouchers`. Único archivo existente editado (solo inserciones): `src/components/orders/confirmed-orders-workspace.tsx` (+5 líneas) y los catálogos `messages/es.json` / `messages/en.json` (+195 líneas cada uno).

## 3. Feature flag y cómo comprobar flag OFF

Todo está bajo `logistics_mvp_enabled`. Con el flag **OFF** (o sin fila de settings) en una cuenta:

- Las 13 rutas responden **403 `feature_disabled`** y no escriben nada; las RPC lanzan `feature_disabled` (42501); la RLS devuelve 0 filas.
- La UI no renderiza nada nuevo y **no hace ninguna petición PR-04** (el indicador solo consulta cuando una fila se hace visible y, ante 401/403/404, deja de preguntar).
- `create_order_confirmation` **no** escribe nada de PR-04 (PR-04 no la toca ni la llama).

Comprobación manual (local):

```sql
-- cuenta con flag OFF: no debe haber ninguna fila PR-04 ni de routing nuevo
select
  (select count(*) from order_logistics          where account_id = '<ACCOUNT>') as logistics,
  (select count(*) from order_documents          where account_id = '<ACCOUNT>') as documents,
  (select count(*) from order_template_dispatches where account_id = '<ACCOUNT>') as dispatches,
  (select count(*) from order_logistics_events   where account_id = '<ACCOUNT>') as events;
-- esperado en una cuenta que nunca tuvo el flag ON: 0 | 0 | 0 | 0
select logistics_mvp_enabled from order_integration_settings where account_id = '<ACCOUNT>';
```

Pruebas automáticas de flag OFF: `supabase/ci/order-logistics-test.sql`, `storage.qa.test.ts`, `voucher-flow.qa.test.ts`, `packaging.qa.test.ts`, tests de rutas y `logistics-ui.test.tsx`.

## 4. Prechecks (LOCAL)

1. `git merge-base HEAD feat/conversation-routing-pr03` = `a1d76f3fb89439b692967f5781033ada058a9784`; `git rev-parse refs/heads/feat/logistics-confirmed-orders` = `98397aa0…`; el tag `pr03-complete-local` apunta a `a1d76f3f…`; `git diff a1d76f3 HEAD --stat -- <archivos de PR-02/PR-03>` vacío.
2. Stack local sano: `npx supabase status` (API 55321, DB 55322).
3. Migrations aplicadas en orden: `select version from supabase_migrations.schema_migrations order by version desc limit 6;` debe terminar en `…29000004`.
4. Bucket privado: `select id, public from storage.buckets where id = 'order-docs';` → `public = false`. Ninguna policy de `storage.objects` sin `bucket_id`: `select count(*) from pg_policies where schemaname='storage' and tablename='objects' and coalesce(qual,'')||coalesce(with_check,'') not like '%bucket_id%';` → 0.
5. Sin datos de otras QA que contaminen: las suites DB están acotadas a sus cuentas sintéticas (no requieren BD vacía).
6. Variables: **no** definir `ORDER_OCR_PROVIDER` salvo desarrollo local (`fake`); con `NODE_ENV=production` solo se resuelve `not_configured` aunque se defina `fake`.

## 5. Tests y cómo ejecutarlos

```powershell
# BD (transaccionales, terminan en ROLLBACK)
docker exec -i supabase_db_wacrm psql -U postgres -v ON_ERROR_STOP=1 -q < supabase/ci/order-logistics-test.sql        # 192
docker exec -i supabase_db_wacrm psql -U postgres -v ON_ERROR_STOP=1 -q < supabase/ci/pr04-pr03-compat-test.sql       # 22
# regresión funcional PR-03 / PR-02 (suites SQL congeladas)
docker exec -i supabase_db_wacrm psql -U postgres -v ON_ERROR_STOP=1 -q < supabase/ci/conversation-routing-test.sql   # 92
docker exec -i supabase_db_wacrm psql -U postgres -v ON_ERROR_STOP=1 -q < supabase/ci/conversation-handoff-test.sql    # 31
docker exec -i supabase_db_wacrm psql -U postgres -v ON_ERROR_STOP=1 -q < supabase/ci/operational-role-delegation-test.sql  # 57
# unitarios + componentes
npx vitest run
# contra el stack real local (storage, RLS, RPC, UI-API): exporta LOCAL_URL / LOCAL_ANON / LOCAL_SERVICE desde `npx supabase status -o env`
npx vitest run src/lib/orders/logistics
npx tsc --noEmit ; npx eslint ; npm run build
```

Los tests `*.qa.test.ts` **se niegan a correr contra cualquier host distinto de `http://127.0.0.1:55321`** y limpian lo que crean.

### Test histórico congelado de PR-03

`src/lib/orders/migration-conversation-routing.test.ts` (**no se modifica**) afirma que la migration de PR-03 es **la última** del repositorio. Eso era cierto al cerrar PR-03 y deja de serlo, legítimamente, al existir cualquier migration posterior.

**EXPECTED HISTORICAL TEST FAILURE AFTER ADDITIVE MIGRATIONS** — clasificación: *invariante histórica de PR-03, incompatible con migrations posteriores, NO regresión funcional.* Evidencia: el archivo de migration y el test tienen el mismo hash que en `a1d76f3`; con la lista de migrations sin las 5 de PR-04 la aserción se cumple (índice 101 = último); sus otras 9 aserciones pasan; las suites funcionales de routing (92/31/57) y `pr04-pr03-compat-test.sql` (22) pasan. La compatibilidad queda demostrada por tests **nuevos de PR-04** (`migration-pr03-compat.test.ts`, `pr04-pr03-compat-test.sql`), sin editar el histórico.

## 6. Rollback

### 6.1 Rollback lógico (normal): flag OFF

```sql
update order_integration_settings set logistics_mvp_enabled = false where account_id = '<ACCOUNT>';
```

Efecto inmediato: se cierran rutas, RPCs y lecturas de PR-04 para esa cuenta (§3). **No borra nada.** Volver a ON restaura el acceso a todo lo guardado. Con el flag OFF el acceso a conversaciones vuelve al comportamiento legacy (regla de PR-03).

### 6.2 Rollback de aplicación

Volver a la imagen/build anterior. Las migrations son aditivas y la app anterior no las conoce: no necesita ningún cambio de BD (rutas nuevas inexistentes, tablas ignoradas). Orden de deploy futuro (no ejecutado): migrations antes que la app, con el flag OFF.

### 6.3 Qué NO es rollback normal

**No se borran tablas, vouchers, evidencias, eventos ni pedidos.** No se proporciona ni se recomienda `DROP TABLE` como rollback operativo. Una reversión destructiva sería una operación **separada y excepcional**, con backup y aprobación explícita, y **no está incluida** en este PR (no hay script de DROP).

### 6.4 Datos que se conservan siempre

Pedidos (`order_confirmations` / items, sin cambios), conversaciones y mensajes (sin cambios), `conversation_routing` y su auditoría, `order_documents` (vouchers originales, resultado OCR, datos revisados, versiones reemplazadas, snapshots de evidencia), objetos del bucket `order-docs`, `order_template_dispatches` (incluidos los `uncertain`), `order_logistics_events` (append-only) y `order_logistics_settings`. Los pedidos solo desaparecen por borrado en cascada del propio pedido o de la cuenta (nunca por PR-04).

## 7. `order_logistics_settings` (carga LOCAL por SQL / `service_role`)

No hay UI ni API de escritura (a propósito, en esta etapa). Campos:

| Campo | Tipo | Significado |
|---|---|---|
| `account_id` | uuid (PK) | cuenta |
| `packaging_template_name` | text | nombre de la plantilla **existente** en `message_templates` de la cuenta |
| `packaging_template_language` | text | idioma (`es`, `es_PE`…); va junto al nombre (CHECK) |
| `packaging_template_params` | jsonb array | campos del pedido que llenan `{{1}}`, `{{2}}`… en orden. Permitidos: `customer_name`, `product`, `quantity`, `total`, `destination`, `seller_name`, `dni` |
| `updated_at`, `updated_by` | | bookkeeping |

Ejemplo **solo local** (valores ficticios):

```sql
insert into order_logistics_settings (account_id, packaging_template_name, packaging_template_language, packaging_template_params)
values ('<ACCOUNT_LOCAL>', '<template_local>', 'es', '["customer_name","product"]')
on conflict (account_id) do update set
  packaging_template_name = excluded.packaging_template_name,
  packaging_template_language = excluded.packaging_template_language,
  packaging_template_params = excluded.packaging_template_params, updated_at = now();
```

Condiciones del envío (se validan antes de reclamar nada): la plantilla debe existir en la cuenta con estado `APPROVED`, el número de variables del cuerpo debe coincidir con `packaging_template_params`, el header debe ser `image` o `document` (o ninguno) y compatible con la evidencia, y el chat debe estar en la etapa del operador.

**Valores pendientes (no inventados):** nombre, idioma, variables y header reales de la plantilla; texto cuando el DNI está vacío (hoy `-` en `src/lib/orders/logistics/template-params.ts`, un solo lugar). **Producción NO debe configurarse todavía:** no cargar settings, plantillas ni flag ON en ninguna cuenta real.

## 8. Dependencias aún no configuradas / pendientes

- **Proveedor OCR real — PENDIENTE.** Existe la interfaz `VoucherOcrProvider` (archivo → campos con confianza → error tipado), `not_configured` (por defecto: cae a captura manual) y `fake` (solo local/tests; imposible en producción). No se instaló SDK ni se eligió proveedor. Faltan: proveedor, contrato real de campos, muestras reales de voucher y la decisión de qué campos son obligatorios. La regla de matching automático (único candidato + 2 señales fuertes DNI y teléfono + confianza ≥ 0,8, `MATCHING_CONFIG`) está **pendiente de aprobación**.
- **Plantilla Meta real — PENDIENTE.** El envío usa la infraestructura existente (`sendMessageToConversation`, mismo `conversation_id`), pero en QA local la llamada a Meta está **simulada**; no se hizo ningún envío real.
- **URL firmada / media con Meta — PENDIENTE de prueba real.** Falta confirmar que Meta acepta como header la URL firmada del bucket privado (o decidir subir el media a Meta y usar `headerMediaId`, que el builder ya admite).
- **Evidencia desde el chat** solo soporta media guardado en `chat-media` de la misma cuenta; un mensaje cuyo único soporte es el enlace proxy de Meta responde `media_not_stored`.
- Documentación/automatización de despliegue: **no preparada** (fase aparte).
