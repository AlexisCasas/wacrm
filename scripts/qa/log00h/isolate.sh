#!/usr/bin/env bash
# Cuts outbound network access for the QA user (app, tests, seed) and for every container, and proves it with canaries.
#   isolate.sh apply <out.json>   positive control (canaries must work), add the rules, canaries must now fail
#   isolate.sh check <out.json>   canaries must still fail
# The runner agent (another user) keeps its connection to GitHub: it is needed for logs and artifacts.
set -euo pipefail
mode="${1:?apply|check}"
out="${2:?output file}"

[ "${GITHUB_ACTIONS:-}" = "true" ] || { echo "isolate.sh only runs on a throwaway GitHub Actions runner"; exit 2; }

QA_UID="$(id -u qarun)"
EXT_IF="$(ip -4 route show default | awk '{print $5; exit}')"
FB_IP="$(getent ahostsv4 graph.facebook.com | awk '{print $1; exit}')"
GH_IP="$(getent ahostsv4 api.github.com | awk '{print $1; exit}')"
[ -n "$EXT_IF" ] && [ -n "$FB_IP" ] && [ -n "$GH_IP" ] || { echo "could not resolve the canary targets"; exit 2; }

# name|url|curl --resolve value (containers cannot use the host resolver, so names are pinned to an address)
CANARIES=(
  "internet-ip|https://1.1.1.1|"
  "meta-graph|https://graph.facebook.com|graph.facebook.com:443:${FB_IP}"
  "github-api|https://api.github.com|api.github.com:443:${GH_IP}"
)

rows="$(mktemp)"
probe() { # $1 = scope label, rest = command prefix
  local scope="$1"; shift
  local c name url resolve reached
  for c in "${CANARIES[@]}"; do
    IFS='|' read -r name url resolve <<<"$c"
    if "$@" curl -sS -o /dev/null --connect-timeout 6 --max-time 8 ${resolve:+--resolve "$resolve"} "$url" >/dev/null 2>&1; then reached=true; else reached=false; fi
    printf '%s\t%s\t%s\n' "$scope" "$name" "$reached" >>"$rows"
  done
}
probe_all() {
  : >"$rows"
  probe "user:qarun" sudo -u qarun
  local id name pid
  for id in $(docker ps -q); do
    name="$(docker inspect -f '{{.Name}}' "$id" | tr -d '/')"
    pid="$(docker inspect -f '{{.State.Pid}}' "$id")"
    probe "container:${name}" sudo nsenter -t "$pid" -n
  done
}

positive=null
if [ "$mode" = apply ]; then
  probe_all
  # the test is only meaningful if the canaries could get out before the rules: from the QA user and from at least one container
  awk -F'\t' '$1=="user:qarun" && $3=="true"{u=1} $1 ~ /^container:/ && $3=="true"{c=1} END{exit !(u&&c)}' "$rows" \
    || { echo "positive control failed: canaries cannot get out even before isolating"; cat "$rows"; exit 1; }
  positive=true
  sudo iptables -I OUTPUT 1 -m owner --uid-owner "$QA_UID" ! -o lo -j REJECT
  sudo ip6tables -I OUTPUT 1 -m owner --uid-owner "$QA_UID" ! -o lo -j REJECT
  sudo iptables -I DOCKER-USER 1 -o "$EXT_IF" -j REJECT
  if sudo ip6tables -S DOCKER-USER >/dev/null 2>&1; then sudo ip6tables -I DOCKER-USER 1 -o "$EXT_IF" -j REJECT; fi
fi

probe_all
leaks="$(awk -F'\t' '$3=="true"' "$rows" | wc -l | tr -d ' ')"
total="$(wc -l <"$rows" | tr -d ' ')"
tmp="$(mktemp)"
python3 - "$rows" "$mode" "$positive" "$leaks" >"$tmp" <<'PY'
import json, sys
rows = [l.rstrip('\n').split('\t') for l in open(sys.argv[1]) if l.strip()]
print(json.dumps({
    'mode': sys.argv[2], 'positiveControl': json.loads(sys.argv[3]), 'leaks': int(sys.argv[4]),
    'canaries': [{'scope': s, 'target': t, 'reached': r == 'true'} for s, t, r in rows],
}, indent=2))
PY
sudo install -m 0644 -o qarun -g qarun "$tmp" "$out"
cat "$tmp"
[ "$leaks" = 0 ] && [ "$total" -gt 3 ] || { echo "ISOLATION=FAIL (leaks=$leaks probes=$total)"; exit 1; }
echo "ISOLATION=PASS (probes=$total)"
