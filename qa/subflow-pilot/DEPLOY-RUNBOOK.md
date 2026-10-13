# Piloto de autoría de subflujos para Pilot: despliegue y rollback

Sigue el procedimiento que ya usa producción (E3): imagen inmutable `wacrm-app:<fase>-candidate-<sha>` seleccionada
mediante un archivo de override de Compose. Rollback = volver a seleccionar la imagen anterior. Nada aquí activa F06, ni
ejecuta subflujos, ni toca WhatsApp/Meta.

## Datos de producción (preflight, solo lectura, 2026-10-13)

| Dato | Valor |
|---|---|
| App en ejecución | `wacrm-app:e3-candidate-b0bdb4f8c586` (árbol idéntico a `main` `c010899a`) |
| Compose | `docker-compose.yml` + `docker-compose.prod.yml` + `docker-compose.e3.yml` en `/opt/apps/wacrm` |
| Base de datos | contenedor `supabase-db` (`/opt/apps/supabase`, dominio `supabase.example.test`) |
| Migraciones aplicadas | hasta la 051 (`flow_folders`). Ninguna de 052-068 |
| Pilot | usuario `dddddddd-dddd-4ddd-8ddd-dddddddddddd`, cuenta `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, owner, único miembro, 243 borradores, 0 activos, 0 ejecuciones, sin `whatsapp_config` |
| Otras cuentas | 2 (con WhatsApp; 92 flujos activos entre ambas) |
| PostgREST | recarga de esquema automática (`pgrst_ddl_watch` activo) |
| `auth.uid()` | versión moderna (lee `request.jwt.claims`) |
| Último backup de BD | 2026-09-11 (antiguo: se crea uno nuevo en el paso 1) |
| Imagen E2 citada en el override E3 | ya no existe; el rollback de este piloto vuelve a la imagen E3, que sí existe |

## Qué cambia

* Imagen nueva `wacrm-app:p4-candidate-<sha>` (rama `feat/pilot-subflow-authoring`).
* Migración **067**: función `replace_flow_draft_atomic` (solo `service_role`). La ruta PUT de **todas** las cuentas pasa a guardar en una sola transacción.
* Migración **068**: la restricción `flow_nodes_node_type_check` admite `execute_flow` (idéntica a la 058 de E4) y dos triggers con cláusula `WHEN` (solo actúan sobre filas `execute_flow` o al pasar un flujo a `active`).
* `.env.local`: `FLOW_SUBFLOW_AUTHORING_ACCOUNT_IDS=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` (solo Pilot).

## Pasos (en orden; detenerse ante cualquier error)

1. Backup verificable (BD y configuración):
   ```bash
   TS=$(date -u +%Y%m%d_%H%M%S)
   docker exec supabase-db pg_dump -U supabase_admin -h /var/run/postgresql -d postgres -Fc > /opt/backups/supabase/wacrm_pre_067_068_$TS.dump
   sha256sum /opt/backups/supabase/wacrm_pre_067_068_$TS.dump > /opt/backups/supabase/wacrm_pre_067_068_$TS.dump.sha256
   docker exec -i supabase-db pg_restore --list < /opt/backups/supabase/wacrm_pre_067_068_$TS.dump | head -3   # el archivo es legible
   install -m 600 /opt/apps/wacrm/.env.local /opt/backups/wacrm/env_pre_p4_$TS.env
   ```
2. Migraciones (aditivas, una transacción cada una):
   ```bash
   docker exec -i supabase-db psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -1 < supabase/migrations/067_replace_flow_draft_atomic.sql
   docker exec -i supabase-db psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -1 < supabase/migrations/068_execute_flow_authoring_guards.sql
   docker exec -i supabase-db psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 < supabase/ci/verify-schema.sql
   ```
   La app E3 en ejecución no usa nada de esto. Hay que comprobar que la función nueva es visible por la API **antes** de cambiar la app (respuesta `22023`, no `PGRST202`):
   ```bash
   SRK=$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' /opt/apps/wacrm/.env.local | cut -d= -f2-)
   curl -s -X POST https://supabase.example.test/rest/v1/rpc/replace_flow_draft_atomic -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
     -H 'content-type: application/json' -d '{"p_account_id":null,"p_flow_id":null,"p_patch":{},"p_nodes":null}'   # -> {"code":"22023",...}
   ```
3. Flag solo para Pilot: añadir a `/opt/apps/wacrm/.env.local` la línea
   `FLOW_SUBFLOW_AUTHORING_ACCOUNT_IDS=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`.
4. Override nuevo `/opt/apps/wacrm/docker-compose.p4.yml` (mismo formato que el de E3):
   ```yaml
   services:
     app:
       build: !reset null
       image: wacrm-app:p4-candidate-<sha12>
   ```
   y recrear solo la app:
   ```bash
   cd /opt/apps/wacrm && docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.p4.yml up -d app
   ```
5. Monitoreo (primeros 30 min): estado `healthy`; `docker logs --since 10m wacrm-app-1` sin errores nuevos; `/login` 200; las otras cuentas guardan un flujo; `select count(*) from flow_runs where created_at > <hora del despliegue>` igual a la actividad normal; ningún flujo de Pilot en `active`.

## Rollback

* **App** (segundos): `docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.e3.yml up -d app`.
* **Flag**: quitar la línea del `.env.local` y recrear la app (el nodo deja de ofrecerse; el API lo rechaza).
* **Base de datos**: 067 y 068 pueden quedarse con la app E3 (no las usa; los triggers solo afectan a `execute_flow`). Para retirarlas del todo:
  `DROP TRIGGER flows_guard_execute_flow_activation ON public.flows; DROP TRIGGER flow_nodes_guard_execute_flow ON public.flow_nodes; DROP FUNCTION public.guard_execute_flow_activation(); DROP FUNCTION public.guard_execute_flow_node(); DROP FUNCTION public.replace_flow_draft_atomic(uuid, uuid, jsonb, jsonb);`
  y restaurar la restricción original **solo después** de borrar o convertir los nodos `execute_flow` de Pilot (si no, fallaría).
* Antes de volver a E3, `GET /api/flows/downgrade-compatibility` lista los flujos con `execute_flow` (`BLOCKED_BY_SUBFLOW_NODES`): el editor E3 no conoce ese tipo de nodo.
* Último recurso: `pg_restore` del backup del paso 1.

## QA manual en la cuenta real de Pilot (debe validarlo una persona)

1. Entrar como `pilot.user@example.test` → Flujos → crear **Flujo B** y **Flujo A** (borradores).
2. En A (vista Lista): **Agregar nodo → Ejecutar otro flujo**. En «Flujo a ejecutar» elegir B; en «Cuando ese flujo termine, continuar en» elegir el nodo de retorno; conectar el nodo de inicio con «Ejecutar otro flujo». **Guardar**.
3. Recargar (F5): el destino y el retorno siguen ahí. Repetir en la vista **Canvas** (el nodo aparece y también se puede añadir desde el menú del canvas).
4. Cambiar el destino a otro flujo y guardar.
5. Cerrar sesión, volver a entrar: todo sigue igual.
6. A y B siguen en **Borrador**; el botón Activar de A está deshabilitado y el panel indica que el nodo no puede ejecutarse aún.
7. Ningún flujo se ejecutó (Ejecuciones = 0).
8. Con otra cuenta (o pedir a otro cliente): el menú «Agregar nodo» no muestra «Ejecutar otro flujo».
