# WACRM — Plantillas manuales Resumen + Voucher

**Fecha:** 2026-11-28  
**Base productiva:** `0c4e88bb0d52eac69a944a38c3d662f97d2425c4`  
**Requerimiento Fase 2:** 02 — Dos plantillas WhatsApp

## Objetivo

Agregar dos acciones manuales en **Pedidos confirmados → Detalle del pedido → Logística**, ubicadas visualmente **entre Voucher y Embalaje**:

1. **Enviar resumen del pedido**
2. **Enviar voucher al cliente**

Nada se envía por cron, Flow o automatización. Siempre debe existir una acción explícita de una persona de Logística/Supervisión.

## Regla habilitante

Ambas acciones se habilitan únicamente cuando:

- el pedido tiene un voucher asociado;
- `order_logistics.voucher_document_id` apunta al voucher vigente;
- el documento es `kind = voucher`;
- el documento está en estado `validated`.

Con voucher ausente, pendiente de revisión, rechazado o reemplazado, los botones permanecen deshabilitados.

Texto sugerido en UI:

> Valida el voucher para habilitar los envíos al cliente.

## Plantilla 1 — Resumen del pedido

Nombre Meta propuesto:

`resumen_pedido_confirmado`

Categoría propuesta:

`UTILITY`

Header:

Ninguno.

Contenido de referencia:

```
Hola {{1}}, te enviamos el resumen de tu pedido.

Cliente: {{2}}
DNI: {{3}}
Destino: {{4}}

{{5}}

Costo total: {{6}}
Adelanto: {{7}}
PAGO PENDIENTE: {{8}}
```

Variables:

1. saludo / nombre del cliente
2. nombre completo
3. DNI
4. destino
5. líneas de productos, por ejemplo:
   - 1 × Guitarra Memphis
   - 1 × Violín clásico
   - 1 × capotraste
   - 1 × afinador
6. costo total formateado: `S/ 580.00`
7. monto pagado confirmado / adelanto: `S/ 80.00`
8. saldo pendiente: `S/ 500.00`

### Fuente de datos

- cliente / DNI / destino / productos / total: pedido confirmado;
- adelanto/pagado y saldo: `order_financials` mediante la lógica financiera existente;
- el saldo nunca se inventa;
- si no existe saldo confiable según `balance_trusted_since`, el envío debe rechazarse.

El voucher validado es requisito para habilitar el botón aunque esta plantilla no adjunte el archivo.

## Plantilla 2 — Voucher validado

Nombre Meta propuesto:

`voucher_pedido_validado`

Categoría propuesta:

`UTILITY`

Header:

`IMAGE`

El header lleva una representación visual del **voucher validado de ese mismo pedido**.

Contenido sugerido:

```
Hola {{1}} 👋

Te compartimos el voucher validado de tu pedido.

Cliente: {{2}}
Destino: {{3}}

Conserva esta imagen como constancia.
```

Variables:

1. nombre del cliente
2. nombre completo
3. destino

### Archivo

- Si el voucher original es JPEG / PNG / WEBP: usar la imagen validada.
- Si el voucher original es PDF: generar una representación de la primera página como imagen para el envío.
- El archivo original almacenado en WACRM nunca se reemplaza ni modifica.
- La URL entregada a Meta debe ser temporal / firmada y no revelar el storage path.

**Nota técnica:** el repositorio actual no declara una dependencia de conversión PDF→imagen propia. La conversión debe implementarse y validarse de forma explícita antes de habilitar envíos de vouchers PDF; no se debe degradar silenciosamente a DOCUMENT ni enviar el PDF en una plantilla IMAGE.

## UX

En el panel:

```
Voucher
[contenido actual]

[ Enviar resumen del pedido ]
[ Enviar voucher al cliente ]

Embalaje
[contenido actual]
```

Estados esperados de cada botón:

- deshabilitado: voucher no validado;
- listo;
- enviando;
- enviado;
- fallo confirmado → permite reintento manual;
- resultado incierto → NO reenvía automáticamente; una persona debe resolverlo.

## Seguridad y comportamiento

- actor, account y permisos se resuelven desde la sesión;
- Logística / Supervisor únicamente;
- RLS preservado;
- conversación debe pertenecer al mismo pedido/cuenta;
- envío usa la infraestructura existente de Meta / `sendMessageToConversation`;
- `origin = manual_reply`, porque es una acción humana;
- el mensaje queda registrado en la conversación;
- no cambia el estado de Embalaje ni mueve el pedido a Listo para despacho;
- no usa el ledger `order_template_dispatches` de Embalaje porque ese ledger cambia el estado logístico;
- debe existir idempotencia propia para evitar doble envío por doble clic/reintento;
- ningún cron ni worker dispara estas plantillas.

## No mezclar con

- plantilla de embalaje;
- aviso de llegada;
- `voucher_envio_shalom` existente;
- automatizaciones;
- Flows.

El `voucher_envio_shalom` actual corresponde a otro momento operativo (guía/envío posterior) y no sustituye estas dos acciones.

## Criterios de aceptación

1. Sin voucher: ambos botones deshabilitados.
2. Voucher pendiente de revisión: ambos deshabilitados.
3. Voucher validado: ambos habilitados.
4. Resumen utiliza los datos reales del pedido y saldo confiable.
5. Voucher envía exactamente el documento validado como representación visual.
6. Doble clic no genera dos mensajes.
7. Error antes de Meta permite reintento manual.
8. Resultado incierto nunca se reenvía solo.
9. Enviar cualquiera de las dos plantillas no cambia el estado logístico.
10. Ambos mensajes aparecen en el chat del mismo cliente.


## Estado del candidato

Backend + UI preparados en la rama. La comunicación es independiente de Embalaje y usa un ledger propio.

**Bloqueador deliberado antes de deploy:** si el voucher validado es PDF, "Enviar voucher al cliente" permanece deshabilitado hasta validar una conversión PDF→imagen estable en el contenedor productivo. "Enviar resumen" no depende del formato del archivo y sí puede operar con voucher PDF validado.

La migración nueva es aditiva y NO debe aplicarse hasta que el candidato completo pase auditoría, tests, build y QA.
