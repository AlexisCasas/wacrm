#!/usr/bin/env bash
# Copies what the run produced while the services are still up. The report is built afterwards, once the teardown result is known.
set -euo pipefail
out="${1:?output directory}"
: "${QA_DIR:?}"
mkdir -p "$out"
if sudo test -d "$QA_DIR/results"; then sudo cp -r "$QA_DIR/results/." "$out/"; fi
if ! docker ps --format '{{.Names}}\t{{.Image}}' >"$out/services.tsv"; then echo "could not list the services"; fi
sudo chown -R "$(id -u):$(id -g)" "$out"
