# OCR de vouchers: auditoría del provider y plan de prueba controlada (NO ejecutado)

Base `847030e` + cambios locales de preparación. Nada se envió a ningún proveedor; no hay ninguna variable `ORDER_OCR_*` ni en local ni en producción (verificado).

## 1. Provider actual (`vision_llm`)

- Archivo: `src/lib/orders/logistics/ocr/vision-provider.ts`; se registra solo en `resolveOcrProvider` (`providers.ts`).
- Activación: `ORDER_OCR_PROVIDER=vision_llm` **y** `ORDER_OCR_API_KEY` **y** `ORDER_OCR_MODEL` (opcional `ORDER_OCR_BASE_URL`, por defecto `https://api.anthropic.com`). Falta cualquiera → `not_configured`.
- Request: `POST {base}/v1/messages`, cabeceras `x-api-key` y `anthropic-version`, el archivo en base64 (PDF como bloque `document`; JPEG/PNG/WebP como bloque `image`) + una instrucción. Sin SDK; sin temperatura fijada (se omite para no depender del modelo).
- Formatos: PDF, JPEG, PNG, WebP (los que ya admite PR-04). Tamaño: máximo 8 MB por archivo (límite WACRM); **imágenes > 5 MB no se envían** (límite del proveedor) → `ocr_unreadable` → revisión manual. Presupuesto de tiempo: 30 s por intento (aborta → `ocr_timeout`).
- Respuesta esperada (JSON): `{"fields": {<campo>: {"value": string|null, "confidence": 0..1}}, "doubtful": [<campo>...]}`.
- Campos extraídos (solo los que WACRM usa): `customer_name`, `dni`, `phone` (destinatario), `amount`, `shalom_number`, `shalom_code`, `destination`. Cualquier otro nombre se descarta.
- Confidence: reportada por el modelo (0–1, **auto-reportada**: no está calibrada). Valor null ⇒ 0; campos en `doubtful` ⇒ máximo 0.5; luego `normalizeOcrOutput` recorta a 0..1.
- Errores (solo códigos, sin texto del proveedor ni contenido): 429 → `ocr_rate_limited`; otros HTTP/red → `ocr_provider_error`; abort → `ocr_timeout`; no JSON / sin `fields` → `ocr_invalid_response`; rechazo del modelo, nada legible o imagen > 5 MB → `ocr_unreadable`.
- Tratamiento por tipo: PDF completo como documento (el proveedor lee texto y visual); JPEG/PNG/WebP como imagen.

## 2. Privacidad: qué datos de terceros saldrían

Se envía **el archivo completo del voucher** (el bytes del PDF/imagen) + el texto fijo de instrucciones. No se envía order id, cuenta, contacto, conversación, ruta de storage ni el número de WhatsApp.

| Dato en el archivo | Titular | Clasificación | ¿Lo pedimos/guardamos? |
| --- | --- | --- | --- |
| Nombre del destinatario | Cliente (tercero) | Personal | Sí (`customer_name`) |
| DNI del destinatario | Cliente | Personal, **alto riesgo** (identificador nacional) | Sí (`dni`, necesario para el matching) |
| Teléfono del destinatario | Cliente | Personal | Sí (`phone`) |
| Monto a pagar | Operación | Bajo | Sí (`amount`) |
| N.º de orden / código Shalom, destino/origen | Operación | Bajo | Sí (`shalom_*`, `destination`) |
| Remitente (nombre/doc/teléfono), fecha, moneda | La empresa / operación | Personal si el remitente es persona natural | **No** (ya no se piden ni se guardan) |
| Imagen/PDF completo | Todos los anteriores | Contiene todo lo anterior, incluido lo no solicitado | Se transmite; no se guarda en el proveedor si hay retención cero (ver abajo) |

Recomendaciones (minimización y cumplimiento):
1. **Base legal y aviso**: tratamiento para ejecutar el envío solicitado por el cliente; actualizar la política de privacidad con el encargado/subencargado y la **transferencia transfronteriza** (Ley 29733 y su reglamento).
2. **Contrato con el proveedor** antes del piloto: términos comerciales de API (sin entrenamiento con datos de la API) y, de ser posible, **retención cero**. Verificar las condiciones vigentes del proveedor; no se asume aquí.
3. **Espacio de trabajo propio** (workspace/proyecto dedicado a WACRM) con límite de gasto y clave exclusiva de OCR; nunca la clave de otro uso.
4. Solo se envían bytes; **nunca registrar** contenido ni valores (los errores ya lo cumplen). El piloto guarda solo métricas.
5. Piloto: usar vouchers de nuestra propia operación, copiados a una carpeta local **fuera del repo**, y borrarlos al terminar. Si el titular de datos no está cubierto, enmascarar el DNI en la copia y medir ese campo aparte con una muestra reducida.
6. Nada de OCR sobre vouchers de otras cuentas; el proveedor se activa por entorno, no por cuenta (decidir si debe ser opt-in por cuenta antes de multi-cuenta).

## 3. Procedimiento del piloto (30–50 vouchers; **no ejecutado**)

1. **Muestra** (40 vouchers, de los últimos 14 días, orden aleatorio): ~20 PDF/impresos limpios, ~12 fotos de celular, ~5 de baja calidad (oscuros, torcidos, tachones), ~3 controles negativos (imágenes que no son vouchers; se espera `ocr_unreadable` o campos vacíos) y 2 duplicados.
2. **Ground truth**: captura manual de los 7 campos por una persona; **doble captura independiente** en 10 vouchers para medir el error humano de referencia. Para el matching, anotar el pedido correcto (`trueOrder`).
3. **Carpeta local** fuera del repo con los archivos + `truth.json` (formato en `pilot-run.test.ts`). Nada de esto entra a git.
4. **Ejecución** (cuando se autorice y haya clave): `pilot-run.test.ts` (omitida por defecto) llama una vez por archivo al mismo provider de producción y escribe `report.json` con **solo métricas y códigos de error**.
5. **Comparar con la captura manual**: `scorePilot` (módulo `pilot-metrics.ts`, probado) compara campo a campo en forma canónica (DNI/teléfono normalizados, monto numérico, nombre como conjunto de palabras).
6. Registrar tiempo por voucher y el gasto total del proveedor (consola de facturación ÷ nº de vouchers) para el costo por voucher.
7. Borrar la carpeta local al cerrar el piloto.

## 4. Métricas

Exactitud por campo; % de campos dudosos; % de vouchers que requieren revisión (dudoso, incorrecto, faltante o intento fallido) y % "limpios"; tiempo medio; errores por código; costo por voucher;
**falsos positivos** = valor incorrecto leído con confianza ≥ umbral (el caso peligroso); tasa de match correcto con el pedido (auto-asociación vs pedido verdadero; auto-asociaciones erróneas deben ser 0).

## 5. Umbrales iniciales recomendados

- **Revisión humana forzada** por campo con confianza < **0.90** (resaltado en la pantalla de revisión).
- **Matching/auto-asociación** (ya en código): DNI **y** teléfono, ambos con confianza ≥ **0.80** y coincidencia exacta con un único pedido `pending_voucher`; si no, queda pendiente de asociación. Con `doubtful` limitado a 0.5 un campo dudoso nunca alimenta el matching.
- **Criterios de aprobación del piloto** (a confirmar tras ver los datos): 0 falsos positivos en DNI, teléfono, n.º Shalom y monto con umbral 0.90; exactitud DNI ≥ 97 %, teléfono ≥ 95 %, n.º Shalom ≥ 98 %, monto ≥ 98 %, nombre ≥ 90 %;
  0 auto-asociaciones erróneas; fallos del proveedor < 5 %; latencia media < 15 s y p95 < 30 s. Con 40 vouchers, 0 fallos solo acota el error real por debajo de ~7 % (95 %): se mantiene la revisión humana de todos los vouchers.
- `sweepThresholds` recorre 0.70–0.95 y muestra falsos positivos vs carga de revisión para ajustar.
- Advertencia: la confianza del modelo es **auto-reportada**; por eso el control real es la comparación con los datos del pedido y la validación humana, no el número.

## 6. Fallback manual (verificado en código y tests)

Ante timeout, error del proveedor, rate limit, respuesta inválida, imagen sobredimensionada, confianza baja o provider no configurado: el intento se **registra como fallido o con campos de baja confianza** y el voucher queda **pendiente de revisión/captura manual**.
Nunca se valida solo: `review` con `validate` es una acción de una persona (Logística/Supervisor); un voucher pendiente de asociación no puede validarse; el OCR es solo una sugerencia. En carga masiva, `ocr_failed` o `low_confidence` ⇒ `pending` (la persona elige el pedido).

## 7. Credencial exacta que hay que conseguir

Una **API key del proveedor de visión (Anthropic)**, creada por WACRM en su propia organización/workspace dedicado (p. ej. "wacrm-ocr"), con límite de gasto mensual, y con los términos de API/retención aceptados.
Se guarda **solo** como `ORDER_OCR_API_KEY` en el entorno del servidor (nunca en git, BD ni chat). Para el piloto, la key va solo en la variable de entorno de la máquina que ejecuta el runner. Además: `ORDER_OCR_MODEL` (id de un modelo con visión; comparar uno económico y uno intermedio durante el piloto).

## 8. Cambios de código hechos en esta preparación (locales, sin red)

1. Minimización: el provider ya **no pide** remitente, fecha ni moneda.
2. Se omite `temperature` (evita fallos 400 en modelos que no aceptan el parámetro).
3. Imágenes > 5 MB no se envían (`ocr_unreadable` → manual).
4. `pilot-metrics.ts` (+ tests) y `pilot-run.test.ts` (runner manual, omitido por defecto).
Tests: 36 en `ocr/`, sin red y con credenciales ficticias.

## 9. Proveedor Gemini (añadido; local, inerte)

- Archivo: `ocr/gemini-provider.ts`. Activación: `ORDER_OCR_PROVIDER=gemini` + `ORDER_OCR_API_KEY` + `ORDER_OCR_MODEL` (opcional `ORDER_OCR_BASE_URL`). `vision_llm` (Anthropic) sigue funcionando igual; sin las tres variables, `not_configured` (manual).
- API nativa: `POST {base}/v1beta/models/{model}:generateContent` (base por defecto `https://generativelanguage.googleapis.com`), autenticación por cabecera `x-goog-api-key` (la key nunca va en la URL ni en el cuerpo).
- Request: `contents[0].parts` = archivo en `inline_data` (PDF/JPEG/PNG/WebP) + prompt fijo; `generationConfig`: `responseMimeType=application/json`, `responseSchema` con los 7 campos **requeridos** + `doubtful_fields`, `maxOutputTokens` 1024.
- Validación estricta: JSON inválido, campo faltante, tipos incorrectos, confianza fuera de 0..1 o respuesta truncada (`MAX_TOKENS`) => `ocr_invalid_response`; bloqueo/seguridad => `ocr_unreadable`; 429 => `ocr_rate_limited`; 400/401/403/404/5xx/red => `ocr_provider_error`; abort => `ocr_timeout`; archivo > 8 MB => no se envía (`ocr_unreadable`). Todos pasan a revisión manual; nunca se valida solo.
- El límite de 5 MB por imagen es de Anthropic y **no aplica** a Gemini (el límite de WACRM, 8 MB, sí: ~10.7 MB en base64, dentro del máximo de la solicitud en línea).
- Modelo: nunca hardcodeado. **No se asume que ningún modelo esté habilitado**: antes del piloto, listar los modelos disponibles con la key (`GET {base}/v1beta/models`, cabecera `x-goog-api-key`, sin mostrar la key) y elegir dos modelos Flash con soporte de imágenes/PDF y salida JSON estructurada.
- Piloto A/B: `ORDER_OCR_PILOT_MODELS="<flash A>,<flash B>"` ejecuta la misma muestra con ambos y compara exactitud, falsos positivos, % limpios, latencia y costo (con `ORDER_OCR_PILOT_PRICE_IN/OUT` en USD por millón de tokens; el provider reporta los tokens usados).
- Privacidad: se envía solo el archivo + el prompt fijo; no se registra contenido; los términos de uso de datos de la API de Gemini (plan de pago vs gratuito) deben revisarse antes de usar vouchers reales: **usar la API de pago/facturación activa**, no el nivel gratuito (en el que los datos pueden usarse para mejorar productos).
