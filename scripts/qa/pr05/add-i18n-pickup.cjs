// One-off: adds the PR-05A/B copy to messages/es.json and messages/en.json (round trip, CRLF kept). Idempotent. LOCAL tooling only.
const fs = require('node:fs')
const path = require('node:path')

const copy = {
  es: {
    shipments: {
      pickupTitle: 'Recojo en destino',
      shalomStatus: 'Estado Shalom',
      daysAtDestination: 'Días en destino',
      daysValue: '{count, plural, one {# día} other {# días}}',
      pickupState: 'Estado de recojo',
      'pickupStates.none': 'Sin condición',
      'pickupStates.waiting_pickup': 'Esperando recojo',
      'pickupStates.alerted_15d': 'Alerta de 15 días',
      'pickupStates.abandoned': 'En abandono',
      'pickupStates.completed': 'Recojo completado',
      customerMessage: 'Mensaje al cliente (día 15)',
      'customerMessageStatus.none': 'No aplica',
      'customerMessageStatus.pending': 'Pendiente de envío',
      'customerMessageStatus.claimed': 'Pendiente de envío',
      'customerMessageStatus.sending': 'Enviando',
      'customerMessageStatus.sent': 'Enviado',
      'customerMessageStatus.failed': 'Falló',
      'customerMessageStatus.uncertain': 'Resultado incierto: revisa la conversación',
      'customerMessageStatus.skipped': 'Omitido (el pedido ya no está en destino)',
      internalAlert: 'Alerta interna (día 15)',
      'internalAlertStates.none': 'Sin alerta',
      'internalAlertStates.open': 'Abierta',
      'internalAlertStates.acknowledged': 'Atendida',
      'internalAlertStates.resolved': 'Resuelta',
      abandonment: 'En abandono',
      abandonmentSince: 'Desde {at}',
      abandonmentNote: 'Condición operativa de WACRM: Shalom sigue mostrando "En destino". Aquí solo se detecta y se etiqueta.',
      retryMessage: 'Reintentar mensaje',
      retriedToast: 'Mensaje en cola para reintento.',
      resolveSent: 'Sí se entregó',
      resolveNotSent: 'No se entregó',
      resolvedToast: 'Resultado del mensaje registrado.',
      alert15Short: 'Alerta 15 días',
      abandonedShort: 'En abandono · {days} días',
      atDestinationShort: 'En destino · {days} d',
      'err.not_failed': 'El mensaje no está fallido.',
      'err.needs_resolution': 'El resultado es incierto: confírmalo en lugar de reintentar.',
      'err.no_longer_at_destination': 'El pedido ya no está en destino.',
      'err.not_uncertain': 'El mensaje no está en estado incierto.',
      'err.invalid_resolution': 'Resolución inválida.',
      'err.invalid_message_id': 'Mensaje inválido.',
      'events.pickup_waiting_started': 'Esperando recojo en destino',
      'events.pickup_completed': 'Recojo completado',
      'events.pickup_abandoned': 'Marcado EN ABANDONO (20 días)',
      'events.pickup_abandonment_cleared': 'Abandono cerrado',
      'events.destination_customer_message_due': 'Mensaje al cliente pendiente (día 15)',
      'events.destination_customer_message_sent': 'Mensaje al cliente enviado',
      'events.destination_customer_message_failed': 'Mensaje al cliente falló',
      'events.destination_customer_message_uncertain': 'Mensaje al cliente: resultado incierto',
      'events.destination_customer_message_skipped': 'Mensaje al cliente omitido',
      'events.destination_customer_message_retry_requested': 'Reintento del mensaje solicitado',
    },
    confirmed: { abandonedFilter: 'En abandono', abandonedFilterHint: 'Mostrar solo pedidos en abandono (20+ días en destino)' },
  },
  en: {
    shipments: {
      pickupTitle: 'Pickup at destination',
      shalomStatus: 'Shalom status',
      daysAtDestination: 'Days at destination',
      daysValue: '{count, plural, one {# day} other {# days}}',
      pickupState: 'Pickup state',
      'pickupStates.none': 'No condition',
      'pickupStates.waiting_pickup': 'Waiting for pickup',
      'pickupStates.alerted_15d': '15-day alert',
      'pickupStates.abandoned': 'Abandoned',
      'pickupStates.completed': 'Pickup completed',
      customerMessage: 'Customer message (day 15)',
      'customerMessageStatus.none': 'Not applicable',
      'customerMessageStatus.pending': 'Waiting to be sent',
      'customerMessageStatus.claimed': 'Waiting to be sent',
      'customerMessageStatus.sending': 'Sending',
      'customerMessageStatus.sent': 'Sent',
      'customerMessageStatus.failed': 'Failed',
      'customerMessageStatus.uncertain': 'Outcome unknown: check the conversation',
      'customerMessageStatus.skipped': 'Skipped (the order is no longer at destination)',
      internalAlert: 'Internal alert (day 15)',
      'internalAlertStates.none': 'No alert',
      'internalAlertStates.open': 'Open',
      'internalAlertStates.acknowledged': 'Attended',
      'internalAlertStates.resolved': 'Resolved',
      abandonment: 'Abandoned',
      abandonmentSince: 'Since {at}',
      abandonmentNote: 'WACRM operational condition: Shalom still shows "At destination". It is only detected and labelled here.',
      retryMessage: 'Retry message',
      retriedToast: 'Message queued for retry.',
      resolveSent: 'It was delivered',
      resolveNotSent: 'It was not delivered',
      resolvedToast: 'Message outcome recorded.',
      alert15Short: '15-day alert',
      abandonedShort: 'Abandoned · {days} days',
      atDestinationShort: 'At destination · {days} d',
      'err.not_failed': 'The message is not failed.',
      'err.needs_resolution': 'The outcome is unknown: confirm it instead of retrying.',
      'err.no_longer_at_destination': 'The order is no longer at destination.',
      'err.not_uncertain': 'The message is not in the unknown state.',
      'err.invalid_resolution': 'Invalid resolution.',
      'err.invalid_message_id': 'Invalid message.',
      'events.pickup_waiting_started': 'Waiting for pickup at destination',
      'events.pickup_completed': 'Pickup completed',
      'events.pickup_abandoned': 'Marked ABANDONED (20 days)',
      'events.pickup_abandonment_cleared': 'Abandonment closed',
      'events.destination_customer_message_due': 'Customer message due (day 15)',
      'events.destination_customer_message_sent': 'Customer message sent',
      'events.destination_customer_message_failed': 'Customer message failed',
      'events.destination_customer_message_uncertain': 'Customer message: outcome unknown',
      'events.destination_customer_message_skipped': 'Customer message skipped',
      'events.destination_customer_message_retry_requested': 'Message retry requested',
    },
    confirmed: { abandonedFilter: 'Abandoned', abandonedFilterHint: 'Show only abandoned orders (20+ days at destination)' },
  },
}

const setDeep = (obj, dotted, value) => {
  const parts = dotted.split('.')
  let o = obj
  for (const k of parts.slice(0, -1)) o = o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {}
  o[parts.at(-1)] = value
}

for (const lang of ['es', 'en']) {
  const file = path.join(__dirname, '..', '..', '..', 'messages', `${lang}.json`)
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const [k, v] of Object.entries(copy[lang].shipments)) setDeep(json.OrderShipments, k, v)
  for (const [k, v] of Object.entries(copy[lang].confirmed)) setDeep(json.ConfirmedOrders, k, v)
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2).replace(/\n/g, '\r\n')}\r\n`, 'utf8')
  console.log('updated', lang)
}
