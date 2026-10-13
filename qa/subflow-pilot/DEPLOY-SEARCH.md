# Despliegue mínimo: buscador de «Ejecutar otro flujo» (sobre el piloto ya desplegado)

Solo cambia la interfaz: **sin migraciones, sin cambios en `.env.local`, sin cambios de flag**. Parte de la imagen
`wacrm-app:p4-candidate-e9c4538d4325` (en producción).

1. Imagen inmutable desde un contexto limpio del commit exacto (mismo `Dockerfile`, mismos `NEXT_PUBLIC_*` de producción):
   ```bash
   SHA=$(git -C /opt/apps/wacrm-subflow-search rev-parse HEAD); CTX=/tmp/p5-ctx-${SHA:0:12}; rm -rf $CTX; mkdir -p $CTX
   git -C /opt/apps/wacrm-subflow-search archive HEAD | tar -x -C $CTX
   # reutilizar el mismo script de build del piloto (/tmp/claude-0/p4-build.sh) cambiando la etiqueta a wacrm-app:p5-candidate-${SHA:0:12}
   ```
2. Verificar etiqueta de revisión = `$SHA` y que el bundle contiene `flow-picker` (`docker run --rm --entrypoint sh <img> -c 'grep -rl "Search flows by name" .next/server | head -1'`).
3. Backup de configuración (no hay cambios de BD): `install -m 600 /opt/apps/wacrm/.env.local /opt/backups/wacrm/env_pre_p5_$(date -u +%Y%m%d_%H%M%S).env`.
4. `/opt/apps/wacrm/docker-compose.p5.yml` (igual que `docker-compose.p4.yml` con la imagen nueva) y:
   `docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.p5.yml up -d app`.
5. Comprobar: `healthy`, `/login` 200, 243 borradores de Pilot y flujos activos de las otras cuentas iguales a la línea base,
   sin errores nuevos en `docker logs wacrm-app-1`.
6. **Rollback** (segundos, sin tocar datos): `... -f docker-compose.p4.yml up -d app`.
