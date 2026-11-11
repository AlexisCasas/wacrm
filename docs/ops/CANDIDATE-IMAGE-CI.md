# WACRM — imagen candidata en GitHub Actions (sin VPS)

Este procedimiento prepara un artefacto Docker para un **despliegue posterior y autorizado**. Ejecutarlo **no** modifica la VPS, la base PostgreSQL, Meta, Caddy o los crons.

## Condiciones previas

El workflow manual `.github/workflows/wacrm-candidate-image.yml` exige un SHA completo de 40 caracteres que coincida con el **HEAD de main al iniciar la ejecución**. Si main cambia, el workflow aborta para no generar un artefacto con origen ambiguo.

Configuración del repositorio GitHub, en **Settings → Secrets and variables → Actions**:

| Tipo | Nombre | Contenido |
|---|---|---|
| Variable | `WACRM_NEXT_PUBLIC_SUPABASE_URL` | URL HTTPS pública del Supabase WACRM en producción |
| Secret | `WACRM_NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clave **publicable/anon** del proyecto WACRM (no usar la clave service_role) |
| Variable | `WACRM_NEXT_PUBLIC_SITE_URL` | URL pública usada en la compilación productiva anterior; puede estar vacía solo si la anterior también lo estaba |
| Variable | `WACRM_NEXT_PUBLIC_APP_LOCALE` | Locale de producción, normalmente `en` |

Estas son variables de **compilación**. Las variables de servidor (`SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`, `META_APP_SECRET`, etc.) **nunca** deben configurarse en el build workflow ni quedar dentro de la imagen. Se inyectan en runtime por el Compose del servidor.

**Gate:** antes del primer build, cotejar de forma segura los cuatro valores públicos de compilación con los usados para construir la imagen productiva (no asumir que sus variables de runtime siempre son idénticas). Si no hay evidencia del valor original, documentar esa incertidumbre y verificar explícitamente la compatibilidad funcional antes de autorizar un despliegue.

## Ejecución manual

1. Después del merge autorizado de los correctivos de despliegue, verificar que `main` está en el SHA exacto que se quiere desplegar.
2. GitHub → Actions → **WACRM candidate image (manual, artifact only)** → Run workflow, rama `main`, input `release_sha` con los 40 caracteres.
3. Verificar resultado del job `build-candidate` y las marcas `CANDIDATE_PREFLIGHT=PASS`, `CANDIDATE_BUILD=PASS`, `CANDIDATE_ARTIFACT_SHA256=PASS`.
4. Descargar el artefacto `wacrm-candidate-<SHA>` (retención de 7 días). Contiene `wacrm-candidate-image.tar.gz`, `SHA256SUMS`, `manifest.txt`.

El SHA de código aparece en la etiqueta OCI `org.opencontainers.image.revision`. El manifiesto registra además el **ID de imagen Docker**, la arquitectura y una **huella SHA-256 de la configuración pública compilada**, sin copiar sus valores.

## Validaciones exigidas antes de usar la imagen

- Comprobar `sha256sum -c SHA256SUMS` antes de `docker load`; ese `load` necesita autorización separada.
- Comparar ID de imagen cargada, plataforma `linux/amd64` y etiqueta OCI con `manifest.txt`.
- Verificar que la huella de configuración pública corresponde a lo esperado para producción.
- Verificar presencia y paridad del `FLOW_RECOVERY_ACTIVE` efectivo: el nuevo engine es **dry-run** sin `true`. La activación debe decidirse expresamente y la candidata debe confirmarse en runtime, sin imprimir otros secretos.
- Comprobar backup de BD **fresco y verificado**, ensayo del engine Docker real, Caddy y endpoints, y crons. **No aplicar migraciones** solo porque el árbol Git incluya SQL históricos.

## Restricciones

Este workflow **no hace** push a registry, `scp`, `docker load`, `docker compose up`, despliegue, migraciones ni alteraciones del servidor. No es un atajo a los gates de producción. Si faltan variables, falla sin generar una imagen basada en datos falsos.

El script de cron `/opt/apps/wacrm/ops/meta-ads/run-meta-sync.sh` existe solo en el host; antes de versionarlo hay que recuperar su fuente sanitizada, revisar sus permisos y dependencias, y preparar un PR independiente. No reemplazarlo con un script supuesto.
