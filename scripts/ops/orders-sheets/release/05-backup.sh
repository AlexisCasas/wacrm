#!/usr/bin/env bash
# Takes the FULL PostgreSQL backup (gates require one younger than 12 h), archives the RUNNING image for rollback and copies the Compose files.
# Read-only on the database and containers; writes files only. Run shortly before the migration window.
. "$(dirname "$0")/lib.sh"; umask 077
mkdir -p $D/db $D/image $D/compose
TS=$(date -u +%Y%m%dT%H%M%SZ); echo $TS > $D/db/TIMESTAMP
docker exec $DBC pg_dump -U supabase_admin -d postgres -Fc -Z 6 > $D/db/postgres_full_$TS.dump 2> $D/db/pg_dump.err; rc1=$?
docker exec $DBC pg_dump -U supabase_admin -d _supabase -Fc > $D/db/_supabase_full_$TS.dump 2>> $D/db/pg_dump.err; rc2=$?
docker exec $DBC pg_dumpall -U supabase_admin --globals-only > $D/db/globals_$TS.sql 2> $D/db/pg_dumpall.err; rc3=$?
echo "pg_dump rc: $rc1 $rc2 $rc3 | stderr bytes: $(cat $D/db/pg_dump.err $D/db/pg_dumpall.err | wc -c)"
(cd $D/db && sha256sum *.dump globals_*.sql > SHA256SUMS && sha256sum -c SHA256SUMS --quiet && echo "db checksums OK")
chk "dump TOC lists every live public table" "$(docker exec -i $DBC pg_restore -l < $D/db/postgres_full_$TS.dump | grep -c 'TABLE DATA public')" "$(RO "select count(*) from pg_tables where schemaname='public'")"
# rollback image archive (the digest must equal the running image)
chk "running image is the expected one" "$(docker inspect wacrm-app-1 --format '{{.Image}}')" $OLD_IMAGE_ID
if [ ! -s $OLD_IMAGE_TAR ]; then docker save $OLD_IMAGE | gzip -6 > $OLD_IMAGE_TAR; fi
(cd $D/image && sha256sum *.tar.gz > SHA256SUMS && sha256sum -c SHA256SUMS --quiet && echo "image archive checksum OK")
chk "image archive digest = running image" "$(tar -xzOf $OLD_IMAGE_TAR index.json | python3 -I -c "import json,sys; print(json.load(sys.stdin)['manifests'][0]['digest'])")" "$(docker inspect wacrm-app-1 --format '{{.Image}}')"
# compose files + the env file's fingerprint (NOT copied: it holds secrets) + a private backup copy used by 45-prepare-env.sh
LBL=$(docker inspect wacrm-app-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'); echo "$LBL" > $D/compose/config_files.label
for f in $(echo $LBL | tr ',' ' '); do cp -p "$f" "$D/compose/$(echo $f | tr '/' '_' | sed 's/^_//')"; done
echo "env file sha256 (fingerprint only): $(sha256sum $ENV_FILE | cut -c1-16)" | tee $D/compose/env-fingerprint.txt
chk "no literal secrets in the Compose copies" "$(grep -cEi '(key|secret|token|password)\s*[:=]\s*[^$ {][^ ]{6,}' $D/compose/*.yml | awk -F: '{s+=$2} END{print s+0}')" 0
[ $rc1 -eq 0 ] && [ $rc2 -eq 0 ] && [ $rc3 -eq 0 ] && [ $fail -eq 0 ] && echo "BACKUP OK ($TS)" || { echo "BACKUP FAILED"; exit 1; }
