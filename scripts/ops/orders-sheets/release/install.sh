#!/usr/bin/env bash
# Installs this package into the deploy directory (outside any repo) and records the reviewed migration's sha256. Writes files only.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"; REPO_ROOT="$(cd "$SRC/../../../.." && pwd)"; D=${RELEASE_DIR:-/opt/backups/wacrm/sheets-keyler-release-deploy}
mkdir -p $D/{scripts,sql,db,image,compose,evidence}; chmod 700 $D
cp -p $SRC/*.sh $D/scripts/; rm -f $D/scripts/install.sh
cp -p $REPO_ROOT/supabase/migrations/20261109000000_order_sheet_exports.sql $D/sql/
cp -p $REPO_ROOT/scripts/ops/orders-sheets/exclude-test-orders.sql $D/sql/
cp -p $SRC/sql/*.sql $D/sql/ 2>/dev/null || true
sha256sum $D/sql/20261109000000_order_sheet_exports.sql | cut -c1-64 > $D/MIG.sha256
chmod +x $D/scripts/*.sh; echo "installed in $D (migration sha256 $(cat $D/MIG.sha256))"
