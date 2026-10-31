#!/usr/bin/env bash
# Verifiable logical backup of the InkaClick Supabase `public` schema BEFORE installing the WACRM receiver. Read-only against the project.
# The DB password is read hidden from the terminal; it is never written to disk, a file, or the process list of the host (only the container env).
# Output: /opt/backups/inkaclick/pre-wacrm-<ts>/{public.dump,fingerprint.txt,restore-list.txt} (dir 700, files 600).
set -euo pipefail
REF=sbbxcunexmjxtzdelypv; HOST=db.$REF.supabase.co; IMG=supabase/postgres:17.6.1.136
TS=$(date -u +%Y%m%dT%H%M%SZ); OUT=/opt/backups/inkaclick/pre-wacrm-$TS
umask 077; mkdir -p "$OUT"; chmod 700 /opt/backups/inkaclick "$OUT"
read -r -s -p "Contrasena de la base de InkaClick (no se muestra): " PGPASSWORD; echo; export PGPASSWORD
run() { docker run --rm --network host -e PGPASSWORD -v "$OUT":/out "$IMG" "$@"; }
CONN="host=$HOST port=5432 dbname=postgres user=postgres sslmode=require"
echo "1/4 conexion..."; run psql "$CONN" -Atc "select current_database(), version()" | cut -c1-80
echo "2/4 volcado (puede tardar un minuto)..."; run pg_dump "$CONN" -Fc -n public -f /out/public.dump
echo "3/4 huella de las filas historicas..."
run psql "$CONN" -Atc "select 'confirmed_orders', count(*), md5(string_agg(md5((to_jsonb(t) - 'external_order_id' - 'departamento')::text), '' order by id)) from confirmed_orders t; select 'customers', count(*), md5(string_agg(md5(to_jsonb(t)::text), '' order by id)) from customers t; select 'vouchers', count(*) from vouchers; select 'whatsapp_conversations', count(*) from whatsapp_conversations; select 'manychat_webhook_events', count(*) from manychat_webhook_events" > "$OUT/fingerprint.txt"
cat "$OUT/fingerprint.txt"
echo "4/4 verificacion del volcado..."; run pg_restore -l /out/public.dump > "$OUT/restore-list.txt"
echo "entradas en el volcado: $(grep -c . "$OUT/restore-list.txt")  | tablas de datos: $(grep -c 'TABLE DATA' "$OUT/restore-list.txt")  | tamano: $(du -h "$OUT/public.dump" | cut -f1)"
grep -E 'TABLE DATA public (confirmed_orders|customers|vouchers) ' "$OUT/restore-list.txt" | wc -l | xargs echo "tablas clave con datos (esperado 3):"
chmod 600 "$OUT"/*; echo "RESPALDO LISTO: $OUT"; echo "$OUT" > /tmp/claude-0/inkaclick-backup-dir
