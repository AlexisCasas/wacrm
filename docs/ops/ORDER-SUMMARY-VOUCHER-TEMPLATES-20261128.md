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

👇👇👇👇

Aquí te compartimos los datos de envío para que puedas hacer el seguimiento:

Número de orden: {{9}}
Código: {{10}}

👇👇👇👇
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
9. número de orden Shalom validado
10. código Shalom validado

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

El candidato V2 ya incorpora conversión PDF→imagen para el voucher: Poppler (`pdftoppm`) renderiza solo la primera página a JPG dentro del runtime, sin modificar el PDF original. La imagen derivada queda en el bucket privado y Meta recibe una URL firmada temporal.

La migración nueva es aditiva y NO debe aplicarse hasta que el candidato completo pase auditoría, tests, build y QA.


## Estado V2 sobre producción actual

Base productiva incluida:
- commit: `186d388a76bdb3b824ee508fa1860a8bb1852a8e`
- imagen: `wacrm-app:inbox-phone-search-186d388a`
- incluye el fix productivo de búsqueda por celular.

Rama:
`feat/order-summary-voucher-templates-v2-20261128`

Cambios cerrados en V2:
- migración renumerada a `20261205000008_order_customer_templates.sql`;
- permisos de la tabla endurecidos: `authenticated` recibe solo SELECT;
- migración registrada en `migration-manifest.json`;
- doble clic/reintento concurrente serializado con advisory lock;
- errores de red ambiguos (`fetch failed`, timeout, ECONNRESET, etc.) pasan a `uncertain` y no habilitan reenvío automático;
- vouchers imagen se envían directamente;
- vouchers PDF se convierten a JPG (primera página) usando Poppler;
- PDF original permanece intacto;
- ambos botones se habilitan únicamente con voucher validado;
- Comercial/Viewer quedan bloqueados por el resolver de acceso de Logística;
- los envíos no cambian `order_logistics.status` ni usan el ledger de Embalaje.

Pendiente antes de deploy:
1. auditoría final de la V2;
2. tests del render PDF en el contenedor real;
3. typecheck/lint/build;
4. creación y aprobación de las dos plantillas Meta;
5. configuración por cuenta;
6. migration + candidate + dry-run + deploy controlado.


## Auditoría V2 — bloqueos corregidos

Auditoría recibida sobre `a51953d62815b6999b974dc53609ed2e17399bdd`:

- migration, RLS, permisos e idempotencia: PASS;
- resumen: contrato de 10 variables correcto;
- PDF→JPG: funcional con Poppler;
- Docker real: build/health PASS;
- resultado global anterior: BLOCKED por 4 defectos pequeños.

Correcciones aplicadas en `7af97d377144a39adfe887c93c30e7d774a195d1`:

1. Fixtures existentes:
   - `logistics-ui.test.tsx`
   - `evidence-upload-ui.test.tsx`
   - `confirmed-orders-stale-selection.test.tsx`
   ahora incluyen `customer_dispatches: []`.

2. PDF seguro:
   - `pdftoppm` añade `-scale-to 2000`;
   - evita dimensiones absurdas y consumo de memoria descontrolado;
   - sigue renderizando solo la primera página.

3. Dispatch atascado:
   - el panel expone `claimed_at` y `sending_at`;
   - un `claimed/sending` de menos de 10 min sigue bloqueado;
   - después de 10 min el botón vuelve a habilitarse;
   - el siguiente clic hace que el backend lo convierta a `uncertain`;
   - la persona puede resolver `confirmed_sent` / `confirmed_not_sent`.

4. WEBP:
   - JPEG/PNG se firman directamente;
   - PDF se renderiza a JPEG;
   - WEBP falla cerrado con `voucher_image_required` en lugar de enviarse a Meta y fallar después.

Pendiente:
- repetir auditoría/tests completos;
- validar tests permanentes nuevos de Claude o equivalentes;
- typecheck/lint/Docker build;
- si pasa, continuar a Meta setup.


## Último bloqueo UI corregido

Auditoría final sobre `d2348d4e3fb0a700e449dba58f091beaf410ad77`:

- backend, migration, permisos, PDF render, idempotencia, roles y state safety: PASS;
- único bloqueo: `Date.now()` dentro del render de `customer-template-actions.tsx`.

Corrección aplicada en:

`532e0c8a5a17d0dc6bb7256a7594b9805435b702`

Cambio:
- se añadió `nowMs` en estado;
- `useEffect` actualiza el reloj cada 30 s;
- `isStaleInFlight` usa ese estado;
- un envío en `claimed/sending` se habilita solo al superar 10 minutos, sin requerir recarga del panel;
- se añadió test permanente `customer-template-actions.test.tsx` para validar 9:30 min bloqueado → >10 min habilitado.

Pendiente:
- revalidar lint;
- correr el nuevo test;
- suite completa;
- typecheck;
- Docker build;
- si todo pasa: Meta setup.
