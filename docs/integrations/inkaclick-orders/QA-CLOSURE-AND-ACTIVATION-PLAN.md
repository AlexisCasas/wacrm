# Cierre del QA comercial y plan de activación gradual de InkaClick

Estado al 2026-10-31. Entrega a InkaClick apagada (`confirm_enabled = true`, `enabled = false`), cron ausente, `INKACLICK_ORDERS_ENABLED` sin definir.

## 1. QA comercial (producción, cuenta piloto)

| Caso | Evidencia | Resultado |
|---|---|---|
| Keyler confirma, David vendedor | Pedido 1, `held`, 0 intentos, atribución correcta | PASS |
| David confirma, Keyler vendedor | Pedido 2, `held`, 0 intentos, `confirmed_by` != `seller_user_id`, contacto distinto del pedido 1 | PASS (solo lectura) |
| Sin entrega ni tráfico a InkaClick | 0 filas en `order_confirmation_deliveries`, sin ID externo, logs sin menciones | PASS |
| Aislamiento | 1 cuenta, 2 contactos, 0 pedidos en otras cuentas | PASS |
| Botón disponible tras registrar | Confirmado visualmente por la persona usuaria | PASS |
| Doble clic / reintento | Índice único `(account_id, request_key)` + `ON CONFLICT DO NOTHING`; `route.test.ts` (200 `created=false`); `e2e` caso 2; el diálogo bloquea el botón mientras envía | PASS (pruebas automáticas; no se generó pedido extra) |
| Segundo pedido del mismo cliente | `e2e` caso 7 (independiente en ambos sistemas) | PASS (automática) |
| Interruptores | `e2e` casos 9, 10, 13 | PASS (automática) |

Pendiente de QA manual, no bloqueante: ninguno para la fase `held`.

## 2. Mejora visual propuesta (no implementada)

Hoy no existe vista de historial de pedidos confirmados. Propuesta, por orden de valor:

1. Dos indicadores separados: estado comercial («Pedido confirmado») y estado de entrega («Retenido», «En cola», «Enviado», «Confirmado por InkaClick», «Falló»), con color y texto distintos.
2. Historial por conversación/contacto: lista de pedidos con fecha, vendedor, quién confirmó y estado de entrega; solo lectura, bajo RLS.
3. Para quien administra: reintento manual de un pedido `failed` (requiere autorización aparte).

Es un PR de UI independiente, sin migraciones: el endpoint de lectura sale de las tablas existentes.

## 3. Plan de activación gradual de InkaClick

Cada fase es una autorización aparte. Un fallo detiene el avance y se revierte con el interruptor indicado.

| Fase | Acción | Verificación | Reversión |
|---|---|---|---|
| 0 | Revisar que el receptor tiene dueño y Production Branch de InkaClick correcta en Vercel (panel) | Confirmación humana | n/a |
| 1 | Proyecto InkaClick **de pruebas**: migración aditiva + edge function `wacrm-confirmed-orders` (`--no-verify-jwt`, token propio) | Token inválido = 401; payload válido crea 1 fila; mismo ID = misma fila | Borrar función y migración en el proyecto de pruebas |
| 2 | WACRM: `INKACLICK_ORDERS_URL/TOKEN` apuntando a pruebas, `INKACLICK_ORDERS_ENABLED=true`, `enabled=true` solo en la cuenta piloto; llamada manual al cron con el secreto (sin programarlo) | El pedido `held` no se envía solo; un pedido nuevo pasa `pending` → `sent` → `acknowledged` | `enabled=false` |
| 3 | Pruebas de fallo contra pruebas: receptor caído, 4xx, respuesta perdida | Reintento con backoff, `failed` visible, sin duplicados | `enabled=false` |
| 4 | Cron cada minuto (línea de cron) aún contra pruebas | 24 h sin errores ni duplicados | Quitar línea de cron |
| 5 | Apuntar a InkaClick productivo, un pedido real controlado | Una fila en `confirmed_orders` con `source` propio; ManyChat intacto | `enabled=false`; borrar la fila de prueba solo con autorización |
| 6 | Resto de cuentas, de una en una | Métricas de `failed`/`pending` | Interruptor por cuenta |

Los pedidos `held` actuales no se reenvían automáticamente; si se quiere enviarlos hay que decidirlo expresamente (hoy son pruebas).

## 4. Riesgos

- **Receptor sin código en repositorio**: se crea nuevo; no se toca la ruta de ManyChat.
- **Vercel de InkaClick**: fusiones a `main` crean despliegues de Producción y el alias sirve una rama de funcionalidad; verificar en el panel antes de tocar nada.
- **Datos de prueba en producción**: los pedidos `held` son de prueba y quedan en la cuenta piloto.
- **Campos vacíos**: `departamento` y descripción no tienen aún destino en InkaClick.
- **Correo**: SPF sin Brevo e IP autorizada sin confirmar; ajeno a pedidos pero afecta los registros.
- **Error previo ajeno**: `messages_status_check` (estados de audio).
- **Mantener `.env` y claves** fuera de logs y PR.

## 5. Verificaciones pendientes

Panel de Vercel (rama y alias); proyecto de pruebas de InkaClick; destino de `departamento`/descripción; decisión sobre los pedidos de prueba `held`; revisión y fusión del PR #56.
