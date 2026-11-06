# Instructivo: cuenta de servicio y hoja QA (paso a paso)

Quién: el titular de la cuenta de Google que es dueña de la hoja. **Las credenciales nunca se pegan en el chat, en GitHub, en tickets ni en archivos del repositorio.** Yo (Claude) no las pido ni las veo: el archivo de clave se queda en el servidor.

## A. Crear el proyecto y habilitar la API
1. Entra a <https://console.cloud.google.com/> con la cuenta dueña de la hoja.
2. Arriba, selector de proyecto → **Proyecto nuevo** → nombre `whatscrm-sheets` → Crear. (Si ya tienes un proyecto dedicado, úsalo; no uses uno compartido con otros sistemas.)
3. Menú ☰ → **APIs y servicios** → **Biblioteca** → busca **Google Sheets API** → **Habilitar**. (No hace falta habilitar Drive API.)

## B. Crear la cuenta de servicio (sin permisos de proyecto)
1. ☰ → **IAM y administración** → **Cuentas de servicio** → **Crear cuenta de servicio**.
2. Nombre: `whatscrm-sheets-export`. Descripción: `Escritura de pedidos en Google Sheets`. → Crear y continuar.
3. En «Otorgar acceso a esta cuenta de servicio al proyecto»: **no asignes ningún rol**. → Continuar → Listo.
4. Abre la cuenta creada y copia su **correo** (`...@whatscrm-sheets.iam.gserviceaccount.com`). Ese correo no es secreto; es lo que se comparte en la hoja.

## C. Crear la clave (el único secreto)
1. En la cuenta de servicio → pestaña **Claves** → **Agregar clave** → **Crear clave nueva** → **JSON** → Crear. Se descarga un archivo `.json`.
2. Si la consola dice que la creación de claves está bloqueada, es la política de organización `iam.disableServiceAccountKeyCreation`; la debe levantar un administrador de la organización para este proyecto.
3. **Súbelo al servidor por un canal seguro** (por ejemplo `scp` a un directorio con permisos `600`, fuera del repositorio) y bórralo de tu equipo y de Descargas después. No lo mandes por correo, chat ni GitHub.
4. En el servidor, codifica solo el campo `private_key` en base64 y guárdalo en el entorno (nunca en Git):
   ```bash
   # el valor resultante va a GOOGLE_SHEETS_SA_KEY_B64 en el archivo de entorno del servidor (permisos 600)
   python3 -c "import json,base64,sys;print(base64.b64encode(json.load(open(sys.argv[1]))['private_key'].encode()).decode())" /ruta/segura/clave.json
   ```
   Variables: `GOOGLE_SHEETS_SA_EMAIL=<correo de la cuenta de servicio>` y `GOOGLE_SHEETS_SA_KEY_B64=<salida anterior>`. Para la prueba QA basta exportarlas en la sesión de shell donde correrá la prueba; para producción irían al `.env` del servidor y la activación se autoriza aparte.

## D. Compartir **solo** la hoja QA
1. Abre la hoja QA **limpia y dedicada a esta corrida** («QA - WhatsCRM Registro de pedidos Keyler (corrida API real, limpia)»): <https://docs.google.com/spreadsheets/d/11VTllvKJdult1b3GjZ6_h2SM9am2qO_nawWERBIjDhI/edit>. Contiene solo los encabezados y las fórmulas, sin filas de corridas anteriores; la primera hoja QA (con filas de ensayos previos) no se usa para esta prueba.
2. **Compartir** → pega el correo de la cuenta de servicio → rol **Editor** → desmarca «Notificar» → Compartir.
3. No compartas carpetas ni otros archivos. La cuenta de servicio solo ve lo que se le comparte explícitamente.
4. La hoja definitiva (más adelante) será un archivo distinto y exclusivo de Keyler, también compartido solo con ese correo; la base de datos impide apuntar dos cuentas al mismo archivo.

## E. Ejecutar la prueba real (datos solo sintéticos)
Desde una copia del repositorio con `node_modules`, en el servidor o equipo de confianza:
```bash
export GOOGLE_SHEETS_SA_EMAIL='...'            # correo de la cuenta de servicio
export GOOGLE_SHEETS_SA_KEY_B64='...'          # no lo pegues en ningún chat
export QA_SHEET_ID='11VTllvKJdult1b3GjZ6_h2SM9am2qO_nawWERBIjDhI'
QA_REAL_API=1 QA_REAL_API_OUT=/tmp/real-api-report.json npx vitest run src/lib/orders/sheets/real-api.integration.test.ts
```
La prueba valida: encabezados, escritura, lectura, re-ejecución idempotente, escritura ambigua con reintento sin duplicados y conciliación por huella. El escenario completo escribe **5 filas sintéticas de 4 pedidos** en «Registro de pedidos»: 3 pedidos / 4 líneas con escritura normal y 1 pedido / 1 línea con la simulación de respuesta perdida (escritura ambigua). Totales esperados: 4 pedidos, 5 líneas, 8 unidades, S/ 495,00. La hoja ya trae esos valores en la columna «Base de datos» de «Control de conciliación», de modo que tras la corrida debe mostrar «Sin diferencias» (antes de la corrida muestra «HAY DIFERENCIAS», porque la hoja está vacía). El informe (`QA_REAL_API_OUT`) solo contiene nombres de pasos y contadores. Si hay que repetir la corrida, se repiten las 5 filas con otros identificadores; para repetirla limpia, borra `A2:AA` de «Registro de pedidos» y vuelve a ejecutar.

## F. Rotación y revocación
- Rotar: crear una clave nueva, actualizar `GOOGLE_SHEETS_SA_KEY_B64`, borrar la clave antigua en la consola.
- Revocar al instante: quitar el correo de la lista de «Compartir» de la hoja, o **Deshabilitar** la cuenta de servicio. El export falla con `forbidden`, reintenta con espera y termina en `dead` (sin afectar pedidos).
