# WhatsApp: compatibilidad con las cuentas de mensajería de Meta (`messaging_account_id`)

**Estado:** implementado en una rama, probado en entornos aislados. **No fusionado, no desplegado, sin cambios en producción.**
Este documento es público a propósito: no contiene números de teléfono, identificadores reales de Meta ni de cuentas, ni tokens. Los identificadores reales viven en la custodia operativa privada; aquí se usan marcadores (`<PHONE_NUMBER_ID>`, `<MESSAGING_ACCOUNT_ID>`).

## 1. Por qué

En el nuevo modelo de cuentas de WhatsApp de Meta, la **facturación, las plantillas y las suscripciones a webhooks pertenecen a una cuenta de mensajería**, no al número de teléfono. Cuando el token que envía llega a **más de una** cuenta de mensajería del mismo número (por ejemplo, la del proveedor anterior y la propia), el envío debe **nombrar** la que se factura con `messaging_account_id` en el cuerpo de `POST /<PHONE_NUMBER_ID>/messages`. Sin eso, Meta puede cobrar a una cuenta que nadie eligió o rechazar el envío.

- Hoy es opcional; Meta lo hace obligatorio para esos casos en las versiones nuevas de la API (primera mitad de 2027) y en todas (2028).
- `paid_messaging_account_id` es un alias que Meta planea retirar; este cambio usa solo `messaging_account_id`.

## 2. Tres identificadores distintos (no intercambiables)

| Campo en `whatsapp_config` | Qué es | Para qué se usa en WACRM | Cambia con este PR |
|---|---|---|---|
| `phone_number_id` | El número | Resuelve el webhook entrante a la cuenta de WACRM; destino de `/messages` | No |
| `waba_id` | El nodo de Graph para plantillas y `/subscribed_apps` | CRUD y sincronización de plantillas, suscripción de la app | No |
| `messaging_account_id` (**nuevo**) | La cuenta de mensajería a la que Meta factura el envío | Se envía en cada mensaje saliente **solo si está configurado** | Sí (columna nueva, nula por defecto) |

Reglas:

- Una cuenta conectada por su propia cuenta de mensajería guarda **ese identificador** en `waba_id` y en `messaging_account_id`. Hoy valen lo mismo, pero Meta introducirá otros identificadores de la cuenta de WhatsApp en 2027, por lo que se guardan en columnas separadas y no se sustituye uno por otro.
- El identificador de la cuenta del proveedor anterior **nunca** se guarda en la fila de una cuenta propia: sus plantillas y suscripciones son las de ese proveedor.
- Verificado solo con lecturas contra Graph: las aristas `phone_numbers`, `message_templates` y `subscribed_apps` responden sobre la cuenta de mensajería nueva y sobre la WABA anterior por separado, con listas independientes de aplicaciones suscritas y de plantillas. El enrutamiento del webhook entrante usa `phone_number_id` primero (`webhook-tenant-secret.ts`); el identificador de la WABA solo decide en eventos sin número, como los de plantillas.

## 3. Cambios de código

| Archivo | Cambio |
|---|---|
| `supabase/migrations/20261103000000_whatsapp_config_messaging_account_id.sql` | Columna `messaging_account_id TEXT` nula + `CHECK` de 5 a 25 dígitos (`NOT VALID` y luego `VALIDATE`). Aditiva e idempotente, en **una transacción**: `lock_timeout` 5 s, `statement_timeout` 30 s y una comprobación interna de que ninguna fila existente cambió (si falla, se deshace sola) |
| `src/lib/whatsapp/meta-api.ts` | `messagingAccountField()` y `MESSAGING_ACCOUNT_ID_PATTERN`; parámetro `messagingAccountId` en los seis envíos: texto, multimedia y audio, plantilla, reacción, botones y lista |
| `send-message.ts`, `flows/meta-send.ts` (texto, multimedia, botones, lista), `automations/meta-send.ts`, `broadcast-core.ts`, `broadcast-resume.ts`, `broadcast/route.ts`, `react/route.ts` | Pasan `config.messaging_account_id` a cada envío. `react/route.ts` lo añade a su `select` explícito |
| `src/app/api/whatsapp/config/route.ts` | Campo opcional validado `messaging_account_id`; modo `prepare_only` (fila nueva = `disconnected`); el `GET` devuelve el identificador y `receiving_enabled` |
| `settings-overview.tsx`, `whatsapp-tile-state.ts`, `whatsapp-config.tsx`, `messages/{es,en}.json` | Distinguen «credenciales válidas» de «recepción habilitada»; las cuentas que ya reciben no cambian |
| `src/types/index.ts` | Campo en `WhatsAppConfig` |

Garantías:

1. **Solo se envía si está configurado.** Con `null`, vacío o ausente, el payload es **byte a byte el de antes**. Las cuentas existentes no cambian de comportamiento.
2. **Un valor malformado detiene el envío**, en vez de omitirse en silencio: omitirlo dejaría a Meta facturar a una cuenta no elegida.
3. El valor son solo dígitos (en la base y en el código), porque se copia a un cuerpo de petición.
4. No viaja ni en la URL ni en las cabeceras.

### `/api/whatsapp/config`: preparar sin registrar ni suscribir

- `messaging_account_id`: `undefined` no toca el valor guardado; `null` o `''` lo borra; otro valor debe ser de 5 a 25 dígitos o responde 400.
- `prepare_only: true` (solo el booleano `true`): verifica el token con Meta (solo lectura), cifra y guarda, y **no** llama a `/register` ni a `/subscribed_apps`; no reescribe `registered_at` ni `subscribed_apps_at`. No se admite junto con un PIN. La respuesta incluye `prepared_only: true`, `registration_skipped: true` y `receiving_enabled: false`.
- **Una cuenta preparada no parece operativa.** Una fila **nueva** guardada con `prepare_only` queda `status = 'disconnected'` y `connected_at = NULL`; una fila **existente** conserva su estado (preparar credenciales nuevas nunca apaga una cuenta que funciona). El `GET` distingue dos hechos: `connected` (Meta acepta el token, semántica de siempre) y **`receiving_enabled`** (`status = 'connected'`). Los ajustes muestran «Credenciales válidas — recepción no habilitada» y el resumen «Credenciales válidas · recepción sin habilitar» en lugar de «Conectado». Un guardado real posterior (sin `prepare_only`) o `activate-account.sql` es la activación. Las cuentas actuales (`status = 'connected'`) y una API que no envíe el campo se comportan como siempre.
- Alcance: `receiving_enabled` informa de la recepción; **no bloquea envíos** (las cuentas con credenciales válidas siempre han podido enviar). Mientras una cuenta esté preparada, no debe usarse para enviar: es parte de la secuencia de conexión (sección 9).
- Sin `prepare_only`, el guardado normal queda **igual que antes** (registro con PIN y suscripción), probado con regresión.
- Aislamiento: se mantiene el rechazo 409 si el número pertenece a otra cuenta.

Nota operativa: guardar la configuración desde la pantalla **suscribe la aplicación** a la cuenta de mensajería. Para conectar una cuenta sin suscribir, usar `scripts/ops/messaging-account/connect-account.sql` (sección 8).

## 4. Pruebas

| # | Control | Resultado |
|---|---|---|
| 1 | Suite completa (`vitest`) | **PASS** (ver el PR para el recuento final) |
| 2 | Forma exacta del payload de los seis envíos (con identificador, sin él, nulo, vacío, malformado) | **PASS** `messaging-account.test.ts` |
| 3 | Todos los llamadores pasan `messagingAccountId` (guarda estática: ningún envío nuevo puede olvidarlo) | **PASS** `messaging-account-wiring.test.ts` |
| 4 | Ruta manual/API: el identificador llega a texto, imagen, audio, plantilla, botones y lista; sin él, no llega nada | **PASS** `send-message.test.ts` |
| 5 | `/api/whatsapp/config`: `prepare_only`, validación, aislamiento, regresión del guardado normal, sin secretos en la respuesta | **PASS** `route.messaging-account.test.ts` (y las 11 pruebas previas de la ruta siguen en verde) |
| 6 | Mutaciones: quitar el parámetro de un llamador, de un payload, aceptar valores malformados, suscribir en `prepare_only`, reescribir `subscribed_apps_at` | Detectadas |
| 7 | Migración en Postgres desechable con el esquema real (sin red, datos sintéticos): aplica, es idempotente (también con valores en la columna), `CHECK`, filas existentes idénticas salvo la columna nueva; `lock_timeout`/`statement_timeout` efectivos; con una tabla bloqueada **desiste en ~5 s sin dejar nada**; una variante que altere una fila se deshace sola | **PASS** `scripts/qa/messaging-account/run.sh` (88 comprobaciones) |
| 8 | Conexión (fila preparada, `disconnected`), activación y desconexión protegidas: guardas de rechazo, exactamente una fila, ninguna otra fila cambia, rollback exacto, RLS de la columna | **PASS** (mismo script) |
| 9 | Rollback del esquema y reaplicación | **PASS** (mismo script) |
| 10 | ESLint de los archivos tocados y tipado de `src` | **PASS** |
| 11 | Compilación completa (`docker build`: compila y pasa el tipado de Next), repetida sobre el HEAD final | **PASS** (imagen de prueba ya eliminada) |

Probado con mutaciones también en los scripts SQL (quitar la guarda de «la cuenta ya tiene configuración» o la de «es la configuración que creamos» hace fallar la QA).

## 5. Riesgos

| Riesgo | Mitigación |
|---|---|
| Aplicar el código antes que la migración: `react/route.ts` y el `GET` de configuración seleccionan la columna | **Migrar primero, desplegar después** (sección 7) |
| Enviar desde una cuenta con acceso a dos cuentas de mensajería sin identificador | Es el caso que este PR resuelve; no hacer ninguna prueba de envío con esa cuenta hasta que el PR esté desplegado y la fila tenga el identificador |
| Identificador equivocado en la fila | El `CHECK` solo garantiza el formato; confirmar el valor contra Graph (lectura) antes de conectar |
| Pegar el token en la interfaz | Usar el cifrado dentro del contenedor (sección 8); el token no pasa por el chat ni por la línea de comandos |
| La API de Meta cambia (obligatoriedad futura) | El parámetro ya se envía cuando existe; revisar al subir de versión de Graph |

## 6. Lo que este PR NO hace

No conecta ninguna cuenta, no suscribe ni desuscribe aplicaciones, no envía mensajes, no cambia flows ni automatizaciones, no toca la base de producción y no modifica las filas existentes de `whatsapp_config`.

## 7. Despliegue técnico (requiere autorización expresa)

Todo en este orden. Detenerse y revertir ante cualquier fallo.

1. **Preflight**: `main` incluye el PR; contenedor `app` healthy; copia de seguridad cifrada de la base y de `.env.local` (mismo procedimiento que `ORDER-HISTORY-PANEL-DEPLOY-PLAN.md`, sección 3). Anotar la imagen en ejecución y guardarla con `docker save` (la limpieza programada de imágenes borra las de más de 24 h sin uso).
2. **Migración primero** (aditiva; una transacción con `lock_timeout` 5 s y `statement_timeout` 30 s; no mueve datos):
   ```bash
   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/20261103000000_whatsapp_config_messaging_account_id.sql
   ```
   Si otra sesión retiene la tabla, la migración **desiste a los 5 s sin cambiar nada**: reintentar cuando no haya carga, nunca subir el timeout. Verificar: la columna y la restricción existen, la columna es nula en todas las filas, las filas existentes son idénticas (huella previa/posterior) y la aplicación actual sigue sana (no la lee).
3. **Imagen** construida desde `main` fusionado, con las mismas `NEXT_PUBLIC_*` que la actual; `docker build` debe terminar sin errores (incluye el tipado de Next).
4. **Recrear solo `app`** (`up -d --no-deps app`) con los mismos ficheros compose que lee el contenedor.
5. **Verificación**: contenedor healthy sin reinicios; sin errores en los logs; `/login` responde; una cuenta con configuración existente **sigue enviando igual** (comprobar con una respuesta real de un agente o con el payload en logs de prueba, nunca imprimiendo tokens); los cron de pedidos y los demás siguen escribiendo `OK`.

## 8. Rollback

- **Código**: recrear `app` con la imagen guardada. El código anterior no lee la columna, así que la columna puede quedarse. No hay nada que deshacer en datos.
- **Esquema** (opcional): `scripts/ops/messaging-account/rollback-column.sql`. **Se niega a ejecutarse** mientras alguna configuración use la columna.
- **Fila conectada** (cuando exista una): primero desuscribir la aplicación en Meta, después `scripts/ops/messaging-account/disconnect-account.sql` con `confirm_unsubscribed=yes`; borra únicamente la fila que creó `connect-account.sql`, y solo si coincide el número y el identificador.

## 9. Conexión de una cuenta con su propia cuenta de mensajería (separada de este PR)

Cada punto requiere autorización expresa, después del despliegue técnico:

1. Token propio para la cuenta (mismo usuario de sistema y misma aplicación, sin revocar el existente), cifrado con `scripts/ops/messaging-account/encrypt-secret.js` **dentro del contenedor**; nunca por chat.
2. Respaldo cifrado + ensayo en base desechable.
3. Inserción protegida con `connect-account.sql`: una sola fila **preparada** (`status = 'disconnected'`, `registered_at`, `subscribed_apps_at` y `connected_at` nulos); no se llama a Meta; no parece operativa en Ajustes.
4. Pausa controlada de los flows de la cuenta antes de suscribir (todos los socios del número reciben cada mensaje entrante y Meta no enruta conversaciones).
5. Suscripción de la aplicación a la cuenta de mensajería; prueba entrante; después `activate-account.sql` (`confirm_subscribed=yes`) registra el estado en WACRM (solo acepta una fila preparada).
6. Prueba saliente con un mensaje de plantilla y comprobación de que el cargo cae en la cuenta de mensajería propia.
7. Corte; retirar al proveedor anterior en último lugar.

## 10. Diagnóstico de registro: registro previo en Meta frente a registro de WACRM

`registered_at` es la hora real en que **WACRM** ejecutó `POST /register`. Un número que ya estaba registrado en Meta antes de usarse en WACRM (por ejemplo, con el proveedor anterior) conserva `registered_at` nulo: **no se inventa una fecha**. El diagnóstico lo distingue:

| `registration_source` | Significado | Cuándo | ¿Operativo? |
|---|---|---|---|
| `wacrm` | WACRM registró el número | `registered_at` informado | Sí, si Meta responde y hay app suscrita (igual que siempre) |
| `meta_prior` | Registrado en Meta antes de WACRM | `registered_at` nulo **y** Meta confirma `CONNECTED` **y** la app está suscrita **y** la cuenta está activada (`status = 'connected'` con `subscribed_apps_at`) | Sí |
| `none` | Ninguno | cualquier otro caso (incluida una cuenta preparada) | No |

- `GET /api/whatsapp/config/verify-registration` (solo lectura) devuelve `registration_source` y el nuevo `checks.meta_confirms_connected`; `registered_at` nunca se modifica.
- Ajustes muestra tres textos distintos: «Registrado — Meta enviará eventos» (WACRM), «Registrado previamente en Meta — operativo (el registro no lo hizo wacrm)» y, mientras no se verifique, «Sin registro local — verifica con Meta» en lugar de «Meta no enviará eventos».
- Lorteg y Alexis Test (con `registered_at`) se comportan exactamente igual.
- Corrige además un fallo previo: tras pulsar «Verificar con Meta», la recarga de la configuración borraba el resultado del diagnóstico.
