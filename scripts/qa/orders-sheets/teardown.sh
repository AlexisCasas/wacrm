#!/usr/bin/env bash
docker rm -f qs-proxy qs-rest qs-pg 2>/dev/null; docker network rm qs-net 2>/dev/null; exit 0
