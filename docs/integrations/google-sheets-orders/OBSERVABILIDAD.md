# Observabilidad y notificación operativa del export a Sheets

## Qué existe hoy (sin servicios externos)
| Señal | Dónde | Qué significa |
|---|---|---|
| HTTP del cron | `/var/log/wacrm-orders-sheets-cron.log` (rc=1 si HTTP 500) | `attention`: cuenta caída, `layout_mismatch`, fila alterada, trabajos `dead` o diferencias de conciliación. Los reintentos esperados (5xx, 429, red) siguen en rc=0 con `status:"retrying"` |
| Monitor de 5 min | `/var/log/wacrm-orders-sheets-health.log` (`OK` / `ALERT códigos`) | S1 trabajos `dead` · S2 atascados · S3 lease colgado · S4 destino activo sin interruptor global · S5 pedido `acknowledged` sin trabajo · S7/S8 sync silencioso o fallido · S9/S10 reconcile silencioso o fallido |
| Hoja | pestaña «Control de conciliación», celda «Estado general» | SIN CONCILIAR · CONCILIACIÓN VENCIDA (> 3 h) · TRABAJOS EN ERROR · HAY DIFERENCIAS · Sin diferencias. Las cifras las escribe el servidor |
Igual que los monitores existentes (`orders-health`, `alerts-p8`), hoy **todo termina en un log local**: nadie recibe aviso si no mira el log o la hoja.

## Propuesta: avisar de verdad
Implementado y probado en seco, **inactivo hasta que se cree el archivo de destino** (`/root/.config/wacrm-secrets/sheets-alert-webhook`, modo 600): `orders-sheets-health-monitor.sh` envía un POST a un webhook cuando cambia el conjunto de códigos en alerta, lo repite cada 6 h mientras siga y avisa una vez al recuperarse. El mensaje solo lleva códigos, contadores y el nombre del host (sin nombres, teléfonos, importes ni IDs de hoja). Una falla del envío queda en el log y no rompe el monitor. Probado con un receptor local: 1 aviso al fallar, 0 repetidos con el mismo estado, 1 aviso de recuperación, 0 sin archivo.

Opciones de destino (decisión y credenciales tuyas; no se configura nada externo sin autorización):
1. **Slack/Mattermost/Discord-compatible** (cuerpo `{"text":"…"}`): la opción por defecto del script.
2. **ntfy** (segunda línea del archivo = `text`): push al móvil, autoalojable, sin cuenta.
3. **Correo** (SMTP/Resend): requiere credenciales y un pequeño adaptador; se descarta salvo que ya haya un buzón operativo.
Complemento recomendado: un **latido externo** (p. ej. Healthchecks.io o un ntfy de "sigo vivo" cada hora) para detectar que la propia VPS o el cron dejaron de ejecutarse; ningún monitor local puede avisar de su propia caída.

## Qué se necesita para activarlo
1. Elegir el servicio y crear el webhook (o tema ntfy). 2. Guardar la URL en el archivo indicado (modo 600). 3. Instalar el cron de salud (`80-install-cron.sh`, otra autorización). 4. Probar provocando una alerta controlada en la hoja QA o con `SHEETS_HEALTH_CMD` simulado.

## Conciliación endurecida (PR de endurecimiento)
- **Sync antes de comparar.** `?mode=reconcile` primero exporta lo pendiente y después compara, de modo que un pedido reconocido desde el último tick de 2 min ya está en la hoja.
- **Reintento acotado solo para desfases.** Si quedan diferencias y son únicamente filas faltantes/sobrantes (crecimiento), espera 45 s, vuelve a exportar y a comparar, como máximo 2 veces (≤ 3 comparaciones, ~2 min). Si se aclara: `ok` con `recoveredAfterRetry:true`. Si persiste: `attention` / `persistent_lag`.
- **Nunca se reintenta ni se suaviza** (atención inmediata): `duplicate_keys`, `altered_rows` (contenido, línea o importe), `projection_errors`, `dead_jobs`, `row_content_mismatch` (fila en cuarentena) y `layout_mismatch`.
- El log del cron de reconcile muestra `attempts` (1 = limpio a la primera).
- **Hoja de Control:** el estado compara la hoja EN VIVO (columna B) con lo que vio la última conciliación (columna D). Crecimiento legítimo → `PENDIENTE DE CONCILIAR` (con detalle en B12); menos filas, un duplicado en vivo o una diferencia del servidor → `HAY DIFERENCIAS`; «Sin diferencias» solo si la hoja no cambió desde la última pasada. Vigencia recomendada: 1,5 h.
- **Aplicar las fórmulas** (paso explícito, no lo hace ningún cron): `node scripts/ops/orders-sheets/apply-control-formulas.mjs --sheet <id>` (simulación por defecto); `CONFIRM=yes … --apply` escribe solo F1:F6, B10:B12, A11:A12 (nunca C2:D7, B9, C13:C15 ni el registro). Fuente única: `src/lib/orders/sheets/control-formulas.json`.
