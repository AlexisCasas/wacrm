# Despliegue P6: esperas duraderas (autoría solo Pilot, ejecución deshabilitada)

**Estado: PREPARADO, NO EJECUTADO.** Requiere autorización explícita porque: (1) aplica la migración 069 sobre `flow_runs`, tabla
compartida por todos los clientes; (2) la imagen P6 modifica el barrido compartido `/api/flows/cron` (consulta una columna nueva).
Ambos cambios son aditivos y ensayados, pero no están "aislados" a una sola cuenta.

## Impacto medido (ensayo sobre la copia restaurada del respaldo de producción de hoy)
| Aspecto | Resultado |
|---|---|
| Duración de la 069 | 0,17 s (19 809 ejecuciones, 6,5 MB) |
| Datos de `flows` / `flow_runs` | idénticos antes y después (hash) |
| Columnas nuevas | 4, todas NULL; el CHECK solo valida filas existentes (todas cumplen) |
| Índice nuevo | parcial, 8 KB; solo filas con espera |
| Triggers nuevos | 2 con `WHEN` (solo filas `delay` con `unit` / activaciones): el resto de escrituras no los llama |
| Consulta de reanudación | índice, 0 filas hoy |
| Orden P5 -> 069 -> P6 | P5 no lee las columnas nuevas: se puede aplicar la 069 con P5 corriendo |

## Orden obligatorio
La **069 antes** de la imagen P6 (el barrido de P6 pide `wait_until`; sin la columna fallaría la limpieza de ejecuciones estancadas).

1. Preflight: imagen en producción = P5 (`wacrm-app:p5-candidate-a0ebbd9630f6`), contenedores sanos, línea base (flujos por cuenta, hash de nodos, WhatsApp, errores) en `/opt/backups/wacrm/p6/`.
2. Respaldo nuevo: `pg_dump -Fc` + sha256 + restauración de prueba en contenedor aislado; copia de `.env.local` y Compose.
3. `psql -1 -v ON_ERROR_STOP=1 < supabase/migrations/069_flow_durable_waits.sql` y verificar: columnas, funciones sin permisos para anon/authenticated, datos idénticos.
4. Imagen P6 desde contexto limpio del commit, `docker-compose.p6.yml`, `up -d --no-deps app`.
5. `.env.local`: añadir **solo** `FLOW_DURABLE_WAIT_AUTHORING_ACCOUNT_IDS=<account_id de Pilot leído de la base>`. **No** crear `FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS` (o dejarlo vacío).
6. Comprobar: `healthy`, `/login` 200, 243 borradores de Pilot, otras cuentas sin cambios, sin errores nuevos, `/api/flows/capabilities` sin sesión 401.
7. **No instalar** `ops/wacrm-waits-cron.sh` todavía: con la ejecución deshabilitada no tiene nada que hacer.

## Rollback
* App: `docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.p5.yml up -d --no-deps app`.
* La 069 puede quedarse con P5 (no la usa). Retirarla del todo solo si no existen esperas ni nodos duraderos:
  `DROP TRIGGER flows_guard_durable_wait_activation ON public.flows; DROP TRIGGER flow_nodes_guard_durable_wait ON public.flow_nodes;`
  `DROP FUNCTION public.guard_durable_wait_activation(), public.guard_durable_wait_node(), public.consume_flow_wait(uuid,uuid,uuid,text), public.claim_due_flow_waits(uuid[],integer,integer), public.schedule_flow_wait(uuid,uuid,text,timestamptz);`
  `DROP INDEX public.idx_flow_runs_waiting_due; ALTER TABLE public.flow_runs DROP CONSTRAINT flow_runs_wait_shape, DROP COLUMN wait_until, DROP COLUMN wait_node_key, DROP COLUMN wait_claim_token, DROP COLUMN wait_claimed_at;`
* Antes de volver a una imagen anterior, `GET /api/flows/downgrade-compatibility`: `BLOCKED_BY_DURABLE_WAITS` lista flujos con espera y ejecuciones en espera.

## QA funcional de Pilot (tras el despliegue)
Entrar a https://crm.example.test con `pilot.user@example.test`:
1. Abrir un flujo en **borrador** -> Agregar nodo -> **Retraso** (el nodo `delay` existente).
2. En «Tipo de espera» elegir **Espera (minutos, horas, días)**; poner **13** y **minutos**; elegir el nodo siguiente. **Guardar**.
3. Recargar (F5): sigue «13» y «minutos»; el resumen del nodo dice «Esperar 13 minutos».
4. Cambiar a **2 horas**, guardar, recargar; volver a **13 minutos**, guardar, recargar.
5. Comprobar que el botón Activar está deshabilitado (el panel dice que las esperas aún no se pueden ejecutar) y que Ejecuciones sigue en 0.
6. En otra cuenta (no Pilot) el nodo Retraso solo muestra la pausa corta de 1-30 s.

## Para habilitar ejecución real (más adelante, con autorización y una cuenta de prueba)
Aceptar las ventanas del paso 3 y 4 de DESIGN.md; confirmar la política de respuestas durante la espera; instalar `ops/wacrm-waits-cron.sh`
en `/etc/cron.d/wacrm` (`* * * * *`); poner el account_id en `FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS`; fijar `app.allow_durable_wait_activation`
solo con una migración/ALTER ROLE deliberado; validar con una ejecución real y un contacto de prueba autorizado.
