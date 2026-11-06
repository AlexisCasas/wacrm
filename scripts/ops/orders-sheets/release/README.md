# Release Keyler · Google Sheets export (PR #82) — paquete de despliegue

**Estado: preparado, NADA aplicado.** Cada paso que cambia algo exige `CONFIRM=yes` y su propia autorización. Instalar el paquete: `./install.sh` → `/opt/backups/wacrm/sheets-keyler-release-deploy/`.

## Qué se despliega (y por qué una sola imagen)
Producción corre `wacrm-app:meta-pricing-13d12e06` = `main` 5d3dae2a + 6 commits del panel de analítica de precios de Meta (rama **local** `codex/meta-pricing-analytics-dashboard`, no está en GitHub) y **sin** el código del PR #81 (su migración ya está aplicada; el código sigue pendiente). La imagen candidata = `main` (con PR #81) + PR #82 + esa rama local, fusionados sin conflictos; el árbol de `main` tras integrar todo debe ser **idéntico** al de la imagen (lo exige `40-gate-image.sh`). Un único recreate de `app` lleva: panel de precios (se conserva), código de estados de WhatsApp del PR #81, exportador de Sheets (inerte) y las tres variables de entorno.

## Orden de integración en GitHub (requiere autorización; el árbol final es el mismo en cualquier orden)
1. PR #83 (`codex/meta-pricing-analytics-dashboard`, publicada con sus 6 commits; verificada byte a byte contra la imagen productiva) → merge a `main`.
2. Actualizar la rama del PR #82 con `git merge origin/main` (fusión limpia verificada; conserva el historial y las pruebas), repetir su QA y sacarlo de Draft → merge.
3. `10-build-image.sh <main HEAD>` → la etiqueta de árbol debe coincidir con el árbol candidato registrado.

## Secuencia de despliegue (T0 = recreate de `app`; ventana tranquila Lima 04:30–05:00)
| Cuándo | Paso | Cambia producción |
|---|---|---|
| T−90 | `05-backup.sh` (dump < 12 h, archivo de la imagen en ejecución) | no (archivos) |
| T−75 | `35-rehearse-on-copy.sh` (copia restaurada sin red) → `REHEARSAL PASS` | no |
| T−60 | `20-gate-migration.sh` → GO | no |
| T−55 | `CONFIRM=yes 30-apply-migration.sh` + `31-verify-migration.sh` (inofensivo con el código actual: 4 tablas + 8 funciones, RLS, solo `service_role`) | sí (aditivo) |
| T−50 | `CONFIRM=yes 32-apply-exclusions.sh` (2 pedidos de prueba, `reason='test'`; originales intactos) | sí (2 filas) |
| T−45 | `CONFIRM=yes 70-activate-keyler.sh register` (destino **enabled=false**) y `precheck` (hoja definitiva: auth + lectura + 27 encabezados + 0 filas) | sí (1 fila) |
| T−30→T−5 | `40-gate-image.sh` en bucle hasta GO | no |
| **T0** | `CONFIRM=yes 50-swap-image.sh` (añade las 3 variables al `.env.local` con copia previa, recrea solo `app`, ~10 s de 502) | sí |
| T0, +10, +30 | `60-postchecks.sh` (el endpoint de Sheets responde 200 `ok` sin tocar ninguna cuenta; 0 trabajos; estados de WhatsApp) | no |
| T+30 | decidir: mantener o `90-rollback-image.sh` | — |
Con esto el exportador queda **apagado**: destino `enabled=false`, sin cron.

## Activación controlada y carga histórica (otra autorización, tras observar la imagen nueva)
1. `CONFIRM=yes 70-activate-keyler.sh enable` (verifica exclusiones y hoja vacía).
2. `CONFIRM=yes 70-activate-keyler.sh sync` hasta `claimed=0` → 238 pedidos / 239 líneas / 272 unidades / S/ 33 012,00 en el corte de las 20:21Z (se recalcula con `70 … status` justo antes).
3. `CONFIRM=yes 70-activate-keyler.sh reconcile` → `differences=0`; la pestaña «Control de conciliación» muestra las cifras del servidor, la hora y «Sin diferencias».
4. `CONFIRM=yes 70-activate-keyler.sh second-pass` → 0 líneas añadidas, 0 trabajos, reconciliación en 0.
5. Solo entonces `CONFIRM=yes 80-install-cron.sh` (sync cada 2 min, reconcile cada 30 min, monitor cada 5 min).

## Alertas (solo log local, como el resto de monitores)
`/var/log/wacrm-orders-sheets-health.log`: `ALERT` si hay trabajos `dead` (S1), atascados (S2), lease colgado (S3), destino activo sin interruptor global (S4), pedido `acknowledged` sin trabajo (S5), sync silencioso > 6 min o último HTTP ≠ 200 (S7/S8), reconcile silencioso > 75 min o fallido (S9/S10). El cron devuelve HTTP 500 (rc=1) cuando una cuenta falló, hay `layout_mismatch`, fila alterada, `dead` o diferencias; los reintentos esperados siguen en 200. En la hoja, «Estado general» pasa a SIN CONCILIAR / CONCILIACIÓN VENCIDA (> 3 h) / TRABAJOS EN ERROR / HAY DIFERENCIAS.

## Rollback (de menor a mayor)
1. Parar el exportador al instante: `CONFIRM=yes 95-disable-export.sh` (destino off + quita los cron). Sin recrear contenedores; pedidos e InkaClick intactos.
2. Volver de imagen: `CONFIRM=yes 90-rollback-image.sh` → `meta-pricing-13d12e06` (recarga desde el archivo verificado si el prune la borró). El esquema nuevo y las variables quedan inertes.
3. Esquema: `sql/91-drop-sheet-objects.sql` solo si se decide expresamente (ensayado en la copia: deja el esquema igual al anterior).
4. Hoja: es una proyección; se vacía y se reconstruye desde la BD con un nuevo `sync`.

## Criterios GO
Gate de migración GO, ensayo en copia `REHEARSAL PASS` con el sha256 exacto, `31-verify` PASS, gate de imagen GO (árbol de `main` = árbol de la imagen, actividad baja, sin pedidos pendientes ni entregas en vuelo), `60-postchecks` PASS a 0/10/30 min. NO-GO ante cualquier FAIL, un pedido pendiente, tráfico por encima de umbral o un `dead`.
