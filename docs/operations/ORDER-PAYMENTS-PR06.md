# PR-06 · Eje FINANCIERO del pedido: pagos, saldo y finalización completa

Estado: **implementado localmente** sobre PR-05 (rama `feat/order-payments-pr06`). Sin push, sin deploy, sin dinero real, sin Yape / banco / API financiera / OCR real, sin tocar InkaClick ni WhatsApp real.

## 1. Principios

* **Eje financiero separado del logístico.** Logístico: `ready_for_dispatch → En origen → En tránsito → En destino → Entregado`. Financiero: `unpaid → partially_paid → paid`. "Entregado + saldo pendiente" **no** está finalizado; "pagado + no entregado" tampoco.
* **El total es `order_confirmations.price`** (inmutable por `order_confirmations_freeze`). PR-06 no lo copia ni lo edita: `saldo = price − paid_confirmed`, calculado SOLO por la base de datos (el frontend no decide nada de dinero).
* Moneda **PEN** (`S/`). Importes `numeric(12,2)` exactos (sin floats): 33.33 + 33.33 + 33.34 = 100.00.
* **Pedidos históricos = `not_tracked`**: los confirmados antes de la primera activación no tienen fila financiera; no se les infiere nada ni se marcan impagos ni bloquean un retorno de conversación. Los pedidos nuevos de una cuenta activada nacen `unpaid`.
* **Un voucher PR-04 no es un pago.** Puede vincularse como evidencia candidata (y precargar el monto SOLO si `reviewed_data.amount` es utilizable), pero una persona confirma el pago.
* Por cuenta: `order_payment_settings.order_payments_enabled` (**default FALSE**) **Y** `logistics_mvp_enabled`. OFF = sin UI, sin escrituras, sin finalización PR-06; **no se borra nada**.
* No se implementa reembolso, CAPI `Purchase` ni cobranza; el modelo (`kind`, estados, eventos) es extensible.

## 2. Modelo (migraciones nuevas; ninguna de PR-01..PR-05 editada)

| Migración | Contenido |
|---|---|
| `20261203000000_order_payments_model.sql` | `order_payment_settings` (+`activated_at`), `order_payments`, `order_financials`, `order_payment_events`, helpers de acceso y RLS (navegador solo LEE) |
| `20261203000001_order_payment_rpcs.sql` | register / confirm / reject / void / correct, cálculo, auditoría |
| `20261203000002_order_payment_proof.sql` | `order_documents.kind = payment_proof` + `register_payment_proof` |
| `20261203000003_order_finalization_pr06.sql` | entrega manual, evaluador de finalización, sweeper, regla multi-pedido (reemplaza la función de retorno de PR-05C) |

* **order_payments**: `amount`, `currency` (PEN), `kind` (advance / balance / full / other, **informativo**), `method` (libre), `operation_number` (opcional), `paid_at`, `status` (`recorded → confirmed | rejected`; `confirmed → voided`), `evidence_document_id`, `notes`, `source`, actor y marcas de cada transición, `row_version`. Datos de dinero **inmutables** (trigger); `rejected` / `voided` son finales; nada se borra.
* **order_financials**: estado vigente de los pedidos rastreados (`paid_confirmed`, `financial_status`, `paid_at` = el momento en que pasó a `paid`).
* **order_payment_events** (append-only, índices únicos por pago y tipo): `payment_registered`, `payment_confirmed`, `payment_rejected`, `payment_voided`, `payment_corrected`, `overpayment_exception`, `finalization_marked`, `finalization_cleared`, `finalization_revoked_after_return`, `order_delivered_manual`. Guardan actor, monto, estado antes/después, **saldo antes/después**, evidencia, motivo y marca de tiempo.

## 3. Cálculo y reglas

* `paid_confirmed = SUM(pagos confirmed)`; `pending_balance = max(price − paid_confirmed, 0)`; `unpaid` (0), `partially_paid`, `paid` (≥ total). **No existe `overpaid`.**
* **Sobrepago bloqueado**: confirmar un pago que excede el saldo se rechaza (`exceeds_balance`) salvo **Supervisor con motivo obligatorio** (queda `overpayment_exception` y el estado sigue siendo `paid`).
* **Sin adelanto mínimo** ni regla 30 % / 50 %: un pedido puede pagarse completo después.
* **Idempotencia**: `request_key` por cuenta (el mismo retry = el mismo pago, sin segundo saldo; otro monto con la misma clave = conflicto); `row_version` (`stale`); la misma evidencia no respalda dos pagos vivos; `operation_number` único por cuenta mientras el pago esté vivo (rechazar / anular lo libera).
* **Concurrencia**: lock por pedido + `FOR UPDATE`; dos operadores o doble clic se serializan (uno solo confirma; dos pagos que juntos exceden el saldo → el segundo se bloquea).
* **Corregir = anular + pago nuevo confirmado** en una transacción (Supervisor, motivo obligatorio, historial completo, `supersedes_payment_id`). Anular = Supervisor + motivo; recalcula; no borra.

## 4. Evidencia

Se reutiliza `order_documents` y el bucket privado `order-docs`: `kind = payment_proof`, `account-<id>/orders/<order>/payment-proofs/…`, subida validada (tamaño, extensión, tipo real por bytes), idempotente por `request_key` (el mismo archivo = una prueba), **solo URL firmadas de 120 s** (la ruta no se devuelve; no hay URL pública). Un voucher PR-04 puede enlazarse sin copiar el archivo. Los RPC de PR-04 rechazan un `payment_proof` (todo está filtrado por `kind`).

## 5. Permisos

| Acción | Logística | Supervisor | Comercial | Viewer / sin área / otra cuenta |
|---|---|---|---|---|
| Ver Total / Pagado / Saldo / Estado en Pedidos Confirmados | sí | sí | no (no entra) | no |
| Ver pagos, historial, evidencia | sí | sí | no | no |
| Registrar y confirmar pago, rechazar, marcar entregado | sí | sí | no | no |
| Corregir, anular, autorizar sobrepago | no | **sí** | no | no |
| **Panel del chat**: Total / Pagado / Saldo / Estado (solo lectura, sin botones) | sí | sí | **sí**, solo de un chat que hoy puede atender (routing PR-03) | no |

Todo por RLS + RPC `service_role` que revalidan actor, cuenta, flags, área y pedido; cross-account imposible (se responde "no encontrado").

## 6. Finalización completa

`COMPLETAMENTE FINALIZADO = LOGÍSTICA ENTREGADO ∧ FINANZAS PAID` → `evaluate_order_finalization` → `mark_order_finalized` (source `pr06_paid_and_delivered`).

* **`finalized_at` = el momento de la ÚLTIMA condición** (`greatest(paid_at, delivered_at)`), nunca la hora del cron. PR-05C cuenta +10 min desde ahí.
* "Entregado" = shipment Shalom `delivered` (PR-05) **o entrega manual** (abajo).
* Se evalúa dentro de cada pago confirmado / anulado / corregido y de la entrega manual, y además un **sweeper durable** en el tick del cron de PR-05C (`/api/conversations/routing/cron`) descubre las entregas Shalom posteriores al pago (PR-05 no llama a PR-06).
* Si antes del retorno un pago se anula / corrige y el pedido deja de estar `paid` → `clear_order_finalized` (reabrir reinicia el reloj). Si el retorno **ya ocurrió**, el routing **no se revierte**: se registra `finalization_revoked_after_return`.

### Entrega manual (Olva y otros, sin tracking Shalom)
`mark_order_delivered_manual`: Logística o Supervisor, **manual, auditada, idempotente** (la primera fecha se conserva; registro inmutable), solo para un pedido `ready_for_dispatch` **sin** shipment Shalom activo / entregado (con guía `stopped` se permite). Una guía Shalom no puede registrarse después de una entrega manual. No toca Shalom ni los pagos.

### Regla multi-pedido (corrige el hueco de PR-05C)
Una conversación vuelve **automáticamente** a Comercial solo cuando **todos** los pedidos relevantes del chat (los rastreados) tienen finalización vigente; los históricos no bloquean; el plazo de 10 min cuenta desde la **última** finalización requerida. Si falta alguno, el retorno queda diferido (`deferred`). La derivación manual (`logistics → shared`) y el no-pisar decisiones humanas de PR-05C se mantienen.

## 7. UI

* **Pedidos Confirmados → detalle**: bloque **Pagos** (Total / Pagado / Saldo / Estado, pagos con sus acciones según rol, formulario de registro con subida de comprobante y candidato de voucher, historial con saldo antes → después, entrega manual, estado de finalización).
* **Lista**: chip financiero (Pendiente / Parcial / Pagado + saldo) y filtro **Con saldo (n)**.
* **Chat (sidebar)**: bloque de solo lectura **Pago del pedido** (sin botones, sin pagos ni evidencia).

## 8. API

`GET|POST /api/orders/payments/orders/[orderId]` (panel / `register` `confirm` `reject` `void` `correct` `mark_delivered`) · `POST …/evidence` (subida) · `GET /api/orders/payments/documents/[id]/url` · `GET …/summary?ids=` · `GET …/with-balance` · `GET …/conversation?conversation_id=` (solo lectura, Comercial incluido). Cron: `GET /api/conversations/routing/cron` (ya existía; ahora también barre finalizaciones). `ORDER_FINALIZED_GRACE_MINUTES` solo afina QA.

## 9. Rollback

`order_payments_enabled = false` (por cuenta): las RPC rechazan escrituras, desaparece la UI y la finalización PR-06 deja de actuar; **pagos, evidencias, eventos y entregas manuales se conservan**. Inbox, Shalom y routing no dependen de las tablas nuevas. Sin `DROP`.

## 10. QA / UAT local

Preparación: `node scripts/qa/pr06/seed.cjs prepare` (activa PR-06 en la cuenta QA A y crea pedidos **nuevos** S/100 `ready_for_dispatch`; los del UAT anterior quedan `not_tracked`; reiniciar la app con `scripts\qa\pr05\start-app.ps1`). Usuarios: `qa-logistica`, `qa-supervisor`, `qa-comercial` (`@qa-pr04.example.invalid`). URL `http://localhost:3000`.

| Comando | Qué hace |
|---|---|
| `node scripts/qa/pr06/status.cjs` | estado de P1..P4: financiero, pagos, entrega, finalización, routing del chat |
| `node scripts/qa/pr06/pay.cjs pay P1 30 advance` | registra + confirma un pago (opcional; todo se puede hacer en la UI) |
| `node scripts/qa/pr06/pay.cjs deliver P2` | entrega manual |
| `node scripts/qa/pr06/pay.cjs shift P1 9` | adelanta `finalized_at` N min (el reloj de QA: +9 / +10 sin esperar) |
| `node scripts/qa/pr06/pay.cjs tick` | un tick del cron (barrido + retorno) |
| `node scripts/qa/pr05/shalom-sim.cjs set delivered 40000021` + `node scripts/qa/pr05/run-cron.cjs --make-due` | entrega Shalom de P1 |
| `node scripts/qa/pr06/smoke.cjs` | humo HTTP de punta a punta sobre PS (ya recorrido por Claude) |

Guía manual (entrar como **qa-logistica** salvo que se indique):
* **A.** Abrir "Pago QA P1": Pagos muestra **Total S/ 100.00 · Pagado S/ 0.00 · Saldo S/ 100.00 · Pendiente** (`unpaid`). El chip de la lista dice "Pendiente de pago".
* **B.** Registrar pago S/30 (adelanto, método libre, comprobante opcional) → queda "Por confirmar" → **Confirmar** → **Parcial**, saldo S/70. Reintentar el mismo envío no duplica.
* **C.** Registrar S/70 (saldo) y confirmar → **Pagado**, saldo 0.
* **D.** Mientras no esté entregado: no hay finalización (el bloque lo dice: "Pagado, pendiente de entrega"). `status.cjs`: finalizado "-".
* **E.** Registrar la guía Shalom `40000021 / QAP1` en Tracking Shalom, `shalom-sim set delivered 40000021`, `run-cron --make-due` (o `pay.cjs tick`): aparece "Pedido completamente finalizado" con `finalized_at` = la última condición.
* **F/G.** `pay.cjs shift P1 9` + `pay.cjs tick` → sigue en Logística; esperar/adelantar 1 min más y `tick` → vuelve a **Comercial** (entrar como **qa-comercial**: ve el chat y el bloque de solo lectura "Pago del pedido", sin botones).
* **H.** Con un pedido pagado y entregado (P2) y antes del +10: entrar como **qa-supervisor**, **Anular** un pago con motivo → la finalización queda revertida (`status.cjs`: "limpiado") y el chat no vuelve. Volver a pagar reabre el reloj.
* **I.** P3 y P4 comparten chat: pagar y entregar solo P3, `shift P3 30` + `tick` → **no** vuelve (`deferred`). Finalizar también P4 y `tick` tras el +10 de la última → vuelve (un solo evento).
* **J.** P2 (sin guía Shalom): pagar S/100, **Marcar como entregado** → finalizado.
* Permisos: **qa-comercial / qa-viewer / qa-sinarea** no ven el bloque Pagos, ni el chip, ni el filtro; Comercial solo ve el resumen de solo lectura en el chat.

## 11. Pendientes externos / decisiones fuera de PR-06

1. **InkaClick** mantiene su propio `pago_inicial` / `pago_restante` / `estado_pedido`: definir cuál sistema es la verdad financiera de WACRM antes de activar nada real (no hay sincronización, PRE-DEPLOY).
2. Meta CAPI `Purchase` sigue bloqueado (no es parte del MVP; PR-06 solo deja la señal "pagado").
3. Muestras reales de vouchers / OCR real, integración bancaria o Yape: fuera de alcance.
4. Reembolsos / devoluciones monetarias y cobranza de saldos (recordatorios, mensajes): automatizaciones futuras; en abandono el saldo simplemente permanece.
5. Reglas de negocio opcionales (adelanto mínimo configurable) si el negocio las define.
6. Instalar el cron cada minuto (`scripts/ops/routing-cron/`) solo al desplegar.
