# Piloto «Confirmar pedido» — runbook de despliegue (cuenta piloto)

Estado: **pasos 1 a 6 EJECUTADOS el 2026-10-31** con autorización expresa. Este documento se conserva como registro histórico y como guía de reversión: **no volver a ejecutar las migraciones ni los pasos 1 a 5** (ver «Resultado del piloto»). Los bloques marcados `[AUTORIZAR]` cambiaron producción y requirieron permiso expreso cada uno.
Complementa `DEPLOY-AND-ROLLBACK.md`. Alcance: WACRM únicamente. **No** se activa el webhook ni la entrega a InkaClick (`enabled` queda en `FALSE`, cron sin instalar).

## 0. Preflight (verificado el 2026-10-31, solo lectura) — HECHO

| Punto | Resultado |
|---|---|
| PR #54 y #55 | fusionados en `main` (`c14f9369`, `e8b778ca`) |
| Producción | imagen `wacrm-app:f1-e7c19571` healthy, 0 reinicios; `main` la contiene (28 commits por delante) |
| Migraciones pendientes | exactamente 2: `20261101000000_order_confirmations.sql`, `20261102000000_order_sellers_from_members.sql` |
| Tablas/funciones/disparadores de pedidos en producción | ninguno (no hay aplicación parcial) |
| Campos personalizados de la cuenta piloto | existen los 8 (Producto, Precio, Destino, DNI, Cantidad, Descripción de pedido, Agencia, Departamento), todos `text`; la precarga los empareja por nombre sin acentos ni mayúsculas |
| Miembros de la cuenta piloto | 2 perfiles, 1 solo `account_id`: propietario y agente |
| Supabase Auth / SMTP | healthy, 0 errores; registro con confirmación por correo y verificación funcionan; `ENABLE_EMAIL_AUTOCONFIRM=false` |
| Huérfanos | 0 usuarios sin perfil, 0 perfiles sin cuenta |
| Flujos | 27 317 ejecuciones completadas; sin cambios por esta integración |

Observaciones sin relación con el despliegue: 1 usuario sin confirmar creado hoy (con perfil, normal tras un registro pendiente) y un error repetido
`messages_status_check` al actualizar el estado de mensajes de audio salientes (23 ocurrencias desde las 12:49 UTC, anterior a este cambio).

## 1. Respaldos `[AUTORIZAR]` — EJECUTADO
```bash
TS=$(date -u +%Y%m%dT%H%M%SZ); B=/opt/backups/wacrm/pre-orders-$TS; mkdir -p $B && chmod 700 $B
docker exec supabase-db pg_dump -U postgres -d postgres -Fc > /opt/backups/supabase/wacrm_pre_orders_$TS.dump
docker save wacrm-app:f1-e7c19571 -o $B/wacrm-app-f1-e7c19571.tar     # el cron `docker image prune -af` (04:13) podría borrar la imagen
cp -p /opt/apps/wacrm/.env.local $B/env.local && chmod 600 $B/env.local
docker inspect wacrm-app-1 > $B/wacrm-app-1.inspect.json
ls -la $B /opt/backups/supabase/wacrm_pre_orders_$TS.dump
```
Criterio: el dump no está vacío (`pg_restore -l <dump> | head`) y el `.tar` existe.

## 2. Construir la imagen (sin tocar producción) `[AUTORIZAR]` — EJECUTADO
```bash
git -C /opt/apps/wacrm-hotfix-signup fetch origin && git -C /opt/apps/wacrm-hotfix-signup worktree add -f /opt/apps/wacrm-orders-build origin/main
cd /opt/apps/wacrm-orders-build && SHA=$(git rev-parse --short HEAD)
set -a; . /opt/apps/wacrm/.env.local; set +a        # NEXT_PUBLIC_* se incrustan en el build; no se imprimen
docker build --build-arg NEXT_PUBLIC_SUPABASE_URL --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY --build-arg NEXT_PUBLIC_SITE_URL --build-arg NEXT_PUBLIC_APP_LOCALE -t wacrm-app:orders-$SHA . > $B/build.log 2>&1; tail -3 $B/build.log
```
Usar las mismas `NEXT_PUBLIC_*` que la imagen actual. El contenedor en producción sigue intacto durante el build.

## 3. Migraciones, en orden, antes de la imagen `[AUTORIZAR]` — EJECUTADO (no repetir)
```bash
cd /opt/apps/wacrm-orders-build
for f in 20261101000000_order_confirmations 20261102000000_order_sellers_from_members; do
  docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 < supabase/migrations/$f.sql || { echo "FALLÓ $f - detener"; break; }
done
ACC=$(docker exec supabase-db psql -U postgres -d postgres -At -c "select p.account_id from profiles p join auth.users u on u.id=p.user_id where u.email='<CORREO_PROPIETARIO>'")
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -v acc="'$ACC'" < /opt/apps/wacrm-orders-build/scripts/ops/orders-pilot-verify.sql
```
`-1` envuelve cada archivo en una transacción: si falla, no queda nada a medias. La imagen actual sigue funcionando con el esquema nuevo (solo se añaden tablas y funciones). Esperado en la verificación: 4 tablas, 7 funciones, RLS `t` en todas, sin `EXECUTE` para `anon`/`authenticated`, sin filas en `order_integration_settings`, vendedores = propietario y agente de la cuenta piloto, 0 cruces.

## 4. Desplegar la imagen (ambos interruptores apagados) `[AUTORIZAR]` — EJECUTADO
```bash
printf 'services:\n  app:\n    image: wacrm-app:orders-%s\n' "$SHA" > $B/wacrm-orders-image.yml
cd /opt/apps/wacrm && docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.bsuid-vars.yml -f $B/wacrm-orders-image.yml up -d --no-deps app
```
(Los archivos `-f` deben ser los de la etiqueta actual del contenedor; comprobarlos con `docker inspect wacrm-app-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'`.)
Verificar: healthy, 0 reinicios, `curl -s -o /dev/null -w '%{http_code}' https://<HOST_PRODUCCION>/login` = 200, logs sin errores nuevos 5 minutos, flujos y automatizaciones activos sin cambios, `GET /api/orders/sellers` desde la sesión del piloto → `{"enabled":false,"sellers":[]}`.

## 5. Habilitar solo la captura comercial `[AUTORIZAR]` — EJECUTADO
```sql
INSERT INTO public.order_integration_settings (account_id, confirm_enabled, enabled)
VALUES ('<ACCOUNT_ID>', TRUE, FALSE)
ON CONFLICT (account_id) DO UPDATE SET confirm_enabled = TRUE;
```
`enabled` (entrega) permanece `FALSE`; **no** se instala el cron de `/api/orders/cron`; **no** se define `INKACLICK_ORDERS_ENABLED`. Comprobar visualmente: el botón aparece en el Inbox y el selector lista al propietario y al agente.

## 6. Pedido sintético autorizado `[AUTORIZAR]` — EJECUTADO (dos pedidos)
Con un contacto de prueba autorizado (no un cliente real): confirmar un pedido y comprobar con `orders-pilot-verify.sql` (punto 7) que queda `held`, sin envíos (ningún `sending`/`sent`) y sin tráfico hacia InkaClick (`docker logs wacrm-app-1` sin llamadas a la URL del receptor).

## Resultado del piloto (2026-10-31)
- Dos pedidos de prueba registrados, con confirmación cruzada (cada miembro confirma con el otro como vendedor). Ambos en `held`, 0 intentos de entrega, 0 filas en `order_confirmation_deliveries`, sin tráfico a InkaClick.
- Estado de interruptores: `confirm_enabled = TRUE` solo en la cuenta piloto; `enabled = FALSE`; sin cron; `INKACLICK_ORDERS_ENABLED` sin definir.
- Los pedidos `held` son de prueba y no se reenvían solos al activar la entrega.
- El módulo de captura ya está desplegado: este runbook no debe ejecutarse otra vez. Lo siguiente (receptor de InkaClick y entrega) está en `QA-CLOSURE-AND-ACTIVATION-PLAN.md`.

## Rollback
| Paso | Reversión |
|---|---|
| Después del paso 5 | `UPDATE order_integration_settings SET confirm_enabled = FALSE WHERE account_id = '<ACCOUNT_ID>';` (el botón desaparece, el historial queda) |
| Después del paso 4 | recrear `app` con `wacrm-f1-image.yml` (`image: wacrm-app:f1-e7c19571`, o `docker load -i $B/wacrm-app-f1-e7c19571.tar` si la imagen fue podada) |
| Después del paso 3 | no se revierte: es aditivo y la imagen anterior no lo usa. Solo ante corrupción: `pg_restore` del dump del paso 1 en una base nueva y revisión manual antes de cualquier sustitución |
| Fallo en el paso 3 | la transacción de cada archivo se deshace sola; no continuar con el siguiente |

## Matriz QA comercial
| # | Prueba | Esperado | Resultado (2026-10-31) |
|---|---|---|---|
| 1 | El propietario confirma con el agente como vendedor | `confirmed_by`=propietario, `seller_user_id`=agente | PASS en producción |
| 2 | El agente confirma con el propietario como vendedor | `confirmed_by`=agente, `seller_user_id`=propietario | PASS en producción |
| 3 | Registros separados | las dos columnas son distintas y no se pisan | PASS en producción |
| 4 | Nombre comercial congelado | cambiar el nombre en el perfil no altera `seller_name` de pedidos anteriores | pendiente (manual) |
| 5 | Precarga | Producto, Precio, Destino, DNI, Cantidad, Descripción de pedido, Agencia, Departamento se rellenan desde los campos del contacto | no verificado en producción (los dos pedidos de prueba no usaron departamento ni descripción) |
| 6 | Cantidad < 1, no numérica, precio ≤ 0 o vacío | el formulario y la API rechazan; no se crea fila | cubierto por pruebas automáticas |
| 7 | Doble clic en «Confirmar» | un único pedido (misma `request_key`) | cubierto por pruebas automáticas (sin pedido extra en producción) |
| 8 | Segundo pedido del mismo cliente | se crea un pedido nuevo, distinto | cubierto por pruebas automáticas |
| 9 | Otra cuenta | el selector no muestra miembros ajenos; `seller_user_id` ajeno → 422 | cubierto por pruebas automáticas |
| 10 | Sin envío a InkaClick | todo en `held`; sin tráfico saliente; `enabled=FALSE` | PASS en producción |
| 11 | Apagar `confirm_enabled` | el botón desaparece, el endpoint responde 403, los pedidos y su historial permanecen | pendiente (manual) |
| 12 | Usuario `viewer` | puede figurar como vendedor, no puede confirmar | cubierto por pruebas automáticas |

## Riesgos
- La imagen nueva trae 28 commits desde F1 (pedidos, vendedores, mensaje de registro); fuera de `src/lib/orders`, rutas `/api/orders`, componentes de pedidos, `mapAuthError` y un componente del Inbox no hay cambios. Mitigado con el rollback de imagen.
- Regla temporal «todo miembro es elegible» (incluye `viewer`); se acota por el rol de quien confirma.
- Un pedido `held` nunca se libera solo al activar la entrega; liberar pedidos del piloto será una decisión aparte.
- `docker image prune -af` (04:13) puede borrar la imagen anterior: por eso el `docker save` del paso 1.
