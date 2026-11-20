// One-off: adds the PR-06 copy (namespace OrderPayments + two ConfirmedOrders keys) to messages/es.json and messages/en.json (round trip, CRLF kept). Idempotent. LOCAL tooling only.
const fs = require('node:fs')
const path = require('node:path')

const es = {
  title: 'Pagos', loadError: 'No se pudieron cargar los pagos.', retry: 'Reintentar', total: 'Total', paid: 'Pagado', balance: 'Saldo', statusLabel: 'Estado financiero',
  status: { unpaid: 'Pendiente', partially_paid: 'Parcial', paid: 'Pagado' },
  chip: { unpaid: 'Pendiente de pago', partially_paid: 'Pago parcial', paid: 'Pagado' }, chipBalance: 'saldo {balance}',
  finalized: 'Pedido completamente finalizado ({at})', deliveredWithBalance: 'Entregado con saldo pendiente: no está finalizado.', paidNotDelivered: 'Pagado, pendiente de entrega: no está finalizado.',
  paymentsList: 'Pagos del pedido', noPayments: 'Sin pagos registrados.',
  kind: { advance: 'Adelanto', balance: 'Saldo', full: 'Pago completo', other: 'Otro' },
  pstatus: { recorded: 'Por confirmar', confirmed: 'Confirmado', rejected: 'Rechazado', voided: 'Anulado' },
  paidOn: 'Pagó el {at}', by: 'registró {name}', operation: 'Operación', reasonLine: 'Motivo: {reason}', overpaymentLine: 'Excepción de sobrepago: {reason}', viewEvidence: 'Ver comprobante',
  confirm: 'Confirmar', reject: 'Rechazar', correct: 'Corregir', void: 'Anular', accept: 'Aceptar', cancel: 'Cancelar', reasonPlaceholder: 'Motivo (obligatorio)',
  acting: { void: 'Anular el pago de {amount}', reject: 'Rechazar el pago de {amount}', 'confirm-over': 'El pago de {amount} excede el saldo. Como Supervisor puedes autorizarlo con un motivo' },
  registerTitle: 'Registrar pago', correctTitle: 'Corregir pago (anula el anterior y crea uno nuevo)', amount: 'Monto (S/)', kindLabel: 'Tipo', method: 'Método (libre)', paidAtLabel: 'Fecha y hora del pago',
  notes: 'Notas', evidence: 'Comprobante', evidenceLinked: 'Comprobante vinculado: {name}', unlink: 'quitar', correctReason: 'Motivo de la corrección (obligatorio)', overReasonOptional: 'Motivo de sobrepago (solo si el nuevo monto excede el saldo)',
  saveCorrection: 'Guardar corrección', save: 'Registrar', register: 'Registrar pago',
  registeredToast: 'Pago registrado (por confirmar).', confirmedToast: 'Pago confirmado.', rejectedToast: 'Pago rechazado.', voidedToast: 'Pago anulado.', correctedToast: 'Pago corregido.', deliveredToast: 'Pedido marcado como entregado.',
  deliveredLine: 'Entregado ({source}) el {at}', deliverySource: { shalom: 'Shalom', manual: 'manual' },
  manualDeliveryHint: 'Pedido sin seguimiento Shalom activo (por ejemplo otro transportista): puedes marcarlo como entregado manualmente.', deliveryNote: 'Nota (opcional)', manualDeliveryConfirm: '¿Marcar este pedido como entregado? No se puede deshacer.', markDelivered: 'Marcar como entregado',
  hideHistory: 'Ocultar historial', showHistory: 'Ver historial ({count})', historyTitle: 'Historial financiero', balanceChange: 'saldo {before} → {after}',
  events: {
    payment_registered: 'Pago registrado', payment_confirmed: 'Pago confirmado', payment_rejected: 'Pago rechazado', payment_voided: 'Pago anulado', payment_corrected: 'Pago corregido', overpayment_exception: 'Excepción de sobrepago',
    finalization_marked: 'Pedido completamente finalizado', finalization_cleared: 'Finalización revertida', finalization_revoked_after_return: 'Finalización revertida (la conversación ya había vuelto a Comercial)', order_delivered_manual: 'Entregado manualmente',
  },
  chatTitle: 'Pago del pedido',
  err: {
    generic: 'No se pudo completar la acción. Inténtalo de nuevo.', network_error: 'Error de red.', feature_disabled: 'Los pagos no están activados para esta cuenta.', operational_role_required: 'Tu área operativa no te da acceso a los pagos.',
    supervisor_required: 'Solo un Supervisor puede hacerlo.', not_found: 'Pedido o pago no encontrado.', not_tracked: 'Este pedido es anterior a la activación de pagos: no tiene seguimiento financiero.',
    exceeds_balance: 'El pago excede el saldo pendiente. Solo un Supervisor puede autorizarlo con un motivo.', exceeds_balance_with: 'El pago excede el saldo pendiente ({balance}). Solo un Supervisor puede autorizarlo con un motivo.',
    overpayment_reason_required: 'Indica el motivo del sobrepago.', duplicate_evidence: 'Ese comprobante ya respalda otro pago vigente.', duplicate_operation: 'Ese número de operación ya está registrado en otro pago vigente.',
    invalid_evidence: 'El comprobante no es válido para este pedido.', stale: 'El pago cambió mientras lo editabas. Recarga e inténtalo de nuevo.', invalid_amount: 'Monto inválido (máximo 2 decimales, mayor que 0).',
    invalid_request: 'Datos inválidos.', invalid_kind: 'Tipo de pago inválido.', invalid_paid_at: 'Fecha de pago inválida.', invalid_request_key: 'Solicitud inválida, recarga e inténtalo de nuevo.', reason_required: 'El motivo es obligatorio.',
    request_key_conflict: 'Esa solicitud ya se usó con otros datos. Recarga e inténtalo de nuevo.', not_confirmable: 'Ese pago ya no se puede confirmar.', not_rejectable: 'Ese pago ya no se puede rechazar.', not_voidable: 'Solo un pago confirmado se puede anular.',
    not_correctable: 'Solo un pago confirmado se puede corregir.', shalom_tracking_active: 'Este pedido tiene seguimiento Shalom: se entrega con Shalom.', not_ready_for_dispatch: 'El pedido aún no está listo para despacho.',
    file_too_large: 'El archivo es demasiado grande.', unsupported_extension: 'Formato no permitido.', unsupported_proof_type: 'Solo PDF, JPG, PNG o WebP.', empty_file: 'El archivo está vacío.', rate_limited: 'Demasiadas solicitudes. Espera un momento.',
  },
}
const en = {
  title: 'Payments', loadError: 'Could not load the payments.', retry: 'Retry', total: 'Total', paid: 'Paid', balance: 'Balance', statusLabel: 'Financial status',
  status: { unpaid: 'Unpaid', partially_paid: 'Partial', paid: 'Paid' },
  chip: { unpaid: 'Payment pending', partially_paid: 'Partially paid', paid: 'Paid' }, chipBalance: 'balance {balance}',
  finalized: 'Order completely finalized ({at})', deliveredWithBalance: 'Delivered with a balance due: not finalized.', paidNotDelivered: 'Paid, pending delivery: not finalized.',
  paymentsList: 'Order payments', noPayments: 'No payments recorded.',
  kind: { advance: 'Advance', balance: 'Balance', full: 'Full payment', other: 'Other' },
  pstatus: { recorded: 'To confirm', confirmed: 'Confirmed', rejected: 'Rejected', voided: 'Voided' },
  paidOn: 'Paid on {at}', by: 'recorded by {name}', operation: 'Operation', reasonLine: 'Reason: {reason}', overpaymentLine: 'Overpayment exception: {reason}', viewEvidence: 'View proof',
  confirm: 'Confirm', reject: 'Reject', correct: 'Correct', void: 'Void', accept: 'Accept', cancel: 'Cancel', reasonPlaceholder: 'Reason (required)',
  acting: { void: 'Void the {amount} payment', reject: 'Reject the {amount} payment', 'confirm-over': 'The {amount} payment exceeds the balance. As Supervisor you can authorize it with a reason' },
  registerTitle: 'Record payment', correctTitle: 'Correct payment (voids the previous one and creates a new one)', amount: 'Amount (S/)', kindLabel: 'Type', method: 'Method (free text)', paidAtLabel: 'Payment date and time',
  notes: 'Notes', evidence: 'Proof', evidenceLinked: 'Linked proof: {name}', unlink: 'remove', correctReason: 'Correction reason (required)', overReasonOptional: 'Overpayment reason (only if the new amount exceeds the balance)',
  saveCorrection: 'Save correction', save: 'Record', register: 'Record payment',
  registeredToast: 'Payment recorded (to confirm).', confirmedToast: 'Payment confirmed.', rejectedToast: 'Payment rejected.', voidedToast: 'Payment voided.', correctedToast: 'Payment corrected.', deliveredToast: 'Order marked as delivered.',
  deliveredLine: 'Delivered ({source}) on {at}', deliverySource: { shalom: 'Shalom', manual: 'manual' },
  manualDeliveryHint: 'Order without an active Shalom shipment (for example another carrier): you can mark it as delivered manually.', deliveryNote: 'Note (optional)', manualDeliveryConfirm: 'Mark this order as delivered? This cannot be undone.', markDelivered: 'Mark as delivered',
  hideHistory: 'Hide history', showHistory: 'Show history ({count})', historyTitle: 'Financial history', balanceChange: 'balance {before} → {after}',
  events: {
    payment_registered: 'Payment recorded', payment_confirmed: 'Payment confirmed', payment_rejected: 'Payment rejected', payment_voided: 'Payment voided', payment_corrected: 'Payment corrected', overpayment_exception: 'Overpayment exception',
    finalization_marked: 'Order completely finalized', finalization_cleared: 'Finalization reverted', finalization_revoked_after_return: 'Finalization reverted (the conversation had already returned to Comercial)', order_delivered_manual: 'Delivered manually',
  },
  chatTitle: 'Order payment',
  err: {
    generic: 'The action could not be completed. Try again.', network_error: 'Network error.', feature_disabled: 'Payments are not enabled for this account.', operational_role_required: 'Your operational area has no access to payments.',
    supervisor_required: 'Only a Supervisor can do this.', not_found: 'Order or payment not found.', not_tracked: 'This order predates the activation of payments: it has no financial tracking.',
    exceeds_balance: 'The payment exceeds the pending balance. Only a Supervisor can authorize it with a reason.', exceeds_balance_with: 'The payment exceeds the pending balance ({balance}). Only a Supervisor can authorize it with a reason.',
    overpayment_reason_required: 'Give the overpayment reason.', duplicate_evidence: 'That proof already backs another live payment.', duplicate_operation: 'That operation number is already used by another live payment.',
    invalid_evidence: 'The proof is not valid for this order.', stale: 'The payment changed while you were editing it. Reload and try again.', invalid_amount: 'Invalid amount (max 2 decimals, greater than 0).',
    invalid_request: 'Invalid data.', invalid_kind: 'Invalid payment type.', invalid_paid_at: 'Invalid payment date.', invalid_request_key: 'Invalid request, reload and try again.', reason_required: 'The reason is required.',
    request_key_conflict: 'That request was already used with other data. Reload and try again.', not_confirmable: 'That payment can no longer be confirmed.', not_rejectable: 'That payment can no longer be rejected.', not_voidable: 'Only a confirmed payment can be voided.',
    not_correctable: 'Only a confirmed payment can be corrected.', shalom_tracking_active: 'This order has Shalom tracking: it is delivered through Shalom.', not_ready_for_dispatch: 'The order is not ready for dispatch yet.',
    file_too_large: 'The file is too large.', unsupported_extension: 'Format not allowed.', unsupported_proof_type: 'Only PDF, JPG, PNG or WebP.', empty_file: 'The file is empty.', rate_limited: 'Too many requests. Wait a moment.',
  },
}
const confirmed = {
  es: { balanceFilter: 'Con saldo', balanceFilterHint: 'Mostrar solo pedidos con saldo pendiente (sin pagar o pago parcial)' },
  en: { balanceFilter: 'With balance', balanceFilterHint: 'Show only orders with a pending balance (unpaid or partially paid)' },
}
for (const [lang, copy] of [['es', es], ['en', en]]) {
  const file = path.join(__dirname, '..', '..', '..', 'messages', `${lang}.json`)
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  json.OrderPayments = copy
  Object.assign(json.ConfirmedOrders, confirmed[lang])
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2).replace(/\n/g, '\r\n')}\r\n`, 'utf8')
  console.log('updated', lang)
}
