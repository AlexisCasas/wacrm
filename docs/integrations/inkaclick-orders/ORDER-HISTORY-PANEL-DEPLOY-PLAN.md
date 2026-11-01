# «Pedidos confirmados»: plan de integración y despliegue

Estado: **plan. Nada de esto se ha ejecutado.** Cada paso marcado `[AUTORIZAR]` espera tu autorización explícita. Este despliegue **no toca la base de datos**, ni InkaClick, ni el cron, ni el interruptor de entrega.

## 1. Punto de partida (verificado en solo lectura, 2026-11-01)

| Dato | Valor |
|---|---|
| Imagen en producción | `wacrm-app:orders-1246621b` (healthy, 0 reinicios, iniciada 2026-11-01 01:02 UTC) |
| Rama a desplegar | `codex/order-history-panel` (2 commits sobre `codex/orders-receiver-e2e`) |
| Linaje | La rama **contiene** `1246621b` (la imagen actual), `origin/main` (`303b86da`), la integración F1 (`e7c19571`) y la pila BSUID (`1343ea65`). Los tres son ancestros |
| Conclusión | **No hace falta ningún commit de integración.** La divergencia entre `main` y producción que había el 31-oct ya está resuelta: producción sale de `main` más los PRs de pedidos |
| Código que cambia respecto de la imagen actual | Solo `src/app/api/orders/history/`, `src/lib/orders/history*`, `src/components/orders/order-history*`, +2 líneas en `contact-sidebar.tsx` y +2 en `confirm-order-dialog.tsx`, y claves nuevas en `messages/es.json` y `en.json`. El resto del diff son docs, scripts de QA y pruebas (no entran en la imagen funcional) |
| Base de datos | **Sin migración.** Lee `order_confirmations` y `order_integration_settings`, que ya existen |
| Estado de los pedidos hoy | 3 pedidos: 2 `held` (0 intentos) y 1 `acknowledged` (1 entrega). `confirm_enabled = TRUE` y `enabled = FALSE` en la única cuenta con configuración. Sin cron, `INKACLICK_ORDERS_ENABLED` sin definir |
| Espacio y memoria | 49 GB libres en disco; 15 GB de RAM, 7 GB en uso (el build ya se hizo en este equipo con esa carga) |

## 2. Integración en GitHub `[AUTORIZAR]`

La rama está apilada sobre `codex/orders-receiver-e2e` (PR #59, solo docs y scripts: no cambia código de la aplicación). Orden recomendado:

1. Abrir el PR de `codex/order-history-panel` con base `codex/orders-receiver-e2e`, para revisar solo estos 2 commits.
2. Tras tu revisión, fusionar #59 y después este PR en `main` (o fusionar este contra #59 y luego #59 en `main`). Tú decides el orden; el resultado en `main` es el mismo.
3. Construir la imagen desde `main` ya fusionado. Así lo desplegado es exactamente lo que está en `main`, como en los despliegues anteriores.

Si prefieres desplegar antes de fusionar, se construye desde el commit de la rama y se fusiona después; no cambia nada del procedimiento, solo que `main` queda por detrás un tiempo.

## 3. Procedimiento de despliegue `[AUTORIZAR]`

Mismo procedimiento que el piloto (`PILOT-ROLLOUT-RUNBOOK.md`). Ventana sugerida: un momento de poco tráfico; el reinicio de `app` corta las conexiones unos segundos. El cron de flujos reintenta solo en el minuto siguiente.

### 3.0 Comprobaciones previas (solo lectura)
```bash
docker inspect wacrm-app-1 --format '{{.Config.Image}} {{.State.Health.Status}} {{.RestartCount}}'      # orders-1246621b healthy 0
docker exec supabase-db psql -U postgres -d postgres -At -c "select delivery_status, count(*) from order_confirmations group by 1 order by 1" \
  -c "select account_id, confirm_enabled, enabled from order_integration_settings"                    # 2 held, 1 acknowledged; t|f
crontab -l | grep -c "orders/cron"                                                                      # 0
docker inspect wacrm-app-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'  # mismos -f que abajo
```
Si algo difiere, **detenerse** y revisar.

### 3.1 Respaldo del rollback
```bash
TS=$(date -u +%Y%m%dT%H%M%SZ); B=/opt/backups/wacrm/pre-order-history-$TS; mkdir -p $B && chmod 700 $B
docker save wacrm-app:orders-1246621b -o $B/wacrm-app-orders-1246621b.tar     # el cron `docker image prune -af` (04:13) podría borrar la imagen
cp -p /opt/apps/wacrm/.env.local $B/env.local && chmod 600 $B/env.local
docker inspect wacrm-app-1 > $B/wacrm-app-1.inspect.json
ls -la $B
```
No hace falta un `pg_dump` nuevo porque no cambia la base; si quieres uno de todos modos por política, es opcional y no bloquea.

### 3.2 Construir la imagen (producción sigue intacta)
```bash
cd /opt/apps/wacrm-orders-build && git fetch origin && git checkout --detach origin/main      # ya con los dos PRs fusionados
SHA=$(git rev-parse --short HEAD)
set -a; . /opt/apps/wacrm/.env.local; set +a        # NEXT_PUBLIC_* se incrustan en el build; no se imprimen
docker build --build-arg NEXT_PUBLIC_SUPABASE_URL --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY --build-arg NEXT_PUBLIC_SITE_URL --build-arg NEXT_PUBLIC_APP_LOCALE \
  -t wacrm-app:orders-history-$SHA . > $B/build.log 2>&1; tail -3 $B/build.log
```
Usar las mismas `NEXT_PUBLIC_*` que la imagen actual. Criterio: el build termina sin errores (incluye la compilación y el tipado de Next).

### 3.3 Desplegar
```bash
printf 'services:\n  app:\n    image: wacrm-app:orders-history-%s\n' "$SHA" > $B/wacrm-orders-history-image.yml
cd /opt/apps/wacrm && docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.bsuid-vars.yml -f $B/wacrm-orders-history-image.yml up -d --no-deps app
```

### 3.4 Verificación inmediata
1. `healthy`, 0 reinicios, `GET /login` = 200, logs sin errores nuevos durante 5 minutos (el error preexistente `messages_status_check` de audios no cuenta).
2. Base **sin cambios**: mismos 3 pedidos y estados, 1 entrega, `confirm_enabled`/`enabled` iguales, 0 líneas de cron, `INKACLICK_ORDERS_ENABLED` sin definir. Huella de `order_confirmations` y `order_confirmation_deliveries` idéntica a la de 3.0.
3. Flujos, automatizaciones y envío de mensajes funcionando como antes (sin errores en los logs; un mensaje de prueba solo si tú lo autorizas).
4. **Comprobación funcional, hecha por ti con tu sesión** (no entro con tus credenciales): abrir en el Inbox la conversación de Alexis Casas.
   - Debe aparecer «Pedidos confirmados (2)» bajo el botón: uno «Confirmado en WACRM · envío a InkaClick no activado» y otro «Recibido en InkaClick» (el E2E, con su texto «PRUEBA WACRM E2E - NO DESPACHAR»). El tercer pedido (el otro `held`) pertenece a la conversación de Keyler Ortega: allí debe aparecer solo ese, con «(1)».
   - Abrir un detalle: autor y vendedor distintos, fechas en hora de Lima, identificador copiable.
   - En las herramientas del navegador: una sola petición `GET /api/orders/history` por conversación abierta, respuesta 200, sin `dni`, `phone` ni `last_error_code`; sin sondeo mientras todo esté `held` o `acknowledged`.
   - El botón «Confirmar pedido» sigue abriendo su formulario (sin enviarlo).
   - Una cuenta sin `confirm_enabled` no ve ninguna sección nueva (solo hay una cuenta con configuración; el resto recibe `enabled: false`).

No se crean pedidos, no se envía ningún formulario y no se toca ningún pedido `held`.

## 4. Rollback

| Qué | Cómo | Efecto |
|---|---|---|
| Ocultar el panel al instante, sin tocar la imagen | `UPDATE order_integration_settings SET confirm_enabled = FALSE WHERE account_id = '<ACCOUNT_ID>'` | Desaparecen el botón y el panel de esa cuenta. Es el mismo interruptor del piloto |
| Volver a la imagen anterior | `cd /opt/apps/wacrm && docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.bsuid-vars.yml -f /opt/backups/wacrm/pre-orders-20261031T154613Z/wacrm-orders-image2.yml up -d --no-deps app` | Vuelve a `orders-1246621b` en segundos. Si la imagen ya no existiera: `docker load -i $B/wacrm-app-orders-1246621b.tar` |
| Base de datos | Nada que revertir | No hubo migración ni escrituras |

## 5. Riesgos y notas

- **Poda de imágenes a las 04:13:** por eso se guarda la imagen actual con `docker save` antes de construir. Conviene no dejar el despliegue a medias pasada esa hora.
- **Lo que verá cada agente de la cuenta piloto:** todos los pedidos de esa cuenta, incluido el E2E. WACRM no conoce la marca `is_test` de InkaClick (no se desarrolla ahora), así que lo identifica solo por su texto.
- **Viewers:** no ven el panel (la política exige rol agente), igual que no ven el botón.
- **Idiomas:** textos en español e inglés. `ko.json` no tiene el bloque `Orders` (ya era así) y el idioma coreano está excluido de la paridad de mensajes.
- **Carga:** una consulta por conversación abierta y, solo si hay pedidos en curso (`pending`/`sending`/`sent`) y la pestaña está visible, una cada 30 s. Con la entrega apagada no hay sondeo.
- **Todavía no probado en producción:** la visualización con tu sesión real y los datos reales. Las pruebas de este plan son la primera vez; por eso el paso 3.4.4 es obligatorio antes de dar el despliegue por bueno.

## 6. Después, y no antes

Con este panel en producción y verificado, continúa el plan de activación automática de la entrega (`QA-CLOSURE-AND-ACTIVATION-PLAN.md`): emisor con `is_test`, filtros de informes y logística, y cron comercial. El panel ya está preparado para ello: un pedido nuevo con la entrega activa pasa de «pendiente de envío» a «Enviado» y a «Recibido en InkaClick» sin recargar, porque el sondeo sigue a los pedidos en curso.

## 7. Qué no cambia

Base de datos, funciones SQL, el cron, `enabled` y `confirm_enabled`, las variables de entorno, los dos pedidos `held`, el receptor y el frontend de InkaClick, ManyChat y los mensajes de WhatsApp.
