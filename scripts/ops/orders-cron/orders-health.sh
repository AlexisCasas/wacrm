#!/bin/sh
# READ-ONLY. Prints the health lines of orders-health.sql. Exit 0 = no alert firing, 1 = at least one O* alert > 0, 2 = could not query.
# Reads no secrets and sends nothing anywhere.  Usage: orders-health.sh [-v late_min=10 ...]
DIR="$(cd "$(dirname "$0")" && pwd)"
out=$(docker exec -i supabase-db psql -U postgres -d postgres -X -q "$@" < "$DIR/orders-health.sql" 2>&1) || { echo "$out" | head -3; exit 2; }
echo "$out"
echo "$out" | awk '$1 ~ /^O[0-9]/ && $2+0 > 0 {bad=1} END {exit bad ? 1 : 0}'
