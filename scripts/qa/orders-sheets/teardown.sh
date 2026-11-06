#!/usr/bin/env bash
PFX=${QS_PREFIX:-qs}
docker rm -f $PFX-proxy $PFX-rest $PFX-pg 2>/dev/null; docker network rm $PFX-net 2>/dev/null; exit 0
