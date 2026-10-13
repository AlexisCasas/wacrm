# QA funcional manual: guardado seguro de flujos (Fase 3)

Entorno **sintético y aislado**: cuentas inventadas, sin Meta, sin datos de clientes, sin acceso a producción. Los contenedores
de backend viven en una red Docker `--internal` (sin salida a internet). Lo único accesible es el puerto `127.0.0.1:38088` de la VPS.

## 1. Levantar y abrir

En la VPS (desde `/opt/apps/wacrm-flows-safe-save`):

```bash
qa/flows-safe-save/staging/build-app.sh     # compila la app con la URL de staging (necesita internet una vez, por las fuentes)
qa/flows-safe-save/staging/up.sh            # base de datos + auth + API + app, con 2 cuentas sintéticas
```

En **tu PC** abre un túnel y luego el navegador:

```bash
ssh -L 38088:127.0.0.1:38088 <usuario>@<vps>
# navegador: http://localhost:38088
```

Credenciales sintéticas (solo existen en este staging): correos `owner@pilot-staging.test` (cuenta A, la "empresa de prueba")
y `owner@other-staging.test` (cuenta B, otra empresa). La contraseña está en
`.qa-staging/env` **del worktree desde el que se levantó el staging** (variable `USER_PASSWORD`). Cada worktree genera sus
propios secretos: usar el archivo de otro worktree da `400 Invalid login credentials`. Para saber cuál es el vigente:
`docker inspect f3-stg-app --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' | head -3` (el directorio raíz que aparece es el worktree).

Apagar y limpiar: `qa/flows-safe-save/staging/down.sh` (borra contenedores y redes; `.qa-staging/` guarda solo secretos sintéticos).

## 2. Provocar y quitar el fallo de persistencia (solo QA)

```bash
qa/flows-safe-save/staging/fault.sh on     # TODO insert en flow_nodes falla dentro de la base de datos de staging
qa/flows-safe-save/staging/fault.sh off    # lo quita
```

Es un trigger creado a mano en el contenedor de staging: no existe en ninguna migración ni es alcanzable desde la app.

Ver el estado real de un flujo en la base de datos:

```bash
docker exec f3-stg-db psql -U supabase_admin -h /var/run/postgresql -d postgres -c \
 "select f.name, f.status, f.updated_at, (select count(*) from flow_nodes n where n.flow_id=f.id) nodos from flows f order by f.created_at desc limit 5"
```

## 3. Casos (marca PASS / FAIL)

Entra como cuenta A. Idioma de la interfaz: inglés.

| ID | Pasos | Resultado esperado |
|---|---|---|
| F3-01 | Flows → **New flow** → **Create blank flow** con nombre "QA manual 1" | Abre el editor; insignia **Draft**. En la base de datos existe con `status = draft` |
| F3-02 | Pestaña **List** → **Add node**: Start, Send message, End. Trigger: palabras clave `hola`. Conecta con *Advances to*: start → send_message → end. Escribe un texto. **Save** | Mensaje "Saved."; la insignia **Edited** desaparece; 3 nodos y sus conexiones en la base de datos |
| F3-03 | Cambia nombre y texto. **Save**. Recarga la página (F5) | El editor muestra los cambios tras recargar |
| F3-04 | `fault.sh on`. Cambia nombre y texto. **Save** | Error visible. En la base de datos el flujo **sigue exactamente igual** que en F3-03 (mismo nombre, mismos 3 nodos, mismo `updated_at`) |
| F3-05 | (Mismo intento de F3-04) | Un solo mensaje de error ("Could not save flow"); sin "Saved."; la insignia **Edited** sigue; tus cambios siguen en pantalla |
| F3-06 | Con el fallo activo pulsa **Activate** | Error de guardado; en la pestaña Network de DevTools **no hay** `POST /api/flows/<id>/activate`; sigue **Draft** |
| F3-05b/06b | `fault.sh off`. En DevTools → Network, clic derecho en una petición `PUT /api/flows/<id>` → *Block request URL*; pulsa **Save** y luego **Activate** | Error mostrado, cambios pendientes, ningún `/activate`, base de datos sin cambios. Quita el bloqueo |
| F3-07 | Sin el fallo ni bloqueo pulsa **Save** otra vez | "Saved."; la insignia **Edited** desaparece; la base de datos tiene tus últimos cambios |
| F3-08 | Menú de usuario → **Sign out**; entra de nuevo; abre el flujo | Conserva todos los cambios guardados |
| F3-09 | Revisa la insignia y la base de datos | Sigue **Draft**; ningún flujo `active`; sin ejecuciones (`flow_runs`) |
| F3-10 | Con la cuenta A en la consola del navegador: `fetch('/api/flows/<id de la otra empresa>', {method:'PUT', headers:{'content-type':'application/json'}, body:'{"name":"X"}'}).then(r=>r.status)` (el id sale de `select id from flows where name like 'OTHER%'`) | `404`; el flujo "OTHER COMPANY FLOW" no cambia y no aparece en la lista de A. Entrando como B sí aparece |

## 4. Automatización equivalente

Una sola vez, para la versión automática (no para la manual): `mkdir -p qa/flows-safe-save/staging/pw && cd qa/flows-safe-save/staging/pw && npm init -y && npm i playwright-core@1.49.1` y `docker pull mcr.microsoft.com/playwright:v1.49.1-noble` (herramientas de QA; el navegador corre dentro del contenedor de la app).

`qa/flows-safe-save/staging/run-f3.sh` ejecuta estos mismos casos en un Chromium real dentro de la red aislada y deja capturas en
`qa/flows-safe-save/staging/shots/`. Resultado de la última ejecución: F3-01 a F3-10b en PASS. Los casos manuales anteriores siguen
**pendientes de validación humana** hasta que alguien los marque.
