#!/usr/bin/env bash
# CALL-03B2.6 QA mock preflight. READ ONLY. No environment variables or credentials are printed.
set -euo pipefail

fail() {
  echo "CALL03B26_MOCK_PREFLIGHT=BLOCKED_$1" >&2
  exit 1
}

[[ "$(hostname -s)" == "srv1917080" ]] || fail WRONG_HOST
command -v docker >/dev/null 2>&1 || fail NO_DOCKER
command -v curl >/dev/null 2>&1 || fail NO_CURL

mock=call03b2-qa-mock-graph
app=call03b2-qa-app
db=call03b2-qa-db
prod=wacrm-app-1

for name in "$mock" "$app" "$db" "$prod"; do
  docker container inspect "$name" >/dev/null 2>&1 || fail "MISSING_CONTAINER_$name"
done

for name in "$mock" "$app" "$db"; do
  project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$name")"
  [[ "$project" == "call03b2-qa" ]] || fail "PROJECT_IDENTITY_$name"
  running="$(docker inspect -f '{{.State.Running}}' "$name")"
  [[ "$running" == "true" ]] || fail "NOT_RUNNING_$name"
done
[[ "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "$mock")" == "mock-graph" ]] || fail WRONG_MOCK_SERVICE
network_mode="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$mock")"
[[ "$network_mode" == container:* ]] || fail MOCK_NOT_IN_SHARED_QA_NETWORK

# Deny builds on a pressured host, even though the mock build is small.
avail_kib="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
[[ "$avail_kib" =~ ^[0-9]+$ ]] || fail MEMORY_UNKNOWN
(( avail_kib >= 2621440 )) || fail MEMORY_BELOW_2560_MIB

# Only report names, image identifiers and compose-file paths. Never inspect or print Config.Env.
compose_files="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$mock")"
[[ -n "$compose_files" && "$compose_files" != "<no value>" ]] || fail COMPOSE_FILES_UNKNOWN

graph_ip="$(docker exec "$app" getent ahostsv4 graph.facebook.com 2>/dev/null | awk 'NR == 1 {print $1}')"
[[ "$graph_ip" == "127.0.0.1" ]] || fail GRAPH_NOT_LOOPBACK

curl --fail --silent --show-error --max-time 8 http://127.0.0.1:38090/qa/health >/dev/null || fail PEER_HEALTH
curl --fail --silent --show-error --location --max-time 8 --output /dev/null http://127.0.0.1:38089/login || fail APP_LOGIN

echo "CALL03B26_MOCK_PREFLIGHT=PASS_READ_ONLY"
echo "HOST=$(hostname -s)"
echo "PROJECT=call03b2-qa"
echo "MOCK_IMAGE_ID=$(docker inspect -f '{{.Image}}' "$mock")"
echo "MOCK_NETWORK_MODE=$network_mode"
echo "COMPOSE_FILES=$compose_files"
echo "QA_APP_IMAGE_ID=$(docker inspect -f '{{.Image}}' "$app")"
echo "QA_DB_IMAGE_ID=$(docker inspect -f '{{.Image}}' "$db")"
echo "PROD_APP_IMAGE_ID=$(docker inspect -f '{{.Image}}' "$prod")"
echo "MEM_AVAILABLE_MIB=$((avail_kib / 1024))"
echo "GRAPH_RESOLUTION=$graph_ip"
echo "QA_URLS=HTTP_OK"
echo "SOURCE_QA_MOCK_COMMIT=786787e7d7ddf816f25ca624e7dd57b4a8f6b53e"
echo "NOTE=NO_CHANGES_TO_QA_OR_PRODUCTION"
