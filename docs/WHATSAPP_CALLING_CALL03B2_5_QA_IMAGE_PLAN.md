# WACRM — CALL-03B2.5: decisión de imagen QA aislada

**21/nov/2026 — Diseño, no autorización de ejecución.** Referencias: [PR #144](https://github.com/AlexisCasas/wacrm/pull/144), [ROOT A2](WHATSAPP_CALLING_CALL03B2_5_VPS_PREFLIGHT_20261121.md).

## Hechos comprobados

- El Dockerfile incorpora en build `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL` y `NEXT_PUBLIC_APP_LOCALE`. La imagen no puede cambiar estos valores de frontend en tiempo de ejecución.
- QA anterior se construyó con el `app.env` de `/opt/apps/call03b2-qa-stack/`: URLs públicas de Supabase y sitio dirigidas a loopback `127.0.0.1:38089`, y clave anon **específica de QA**. No publicar su contenido; el auditor solo informó su longitud. `NEXT_PUBLIC_APP_LOCALE` no existe en ese entorno y Dockerfile usa `en` por defecto.
- El workflow existente `.github/workflows/wacrm-candidate-image.yml` exige el HEAD de `main` y utiliza variables/secrets de **producción**. **Prohibido reutilizarlo para #144**.
- La VPS tiene 7.222 MiB MemAvailable en el corte A2, pero también contiene producción y siete servicios QA. La memoria disponible no obliga a construir allí.
- **Evidencia histórica del túnel:** [`WHATSAPP_CALLING_CALL03_QA_CLOSEOUT.md`](WHATSAPP_CALLING_CALL03_QA_CLOSEOUT.md), líneas 31–33, documenta explícitamente WACRM QA `http://127.0.0.1:38089`, Peer `http://127.0.0.1:38090/peer` y acceso desde el equipo de QA **mediante túnel SSH**. Falta confirmar si ese túnel sigue disponible para las nuevas pruebas; no es necesario rediseñar la arquitectura.
- GitHub Actions CI con variables ficticias ya compiló correctamente el código, pero ese build **no produce una imagen con configuración QA**.

## Distinción técnica: compilar contra loopback no exige tener servidor en GitHub

Un runner externo **puede ejecutar `docker build` con una URL `http://127.0.0.1:38089`**: esta cadena se inyecta al JavaScript y normalmente no requiere que el runner contacte a PostgreSQL/Auth/REST. Esto queda sujeto a que el build no dependa de acceso de red a ese servicio (CI con URLs ficticias es indicio, no prueba de imagen Docker).

En el navegador, por el contrario, `127.0.0.1` refiere al equipo **del probador**. Para acceder desde Firefox/Chromium externo a QA en la VPS, se necesita una ruta local aprobada (p. ej., túnel SSH de 38089/38090 con el mapeo correcto). Sin ella, la imagen puede compilar y el login/API fallar. Confirmar además cookies, URLs permitidas/redirects Auth y que el navegador accede al **mismo origen esperado**.

## Elección técnica recomendada

**Empaquetado externo, exclusivo QA, desde commit exacto del PR #144:**

1. Confirmar primero el **SHA HEAD definitivo** y el mecanismo de acceso del navegador; no fijar un SHA transitorio antes de cerrar código.
2. Preparar un workflow QA independiente con evento y gate de aprobación explícitos (no reutilizar pipeline candidato/main). Como un workflow `workflow_dispatch` nuevo no puede ejecutarse por primera vez desde una rama donde solo existe como Draft sin estar en el default branch, evaluar `pull_request` con gate de etiqueta y entorno QA protegido o integrar primero, de forma separada, un workflow de infraestructura aprobado.
3. Configurar exclusivamente cuatro variables QA de build (URL del endpoint, clave anon/publishable de QA, site URL y locale explícito) mediante un entorno/secret dedicado de Actions. **Nunca** usar `WACRM_NEXT_PUBLIC_*` de producción ni copiar `build-args.env` de producción.
4. Verificar dominios/orígenes: loopback de QA, sin URLs de producción. Tratar la clave anon como pública por diseño del cliente, pero no registrarla en logs, artefactos o manifest; no usar `service_role`.
5. Construir `linux/amd64` con etiqueta `wacrm-app:call03b25-qa-<sha12>` y OCI revision `<sha40>`. Comprobar `docker image inspect` y que configuración pública QA está embebida sin publicar su valor.
6. Exportar solamente `docker save` comprimido, SHA256SUMS y manifest sanitizado (`SOURCE_SHA`, `PLATFORM`, `IMAGE_ID`, fingerprint de configuración QA, `DEPLOYED=false`). Sin `docker push`, sin SSH, sin secret runtime, sin despliegue ni migraciones.
7. Descargar/importar a VPS **solo tras aprobación posterior**, comparar SHA256 y OCI revision; conservar imagen actual como opción de rollback. Realizar migración QA **antes** de iniciar imagen que consulta las columnas nuevas, con respaldo nuevo y restaurabilidad verificada.

### Alternativa si el workflow externo no es viable

Empaquetar en máquina de desarrollo **separada de producción**, con `app.env` QA manejado localmente y validaciones idénticas (SHA, manifest, OCI, checksum), sin reproducirlo en logs ni GitHub. Construir en la VPS compartida es la última opción y requeriría límites CPU/memoria, preflight renovado y autorización operativa separada.

## Información faltante para pasar de diseño a ejecución

| Consulta SOLO LECTURA | Criterio de cierre |
|---|---|
| ¿Sigue operativo el túnel SSH histórico usado por Firefox en QA? | Confirmar el mapeo actual del navegador a 38089 y 38090; REST/Auth/Next se mantienen en loopback, sin exponer puertos públicos |
| ¿`http://127.0.0.1:38089` es exactamente el `SITE_URL` de la sesión QA? ¿Hay redirects o cookies con host distinto? | Origen, redirect allowlist y cookies compatibles, sin mostrar credenciales |
| ¿Se dispone de una vía para cargar las cuatro variables QA en GitHub Actions sin exponer el anon key en chat, logs ni repositorio? | Entorno QA separado y protegido identificado; configuración NO es de producción |
| ¿Qué locale usan las pantallas QA? | Elegir `en` o `es` explícitamente; no depender de fallback accidental |
| ¿Dónde reside la fuente del Compose QA y su mecanismo de image import/rollback? | Procedimiento verificable que no recree db/auth/rest/gw y no altere producción |

**Decisión actual:** `BUILD_QA_DESIGN=PROPOSED_NOT_EXECUTED`; `QA_MUTATIONS=NOT_AUTHORIZED`; `MERGE=NO_GO`. La carrera `accept`/terminación y el token mismo usuario/dos pestañas permanecen abiertas independientemente de este empaquetado.
