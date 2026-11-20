# CALL-02 - Persistencia y recepcion segura de WhatsApp Calling

**Estado:** implementacion en rama; no desplegado. **Webhook calls:** desactivado en Meta hasta completar QA.

## Alcance

- Persistir connect, terminate y estados RINGING/ACCEPTED de field=calls.
- Deduplicar por hash estable y actualizar una sesion por phone_number_id + call_id.
- Resolver la cuenta exclusivamente desde whatsapp_config.phone_number_id.
- Cifrar SDP antes de almacenarlo; caducidad de cinco minutos. No se registra ni se conserva en historial conversacional.
- Persistir respuestas explicitas call_permission_reply del webhook messages, con permiso temporal/permanente o rechazo.
- Tablas y RPCs inaccesibles para anon/authenticated; solo service_role.
- Integrar field=calls en el procesador durable existente.

## Modelo

- whatsapp_call_sessions: estado actual, identidad minima y SDP cifrado efimero.
- whatsapp_call_events: registro idempotente minimo, sin payload ni SDP.
- whatsapp_call_permissions: ultima decision por numero empresarial y clave de cliente (BSUID preferido; telefono fallback).

## Estados

- connect + USER_INITIATED: offered.
- connect + BUSINESS_INITIATED: connecting.
- statuses[type=call,status=RINGING]: ringing.
- statuses[type=call,status=ACCEPTED]: connected.
- terminate: terminated/failed; elimina SDP efimero.
- call_permission_reply: approved temporal/permanente o rejected.

## Fuera de alcance

No activa Meta calls, no inicia llamadas, no solicita permisos, no ofrece endpoints al navegador, no añade WebRTC ni UI, no cambia VPS ni producción.

## QA requerido

Migracion aislada; SQL QA para RLS/grants/deduplicacion/aislamiento/orden temporal/permisos; unit tests; lint, typecheck, test y build. La suscripcion calls solo se reactivara despues de QA integral y autorizacion del operador.
