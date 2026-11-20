# P0 parity (fase 2): plantillas Meta finales, OCR real y coexistencia del número viejo (LOCAL)

Rama `feat/p0-parity-balance-voucher`. Solo local: sin deploy, sin cutover, sin WhatsApp, sin Meta, sin Shalom, sin tocar InkaClick. **Las plantillas de abajo NO están creadas en Meta**:
este documento es el contenido final propuesto para revisión.

## 0. Decisiones incorporadas

1. Históricos / `not_tracked`: **estrategia A** — los pedidos anteriores a la activación de PR-06 terminan su ciclo en InkaClick. No se importan saldos, no se modifica nada histórico.
   WACRM es fuente financiera solo de pedidos nuevos desde el cutover. (El código ya cumple: sin fila financiera no hay saldo ni envío automático.)
2. Instrucciones de pago: siguen en `order_payment_settings.customer_payment_instructions` (por cuenta, sin valores reales cargados).
3. DNI: ninguna plantilla lleva el número; solo "acércate con tu DNI o documento físico".
4. OCR real: P0, preparado antes del cutover (sección 3). El flujo manual sigue como fallback.
5. Número viejo +51 963 465 690: NO se apaga en el cutover inicial; nuevas comunicaciones WACRM por +51 980 942 247 (sección 5).
6. InkaClick sigue activo íntegro (`sync-shalom-statuses`, `notify-destination-vouchers`, `wacrm-confirmed-orders`, `whatsapp-webhook`, operación manual).

## 1. Set final de plantillas Meta P0

Se mantienen **sin modificar** las 3 PENDING: `pedido_embalado_listo`, `pedido_llegada_destino`, `recordatorio_recojo_pedido`. Se proponen 3 nuevas (idioma `es`, categoría UTILITY).
Reglas Meta respetadas: el cuerpo no empieza ni termina con variable, ninguna variable lleva saltos de línea, sin contenido promocional, sin datos bancarios.

### 1.1 `pedido_embalado_listo_saldo`
- Reemplaza en InkaClick: `actualizacion_pedido_embalaje` (aviso de embalaje con foto) para pedidos con saldo > 0.
- Header: **IMAGE** (la foto de evidencia del embalaje; muestra en el alta: una foto de paquete genérica).
- Body:
  > Hola {{1}}, tu pedido de {{2}} ya está embalado y listo para enviarse a {{3}}. Te compartimos la foto del paquete. Tu pedido tiene un saldo pendiente de {{4}}, que se completa antes del recojo. Si tienes alguna consulta, respóndenos por este mismo chat.
- Variables (orden = `packaging_balance_template_params`): `customer_name`, `product`, `destination`, `pending_balance`.
- Ejemplo: {{1}}=María Pérez, {{2}}=2 cajas de Colágeno, {{3}}=Piura, {{4}}=S/ 150.00.
- Sin número de DNI, sin datos bancarios. Con saldo 0 se sigue usando `pedido_embalado_listo`.

### 1.2 `pedido_llegada_destino_saldo`
- Reemplaza en InkaClick: `confirmacion_recojo_hoy_v2` (aviso de llegada con saldo) para pedidos nuevos con saldo > 0.
- Header: ninguno.
- Body:
  > Hola {{1}}, tu pedido de {{2}} ya llegó a la agencia en {{3}} y está listo para recoger. Recuerda acercarte con tu DNI o documento físico. Tienes un saldo pendiente de {{4}}. Para completar el pago: {{5}}. Si ya lo realizaste, avísanos respondiendo a este mensaje.
- Variables (orden = `arrival_balance_template_params`): `customer_name`, `product`, `destination`, `pending_balance`, `payment_instructions`.
- Ejemplo: {{1}}=María Pérez, {{2}}=2 cajas de Colágeno, {{3}}=Piura, {{4}}=S/ 150.00, {{5}}=Paga por el medio indicado por tu asesor y envía tu comprobante.
- `payment_instructions` queda vacío hasta autorización específica; sin instrucciones el envío se rechaza (`payment_instructions_not_configured`), nunca sale a medias.
- Con saldo 0 se usa `pedido_llegada_destino`. Pedido `not_tracked`: no se envía nada automático (estrategia A).

### 1.3 `voucher_envio_shalom`
- Reemplaza en InkaClick: `voucher_shalom_pdf`.
- Header: **DOCUMENT** (el PDF del voucher validado en PR-04; nombre de archivo en el alta: `voucher-shalom.pdf`).
- Body:
  > Hola {{1}}, te compartimos el voucher de tu envío por Shalom. Número de orden: {{2}}. Código: {{3}}. Destino: {{4}}. Con estos datos puedes hacer seguimiento y recoger tu pedido con tu DNI o documento físico.
- Variables (orden = `voucher_message_template_params`): `customer_name`, `shalom_number`, `shalom_code`, `destination`.
- Ejemplo: {{1}}=María Pérez, {{2}}=104453167, {{3}}=N3WC, {{4}}=Piura.
- Envío **manual** por Logística/Supervisor; nunca automático.

Luego de aprobada cada una: configurar por cuenta `packaging_balance_template_*`, `arrival_balance_template_*`, `voucher_message_template_*` (sin deploy adicional).

## 2. OCR actual de InkaClick (auditoría solo lectura, sin secretos)

- **No existe** ninguna Edge Function de OCR en el proyecto Supabase de InkaClick (funciones: envío WhatsApp, `notify-destination-vouchers`, `sync-shalom-statuses`, `wacrm-confirmed-orders`, `whatsapp-webhook`, etc.).
  La extracción corre **fuera de Supabase** (aplicación/servicio de InkaClick no accesible desde aquí). Endpoint, autenticación, request y proveedor subyacente: **no determinables** con el acceso disponible, y no se copió ni se buscó ningún secreto.
- Contrato inferido de los datos (`vouchers`): campos `codigo`, `numero_orden`, `modalidad`, `tipo_entrega`, `moneda`, `total_pagar`, `fecha_emision`, `fecha_traslado`, `origen`, `remitente_{nombre,documento,telefono}`, `destinatario_{nombre,documento,telefono}`,
  `confianza_ocr` (escala 0–100, promedio ≈ 93, p10 = 90) y `campos_dudosos` (lista de campos). Es decir, el comportamiento es de **lector con visión (LLM)**: un score global + lista de campos dudosos, no un OCR clásico por campo.
- Volumen: ~58 vouchers/día (14 días); **56 %** (490 de 875) llegan con al menos un campo dudoso → la revisión humana sigue siendo necesaria incluso con OCR.
- Veredicto de reutilización: **no se recomienda** reutilizar el intermediario de InkaClick: no se conoce su contrato ni sus condiciones de uso, acoplaría WACRM a un sistema que se va a retirar, y compartiría credenciales entre sistemas.

## 3. Diseño OCR WACRM (implementado, inerte)

- La frontera ya existía (PR-04): `VoucherOcrProvider` → `runDocumentOcr` (claim, timeout 30 s, auditoría) → `normalizeOcrOutput` → pantalla de revisión → comparación con el pedido → matching conservador. El resultado es **sugerencia**; nunca valida un voucher.
- Nuevo: `src/lib/orders/logistics/ocr/vision-provider.ts` (`vision_llm`), proveedor HTTP real contra la API de mensajes de un LLM con visión (PDF/JPEG/PNG). Sin SDK.
  - Activación: `ORDER_OCR_PROVIDER=vision_llm` **y** `ORDER_OCR_API_KEY` **y** `ORDER_OCR_MODEL` (opcional `ORDER_OCR_BASE_URL`). Si falta cualquiera → `not_configured` (flujo manual). Clave solo por entorno, nunca en BD ni logs.
  - Request: `POST /v1/messages`, temperatura 0, el archivo en base64 (documento o imagen) + instrucción de extraer solo lo impreso y devolver JSON.
  - Campos (convención WACRM): `customer_name`, `dni`, `phone` (destinatario), `amount`, `shalom_number`, `shalom_code`, `destination`, `sender_name/dni/phone`, `issued_at`, `currency`. Los nombres no permitidos se descartan.
  - Confianza: 0–1 por campo; null ⇒ 0; campos que el modelo marca como dudosos se limitan a 0.5 (paridad con `campos_dudosos`); la normalización recorta a 0..1.
  - Errores tipados sin texto del proveedor ni contenido del voucher: 429 → `ocr_rate_limited`; 4xx/5xx/red → `ocr_provider_error`; abort/timeout → `ocr_timeout`; respuesta no JSON / sin `fields` → `ocr_invalid_response`; rechazo del modelo o nada legible → `ocr_unreadable`.
  - Límites: archivo ≤ 8 MB (WACRM); las imágenes grandes pueden superar el límite por imagen del proveedor → fallan como `ocr_provider_error` y quedan en captura manual.
  - Privacidad: el voucher contiene DNI, teléfono y nombres de terceros. Se envía solo el contenido del archivo, nunca el order id ni el nombre de cuenta; bucket privado; no se registra contenido. Requiere aceptar el contrato de tratamiento de datos del proveedor
    (retención cero / sin entrenamiento) y aviso en la política de privacidad (Ley 29733).
- **Fallback manual intacto**: sin proveedor, o ante cualquier error, la revisión/captura manual funciona igual. Tests (sin red, credenciales ficticias): 28 en `ocr/`.

### Qué necesitamos para dejar el OCR READY
1. Decidir proveedor (el adaptador implementado habla con la API de Anthropic Messages; otro proveedor = un adaptador más, ~1 archivo).
2. Una API key propia de producción (cuenta/billing/DPA) como variable de entorno del servidor — no se creó ni se pidió aquí.
3. Prueba de precisión con 30–50 vouchers reales (sin salir de nuestro entorno) para fijar umbrales de revisión; el costo esperado es del orden de centavos de dólar por voucher (validar en el piloto).
4. Aprobación de privacidad del tratamiento (punto anterior).

## 4. Riesgos
- Mensajes de plantilla: rechazo de Meta por redacción (mitigación: texto utilitario, sin promoción, ejemplos reales).
- 56 % de vouchers con campos dudosos: el OCR reduce, no elimina, la captura manual.
- Instrucciones de pago aún sin cargar: sin ellas no sale el aviso de llegada con saldo.
- Cliente con conversación en ambos números (sección 5).

## 5. Coexistencia del número viejo (diseño, nada ejecutado)

Hechos técnicos: en WACRM hay **una** configuración WhatsApp por cuenta (`UNIQUE(account_id)` y `UNIQUE(phone_number_id)`) y una conversación por contacto y cuenta. El número viejo sigue conectado al `whatsapp-webhook` de InkaClick,
por lo que **sus respuestas entrantes siguen llegando a InkaClick y no a WACRM**. No se mueve ningún número, WABA ni webhook.

- **Criterio "conversación/pedido histórico"**: pedido creado antes de `order_payment_settings.activated_at` de la cuenta (sin fila en `order_financials`) y/o presente en InkaClick sin estado final. Todo lo demás es pedido WACRM.
- **Regla de envío**: WACRM comunica solo pedidos nuevos, desde +51 980 942 247. Los históricos no reciben nada automático de WACRM (ya garantizado por `not_tracked`) y se atienden por el número viejo/InkaClick.
- **Respuestas al número viejo**: continúan en InkaClick (que sigue activo) y las atiende el equipo allí. Mientras dure el drenaje no hay reenvío automático a WACRM (exigiría una segunda config por cuenta: cambio de esquema fuera de este alcance).
- **Cliente en ambos números**: puede tener un pedido histórico (número viejo) y uno nuevo (número nuevo). Se verá como dos conversaciones en sistemas distintos. Mitigación operativa: el equipo consulta ambos hasta el retiro; el primer mensaje de WACRM a un cliente conocido
  identifica el pedido por producto/destino. Riesgo residual: respuesta del cliente al número equivocado → se atiende en el sistema donde llegue.
- **Período de drenaje y criterio de retiro** (retiro = cutover separado posterior). Línea base medida hoy en InkaClick (solo agregados): ~4,074 mensajes entrantes y ~665 conversaciones distintas en 7 días; 5,719 vouchers en `en_logistica`, 871 `confirmado`, 495 `entregado`.
  Se puede retirar el número viejo cuando se cumplan **todas**: (1) 0 pedidos históricos abiertos que dependan de InkaClick (o una decisión explícita de cerrarlos); (2) conversaciones entrantes del número viejo < 5 % de la línea base (< ~35 en 7 días) y luego 30 días consecutivos sin respuestas de clientes con pedido abierto;
  (3) mensaje de cambio de número enviado a clientes activos con plantilla aprobada y sin quejas pendientes; (4) respaldo de las conversaciones históricas.
- Antes del retiro: decidir qué hace el número viejo (mensaje de redirección, número en espera). Fuera de este alcance.

## 6. Pendientes P0 tras esta fase
Aprobar los textos de §1 y crear las 3 plantillas; cargar `customer_payment_instructions` (autorización específica); decidir proveedor OCR + key + prueba con muestras + privacidad; cargar configuración por cuenta tras la aprobación de Meta;
plan operativo del número viejo (drenaje); deploy controlado de las 2 migraciones P0; rotación del CRON_SECRET de InkaClick (seguridad, separada).
