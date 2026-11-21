# Integración PRODUCCIÓN ACTUAL + PR-01 → PR-06 (candidato local)

Rama: `release/pr01-pr06-prod-integration`. Local. Sin push, sin deploy, sin migraciones en producción, sin dump. El tag `pr06-complete-local` (`9664306c967d9df49e7950a57bd002a748a7105e`) y la rama `feat/order-payments-pr06` no se tocaron.

## 1. Producción reconstruida (evidencia, solo lectura)

| Evidencia | Resultado |
|---|---|
| Contenedor `wacrm-app-1` | imagen `wacrm-app:clear-fields-manual-flow-fa9066ec`, id `sha256:e866ae81…ac23e` |
| Labels de la imagen | `org.opencontainers.image.revision = fa9066ecb0f9a7e3b851ba48d231eadad69673e5`, `io.wacrm.source-tree = cdb0380dba0ac647363c30309281151184978dda` |
| `ROLLBACK.md` del deploy | "Source: git archive of fa9066ec (tree cdb0380…)", sin migraciones ni cambios de BD |
| Contexto de build guardado (`…/build/wt-fa9066ec`) | **1256 archivos: 1256 coinciden por hash de blob con el árbol `cdb0380`, 0 distintos, 0 sobrantes** |
| Commit `fa9066ec` | existe en el repo del servidor (rama `feat/integrate-clear-fields-manual-flow`, **no empujada a origin**); traído al repo local como `refs/remotes/prod-server/…`; su árbol local = `cdb0380…` |
| Linaje | `origin/main` (`758413f`, PR #133) → `c550df3` (clear custom fields) → `fa9066e` (manual flow start non-blocking) |

Conclusión: el source exacto de producción **sí** se reconstruye con confianza (commit + árbol + imagen + archivos). Base del candidato: `fa9066ec`.

## 2. Funcionalidad productiva (posterior a `main@31c8223`)

| Funcionalidad productiva | Rama | Commit | Archivos | Migración | En imagen actual | En `pr06-complete-local` | En el candidato |
|---|---|---|---|---|---|---|---|
| Guardas de contrato del proxy / deploy (#129) | `fix/deploy-proxy-contract-guard-20261117` | `4e008f7` | 7 (`ops/deploy`, tests, CI) | — | sí | no | **sí** |
| Búsqueda: normalizar teléfono (#130) | `hotfix/inbox-search-phone-normalize-20261118` | `3afd8f5` (`4b862e6`) | 8 (conversation-list, filtros) | — | sí | no | **sí** |
| Búsqueda por teléfono del pedido (#131) | `fix/inbox-search-02-order-phone-20261118` | `e11f68a` (`4917b05`, `600da7c`) | 9 | — | sí | no | **sí** |
| Contact name lock (#132) | `fix/contact-name-lock-03-20261118` | `d31bf1e` (`78b9310`) | 22 | `20261126000000_contacts_name_locked` (aplicada 2026-11-18T22:23Z) | sí | no | **sí** |
| Contact deletion controls (#133) | `fix/contact-deletion-controls-04-20261119` | `758413f` (`a8f26fd`) | 15 | `20261127000000_contact_deletion_controls` (aplicada 2026-11-19T00:06Z) | sí | no | **sí** |
| Clear custom fields | `feat/contact-clear-custom-fields` (solo servidor) | `c550df3` | 7 | — | sí | no | **sí** |
| Manual flow start no bloqueante | `feat/integrate-clear-fields-manual-flow` (solo servidor) | `fa9066e` | 3 | — | sí | no | **sí** |

Prueba de preservación: de los 53 archivos que producción cambió desde `31c8223`, **50 tienen exactamente el mismo blob** en el candidato; los otros 3 (`messages/es.json`, `messages/en.json`, `src/types/index.ts`) los tocan también PR-02..06 y se fusionaron sin conflicto conservando ambos lados (los dos JSON: +581 líneas / 0 borradas respecto a producción; `types/index.ts`: solo se amplía `NotificationType` y se añade `order_id`). **Producción → candidato: 0 archivos borrados, 223 añadidos, 18 modificados, todos tocados por el release PR.**

## 3. Integración y conflictos

* Rama creada desde `fa9066ec`; `git merge --no-ff pr06-complete-local`. **Conflictos de texto: ninguno** (auto-merge de `messages/*.json` y `src/types/index.ts`, verificados).
* Conflicto real, de **packaging**: versiones de migración. Ver §4.

## 4. Versiones de migración y OLD → NEW

Versiones usadas o reservadas (todas las fuentes: producción, `.applied`, ramas remotas y del servidor, `main`, release, ramas locales, predeploy):

* Producción (`.applied`, formato: migration / commit / sha256 / applied_at / applied_by / backup / result): `20261126000000_contacts_name_locked`, `20261127000000_contact_deletion_controls`.
* Reservadas por la rama no desplegada de llamadas: `20261127000001_whatsapp_calling_backend`, `20261128000000_whatsapp_calls_shadow`, `20261129000000_whatsapp_calling_sessions_permissions`.
* **Mayor versión usada o reservada fuera del release: `20261129000000`.** El release original llegaba a `20261203000003`.

Decisión: las 22 migraciones PR-02→PR-06 se reempaquetan en un bloque contiguo **`20261204000000` … `20261204000021`**, mismo orden relativo, **SQL byte-equivalente (22/22 renames al 100 %)**. Nada de SQL se modificó. Mapa y checksums en `supabase/release/migration-manifest.json`.

| # | OLD | NEW |
|---|---|---|
| 1 | `20261126000000_operational_role_supervisor_delegation` | `20261204000000_…` |
| 2 | `20261127000000_conversation_handoff_rls` | `20261204000001_…` |
| 3 | `20261128000000_conversation_routing` | `20261204000002_…` |
| 4–9 | `20261129000000`…`20261129000005` (order_logistics_model, security_rpcs, order_docs_storage, evidence_rpc, template_dispatch_rpcs, evidence_upload) | `20261204000003`…`20261204000008` |
| 10–14 | `20261130000000`…`20261130000004` (shipment_settings, shipments_model, shipments_rpcs, notifications_shipment_alert, shipment_alert_rpcs) | `20261204000009`…`20261204000013` |
| 15–17 | `20261201000000`…`20261201000002` (pickup_state, customer_message, abandonment) | `20261204000014`…`20261204000016` |
| 18 | `20261202000000_order_finalization_routing_return` | `20261204000017_…` |
| 19–22 | `20261203000000`…`20261203000003` (payments_model, payment_rpcs, payment_proof, finalization_pr06) | `20261204000018`…`20261204000021` |

Las referencias (tests, SQL de CI, docs) se actualizaron al nombre nuevo; los comentarios dentro de los `.sql` conservan los nombres viejos a propósito (el contenido no cambia).

## 5. Compatibilidad de base de datos (producción vs el release)

* Las dos migraciones productivas solo tocan `contacts` (`name_locked`), tablas `contact_deletion_*` / `contact_media_cleanup_items` y funciones de borrado (`bulk_delete_contacts_internal`, `contact_delete_*`) y la política `contacts_delete`. **Ninguna de las 22 toca `contacts`, `profiles`, `accounts`, `notifications` (salvo ampliar su CHECK) ni esas funciones.** No hay choque de tablas, columnas, índices, triggers, funciones, RLS ni enums.
* **Prueba del reempaquetado**: una BD limpia aislada (`supabase db start`, puerto 56322) aplicó TODA la cadena integrada (incluidas las dos migraciones de producción) sin errores; el esquema `public` resultante es **idéntico** (0 diferencias) al de la BD local con la cadena vieja + las dos migraciones de producción.
* Interacción real probada con test (BD real): borrar un contacto cuya conversación está en Logística con pedido, pagos confirmados y finalización → el borrado funciona, se audita, la conversación y su routing se eliminan por cascada, el pedido sobrevive desvinculado y todo el historial financiero queda intacto (`src/lib/integration/prod-compat.qa.test.ts`).
* Pendiente de la siguiente fase (dry-run de base de datos): aplicar las 22 sobre un **clon del esquema productivo real** (no sobre una BD vacía).

## 6. Estrategia de ledger (futuro deploy; nada implementado en producción)

Producción no tiene `schema_migrations`; el registro es un `.applied` por migración en `/opt/backups/wacrm/migrations-applied/`. Herramienta local de solo lectura/impresión: `scripts/release/migration-ledger.cjs`.

* `verify`: el árbol coincide con el manifest (nombres, orden, bloque contiguo y único, estrictamente posterior a toda versión productiva/reservada, sha256 de cada archivo y de las dos migraciones productivas = los hashes que producción registró).
* `plan <copia-del-directorio-.applied>`: qué se aplicaría, **un archivo a la vez**, en orden; salta lo ya registrado con el **mismo** sha256; **aborta (exit 2)** si una versión está registrada con sha256 distinto o con otro nombre; falla si falta el registro de un prerrequisito productivo.
* `record <archivo> <sha-release> [backup]`: imprime (stdout) el registro `.applied` que el deploy debe escribir tras cada migración (migration, commit, sha256, applied_at, applied_by, backup, result, versión original del release).
* Checksum = sha256 del archivo con LF (lo que producen `git show` / `git archive`; es el mismo criterio de los `.applied` productivos: verificado).

## 7. Qué NO activa el candidato

Todos los flags nacen apagados (`order_payments_enabled`, `shalom_tracking_enabled`, `destination_customer_message_enabled`; `logistics_mvp_enabled` no se cambia). `scripts/qa/**`, seeds, `finalize.cjs`, `pay.cjs`, smoke, usuarios `qa-*`, fixtures, `meta-sim`, Shalom fake y OCR fake **existen en el repo pero nada los ejecuta**: ni `package.json`, ni `Dockerfile`, ni compose, ni workflows, ni scripts de deploy los referencian; los proveedores fake se ignoran con `NODE_ENV=production`; `.dockerignore` excluye `supabase` y `docs` de la imagen.

## 8. Decisiones de negocio cerradas (2026-11-20)

* **Fuente de verdad financiera: WACRM.** **Dueño del polling Shalom: WACRM.** InkaClick queda fuera del flujo cuando se active la nueva operación. Ya no son decisiones pendientes. Esta fase **no modifica InkaClick**; su apagado ordenado (outbox, aviso al llegar a destino, polling) se ejecuta al activar, no antes.

## 9. Dry-run de base de datos sobre una copia aislada del backup productivo

Resultados y evidencia: `docs/release/DATABASE-DRY-RUN.md`. Herramientas: `scripts/release/db-baseline.sql` (estructura + conteos + hashes de datos, sin contenido) y `scripts/release/dryrun-apply.cjs` (aplica las 22 una por una, solo contra el contenedor aislado `dryrun-db`).
